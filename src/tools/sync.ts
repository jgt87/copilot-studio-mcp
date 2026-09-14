/**
 * Tools: sync (pac).
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";


import { errorMessage, log } from "../log.js";
import { INSTRUCTIONS_LIMIT, limitRefusal } from "../instructions.js";
import { explainFailure, parseCopilotList, runPac, PUBLISH_FAILED } from "../pac.js";
import { describeWorkspace, findWorkspaceRoot, readWorkspace } from "../workspace.js";
import { adminProfileDefault, makerProfileDefault, runPacAs } from "../pacProfile.js";
import { needsInput, type NeedSpec } from "../needs.js";
import { createAgentNeeds, solutionGuidance, type CreateAgentFacts } from "../createAgentGuidance.js";
import { listSolutions } from "../solutions.js";
import { readOnlyMode, readOnlyRefusal } from "../policy.js";
import { briefQuick, fullDrift, gitState, readStamp } from "../drift.js";

import { getToken } from "../auth.js";
import { dataverseScope, listPublishers, publishBot, solutionPublisherPrefix } from "../cloud/dataverse.js";
import { createSolution, initAgentInSolution } from "../bootstrap.js";
import { backgroundArg, botArg, clientArg, cloudContext, confirmArg, dryRun, envArg, fail, maybeBackground, pacSummary, quickDriftFor, resolveRoot, server, silentDataverseFor, stampAfterSync, tenantArg, text, validateWorkspaceFiles, workspaceArg } from "./shared.js";

// ---- sync (pac) -----------------------------------------------------------

/** The argv for a local `pac copilot init`: only the flags the caller supplied. */
function initArgs(a: { name: string; publisherPrefix: string; projectDir: string; authoringMode?: string; template?: string; instructions?: string; schemaName?: string; environment?: string }): string[] {
  const args = ["copilot", "init", "--name", a.name, "--publisher-prefix", a.publisherPrefix, "--project-dir", a.projectDir];
  if (a.authoringMode) args.push("--authoring-mode", a.authoringMode);
  if (a.template) args.push("--template", a.template);
  if (a.instructions) args.push("--instructions", a.instructions);
  if (a.schemaName) args.push("--schema-name", a.schemaName);
  if (a.environment) args.push("--environment", a.environment);
  return args;
}

/** The sentence cs_create_agent shows before it touches an environment. */
function createAgentPlan(a: DecidedCreateAgent, facts: CreateAgentFacts): string {
  const solution = a.solutionName ? ` inside solution ${a.solutionName}${a.createSolution ? " (created if missing)" : ""}` : "";
  const instructions = a.instructions ? `, with ${a.instructions.length} characters of instructions (limit ${INSTRUCTIONS_LIMIT})` : "";
  return [
    `create agent '${a.name}' in environment ${a.environment}${solution}${instructions}`,
    `Files: ${a.projectDir} (new folder on this machine; edit there, then cs_push).`,
    `Publisher prefix: ${a.publisherPrefix} - every component of this agent will be named <${a.publisherPrefix}>_..., and that cannot be changed later.`,
    solutionGuidance(a, facts),
  ].join(" ");
}

export interface CreateAgentInput {
  name: string;
  /** Both are asked for when missing (createAgentNeeds), so a decided input always has them. */
  publisherPrefix?: string;
  projectDir?: string;
  authoringMode?: "classic" | "cli-copilot";
  template?: "default" | "minimal";
  instructions?: string;
  schemaName?: string;
  environment?: string;
  solutionName?: string;
  createSolution?: boolean;
  background?: boolean;
  confirm?: boolean;
}

/** An input the gate has let through: the user has answered both questions. */
export type DecidedCreateAgent = CreateAgentInput & { publisherPrefix: string; projectDir: string };

/** What cs_create_agent does with an input, before anything runs. */
export type CreateAgentGate =
  | { action: "refuse"; reason: string }
  | { action: "ask"; needs: NeedSpec[] }
  | { action: "dryRun"; plan: string }
  | { action: "bootstrapSolution" }
  | { action: "init" };

