/**
 * Tools: evaluations.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { readWorkspace } from "../workspace.js";

import { getToken, PPAPI_SCOPE } from "../auth.js";
import { downloadSnapshot, getRun, getTestSet, listRuns, listTestSets, runIsFinished, startRun, summarizeRun } from "../cloud/ppapi.js";
import { buildTestSetCsv, evaluationPageUrl, suggestTestCases } from "../evals.js";
import { botArg, clientArg, cloudContext, confirmArg, downloadPath, dryRun, envArg, fail, resolveRoot, server, tenantArg, text, workspaceArg } from "./shared.js";

/** One agent's tool connections for a run: the evaluated agent by default, or a connected child agent. */
const toolsConnectionsArg = z
  .array(
    z.object({
      botId: z.string().optional().describe("Dataverse bot id; default: the evaluated agent"),
      botSchemaName: z.string().optional(),
      connections: z.array(
        z.object({
          connectorId: z.string().describe("Connector id, e.g. shared_office365 (cs_list_connectors)"),
          connectionId: z.string().describe("The user connection to run it with (cs_list_connections)"),
          connectionReferenceName: z.string().optional().describe("Connection reference name in the agent, when the tool is bound through one"),
        }),
      ),
    }),
  )
  .optional()
  .describe("Which connection each connector tool should use during the run");

// ---- evaluations ----------------------------------------------------------

