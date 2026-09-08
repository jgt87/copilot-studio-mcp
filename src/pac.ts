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
  /**
   * Patterns that mean failure even though pac exited 0. `pac copilot publish`
   * prints "Failed to publish" and still exits 0, which made this server report
   * a successful publish of an agent that had not published (found on a live
   * tenant, 2026-09-09). Opt in per command: applied to everything, a pattern
   * like this would misread the word "failed" in an unrelated log line.
   */
  failOnOutput?: RegExp[];
}

/** `pac copilot publish` reporting failure on a zero exit. */
export const PUBLISH_FAILED = /\bFailed to publish\b/i;

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
 * How to spawn pac. A `.cmd` shim cannot be spawned directly on Windows
 * (EINVAL), and `shell: true` is not the answer: node then concatenates argv
 * without escaping, so `--project-dir C:\a b\ws` arrives as three arguments
 * with the backslashes eaten by cmd. Build the command line instead and hand it
 * to `cmd /d /s /c` verbatim: with the whole line wrapped in quotes, `/s` makes
 * cmd strip only the outer pair and take the rest as written.
 */
function spawnSpec(exe: string, args: string[]): { exe: string; args: string[]; verbatim: boolean } {
  if (!IS_WIN || !exe.toLowerCase().endsWith(".cmd")) return { exe, args, verbatim: false };
  const line = [exe, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  return { exe: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
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

  const spawnAs = spawnSpec(exe, args);
  return new Promise((resolve, reject) => {
    const child = spawn(spawnAs.exe, spawnAs.args, {
      cwd: options.cwd,
      env: { ...process.env, ...dotnetRootDefault(), ...options.env, PAC_CLI_TELEMETRY_OPTOUT: process.env.PAC_CLI_TELEMETRY_OPTOUT ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: spawnAs.verbatim,
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
      const out = stdout.replace(ANSI, "");
      let err = stderr.replace(ANSI, "");
      // pac can report a failure and still exit 0; only the commands that opt in are checked.
      const reportedFailure = code === 0 ? (options.failOnOutput ?? []).find((re) => re.test(out) || re.test(err)) : undefined;
      if (reportedFailure) err += `\n[copilot-studio-mcp] pac exited 0 but its output reports failure (matched ${String(reportedFailure)})`;
      resolve({
        ok: !timedOut && code === 0 && !reportedFailure,
        code,
        stdout: out,
        stderr: err,
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
/**
 * Rows from pac's JSON output, either a bare array or `{ value: [...] }`.
 * Column names differ between pac versions, so each field accepts the shapes
 * seen so far. Returns null when the text is not the JSON we expect, which
 * sends the caller back to the text parser.
 */
function copilotRowsFromJson(trimmed: string): CopilotRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
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
}

/** Rows from the text table, anchored on the two GUID columns rather than column offsets. */
function copilotRowsFromText(stdout: string): CopilotRow[] {
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

export function parseCopilotList(stdout: string): CopilotRow[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const rows = copilotRowsFromJson(trimmed);
    if (rows) return rows;
  }
  return copilotRowsFromText(stdout);
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
