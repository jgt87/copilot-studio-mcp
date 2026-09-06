/**
 * Environment snapshots and comparison for DTAP pipelines.
 *
 * A snapshot is a folder: `snapshot.json` plus `agents/<Agent>/` workspaces
 * produced by `pac copilot clone`. Snapshots are plain files, so they can be
 * committed for history and compared offline. Comparison normalises the YAML
 * (drops audit/id noise, connection ids) before diffing, treats values that
 * differ by design between environments as "expected", and reports the rest
 * as drift.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { createTwoFilesPatch } from "diff";
import { explainFailure, parseCopilotList, runPac } from "./pac.js";
import { findWorkspaceRoot, readWorkspace } from "./workspace.js";
import { listSolutions, type SolutionRow } from "./solutions.js";
import type { ConnectionReferenceRow, EnvironmentVariableRow, FlowRow, BotRow } from "./cloud/dataverse.js";
import { log, errorMessage } from "./log.js";

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

export async function captureSnapshot(o: CaptureOptions): Promise<Snapshot> {
  const dir = path.resolve(o.dir);
  const agentsDir = path.join(dir, "agents");
  fs.rmSync(agentsDir, { recursive: true, force: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  const notes: string[] = [];

  let solutionRow: SolutionRow | null = null;
  try {
    const { solutions } = await listSolutions(o.environment);
    if (o.solution) {
      solutionRow = solutions.find((s) => s.uniqueName.toLowerCase() === o.solution!.toLowerCase()) ?? null;
      if (!solutionRow) notes.push(`Solution '${o.solution}' not found in ${o.label}`);
    }
  } catch (err) {
    notes.push(`solution list failed: ${errorMessage(err)}`);
  }

  let targets: { ref: string; name: string | null }[];
  if (o.agents?.length) targets = o.agents.map((a) => ({ ref: a, name: null }));
  else {
    const r = await runPac(["copilot", "list", "--environment", o.environment], { timeoutMs: 180_000 });
    if (!r.ok) throw new Error(`pac copilot list failed: ${explainFailure(r)}`);
    const rows = parseCopilotList(r.stdout);
    const max = o.maxAgents ?? 20;
    if (rows.length > max) notes.push(`${rows.length} agents in ${o.label}; only the first ${max} were cloned (raise maxAgents or pass agents)`);
    targets = rows.slice(0, max).map((row) => ({ ref: row.botId, name: row.name }));
  }

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

  if (o.dataverse) {
    for (const a of agents) {
      const bot = o.dataverse.bots.find((b) => (a.schemaName && b.schemaName === a.schemaName) || (a.botId && b.botId === a.botId));
      if (bot) {
        a.publishedOn = bot.publishedOn;
        a.modifiedOn = bot.modifiedOn;
        a.authenticationMode = bot.authenticationMode;
        a.isManaged = bot.isManaged;
        a.botId = a.botId ?? bot.botId;
        a.schemaName = a.schemaName ?? bot.schemaName;
      }
    }
  } else notes.push("Dataverse details (flows, connection references, environment variables, publish state) not captured: sign in with cs_login to include them");

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

// ---------------------------------------------------------------------------
// Normalisation and file diff
// ---------------------------------------------------------------------------

/** Keys that differ between environments without meaning a change in the agent. */
export const DEFAULT_IGNORED_KEYS = ["auditInfo", "version", "parentBotId", "parentBotComponentId", "parentBotComponentCollectionId", "connectionId", "customConnectorId", "managedProperties"];
const SKIP_FILES = /(^|[\\/])(\.mcs[\\/]|icon\.png$|agent\.sync\.ya?ml$|botdefinition\.json$)/i;

function normalize(value: unknown, ignored: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ignored));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ignored.has(k)) continue;
    out[k] = normalize(v, ignored);
  }
  return out;
}

