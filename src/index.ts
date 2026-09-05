#!/usr/bin/env node
/**
 * copilot-studio-mcp: MCP server for Microsoft Copilot Studio agent development.
 *
 * Three layers behind one tool list:
 *  - sync: pac copilot init/clone/pull/push/pack/publish (child process)
 *  - authoring: YAML files in the workspace (topics, knowledge, tools, flows,
 *    triggers, variables, agent settings), schema-validated
 *  - cloud: Power Platform API (evaluations), Dataverse (agents, publish),
 *    BAP (environments), DirectLine / Copilot Studio client (chat)
 *
 * Every call that mutates a live environment takes `confirm: true`; without
 * it the tool returns a dry-run description so the calling agent can surface
 * it to the user first.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as yaml from "js-yaml";

import { errorMessage, log } from "./log.js";
import { explainFailure, findPac, installHint, parseAuthList, parseCopilotList, pacVersion, runPac, type PacResult } from "./pac.js";
import { describeWorkspace, findWorkspaceRoot, readWorkspace, type WorkspaceInfo } from "./workspace.js";
import { listKinds, lookupDefinition, resolveDefinition, schemaPath, searchDefinitions, summarizeDefinition, validateDocument, type Diagnostic } from "./schema.js";
import { addTopic, type ActionSpec, type TopicSpec } from "./authoring/topics.js";
import { addKnowledgeSource } from "./authoring/knowledge.js";
import { addTool, connectorFromReference, readConnectionReferences, type ToolSpec } from "./authoring/tools.js";
import {
  catalogDir,
  checkOperation,
  fetchConnectorList,
  fetchConnectorSwagger,
  inputsFromOperation,
  listPrompts,
  loadSeed,
  readConnectorDefinition,
  readConnectorList,
  searchConnectors,
  toDefinition,
  writeConnectorDefinition,
  writeConnectorList,
  type ConnectorDefinition,
} from "./catalog.js";
import { scaffoldFlow } from "./authoring/flows.js";
import { addTrigger } from "./authoring/triggers.js";
import { addGlobalVariable } from "./authoring/variables.js";
import { updateAgent, updateCliCopilotInstructions, updateSettings } from "./authoring/agent.js";
import { isYamlFile, listFilesRecursive } from "./authoring/util.js";
import {
  acquireInteractive,
  BAP_SCOPE,
  COPILOT_INVOKE_SCOPE,
  effectiveClientId,
  getToken,
  listAccounts,
  pendingLoginStatus,
  PPAPI_SCOPE,
  resolveTenantId,
  signOut,
  startDeviceCodeLogin,
  waitForPendingLogin,
  type AuthConfig,
} from "./auth.js";
import { getEnvironment, listEnvironments } from "./cloud/bap.js";
import { dataverseScope, getBot, listBots, listConnectionReferences, listEnvironmentVariables, listFlows, publishBot } from "./cloud/dataverse.js";
import { captureSnapshot, compareChain, compareSnapshots, writeReport, type DataverseReads } from "./compare.js";
import { buildInstructionsBrief, createSolution, generateWithAiBuilder, initAgentInSolution } from "./bootstrap.js";
import { getRun, getTestSet, listRuns, listTestSets, startRun, summarizeRun } from "./cloud/ppapi.js";
import { chatDirectLine, chatSdk, directLineTokenEndpoint, type ChatResult } from "./cloud/chat.js";
import { buildTestSetCsv, CONVERSATION_TESTS_EXAMPLE, evaluateReplies, evaluationPageUrl, parseConversationTests, suggestTestCases, type ConversationTest } from "./evals.js";
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
} from "./solutions.js";

const execFileAsync = promisify(execFile);
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { ...text({ error: message }), isError: true as const };
}

function tail(s: string, lines = 60): string {
  const arr = s.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return arr.slice(-lines).join("\n");
}

function pacSummary(r: PacResult): Record<string, unknown> {
  return {
    ok: r.ok,
    command: r.command,
    exitCode: r.code,
    durationMs: r.durationMs,
    stdout: tail(r.stdout),
    ...(r.stderr.trim() ? { stderr: tail(r.stderr, 30) } : {}),
    ...(r.ok ? {} : { explanation: explainFailure(r) }),
  };
}

function resolveRoot(workspace?: string): string {
  const start = workspace ?? process.env.CPS_WORKSPACE ?? process.cwd();
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new Error(`No Copilot Studio agent workspace found at or around ${start} (looking for agent.mcs.yml / settings.mcs.yml / agent.sync.yaml). Pass 'workspace' or run cs_clone_agent / cs_init_agent first.`);
  }
  return root;
}

function tryWorkspace(workspace?: string): WorkspaceInfo | null {
  try {
    return readWorkspace(resolveRoot(workspace));
  } catch {
    return null;
  }
}

interface CloudContext {
  tenantId: string;
  clientId: string;
  environmentId: string | null;
  botId: string | null;
  dataverseUrl: string | null;
  schemaName: string | null;
  authCfg: AuthConfig;
}

async function cloudContext(args: { workspace?: string; tenantId?: string; clientId?: string; environmentId?: string; botId?: string; dataverseUrl?: string }, needs: { environment?: boolean; bot?: boolean; dataverse?: boolean } = {}): Promise<CloudContext> {
  const ws = tryWorkspace(args.workspace);
  const tenantId = resolveTenantId(args.tenantId ?? ws?.sync.tenantId ?? undefined);
  const clientId = effectiveClientId(args.clientId);
  const environmentId = args.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID ?? null;
  const botId = args.botId ?? ws?.sync.agentId ?? process.env.CPS_AGENT_ID ?? null;
  let dataverseUrl = args.dataverseUrl ?? ws?.sync.dataverseUrl ?? process.env.CPS_ENVIRONMENT_URL ?? null;
  const authCfg: AuthConfig = { tenantId, clientId };
  if (needs.environment && !environmentId) throw new Error("environmentId is required (pass it, set CPS_ENVIRONMENT_ID, or use a synced workspace)");
  if (needs.bot && !botId) throw new Error("botId is required (pass it, set CPS_AGENT_ID, or use a synced workspace)");
  if (needs.dataverse && !dataverseUrl) {
    if (!environmentId) throw new Error("dataverseUrl or environmentId is required");
    const bap = await getToken(authCfg, [BAP_SCOPE]);
    dataverseUrl = (await getEnvironment(bap.accessToken, environmentId)).dataverseUrl;
    if (!dataverseUrl) throw new Error(`Environment ${environmentId} has no Dataverse instance`);
  }
  return { tenantId, clientId, environmentId, botId, dataverseUrl, schemaName: ws?.schemaName ?? null, authCfg };
}

function dryRun(summary: string, extra: Record<string, unknown> = {}) {
  return text({ dryRun: true, wouldDo: summary, ...extra, hint: "This mutates a live environment. Show the user what will happen, then call again with confirm: true." });
}

/**
 * Verified against pac 2.11.2: `pac copilot pack` on an init-only workspace
 * accepts settings, agent.mcs.yml, icon.png and topics/ and rejects every
 * other folder. The full layout is applied by `pac copilot push` from a
 * sync-connected workspace (clone or init --environment).
 */
function layoutNote(ws: WorkspaceInfo): string | null {
  if (ws.sync.source !== "none") return null;
  return "Workspace has no sync metadata (pac copilot init without --environment). 'pac copilot pack' packages only settings and topics; knowledge, tools, flows, triggers and variables are applied by 'pac copilot push' from a sync-connected workspace (cs_init_agent with environment, or cs_clone_agent).";
}

const COMPONENT_DIRS = ["topics", "knowledge", "actions", "tools", "trigger", "triggers", "variables"];

