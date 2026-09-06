/**
 * MSAL public-client authentication for the cloud layer.
 *
 * Default client id is the first-party VS Code application id that Microsoft's
 * own Copilot Studio tooling uses (pre-authorised for Power Platform API,
 * Dataverse and BAP). Override with CPS_CLIENT_ID. Tokens persist in the OS
 * credential store via msal-node-extensions when available; otherwise they are
 * held in memory for the life of the server process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PublicClientApplication, type AccountInfo, type AuthenticationResult, type ICachePlugin } from "@azure/msal-node";
import { log } from "./log.js";

export const DEFAULT_CLIENT_ID = "51f81489-12ee-4a9e-aaae-a2591f45987d";
export const PPAPI_SCOPE = "https://api.powerplatform.com/.default";
export const BAP_SCOPE = "https://service.powerapps.com/.default";
export const COPILOT_INVOKE_SCOPE = "https://api.powerplatform.com/CopilotStudio.Copilots.Invoke";

export interface AuthConfig {
  tenantId: string;
  clientId?: string;
  cacheDir?: string;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

export interface TokenInfo {
  accessToken: string;
  expiresOn: string | null;
  scopes: string[];
  account: { username?: string; tenantId?: string; homeAccountId?: string } | null;
}

function toTokenInfo(r: AuthenticationResult): TokenInfo {
  return {
    accessToken: r.accessToken,
    expiresOn: r.expiresOn ? r.expiresOn.toISOString() : null,
    scopes: r.scopes,
    account: r.account ? { username: r.account.username, tenantId: r.account.tenantId, homeAccountId: r.account.homeAccountId } : null,
  };
}

export function defaultCacheDir(): string {
  return process.env.CPS_CACHE_DIR ?? path.join(os.homedir(), ".copilot-studio-mcp");
}

export function effectiveClientId(explicit?: string): string {
  return explicit ?? process.env.CPS_CLIENT_ID ?? DEFAULT_CLIENT_ID;
}

let cachePluginPromise: Promise<ICachePlugin | null> | null = null;

/** Persistent, OS-protected token cache. Returns null (memory only) when the native extension is unavailable. */
async function getCachePlugin(cacheDir: string): Promise<ICachePlugin | null> {
  if (!cachePluginPromise) {
    cachePluginPromise = (async () => {
      try {
        const ext = await import("@azure/msal-node-extensions");
        fs.mkdirSync(cacheDir, { recursive: true });
        const persistence = await ext.PersistenceCreator.createPersistence({
          cachePath: path.join(cacheDir, "msal-cache.bin"),
          dataProtectionScope: ext.DataProtectionScope.CurrentUser,
          serviceName: "copilot-studio-mcp",
          accountName: "msal",
          usePlaintextFileOnLinux: false,
        });
        return new ext.PersistenceCachePlugin(persistence);
      } catch (err) {
        log(`persistent token cache unavailable (${(err as Error).message}); tokens will be kept in memory only`);
        return null;
      }
    })();
  }
  return cachePluginPromise;
}

const apps = new Map<string, Promise<PublicClientApplication>>();