/**
 * Decide which of cs_create_agent's paths an input takes. Only `environment`
 * makes the tool touch a live environment, and the tool used to test it in four
 * separate conditions interleaved with the work, so the order of the write
 * gates was hard to read off. They are one ladder here, in the order that
 * matters: read-only refusal, then the confirm contract, then the two ways to
 * create an agent. `readOnly` is a parameter so this stays pure and testable.
 */
export function createAgentGate(a: CreateAgentInput, readOnly: boolean, facts: CreateAgentFacts = { cwd: process.cwd() }): CreateAgentGate {
  if (a.instructions && a.instructions.length > INSTRUCTIONS_LIMIT) return { action: "refuse", reason: limitRefusal("instructions", a.instructions.length) };
  if (a.environment && readOnly) return { action: "refuse", reason: readOnlyRefusal(`create agent '${a.name}' in environment ${a.environment}`) };
  if (!a.environment && a.solutionName) return { action: "refuse", reason: "solutionName needs environment" };
  // The two answers only the user has. Asked before the dry run, because a dry
  // run that invents a folder and a prefix is not a plan anyone can approve.
  const needs = createAgentNeeds(a, facts);
  if (needs.length) return { action: "ask", needs };
  if (a.environment) {
    if (!a.confirm) return { action: "dryRun", plan: createAgentPlan(a as DecidedCreateAgent, facts) };
    if (a.solutionName) return { action: "bootstrapSolution" };
  }
  return { action: "init" };
}

/**
 * What the environment can answer for the user: which solutions are there to
 * put the agent in, and which publisher prefixes exist. Best effort and silent
 * - no sign-in prompt, no pac call without an environment - because not
 * knowing only costs the choices, not the questions.
 */
async function createAgentFacts(a: CreateAgentInput): Promise<CreateAgentFacts> {
  const facts: CreateAgentFacts = { cwd: process.cwd() };
  if (!a.environment) return facts;
  if (a.publisherPrefix && a.projectDir) return facts;
  try {
    const listed = await listSolutions(a.environment);
    facts.solutions = listed.solutions.filter((s) => !s.isManaged).map((s) => ({ uniqueName: s.uniqueName, friendlyName: s.friendlyName }));
  } catch (err) {
    log(`solution list for cs_create_agent guidance skipped: ${errorMessage(err)}`);
  }
  const dv = await silentDataverseFor(a.environment);
  if (!dv) return facts;
  try {
    if (a.solutionName) {
      const prefix = await solutionPublisherPrefix(dv.url, dv.token, a.solutionName);
      if (prefix && facts.solutions) facts.solutions = facts.solutions.map((s) => (s.uniqueName.toLowerCase() === (a.solutionName as string).toLowerCase() ? { ...s, publisherPrefix: prefix } : s));
    }
    const publishers = await listPublishers(dv.url, dv.token);
    facts.publishers = publishers.map((p) => ({ prefix: p.prefix, name: p.friendlyName, isDefault: p.isDefault }));
  } catch (err) {
    log(`publisher read for cs_create_agent guidance skipped: ${errorMessage(err)}`);
  }
  return facts;
}

/** `pac copilot init`, then describe the workspace it produced and stamp a connected one. */
async function initAgentLocally(a: DecidedCreateAgent) {
  const r = await runPac(initArgs(a), { timeoutMs: 15 * 60_000 });
  const root = fs.existsSync(a.projectDir) ? findWorkspaceRoot(a.projectDir) : null;
  const workspace = root ? describeWorkspace(readWorkspace(root)) : null;
  const stamped = root && r.ok && a.environment ? { syncStamp: await stampAfterSync(root, "init") } : {};
  return { ...pacSummary(r), workspace, ...stamped };
}

