/**
 * Portal drift: changes made directly in Copilot Studio after the workspace
 * was last synced, detected with or without a clone.
 *
 * 1. Stamp: `.mcs/cs-sync.json`, written after clone / pull / push / init.
 *    Holds a fingerprint per workspace file and, when Dataverse was reachable,
 *    the modification stamp of every bot component. `.mcs/` is skipped by
 *    `pac copilot pack` (verified with 2.11.2); a dotfile at the root is not.
 * 2. Quick check: one Dataverse read of the bot row and its components,
 *    compared with the stamp. Says which components changed, by whom, when,
 *    and whether the agent has unpublished changes. Seconds, no pac.
 * 3. Full check: `pac copilot clone` into a temporary folder and a three-way
 *    classification of every file (local, remote, both) against the stamp.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { compareWorkspaces, workspaceFingerprints } from "./compare.js";
import { explainFailure, runPac } from "./pac.js";
import { findWorkspaceRoot, type ComponentInfo, type WorkspaceInfo } from "./workspace.js";
import type { BotComponentRow, BotDetails } from "./cloud/dataverse.js";
import { fileStem } from "./authoring/util.js";

export const STAMP_REL = ".mcs/cs-sync.json";
export type SyncOperation = "clone" | "pull" | "push" | "init";

export interface RemoteComponentStamp {
  name: string;
  type: string | null;
  modifiedOn: string | null;
}

export interface RemoteState {
  botModifiedOn: string | null;
  botPublishedOn: string | null;
  /** Keyed by component schema name (component id when the row has none). */
  components: Record<string, RemoteComponentStamp>;
}

export interface SyncStamp {
  version: 1;
  operation: SyncOperation;
  syncedAt: string;
  botId: string | null;
  environmentId: string | null;
  /** Fingerprint per file right after the sync (see workspaceFingerprints). */
  files: Record<string, string>;
  /** Remote component stamps at sync time; null when Dataverse was not reachable. */
  remote: RemoteState | null;
}

// ---------------------------------------------------------------------------
// Stamp
// ---------------------------------------------------------------------------

export function stampPath(root: string): string {
  return path.join(root, ".mcs", "cs-sync.json");
}

export function readStamp(root: string): SyncStamp | null {
  const file = stampPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as SyncStamp | null;
    const wellFormed = s?.version === 1 && typeof s.files === "object" && s.files !== null;
    return wellFormed ? s : null;
  } catch {
    return null;
  }
}

export function writeStamp(root: string, o: { operation: SyncOperation; botId?: string | null; environmentId?: string | null; remote?: RemoteState | null; now?: Date }): SyncStamp {
  const stamp: SyncStamp = {
    version: 1,
    operation: o.operation,
    syncedAt: (o.now ?? new Date()).toISOString(),
    botId: o.botId ?? null,
    environmentId: o.environmentId ?? null,
    files: workspaceFingerprints(root),
    remote: o.remote ?? null,
  };
  fs.mkdirSync(path.dirname(stampPath(root)), { recursive: true });
  fs.writeFileSync(stampPath(root), JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

export function componentKey(c: BotComponentRow): string {
  return c.schemaName ?? c.componentId;
}

function typeLabel(c: BotComponentRow): string | null {
  return c.componentTypeLabel ?? (c.componentType === null ? null : String(c.componentType));
}

export function remoteStateFrom(bot: BotDetails | null, components: BotComponentRow[]): RemoteState {
  const map: Record<string, RemoteComponentStamp> = {};
  for (const c of components) map[componentKey(c)] = { name: c.name, type: typeLabel(c), modifiedOn: c.modifiedOn };
  return { botModifiedOn: bot?.modifiedOn ?? null, botPublishedOn: bot?.publishedOn ?? null, components: map };
}

/** Files whose fingerprint differs from the stamp (added, modified or deleted locally). */
export function localChanges(stamp: SyncStamp | null, local: Record<string, string>): string[] {
  if (!stamp) return [];
  const paths = new Set([...Object.keys(local), ...Object.keys(stamp.files)]);
  return [...paths].filter((p) => local[p] !== stamp.files[p]).sort();
}

// ---------------------------------------------------------------------------
// File classification (three-way against the stamp)
// ---------------------------------------------------------------------------

export type FileStatus =
  | "local-modified"
  | "remote-modified"
  | "both-modified"
  | "both-modified-same"
  | "local-added"
  | "remote-added"
  | "both-added"
  | "local-deleted"
  | "remote-deleted"
  | "differs"
  | "only-local"
  | "only-remote";

export interface FileDrift {
  path: string;
  status: FileStatus;
  /** Local and remote both diverged from the stamp in different ways. */
  conflict: boolean;
  diff?: string;
}

/**
 * Classify every file by comparing local and remote fingerprints with the
 * stamp taken at the last sync. Without a stamp only two-way statuses are
 * possible (differs / only-local / only-remote) and nothing is a conflict.
 * Unchanged files are omitted. "both-modified" also covers delete-versus-edit.
 */
export function classifyFiles(stamp: SyncStamp | null, local: Record<string, string>, remote: Record<string, string>, diffs?: Map<string, string>): FileDrift[] {
  const out: FileDrift[] = [];
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(stamp?.files ?? {})]);
  for (const p of [...paths].sort()) {
    const c = classifyOne(Boolean(stamp), local[p], remote[p], stamp?.files[p]);
    if (!c) continue;
    const diff = diffs?.get(p);
    out.push({ path: p, ...c, ...(diff ? { diff } : {}) });
  }
  return out;
}

