/**
 * Copilot Studio YAML authoring schema: lookup, search, resolve, and a
 * structural validator for workspace files. The schema file ships in
 * `reference/` (MIT, from microsoft/skills-for-copilot-studio).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Node = Record<string, unknown>;

export interface SchemaIndex {
  definitions: Record<string, Node>;
  kindToDefinition: Map<string, string>;
  kinds: string[];
}

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "reference", "bot.schema.yaml-authoring.json");

let cached: SchemaIndex | null = null;

export function schemaPath(): string {
  return SCHEMA_PATH;
}

export function loadSchema(): SchemaIndex {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as { definitions?: Record<string, Node> };
  const definitions = raw.definitions ?? {};
  const kindToDefinition = new Map<string, string>();
  for (const [name, def] of Object.entries(definitions)) {
    const props = def.properties as Node | undefined;
    const kindProp = props?.kind as Node | undefined;
    if (!kindProp) continue;
    const consts: string[] = [];
    if (typeof kindProp.const === "string") consts.push(kindProp.const);
    if (Array.isArray(kindProp.enum)) consts.push(...(kindProp.enum as string[]));
    for (const k of consts) {
      // Prefer the definition whose name equals the kind; otherwise first seen.
      if (!kindToDefinition.has(k) || name === k) kindToDefinition.set(k, name);
    }
  }
  cached = { definitions, kindToDefinition, kinds: [...kindToDefinition.keys()].sort() };
  return cached;
}

export function lookupDefinition(name: string): { name: string; definition: Node } | null {
  const { definitions } = loadSchema();
  if (definitions[name]) return { name, definition: definitions[name] };
  const lower = name.toLowerCase();
  for (const key of Object.keys(definitions)) {
    if (key.toLowerCase() === lower) return { name: key, definition: definitions[key] };
  }
  return null;
}

export function searchDefinitions(keyword: string, limit = 50): string[] {
  const { definitions } = loadSchema();
  const k = keyword.toLowerCase();
  return Object.keys(definitions)
    .filter((n) => n.toLowerCase().includes(k))
    .sort()
    .slice(0, limit);
}

export function listKinds(): string[] {
  return loadSchema().kinds;
}

export function definitionForKind(kind: string): Node | null {
  const { definitions, kindToDefinition } = loadSchema();
  const name = kindToDefinition.get(kind);
  return name ? definitions[name] : null;
}

function refName(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const prefix = "#/definitions/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

/** Inline `$ref`s up to `maxDepth`, marking cycles. */
export function resolveDefinition(name: string, maxDepth = 4): unknown {
  const found = lookupDefinition(name);
  if (!found) return { error: `Definition '${name}' not found` };
  const { definitions } = loadSchema();
  const walk = (node: unknown, depth: number, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, depth, seen));
    if (!node || typeof node !== "object") return node;
    const obj = node as Node;
    const ref = refName(obj.$ref);
    if (ref && Object.keys(obj).length === 1) {
      if (seen.has(ref)) return { $ref: ref, note: "cycle" };
      if (depth >= maxDepth) return { $ref: ref, note: "depth limit" };
      const target = definitions[ref];
      if (!target) return { $ref: ref, note: "missing" };
      return walk(target, depth + 1, new Set([...seen, ref]));
    }
    const out: Node = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "title" || k === "description") continue; // localisation keys, no value
      out[k] = walk(v, depth, seen);
    }
    return out;
  };
  return walk(found.definition, 0, new Set([found.name]));
}

/** Compact one-screen description of a definition: properties, required, oneOf kinds. */
export function summarizeDefinition(name: string): string {
  const found = lookupDefinition(name);
  if (!found) {
    const similar = searchDefinitions(name, 10);
    return `Definition '${name}' not found.${similar.length ? ` Similar: ${similar.join(", ")}` : ""}`;
  }
  const def = found.definition;
  const lines = [`Definition: ${found.name}`];
  const props = def.properties as Record<string, Node> | undefined;
  if (props) {
    lines.push("Properties:");
    for (const [p, pd] of Object.entries(props)) {
      let type = (pd.type as string | undefined) ?? "";
      const r = refName(pd.$ref);
      if (r) type = r;
      if (typeof pd.const === "string") type = `const ${pd.const}`;
      if (Array.isArray(pd.oneOf)) type = `oneOf(${(pd.oneOf as Node[]).map((o) => refName(o.$ref) ?? (o.type as string) ?? "?").join("|")})`;
      const items = pd.items as Node | undefined;
      if (type === "array" && items) type = `array<${refName(items.$ref) ?? (items.type as string) ?? "?"}>`;
      const def_ = pd.default !== undefined ? ` (default ${JSON.stringify(pd.default)})` : "";
      lines.push(`  - ${p}: ${type}${def_}`);
    }
  }
  if (Array.isArray(def.required)) lines.push(`Required: ${(def.required as string[]).join(", ")}`);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = def[key] as Node[] | undefined;
    if (arr) lines.push(`${key}: ${arr.map((o) => refName(o.$ref) ?? (o.type as string) ?? JSON.stringify(o).slice(0, 40)).join(", ")}`);
  }
  return lines.join("\n");
}

/** Kind constants reachable from a oneOf definition such as DialogAction or TaskAction. */
export function validKindsFromOneOf(definitionName: string): string[] {
  const { definitions } = loadSchema();
  const def = definitions[definitionName];
  const oneOf = def?.oneOf as Node[] | undefined;
  if (!oneOf) return [];
  const kinds: string[] = [];
  for (const entry of oneOf) {
    const r = refName(entry.$ref);
    const target = r ? definitions[r] : entry;
    const kindProp = (target?.properties as Node | undefined)?.kind as Node | undefined;
    if (typeof kindProp?.const === "string") kinds.push(kindProp.const);
    if (Array.isArray(kindProp?.enum)) kinds.push(...(kindProp.enum as string[]));
    // Nested oneOf (e.g. MessageOptionalKind inside ActivityTemplateBase)
    if (target?.oneOf && r) kinds.push(...validKindsFromOneOf(r));
  }
  return kinds;
}

/** Property names of a definition, unioned across oneOf variants. */
export function validProperties(definitionName: string): Set<string> {
  const { definitions } = loadSchema();
  const def = definitions[definitionName];
  const out = new Set<string>();
  if (!def) return out;
  const props = def.properties as Node | undefined;
  if (props) for (const k of Object.keys(props)) out.add(k);
  const oneOf = def.oneOf as Node[] | undefined;
  if (oneOf) {
    for (const entry of oneOf) {
      const r = refName(entry.$ref);
      if (r) for (const k of validProperties(r)) out.add(k);
      const p = entry.properties as Node | undefined;
      if (p) for (const k of Object.keys(p)) out.add(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export { validateDocument, type Diagnostic } from "./schemaValidate.js";
