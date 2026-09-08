/**
 * Tools: session start / auth.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";


import { errorMessage, log } from "../log.js";
import { findPac, installHint, parseAuthList, pacVersion, runPac } from "../pac.js";
import { type WorkspaceInfo } from "../workspace.js";
import { listKinds, schemaPath } from "../schema.js";
import { adminProfileDefault, makerProfileDefault } from "../pacProfile.js";
import { guide, nextSteps } from "../guide.js";
import { readOnlyMode } from "../policy.js";
import { activePreset, parsePatterns, presetOptions } from "../toolFilter.js";

import { acquireSilent, BAP_SCOPE, COPILOT_INVOKE_SCOPE, effectiveClientId, listAccounts, pendingLoginStatus, PPAPI_SCOPE, resolveTenantId, signOut, startDeviceCodeLogin, startInteractiveLogin, waitForPendingLogin, type AuthConfig } from "../auth.js";
import { dataverseScope } from "../cloud/dataverse.js";
import { FLOW_SCOPE } from "../cloud/flowruns.js";
import { VERSION, applyToolPreset, clientArg, disabledToolCount, execFileAsync, fail, registeredTools, server, tenantArg, text, tryWorkspace, withheldTools, workspaceArg } from "./shared.js";

/** The preset chosen with cs_set_tool_preset during this session, if any. */
let chosenPreset: string | null = null;

// ---- session start / auth --------------------------------------------------------

server.registerTool(
  "cs_init",
  {
    title: "Start a session",
    description:
      "Run this first in a new session. Reports the pac CLI and .NET, the pac auth profiles (and which is active), the MSAL sign-in, the environment variables, the write policy in force, and the agent workspace it found, then ends with the next steps for that workspace. Read-only. It does not create anything: cs_create_agent scaffolds or creates an agent, cs_guide explains a task.",
    inputSchema: { workspace: workspaceArg },
  },
  async ({ workspace }) => {
    const pacPath = findPac();
    const ws = tryWorkspace(workspace);
    const pacAuth = await probePacAuth(pacPath);
    const msal = await probeMsal(ws);
    const pacProfiles = (pacAuth.pacAuthProfiles as unknown[] | undefined) ?? [];
    const msalAccounts = Array.isArray(msal.msalAccounts) ? (msal.msalAccounts as unknown[]) : [];
    return text({
      serverVersion: VERSION,
      // The first live run tested a different, older checkout than the one that had just been
      // pulled, and concluded four tools were unimplemented. Say which build is answering.
      serverBuild: {
        modulePath: fileURLToPath(import.meta.url),
        registeredTools: registeredTools.length,
        offered: registeredTools.length - disabledToolCount(),
        toolPreset: chosenPreset ?? activePreset() ?? null,
      },
      pac: await probePac(pacPath),
      dotnetSdks: await probeDotnet(),
      ...pacAuth,
      env: probeEnv(),
      workspace: ws ? { root: ws.root, harness: ws.harness, schemaName: ws.schemaName, sync: ws.sync.source, environmentId: ws.sync.environmentId, agentId: ws.sync.agentId } : { found: false, searchedFrom: workspace ?? process.env.CPS_WORKSPACE ?? process.cwd() },
      ...msal,
      cloudAccess: await probeTokenScopes(ws, msalAccounts.length > 0),
      schema: { path: schemaPath(), kinds: listKinds().length },
      profiles: { adminDefault: adminProfileDefault() ?? null, makerDefault: makerProfileDefault() ?? null },
      writePolicy: { confirmRequired: "Every tool that changes a live environment returns a dry run until confirm: true, which the user must approve.", readOnlyMode: readOnlyMode(), ...(withheldTools.length ? { toolsWithheld: withheldTools } : {}) },
      nextSteps: nextSteps(ws, { pacFound: Boolean(pacPath), pacProfile: pacProfiles.length > 0, signedIn: msalAccounts.length > 0 }),
      toolPresets: {
        current: chosenPreset ?? activePreset() ?? "full (every tool)",
        question: "Which set of tools should I offer for this session?",
        howToApply: "Put the question and this table to the user, then call cs_set_tool_preset with what they choose. Nothing is lost either way: a preset only hides tools, and 'full' brings them all back.",
        options: presetOptions(registeredTools),
      },
      guide: "cs_guide topic='getting-started' walks through cloning or creating an agent and taking it to a published, tested state.",
    });
  },
);

async function probePac(pacPath: string | null): Promise<Record<string, unknown>> {
  if (!pacPath) return { installed: false, hint: installHint() };
  return { path: pacPath, version: await pacVersion().catch(() => null) };
}