type Verdict = { status: FileStatus; conflict: boolean };

/** One file: local (l) and remote (r) fingerprints against the stamp base (b); null when unchanged. */
function classifyOne(hasStamp: boolean, l: string | undefined, r: string | undefined, b: string | undefined): Verdict | null {
  if (!hasStamp) {
    if (l === r) return null;
    return { status: l === undefined ? "only-remote" : r === undefined ? "only-local" : "differs", conflict: false };
  }
  if (l === r) return l === undefined || b === l ? null : { status: "both-modified-same", conflict: false };
  if (b === undefined) {
    const status: FileStatus = l === undefined ? "remote-added" : r === undefined ? "local-added" : "both-added";
    return { status, conflict: status === "both-added" };
  }
  if (l === b) return { status: r === undefined ? "remote-deleted" : "remote-modified", conflict: false };
  if (r === b) return { status: l === undefined ? "local-deleted" : "local-modified", conflict: false };
  return { status: "both-modified", conflict: true };
}

// ---------------------------------------------------------------------------
// Component to file mapping
// ---------------------------------------------------------------------------

/**
 * Map a Dataverse component schema name (`<agentSchema>.<kind>.<Stem>`) to the
 * workspace file with that stem. The kind segment picks the folder when it is
 * one we know; otherwise every component folder is searched.
 */
export function componentFileFor(ws: WorkspaceInfo, schemaName: string | null): string | null {
  if (!schemaName) return null;
  const m = /^(.+)\.([a-z0-9]+)\.([^.]+)$/i.exec(schemaName);
  if (!m) return null;
  const kind = m[2].toLowerCase();
  const stem = m[3];
  const pools: Record<string, ComponentInfo[]> = {
    topic: ws.topics,
    knowledge: ws.knowledge,
    action: ws.actions,
    tool: ws.actions,
    trigger: ws.triggers,
    globalvariable: ws.variables,
    variable: ws.variables,
  };
  const all = [...ws.topics, ...ws.knowledge, ...ws.actions, ...ws.triggers, ...ws.variables];
  const pool = pools[kind] ?? all;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit =
    pool.find((c) => fileStem(c.file).toLowerCase() === stem.toLowerCase()) ??
    pool.find((c) => norm(fileStem(c.file)) === norm(stem)) ??
    pool.find((c) => norm(c.name) === norm(stem)) ??
    (pool === all ? null : all.find((c) => norm(fileStem(c.file)) === norm(stem)));
  return hit?.relPath ?? null;
}