function stableYaml(doc: unknown): string {
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: true });
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full);
      if (SKIP_FILES.test(rel + (e.isDirectory() ? path.sep : ""))) continue;
      if (e.isDirectory()) walk(full);
      else out.push(rel.split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

export interface FileComparison {
  path: string;
  status: "identical" | "changed" | "only-in-a" | "only-in-b";
  diff?: string;
}

function contentFor(file: string, ignored: Set<string>): { text: string; binary: boolean } {
  if (/\.ya?ml$/i.test(file)) {
    const raw = fs.readFileSync(file, "utf8");
    try {
      return { text: stableYaml(normalize(yaml.load(raw), ignored)), binary: false };
    } catch {
      return { text: raw, binary: false };
    }
  }
  if (/\.(json|txt|md|csv)$/i.test(file)) return { text: fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), binary: false };
  return { text: createHash("sha1").update(fs.readFileSync(file)).digest("hex"), binary: true };
}

export function compareWorkspaces(rootA: string, rootB: string, opts: { ignoredKeys?: string[]; includeDiffs?: boolean } = {}): FileComparison[] {
  const ignored = new Set(opts.ignoredKeys ?? DEFAULT_IGNORED_KEYS);
  const filesA = new Set(listFiles(rootA));
  const filesB = new Set(listFiles(rootB));
  const all = [...new Set([...filesA, ...filesB])].sort();
  return all.map((rel) => {
    if (!filesA.has(rel)) return { path: rel, status: "only-in-b" as const };
    if (!filesB.has(rel)) return { path: rel, status: "only-in-a" as const };
    const a = contentFor(path.join(rootA, rel), ignored);
    const b = contentFor(path.join(rootB, rel), ignored);
    if (a.text === b.text) return { path: rel, status: "identical" as const };
    const diff = opts.includeDiffs !== false && !a.binary ? createTwoFilesPatch(`a/${rel}`, `b/${rel}`, a.text, b.text, "", "", { context: 3 }) : undefined;
    return { path: rel, status: "changed" as const, ...(diff ? { diff } : {}) };
  });
}

/**
 * One fingerprint per workspace file (sha1 of the normalised YAML, or of the
 * bytes for binaries), keyed by posix-style relative path. `.mcs/`, icons and
 * sync markers are skipped like everywhere else in this module.
 */
