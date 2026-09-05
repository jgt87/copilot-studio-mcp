/**
 * Shared helpers for the authoring layer: ids, naming, YAML read/write.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as yaml from "js-yaml";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DIACRITICS = /[̀-ͯ]/g;

/** Random node id in the style Copilot Studio uses: `sendMessage_Ab3xQ9`. */
export function newId(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return `${prefix}_${out}`;
}

/** kebab-case file stem from a display name: "Order Status FAQ" -> "order-status-faq". */
export function kebab(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(DIACRITICS, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "component"
  );
}

/** PascalCase identifier from a display name: "Order Status FAQ" -> "OrderStatusFAQ". */
export function pascal(name: string): string {
  const parts = name.normalize("NFKD").replace(DIACRITICS, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return out || "Component";
}

/** Power Fx string literal. */
export function pfxString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function yamlDump(doc: unknown): string {
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false });
}

export function readYamlFile<T = unknown>(file: string): T {
  return yaml.load(fs.readFileSync(file, "utf8")) as T;
}

export interface WriteOptions {
  overwrite?: boolean;
}

/**
 * Write a component file: optional `# comment` header lines, then the YAML
 * body. Refuses to overwrite an existing file unless asked.
 */
export function writeComponentFile(file: string, headerLines: string[], doc: unknown, opts: WriteOptions = {}): string {
  if (fs.existsSync(file) && !opts.overwrite) {
    throw new Error(`Refusing to overwrite existing file ${file} (pass overwrite: true)`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = headerLines.filter((l) => l.trim().length > 0).map((l) => `# ${l.replace(/\r?\n/g, " ")}`);
  const body = yamlDump(doc);
  fs.writeFileSync(file, (header.length ? header.join("\n") + "\n" : "") + body, "utf8");
  return file;
}

/** Component name from `# Name:` header, else `mcs.metadata.componentName`, else file stem. */
export function componentNameFromText(text: string, doc: unknown, file: string): string {
  const m = /^#\s*Name:\s*(.+?)\s*$/m.exec(text);
  if (m) return m[1];
  const meta = (doc as { "mcs.metadata"?: { componentName?: string } } | null)?.["mcs.metadata"];
  if (meta?.componentName) return meta.componentName;
  return fileStem(file);
}

/** Description from `mcs.metadata.description`, else the second `#` header line. */
export function componentDescriptionFromText(text: string, doc: unknown): string | null {
  const meta = (doc as { "mcs.metadata"?: { description?: string } } | null)?.["mcs.metadata"];
  if (meta?.description) return meta.description;
  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("#")) break;
    header.push(line.replace(/^#\s?/, ""));
  }
  const desc = header.filter((l) => !/^\s*(Name|Template|NOTE|Description)\s*:/i.test(l) && l.trim().length > 0);
  const explicit = header.find((l) => /^\s*Description\s*:/i.test(l));
  if (explicit) return explicit.replace(/^\s*Description\s*:\s*/i, "").trim();
  return desc[0]?.trim() ?? null;
}

/** `orders.topic.mcs.yml` -> `orders`; `orders.mcs.yaml` -> `orders`. */
export function fileStem(file: string): string {
  return path
    .basename(file)
    .replace(/\.(topic|knowledge|variable|trigger|action|tool)\.mcs\.ya?ml$/i, "")
    .replace(/\.mcs\.ya?ml$/i, "")
    .replace(/\.ya?ml$/i, "");
}

export function isYamlFile(file: string): boolean {
  return /\.ya?ml$/i.test(file);
}

export function listFilesRecursive(dir: string, predicate: (f: string) => boolean, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (predicate(full)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}
