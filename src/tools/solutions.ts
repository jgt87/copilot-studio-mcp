/**
 * Tools: solutions (ALM.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import { withPacProfile, makerProfileDefault, hasPacProfileLock } from "../pacProfile.js";
import path from "node:path";
import { z } from "zod";


import { errorMessage, log } from "../log.js";
import { publicView, startJob, type Progress } from "../jobs.js";
import { explainFailure, runPac } from "../pac.js";
import { findWorkspaceRoot, readWorkspace } from "../workspace.js";
import { updateAgent, updateCliCopilotInstructions } from "../authoring/agent.js";

import { buildInstructionsBrief, createSolution, generateWithAiBuilder } from "../bootstrap.js";
import {
  applyDeploymentSettings,
  createDeploymentSettings,
  exportSolution,
  importSolution,
  inventorySolutionFolder,
  listConnections,
  listSolutions,
  packSolution,
  readDeploymentSettings,
  readManifest,
  summarizeInventory,
  unmappedSettings,
  unpackSolution,
  writeManifest,
  type PackageType,
  type PullManifest,
} from "../solutions.js";
import { confirmArg, dryRun, envOrProfile, fail, pacSummary, resolveRoot, server, text, tryWorkspace, workspaceArg } from "./shared.js";

// ---- solutions (ALM: pull everything, redeploy 1:1) -----------------------

function defaultSolutionWorkDir(name: string): string {
  return path.join(process.env.CPS_WORKSPACE ?? process.cwd(), ".cs-solutions", name);
}

server.registerTool(
  "cs_create_solution",
  {
    title: "Create an unmanaged solution",
    description: "Create a new unmanaged solution (and its publisher if missing) in an environment by packing an empty solution manifest and importing it with pac. Use it to prepare the container before cs_create_agent with solutionName. Requires confirm: true.",
    inputSchema: { uniqueName: z.string().describe("e.g. contoso_Agents"), displayName: z.string().optional(), publisherPrefix: z.string().describe("2-8 lowercase characters, e.g. contoso"), publisherName: z.string().optional(), environment: envOrProfile, workDir: z.string().optional().describe("Where the manifest and zip are written (default <workspace>/.cs-solutions/<uniqueName>)"), confirm: confirmArg },
  },
  async (a) => {
    try {
      if (!a.confirm) return dryRun(`create solution ${a.uniqueName} (publisher ${a.publisherPrefix}) in ${a.environment ?? "the active profile's environment"}`);
      const r = await createSolution({ uniqueName: a.uniqueName, displayName: a.displayName, publisherPrefix: a.publisherPrefix, publisherName: a.publisherName, environment: a.environment, workDir: a.workDir ?? defaultSolutionWorkDir(a.uniqueName) });
      return text({ uniqueName: r.uniqueName, existed: r.existed, zip: r.zip, ...(r.import ? { import: pacSummary(r.import) } : { note: "solution already existed; nothing imported" }) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_generate_instructions",
  {
    title: "Generate agent instructions with an AI Builder prompt",
    description:
      "Write the agent's instructions for it - the system prompt that decides how it answers. Builds a brief from purpose, audience, tone, capabilities, boundaries and examples, send it to an AI Builder prompt or model (pac copilot model predict; pick one with cs_list_prompts), and return the generated instructions. With apply: true the text is written into the agent's instructions (agent.mcs.yml, or settings.mcs.yml for cli-copilot). Pass currentInstructions/changeRequest (or refine: true to read the workspace) to revise existing instructions instead.",
    inputSchema: {
      workspace: workspaceArg,
      purpose: z.string().optional().describe("What the agent is for; required unless refining"),
      audience: z.string().optional(),
      tone: z.string().optional(),
      capabilities: z.array(z.string()).optional().describe("Default: derived from the workspace (topics, knowledge, tools)"),
      boundaries: z.array(z.string()).optional(),
      examples: z.array(z.string()).optional(),
      language: z.string().optional(),
      refine: z.boolean().optional().describe("Revise the workspace's current instructions using changeRequest"),
      changeRequest: z.string().optional(),
      modelId: z.string().optional(),
      modelName: z.string().optional().describe("Full or partial AI Builder model / prompt name"),
      inputMode: z.enum(["prompt", "text"]).optional(),
      environment: envOrProfile,
      apply: z.boolean().optional().describe("Write the result into the agent instructions"),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const capabilities =
        a.capabilities ??
        [
          ...ws.topics.filter((t) => (t.details.triggerKind as string) === "OnRecognizedIntent").map((t) => `topic: ${t.name}${t.description ? ` (${t.description})` : ""}`),
          ...ws.knowledge.map((k) => `knowledge: ${k.name}${k.details.site ? ` (${k.details.site})` : ""}`),
          ...ws.actions.map((t) => `tool: ${t.name}${t.description ? ` (${t.description})` : ""}`),
        ];
      let brief: string;
      if (a.refine) {
        let current = ws.agent?.instructions ?? "";
        if (ws.harness === "github-copilot") {
          const segments = (((ws.settings?.configuration as Record<string, unknown>)?.agentSettings as Record<string, unknown>)?.instructions as Record<string, unknown>)?.segments;
          current = Array.isArray(segments) ? (segments as { value?: string }[]).map((s) => s.value ?? "").join("\n") : "";
        }
        if (!current.trim()) return fail("No current instructions to refine; pass purpose instead");
        brief = buildInstructionsBrief({ purpose: "", currentInstructions: current, changeRequest: a.changeRequest });
      } else {
        if (!a.purpose) return fail("purpose is required (or refine: true)");
        brief = buildInstructionsBrief({ purpose: a.purpose, audience: a.audience, tone: a.tone, capabilities, boundaries: a.boundaries, examples: a.examples, language: a.language });
      }
      const gen = await generateWithAiBuilder({ modelId: a.modelId, modelName: a.modelName, brief, environment: a.environment, inputMode: a.inputMode });
      let applied: unknown = null;
      if (a.apply) applied = ws.harness === "github-copilot" ? updateCliCopilotInstructions(root, gen.text) : updateAgent(root, { instructions: gen.text });
      return text({ instructions: gen.text, applied, brief, model: a.modelId ?? a.modelName, next: a.apply ? "Review agent.mcs.yml, then cs_validate and cs_push." : "Review the text; call again with apply: true to write it, or edit and use cs_update_agent." });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_list_solutions", { title: "List solutions", description: "pac solution list: solutions in an environment with version and managed flag. Needs a pac auth profile.", inputSchema: { environment: envOrProfile, includeSystem: z.boolean().optional() } }, async ({ environment, includeSystem }) => {
  try {
    const r = await listSolutions(environment, includeSystem);
    return text({ environment: environment ?? "(active profile)", count: r.solutions.length, solutions: r.solutions });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool("cs_list_connections", { title: "List connections", description: "pac connection list: connections that exist in an environment (id, connector, owner). Use the ids to map connection references in a deployment settings file before cs_deploy_solution.", inputSchema: { environment: envOrProfile } }, async ({ environment }) => {
  try {
    const r = await listConnections(environment);
    return text({ environment: environment ?? "(active profile)", count: r.connections.length, connections: r.connections });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_describe_solution",
  {
    title: "Describe a solution",
    description: "Export a solution (unmanaged, async) and unpack it locally, then inventory everything inside: agents (with harness and component counts), bot components by kind, cloud flows, connection references, environment variables, custom connectors, other component folders. Read-only for the environment.",
    inputSchema: { name: z.string().describe("Solution unique name"), environment: envOrProfile, workDir: z.string().optional().describe("Where to put the export and unpacked source (default <workspace>/.cs-solutions/<name>)") },
  },
  async ({ name, environment, workDir }) => {
    try {
      const dir = workDir ?? defaultSolutionWorkDir(name);
      const zip = path.join(dir, "export", `${name}_unmanaged.zip`);
      const src = path.join(dir, "src");
      await exportSolution({ name, zipPath: zip, environment, managed: false });
      await unpackSolution(zip, src, "Unmanaged");
      const inv = inventorySolutionFolder(src);
      return text({ zip, srcFolder: src, ...summarizeInventory(inv) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_pull_solution",
  {
    title: "Pull a whole solution locally",
    description:
      "Export the solution (unmanaged and optionally managed), unpack it to <targetDir>/src, write <targetDir>/solution.json, generate deployment-settings.json (connection references + environment variables to map), and clone every agent in the solution into <targetDir>/agents/<name> as a sync-connected workspace. This is the input for cs_deploy_solution.",
    inputSchema: {
      name: z.string().describe("Solution unique name"),
      targetDir: z.string(),
      environment: envOrProfile,
      packagetype: z.enum(["Unmanaged", "Managed", "Both"]).optional().describe("Default Both: exports both zips, unpacks both"),
      cloneAgents: z.boolean().optional().describe("Default true"),
      background: z.boolean().optional().describe("Run in the background and return a jobId immediately. Use this when the export is large enough that the MCP client times the call out; poll with cs_job_status."),
    },
  },
  async ({ name, targetDir, environment, packagetype, cloneAgents, background }) => {
    try {
      const dir = path.resolve(targetDir);
      const label = `pull solution '${name}'${environment ? ` from ${environment}` : ""} into ${dir}`;
      const run = (progress: Progress) => pullSolution({ name, targetDir, environment, packagetype, cloneAgents }, progress);
      if (background) {
        const job = startJob({ tool: "cs_pull_solution", label, recordFile: path.join(dir, "pull-job.json") }, run);
        return text({
          ...publicView(job),
          note: "Running in the background so the call cannot outlive the client's timeout. Poll cs_job_status with this jobId; the outcome is also written to pull-job.json in the target directory, so it survives a server restart.",
        });
      }
      return text(await run(() => {}));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

/**
 * Export, unpack, write the settings file and clone every agent. Minutes of
 * work: it reports each phase through `progress` so a background run can say
 * where it is, and it is the same code path either way.
 */
