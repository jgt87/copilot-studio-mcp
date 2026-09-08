/**
 * The server instance, the registration gates, and everything the tool modules
 * share: result shaping, workspace and cloud context resolution, the dry-run
 * contract, sync stamping and the common argument schemas.
 *
 * Tool modules import from here; this file must never import them back.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";


import { errorMessage, log } from "../log.js";
import { explainFailure, type PacResult } from "../pac.js";
import { findWorkspaceRoot, readWorkspace, type WorkspaceInfo } from "../workspace.js";
import { validateWorkspace } from "../validate.js";
import { toolEnabled } from "../toolFilter.js";
import { SERVER_INSTRUCTIONS } from "../guide.js";
import { ENVIRONMENT_WRITE_TOOLS, readOnlyMode } from "../policy.js";
import { quickDrift, readStamp, remoteStateFrom, STAMP_REL, writeStamp, type QuickDriftReport, type SyncOperation } from "../drift.js";

import { acquireSilent, BAP_SCOPE, effectiveClientId, getToken, resolveTenantId, type AuthConfig } from "../auth.js";
import { getEnvironment } from "../cloud/bap.js";
import { dataverseScope, getBot, listBotComponents, listBots, listConnectionReferences, listEnvironmentVariables, listFlows, type BotComponentRow, type BotDetails } from "../cloud/dataverse.js";
import { type DataverseReads } from "../compare.js";

export const execFileAsync = promisify(execFile);
export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string) {
  return { ...text({ error: message }), isError: true as const };
}

export function tail(s: string, lines = 60): string {
  const arr = s.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return arr.slice(-lines).join("\n");
}

export function pacSummary(r: PacResult): Record<string, unknown> {
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

export function resolveRoot(workspace?: string): string {
  const start = workspace ?? process.env.CPS_WORKSPACE ?? process.cwd();
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new Error(`No Copilot Studio agent workspace found at or around ${start} (looking for agent.mcs.yml / settings.mcs.yml / agent.sync.yaml). Pass 'workspace' or run cs_clone_agent / cs_create_agent first.`);
  }
  return root;
}

export function tryWorkspace(workspace?: string): WorkspaceInfo | null {
  try {
    return readWorkspace(resolveRoot(workspace));
  } catch {
    return null;
  }
}

export interface CloudContext {
  tenantId: string;
  clientId: string;
  environmentId: string | null;
  botId: string | null;
  dataverseUrl: string | null;
  schemaName: string | null;
  authCfg: AuthConfig;
}

export async function cloudContext(args: { workspace?: string; tenantId?: string; clientId?: string; environmentId?: string; botId?: string; dataverseUrl?: string }, needs: { environment?: boolean; bot?: boolean; dataverse?: boolean } = {}): Promise<CloudContext> {
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

export function dryRun(summary: string, extra: Record<string, unknown> = {}) {
  return text({ dryRun: true, wouldDo: summary, ...extra, hint: "This mutates a live environment. Show the user what will happen, then call again with confirm: true." });
}

/**
 * Verified against pac 2.11.2: `pac copilot pack` on an init-only workspace
 * accepts settings, agent.mcs.yml, icon.png and topics/ and rejects every
 * other folder. The full layout is applied by `pac copilot push` from a
 * sync-connected workspace (clone or init --environment).
 */
export function layoutNote(ws: WorkspaceInfo): string | null {
  if (ws.sync.source !== "none") return null;
  return "Workspace has no sync metadata (pac copilot init without --environment). 'pac copilot pack' packages only settings and topics; knowledge, tools, flows, triggers and variables are applied by 'pac copilot push' from a sync-connected workspace (cs_create_agent with environment, or cs_clone_agent).";
}

/** Dataverse URL and token for the workspace's environment without any interaction; null when not signed in or unresolvable. */
export async function silentDataverse(ws: WorkspaceInfo, o: { tenantId?: string; clientId?: string } = {}): Promise<{ url: string; token: string } | null> {
  try {
    const authCfg: AuthConfig = { tenantId: resolveTenantId(o.tenantId ?? ws.sync.tenantId ?? undefined), clientId: effectiveClientId(o.clientId) };
    let url = ws.sync.dataverseUrl ?? process.env.CPS_ENVIRONMENT_URL ?? null;
    if (!url && ws.sync.environmentId) {
      const bap = await acquireSilent(authCfg, [BAP_SCOPE]);
      if (!bap) return null;
      url = (await getEnvironment(bap.accessToken, ws.sync.environmentId)).dataverseUrl;
    }
    if (!url) return null;
    const tok = await acquireSilent(authCfg, [dataverseScope(url)]);
    return tok ? { url, token: tok.accessToken } : null;
  } catch (err) {
    log(`silent Dataverse access skipped: ${errorMessage(err)}`);
    return null;
  }
}

