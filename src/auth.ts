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
 * How to hand a URL to the default browser without a shell parsing it.
 * On Windows `cmd /c start <url>` cuts the URL at the first `&` (and expands
 * `%` sequences), which strips `scope` from the Entra authorize request and
 * makes the sign-in page fail with AADSTS900144 ("The request body must
 * contain the following parameter: 'scope'"). PowerShell with an encoded
 * command passes the URL through untouched.
 */
export function browserLaunchSpec(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") {
    const script = `Start-Process -FilePath '${url.replace(/'/g, "''")}'`;
    return { command: windowsPowerShell(), args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Absolute path of Windows PowerShell where Windows installs it; falls back to PATH lookup. */
function windowsPowerShell(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(full) ? full : "powershell.exe";
}

/**
 * Start a fire-and-forget process. A launch failure (ENOENT, EACCES) is
 * logged, never thrown: the 'error' event of a child process is emitted
 * asynchronously, and without a listener it takes the whole server down,
 * which MCP clients only see as a broken pipe.
 */
export function launchDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => log(`could not start ${command}: ${err.message}`));
    child.unref();
  } catch (err) {
    log(`could not start ${command}: ${(err as Error).message}`);
  }
}

function openBrowser(url: string): void {
  const { command, args } = browserLaunchSpec(url);
  launchDetached(command, args);
}

export async function acquireInteractive(cfg: AuthConfig, scopes: string[], timeoutMs = 300_000): Promise<TokenInfo> {
  const app = await getApp(cfg);
  const result = await Promise.race([
    app.acquireTokenInteractive({
      scopes,
      openBrowser: async (url) => {
        log(`open this URL to sign in: ${url}`);
        openBrowser(url);
      },
      successTemplate: "<html><body><h2>Signed in. You can close this tab.</h2></body></html>",
      errorTemplate: "<html><body><h2>Sign-in failed. Return to your editor.</h2></body></html>",
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`interactive sign-in timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
  ]);
  return toTokenInfo(result);
}

interface PendingDeviceLogin {
  key: string;
  info: DeviceCodeInfo;
  promise: Promise<TokenInfo>;
  startedAt: number;
  done: boolean;
  error: string | null;
}

let pendingDevice: PendingDeviceLogin | null = null;

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
  const entry: PendingDeviceLogin = {
    key: `${cfg.tenantId}:${scopes.join(" ")}`,
    info: { userCode: "", verificationUri: "", message: "", expiresIn: 0 },
    promise: Promise.reject(new Error("not started")),
    startedAt: Date.now(),
    done: false,
    error: null,
  };
  entry.promise.catch(() => undefined);
  const promise = app
    .acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: (resp) => {
        resolveInfo({ userCode: resp.userCode, verificationUri: resp.verificationUri, message: resp.message, expiresIn: resp.expiresIn });
      },
    })
    .then((r) => {
      if (!r) throw new Error("device code flow returned no result");
      entry.done = true;
      return toTokenInfo(r);
    })
    .catch((err: Error) => {
      entry.done = true;
      entry.error = err.message;
      rejectInfo(err);
      throw err;
    });
  // Keep the rejection from surfacing as unhandled before someone awaits it.
  promise.catch(() => undefined);
  entry.promise = promise;
  entry.info = await infoPromise;
  pendingDevice = entry;
  return entry.info;
}

export function pendingLoginStatus(): { pending: boolean; info?: DeviceCodeInfo; done?: boolean; error?: string | null; ageSeconds?: number } {
  if (!pendingDevice) return { pending: false };
  return {
    pending: !pendingDevice.done,
    info: pendingDevice.info,
    done: pendingDevice.done,
    error: pendingDevice.error,
    ageSeconds: Math.round((Date.now() - pendingDevice.startedAt) / 1000),
  };
}

export async function waitForPendingLogin(timeoutMs = 900_000): Promise<TokenInfo | null> {
  if (!pendingDevice) return null;
  const p = pendingDevice.promise;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("device code login still pending; complete it in the browser and retry")), timeoutMs)),
  ]);
}

/**
 * Get a token for `scopes`: silent first, then whatever pending device login
 * exists, then interactive browser sign-in (unless disabled).
 */
export async function getToken(cfg: AuthConfig, scopes: string[], opts: { interactive?: boolean } = {}): Promise<TokenInfo> {
  const silent = await acquireSilent(cfg, scopes);
  if (silent) return silent;
  if (pendingDevice && !pendingDevice.done) {
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
