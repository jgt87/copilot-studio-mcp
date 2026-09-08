/**
 * Knowledge sources as YAML (`knowledge/<name>.knowledge.mcs.yml`) or files
 * dropped into `knowledge/files/` for upload on the next push.
 */
import fs from "node:fs";
import path from "node:path";
import { pascal, writeComponentFile } from "./util.js";

export type KnowledgeKind = "public-site" | "sharepoint" | "graph-connector" | "files";

export interface KnowledgeSpec {
  name: string;
  description?: string;
  kind: KnowledgeKind;
  /** public-site / sharepoint: the URL (SharePoint must be a direct folder path, spaces as %20). */
  site?: string;
  includeSubPages?: boolean;
  /** graph-connector */
  connectionEnvironmentVariable?: string;
  connectionName?: string;
  contentSourceDisplayName?: string;
  /** files: absolute paths to copy into knowledge/files */
  files?: string[];
  triggerCondition?: string;
  additionalSearchTerms?: string;
  overwrite?: boolean;
}

export interface KnowledgeResult {
  files: string[];
  note: string;
  portalStep: string | null;
}

/** Normalise a SharePoint URL: AllItems.aspx?id=... becomes the direct folder path. */
export function normalizeSharePointUrl(url: string): { url: string; note: string | null } {
  try {
    const u = new URL(url);
    if (/\/:[a-z]:\//i.test(u.pathname)) {
      return { url, note: "This looks like a SharePoint sharing link; Copilot Studio needs the folder URL from the address bar instead." };
    }
    const id = u.searchParams.get("id");
    if (/AllItems\.aspx$/i.test(u.pathname) && id) {
      const decoded = decodeURIComponent(id);
      const encoded = decoded.split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return { url: `${u.origin}${encoded}`, note: "Converted AllItems.aspx link to a direct folder URL." };
    }
    const cleaned = `${u.origin}${u.pathname}`.replace(/ /g, "%20");
    return { url: cleaned, note: cleaned !== url ? "Dropped query string / encoded spaces." : null };
  } catch {
    return { url, note: null };
  }
}

/**
 * Uploaded documents: copied into `knowledge/files`, which push uploads as
 * agent knowledge. Nothing is parsed and no YAML is written.
 */
function copyKnowledgeFiles(root: string, spec: KnowledgeSpec): string[] {
  const files = spec.files ?? [];
  if (files.length === 0) throw new Error("kind 'files' needs at least one file path");
  const dest = path.join(root, "knowledge", "files");
  fs.mkdirSync(dest, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
    const target = path.join(dest, path.basename(f));
    if (fs.existsSync(target) && !spec.overwrite) throw new Error(`Refusing to overwrite ${target} (pass overwrite: true)`);
    fs.copyFileSync(f, target);
    written.push(target);
  }
  return written;
}

/**
 * The `source` block of the component, one shape per kind, plus the options
 * that apply to all of them. Anything the caller should know (a rewritten
 * SharePoint URL, a path too deep for Bing, the Graph connector's own setup)
 * is appended to `notes`.
 */
function buildSource(spec: KnowledgeSpec, notes: string[]): Record<string, unknown> {
  const source = sourceForKind(spec, notes);
  if (spec.triggerCondition) source.triggerCondition = spec.triggerCondition.startsWith("=") ? spec.triggerCondition : `=${spec.triggerCondition}`;
  if (spec.additionalSearchTerms && spec.kind !== "public-site") source.additionalSearchTerms = spec.additionalSearchTerms;
  return source;
}

function sourceForKind(spec: KnowledgeSpec, notes: string[]): Record<string, unknown> {
  if (spec.kind === "public-site") {
    if (!spec.site) throw new Error("public-site needs 'site'");
    const u = new URL(spec.site);
    const depth = u.pathname.split("/").filter(Boolean).length;
    if (depth > 2) notes.push("Public sites support at most 2 path levels below the domain; deeper paths are ignored by Bing search.");
    return { kind: "PublicSiteSearchSource", site: spec.site, ...(spec.includeSubPages === false ? { includeSubPages: false } : {}) };
  }
  if (spec.kind === "sharepoint") {
    if (!spec.site) throw new Error("sharepoint needs 'site'");
    const norm = normalizeSharePointUrl(spec.site);
    if (norm.note) notes.push(norm.note);
    return { kind: "SharePointSearchSource", site: norm.url };
  }
  if (spec.kind === "graph-connector") {
    if (!spec.connectionEnvironmentVariable || !spec.connectionName) {
      throw new Error("graph-connector needs 'connectionEnvironmentVariable' (env var schema name holding the connection id) and 'connectionName'");
    }
    notes.push("The Graph connector must be registered in the M365 admin center and its connection id stored in the named environment variable.");
    return {
      kind: "GraphConnectorSearchSource",
      connectionId: { schemaName: spec.connectionEnvironmentVariable },
      connectionName: spec.connectionName,
      ...(spec.contentSourceDisplayName ? { contentSourceDisplayName: spec.contentSourceDisplayName } : {}),
    };
  }
  throw new Error(`Unsupported knowledge kind '${String(spec.kind)}'. Dataverse, AI Search, SQL and uploaded files are configured in the portal.`);
}

export function addKnowledgeSource(root: string, spec: KnowledgeSpec): KnowledgeResult {
  if (spec.kind === "files") {
    return {
      files: copyKnowledgeFiles(root, spec),
      note: "Files placed in knowledge/files are uploaded as agent knowledge on the next push (VS Code extension or pac copilot push).",
      portalStep: null,
    };
  }

  const notes: string[] = [];
  const source = buildSource(spec, notes);
  const header = [`Name: ${spec.name}`, spec.description ?? `Knowledge source: ${spec.name}`];
  const meta = { componentName: spec.name, ...(spec.description ? { description: spec.description } : {}) };
  const doc = { "mcs.metadata": meta, kind: "KnowledgeSourceConfiguration", source };
  const file = writeComponentFile(path.join(root, "knowledge", `${pascal(spec.name)}.mcs.yml`), header, doc, { overwrite: spec.overwrite });
  return {
    files: [file],
    note: [`Wrote ${path.relative(root, file)}.`, ...notes, "Push the workspace to apply."].join(" "),
    portalStep: null,
  };
}
