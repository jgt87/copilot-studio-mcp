/**
 * Comparing two snapshots and reporting the result.
 *
 * Each layer (solution, agents, flows, connection references, environment
 * variables) is compared by its own function, and each classifies what it
 * finds as **drift** (a real difference) or an **expected difference** (a value
 * that is meant to differ per environment: a connection binding, a variable
 * value, the managed flag).
 */
import fs from "node:fs";
import path from "node:path";
import { readSnapshot, type Snapshot, type SnapshotAgent } from "./snapshot.js";
import { compareWorkspaces, type FileComparison } from "./workspaceDiff.js";
import type { SolutionRow } from "./solutions.js";
import { log } from "./log.js";

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

type CompareOptions = { ignoredKeys?: string[]; includeDiffs?: boolean; strictVariables?: boolean };

/** Where drift and expected differences are collected while the layers are compared. */
interface Findings {
  drift: string[];
  expected: string[];
  notes: string[];
}

function publishState(a: SnapshotAgent): PublishState | null {
  if (!a.publishedOn && !a.modifiedOn) return null;
  const unpublished = a.publishedOn && a.modifiedOn ? new Date(a.modifiedOn).getTime() > new Date(a.publishedOn).getTime() + 5000 : a.modifiedOn ? true : null;
  return { publishedOn: a.publishedOn, modifiedOn: a.modifiedOn, unpublishedChanges: unpublished };
}

/** Pair two lists by key and walk the union in a stable order, so both sides are always visible. */
function mergeByKey<T>(a: T[], b: T[], key: (item: T) => string): { key: string; a: T | undefined; b: T | undefined }[] {
  const mapA = new Map(a.map((item) => [key(item), item]));
  const mapB = new Map(b.map((item) => [key(item), item]));
  return [...new Set([...mapA.keys(), ...mapB.keys()])].sort().map((k) => ({ key: k, a: mapA.get(k), b: mapB.get(k) }));
}

function compareSolution(A: Snapshot, B: Snapshot, f: Findings): CompareReport["solution"]["status"] {
  if (!A.solution && !B.solution) return "not-captured";
  if (A.solutionRow && B.solutionRow) {
    if (A.solutionRow.version !== B.solutionRow.version) {
      f.drift.push(`solution version ${A.solutionRow.version} in ${A.label} vs ${B.solutionRow.version} in ${B.label}`);
      return "version-differs";
    }
    if (A.solutionRow.isManaged !== B.solutionRow.isManaged) {
      f.expected.push(`solution is ${A.solutionRow.isManaged ? "managed" : "unmanaged"} in ${A.label} and ${B.solutionRow.isManaged ? "managed" : "unmanaged"} in ${B.label}`);
      return "managed-differs";
    }
    return "same";
  }
  if (A.solutionRow) {
    f.drift.push(`solution missing in ${B.label}`);
    return "missing-in-b";
  }
  if (B.solutionRow) {
    f.drift.push(`solution missing in ${A.label}`);
    return "missing-in-a";
  }
  return "not-captured";
}