server.registerTool(
  "cs_create_test_set_csv",
  {
    title: "Create an evaluation test set (CSV for import)",
    description: "Write the CSV the portal's Evaluation page imports (columns Question, Expected response; max 100 cases). Test sets cannot be created through the API, so this file is imported once in the portal; runs and results are then automated via cs_run_evaluation. suggestFromWorkspace derives cases from topics, starters and knowledge.",
    inputSchema: { workspace: workspaceArg, outputPath: z.string().optional().describe("Default <workspace>/../<agent>-testset.csv"), cases: z.array(z.object({ question: z.string(), expectedResponse: z.string().optional() })).optional(), suggestFromWorkspace: z.boolean().optional(), maxSuggested: z.number().optional() },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const cases = [...(a.cases ?? [])];
      if (a.suggestFromWorkspace || cases.length === 0) cases.push(...suggestTestCases(ws, a.maxSuggested ?? 25).filter((s) => !cases.some((c) => c.question.toLowerCase() === s.question.toLowerCase())));
      const { csv, warnings } = buildTestSetCsv(cases);
      const out = a.outputPath ?? path.join(path.dirname(root), `${path.basename(root)}-testset.csv`);
      fs.writeFileSync(out, csv, "utf8");
      return text({
        file: out,
        cases: Math.min(cases.length, 100),
        warnings,
        importSteps: [
          ws.sync.environmentId && ws.sync.agentId ? `Open ${evaluationPageUrl(ws.sync.environmentId, ws.sync.agentId)} and go to the Evaluation tab` : "Open the agent in Copilot Studio and go to the Evaluation tab",
          "New evaluation > Single responses > Import > upload this CSV",
          "Choose test methods (General quality needs no expected response; Compare meaning / Exact match use the Expected response column)",
          "Save. Then cs_list_test_sets shows the id and cs_run_evaluation runs it.",
        ],
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_list_test_sets", { title: "List evaluation test sets", description: "Power Platform API: test sets defined for the agent (standard harness).", inputSchema: { workspace: workspaceArg, environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg } }, async (a) => {
  try {
    const ctx = await cloudContext(a, { environment: true, bot: true });
    const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
    const sets = await listTestSets(tok.accessToken, ctx.environmentId as string, ctx.botId as string);
    return text({ count: sets.length, testSets: sets.map(({ raw: _raw, ...s }) => s) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_run_evaluation",
  {
    title: "Run an evaluation",
    description:
      "Start an evaluation run for a test set (draft agent by default, or the published one). Optionally wait for completion and return the summary. mcsConnectionId runs it signed in as a user profile (the id of that user's Copilot Studio connection) so authenticated knowledge and tools answer; toolsConnections picks the connection each connector tool uses. Counts against the 20 runs per agent per 24h limit: requires confirm: true.",
    inputSchema: {
      workspace: workspaceArg,
      testSetId: z.string(),
      runOnPublishedBot: z.boolean().optional(),
      runName: z.string().optional(),
      mcsConnectionId: z.string().optional().describe("Copilot Studio connection id of the user profile to run as; omit for an anonymous run. Power Automate > Connections > Microsoft Copilot Studio, the GUID in the URL"),
      toolsConnections: toolsConnectionsArg,
      wait: z.boolean().optional(),
      timeoutSeconds: z.number().optional(),
      environmentId: envArg,
      botId: botArg,
      tenantId: tenantArg,
      clientId: clientArg,
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const set = await getTestSet(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.testSetId);
      if (!a.confirm) {
        return dryRun(`run test set '${set.displayName}' (${set.totalTestCases ?? "?"} cases) against the ${a.runOnPublishedBot ? "published" : "draft"} agent ${ctx.botId}`, {
          signedInAs: a.mcsConnectionId ? `user profile via connection ${a.mcsConnectionId}` : "anonymous (authenticated knowledge and tools will not answer)",
          ...(a.toolsConnections?.length ? { toolsConnections: a.toolsConnections } : {}),
        });
      }
      let run = await startRun(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.testSetId, { runOnPublishedBot: a.runOnPublishedBot, evaluationRunName: a.runName, mcsConnectionId: a.mcsConnectionId, toolsConnections: a.toolsConnections });
      if (a.wait) {
        const deadline = Date.now() + (a.timeoutSeconds ?? 600) * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          const t2 = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
          run = await getRun(t2.accessToken, ctx.environmentId as string, ctx.botId as string, run.id);
          if (runIsFinished(run) && (run.testCasesProcessed ?? 0) >= (run.totalTestCases ?? 0)) break;
        }
        const { raw: _raw, ...r } = run;
        return text({ run: { ...r, testCasesResults: undefined }, summary: summarizeRun(run) });
      }
      const { raw: _raw, ...r } = run;
      return text({ run: r, next: `Poll with cs_get_evaluation_run runId=${run.id}` });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_get_evaluation_run", { title: "Get an evaluation run", description: "Status and per-case results of an evaluation run, with a pass/fail summary per test method.", inputSchema: { workspace: workspaceArg, runId: z.string(), includeRaw: z.boolean().optional(), environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg } }, async (a) => {
  try {
    const ctx = await cloudContext(a, { environment: true, bot: true });
    const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
    const run = await getRun(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.runId);
    const { raw, testCasesResults: _t, ...r } = run;
    return text({ run: r, summary: summarizeRun(run), ...(a.includeRaw ? { raw } : {}) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_download_evaluation_snapshot",
  {
    title: "Download the agent content an evaluation run tested",
    description:
      "Answer 'what exactly did that evaluation run test?': download the agent content snapshot the run was scored against, as the service zipped it, so it can be compared with the workspace now (unzip, then cs_compare_snapshots or a file diff). Writes only the zip file; the environment is not touched. Follows the published Power Platform API reference; not yet verified against a live tenant.",
    inputSchema: { workspace: workspaceArg, runId: z.string().describe("cs_list_evaluation_runs shows the ids"), outputPath: z.string().optional().describe("Where to write the zip. Default: beside the workspace, else the temp folder"), environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const file = await downloadSnapshot(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.runId);
      const out = downloadPath(a.workspace, file.fileName ?? `evaluation-${a.runId}-snapshot.zip`, a.outputPath);
      fs.writeFileSync(out, file.bytes);
      return text({ file: out, bytes: file.bytes.byteLength, contentType: file.contentType, runId: a.runId });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_list_evaluation_runs",{ title: "List evaluation runs", description: "Previous evaluation runs for the agent.", inputSchema: { workspace: workspaceArg, environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg } }, async (a) => {
  try {
    const ctx = await cloudContext(a, { environment: true, bot: true });
    const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
    const runs = await listRuns(tok.accessToken, ctx.environmentId as string, ctx.botId as string);
    return text({ count: runs.length, runs: runs.map(({ raw: _r, testCasesResults: _t, ...x }) => x) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});