export type RemoteAgentState = { bot: BotDetails; components: BotComponentRow[]; note: null } | { bot: null; components: null; note: string };

/** Bot row plus component rows for the workspace's agent, read silently; a note says why when that is not possible. */
export async function remoteAgentState(ws: WorkspaceInfo, o: { tenantId?: string; clientId?: string } = {}): Promise<RemoteAgentState> {
  if (!ws.sync.agentId) return { bot: null, components: null, note: "workspace has no sync metadata (agent id unknown)" };
  const dv = await silentDataverse(ws, o);
  if (!dv) return { bot: null, components: null, note: "no cached Dataverse sign-in for this environment (run cs_login) or Dataverse URL unresolved; drift check skipped" };
  try {
    const [bot, components] = await Promise.all([getBot(dv.url, dv.token, ws.sync.agentId), listBotComponents(dv.url, dv.token, ws.sync.agentId)]);
    return { bot, components, note: null };
  } catch (err) {
    return { bot: null, components: null, note: `Dataverse read failed: ${errorMessage(err)}` };
  }
}

/** Record the post-sync state in .mcs/cs-sync.json (file fingerprints, remote component stamps when reachable). Never throws. */
export async function stampAfterSync(root: string, operation: SyncOperation): Promise<Record<string, unknown>> {
  try {
    const ws = readWorkspace(root);
    if (ws.sync.source === "none") return { stamped: false, reason: "not a sync-connected workspace" };
    const remote = await remoteAgentState(ws);
    const stamp = writeStamp(root, { operation, botId: ws.sync.agentId, environmentId: ws.sync.environmentId, remote: remote.bot ? remoteStateFrom(remote.bot, remote.components) : null });
    return { stamped: true, file: STAMP_REL, syncedAt: stamp.syncedAt, files: Object.keys(stamp.files).length, remoteComponents: remote.components?.length ?? null, ...(remote.note ? { note: remote.note } : {}) };
  } catch (err) {
    log(`sync stamp skipped: ${errorMessage(err)}`);
    return { stamped: false, reason: errorMessage(err) };
  }
}

/** Quick drift report for a workspace, or the reason it could not run. */
export async function quickDriftFor(ws: WorkspaceInfo, o: { tenantId?: string; clientId?: string } = {}): Promise<{ report: QuickDriftReport | null; note: string | null }> {
  const remote = await remoteAgentState(ws, o);
  if (!remote.bot) return { report: null, note: remote.note };
  return { report: quickDrift({ ws, stamp: readStamp(ws.root), bot: remote.bot, components: remote.components }), note: null };
}

// Cross-file validation lives in validate.ts; the local name is kept for the call sites below.
export const validateWorkspaceFiles = validateWorkspace;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const server = new McpServer({ name: "copilot-studio-mcp", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

// Two registration gates (see policy.ts and toolFilter.ts):
//  - read-only mode hides every tool that can change a live environment;
//  - CPS_TOOLS / CPS_TOOLS_EXCLUDE trim the list for clients with small context windows.
export const skippedTools: string[] = [];
export const withheldTools: string[] = [];
{
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    if (readOnlyMode() && ENVIRONMENT_WRITE_TOOLS.has(name)) {
      withheldTools.push(name);
      return undefined;
    }
    if (!toolEnabled(name)) {
      skippedTools.push(name);
      return undefined;
    }
    return original(name, ...rest);
  }) as unknown as typeof server.registerTool;
}

export const workspaceArg = z.string().optional().describe("Path to (or inside) the agent workspace. Defaults to CPS_WORKSPACE or the current directory.");
export const tenantArg = z.string().optional().describe("Entra tenant id. Defaults to the workspace sync metadata, then CPS_TENANT_ID.");
export const clientArg = z.string().optional().describe("Entra app (client) id for MSAL. Defaults to CPS_CLIENT_ID, then the first-party VS Code id.");
export const envArg = z.string().optional().describe("Power Platform environment id (GUID). Defaults to workspace sync metadata or CPS_ENVIRONMENT_ID.");
export const botArg = z.string().optional().describe("Agent (bot) id. Defaults to workspace sync metadata or CPS_AGENT_ID.");
export const confirmArg = z.boolean().optional().describe("Required to actually perform a change in a live environment. Without it the tool returns a dry run.");
export const envOrProfile = z.string().optional().describe("Environment id or URL. Defaults to the active pac auth profile.");

/**
 * Optional Dataverse reads (bots, flows, connection references, environment
 * variables) for a snapshot or a tenant backup. Silent: it never prompts, and
 * returns a note instead of throwing when there is no cached sign-in.
 */
export async function dataverseReadsFor(environment: string, tenantId?: string, clientId?: string): Promise<{ reads: DataverseReads | null; note: string | null }> {
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