function compareAgents(A: Snapshot, B: Snapshot, opts: CompareOptions, f: Findings): AgentComparison[] {
  const key = (a: SnapshotAgent) => a.schemaName ?? a.botId ?? a.name ?? "?";
  const agents: AgentComparison[] = [];
  for (const { key: k, a, b } of mergeByKey(A.agents, B.agents, key)) {
    const base: Omit<AgentComparison, "status" | "changedFiles" | "files"> = {
      schemaName: k,
      name: a?.name ?? b?.name ?? null,
      publish: { a: a ? publishState(a) : null, b: b ? publishState(b) : null },
      authenticationMode: { a: a?.authenticationMode ?? null, b: b?.authenticationMode ?? null, differs: a?.authenticationMode != null && b?.authenticationMode != null && a.authenticationMode !== b.authenticationMode },
    };
    if (!a || !b) {
      agents.push({ ...base, status: a ? "only-in-a" : "only-in-b", changedFiles: 0, files: [] });
      f.drift.push(`agent ${k} exists only in ${a ? A.label : B.label}`);
      continue;
    }
    if (!a.workspace || !b.workspace) {
      agents.push({ ...base, status: "clone-failed", changedFiles: 0, files: [] });
      f.notes.push(`agent ${k}: clone failed in ${!a.workspace ? A.label : B.label} (${a.cloneError ?? b.cloneError ?? "no workspace"})`);
      continue;
    }
    const files = compareWorkspaces(a.workspace, b.workspace, opts);
    const changed = files.filter((x) => x.status !== "identical");
    agents.push({ ...base, status: changed.length ? "changed" : "identical", changedFiles: changed.length, files: opts.includeDiffs === false ? changed.map(({ diff: _d, ...x }) => x) : changed });
    if (changed.length) f.drift.push(`agent ${k}: ${changed.length} file(s) differ (${changed.slice(0, 5).map((x) => x.path).join(", ")}${changed.length > 5 ? ", ..." : ""})`);
    if (base.authenticationMode.differs) f.drift.push(`agent ${k}: authentication mode ${base.authenticationMode.a} in ${A.label} vs ${base.authenticationMode.b} in ${B.label}`);
    for (const [label, st] of [[A.label, base.publish.a], [B.label, base.publish.b]] as const) {
      if (st?.unpublishedChanges) f.drift.push(`agent ${k}: unpublished changes in ${label} (modified ${st.modifiedOn}, published ${st.publishedOn ?? "never"})`);
    }
  }
  return agents;
}

function compareFlows(A: Snapshot, B: Snapshot, f: Findings): CompareReport["flows"] {
  if (!A.flows || !B.flows) return null;
  return mergeByKey(A.flows, B.flows, (x) => x.name).map(({ key: name, a: x, b: y }) => {
    const status = !x ? "only-in-b" : !y ? "only-in-a" : x.state !== y.state ? "state-differs" : "same";
    if (status !== "same") f.drift.push(`flow '${name}': ${status}${status === "state-differs" ? ` (${x?.state} vs ${y?.state})` : ""}`);
    return { name, status, stateA: x?.state ?? null, stateB: y?.state ?? null } as NonNullable<CompareReport["flows"]>[number];
  });
}

function compareConnectionReferences(A: Snapshot, B: Snapshot, f: Findings): CompareReport["connectionReferences"] {
  if (!A.connectionReferences || !B.connectionReferences) return null;
  return mergeByKey(A.connectionReferences, B.connectionReferences, (c) => c.logicalName).map(({ key: logicalName, a: x, b: y }) => {
    let status: NonNullable<CompareReport["connectionReferences"]>[number]["status"] = "same";
    if (!x) status = "only-in-b";
    else if (!y) status = "only-in-a";
    else if ((x.connectorId ?? "") !== (y.connectorId ?? "")) status = "connector-differs";
    else if (!x.connectionId && !y.connectionId) status = "unbound-in-both";
    else if (!x.connectionId) status = "unbound-in-a";
    else if (!y.connectionId) status = "unbound-in-b";
    if (status === "same" && x?.connectionId !== y?.connectionId) f.expected.push(`connection reference ${logicalName} is bound to different connections (by design)`);
    else if (status !== "same") f.drift.push(`connection reference ${logicalName}: ${status}`);
    return { logicalName, status, connectorA: x?.connectorId ?? null, connectorB: y?.connectorId ?? null };
  });
}

function compareEnvironmentVariables(A: Snapshot, B: Snapshot, opts: CompareOptions, f: Findings): CompareReport["environmentVariables"] {
  if (!A.environmentVariables || !B.environmentVariables) return null;
  return mergeByKey(A.environmentVariables, B.environmentVariables, (v) => v.schemaName).map(({ key: schemaName, a: x, b: y }) => {
    const valA = x ? (x.currentValue ?? x.defaultValue) : null;
    const valB = y ? (y.currentValue ?? y.defaultValue) : null;
    let status: NonNullable<CompareReport["environmentVariables"]>[number]["status"] = "same";
    if (!x) status = "only-in-b";
    else if (!y) status = "only-in-a";
    else if (!valB && valA) status = "no-value-in-b";
    else if (!valA && valB) status = "no-value-in-a";
    else if (valA !== valB) status = "value-differs";
    if (status === "value-differs") (opts.strictVariables ? f.drift : f.expected).push(`environment variable ${schemaName} differs (${valA} vs ${valB})`);
    else if (status !== "same") f.drift.push(`environment variable ${schemaName}: ${status}`);
    return { schemaName, status, valueA: valA, valueB: valB };
  });
}