function validateWorkspaceFiles(root: string, only?: string): { files: { file: string; diagnostics: Diagnostic[] }[]; errors: number; warnings: number } {
  const ws = readWorkspace(root);
  const files: string[] = [];
  if (only) {
    files.push(path.isAbsolute(only) ? only : path.join(root, only));
  } else {
    for (const d of COMPONENT_DIRS) {
      const dir = path.join(root, d);
      if (fs.existsSync(dir)) files.push(...listFilesRecursive(dir, (f) => isYamlFile(f) && !f.includes(`${path.sep}files${path.sep}`), 2));
    }
    for (const n of ["agent.mcs.yml", "agent.mcs.yaml"]) if (fs.existsSync(path.join(root, n))) files.push(path.join(root, n));
  }
  const crEntries = readConnectionReferences(root).entries;
  const crNames = new Set(crEntries.map((e) => e.connectionReferenceLogicalName));
  const topicNames = new Set(ws.topics.map((t) => t.name.replace(/[^A-Za-z0-9]/g, "")));
  let errors = 0;
  let warnings = 0;
  const out = files.map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    let diagnostics: Diagnostic[];
    let doc: unknown = null;
    try {
      doc = yaml.load(raw);
      diagnostics = validateDocument(doc, raw);
    } catch (err) {
      diagnostics = [{ severity: "error", message: `YAML parse error: ${errorMessage(err)}` }];
    }
    // Cross-file checks
    if (doc && typeof doc === "object") {
      const d = doc as Record<string, unknown>;
      const action = d.action as Record<string, unknown> | undefined;
      const cr = action?.connectionReference;
      if (typeof cr === "string" && cr.includes("<AGENT_SCHEMA>")) diagnostics.push({ severity: "error", message: "connectionReference still contains <AGENT_SCHEMA>" });
      else if (typeof cr === "string" && crNames.size && !crNames.has(cr)) diagnostics.push({ severity: "warning", message: `connectionReference '${cr}' is not listed in connectionreferences.mcs.yml` });
      // Catalog check: does the operation exist on the connector (when its definition is cached)?
      if (action?.kind === "InvokeConnectorTaskAction" && typeof cr === "string" && typeof action.operationId === "string") {
        const connector = connectorFromReference(cr, crEntries);
        if (connector) {
          const chk = checkOperation(catalogDir(root), ws.sync.environmentId, connector, action.operationId);
          if (chk.known && chk.operationFound === false) diagnostics.push({ severity: "warning", message: chk.message ?? "operation not found in catalog" });
          else if (!chk.known) diagnostics.push({ severity: "info", message: chk.message ?? "no catalog" });
        }
      }
      const refs: string[] = [];
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        if (typeof o.dialog === "string") refs.push(o.dialog);
        Object.values(o).forEach(walk);
      };
      walk(d);
      for (const r of refs) {
        if (r.includes("<AGENT_SCHEMA>")) diagnostics.push({ severity: "error", message: `topic reference '${r}' still contains <AGENT_SCHEMA>` });
        const m = /\.topic\.([A-Za-z0-9_]+)$/.exec(r);
        if (m && topicNames.size && !topicNames.has(m[1]) && !/^(Escalate|Fallback|Greeting|Goodbye|ThankYou|StartOver|ConversationStart|OnError|EndOfConversation|Signin|MultipleTopicsMatched|ResetConversation)$/i.test(m[1])) {
          diagnostics.push({ severity: "warning", message: `redirect target '${r}' does not match any local topic (system topics are fine)` });
        }
      }
    }
    errors += diagnostics.filter((x) => x.severity === "error").length;
    warnings += diagnostics.filter((x) => x.severity === "warning").length;
    return { file: path.relative(root, file).split(path.sep).join("/"), diagnostics };
  });
  return { files: out, errors, warnings };
}

async function runChat(utterance: string, args: { workspace?: string; conversationId?: string; transport?: string; tokenEndpoint?: string; directLineSecret?: string; environmentId?: string; schemaName?: string; tenantId?: string; clientId?: string; dataverseUrl?: string; botId?: string }): Promise<ChatResult> {
  const transport = args.transport ?? "auto";
  if (transport === "directline" || args.tokenEndpoint || args.directLineSecret) {
    let tokenEndpoint = args.tokenEndpoint;
    if (!tokenEndpoint && !args.directLineSecret) {
      const ctx = await cloudContext(args, { environment: true });
      const schemaName = args.schemaName ?? ctx.schemaName;
      if (!schemaName) throw new Error("schemaName is required for DirectLine (from settings.mcs.yml or pass it)");
      tokenEndpoint = directLineTokenEndpoint(ctx.environmentId as string, schemaName);
    }
    return chatDirectLine(utterance, { tokenEndpoint, secret: args.directLineSecret, conversationId: args.conversationId });
  }
  const ctx = await cloudContext(args, { environment: true });
  const schemaName = args.schemaName ?? ctx.schemaName ?? null;
  let mode: "directline" | "sdk" = transport === "sdk" ? "sdk" : "directline";
  let resolvedSchema = schemaName;
  if (transport === "auto") {
    // Ask Dataverse which authentication mode the agent uses.
    try {
      const c2 = await cloudContext(args, { environment: true, bot: true, dataverse: true });
      const dv = await getToken(ctx.authCfg, [dataverseScope(c2.dataverseUrl as string)]);
      const bot = await getBot(c2.dataverseUrl as string, dv.accessToken, c2.botId as string);
      resolvedSchema = resolvedSchema ?? bot.schemaName;
      mode = bot.authenticationMode === 2 ? "sdk" : "directline";
      log(`agent ${bot.name} authenticationmode=${bot.authenticationMode} -> ${mode}`);
    } catch (err) {
      log(`auth-mode detection skipped (${errorMessage(err)}); defaulting to DirectLine`);
    }
  }
  if (!resolvedSchema) throw new Error("schemaName is required (from settings.mcs.yml, Dataverse, or pass it)");
  if (mode === "directline") {
    return chatDirectLine(utterance, { tokenEndpoint: directLineTokenEndpoint(ctx.environmentId as string, resolvedSchema), conversationId: args.conversationId });
  }
  const clientId = args.clientId ?? process.env.CPS_CLIENT_ID;
  if (!clientId) throw new Error("This agent uses Entra SSO (integrated authentication). Pass clientId of an app registration with the CopilotStudio.Copilots.Invoke delegated permission (redirect URI http://localhost).");
  const token = await getToken({ tenantId: ctx.tenantId, clientId }, [COPILOT_INVOKE_SCOPE]);
  return chatSdk(utterance, { environmentId: ctx.environmentId as string, schemaName: resolvedSchema, tenantId: ctx.tenantId === "organizations" ? undefined : ctx.tenantId, token: token.accessToken, conversationId: args.conversationId });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "copilot-studio-mcp", version: VERSION });

const workspaceArg = z.string().optional().describe("Path to (or inside) the agent workspace. Defaults to CPS_WORKSPACE or the current directory.");
const tenantArg = z.string().optional().describe("Entra tenant id. Defaults to the workspace sync metadata, then CPS_TENANT_ID.");
const clientArg = z.string().optional().describe("Entra app (client) id for MSAL. Defaults to CPS_CLIENT_ID, then the first-party VS Code id.");
const envArg = z.string().optional().describe("Power Platform environment id (GUID). Defaults to workspace sync metadata or CPS_ENVIRONMENT_ID.");
const botArg = z.string().optional().describe("Agent (bot) id. Defaults to workspace sync metadata or CPS_AGENT_ID.");
const confirmArg = z.boolean().optional().describe("Required to actually perform a change in a live environment. Without it the tool returns a dry run.");

// ---- doctor / auth --------------------------------------------------------

server.registerTool(
  "cs_doctor",
  {
    title: "Check prerequisites",
    description: "Report pac CLI, .NET, pac auth profiles, MSAL sign-in state, environment variables and the detected agent workspace. Run first in a new session.",
    inputSchema: { workspace: workspaceArg },
  },
  async ({ workspace }) => {
    const report: Record<string, unknown> = { serverVersion: VERSION };
    const pacPath = findPac();
    report.pac = pacPath ? { path: pacPath, version: await pacVersion().catch(() => null) } : { installed: false, hint: installHint() };
    try {
      const { stdout } = await execFileAsync("dotnet", ["--list-sdks"], { timeout: 20_000, windowsHide: true });
      report.dotnetSdks = stdout.trim().split(/\r?\n/);
    } catch (err) {
      report.dotnetSdks = { error: errorMessage(err) };
    }
    if (pacPath) {
      const auth = await runPac(["auth", "list"], { timeoutMs: 60_000 }).catch((e: unknown) => null);
      report.pacAuthProfiles = auth ? parseAuthList(auth.stdout) : [];
      if (auth && (report.pacAuthProfiles as unknown[]).length === 0) report.pacAuthHint = "No pac auth profile. In a terminal run: pac auth create --environment <environment id or URL>";
    }
    const env = ["CPS_TENANT_ID", "CPS_CLIENT_ID", "CPS_ENVIRONMENT_ID", "CPS_ENVIRONMENT_URL", "CPS_AGENT_ID", "CPS_WORKSPACE", "PAC_PATH", "DOTNET_ROOT"];
    report.env = Object.fromEntries(env.map((k) => [k, process.env[k] ? (k === "CPS_CLIENT_ID" ? "(set)" : process.env[k]) : null]));
    const ws = tryWorkspace(workspace);
    report.workspace = ws ? { root: ws.root, harness: ws.harness, schemaName: ws.schemaName, sync: ws.sync.source, environmentId: ws.sync.environmentId, agentId: ws.sync.agentId } : { found: false, searchedFrom: workspace ?? process.env.CPS_WORKSPACE ?? process.cwd() };
    try {
      const tenantId = resolveTenantId(ws?.sync.tenantId ?? undefined);
      report.msalAccounts = await listAccounts({ tenantId });
      report.pendingLogin = pendingLoginStatus();
    } catch (err) {
      report.msalAccounts = { error: errorMessage(err) };
    }
    report.schema = { path: schemaPath(), kinds: listKinds().length };
    return text(report);
  },
);