async function pullSolution(
  { name, targetDir, environment, packagetype, cloneAgents }: { name: string; targetDir: string; environment?: string; packagetype?: PackageType; cloneAgents?: boolean },
  progress: Progress,
): Promise<Record<string, unknown>> {
  if (!hasPacProfileLock()) return (await withPacProfile(makerProfileDefault(), () => pullSolution({ name, targetDir, environment, packagetype, cloneAgents }, progress))).result;
  const pt: PackageType = packagetype ?? "Both";
  const dir = path.resolve(targetDir);
  fs.mkdirSync(path.join(dir, "export"), { recursive: true });
  const unmanagedZip = path.join(dir, "export", `${name}_unmanaged.zip`);
  const managedZip = path.join(dir, "export", `${name}_managed.zip`);
  const exports: PullManifest["exports"] = { unmanaged: null, managed: null };
  if (pt !== "Managed") {
    progress("exporting the unmanaged solution");
    await exportSolution({ name, zipPath: unmanagedZip, environment, managed: false });
    exports.unmanaged = unmanagedZip;
  }
  if (pt !== "Unmanaged") {
    progress("exporting the managed solution");
    await exportSolution({ name, zipPath: managedZip, environment, managed: true });
    exports.managed = managedZip;
  }
  const src = path.join(dir, "src");
  progress("unpacking");
  await unpackSolution(exports.unmanaged ?? (exports.managed as string), src, pt);
  const inv = inventorySolutionFolder(src);
  progress(`inventory: ${inv.agents.length} agent(s), ${inv.flows.length} flow(s)`);
  let settingsFile: string | null = null;
  try {
    settingsFile = path.join(dir, "deployment-settings.json");
    progress("writing deployment settings");
    await createDeploymentSettings({ zipPath: exports.unmanaged ?? (exports.managed as string) }, settingsFile);
  } catch (err) {
    log(`create-settings skipped: ${errorMessage(err)}`);
    settingsFile = null;
  }
  const agents: PullManifest["agents"] = [];
  for (const a of inv.agents) {
    let workspace: string | null = null;
    let cloneError: string | null = null;
    if (cloneAgents !== false) {
      progress(`cloning agent ${a.schemaName}`);
      const agentsDir = path.join(dir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      const r = await runPac(["copilot", "clone", "--bot", a.schemaName, "--output-dir", agentsDir, ...(environment ? ["--environment", environment] : [])], { timeoutMs: 15 * 60_000 });
      if (r.ok) {
        const root = findWorkspaceRoot(agentsDir);
        workspace = root ?? agentsDir;
        // several agents: locate the folder created for this one by schema name
        for (const d of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const ws = tryWorkspace(path.join(agentsDir, d.name));
          if (ws?.schemaName === a.schemaName) workspace = ws.root;
        }
      } else cloneError = explainFailure(r);
    }
    agents.push({ schemaName: a.schemaName, name: a.name, workspace, cloneError });
  }
  const manifest: PullManifest = { solution: name, sourceEnvironment: environment ?? null, pulledAt: new Date().toISOString(), packagetype: pt, exports, srcFolder: src, settingsFile, agents };
  const manifestFile = writeManifest(dir, manifest);
  const settings = settingsFile ? readDeploymentSettings(settingsFile) : null;
  progress("done");
  return {
    manifestFile,
    ...summarizeInventory(inv),
    agentsCloned: agents,
    deploymentSettings: settings ? { file: settingsFile, unmapped: unmappedSettings(settings) } : null,
    next: "Map connection references and environment variables for the target with cs_create_deployment_settings (use cs_list_connections on the target), then cs_deploy_solution.",
  };
}

server.registerTool(
  "cs_create_deployment_settings",
  {
    title: "Create or update deployment settings",
    description: "pac solution create-settings: the JSON that maps every connection reference (to a connection id in the target environment) and environment variable (to a target value). Pass connectionReferences / environmentVariables to fill values; the result lists what is still unmapped.",
    inputSchema: {
      zip: z.string().optional().describe("Solution zip (or use solutionDir from cs_pull_solution)"),
      solutionDir: z.string().optional().describe("Directory written by cs_pull_solution"),
      settingsFile: z.string().optional().describe("Default <solutionDir>/deployment-settings.json or next to the zip"),
      regenerate: z.boolean().optional().describe("Recreate the file even if it exists (mappings are lost)"),
      connectionReferences: z.record(z.string()).optional().describe("logicalName -> connectionId in the target environment"),
      environmentVariables: z.record(z.string()).optional().describe("schemaName -> value for the target"),
      copilotAgents: z.record(z.string()).optional().describe("agent schema name -> Entra security group id allowed to use the agent in the target"),
    },
  },
  async (a) => {
    try {
      const manifest = a.solutionDir ? readManifest(a.solutionDir) : null;
      const zip = a.zip ?? manifest?.exports.unmanaged ?? manifest?.exports.managed ?? null;
      if (!zip) return fail("Pass zip or a solutionDir that contains solution.json");
      const file = a.settingsFile ?? manifest?.settingsFile ?? (a.solutionDir ? path.join(a.solutionDir, "deployment-settings.json") : zip.replace(/\.zip$/i, "") + ".settings.json");
      if (!fs.existsSync(file) || a.regenerate) await createDeploymentSettings({ zipPath: zip }, file);
      const r = a.connectionReferences || a.environmentVariables || a.copilotAgents ? applyDeploymentSettings(file, a) : { settings: readDeploymentSettings(file), applied: [], unknown: [] };
      return text({ settingsFile: file, applied: r.applied, unknown: r.unknown, unmapped: unmappedSettings(r.settings), settings: r.settings });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_pack_solution", { title: "Pack an unpacked solution folder", description: "pac solution pack: zip an unpacked source folder (after local edits) so it can be deployed.", inputSchema: { folder: z.string(), zip: z.string(), packagetype: z.enum(["Unmanaged", "Managed"]).optional() } }, async ({ folder, zip, packagetype }) => {
  try {
    return text(pacSummary(await packSolution(folder, zip, packagetype ?? "Unmanaged")));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_deploy_solution",
  {
    title: "Deploy a solution to another environment (1:1)",
    description:
      "pac solution import into the target environment using the deployment settings file, then publish every Copilot Studio agent from the solution. Source: a zip, or a solutionDir from cs_pull_solution (managed zip preferred when present unless unmanaged: true), or an unpacked srcFolder (packed first). Blocks when connection references or environment variables are unmapped unless allowUnmapped. Requires confirm: true.",
    inputSchema: {
      targetEnvironment: z.string().describe("Environment id or URL to deploy into"),
      zip: z.string().optional(),
      solutionDir: z.string().optional(),
      srcFolder: z.string().optional().describe("Unpacked solution folder to pack and deploy"),
      unmanaged: z.boolean().optional().describe("With solutionDir: deploy the unmanaged zip instead of the managed one"),
      settingsFile: z.string().optional(),
      allowUnmapped: z.boolean().optional(),
      forceOverwrite: z.boolean().optional(),
      skipLowerVersion: z.boolean().optional(),
      stageAndUpgrade: z.boolean().optional(),
      publishAgents: z.boolean().optional().describe("Default true: pac copilot publish for each agent after import"),
      maxAsyncWaitMinutes: z.number().optional(),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const manifest = a.solutionDir ? readManifest(a.solutionDir) : null;
      let zip = a.zip ?? null;
      if (!zip && manifest) zip = a.unmanaged ? manifest.exports.unmanaged : (manifest.exports.managed ?? manifest.exports.unmanaged);
      if (!zip && a.srcFolder) {
        zip = path.join(path.dirname(a.srcFolder), "deploy", `${path.basename(a.srcFolder)}_${a.unmanaged === false ? "managed" : "unmanaged"}.zip`);
        await packSolution(a.srcFolder, zip, a.unmanaged === false ? "Managed" : "Unmanaged");
      }
      if (!zip) return fail("Pass zip, solutionDir (from cs_pull_solution) or srcFolder");
      const settingsFile = a.settingsFile ?? manifest?.settingsFile ?? null;
      let unmapped: ReturnType<typeof unmappedSettings> | null = null;
      if (settingsFile && fs.existsSync(settingsFile)) unmapped = unmappedSettings(readDeploymentSettings(settingsFile));
      const agentSchemas = manifest?.agents.map((x) => x.schemaName) ?? (a.srcFolder ? inventorySolutionFolder(a.srcFolder).agents.map((x) => x.schemaName) : []);
      const blocked = unmapped && (unmapped.connectionReferences.length || unmapped.environmentVariables.length) && !a.allowUnmapped;
      if (blocked) {
        return { ...text({ blocked: true, reason: "Deployment settings still have unmapped entries; map them with cs_create_deployment_settings (ids from cs_list_connections on the target) or pass allowUnmapped: true", unmapped }), isError: true as const };
      }
      if (!a.confirm) return dryRun(`import ${zip} into ${a.targetEnvironment}${settingsFile ? ` with ${settingsFile}` : " without a settings file"}, then publish agents: ${agentSchemas.join(", ") || "(none known)"}`, { unmapped });
      return (await withPacProfile(makerProfileDefault(), async () => {
        const imp = await importSolution({ zipPath: zip, environment: a.targetEnvironment, settingsFile: settingsFile ?? undefined, forceOverwrite: a.forceOverwrite, skipLowerVersion: a.skipLowerVersion, stageAndUpgrade: a.stageAndUpgrade, maxAsyncWaitMinutes: a.maxAsyncWaitMinutes });
        const published: Record<string, unknown>[] = [];
        if (a.publishAgents !== false) {
          for (const schema of agentSchemas) {
            const r = await runPac(["copilot", "publish", "--bot", schema, "--environment", a.targetEnvironment], { timeoutMs: 15 * 60_000 });
            published.push({ agent: schema, ok: r.ok, ...(r.ok ? {} : { error: explainFailure(r) }) });
          }
        }
        return text({
          import: pacSummary(imp),
          ok: imp.ok && published.every((p) => p.ok === true),
          published,
          unmapped,
          postDeploymentSteps: [
            ...(unmapped?.copilotAgentsWithoutGroup.length ? [`Agents without a security group in the settings file (${unmapped.copilotAgentsWithoutGroup.join(", ")}): set who can use them in the target portal or map copilotAgents in cs_create_deployment_settings.`] : []),
            "Open each agent in the target environment and check Tools: connections bound through the settings file should show as connected; any others need a one-time authorisation.",
            "Knowledge that lives outside the solution (uploaded files, Dataverse tables, SharePoint permissions) must exist and be accessible in the target.",
            "Channels (Teams, web, M365 Copilot) are configured per environment; publish to channels in the target portal.",
            "Cloud flows are imported off unless their connection references resolve; turn them on after binding connections.",
          ],
        });
      })).result;
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