export function compareSnapshots(dirA: string, dirB: string, opts: CompareOptions = {}): CompareReport {
  const A = readSnapshot(dirA);
  const B = readSnapshot(dirB);
  const f: Findings = { drift: [], expected: [], notes: [...A.notes.map((n) => `${A.label}: ${n}`), ...B.notes.map((n) => `${B.label}: ${n}`)] };

  const solutionStatus = compareSolution(A, B, f);
  const agents = compareAgents(A, B, opts, f);
  const flows = compareFlows(A, B, f);
  const connectionReferences = compareConnectionReferences(A, B, f);
  const environmentVariables = compareEnvironmentVariables(A, B, opts, f);

  return {
    a: { label: A.label, environment: A.environment, takenAt: A.takenAt },
    b: { label: B.label, environment: B.environment, takenAt: B.takenAt },
    solution: { name: A.solution ?? B.solution ?? null, a: A.solutionRow, b: B.solutionRow, status: solutionStatus },
    agents,
    flows,
    connectionReferences,
    environmentVariables,
    drift: f.drift.length > 0,
    driftSummary: f.drift,
    expectedDifferences: f.expected,
    notes: f.notes,
  };
}

/** Verdict, drift, expected differences, the solution table and the agent table. */
function summaryLines(r: CompareReport): string[] {
  const lines: string[] = [];
  lines.push(`# ${r.a.label} vs ${r.b.label}`, "", `- ${r.a.label}: environment ${r.a.environment}, snapshot ${r.a.takenAt}`, `- ${r.b.label}: environment ${r.b.environment}, snapshot ${r.b.takenAt}`, "", `**Verdict: ${r.drift ? "DRIFT" : "no drift"}**`, "");
  if (r.driftSummary.length) lines.push("## Drift", "", ...r.driftSummary.map((d) => `- ${d}`), "");
  if (r.expectedDifferences.length) lines.push("## Expected differences", "", ...r.expectedDifferences.map((d) => `- ${d}`), "");
  lines.push("## Solution", "", `| | ${r.a.label} | ${r.b.label} |`, "| --- | --- | --- |", `| version | ${r.solution.a?.version ?? "-"} | ${r.solution.b?.version ?? "-"} |`, `| managed | ${r.solution.a ? r.solution.a.isManaged : "-"} | ${r.solution.b ? r.solution.b.isManaged : "-"} |`, `| status | ${r.solution.status} | |`, "");
  lines.push("## Agents", "", "| agent | status | changed files | unpublished changes |", "| --- | --- | --- | --- |");
  for (const a of r.agents) lines.push(`| ${a.schemaName}${a.name ? ` (${a.name})` : ""} | ${a.status} | ${a.changedFiles} | ${r.a.label}: ${a.publish.a?.unpublishedChanges ?? "?"}, ${r.b.label}: ${a.publish.b?.unpublishedChanges ?? "?"} |`);
  lines.push("");
  return lines;
}

/** One section per agent that has file diffs. */
function diffLines(r: CompareReport): string[] {
  const lines: string[] = [];
  for (const a of r.agents) {
    const withDiff = a.files.filter((f) => f.diff);
    if (!withDiff.length) continue;
    lines.push(`### ${a.schemaName}`, "");
    for (const f of withDiff) lines.push(`#### ${f.path} (${f.status})`, "", "```diff", f.diff!.trimEnd(), "```", "");
  }
  return lines;
}

export function renderReportMarkdown(r: CompareReport): string {
  const lines: string[] = [...summaryLines(r), ...diffLines(r)];
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
export function compareChain(dirs: string[], opts: CompareOptions = {}): CompareReport[] {
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
