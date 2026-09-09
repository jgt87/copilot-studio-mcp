/**
 * Finding and running pac, and reading `pac auth list`.
 *
 * This layer knows nothing about which account is active: it spawns the
 * process it is told to spawn. The account coordinator (`pacProfile.ts`) sits
 * above it and needs the profile list to choose one, so the `auth list` parser
 * lives here too - reading the profiles must not itself require a profile.
 * `pac.ts` is the facade over both and is what the rest of the server imports.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
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

/**
 * Stop a timed-out run. On Windows the spawned process may be `cmd.exe`
 * wrapping the real pac (see spawnSpec): killing the wrapper alone orphans its
 * descendants, which keep the inherited pipes open, so `close` never arrives
 * and the timeout does not bound the call. taskkill /T ends the whole tree.
 */
function terminateTree(child: ChildProcess, done: (confirmed: boolean) => void): void {
  if (IS_WIN && child.pid) {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 2000 }, (err) => done(!err));
    return;
  }
  done(child.kill("SIGKILL"));
}

/** Publish always checks its known zero-exit failure; other commands opt in. */
function failurePatterns(args: string[], options: PacRunOptions): RegExp[] {
  const publish = args[0] === "copilot" && args[1] === "publish";
  return [...(options.failOnOutput ?? []), ...(publish ? [PUBLISH_FAILED] : [])];
}

const TERMINATED = "Process termination completed; remote changes already submitted may still complete.";
const TERMINATION_UNCONFIRMED = "Process termination could not be confirmed; the operation may still be running. Check its status before retrying.";

/**
 * Run pac with the given argv, on whichever profile is currently active.
 * Never throws for a non-zero exit; rejects only when pac is missing or the
 * process cannot be spawned at all. Account-dependent callers want
 * `runPac`/`runPacAs`, which choose the profile first.
 */
export function runPacRaw(args: string[], options: PacRunOptions = {}): Promise<PacResult> {
  const exe = findPac();
  if (!exe) return Promise.reject(new Error(installHint()));
  const started = Date.now();
  const shownArgs = options.redact?.length ? args.map((a) => (options.redact!.includes(a) ? "***" : a)) : args;
  const command = `${path.basename(exe)} ${shownArgs.join(" ")}`;
  log(`run: ${command}${options.cwd ? ` (cwd ${options.cwd})` : ""}`);

  const spawnAs = spawnSpec(exe, args);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
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
    let settled = false;
    let terminating = false;
    let terminationNote = "";

    const finish = (code: number | null) => {
      if (settled || terminating) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) stderr += `\n[copilot-studio-mcp] pac timed out after ${timeoutMs} ms. ${terminationNote}`;
      const out = stdout.replace(ANSI, "");
      let err = stderr.replace(ANSI, "");
      const reportedFailure = code === 0 ? failurePatterns(args, options).find((re) => re.test(out) || re.test(err)) : undefined;
      if (reportedFailure) err += `\n[copilot-studio-mcp] pac exited 0 but its output reports failure (matched ${String(reportedFailure)})`;
      resolve({ ok: !timedOut && code === 0 && !reportedFailure, code, stdout: out, stderr: err, command, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminating = true;
      terminateTree(child, (confirmed) => {
        terminationNote = confirmed ? TERMINATED : TERMINATION_UNCONFIRMED;
        terminating = false;
        // Drop the pipes an orphaned descendant could still hold open.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", finish);
  });
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