// ---------------------------------------------------------------------------
// Quick check (Dataverse rows against the stamp)
// ---------------------------------------------------------------------------

export interface ComponentDrift {
  key: string;
  name: string;
  type: string | null;
  status: "modified" | "added" | "removed";
  modifiedOn: string | null;
  modifiedBy: string | null;
  /** Workspace file the component maps to, when found. */
  file: string | null;
  /** That file also changed locally since the stamp. */
  localModified: boolean;
  conflict: boolean;
}

export interface QuickDriftReport {
  /** components: per-component stamps recorded at sync; syncedAt: only the sync time; none: no stamp. */
  baseline: "components" | "syncedAt" | "none";
  syncedAt: string | null;
  lastOperation: SyncOperation | null;
  bot: {
    modifiedOn: string | null;
    modifiedBy: string | null;
    publishedOn: string | null;
    /** Bot row (settings, instructions) changed since the stamp; null when unknown. */
    settingsChanged: boolean | null;
    /** Something changed after the last publish; null when never published. */
    unpublishedChanges: boolean | null;
  };
  components: ComponentDrift[];
  conflicts: ComponentDrift[];
  localChanges: string[];
  remoteComponentCount: number;
  summary: string;
}

/** Clock tolerance for comparing server stamps with the local sync time. */
const SKEW_MS = 2 * 60_000;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Server stamp clearly later than the local sync time (skew-tolerant, biased against false positives). */
function laterThanSync(iso: string | null, syncedAt: string): boolean {
  const a = parse(iso);
  const b = parse(syncedAt);
  return a !== null && b !== null && a > b + SKEW_MS;
}

type Baseline = QuickDriftReport["baseline"];

/** Status of one remote component against the stamp; null when unchanged or undatable. */
function componentStatus(baseline: Baseline, stamp: SyncStamp | null, c: BotComponentRow): ComponentDrift["status"] | null {
  if (baseline === "components") {
    const prev = stamp?.remote?.components[componentKey(c)];
    if (!prev) return "added";
    return (prev.modifiedOn ?? null) !== (c.modifiedOn ?? null) ? "modified" : null;
  }
  if (baseline === "syncedAt" && stamp && laterThanSync(c.modifiedOn, stamp.syncedAt)) return "modified";
  return null;
}

function settingsChangedSince(baseline: Baseline, stamp: SyncStamp | null, botModifiedOn: string | null): boolean | null {
  if (!stamp) return null;
  if (baseline === "components") return (stamp.remote?.botModifiedOn ?? null) !== botModifiedOn;
  return laterThanSync(botModifiedOn, stamp.syncedAt);
}

/** True when the bot row or any component was modified after the last publish; null when never published. */
function unpublishedSince(bot: BotDetails | null, components: BotComponentRow[]): boolean | null {
  const published = parse(bot?.publishedOn ?? null);
  if (published === null) return null;
  const stamps = [bot?.modifiedOn ?? null, ...components.map((c) => c.modifiedOn)].map(parse).filter((t): t is number => t !== null);
  return stamps.some((t) => t > published);
}

function describeQuick(stamp: SyncStamp | null, components: ComponentDrift[], conflicts: ComponentDrift[], settingsChanged: boolean | null, localCount: number, unpublished: boolean | null): string {
  const parts: string[] = [];
  if (!stamp) parts.push("No sync stamp: run cs_pull (or clone again) to establish a baseline; component changes cannot be dated against it.");
  else if (components.length === 0 && !settingsChanged) parts.push(`No portal changes since the last ${stamp.operation} at ${stamp.syncedAt}.`);
  else {
    const by = (s: ComponentDrift["status"]) => components.filter((c) => c.status === s).length;
    parts.push(`${by("modified")} modified, ${by("added")} added, ${by("removed")} removed component(s) in Copilot Studio since the last ${stamp.operation} at ${stamp.syncedAt}${settingsChanged ? "; agent settings changed too" : ""}.`);
  }
  if (conflicts.length) parts.push(`${conflicts.length} of them also changed locally (conflict): ${conflicts.map((c) => c.name).join(", ")}. Run cs_pull before pushing.`);
  else if (components.length) parts.push("None of them changed locally; cs_pull will merge them cleanly.");
  if (localCount) parts.push(`${localCount} local file(s) changed since the stamp.`);
  if (unpublished) parts.push("The live agent has unpublished changes.");
  return parts.join(" ");
}