server.registerTool(
  "cs_login",
  {
    title: "Sign in (MSAL)",
    description:
      "Acquire a Microsoft Entra token for the cloud tools (evaluations, environments, agents, publish, chat). mode 'interactive' opens a browser and waits; mode 'device_code' returns a code immediately and completes in the background (check cs_login_status). Not needed for pac commands, which use 'pac auth create'.",
    inputSchema: {
      mode: z.enum(["interactive", "device_code"]).optional().describe("Default interactive"),
      tenantId: tenantArg,
      clientId: clientArg,
      scope: z.enum(["powerplatform", "bap", "dataverse", "copilot_invoke"]).optional().describe("Which resource to pre-authorise. Default powerplatform (evaluations). Others are acquired silently later when possible."),
      dataverseUrl: z.string().optional().describe("Required when scope is dataverse, e.g. https://org.crm.dynamics.com"),
      workspace: workspaceArg,
    },
  },
  async ({ mode, tenantId, clientId, scope, dataverseUrl, workspace }) => {
    try {
      const ws = tryWorkspace(workspace);
      const cfg: AuthConfig = { tenantId: resolveTenantId(tenantId ?? ws?.sync.tenantId ?? undefined), clientId };
      const scopes =
        scope === "bap" ? [BAP_SCOPE] : scope === "dataverse" ? [dataverseScope(dataverseUrl ?? ws?.sync.dataverseUrl ?? (() => { throw new Error("dataverseUrl required"); })())] : scope === "copilot_invoke" ? [COPILOT_INVOKE_SCOPE] : [PPAPI_SCOPE];
      if (mode === "device_code") {
        const info = await startDeviceCodeLogin(cfg, scopes);
        return text({ status: "device_code", ...info, next: "Tell the user to open verificationUri and enter userCode. Then call cs_login_status or any cloud tool." });
      }
      const tok = await acquireInteractive(cfg, scopes);
      return text({ status: "ok", account: tok.account, expiresOn: tok.expiresOn, scopes: tok.scopes, clientId: effectiveClientId(clientId) === "51f81489-12ee-4a9e-aaae-a2591f45987d" ? "first-party (VS Code)" : "custom" });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_login_status",
  { title: "Sign-in status", description: "Show cached MSAL accounts and whether a device-code login is still pending; optionally wait for it.", inputSchema: { wait: z.boolean().optional(), tenantId: tenantArg, workspace: workspaceArg } },
  async ({ wait, tenantId, workspace }) => {
    try {
      const ws = tryWorkspace(workspace);
      const cfg: AuthConfig = { tenantId: resolveTenantId(tenantId ?? ws?.sync.tenantId ?? undefined) };
      if (wait) await waitForPendingLogin(600_000).catch((e: unknown) => log(errorMessage(e)));
      return text({ pending: pendingLoginStatus(), accounts: await listAccounts(cfg) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_logout", { title: "Sign out", description: "Remove cached MSAL accounts for the tenant.", inputSchema: { tenantId: tenantArg } }, async ({ tenantId }) => {
  try {
    return text({ removedAccounts: await signOut({ tenantId: resolveTenantId(tenantId) }) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

// ---- environments / agents ------------------------------------------------

server.registerTool(
  "cs_list_environments",
  { title: "List environments", description: "List Power Platform environments the signed-in user can access (BAP API), with Dataverse URLs.", inputSchema: { tenantId: tenantArg, clientId: clientArg } },
  async ({ tenantId, clientId }) => {
    try {
      const cfg: AuthConfig = { tenantId: resolveTenantId(tenantId), clientId };
      const tok = await getToken(cfg, [BAP_SCOPE]);
      const envs = await listEnvironments(tok.accessToken);
      return text({ count: envs.length, environments: envs });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_list_agents",
  {
    title: "List agents",
    description: "List Copilot Studio agents in an environment. via 'pac' uses 'pac copilot list' (needs a pac auth profile); via 'dataverse' queries the bots table with the MSAL token. Default auto: pac when available, else dataverse.",
    inputSchema: { environmentId: envArg, dataverseUrl: z.string().optional(), via: z.enum(["auto", "pac", "dataverse"]).optional(), ownerOnly: z.boolean().optional(), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (args) => {
    try {
      const via = args.via ?? "auto";
      if (via === "pac" || (via === "auto" && findPac())) {
        const ws = tryWorkspace(args.workspace);
        const envId = args.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID;
        const r = await runPac(["copilot", "list", ...(envId ? ["--environment", envId] : [])], { timeoutMs: 120_000 });
        if (r.ok) return text({ via: "pac", environmentId: envId ?? "(active profile)", agents: parseCopilotList(r.stdout), raw: tail(r.stdout, 40) });
        if (via === "pac") return fail(explainFailure(r));
        log(`pac copilot list failed (${explainFailure(r)}); falling back to Dataverse`);
      }
      const ctx = await cloudContext(args, { dataverse: true });
      const tok = await getToken(ctx.authCfg, [dataverseScope(ctx.dataverseUrl as string)]);
      const bots = await listBots(ctx.dataverseUrl as string, tok.accessToken, { ownerOnly: args.ownerOnly });
      return text({ via: "dataverse", dataverseUrl: ctx.dataverseUrl, count: bots.length, agents: bots });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---- sync (pac) -----------------------------------------------------------

server.registerTool(
  "cs_init_agent",
  {
    title: "Scaffold a new agent workspace",
    description:
      "pac copilot init: create a new agent workspace on disk. Without 'environment' it is a local scaffold (no sign-in). With 'environment' it also creates the live agent and connects the workspace (needs pac auth profile and confirm: true). With 'solutionName' the agent is created inside that solution (existing unmanaged solution, or a new one with createSolution: true) via init, pack, import and clone; without it, pac puts the agent in a solution named after the agent. authoringMode 'classic' is the standard harness (topics, evaluations); 'cli-copilot' is the GitHub Copilot harness.",
    inputSchema: {
      name: z.string().describe("Agent display name"),
      publisherPrefix: z.string().describe("Solution publisher prefix, e.g. contoso; must match the publisher of an existing target solution"),
      projectDir: z.string().describe("Target directory (must be empty or not exist)"),
      authoringMode: z.enum(["classic", "cli-copilot"]).optional(),
      template: z.enum(["default", "minimal"]).optional().describe("classic only"),
      instructions: z.string().optional(),
      schemaName: z.string().optional(),
      environment: z.string().optional().describe("Environment id or URL to bootstrap into (creates a live agent)"),
      solutionName: z.string().optional().describe("Unique name of the solution to create the agent in (requires environment)"),
      createSolution: z.boolean().optional().describe("Create solutionName if it does not exist"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      if (a.environment && !a.confirm) return dryRun(`create agent '${a.name}' in environment ${a.environment}${a.solutionName ? ` inside solution ${a.solutionName}${a.createSolution ? " (created if missing)" : ""}` : " (in a solution named after the agent)"}`);
      if (a.environment && a.solutionName) {
        const r = await initAgentInSolution({ name: a.name, publisherPrefix: a.publisherPrefix, projectDir: a.projectDir, solutionName: a.solutionName, environment: a.environment, createSolution: a.createSolution, instructions: a.instructions, schemaName: a.schemaName, template: a.template, authoringMode: a.authoringMode });
        return text({ ...r, workspaceInfo: describeWorkspace(readWorkspace(r.workspace)) });
      }
      if (a.solutionName && !a.environment) return fail("solutionName needs environment");
      const args = ["copilot", "init", "--name", a.name, "--publisher-prefix", a.publisherPrefix, "--project-dir", a.projectDir];
      if (a.authoringMode) args.push("--authoring-mode", a.authoringMode);
      if (a.template) args.push("--template", a.template);
      if (a.instructions) args.push("--instructions", a.instructions);
      if (a.schemaName) args.push("--schema-name", a.schemaName);
      if (a.environment) args.push("--environment", a.environment);
      const r = await runPac(args, { timeoutMs: 15 * 60_000 });
      const root = fs.existsSync(a.projectDir) ? findWorkspaceRoot(a.projectDir) : null;
      return text({ ...pacSummary(r), workspace: root ? describeWorkspace(readWorkspace(root)) : null });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_clone_agent",
  {
    title: "Clone an agent to disk",
    description: "pac copilot clone: download an existing agent into a sync-connected workspace (a subfolder named after the agent under outputDir). Needs a pac auth profile.",
    inputSchema: { bot: z.string().describe("Agent id (GUID) or schema name"), environment: z.string().optional().describe("Environment id or URL; default active profile"), outputDir: z.string().optional(), displayName: z.string().optional().describe("Folder name override"), componentCollections: z.array(z.string()).optional() },
  },
  async (a) => {
    try {
      const args = ["copilot", "clone", "--bot", a.bot];
      if (a.environment) args.push("--environment", a.environment);
      if (a.outputDir) args.push("--output-dir", a.outputDir);
      if (a.displayName) args.push("--display-name", a.displayName);
      for (const cc of a.componentCollections ?? []) args.push("--component-collection", cc);
      const r = await runPac(args, { timeoutMs: 15 * 60_000 });
      let workspace: unknown = null;
      if (r.ok) {
        const base = a.outputDir ?? process.cwd();
        const root = findWorkspaceRoot(base);
        if (root) workspace = describeWorkspace(readWorkspace(root));
      }
      return text({ ...pacSummary(r), workspace });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_pull", { title: "Pull remote changes", description: "pac copilot pull: three-way merge of server changes into the local workspace (also downloads knowledge files). Run before editing and before pushing.", inputSchema: { workspace: workspaceArg } }, async ({ workspace }) => {
  try {
    const root = resolveRoot(workspace);
    const r = await runPac(["copilot", "pull", "--project-dir", root], { cwd: root, timeoutMs: 15 * 60_000 });
    return text(pacSummary(r));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_push",
  {
    title: "Push local changes",
    description: "pac copilot push: upload local workspace changes to the live agent (topics, knowledge files, flows, connection references). Validates YAML first and blocks on errors unless force. Mutates the live agent: requires confirm: true.",
    inputSchema: { workspace: workspaceArg, force: z.boolean().optional().describe("Push even if validation reports errors"), confirm: confirmArg },
  },
  async ({ workspace, force, confirm }) => {
    try {
      const root = resolveRoot(workspace);
      const validation = validateWorkspaceFiles(root);
      if (validation.errors > 0 && !force) {
        return { ...text({ blocked: true, reason: `${validation.errors} validation error(s); fix them or pass force: true`, validation }), isError: true as const };
      }
      const ws = readWorkspace(root);
      if (!confirm) return dryRun(`pac copilot push from ${root} to agent ${ws.sync.agentId ?? "(from sync metadata)"} in environment ${ws.sync.environmentId ?? "(from sync metadata)"}`, { validation: { errors: validation.errors, warnings: validation.warnings } });
      const r = await runPac(["copilot", "push", "--project-dir", root], { cwd: root, timeoutMs: 15 * 60_000 });
      return text({ ...pacSummary(r), validation: { errors: validation.errors, warnings: validation.warnings } });
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
    description: "Make the draft agent live for its channels. via 'pac' runs 'pac copilot publish'; via 'dataverse' calls the PvaPublish action with the MSAL token and polls until publishedon changes. Requires confirm: true.",
    inputSchema: { workspace: workspaceArg, botId: botArg, environmentId: envArg, dataverseUrl: z.string().optional(), via: z.enum(["pac", "dataverse"]).optional(), tenantId: tenantArg, clientId: clientArg, timeoutSeconds: z.number().optional(), confirm: confirmArg },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { bot: true });
      if (!a.confirm) return dryRun(`publish agent ${ctx.botId} (environment ${ctx.environmentId ?? "active profile"}) via ${a.via ?? "pac"}; every user the agent is shared with gets this version`);
      if ((a.via ?? "pac") === "pac") {
        const args = ["copilot", "publish", "--bot", ctx.botId as string];
        if (ctx.environmentId) args.push("--environment", ctx.environmentId);
        return text(pacSummary(await runPac(args, { timeoutMs: 15 * 60_000 })));
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

const READ_ONLY_PAC = [/^(help|--version|-v)$/, /^auth (list|who)$/, /^org (who|list|fetch)$/, /^env (list|who|fetch)$/, /^copilot (list|status|model list)$/, /^solution (list|version)$/, /^admin (list|list-tenant-settings|status)$/, /^connection list$/, /^connector list$/];

server.registerTool(
  "cs_pac",
  { title: "Run any pac command", description: "Escape hatch: run 'pac <args...>' directly. Read-only commands (list/who/status/help) run immediately; anything else needs confirm: true.", inputSchema: { args: z.array(z.string()).describe("Arguments after 'pac', e.g. [\"env\",\"list\"]"), cwd: z.string().optional(), confirm: confirmArg, timeoutSeconds: z.number().optional() } },
  async ({ args, cwd, confirm, timeoutSeconds }) => {
    try {
      const head = args.slice(0, 3).join(" ");
      const readOnly = READ_ONLY_PAC.some((re) => re.test(args.slice(0, 2).join(" ")) || re.test(head) || re.test(args[0] ?? ""));
      if (!readOnly && !confirm) return dryRun(`pac ${args.join(" ")}`);
      return text(pacSummary(await runPac(args, { cwd, timeoutMs: (timeoutSeconds ?? 600) * 1000 })));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---- authoring ------------------------------------------------------------

server.registerTool("cs_describe_workspace", { title: "Describe the workspace", description: "Inventory of an agent workspace: settings, instructions, topics (with trigger phrases), knowledge sources, tools, flows, triggers, variables, connection references, sync metadata.", inputSchema: { workspace: workspaceArg } }, async ({ workspace }) => {
  try {
    return text(describeWorkspace(readWorkspace(resolveRoot(workspace))));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_validate",
  { title: "Validate workspace YAML", description: "Structural validation of every component file against the Copilot Studio authoring schema (kinds, unknown/missing properties, duplicate ids, placeholders, Power Fx prefixes, variable scopes) plus cross-file checks (connection references, topic redirects). Run before cs_push.", inputSchema: { workspace: workspaceArg, file: z.string().optional().describe("Validate a single file (relative to workspace)") } },
  async ({ workspace, file }) => {
    try {
      const root = resolveRoot(workspace);
      const v = validateWorkspaceFiles(root, file);
      return text({ valid: v.errors === 0, errors: v.errors, warnings: v.warnings, files: v.files.filter((f) => f.diagnostics.length > 0), checked: v.files.length });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_lookup_schema",
  { title: "Look up the YAML schema", description: "Inspect the Copilot Studio authoring schema: summarize or resolve a definition (e.g. Question, SearchAndSummarizeContent, KnowledgeSourceConfiguration), search by keyword, or list all kinds.", inputSchema: { name: z.string().optional(), search: z.string().optional(), resolve: z.boolean().optional().describe("Return the full resolved JSON instead of a summary"), depth: z.number().optional(), listKinds: z.boolean().optional() } },
  async ({ name, search, resolve, depth, listKinds: lk }) => {
    try {
      if (lk) return text({ kinds: listKinds() });
      if (search) return text({ matches: searchDefinitions(search) });
      if (!name) return fail("Pass name, search, or listKinds");
      if (resolve) return text(resolveDefinition(lookupDefinition(name)?.name ?? name, depth ?? 3));
      return text(summarizeDefinition(name));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

const actionSpec: z.ZodType<ActionSpec> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), text: z.union([z.string(), z.array(z.string())]), speak: z.union([z.string(), z.array(z.string())]).optional() }),
    z.object({
      type: z.literal("question"),
      prompt: z.string(),
      variable: z.string().describe("Topic.Name (prefix optional)"),
      entity: z.enum(["String", "Boolean", "Number", "Email", "Date", "DateTime", "PhoneNumber", "URL", "Money", "PersonName", "City", "CountryOrRegion", "Organization", "Percentage", "Age", "Duration", "Color", "Language", "ZipCode", "StreetAddress", "File"]).optional(),
      choices: z.array(z.string()).optional().describe("Multiple-choice options (closed list) instead of an entity"),
      allowInterruption: z.boolean().optional(),
    }),
    z.object({ type: z.literal("condition"), cases: z.array(z.object({ condition: z.string().describe("Power Fx, e.g. Topic.Choice = \"Yes\""), actions: z.array(actionSpec) })), else: z.array(actionSpec).optional() }),
    z.object({ type: z.literal("redirect"), topic: z.string().describe("Topic name or full reference"), replace: z.boolean().optional() }),
    z.object({ type: z.literal("setVariable"), variable: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ type: z.literal("searchKnowledge"), variable: z.string().optional(), endIfAnswered: z.boolean().optional() }),
    z.object({ type: z.literal("http"), method: z.enum(["Get", "Post", "Put", "Patch", "Delete"]).optional(), url: z.string(), headers: z.record(z.string()).optional(), body: z.unknown().optional(), responseVariable: z.string() }),
    z.object({ type: z.literal("invokeFlow"), flowId: z.string(), input: z.record(z.string()).optional(), output: z.record(z.string()).optional() }),
    z.object({ type: z.literal("end"), clearTopicQueue: z.boolean().optional() }),
    z.object({ type: z.literal("raw"), node: z.record(z.unknown()).describe("A full DialogAction node; 'id' is added if missing") }),
  ]),
) as z.ZodType<ActionSpec>;

server.registerTool(
  "cs_add_topic",
  {
    title: "Add a topic",
    description: "Create topics/<name>.topic.mcs.yml from a declarative spec: trigger phrases (or a system trigger) plus message / question / condition / redirect / setVariable / searchKnowledge / http / invokeFlow / end / raw nodes. Validates the result. Push to apply.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      triggerPhrases: z.array(z.string()).optional().describe("User phrases that start the topic (OnRecognizedIntent)"),
      triggerKind: z.enum(["conversationStart", "unknownIntent", "escalate", "inactivity", "error", "signIn", "redirect", "planComplete"]).optional().describe("System trigger instead of phrases"),
      priority: z.number().optional(),
      actions: z.array(actionSpec),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const trigger: TopicSpec["trigger"] = a.triggerPhrases?.length ? { kind: "phrases", phrases: a.triggerPhrases } : a.triggerKind ? { kind: a.triggerKind } : { kind: "phrases", phrases: [] };
      const r = addTopic(root, { name: a.name, description: a.description, trigger, priority: a.priority, actions: a.actions, agentSchemaName: ws.schemaName ?? undefined, overwrite: a.overwrite });
      const v = validateWorkspaceFiles(root, r.file);
      return text({ ...r, validation: v.files[0]?.diagnostics ?? [], yaml: fs.readFileSync(r.file, "utf8") });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_add_knowledge_source",
  {
    title: "Add a knowledge source",
    description: "Add knowledge as YAML: kind 'public-site' (Bing-scoped website, max 2 path levels), 'sharepoint' (direct folder URL), 'graph-connector' (Microsoft Graph connector via environment variable), or 'files' (copy documents into knowledge/files for upload on push). Dataverse, AI Search and SQL knowledge are portal-only.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      kind: z.enum(["public-site", "sharepoint", "graph-connector", "files"]),
      site: z.string().optional(),
      includeSubPages: z.boolean().optional(),
      connectionEnvironmentVariable: z.string().optional(),
      connectionName: z.string().optional(),
      contentSourceDisplayName: z.string().optional(),
      files: z.array(z.string()).optional().describe("Absolute paths of documents (pdf, docx, txt, ...)"),
      triggerCondition: z.string().optional().describe("Power Fx condition restricting when this source is searched"),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = addKnowledgeSource(root, a);
      const yamlFile = r.files.find((f) => f.endsWith(".yml"));
      const validation = yamlFile ? validateWorkspaceFiles(root, yamlFile).files[0]?.diagnostics ?? [] : [];
      return text({ ...r, validation, layoutNote: layoutNote(readWorkspace(root)), ...(yamlFile ? { yaml: fs.readFileSync(yamlFile, "utf8") } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

const toolInput = z.union([
  z.object({ kind: z.literal("automatic"), name: z.string(), description: z.string(), entity: z.string().optional(), shouldPromptUser: z.boolean().optional() }),
  z.object({ kind: z.literal("manual"), name: z.string(), value: z.string().describe("Literal or Power Fx (=System.User.Email)") }),
]);

server.registerTool(
  "cs_add_tool",
  {
    title: "Add a tool (connector, MCP server, flow, prompt, agent, or raw)",
    description:
      "Create actions/<name>.mcs.yml. type 'connector': a connector operation (connectorId like shared_office365, operationId like SendEmailV2; use cs_list_connectors / cs_describe_connector to find them). type 'mcp': an MCP server exposed through a connector. type 'flow': a cloud flow by id. type 'prompt': an AI Builder prompt by model id (cs_list_prompts). type 'connected-agent': another Copilot Studio agent by schema name. type 'child-agent': a child agent's GPT component. type 'raw': any other TaskAction kind with the action object supplied. When the connector definition is cached, the operationId is checked and required inputs are filled from the catalog unless inputs are given. Connector and MCP tools need a connection that only the portal can authorise; the tool writes the connection-reference stub and returns the portal step.",
    inputSchema: {
      workspace: workspaceArg,
      type: z.enum(["connector", "mcp", "flow", "prompt", "connected-agent", "child-agent", "raw"]),
      name: z.string(),
      description: z.string().describe("Also used as modelDescription unless overridden; the orchestrator routes on it"),
      modelDescription: z.string().optional(),
      connectorId: z.string().optional().describe("shared_<name> or a display name from the catalog"),
      operationId: z.string().optional(),
      connectionReference: z.string().optional().describe("Existing logical name from connectionreferences.mcs.yml"),
      connectionMode: z.enum(["Invoker", "Maker"]).optional().describe("Invoker = end user's connection; Maker = the maker's shared connection"),
      flowId: z.string().optional(),
      aiModelId: z.string().optional().describe("type prompt: AI Builder model id"),
      botSchemaName: z.string().optional().describe("type connected-agent"),
      gptComponentSchemaName: z.string().optional().describe("type child-agent"),
      action: z.record(z.unknown()).optional().describe("type raw: full TaskAction object with kind"),
      inputs: z.array(toolInput).optional(),
      inputsFromCatalog: z.boolean().optional().describe("Default true: when no inputs are given and the connector definition is cached, add automatic inputs for the operation's required parameters"),
      outputs: z.array(z.string()).optional(),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const catalog: Record<string, unknown> = {};
      let spec: ToolSpec;
      let inputs = a.inputs;
      let connectorId = a.connectorId;
      if (connectorId && !/^shared_/i.test(connectorId) && !/^[a-z0-9_]+$/i.test(connectorId)) {
        // Display name given: resolve through the cached list or the seed.
        const cached = ws.sync.environmentId ? readConnectorList(catalogDir(root), ws.sync.environmentId)?.connectors : null;
        const hit = searchConnectors(connectorId, cached ?? loadSeed());
        if (hit.length === 1) {
          catalog.resolvedConnector = { from: connectorId, to: hit[0].name, displayName: hit[0].displayName };
          connectorId = hit[0].name;
        } else return fail(`connectorId '${connectorId}' is ambiguous or unknown (${hit.length} matches: ${hit.slice(0, 8).map((h) => h.name).join(", ")}). Use cs_list_connectors and pass the shared_ name.`);
      }
      if (a.type === "connector" && connectorId && a.operationId) {
        const chk = checkOperation(catalogDir(root), ws.sync.environmentId, connectorId, a.operationId);
        catalog.operationCheck = chk;
        if (chk.known && chk.operationFound === false) return fail(chk.message ?? "operation not found in the cached connector definition");
        if (chk.known && (!inputs || inputs.length === 0) && a.inputsFromCatalog !== false) {
          const def = readConnectorDefinition(catalogDir(root), ws.sync.environmentId, connectorId);
          const op = def?.operations.find((o) => o.operationId === a.operationId);
          if (op) {
            inputs = inputsFromOperation(op);
            catalog.inputsFromCatalog = inputs.map((i) => i.name);
          }
        }
      }
      const base = { name: a.name, description: a.description, modelDescription: a.modelDescription, inputs, outputs: a.outputs, overwrite: a.overwrite };
      switch (a.type) {
        case "flow":
          if (!a.flowId) return fail("flowId is required for type 'flow'");
          spec = { ...base, type: "flow", flowId: a.flowId };
          break;
        case "connector":
          if (!connectorId || !a.operationId) return fail("connectorId and operationId are required for type 'connector'");
          spec = { ...base, type: "connector", connectorId, operationId: a.operationId, connectionReference: a.connectionReference, connectionMode: a.connectionMode };
          break;
        case "mcp":
          if (!connectorId) return fail("connectorId is required for type 'mcp' (the connector that wraps the MCP server)");
          spec = { ...base, type: "mcp", connectorId, operationId: a.operationId, connectionReference: a.connectionReference, connectionMode: a.connectionMode };
          break;
        case "prompt":
          if (!a.aiModelId) return fail("aiModelId is required for type 'prompt' (see cs_list_prompts)");
          spec = { ...base, type: "prompt", aiModelId: a.aiModelId };
          break;
        case "connected-agent":
          if (!a.botSchemaName) return fail("botSchemaName is required for type 'connected-agent'");
          spec = { ...base, type: "connected-agent", botSchemaName: a.botSchemaName };
          break;
        case "child-agent":
          if (!a.gptComponentSchemaName) return fail("gptComponentSchemaName is required for type 'child-agent'");
          spec = { ...base, type: "child-agent", gptComponentSchemaName: a.gptComponentSchemaName };
          break;
        default:
          if (!a.action) return fail("action is required for type 'raw'");
          spec = { ...base, type: "raw", action: a.action };
      }
      const r = addTool(root, spec, ws.schemaName ?? undefined);
      const validation = validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [];
      return text({ ...r, catalog, validation, layoutNote: layoutNote(ws), yaml: fs.readFileSync(r.file, "utf8") });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---- tool catalog ---------------------------------------------------------

async function powerAppsToken(args: { tenantId?: string; clientId?: string; workspace?: string }): Promise<string> {
  const ws = tryWorkspace(args.workspace);
  const cfg: AuthConfig = { tenantId: resolveTenantId(args.tenantId ?? ws?.sync.tenantId ?? undefined), clientId: args.clientId };
  return (await getToken(cfg, [BAP_SCOPE])).accessToken;
}

server.registerTool(
  "cs_list_connectors",
  {
    title: "List connectors available in an environment",
    description: "The environment's connector registry (the same list the portal's Add a tool shows): Microsoft-published and custom connectors, with an mcpLikely flag for MCP servers. Cached under .cs-catalog/<environment>/connectors.json for offline use; with search and no sign-in, falls back to the offline seed of public connectors.",
    inputSchema: { environmentId: envArg, search: z.string().optional(), customOnly: z.boolean().optional(), mcpOnly: z.boolean().optional(), refresh: z.boolean().optional().describe("Fetch again even if cached"), offline: z.boolean().optional().describe("Use cache or seed only"), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (a) => {
    try {
      const ws = tryWorkspace(a.workspace);
      const root = ws?.root;
      const environmentId = a.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID ?? null;
      const dir = catalogDir(root);
      let source = "cache";
      let list = environmentId ? (readConnectorList(dir, environmentId)?.connectors ?? null) : null;
      if ((!list || a.refresh) && !a.offline && environmentId) {
        const token = await powerAppsToken(a);
        list = await fetchConnectorList(environmentId, token);
        writeConnectorList(dir, environmentId, list);
        source = "registry";
      }
      if (!list) {
        list = loadSeed().map((s) => ({ name: s.name, id: `/providers/Microsoft.PowerApps/apis/${s.name}`, displayName: s.displayName, description: null, publisher: "Microsoft (seed)", tier: null, isCustom: false, mcpLikely: /mcp/i.test(s.name) || /\bmcp\b/i.test(s.displayName), iconUri: null }));
        source = "seed (public connector reference; confirm ids against the environment)";
      }
      let out = list;
      if (a.customOnly) out = out.filter((c) => c.isCustom);
      if (a.mcpOnly) out = out.filter((c) => c.mcpLikely);
      if (a.search) out = searchConnectors(a.search, out) as typeof out;
      return text({ environmentId, source, total: list.length, returned: Math.min(out.length, 200), connectors: out.slice(0, 200).map(({ iconUri: _i, ...c }) => c) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_describe_connector",
  {
    title: "Describe a connector's operations",
    description: "Fetch (or read from cache) a connector's OpenAPI definition and list its operations with operationId, parameters (required, type, description) and response fields; marks MCP-capable connectors (x-ms-agentic-protocol). Exactly what cs_add_tool needs. Cached under .cs-catalog/<environment>/connectors/<name>.json and used by cs_validate.",
    inputSchema: { connector: z.string().describe("shared_<name> or a display name"), environmentId: envArg, operation: z.string().optional().describe("Filter operations by id or summary"), includeInternal: z.boolean().optional(), refresh: z.boolean().optional(), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (a) => {
    try {
      const ws = tryWorkspace(a.workspace);
      const root = ws?.root;
      const environmentId = a.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID ?? null;
      const dir = catalogDir(root);
      let name = a.connector;
      if (!/^shared_/i.test(name)) {
        const pool = (environmentId ? readConnectorList(dir, environmentId)?.connectors : null) ?? loadSeed();
        const hit = searchConnectors(name, pool);
        if (hit.length !== 1) return fail(`'${name}' matched ${hit.length} connectors: ${hit.slice(0, 10).map((h) => `${h.name} (${h.displayName})`).join(", ")}. Pass the shared_ name.`);
        name = hit[0].name;
      }
      let def: ConnectorDefinition | null = a.refresh ? null : readConnectorDefinition(dir, environmentId, name);
      let source = "cache";
      if (!def) {
        if (!environmentId) return fail("environmentId is required to fetch a connector definition (or use a synced workspace)");
        const token = await powerAppsToken(a);
        const { api, swagger } = await fetchConnectorSwagger(environmentId, name, token);
        def = toDefinition(api, swagger);
        writeConnectorDefinition(dir, environmentId, def);
        source = swagger ? "registry" : "registry (no OpenAPI definition returned)";
      }
      let ops = def.operations;
      if (!a.includeInternal) ops = ops.filter((o) => o.visibility !== "internal");
      if (a.operation) {
        const q = a.operation.toLowerCase();
        ops = ops.filter((o) => o.operationId.toLowerCase().includes(q) || (o.summary ?? "").toLowerCase().includes(q));
      }
      return text({
        source,
        connector: { name: def.name, displayName: def.displayName, isCustom: def.isCustom, mcp: def.mcp, fetchedAt: def.fetchedAt },
        operationCount: def.operations.length,
        operations: ops.slice(0, 100).map((o) => ({ operationId: o.operationId, summary: o.summary, method: o.method, mcp: o.mcp, visibility: o.visibility, requiredParameters: o.parameters.filter((p) => p.required).map((p) => `${p.name}${p.type ? `:${p.type}` : ""}`), optionalParameters: o.parameters.filter((p) => !p.required).map((p) => p.name), responseProperties: o.responseProperties })),
        usage: def.mcp ? `cs_add_tool type=mcp connectorId=${def.name}` : `cs_add_tool type=connector connectorId=${def.name} operationId=<operationId>`,
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_list_prompts", { title: "List AI Builder prompts / models", description: "pac copilot model list: AI Builder models (including custom prompts) in the environment, with ids for cs_add_tool type 'prompt'.", inputSchema: { environment: z.string().optional().describe("Environment id or URL; default active pac profile"), activeOnly: z.boolean().optional(), search: z.string().optional() } }, async ({ environment, activeOnly, search }) => {
  try {
    let rows = await listPrompts(environment);
    if (activeOnly) rows = rows.filter((r) => /^active$/i.test(r.state));
    if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
    return text({ count: rows.length, prompts: rows });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_add_flow",
  {
    title: "Scaffold a cloud flow (experimental)",
    description: "EXPERIMENTAL: write workflows/<Name>/metadata.yaml + workflow.json for a flow with the 'when an agent calls the flow' trigger and a response, optionally exposing it as a tool. Format follows the schema's CloudFlowDefinition and the Power Automate solution JSON; verify with cs_pack and in the portal after push.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      inputs: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]).optional(), description: z.string().optional() })).optional(),
      outputs: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]).optional(), value: z.string().optional().describe("Power Automate expression for the response value") })).optional(),
      actions: z.record(z.unknown()).optional().describe("Extra Power Automate actions (name -> definition) inserted before the response"),
      addTool: z.boolean().optional().describe("Also create actions/<name>.mcs.yml invoking this flow"),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = scaffoldFlow(root, a);
      const ws = readWorkspace(root);
      let tool: unknown = null;
      if (a.addTool) tool = addTool(root, { type: "flow", name: a.name, description: a.description ?? `Runs the ${a.name} flow`, flowId: r.workflowId, overwrite: a.overwrite }, ws.schemaName ?? undefined);
      return text({ ...r, tool, layoutNote: layoutNote(ws) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_add_trigger", { title: "Add an event trigger", description: "Create trigger/<name>.trigger.mcs.yml pointing at a cloud flow that starts the agent (WorkflowExternalTrigger).", inputSchema: { workspace: workspaceArg, name: z.string(), description: z.string().optional(), flowId: z.string(), overwrite: z.boolean().optional() } }, async (a) => {
  try {
    const root = resolveRoot(a.workspace);
    const r = addTrigger(root, a);
    return text({ ...r, validation: validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [], layoutNote: layoutNote(readWorkspace(root)) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool("cs_add_variable", { title: "Add a global variable", description: "Create variables/<name>.variable.mcs.yml (GlobalVariableComponent, conversation scope).", inputSchema: { workspace: workspaceArg, name: z.string(), description: z.string().optional(), defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(), aiVisibility: z.enum(["UseInAIContext", "Hidden"]).optional(), overwrite: z.boolean().optional() } }, async (a) => {
  try {
    const root = resolveRoot(a.workspace);
    const ws = readWorkspace(root);
    return text({ ...addGlobalVariable(root, { ...a, agentSchemaName: ws.schemaName ?? undefined }), layoutNote: layoutNote(ws) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_update_agent",
  {
    title: "Update agent instructions / starters / model",
    description: "Edit agent.mcs.yml (standard harness): replace or append instructions, set displayName, replace or add conversation starters, set the model hint. For GitHub Copilot harness (cli-copilot) workspaces the instructions go into settings.mcs.yml.",
    inputSchema: { workspace: workspaceArg, instructions: z.string().optional(), appendInstructions: z.string().optional(), displayName: z.string().optional(), conversationStarters: z.array(z.object({ title: z.string(), text: z.string() })).optional(), addConversationStarters: z.array(z.object({ title: z.string(), text: z.string() })).optional(), modelNameHint: z.string().optional() },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      if (ws.harness === "github-copilot") {
        if (!a.instructions) return fail("cli-copilot workspaces only support 'instructions' here");
        return text(updateCliCopilotInstructions(root, a.instructions));
      }
      return text(updateAgent(root, a));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_update_settings", { title: "Update settings.mcs.yml", description: "Set values in settings.mcs.yml by dot path, e.g. {\"configuration.settings.GenerativeActionsEnabled\": true}. Do not change authoringModel/recognizer/template.", inputSchema: { workspace: workspaceArg, patch: z.record(z.unknown()) } }, async ({ workspace, patch }) => {
  try {
    const forbidden = Object.keys(patch).filter((k) => /authoringModel|recognizer\.kind|^template$/.test(k));
    if (forbidden.length) return fail(`Refusing to change ${forbidden.join(", ")}: the tooling relies on them`);
    return text(updateSettings(resolveRoot(workspace), patch));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

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
    description: "Start an evaluation run for a test set (draft agent by default, or the published one). Optionally wait for completion and return the summary. Counts against the 20 runs per agent per 24h limit: requires confirm: true.",
    inputSchema: { workspace: workspaceArg, testSetId: z.string(), runOnPublishedBot: z.boolean().optional(), runName: z.string().optional(), mcsConnectionId: z.string().optional().describe("User profile connection id for authenticated knowledge/tools"), wait: z.boolean().optional(), timeoutSeconds: z.number().optional(), environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg, confirm: confirmArg },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const set = await getTestSet(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.testSetId);
      if (!a.confirm) return dryRun(`run test set '${set.displayName}' (${set.totalTestCases ?? "?"} cases) against the ${a.runOnPublishedBot ? "published" : "draft"} agent ${ctx.botId}`);
      let run = await startRun(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.testSetId, { runOnPublishedBot: a.runOnPublishedBot, evaluationRunName: a.runName, mcsConnectionId: a.mcsConnectionId });
      if (a.wait) {
        const deadline = Date.now() + (a.timeoutSeconds ?? 600) * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10_000));
          const t2 = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
          run = await getRun(t2.accessToken, ctx.environmentId as string, ctx.botId as string, run.id);
          if (run.state && /completed|succeeded|failed|cancel|error/i.test(run.state) && (run.testCasesProcessed ?? 0) >= (run.totalTestCases ?? 0)) break;
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

server.registerTool("cs_list_evaluation_runs", { title: "List evaluation runs", description: "Previous evaluation runs for the agent.", inputSchema: { workspace: workspaceArg, environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg } }, async (a) => {
  try {
    const ctx = await cloudContext(a, { environment: true, bot: true });
    const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
    const runs = await listRuns(tok.accessToken, ctx.environmentId as string, ctx.botId as string);
    return text({ count: runs.length, runs: runs.map(({ raw: _r, testCasesResults: _t, ...x }) => x) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

// ---- chat / conversation tests -------------------------------------------

const chatArgs = {
  workspace: workspaceArg,
  conversationId: z.string().optional().describe("Continue an earlier conversation from cs_chat"),
  transport: z.enum(["auto", "directline", "sdk"]).optional().describe("auto detects the agent's authentication mode via Dataverse; directline for no-auth/manual-auth agents; sdk for Entra SSO agents"),
  tokenEndpoint: z.string().optional().describe("Explicit DirectLine token endpoint"),
  directLineSecret: z.string().optional(),
  environmentId: envArg,
  botId: botArg,
  schemaName: z.string().optional(),
  dataverseUrl: z.string().optional(),
  tenantId: tenantArg,
  clientId: clientArg,
};

server.registerTool("cs_chat", { title: "Chat with the published agent", description: "Send one utterance to the published agent and return its replies (and raw activities). Use conversationId to continue. If the agent answers with a sign-in card, signInUrl is returned.", inputSchema: { utterance: z.string(), ...chatArgs } }, async (a) => {
  try {
    const r = await runChat(a.utterance, a);
    return text({ protocol: r.protocol, conversationId: r.conversationId, replies: r.replies, signInUrl: r.signInUrl, activityCount: r.activities.length, activities: r.activities.map((x) => ({ type: x.type, text: x.text, name: x.name, attachments: x.attachments?.map((at) => at.contentType), value: x.value })) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_run_conversation_tests",
  {
    title: "Run local conversation tests",
    description: "Run a YAML test file (tests: name, utterance, expect {contains, containsAny, notContains, regex, minLength}, continueConversation) against the published agent through cs_chat and report pass/fail. The CLI-native complement to portal evaluations. Pass writeExample to create a starter file.",
    inputSchema: { file: z.string().optional(), tests: z.array(z.object({ name: z.string().optional(), utterance: z.string(), expect: z.record(z.unknown()).optional(), continueConversation: z.boolean().optional() })).optional(), writeExample: z.string().optional().describe("Path to write an example test file, then return"), stopOnFail: z.boolean().optional(), ...chatArgs },
  },
  async (a) => {
    try {
      if (a.writeExample) {
        fs.writeFileSync(a.writeExample, CONVERSATION_TESTS_EXAMPLE, "utf8");
        return text({ wrote: a.writeExample, example: CONVERSATION_TESTS_EXAMPLE });
      }
      let tests: ConversationTest[];
      if (a.file) tests = parseConversationTests(fs.readFileSync(a.file, "utf8")).tests;
      else if (a.tests?.length) tests = a.tests.map((t, i) => ({ name: t.name ?? `test ${i + 1}`, utterance: t.utterance, expect: (t.expect ?? {}) as ConversationTest["expect"], continueConversation: Boolean(t.continueConversation) }));
      else return fail("Pass file or tests (or writeExample)");
      const results: Record<string, unknown>[] = [];
      let conversationId: string | undefined;
      let passed = 0;
      for (const t of tests) {
        const started = Date.now();
        try {
          const r = await runChat(t.utterance, { ...a, conversationId: t.continueConversation ? conversationId : undefined });
          conversationId = r.conversationId;
          const ev = evaluateReplies(r.replies, t.expect ?? {}, r.signInUrl);
          if (ev.pass) passed++;
          results.push({ name: t.name, utterance: t.utterance, pass: ev.pass, failures: ev.failures, replies: r.replies, durationMs: Date.now() - started });
          if (!ev.pass && a.stopOnFail) break;
        } catch (err) {
          results.push({ name: t.name, utterance: t.utterance, pass: false, failures: [errorMessage(err)], durationMs: Date.now() - started });
          if (a.stopOnFail) break;
        }
      }
      return text({ total: tests.length, passed, failed: results.filter((r) => !r.pass).length, results });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---- solutions (ALM: pull everything, redeploy 1:1) -----------------------

const envOrProfile = z.string().optional().describe("Environment id or URL. Defaults to the active pac auth profile.");

function defaultSolutionWorkDir(name: string): string {
  return path.join(process.env.CPS_WORKSPACE ?? process.cwd(), ".cs-solutions", name);
}

server.registerTool(
  "cs_create_solution",
  {
    title: "Create an unmanaged solution",
    description: "Create a new unmanaged solution (and its publisher if missing) in an environment by packing an empty solution manifest and importing it with pac. Use it to prepare the container before cs_init_agent with solutionName. Requires confirm: true.",
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
      "Build a brief from purpose, audience, tone, capabilities, boundaries and examples, send it to an AI Builder prompt or model (pac copilot model predict; pick one with cs_list_prompts), and return the generated instructions. With apply: true the text is written into the agent's instructions (agent.mcs.yml, or settings.mcs.yml for cli-copilot). Pass currentInstructions/changeRequest (or refine: true to read the workspace) to revise existing instructions instead.",
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
    },
  },
  async ({ name, targetDir, environment, packagetype, cloneAgents }) => {
    try {
      const pt: PackageType = packagetype ?? "Both";
      const dir = path.resolve(targetDir);
      fs.mkdirSync(path.join(dir, "export"), { recursive: true });
      const unmanagedZip = path.join(dir, "export", `${name}_unmanaged.zip`);
      const managedZip = path.join(dir, "export", `${name}_managed.zip`);
      const exports: PullManifest["exports"] = { unmanaged: null, managed: null };
      if (pt !== "Managed") {
        await exportSolution({ name, zipPath: unmanagedZip, environment, managed: false });
        exports.unmanaged = unmanagedZip;
      }
      if (pt !== "Unmanaged") {
        await exportSolution({ name, zipPath: managedZip, environment, managed: true });
        exports.managed = managedZip;
      }
      const src = path.join(dir, "src");
      await unpackSolution(exports.unmanaged ?? (exports.managed as string), src, pt);
      const inv = inventorySolutionFolder(src);
      let settingsFile: string | null = null;
      try {
        settingsFile = path.join(dir, "deployment-settings.json");
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
      return text({
        manifestFile,
        ...summarizeInventory(inv),
        agentsCloned: agents,
        deploymentSettings: settings ? { file: settingsFile, unmapped: unmappedSettings(settings) } : null,
        next: "Map connection references and environment variables for the target with cs_create_deployment_settings (use cs_list_connections on the target), then cs_deploy_solution.",
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

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
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---- environment comparison (DTAP) -----------------------------------------

/** Dataverse reads for a snapshot; skipped (null) when no silent token is available. */
async function dataverseReadsFor(environment: string, tenantId?: string, clientId?: string): Promise<{ reads: DataverseReads | null; note: string | null }> {
  try {
    const ctx = await cloudContext({ environmentId: /^[0-9a-f-]{36}$/i.test(environment) ? environment : undefined, dataverseUrl: /^https?:\/\//i.test(environment) ? environment : undefined, tenantId, clientId }, {});
    let dataverseUrl = ctx.dataverseUrl;
    if (!dataverseUrl && ctx.environmentId) {
      const bap = await getToken(ctx.authCfg, [BAP_SCOPE], { interactive: false });
      dataverseUrl = (await getEnvironment(bap.accessToken, ctx.environmentId)).dataverseUrl;
    }
    if (!dataverseUrl) return { reads: null, note: "could not resolve the Dataverse URL" };
    const tok = await getToken(ctx.authCfg, [dataverseScope(dataverseUrl)], { interactive: false });
    const [bots, flows, connectionReferences, environmentVariables] = await Promise.all([
      listBots(dataverseUrl, tok.accessToken, { includeManaged: true }),
      listFlows(dataverseUrl, tok.accessToken),
      listConnectionReferences(dataverseUrl, tok.accessToken),
      listEnvironmentVariables(dataverseUrl, tok.accessToken),
    ]);
    return { reads: { bots, flows, connectionReferences, environmentVariables }, note: null };
  } catch (err) {
    return { reads: null, note: `Dataverse details skipped: ${errorMessage(err)}` };
  }
}

const snapshotArgs = {
  solution: z.string().optional().describe("Solution unique name to record version/managed state for"),
  agents: z.array(z.string()).optional().describe("Agent schema names or ids to clone; default: every agent pac copilot list returns"),
  maxAgents: z.number().optional().describe("Default 20"),
  includeDataverse: z.boolean().optional().describe("Default true: flows, connection references, environment variables and publish state via Dataverse (needs cs_login; skipped silently otherwise)"),
  tenantId: tenantArg,
  clientId: clientArg,
};

server.registerTool(
  "cs_snapshot_environment",
  {
    title: "Snapshot an environment",
    description: "Capture one environment into a folder for comparison or history: solution version, every agent cloned with pac copilot clone (agents/<name>), and, when signed in, flows, connection references, environment variables and publish state. Read-only for the environment.",
    inputSchema: { label: z.string().describe("Short name such as DEV, TEST, ACC, PROD"), environment: z.string().describe("Environment id or URL"), dir: z.string().describe("Snapshot folder (recreated)"), ...snapshotArgs },
  },
  async (a) => {
    try {
      const dv = a.includeDataverse === false ? { reads: null, note: null } : await dataverseReadsFor(a.environment, a.tenantId, a.clientId);
      const snap = await captureSnapshot({ label: a.label, environment: a.environment, dir: a.dir, solution: a.solution, agents: a.agents, maxAgents: a.maxAgents, dataverse: dv.reads });
      if (dv.note) snap.notes.push(dv.note);
      return text({ dir: path.resolve(a.dir), label: snap.label, solution: snap.solutionRow, agents: snap.agents.map(({ workspace, ...x }) => ({ ...x, workspace: workspace ? path.relative(path.resolve(a.dir), workspace) : null })), captured: { flows: snap.flows?.length ?? null, connectionReferences: snap.connectionReferences?.length ?? null, environmentVariables: snap.environmentVariables?.length ?? null }, notes: snap.notes });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_compare_snapshots",
  {
    title: "Compare two snapshots",
    description: "Offline diff of two snapshot folders: solution version, per-agent YAML differences (noise such as ids, audit info and connection ids removed), flows, connection references, environment variables, unpublished changes. Writes <reportDir>/<a>-vs-<b>.md and .json. failOnDrift returns an error result when drift is found (for pipeline gates).",
    inputSchema: { a: z.string().describe("Snapshot folder (earlier stage, e.g. DEV)"), b: z.string().describe("Snapshot folder (later stage, e.g. TEST)"), reportDir: z.string().optional().describe("Default: parent of b"), includeDiffs: z.boolean().optional().describe("Default true: unified diffs in the report"), strictVariables: z.boolean().optional().describe("Treat differing environment variable values as drift"), ignoredKeys: z.array(z.string()).optional(), failOnDrift: z.boolean().optional() },
  },
  async (a) => {
    try {
      const report = compareSnapshots(a.a, a.b, { includeDiffs: a.includeDiffs, strictVariables: a.strictVariables, ignoredKeys: a.ignoredKeys });
      const out = writeReport(a.reportDir ?? path.dirname(path.resolve(a.b)), `${report.a.label}-vs-${report.b.label}`, report);
      const payload = { drift: report.drift, driftSummary: report.driftSummary, expectedDifferences: report.expectedDifferences, solution: report.solution, agents: report.agents.map((x) => ({ schemaName: x.schemaName, status: x.status, changedFiles: x.changedFiles, files: x.files.map((f) => `${f.status}: ${f.path}`), publish: x.publish })), flows: report.flows, connectionReferences: report.connectionReferences, environmentVariables: report.environmentVariables, notes: report.notes, report: out };
      if (a.failOnDrift && report.drift) return { ...text(payload), isError: true as const };
      return text(payload);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_compare_environments",
  {
    title: "Compare a DTAP chain",
    description: "Snapshot every environment in an ordered chain (e.g. DEV, TEST, ACC, PROD) and compare each adjacent pair. Returns one report per pair plus the first stage where drift appears. Snapshots go to <dir>/<label>, reports to <dir>/reports.",
    inputSchema: { chain: z.array(z.object({ label: z.string(), environment: z.string() })).min(2), dir: z.string(), includeDiffs: z.boolean().optional(), strictVariables: z.boolean().optional(), failOnDrift: z.boolean().optional(), ...snapshotArgs },
  },
  async (a) => {
    try {
      const dirs: string[] = [];
      const captured: Record<string, unknown>[] = [];
      for (const stage of a.chain) {
        const dir = path.join(a.dir, stage.label);
        const dv = a.includeDataverse === false ? { reads: null, note: null } : await dataverseReadsFor(stage.environment, a.tenantId, a.clientId);
        const snap = await captureSnapshot({ label: stage.label, environment: stage.environment, dir, solution: a.solution, agents: a.agents, maxAgents: a.maxAgents, dataverse: dv.reads });
        if (dv.note) snap.notes.push(dv.note);
        dirs.push(dir);
        captured.push({ label: stage.label, agents: snap.agents.length, cloneErrors: snap.agents.filter((x) => x.cloneError).length, notes: snap.notes });
      }
      const reports = compareChain(dirs, { includeDiffs: a.includeDiffs, strictVariables: a.strictVariables });
      const written = reports.map((r) => writeReport(path.join(a.dir, "reports"), `${r.a.label}-vs-${r.b.label}`, r));
      const firstDrift = reports.find((r) => r.drift);
      const payload = {
        drift: Boolean(firstDrift),
        firstDriftBetween: firstDrift ? `${firstDrift.a.label} -> ${firstDrift.b.label}` : null,
        stages: captured,
        pairs: reports.map((r, i) => ({ pair: `${r.a.label} -> ${r.b.label}`, drift: r.drift, driftSummary: r.driftSummary, expectedDifferences: r.expectedDifferences, report: written[i].markdown })),
      };
      if (a.failOnDrift && firstDrift) return { ...text(payload), isError: true as const };
      return text(payload);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`copilot-studio-mcp ${VERSION} ready (pac: ${findPac() ?? "not found"})`);
}

main().catch((err) => {
  log(`fatal: ${errorMessage(err)}`);
  process.exit(1);
});
