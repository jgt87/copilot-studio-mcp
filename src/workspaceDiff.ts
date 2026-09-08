/**
 * Comparing two agent workspaces file by file.
 *
 * YAML is normalised before it is compared (audit stamps, ids and connection
 * bindings dropped, keys sorted), so two environments that hold the same agent
 * compare equal even though their rows differ. Text files are compared as
 * text, everything else by hash.
 *
 * Used by the snapshot comparison (`compareReport.ts`) and by drift detection
 * (`drift.ts`), which needs the fingerprints rather than the diffs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { createTwoFilesPatch } from "diff";

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