async function probeDotnet(): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("dotnet", ["--list-sdks"], { timeout: 20_000, windowsHide: true });
    return stdout.trim().split(/\r?\n/);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function probePacAuth(pacPath: string | null): Promise<Record<string, unknown>> {
  if (!pacPath) return {};
  const auth = await runPac(["auth", "list"], { timeoutMs: 60_000 }).catch(() => null);
  const profiles = auth ? parseAuthList(auth.stdout) : [];
  const hint = auth && profiles.length === 0 ? { pacAuthHint: "No pac auth profile. In a terminal run: pac auth create --environment <environment id or URL>" } : {};
  return { pacAuthProfiles: profiles, ...hint };
}

const REPORTED_ENV_VARS = ["CPS_TENANT_ID", "CPS_CLIENT_ID", "CPS_ENVIRONMENT_ID", "CPS_ENVIRONMENT_URL", "CPS_AGENT_ID", "CPS_WORKSPACE", "PAC_PATH", "DOTNET_ROOT"];

function probeEnv(): Record<string, string | null> {
  return Object.fromEntries(REPORTED_ENV_VARS.map((k) => [k, process.env[k] ? (k === "CPS_CLIENT_ID" ? "(set)" : (process.env[k] as string)) : null]));
}

async function probeMsal(ws: WorkspaceInfo | null): Promise<Record<string, unknown>> {
  try {
    const tenantId = resolveTenantId(ws?.sync.tenantId ?? undefined);
    return { msalAccounts: await listAccounts({ tenantId }), pendingLogin: pendingLoginStatus() };
  } catch (err) {
    return { msalAccounts: { error: errorMessage(err) } };
  }
}

/**
 * Which cloud resources a token can actually be had for, without prompting.
 *
 * A cached account is not the same as a usable token: the first live run had an
 * account listed here and still could not read Dataverse, so the drift quick
 * check and the transcript tools failed with no warning beforehand. Each entry
 * is a silent acquisition against the real scope, so this says what will work
 * rather than what signed in once.
 */
async function probeTokenScopes(ws: WorkspaceInfo | null, hasAccount: boolean): Promise<Record<string, unknown>> {
  if (!hasAccount) return { ready: {}, note: "No MSAL account cached: every Dataverse, Power Platform API and connector-catalog tool will fail until cs_login completes. The pac-backed tools are unaffected." };
  const cfg: AuthConfig = { tenantId: resolveTenantId(ws?.sync.tenantId ?? undefined), clientId: effectiveClientId() };
  const dataverseUrl = ws?.sync.dataverseUrl ?? process.env.CPS_ENVIRONMENT_URL ?? null;
  const targets: { key: string; scope: string; unlocks: string }[] = [
    { key: "powerPlatformApi", scope: PPAPI_SCOPE, unlocks: "evaluations (cs_list_test_sets, cs_run_evaluation, cs_get_evaluation_run)" },
    { key: "powerAppsService", scope: BAP_SCOPE, unlocks: "cs_list_environments, the Dataverse URL lookup, cs_list_connectors, cs_describe_connector" },
    { key: "powerAutomate", scope: FLOW_SCOPE, unlocks: "cs_list_flow_runs, cs_get_flow_run, cs_run_flow" },
    ...(dataverseUrl ? [{ key: "dataverse", scope: dataverseScope(dataverseUrl), unlocks: "cs_check_drift quick mode, cs_list_agents via dataverse, the transcript tools, cs_publish via dataverse" }] : []),
  ];
  const results: { key: string; unlocks: string; ok: boolean; error?: string }[] = await Promise.all(
    targets.map(async (t) => {
      try {
        return { key: t.key, unlocks: t.unlocks, ok: Boolean(await acquireSilent(cfg, [t.scope])) };
      } catch (err) {
        return { key: t.key, unlocks: t.unlocks, ok: false, error: errorMessage(err) };
      }
    }),
  );
  const ready: Record<string, unknown> = {};
  for (const r of results) ready[r.key] = r.ok ? "ok" : { needsSignIn: true, unlocks: r.unlocks, ...(r.error ? { error: r.error } : {}) };
  if (!dataverseUrl) ready.dataverse = { unknown: true, why: "no Dataverse URL in the workspace sync metadata or CPS_ENVIRONMENT_URL, so it could not be probed" };
  const missing = results.filter((r) => !r.ok);
  return {
    ready,
    ...(missing.length ? { note: `cs_login has not granted ${missing.length === 1 ? "this resource" : "these resources"} yet: ${missing.map((m) => m.key).join(", ")}. Run cs_login (add scope for Power Automate) before the tools listed under each.` } : {}),
  };
}