async function getApp(cfg: AuthConfig): Promise<PublicClientApplication> {
  const clientId = effectiveClientId(cfg.clientId);
  const key = `${cfg.tenantId}:${clientId}`;
  let p = apps.get(key);
  if (!p) {
    p = (async () => {
      const cachePlugin = await getCachePlugin(cfg.cacheDir ?? defaultCacheDir());
      return new PublicClientApplication({
        auth: { clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}` },
        cache: cachePlugin ? { cachePlugin } : undefined,
      });
    })();
    apps.set(key, p);
  }
  return p;
}

async function findAccount(app: PublicClientApplication, tenantId: string): Promise<AccountInfo | null> {
  const accounts = await app.getTokenCache().getAllAccounts();
  const inTenant = accounts.filter((a) => a.tenantId === tenantId);
  return inTenant[0] ?? accounts[0] ?? null;
}

export async function acquireSilent(cfg: AuthConfig, scopes: string[]): Promise<TokenInfo | null> {
  const app = await getApp(cfg);
  const account = await findAccount(app, cfg.tenantId);
  if (!account) return null;
  try {
    const r = await app.acquireTokenSilent({ scopes, account });
    return r ? toTokenInfo(r) : null;
  } catch (err) {
    log(`silent token acquisition failed for ${scopes[0]}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Ways to hand a URL to the default browser without a shell parsing it, in
 * the order they are tried. On Windows an unquoted `cmd /c start <url>` cuts
 * the URL at the first `&`, which strips `scope` from the Entra authorize
 * request and makes the sign-in page fail with AADSTS900144 ("The request
 * body must contain the following parameter: 'scope'"). PowerShell gets the
 * URL as a single-quoted literal; rundll32 and a quoted `start` are
 * fallbacks for machines where policy blocks PowerShell.
 */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** Pass args verbatim (Windows): they are already quoted for cmd.exe. */
  verbatim?: boolean;
}

export function browserLaunchSpecs(url: string, platform: NodeJS.Platform = process.platform): LaunchSpec[] {
  if (platform === "win32") {
    const system32 = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32");
    const exe = (rel: string, fallback: string) => (fs.existsSync(path.join(system32, rel)) ? path.join(system32, rel) : fallback);
    return [
      { command: exe(path.join("WindowsPowerShell", "v1.0", "powershell.exe"), "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url.replace(/'/g, "''")}'`] },
      { command: exe("rundll32.exe", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] },
      { command: exe("cmd.exe", "cmd.exe"), args: ["/c", "start", '""', `"${url.replace(/"/g, "")}"`], verbatim: true },
    ];
  }
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  return [{ command: "xdg-open", args: [url] }];
}

/** First strategy of browserLaunchSpecs. */
export function browserLaunchSpec(url: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  return browserLaunchSpecs(url, platform)[0];
}

/**
 * Start a fire-and-forget process. A launch failure (ENOENT, EACCES) is
 * logged and reported to `onError`, never thrown: the 'error' event of a
 * child process is emitted asynchronously, and without a listener it takes
 * the whole server down, which MCP clients only see as a broken pipe.
 */
export function launchDetached(command: string, args: string[], opts: { verbatim?: boolean; onError?: (err: Error) => void } = {}): void {
  const report = (err: Error) => {
    log(`could not start ${command}: ${err.message}`);
    opts.onError?.(err);
  };
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: opts.verbatim });
    child.on("error", report);
    child.unref();
  } catch (err) {
    report(err as Error);
  }
}

/** Try each launch strategy in turn; the next one runs only when the previous one failed to start. */
function openBrowser(url: string): void {
  const specs = browserLaunchSpecs(url);
  const tryAt = (i: number) => {
    const s = specs[i];
    if (!s) return;
    launchDetached(s.command, s.args, { verbatim: s.verbatim, onError: () => tryAt(i + 1) });
  };
  tryAt(0);
}

// ---------------------------------------------------------------------------
// Pending logins (device code and browser): started now, completed later
// ---------------------------------------------------------------------------

export type LoginKind = "device_code" | "interactive";

interface PendingLogin {
  kind: LoginKind;
  key: string;
  info: DeviceCodeInfo | null;
  url: string | null;
  promise: Promise<TokenInfo>;
  startedAt: number;
  done: boolean;
  error: string | null;
}

let pendingLogin: PendingLogin | null = null;

function track(kind: LoginKind, cfg: AuthConfig, scopes: string[], raw: Promise<TokenInfo>): PendingLogin {
  const entry: PendingLogin = { kind, key: `${cfg.tenantId}:${scopes.join(" ")}`, info: null, url: null, promise: raw, startedAt: Date.now(), done: false, error: null };
  entry.promise = raw
    .then((r) => {
      entry.done = true;
      return r;
    })
    .catch((err: Error) => {
      entry.done = true;
      entry.error = err.message;
      throw err;
    });
  // Keep the rejection from surfacing as unhandled before someone awaits it.
  entry.promise.catch(() => undefined);
  pendingLogin = entry;
  return entry;
}

/**
 * Start a device-code login and return the code as soon as MSAL hands it out.
 * The token itself arrives later; callers await `waitForPendingLogin()`.
 */
export async function startDeviceCodeLogin(cfg: AuthConfig, scopes: string[]): Promise<DeviceCodeInfo> {
  const app = await getApp(cfg);
  let resolveInfo!: (i: DeviceCodeInfo) => void;
  let rejectInfo!: (e: Error) => void;
  const infoPromise = new Promise<DeviceCodeInfo>((res, rej) => {
    resolveInfo = res;
    rejectInfo = rej;
  });
  const raw = app
    .acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: (resp) => resolveInfo({ userCode: resp.userCode, verificationUri: resp.verificationUri, message: resp.message, expiresIn: resp.expiresIn }),
    })
    .then((r) => {
      if (!r) throw new Error("device code flow returned no result");
      return toTokenInfo(r);
    });
  raw.catch((err: Error) => rejectInfo(err));
  const entry = track("device_code", cfg, scopes, raw);
  entry.info = await infoPromise;
  return entry.info;
}

/**
 * Start a browser sign-in and return the authorize URL as soon as MSAL's
 * loopback listener is up. Opening the browser is best effort; the URL is
 * returned so a caller can show it when no browser appears (remote server,
 * blocked launcher). The token arrives later through waitForPendingLogin /
 * getToken; the loopback listener completes the login in the background.
 */
export async function startInteractiveLogin(cfg: AuthConfig, scopes: string[], opts: { launch?: boolean; timeoutMs?: number } = {}): Promise<{ url: string }> {
  const app = await getApp(cfg);
  let resolveUrl!: (u: string) => void;
  let rejectUrl!: (e: Error) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const msal = app
    .acquireTokenInteractive({
      scopes,
      openBrowser: async (url) => {
        log(`open this URL to sign in: ${url}`);
        resolveUrl(url);
        if (opts.launch !== false) openBrowser(url);
      },
      successTemplate: "<html><body><h2>Signed in. You can close this tab.</h2></body></html>",
      errorTemplate: "<html><body><h2>Sign-in failed. Return to your editor.</h2></body></html>",
    })
    .then(toTokenInfo);
  msal.catch((err: Error) => rejectUrl(err));
  const raced = Promise.race([msal, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`interactive sign-in timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs))]);
  const entry = track("interactive", cfg, scopes, raced);
  entry.url = await urlPromise;
  return { url: entry.url };
}

/** Browser sign-in that blocks until the token arrives (or `timeoutMs`). */
export async function acquireInteractive(cfg: AuthConfig, scopes: string[], timeoutMs = 300_000): Promise<TokenInfo> {
  await startInteractiveLogin(cfg, scopes, { timeoutMs });
  const tok = await waitForPendingLogin(timeoutMs);
  if (!tok) throw new Error("interactive sign-in did not complete");
  return tok;
}

export function pendingLoginStatus(): { pending: boolean; kind?: LoginKind; info?: DeviceCodeInfo | null; url?: string | null; done?: boolean; error?: string | null; ageSeconds?: number } {
  if (!pendingLogin) return { pending: false };
  return {
    pending: !pendingLogin.done,
    kind: pendingLogin.kind,
    info: pendingLogin.info,
    url: pendingLogin.url,
    done: pendingLogin.done,
    error: pendingLogin.error,
    ageSeconds: Math.round((Date.now() - pendingLogin.startedAt) / 1000),
  };
}

export async function waitForPendingLogin(timeoutMs = 900_000): Promise<TokenInfo | null> {
  if (!pendingLogin) return null;
  const p = pendingLogin.promise;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sign-in still pending; complete it in the browser and retry")), timeoutMs)),
  ]);
}

/**
 * Get a token for `scopes`: silent first, then whatever pending login exists,
 * then a browser sign-in (unless disabled).
 */
export async function getToken(cfg: AuthConfig, scopes: string[], opts: { interactive?: boolean } = {}): Promise<TokenInfo> {
  const silent = await acquireSilent(cfg, scopes);
  if (silent) return silent;
  if (pendingLogin && !pendingLogin.done) {
    await waitForPendingLogin(60_000);
    const again = await acquireSilent(cfg, scopes);
    if (again) return again;
  }
  if (opts.interactive === false) {
    throw new Error(`No cached token for ${scopes.join(" ")}. Run cs_login first (interactive or device code).`);
  }
  return acquireInteractive(cfg, scopes);
}

export async function listAccounts(cfg: AuthConfig): Promise<{ username: string; tenantId: string; homeAccountId: string }[]> {
  const app = await getApp(cfg);
  const accounts = await app.getTokenCache().getAllAccounts();
  return accounts.map((a) => ({ username: a.username, tenantId: a.tenantId, homeAccountId: a.homeAccountId }));
}

export async function signOut(cfg: AuthConfig): Promise<number> {
  const app = await getApp(cfg);
  const accounts = await app.getTokenCache().getAllAccounts();
  for (const a of accounts) await app.getTokenCache().removeAccount(a);
  return accounts.length;
}

/** Tenant id from explicit arg, env, else "organizations" (MSAL discovers it during sign-in). */
export function resolveTenantId(explicit?: string): string {
  return explicit ?? process.env.CPS_TENANT_ID ?? "organizations";
}
