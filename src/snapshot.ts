/**
 * Capturing one environment as a snapshot folder.
 *
 * A snapshot is `snapshot.json` plus `agents/<Agent>/` workspaces produced by
 * `pac copilot clone`, so it is plain files that can be committed for history
 * and compared offline (`compareReport.ts`).
 */
import fs from "node:fs";
import { withPacProfile, makerProfileDefault, hasPacProfileLock } from "./pacProfile.js";
import path from "node:path";
import { explainFailure, parseCopilotList, runPac } from "./pac.js";
import { findWorkspaceRoot, readWorkspace } from "./workspace.js";
import { listSolutions, type SolutionRow } from "./solutions.js";
import type { ConnectionReferenceRow, EnvironmentVariableRow, FlowRow, BotRow } from "./cloud/dataverse.js";
import { errorMessage } from "./log.js";

export const SNAPSHOT_FILE = "snapshot.json";

export interface SnapshotAgent {
  schemaName: string | null;
  botId: string | null;
  name: string | null;
  workspace: string | null;
  cloneError: string | null;
  publishedOn: string | null;
  modifiedOn: string | null;
  authenticationMode: number | null;
  isManaged: boolean | null;
}

export interface Snapshot {
  label: string;
  environment: string;
  takenAt: string;
  solution: string | null;
  solutionRow: SolutionRow | null;
  agents: SnapshotAgent[];
  /** null = not captured (no Dataverse sign-in) */
  flows: FlowRow[] | null;
  connectionReferences: ConnectionReferenceRow[] | null;
  environmentVariables: EnvironmentVariableRow[] | null;
  notes: string[];
}

export function writeSnapshot(dir: string, s: Snapshot): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SNAPSHOT_FILE);
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", "utf8");
  return file;
}

export function readSnapshot(dir: string): Snapshot {
  const file = path.join(dir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) throw new Error(`No ${SNAPSHOT_FILE} in ${dir}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface DataverseReads {
  bots: BotRow[];
  flows: FlowRow[];
  connectionReferences: ConnectionReferenceRow[];
  environmentVariables: EnvironmentVariableRow[];
}

export interface CaptureOptions {
  label: string;
  environment: string;
  dir: string;
  solution?: string;
  /** Agent schema names or ids to clone. Default: every agent `pac copilot list` returns (up to maxAgents). */
  agents?: string[];
  maxAgents?: number;
  /** Optional Dataverse reads (flows, connection references, environment variables, publish state). */
  dataverse?: DataverseReads | null;
}

function listDirs(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

/** The solution row to record, when the caller named a solution. A failure is a note, not an error. */
async function resolveSolutionRow(o: CaptureOptions, notes: string[]): Promise<SolutionRow | null> {
  try {
    const { solutions } = await listSolutions(o.environment);
    if (!o.solution) return null;
    const row = solutions.find((s) => s.uniqueName.toLowerCase() === o.solution!.toLowerCase()) ?? null;
    if (!row) notes.push(`Solution '${o.solution}' not found in ${o.label}`);
    return row;
  } catch (err) {
    notes.push(`solution list failed: ${errorMessage(err)}`);
    return null;
  }
}

/** The agents to clone: the ones the caller named, or what `pac copilot list` returns up to maxAgents. */
async function resolveTargets(o: CaptureOptions, notes: string[]): Promise<{ ref: string; name: string | null }[]> {
  if (o.agents?.length) return o.agents.map((a) => ({ ref: a, name: null }));
  const r = await runPac(["copilot", "list", "--environment", o.environment], { timeoutMs: 180_000 });
  if (!r.ok) throw new Error(`pac copilot list failed: ${explainFailure(r)}`);
  const rows = parseCopilotList(r.stdout);
  const max = o.maxAgents ?? 20;
  if (rows.length > max) notes.push(`${rows.length} agents in ${o.label}; only the first ${max} were cloned (raise maxAgents or pass agents)`);
  return rows.slice(0, max).map((row) => ({ ref: row.botId, name: row.name }));
}

/** Clone each agent into `agentsDir`; a clone that fails becomes an entry carrying the reason. */
async function cloneAgents(o: CaptureOptions, agentsDir: string, targets: { ref: string; name: string | null }[]): Promise<SnapshotAgent[]> {
  const agents: SnapshotAgent[] = [];
  for (const t of targets) {
    const before = listDirs(agentsDir);
    const r = await runPac(["copilot", "clone", "--bot", t.ref, "--environment", o.environment, "--output-dir", agentsDir], { timeoutMs: 15 * 60_000 });
    const entry: SnapshotAgent = { schemaName: null, botId: null, name: t.name, workspace: null, cloneError: null, publishedOn: null, modifiedOn: null, authenticationMode: null, isManaged: null };
    if (r.ok) {
      const created = [...listDirs(agentsDir)].filter((d) => !before.has(d));
      const folder = created.length === 1 ? path.join(agentsDir, created[0]) : findWorkspaceRoot(agentsDir);
      if (folder) {
        const ws = readWorkspace(folder);
        entry.workspace = folder;
        entry.schemaName = ws.schemaName;
        entry.botId = ws.sync.agentId ?? (/^[0-9a-f-]{36}$/i.test(t.ref) ? t.ref : null);
        entry.name = (ws.settings?.displayName as string) ?? t.name;
      } else entry.cloneError = "clone succeeded but the workspace folder could not be located";
    } else entry.cloneError = explainFailure(r);
    if (!entry.schemaName && !/^[0-9a-f-]{36}$/i.test(t.ref)) entry.schemaName = t.ref;
    agents.push(entry);
  }
  return agents;
}

/** Fill in publish state and managed flag from the Dataverse rows, matching on schema name or id. */
function applyDataverseDetails(agents: SnapshotAgent[], dataverse: DataverseReads | null | undefined, notes: string[]): void {
  if (!dataverse) {
    notes.push("Dataverse details (flows, connection references, environment variables, publish state) not captured: sign in with cs_login to include them");
    return;
  }
  for (const a of agents) {
    const bot = dataverse.bots.find((b) => (a.schemaName && b.schemaName === a.schemaName) || (a.botId && b.botId === a.botId));
    if (!bot) continue;
    a.publishedOn = bot.publishedOn;
    a.modifiedOn = bot.modifiedOn;
    a.authenticationMode = bot.authenticationMode;
    a.isManaged = bot.isManaged;
    a.botId = a.botId ?? bot.botId;
    a.schemaName = a.schemaName ?? bot.schemaName;
  }
}

export async function captureSnapshot(o: CaptureOptions): Promise<Snapshot> {
  if (!hasPacProfileLock()) return (await withPacProfile(makerProfileDefault(), () => captureSnapshot(o))).result;
  const dir = path.resolve(o.dir);
  const agentsDir = path.join(dir, "agents");
  fs.rmSync(agentsDir, { recursive: true, force: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  const notes: string[] = [];

  const solutionRow = await resolveSolutionRow(o, notes);
  const targets = await resolveTargets(o, notes);
  const agents = await cloneAgents(o, agentsDir, targets);
  applyDataverseDetails(agents, o.dataverse, notes);

  const snapshot: Snapshot = {
    label: o.label,
    environment: o.environment,
    takenAt: new Date().toISOString(),
    solution: o.solution ?? null,
    solutionRow,
    agents,
    flows: o.dataverse?.flows ?? null,
    connectionReferences: o.dataverse?.connectionReferences ?? null,
    environmentVariables: o.dataverse?.environmentVariables ?? null,
    notes,
  };
  writeSnapshot(dir, snapshot);
  return snapshot;
}