server.registerTool(
  "cs_login",
  {
    title: "Sign in (MSAL)",
    description:
      "Acquire a Microsoft Entra token for the cloud tools (evaluations, environments, agents, publish, chat, drift). mode 'interactive' (default) starts a browser sign-in and returns within waitSeconds: status 'ok' when it completed, otherwise status 'pending' with the sign-in URL. If no browser opened, show the user that URL to open on the machine running this server; the page redirects to localhost and the login completes in the background (check cs_login_status or call any cloud tool). mode 'device_code' returns a code to enter at microsoft.com/devicelogin (some tenants block this flow). Not needed for pac commands, which use 'pac auth create'.",
    inputSchema: {
      mode: z.enum(["interactive", "device_code"]).optional().describe("Default interactive"),
      tenantId: tenantArg,
      clientId: clientArg,
      scope: z.enum(["powerplatform", "bap", "dataverse", "copilot_invoke", "flow"]).optional().describe("Which resource to pre-authorise. Default powerplatform (evaluations); 'flow' is the Power Automate service used by the flow-run tools. Others are acquired silently later when possible."),
      dataverseUrl: z.string().optional().describe("Required when scope is dataverse, e.g. https://org.crm.dynamics.com"),
      workspace: workspaceArg,
      openBrowser: z.boolean().optional().describe("interactive: try to open the browser from the server (default true). Set false when the server runs where no browser can appear."),
      waitSeconds: z.number().optional().describe("interactive: how long to wait for the sign-in before returning 'pending' (default 15; keep it below the client's tool timeout)"),
    },
  },
  async ({ mode, tenantId, clientId, scope, dataverseUrl, workspace, openBrowser, waitSeconds }) => {
    try {
      const ws = tryWorkspace(workspace);
      const cfg: AuthConfig = { tenantId: resolveTenantId(tenantId ?? ws?.sync.tenantId ?? undefined), clientId };
      const scopes =
        scope === "bap" ? [BAP_SCOPE] : scope === "flow" ? [FLOW_SCOPE] : scope === "dataverse" ? [dataverseScope(dataverseUrl ?? ws?.sync.dataverseUrl ?? (() => { throw new Error("dataverseUrl required"); })())] : scope === "copilot_invoke" ? [COPILOT_INVOKE_SCOPE] : [PPAPI_SCOPE];
      if (mode === "device_code") {
        const info = await startDeviceCodeLogin(cfg, scopes);
        return text({ status: "device_code", ...info, next: "Tell the user to open verificationUri and enter userCode. Then call cs_login_status or any cloud tool." });
      }
      const clientKind = effectiveClientId(clientId) === "51f81489-12ee-4a9e-aaae-a2591f45987d" ? "first-party (VS Code)" : "custom";
      const started = await startInteractiveLogin(cfg, scopes, { launch: openBrowser !== false });
      const tok = await waitForPendingLogin(Math.max(1, waitSeconds ?? 15) * 1000).catch(() => null);
      if (tok) return text({ status: "ok", account: tok.account, expiresOn: tok.expiresOn, scopes: tok.scopes, clientId: clientKind });
      const status = pendingLoginStatus();
      if (status.done && status.error) return fail(`sign-in failed: ${status.error}`);
      return text({
        status: "pending",
        url: started.url,
        next: "No token yet. If no browser opened, open this URL on the machine running the MCP server and sign in; the page redirects to localhost and completes the login in the background. Then call cs_login_status (wait: true) or any cloud tool.",
        clientId: clientKind,
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_login_status",
  { title: "Sign-in status", description: "Show cached MSAL accounts and whether a sign-in (browser or device code) is still pending, with its URL or code; optionally wait for it to complete.", inputSchema: { wait: z.boolean().optional().describe("Block until the pending sign-in completes (up to 10 minutes)"), tenantId: tenantArg, workspace: workspaceArg } },
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

server.registerTool(
  "cs_set_tool_preset",
  {
    title: "Choose how many tools are offered",
    description:
      "Narrow (or restore) the tool list for the rest of this session. The full list is 131 tools and about 50k tokens of schema, which crowds a smaller model's context and makes it choose worse. Presets: core (the loop that builds an agent and gets it live), authoring (local files only), admin (tenant administration), solutions (moving solutions between environments), full (everything). Read-only: it changes nothing in any environment and no tool is lost, only hidden. Ask the user before calling it.",
    inputSchema: {
      preset: z.enum(["core", "authoring", "admin", "solutions", "full"]).describe("Which set to offer for the rest of this session"),
      keep: z.array(z.string()).optional().describe("Extra tool names to keep on top of the preset"),
    },
  },
  async ({ preset, keep }) => {
    try {
      // cs_init and this tool must survive every preset, or the session cannot recover.
      const always = ["cs_init", "cs_guide", "cs_set_tool_preset", "cs_job_status", ...(keep ?? [])];
      const { enabled, disabled } = applyToolPreset(parsePatterns(preset), always);
      chosenPreset = preset;
      return text({
        preset,
        offered: enabled.length,
        hidden: disabled.length,
        tools: enabled.sort(),
        note:
          disabled.length === 0
            ? "Every tool this server registered is offered."
            : `${disabled.length} tool(s) are hidden for this session. Nothing is lost: call cs_set_tool_preset with preset 'full' to bring them back, and cs_pac still runs any pac command.`,
        clientNote: "The server told the client its tool list changed. A client that caches the list may need a restart to notice.",
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