export function quickDrift(o: { ws: WorkspaceInfo; stamp: SyncStamp | null; bot: BotDetails | null; components: BotComponentRow[]; localFingerprints?: Record<string, string> }): QuickDriftReport {
  const { ws, stamp } = o;
  const local = o.localFingerprints ?? workspaceFingerprints(ws.root);
  const changedLocally = localChanges(stamp, local);
  const baseline: Baseline = stamp?.remote ? "components" : stamp ? "syncedAt" : "none";
  const entry = (key: string, name: string, type: string | null, status: ComponentDrift["status"], modifiedOn: string | null, modifiedBy: string | null): ComponentDrift => {
    const file = componentFileFor(ws, key.includes(".") ? key : null);
    const localModified = file ? changedLocally.includes(file) : false;
    return { key, name, type, status, modifiedOn, modifiedBy, file, localModified, conflict: localModified };
  };

  const components: ComponentDrift[] = [];
  const seen = new Set<string>();
  for (const c of o.components) {
    const key = componentKey(c);
    seen.add(key);
    const status = componentStatus(baseline, stamp, c);
    if (status) components.push(entry(key, c.name, typeLabel(c), status, c.modifiedOn, c.modifiedBy));
  }
  if (baseline === "components") {
    for (const [key, prev] of Object.entries(stamp?.remote?.components ?? {})) {
      if (!seen.has(key)) components.push(entry(key, prev.name, prev.type, "removed", prev.modifiedOn, null));
    }
  }

  const botModifiedOn = o.bot?.modifiedOn ?? null;
  const settingsChanged = settingsChangedSince(baseline, stamp, botModifiedOn);
  const unpublishedChanges = unpublishedSince(o.bot, o.components);
  const conflicts = components.filter((c) => c.conflict);
  return {
    baseline,
    syncedAt: stamp?.syncedAt ?? null,
    lastOperation: stamp?.operation ?? null,
    bot: { modifiedOn: botModifiedOn, modifiedBy: o.bot?.modifiedBy ?? null, publishedOn: o.bot?.publishedOn ?? null, settingsChanged, unpublishedChanges },
    components,
    conflicts,
    localChanges: changedLocally,
    remoteComponentCount: o.components.length,
    summary: describeQuick(stamp, components, conflicts, settingsChanged, changedLocally.length, unpublishedChanges),
  };
}

/** Compact form for tool results that embed the report (push dry run). */
export function briefQuick(r: QuickDriftReport): Record<string, unknown> {
  return {
    baseline: r.baseline,
    summary: r.summary,
    settingsChanged: r.bot.settingsChanged,
    unpublishedChanges: r.bot.unpublishedChanges,
    changes: r.components.map((c) => ({ status: c.status, name: c.name, type: c.type, modifiedOn: c.modifiedOn, modifiedBy: c.modifiedBy, file: c.file, conflict: c.conflict })),
    localChanges: r.localChanges.length,
  };
}

// ---------------------------------------------------------------------------
// Full check (clone and compare)
// ---------------------------------------------------------------------------

export interface FullDriftReport {
  baseline: "stamp" | "none";
  syncedAt: string | null;
  /** Path of the clone when kept; null when it was removed. */
  remoteRoot: string | null;
  files: FileDrift[];
  conflicts: FileDrift[];
  counts: Record<string, number>;
  localChanges: string[];
  summary: string;
  notes: string[];
}