server.registerTool(
  "cs_create_agent",
  {
    title: "Create a new agent",
    description:
      "pac copilot init: create a new agent workspace on disk. Without 'environment' it is a local scaffold (no sign-in). With 'environment' it also creates the live agent and connects the workspace (needs pac auth profile and confirm: true). With 'solutionName' the agent is created inside that solution (existing unmanaged solution, or a new one with createSolution: true) via init, pack, import and clone; without it, pac puts the agent in a solution named after the agent. authoringMode 'classic' is the standard harness (topics, evaluations); 'cli-copilot' is the GitHub Copilot harness.",
    inputSchema: {
      name: z.string().describe("Agent display name"),
      publisherPrefix: z.string().optional().describe("Publisher prefix, 2-8 lowercase letters or digits: it becomes part of every component's schema name and must match the publisher of the solution the agent lands in. Omit it to be shown the publishers in the environment and what the choice decides."),
      projectDir: z.string().optional().describe("Folder for the agent's files, new or empty. Omit it to be offered one named after the agent."),
      authoringMode: z.enum(["classic", "cli-copilot"]).optional(),
      template: z.enum(["default", "minimal"]).optional().describe("classic only"),
      instructions: z.string().optional(),
      schemaName: z.string().optional(),
      environment: z.string().optional().describe("Environment id or URL to bootstrap into (creates a live agent)"),
      solutionName: z.string().optional().describe("Unique name of the solution to create the agent in (requires environment)"),
      createSolution: z.boolean().optional().describe("Create solutionName if it does not exist"),
      background: backgroundArg,
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const facts = await createAgentFacts(a);
      const gate = createAgentGate(a, readOnlyMode(), facts);
      if (gate.action === "refuse") return fail(gate.reason);
      if (gate.action === "ask") return text(needsInput("cs_create_agent", gate.needs));
      if (gate.action === "dryRun") return dryRun(gate.plan);
      // Past the gate both questions are answered; the casts say what it proved.
      const decided: DecidedCreateAgent = { ...a, publisherPrefix: a.publisherPrefix as string, projectDir: a.projectDir as string };
      if (gate.action === "bootstrapSolution") {
        return await maybeBackground({ tool: "cs_create_agent", label: `create agent '${a.name}' in solution ${a.solutionName} (${a.environment})`, background: a.background }, async () => {
          const r = await initAgentInSolution({ name: decided.name, publisherPrefix: decided.publisherPrefix, projectDir: decided.projectDir, solutionName: a.solutionName as string, environment: a.environment as string, createSolution: a.createSolution, instructions: a.instructions, schemaName: a.schemaName, template: a.template, authoringMode: a.authoringMode });
          return { ...r, workspaceInfo: describeWorkspace(readWorkspace(r.workspace)), syncStamp: await stampAfterSync(r.workspace, "init") };
        });
      }
      return await maybeBackground({ tool: "cs_create_agent", label: `pac copilot init '${a.name}'${a.environment ? ` in environment ${a.environment}` : " (local scaffold)"}`, background: a.background }, () => initAgentLocally(decided));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_clone_agent",
  {
    title: "Clone an agent to disk",
    description: "pac copilot clone: download an existing agent into a sync-connected workspace (a subfolder named after the agent under outputDir). Needs a pac auth profile. Records a sync stamp (.mcs/cs-sync.json) that cs_check_drift and the cs_push preflight compare against.",
    inputSchema: { bot: z.string().optional().describe("Agent id (GUID) or schema name; omit to be shown the agents in the environment"), environment: z.string().optional().describe("Environment id or URL; default active profile"), outputDir: z.string().optional(), displayName: z.string().optional().describe("Folder name override"), componentCollections: z.array(z.string()).optional() },
  },
  async (a) => {
    try {
      if (!a.bot) {
        const listed = await runPac(["copilot", "list", ...(a.environment ? ["--environment", a.environment] : [])], { timeoutMs: 180_000 });
        const rows = listed.ok ? parseCopilotList(listed.stdout) : [];
        return text(
          needsInput("cs_clone_agent", [
            {
              argument: "bot",
              question: "Which agent should I clone?",
              why: rows.length ? "Cloning downloads one agent into a workspace." : `The agents could not be listed: ${listed.ok ? "the environment returned none" : explainFailure(listed)}`,
              choices: rows.map((r) => ({ value: r.botId, label: r.name, ...(r.isManaged === true ? { detail: "managed" } : {}) })),
              totalChoices: rows.length,
              moreWith: "cs_list_agents",
            },
          ]),
        );
      }
      const args = ["copilot", "clone", "--bot", a.bot];
      if (a.environment) args.push("--environment", a.environment);
      if (a.outputDir) args.push("--output-dir", a.outputDir);
      if (a.displayName) args.push("--display-name", a.displayName);
      for (const cc of a.componentCollections ?? []) args.push("--component-collection", cc);
      const r = await runPac(args, { timeoutMs: 15 * 60_000 });
      let workspace: unknown = null;
      let syncStamp: Record<string, unknown> | undefined;
      if (r.ok) {
        const base = a.outputDir ?? process.cwd();
        const root = findWorkspaceRoot(base);
        if (root) {
          workspace = describeWorkspace(readWorkspace(root));
          syncStamp = await stampAfterSync(root, "clone");
        }
      }
      return text({ ...pacSummary(r), workspace, ...(syncStamp ? { syncStamp } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_pull", { title: "Pull remote changes", description: "pac copilot pull: three-way merge of server changes into the local workspace (also downloads knowledge files). Run before editing and before pushing. Records a sync stamp (.mcs/cs-sync.json) so cs_check_drift can tell later portal changes from yours; commit the workspace afterwards to keep a reviewable history.", inputSchema: { workspace: workspaceArg } }, async ({ workspace }) => {
  try {
    const root = resolveRoot(workspace);
    const r = await runPac(["copilot", "pull", "--project-dir", root], { cwd: root, timeoutMs: 15 * 60_000 });
    return text({ ...pacSummary(r), ...(r.ok ? { syncStamp: await stampAfterSync(root, "pull"), hint: "Commit the workspace now so changes made in Copilot Studio show up as a reviewable diff." } : {}) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_push",
  {
    title: "Push local changes",
    description: "Send local file changes up into the agent's draft in Copilot Studio - topics, knowledge files, flows, connection references - so the draft matches your workspace (pac copilot push). This is the tool for 'upload', 'send my changes up' and 'sync my edits'. It only moves files into the draft; cs_publish is the separate step afterwards. Validates YAML first and blocks on errors unless force. The dry run also reports components changed in Copilot Studio since the last sync (quick drift check, needs a cached cs_login); when one of those also changed locally the push is blocked unless force. Changes the agent in Copilot Studio: requires confirm: true.",
    inputSchema: { workspace: workspaceArg, force: z.boolean().optional().describe("Push even if validation reports errors or portal changes conflict with local edits"), confirm: confirmArg },
  },
  async ({ workspace, force, confirm }) => {
    try {
      const root = resolveRoot(workspace);
      const validation = validateWorkspaceFiles(root);
      if (validation.errors > 0 && !force) {
        return { ...text({ blocked: true, reason: `${validation.errors} validation error(s); fix them or pass force: true`, validation }), isError: true as const };
      }
      const ws = readWorkspace(root);
      const drift = await quickDriftFor(ws);
      const driftInfo = drift.report ? briefQuick(drift.report) : { skipped: drift.note };
      if (!confirm) return dryRun(`pac copilot push from ${root} to agent ${ws.sync.agentId ?? "(from sync metadata)"} in environment ${ws.sync.environmentId ?? "(from sync metadata)"}`, { validation: { errors: validation.errors, warnings: validation.warnings }, drift: driftInfo });
      if (drift.report && drift.report.conflicts.length > 0 && !force) {
        return { ...text({ blocked: true, reason: `${drift.report.conflicts.length} component(s) changed in Copilot Studio since the last sync and also changed locally: ${drift.report.conflicts.map((c) => c.name).join(", ")}. Run cs_pull (three-way merge) first, or pass force: true to push over the portal changes.`, drift: driftInfo }), isError: true as const };
      }
      const r = await runPac(["copilot", "push", "--project-dir", root], { cwd: root, timeoutMs: 15 * 60_000 });
      return text({ ...pacSummary(r), validation: { errors: validation.errors, warnings: validation.warnings }, drift: driftInfo, ...(r.ok ? { syncStamp: await stampAfterSync(root, "push") } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_pack",
  {
    title: "Pack workspace into a solution zip",
    description: "pac copilot pack: local-only packaging of the workspace into a Dataverse solution .zip (no sign-in). Also a cheap structural check of the workspace. outputPath must be outside the workspace.",
    inputSchema: { workspace: workspaceArg, publisherPrefix: z.string(), outputPath: z.string().optional(), solutionName: z.string().optional() },
  },
  async ({ workspace, publisherPrefix, outputPath, solutionName }) => {
    try {
      const root = resolveRoot(workspace);
      const out = outputPath ?? path.join(path.dirname(root), "out");
      if (path.resolve(out).startsWith(path.resolve(root) + path.sep)) return fail(`outputPath ${out} is inside the workspace; pac refuses that ('Unsupported directory'). Choose a folder outside.`);
      fs.mkdirSync(out, { recursive: true });
      const args = ["copilot", "pack", "--publisher-prefix", publisherPrefix, "--project-dir", root, "--output-path", out];
      if (solutionName) args.push("--solution-name", solutionName);
      const r = await runPac(args, { timeoutMs: 10 * 60_000 });
      const zips = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.toLowerCase().endsWith(".zip")).map((f) => path.join(out, f)) : [];
      return text({ ...pacSummary(r), outputPath: out, zips });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_import_solution",
  { title: "Import a solution zip", description: "pac solution import of a packed agent (from cs_pack) into an environment. Mutates the environment: requires confirm: true.", inputSchema: { path: z.string(), environment: z.string().optional(), publishChanges: z.boolean().optional(), forceOverwrite: z.boolean().optional(), confirm: confirmArg } },
  async (a) => {
    try {
      if (!a.confirm) return dryRun(`pac solution import --path ${a.path}${a.environment ? ` into ${a.environment}` : " into the active profile's environment"}`);
      const args = ["solution", "import", "--path", a.path];
      if (a.environment) args.push("--environment", a.environment);
      if (a.publishChanges !== false) args.push("--publish-changes");
      if (a.forceOverwrite) args.push("--force-overwrite");
      return text(pacSummary(await runPac(args, { timeoutMs: 20 * 60_000 })));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_publish",
  {
    title: "Publish the agent",
    description: "Make the agent's current draft visible to real users on its channels - the tool for 'go live', 'release it' and 'make my changes live'. It publishes what is already in Copilot Studio, so send local edits up with cs_push first. via 'pac' runs 'pac copilot publish'; via 'dataverse' calls the PvaPublish action with the MSAL token and polls until publishedon changes. Requires confirm: true.",
    inputSchema: { workspace: workspaceArg, botId: botArg, environmentId: envArg, dataverseUrl: z.string().optional(), via: z.enum(["pac", "dataverse"]).optional(), tenantId: tenantArg, clientId: clientArg, timeoutSeconds: z.number().optional(), background: backgroundArg, confirm: confirmArg },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { bot: true });
      if (!a.confirm) return dryRun(`publish agent ${ctx.botId} (environment ${ctx.environmentId ?? "active profile"}) via ${a.via ?? "pac"}; every user the agent is shared with gets this version`);
      if ((a.via ?? "pac") === "pac") {
        const args = ["copilot", "publish", "--bot", ctx.botId as string];
        if (ctx.environmentId) args.push("--environment", ctx.environmentId);
        return await maybeBackground({ tool: "cs_publish", label: `publish agent ${ctx.botId}`, background: a.background }, async () => {
          // pac prints "Failed to publish" and still exits 0, so the exit code alone would report success.
          const r = await runPac(args, { timeoutMs: 15 * 60_000, failOnOutput: [PUBLISH_FAILED] });
          return {
            ...pacSummary(r),
            ...(r.ok ? {} : { hint: "pac reported the publish as failed. Check the agent in the portal before assuming it is live; publishing again, or via: 'dataverse' (which polls publishedon), usually says more about why." }),
          };
        });
      }
      const c2 = await cloudContext(a, { bot: true, dataverse: true });
      const tok = await getToken(c2.authCfg, [dataverseScope(c2.dataverseUrl as string)]);
      const r = await publishBot(c2.dataverseUrl as string, tok.accessToken, c2.botId as string, { timeoutMs: (a.timeoutSeconds ?? 300) * 1000 });
      return text(r);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_status", { title: "Agent provisioning status", description: "pac copilot status for an agent id.", inputSchema: { botId: botArg, environmentId: envArg, workspace: workspaceArg } }, async (a) => {
  try {
    const ctx = await cloudContext(a, { bot: true });
    const args = ["copilot", "status", "--bot-id", ctx.botId as string];
    if (ctx.environmentId) args.push("--environment", ctx.environmentId);
    return text(pacSummary(await runPac(args, { timeoutMs: 120_000 })));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_check_drift",
  {
    title: "Detect portal changes since the last sync",
    description:
      "Find changes made directly in Copilot Studio after the workspace was last cloned, pulled or pushed. mode 'quick' (default) reads the agent's component rows from Dataverse and compares them with the sync stamp: which topics, tools and knowledge sources changed, by whom, when, whether the agent settings changed and whether there are unpublished changes; needs a cached cs_login, no pac. mode 'full' runs pac copilot clone into a temporary folder and classifies every file as local-modified, remote-modified or both (conflict) against the stamp, with unified diffs. Both are read-only. Resolve drift with cs_pull (three-way merge), then commit.",
    inputSchema: {
      workspace: workspaceArg,
      mode: z.enum(["quick", "full"]).optional(),
      includeDiffs: z.boolean().optional().describe("full: include unified diffs (default true)"),
      keepClone: z.boolean().optional().describe("full: keep the temporary clone and return its path"),
      tenantId: tenantArg,
      clientId: clientArg,
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const stamp = readStamp(root);
      const git = await gitState(root);
      const lastSync = stamp ? { operation: stamp.operation, syncedAt: stamp.syncedAt, baseline: stamp.remote ? "components" : "syncedAt" } : null;
      if (a.mode === "full") {
        if (!ws.sync.agentId) return fail("The workspace has no sync metadata (agent id unknown); clone the agent first.");
        const report = await fullDrift({ root, botId: ws.sync.agentId, environment: ws.sync.environmentId, includeDiffs: a.includeDiffs, keepClone: a.keepClone });
        return text({ mode: "full", lastSync, git, ...report });
      }
      const quick = await quickDriftFor(ws, { tenantId: a.tenantId, clientId: a.clientId });
      if (!quick.report) return text({ mode: "quick", lastSync, git, skipped: quick.note, hint: "Sign in with cs_login for the quick check, or use mode: 'full' (pac copilot clone) which only needs the pac auth profile." });
      return text({ mode: "quick", lastSync, git, ...quick.report });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

const READ_ONLY_PAC = [/^(help|--version|-v)$/, /^auth (list|who)$/, /^org (who|list|fetch)$/, /^env (list|who|fetch)$/, /^copilot (list|status|model list)$/, /^solution (list|version)$/, /^admin (list|list-tenant-settings|status)$/, /^connection list$/, /^connector list$/, /^pipeline list$/];

/** A pac command that only reads. It runs without confirm, and survives CPS_READ_ONLY. */
export function isReadOnlyPac(args: string[]): boolean {
  const first = args[0] ?? "";
  return READ_ONLY_PAC.some((re) => re.test(args.slice(0, 2).join(" ")) || re.test(args.slice(0, 3).join(" ")) || re.test(first));
}

/** Which account runs a bare pac command: the admin group defaults to the admin profile. */
export function defaultPacProfile(args: string[]): string | undefined {
  return args[0] === "admin" ? adminProfileDefault() : makerProfileDefault();
}

server.registerTool(
  "cs_pac",
  { title: "Run any pac command", description: "Escape hatch: run 'pac <args...>' directly. Read-only commands (list/who/status/help) run immediately; anything else needs confirm: true. 'profile' runs it as another pac auth profile, for example the tenant admin account.", inputSchema: { args: z.array(z.string()).describe("Arguments after 'pac', e.g. [\"env\",\"list\"]"), cwd: z.string().optional(), profile: z.string().optional().describe("pac auth profile to run as (cs_init lists them)"), confirm: confirmArg, timeoutSeconds: z.number().optional() } },
  async ({ args, cwd, profile, confirm, timeoutSeconds }) => {
    try {
      if (!isReadOnlyPac(args)) {
        if (readOnlyMode()) return fail(readOnlyRefusal(`pac ${args.join(" ")}`));
        if (!confirm) return dryRun(`pac ${args.join(" ")}${profile ? ` (as pac auth profile '${profile}')` : ""}`);
      }
      const runAs = profile ?? defaultPacProfile(args);
      const r = await runPacAs(runAs, args, { cwd, timeoutMs: (timeoutSeconds ?? 600) * 1000 });
      return text({ ...pacSummary(r), ...(profile ? { profile } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
