/**
 * Thin wrapper around the Power Platform CLI (`pac`). Spawns without a shell,
 * passes an argv array, and returns stdout/stderr/exit code. Output parsing for
 * the handful of list commands the server exposes lives here too.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.js";

export interface PacResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

export interface PacRunOptions {
  /** Argument values to mask in the log line and the returned command string (secrets). */
  redact?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const IS_WIN = process.platform === "win32";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

function candidateNames(): string[] {
  return IS_WIN ? ["pac.exe", "pac.cmd", "pac"] : ["pac"];
}

/**
 * Locate pac. Order: PAC_PATH env, PATH entries, the dotnet global tools folder.
 * Returns null when nothing is found; callers turn that into an install hint.
 */
export function findPac(): string | null {
  const override = process.env.PAC_PATH;
  if (override && fs.existsSync(override)) return override;

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    for (const name of candidateNames()) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }

  const toolsDir = path.join(os.homedir(), ".dotnet", "tools");
  for (const name of candidateNames()) {
    const full = path.join(toolsDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * pac installed as a dotnet global tool needs the matching .NET runtime. When
 * the SDK lives in the user profile (dotnet-install.ps1 without admin), the
 * shim only finds it through DOTNET_ROOT, so default it when unset.
 */
export function dotnetRootDefault(): NodeJS.ProcessEnv {
  if (process.env.DOTNET_ROOT) return {};
  const userRoot = path.join(os.homedir(), ".dotnet");
  const exe = path.join(userRoot, IS_WIN ? "dotnet.exe" : "dotnet");
  return fs.existsSync(exe) ? { DOTNET_ROOT: userRoot } : {};
}

export function installHint(): string {
  return [
    "pac (Power Platform CLI) was not found.",
    "Install the .NET 10 SDK, then run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool",
    "Or set PAC_PATH to the pac executable.",
  ].join(" ");
}

/**
 * Run pac with the given argv. Never throws for a non-zero exit; rejects only
 * when pac is missing or the process cannot be spawned at all.
 */
export function runPac(args: string[], options: PacRunOptions = {}): Promise<PacResult> {
  const exe = findPac();
  if (!exe) return Promise.reject(new Error(installHint()));
  const started = Date.now();
  const shownArgs = options.redact?.length ? args.map((a) => (options.redact!.includes(a) ? "***" : a)) : args;
  const command = `${path.basename(exe)} ${shownArgs.join(" ")}`;
  log(`run: ${command}${options.cwd ? ` (cwd ${options.cwd})` : ""}`);

  return new Promise((resolve, reject) => {
    // .cmd shims cannot be spawned without a shell on Windows (EINVAL).
    const useShell = IS_WIN && exe.toLowerCase().endsWith(".cmd");
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: { ...process.env, ...dotnetRootDefault(), ...options.env, PAC_CLI_TELEMETRY_OPTOUT: process.env.PAC_CLI_TELEMETRY_OPTOUT ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[copilot-studio-mcp] pac timed out after ${timeoutMs} ms`;
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout: stdout.replace(ANSI, ""),
        stderr: stderr.replace(ANSI, ""),
        command,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** `pac` with no arguments prints a banner containing `Version: x.y.z+gHASH`. */
export function parseVersion(bannerOrHelp: string): string | null {
  const m = /Version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:[+\-][^\s]*)?)/.exec(bannerOrHelp);
  return m ? m[1] : null;
}

export async function pacVersion(): Promise<string | null> {
  const r = await runPac([], { timeoutMs: 60_000 });
  return parseVersion(r.stdout) ?? parseVersion(r.stderr);
}

export interface AuthProfile {
  index: number;
  active: boolean;
  kind: string;
  name: string;
  url: string | null;
  user: string | null;
  cloud: string | null;
  raw: string;
}

/**
 * Parse `pac auth list`. The table is space-aligned and the friendly name may
 * contain spaces, so we anchor on the bracketed index and pull the URL and the
 * user (an email or an app id) out with regexes rather than column offsets.
 */
export function parseAuthList(stdout: string): AuthProfile[] {
  const profiles: AuthProfile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*\[(\d+)\]\s+(\*?)\s*(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[4];
    const url = /https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const user = /[^\s]+@[^\s]+/.exec(rest)?.[0] ?? null;
    const cloud = /\b(Public|UsGov|UsGovHigh|UsGovDod|China|Preprod|Tip1|Tip2)\b/.exec(rest)?.[1] ?? null;
    let name = rest;
    if (url) name = name.slice(0, name.indexOf(url));
    profiles.push({
      index: Number(m[1]),
      active: m[2] === "*",
      kind: m[3],
      name: name.trim(),
      url,
      user,
      cloud,
      raw: line.trim(),
    });
  }
  return profiles;
}

export interface CopilotRow {
  name: string;
  botId: string;
  componentState: string | null;
  isManaged: boolean | null;
  solutionId: string | null;
  statusCode: string | null;
  stateCode: string | null;
}

const GUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * Parse `pac copilot list`. Accepts JSON when pac emitted it, else anchors each
 * text row on its two GUID columns (Bot ID, Solution ID).
 */
export function parseCopilotList(stdout: string): CopilotRow[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed) ? parsed : ((parsed as { value?: unknown[] }).value ?? []);
      return (arr as Record<string, unknown>[]).map((r) => ({
        name: String(r.Name ?? r.name ?? ""),
        botId: String(r.BotId ?? r["Bot ID"] ?? r.botId ?? r.id ?? ""),
        componentState: (r.ComponentState ?? r["Component State"] ?? null) as string | null,
        isManaged: typeof r.IsManaged === "boolean" ? r.IsManaged : null,
        solutionId: (r.SolutionId ?? r["Solution ID"] ?? null) as string | null,
        statusCode: (r.StatusCode ?? r["Status Code"] ?? null) as string | null,
        stateCode: (r.StateCode ?? r["State Code"] ?? null) as string | null,
      }));
    } catch {
      // fall through to text parsing
    }
  }
  const rows: CopilotRow[] = [];
  const re = new RegExp(`^(.*?)\\s+(${GUID})\\s+(\\S+)\\s+(\\S+)\\s+(${GUID})\\s+(\\S+)\\s+(\\S+)\\s*$`);
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    rows.push({
      name: m[1].trim(),
      botId: m[2],
      componentState: m[3],
      isManaged: /^managed$/i.test(m[4]) ? true : /^unmanaged$/i.test(m[4]) ? false : null,
      solutionId: m[5],
      statusCode: m[6],
      stateCode: m[7],
    });
  }
  return rows;
}

/** Turn a pac failure into a one-line explanation, keeping the tail of stderr/stdout. */
export function explainFailure(r: PacResult): string {
  const tail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
  if (/workspace not found|No synced workspace/i.test(tail)) {
    return `${tail} - pull/push only work inside a folder created by 'pac copilot clone' or 'pac copilot init --environment'.`;
  }
  if (/pull first|changed on the server|conflict/i.test(tail)) {
    return `${tail} - run cs_pull, resolve, then push again.`;
  }
  if (/auth|sign in|login|token|not authenticated|No profiles/i.test(tail)) {
    return `${tail} - create a profile with 'pac auth create --environment <id-or-url>' in a terminal (interactive sign-in).`;
  }
  if (/Unsupported directory/i.test(tail)) {
    return `${tail} - 'pac copilot pack' refuses an output path inside the workspace; choose a folder outside it.`;
  }
  return tail || `pac exited with code ${r.code}`;
}