/** Classify the workspace against an already-cloned copy of the live agent. */
export function compareWithClone(root: string, remoteRoot: string, opts: { stamp?: SyncStamp | null; includeDiffs?: boolean } = {}): FullDriftReport {
  const stamp = opts.stamp === undefined ? readStamp(root) : opts.stamp;
  const local = workspaceFingerprints(root);
  const remote = workspaceFingerprints(remoteRoot);
  const diffs = new Map<string, string>();
  if (opts.includeDiffs !== false) {
    for (const f of compareWorkspaces(root, remoteRoot, { includeDiffs: true })) if (f.diff) diffs.set(f.path, f.diff);
  }
  const files = classifyFiles(stamp, local, remote, diffs);
  const counts: Record<string, number> = {};
  for (const f of files) counts[f.status] = (counts[f.status] ?? 0) + 1;
  const conflicts = files.filter((f) => f.conflict);
  const remoteSide = files.filter((f) => /^(remote-|both-|only-remote|differs)/.test(f.status) && f.status !== "both-modified-same");
  const parts: string[] = [];
  if (!stamp) parts.push("No sync stamp: two-way comparison only (local versus live); run cs_pull to record a baseline.");
  if (files.length === 0) parts.push("Workspace and live agent are identical.");
  else {
    parts.push(`${files.length} file(s) differ: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    if (stamp && remoteSide.length) parts.push(`${remoteSide.length} changed in Copilot Studio since the last ${stamp.operation}.`);
    if (conflicts.length) parts.push(`${conflicts.length} conflict(s): ${conflicts.map((f) => f.path).join(", ")}. Run cs_pull (three-way merge) before pushing.`);
  }
  return { baseline: stamp ? "stamp" : "none", syncedAt: stamp?.syncedAt ?? null, remoteRoot, files, conflicts, counts, localChanges: localChanges(stamp, local), summary: parts.join(" "), notes: [] };
}

export async function fullDrift(o: { root: string; botId: string; environment?: string | null; includeDiffs?: boolean; keepClone?: boolean; cloneDir?: string }): Promise<FullDriftReport> {
  const cloneDir = o.cloneDir ? path.resolve(o.cloneDir) : fs.mkdtempSync(path.join(os.tmpdir(), "cs-mcp-drift-"));
  fs.mkdirSync(cloneDir, { recursive: true });
  const cleanup = () => {
    if (!o.keepClone) fs.rmSync(cloneDir, { recursive: true, force: true, maxRetries: 3 });
  };
  const args = ["copilot", "clone", "--bot", o.botId, "--output-dir", cloneDir];
  if (o.environment) args.push("--environment", o.environment);
  const r = await runPac(args, { timeoutMs: 15 * 60_000 });
  if (!r.ok) {
    cleanup();
    throw new Error(`pac copilot clone failed: ${explainFailure(r)}`);
  }
  const remoteRoot = findWorkspaceRoot(cloneDir);
  if (!remoteRoot) {
    cleanup();
    throw new Error(`pac copilot clone produced no workspace under ${cloneDir}`);
  }
  const report = compareWithClone(o.root, remoteRoot, { includeDiffs: o.includeDiffs });
  if (o.keepClone) return report;
  cleanup();
  return { ...report, remoteRoot: null, notes: [...report.notes, "temporary clone removed (pass keepClone: true to inspect it)"] };
}

// ---------------------------------------------------------------------------
// Git ledger
// ---------------------------------------------------------------------------

export interface GitState {
  repo: boolean;
  branch: string | null;
  /** Files under the workspace with uncommitted changes. */
  dirty: number;
}

/** Whether the workspace is in a git repository and how many of its files are uncommitted; null when git is unavailable. */
export function gitState(root: string): Promise<GitState | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "status", "--porcelain", "--branch", "--", "."], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(/not a git repository/i.test(String(err.message)) ? { repo: false, branch: null, dirty: 0 } : null);
        return;
      }
      const lines = String(stdout).split(/\r?\n/).filter(Boolean);
      const head = lines[0]?.startsWith("##") ? lines.shift()!.slice(3) : null;
      resolve({ repo: true, branch: head ? head.split("...")[0] : null, dirty: lines.length });
    });
  });
}