export function workspaceFingerprints(root: string, ignoredKeys?: string[]): Record<string, string> {
  const ignored = new Set(ignoredKeys ?? DEFAULT_IGNORED_KEYS);
  const out: Record<string, string> = {};
  for (const rel of listFiles(root)) {
    const c = contentFor(path.join(root, rel), ignored);
    out[rel] = c.binary ? c.text : createHash("sha1").update(c.text).digest("hex");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot comparison
// ---------------------------------------------------------------------------

export interface AgentComparison {
  schemaName: string;
  name: string | null;
  status: "identical" | "changed" | "only-in-a" | "only-in-b" | "clone-failed";
  changedFiles: number;
  files: FileComparison[];
  publish: { a: PublishState | null; b: PublishState | null };
  authenticationMode: { a: number | null; b: number | null; differs: boolean };
}

export interface PublishState {
  publishedOn: string | null;
  modifiedOn: string | null;
  unpublishedChanges: boolean | null;
}

export interface CompareReport {
  a: { label: string; environment: string; takenAt: string };
  b: { label: string; environment: string; takenAt: string };
  solution: { name: string | null; a: SolutionRow | null; b: SolutionRow | null; status: "same" | "version-differs" | "managed-differs" | "missing-in-a" | "missing-in-b" | "not-captured" };
  agents: AgentComparison[];
  flows: { name: string; status: "same" | "only-in-a" | "only-in-b" | "state-differs"; stateA: string | null; stateB: string | null }[] | null;
  connectionReferences: { logicalName: string; status: "same" | "only-in-a" | "only-in-b" | "connector-differs" | "unbound-in-a" | "unbound-in-b" | "unbound-in-both"; connectorA: string | null; connectorB: string | null }[] | null;
  environmentVariables: { schemaName: string; status: "same" | "only-in-a" | "only-in-b" | "value-differs" | "no-value-in-b" | "no-value-in-a"; valueA: string | null; valueB: string | null }[] | null;
  drift: boolean;
  driftSummary: string[];
  expectedDifferences: string[];
  notes: string[];
}

function publishState(a: SnapshotAgent): PublishState | null {
  if (!a.publishedOn && !a.modifiedOn) return null;
  const unpublished = a.publishedOn && a.modifiedOn ? new Date(a.modifiedOn).getTime() > new Date(a.publishedOn).getTime() + 5000 : a.modifiedOn ? true : null;
  return { publishedOn: a.publishedOn, modifiedOn: a.modifiedOn, unpublishedChanges: unpublished };
}

export function compareSnapshots(dirA: string, dirB: string, opts: { ignoredKeys?: string[]; includeDiffs?: boolean; strictVariables?: boolean } = {}): CompareReport {
  const A = readSnapshot(dirA);
  const B = readSnapshot(dirB);
  const drift: string[] = [];
  const expected: string[] = [];
  const notes = [...A.notes.map((n) => `${A.label}: ${n}`), ...B.notes.map((n) => `${B.label}: ${n}`)];

  // Solution
  let solutionStatus: CompareReport["solution"]["status"] = "not-captured";
  if (A.solution || B.solution) {
    if (A.solutionRow && B.solutionRow) {
      if (A.solutionRow.version !== B.solutionRow.version) {
        solutionStatus = "version-differs";
        drift.push(`solution version ${A.solutionRow.version} in ${A.label} vs ${B.solutionRow.version} in ${B.label}`);
      } else if (A.solutionRow.isManaged !== B.solutionRow.isManaged) {
        solutionStatus = "managed-differs";
        expected.push(`solution is ${A.solutionRow.isManaged ? "managed" : "unmanaged"} in ${A.label} and ${B.solutionRow.isManaged ? "managed" : "unmanaged"} in ${B.label}`);
      } else solutionStatus = "same";
    } else if (A.solutionRow) {
      solutionStatus = "missing-in-b";
      drift.push(`solution missing in ${B.label}`);
    } else if (B.solutionRow) {
      solutionStatus = "missing-in-a";
      drift.push(`solution missing in ${A.label}`);
    }
  }

  // Agents by schema name
  const key = (a: SnapshotAgent) => a.schemaName ?? a.botId ?? a.name ?? "?";
  const mapA = new Map(A.agents.map((a) => [key(a), a]));
  const mapB = new Map(B.agents.map((a) => [key(a), a]));
  const agents: AgentComparison[] = [];
  for (const k of [...new Set([...mapA.keys(), ...mapB.keys()])].sort()) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    const base: Omit<AgentComparison, "status" | "changedFiles" | "files"> = {
      schemaName: k,
      name: a?.name ?? b?.name ?? null,
      publish: { a: a ? publishState(a) : null, b: b ? publishState(b) : null },
      authenticationMode: { a: a?.authenticationMode ?? null, b: b?.authenticationMode ?? null, differs: a?.authenticationMode != null && b?.authenticationMode != null && a.authenticationMode !== b.authenticationMode },
    };
    if (!a || !b) {
      agents.push({ ...base, status: a ? "only-in-a" : "only-in-b", changedFiles: 0, files: [] });
      drift.push(`agent ${k} exists only in ${a ? A.label : B.label}`);
      continue;
    }
    if (!a.workspace || !b.workspace) {
      agents.push({ ...base, status: "clone-failed", changedFiles: 0, files: [] });
      notes.push(`agent ${k}: clone failed in ${!a.workspace ? A.label : B.label} (${a.cloneError ?? b.cloneError ?? "no workspace"})`);
      continue;
    }
    const files = compareWorkspaces(a.workspace, b.workspace, opts);
    const changed = files.filter((f) => f.status !== "identical");
    agents.push({ ...base, status: changed.length ? "changed" : "identical", changedFiles: changed.length, files: opts.includeDiffs === false ? changed.map(({ diff: _d, ...f }) => f) : changed });
    if (changed.length) drift.push(`agent ${k}: ${changed.length} file(s) differ (${changed.slice(0, 5).map((f) => f.path).join(", ")}${changed.length > 5 ? ", ..." : ""})`);
    if (base.authenticationMode.differs) drift.push(`agent ${k}: authentication mode ${base.authenticationMode.a} in ${A.label} vs ${base.authenticationMode.b} in ${B.label}`);
    for (const [label, st] of [[A.label, base.publish.a], [B.label, base.publish.b]] as const) {
      if (st?.unpublishedChanges) drift.push(`agent ${k}: unpublished changes in ${label} (modified ${st.modifiedOn}, published ${st.publishedOn ?? "never"})`);
    }
  }

  // Flows
  let flows: CompareReport["flows"] = null;
  if (A.flows && B.flows) {
    const fa = new Map(A.flows.map((f) => [f.name, f]));
    const fb = new Map(B.flows.map((f) => [f.name, f]));
    flows = [...new Set([...fa.keys(), ...fb.keys()])].sort().map((name) => {
      const x = fa.get(name);
      const y = fb.get(name);
      const status = !x ? "only-in-b" : !y ? "only-in-a" : x.state !== y.state ? "state-differs" : "same";
      if (status !== "same") drift.push(`flow '${name}': ${status}${status === "state-differs" ? ` (${x?.state} vs ${y?.state})` : ""}`);
      return { name, status, stateA: x?.state ?? null, stateB: y?.state ?? null } as NonNullable<CompareReport["flows"]>[number];
    });
  }

  // Connection references
  let connectionReferences: CompareReport["connectionReferences"] = null;
  if (A.connectionReferences && B.connectionReferences) {
    const ca = new Map(A.connectionReferences.map((c) => [c.logicalName, c]));
    const cb = new Map(B.connectionReferences.map((c) => [c.logicalName, c]));
    connectionReferences = [...new Set([...ca.keys(), ...cb.keys()])].sort().map((logicalName) => {
      const x = ca.get(logicalName);
      const y = cb.get(logicalName);
      let status: NonNullable<CompareReport["connectionReferences"]>[number]["status"] = "same";
      if (!x) status = "only-in-b";
      else if (!y) status = "only-in-a";
      else if ((x.connectorId ?? "") !== (y.connectorId ?? "")) status = "connector-differs";
      else if (!x.connectionId && !y.connectionId) status = "unbound-in-both";
      else if (!x.connectionId) status = "unbound-in-a";
      else if (!y.connectionId) status = "unbound-in-b";
      if (status === "same" && x?.connectionId !== y?.connectionId) expected.push(`connection reference ${logicalName} is bound to different connections (by design)`);
      else if (status !== "same") drift.push(`connection reference ${logicalName}: ${status}`);
      return { logicalName, status, connectorA: x?.connectorId ?? null, connectorB: y?.connectorId ?? null };
    });
  }

  // Environment variables
  let environmentVariables: CompareReport["environmentVariables"] = null;
  if (A.environmentVariables && B.environmentVariables) {
    const va = new Map(A.environmentVariables.map((v) => [v.schemaName, v]));
    const vb = new Map(B.environmentVariables.map((v) => [v.schemaName, v]));
    environmentVariables = [...new Set([...va.keys(), ...vb.keys()])].sort().map((schemaName) => {
      const x = va.get(schemaName);
      const y = vb.get(schemaName);
      const valA = x ? (x.currentValue ?? x.defaultValue) : null;
      const valB = y ? (y.currentValue ?? y.defaultValue) : null;
      let status: NonNullable<CompareReport["environmentVariables"]>[number]["status"] = "same";
      if (!x) status = "only-in-b";
      else if (!y) status = "only-in-a";
      else if (!valB && valA) status = "no-value-in-b";
      else if (!valA && valB) status = "no-value-in-a";
      else if (valA !== valB) status = "value-differs";
      if (status === "value-differs") (opts.strictVariables ? drift : expected).push(`environment variable ${schemaName} differs (${valA} vs ${valB})`);
      else if (status !== "same") drift.push(`environment variable ${schemaName}: ${status}`);
      return { schemaName, status, valueA: valA, valueB: valB };
    });
  }

  return {
    a: { label: A.label, environment: A.environment, takenAt: A.takenAt },
    b: { label: B.label, environment: B.environment, takenAt: B.takenAt },
    solution: { name: A.solution ?? B.solution ?? null, a: A.solutionRow, b: B.solutionRow, status: solutionStatus },
    agents,
    flows,
    connectionReferences,
    environmentVariables,
    drift: drift.length > 0,
    driftSummary: drift,
    expectedDifferences: expected,
    notes,
  };
}

export function renderReportMarkdown(r: CompareReport): string {
  const lines: string[] = [];
  lines.push(`# ${r.a.label} vs ${r.b.label}`, "", `- ${r.a.label}: environment ${r.a.environment}, snapshot ${r.a.takenAt}`, `- ${r.b.label}: environment ${r.b.environment}, snapshot ${r.b.takenAt}`, "", `**Verdict: ${r.drift ? "DRIFT" : "no drift"}**`, "");
  if (r.driftSummary.length) lines.push("## Drift", "", ...r.driftSummary.map((d) => `- ${d}`), "");
  if (r.expectedDifferences.length) lines.push("## Expected differences", "", ...r.expectedDifferences.map((d) => `- ${d}`), "");
  lines.push("## Solution", "", `| | ${r.a.label} | ${r.b.label} |`, "| --- | --- | --- |", `| version | ${r.solution.a?.version ?? "-"} | ${r.solution.b?.version ?? "-"} |`, `| managed | ${r.solution.a ? r.solution.a.isManaged : "-"} | ${r.solution.b ? r.solution.b.isManaged : "-"} |`, `| status | ${r.solution.status} | |`, "");
  lines.push("## Agents", "", "| agent | status | changed files | unpublished changes |", "| --- | --- | --- | --- |");
  for (const a of r.agents) lines.push(`| ${a.schemaName}${a.name ? ` (${a.name})` : ""} | ${a.status} | ${a.changedFiles} | ${r.a.label}: ${a.publish.a?.unpublishedChanges ?? "?"}, ${r.b.label}: ${a.publish.b?.unpublishedChanges ?? "?"} |`);
  lines.push("");
  for (const a of r.agents) {
    const withDiff = a.files.filter((f) => f.diff);
    if (!withDiff.length) continue;
    lines.push(`### ${a.schemaName}`, "");
    for (const f of withDiff) lines.push(`#### ${f.path} (${f.status})`, "", "```diff", f.diff!.trimEnd(), "```", "");
  }
  const section = (title: string, header: string[], rows: string[][] | null) => {
    if (!rows) {
      lines.push(`## ${title}`, "", "_not captured (no Dataverse sign-in)_", "");
      return;
    }
    lines.push(`## ${title}`, "", `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`), "");
  };
  section("Flows", ["flow", "status", r.a.label, r.b.label], r.flows?.map((f) => [f.name, f.status, f.stateA ?? "-", f.stateB ?? "-"]) ?? null);
  section("Connection references", ["reference", "status", "connector"], r.connectionReferences?.map((c) => [c.logicalName, c.status, (c.connectorA ?? c.connectorB ?? "-").split("/").pop() ?? "-"]) ?? null);
  section("Environment variables", ["variable", "status", r.a.label, r.b.label], r.environmentVariables?.map((v) => [v.schemaName, v.status, v.valueA ?? "-", v.valueB ?? "-"]) ?? null);
  if (r.notes.length) lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

/** Compare adjacent pairs of an ordered chain (DEV -> TEST -> ACC -> PROD). */
export function compareChain(dirs: string[], opts: Parameters<typeof compareSnapshots>[2] = {}): CompareReport[] {
  const out: CompareReport[] = [];
  for (let i = 0; i + 1 < dirs.length; i++) out.push(compareSnapshots(dirs[i], dirs[i + 1], opts));
  return out;
}

export function writeReport(dir: string, name: string, report: CompareReport): { json: string; markdown: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `${name}.json`);
  const markdown = path.join(dir, `${name}.md`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(markdown, renderReportMarkdown(report), "utf8");
  log(`report written: ${markdown}`);
  return { json, markdown };
}
