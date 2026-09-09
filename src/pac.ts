/**
 * The pac facade: the account-aware entry point (`runPac`) plus the output
 * parsers, over the account-independent runner in `pacRun.ts`.
 *
 * Everything `pacRun.ts` exports is re-exported here, so this stays the one
 * module the rest of the server imports pac from. The runner must not import
 * this file or `pacProfile.ts`: that is the import cycle this split removes.
 */
import { adminProfileDefault, makerProfileDefault, hasPacProfileLock, runPacAs } from "./pacProfile.js";
import { runPacRaw, type PacResult, type PacRunOptions } from "./pacRun.js";

export * from "./pacRun.js";

/** Commands that are about the profile list itself, or about pac rather than an environment. */
function accountIndependent(args: string[]): boolean {
  return !args.length || args[0] === "auth" || args[0] === "help" || args[0].startsWith("-");
}

/**
 * Run pac on the account this command should use: the admin profile for
 * `pac admin ...`, the maker profile otherwise, and whatever is active for the
 * commands that are not about an environment. Inside an operation that already
 * holds the profile lock the choice is made, so the call runs straight through.
 */
export function runPac(args: string[], options: PacRunOptions = {}): Promise<PacResult> {
  if (hasPacProfileLock()) return runPacRaw(args, options);
  if (accountIndependent(args)) return runPacAs(undefined, args, options);
  return runPacAs(args[0] === "admin" ? adminProfileDefault() : makerProfileDefault(), args, options);
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
