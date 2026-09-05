/**
 * Copilot Studio YAML authoring schema: lookup, search, resolve, and a
 * structural validator for workspace files. The schema file ships in
 * `reference/` (MIT, from microsoft/skills-for-copilot-studio).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Node = Record<string, unknown>;

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

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
}

const IGNORED_ROOT_KEYS = new Set(["mcs.metadata"]);
const VARIABLE_SCOPES = ["Topic.", "System.", "Global.", "User.", "Env."];

function isObject(v: unknown): v is Node {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Properties the product accepts but the published schema omits. Root-level
 * unknowns are reported as warnings (the schema lags the product); unknowns
 * inside dialog actions are errors (that part of the schema is reliable).
 */
const TOLERATED_PROPS: Record<string, string[]> = { GptComponentMetadata: ["displayName", "description", "modelDescription"] };

function checkUnknownProps(obj: Node, definitionName: string, atPath: string, out: Diagnostic[], ignore: Set<string> = new Set(), unknownSeverity: Diagnostic["severity"] = "error"): void {
  const def = loadSchema().definitions[definitionName];
  if (!def || def.additionalProperties !== false || !def.properties) return;
  const allowed = validProperties(definitionName);
  const tolerated = new Set(TOLERATED_PROPS[definitionName] ?? []);
  for (const key of Object.keys(obj)) {
    if (ignore.has(key) || allowed.has(key) || tolerated.has(key)) continue;
    out.push({ severity: unknownSeverity, message: `Unknown property '${key}' for ${definitionName}`, path: atPath });
  }
  const required = (def.required as string[] | undefined) ?? [];
  for (const r of required) {
    if (obj[r] === undefined) out.push({ severity: "error", message: `Missing required property '${r}' for ${definitionName}`, path: atPath });
  }
}

function validateActions(actions: unknown, atPath: string, out: Diagnostic[], validActionKinds: string[]): void {
  if (!Array.isArray(actions)) return;
  actions.forEach((action, i) => {
    const p = `${atPath}[${i}]`;
    if (!isObject(action)) {
      out.push({ severity: "error", message: "Action must be a mapping", path: p });
      return;
    }
    const kind = action.kind;
    if (typeof kind !== "string") {
      out.push({ severity: "error", message: "Action is missing 'kind'", path: p });
      return;
    }
    if (validActionKinds.length && !validActionKinds.includes(kind)) {
      out.push({ severity: "error", message: `'${kind}' is not a valid action kind (see DialogAction)`, path: p });
      return;
    }
    const defName = loadSchema().kindToDefinition.get(kind);
    if (defName) checkUnknownProps(action, defName, p, out);
    // Recurse into nested action containers.
    if (action.actions) validateActions(action.actions, `${p}.actions`, out, validActionKinds);
    if (action.elseActions) validateActions(action.elseActions, `${p}.elseActions`, out, validActionKinds);
    if (Array.isArray(action.conditions)) {
      (action.conditions as unknown[]).forEach((c, ci) => {
        if (isObject(c)) {
          checkUnknownProps(c, "ConditionItemNoKind", `${p}.conditions[${ci}]`, out);
          validateActions(c.actions, `${p}.conditions[${ci}].actions`, out, validActionKinds);
        }
      });
    }
  });
}

function collect(obj: unknown, visit: (node: Node, atPath: string) => void, atPath = "$"): void {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collect(v, visit, `${atPath}[${i}]`));
    return;
  }
  if (!isObject(obj)) return;
  visit(obj, atPath);
  for (const [k, v] of Object.entries(obj)) collect(v, visit, `${atPath}.${k}`);
}

/**
 * Structural validation of one parsed YAML document. Mirrors the checks in
 * Microsoft's schema-lookup script and adds unknown-property detection for
 * every kind the schema knows.
 */
export function validateDocument(doc: unknown, rawText: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { kindToDefinition } = loadSchema();
  if (!isObject(doc)) {
    out.push({ severity: "error", message: "Document is empty or not a mapping" });
    return out;
  }
  const kind = doc.kind;
  if (typeof kind !== "string") {
    out.push({ severity: "error", message: "No 'kind' property at root level" });
    return out;
  }
  const rootDef = kindToDefinition.get(kind);
  if (!rootDef) {
    out.push({ severity: "warning", message: `Kind '${kind}' not found in schema` });
  } else {
    checkUnknownProps(doc, rootDef, "$", out, IGNORED_ROOT_KEYS, "warning");
  }

  const actionKinds = validKindsFromOneOf("DialogAction");

  if (kind === "AdaptiveDialog" || kind === "AgentDialog") {
    const bd = doc.beginDialog;
    if (!isObject(bd)) {
      out.push({ severity: "error", message: `${kind} requires 'beginDialog'` });
    } else {
      if (typeof bd.kind !== "string") out.push({ severity: "error", message: "beginDialog is missing 'kind'", path: "$.beginDialog" });
      if (typeof bd.id !== "string") out.push({ severity: "error", message: "beginDialog is missing 'id'", path: "$.beginDialog" });
      const trigDef = typeof bd.kind === "string" ? kindToDefinition.get(bd.kind) : undefined;
      if (typeof bd.kind === "string" && !trigDef) {
        out.push({ severity: "error", message: `Unknown trigger kind '${bd.kind}'`, path: "$.beginDialog" });
      } else if (trigDef) {
        checkUnknownProps(bd, trigDef, "$.beginDialog", out);
        // Properties that belong at the root, not inside the trigger.
        const rootProps = rootDef ? validProperties(rootDef) : new Set<string>();
        const trigProps = validProperties(trigDef);
        for (const key of Object.keys(bd)) {
          if (!trigProps.has(key) && rootProps.has(key)) {
            out.push({ severity: "error", message: `'${key}' belongs at the ${kind} root, not inside beginDialog`, path: `$.beginDialog.${key}` });
          }
        }
      }
      if (kind === "AgentDialog") {
        if (bd.kind !== "OnToolSelected") out.push({ severity: "warning", message: "Child agents normally use beginDialog.kind OnToolSelected", path: "$.beginDialog" });
        if (!bd.description) out.push({ severity: "warning", message: "beginDialog.description missing; the parent orchestrator routes on it", path: "$.beginDialog" });
        if (Array.isArray(bd.actions) && bd.actions.length > 0) {
          out.push({ severity: "error", message: "AgentDialog must not contain beginDialog.actions; put behaviour in settings.instructions", path: "$.beginDialog.actions" });
        }
        const settings = doc.settings as Node | undefined;
        if (!settings?.instructions) out.push({ severity: "warning", message: "settings.instructions missing for child agent" });
      } else {
        validateActions(bd.actions, "$.beginDialog.actions", out, actionKinds);
      }
    }
  } else if (kind === "KnowledgeSourceConfiguration") {
    const source = doc.source;
    if (!isObject(source)) out.push({ severity: "error", message: "KnowledgeSourceConfiguration requires 'source'" });
    else {
      const sk = source.kind;
      const valid = validKindsFromOneOf("KnowledgeSource");
      if (typeof sk !== "string") out.push({ severity: "error", message: "source.kind missing", path: "$.source" });
      else if (valid.length && !valid.includes(sk)) out.push({ severity: "error", message: `'${sk}' is not a valid knowledge source kind`, path: "$.source" });
      else {
        const dn = kindToDefinition.get(sk);
        if (dn) checkUnknownProps(source, dn, "$.source", out);
      }
    }
  } else if (kind === "TaskDialog") {
    const action = doc.action;
    if (!isObject(action)) out.push({ severity: "warning", message: "TaskDialog has no 'action'" });
    else {
      const ak = action.kind;
      const valid = validKindsFromOneOf("TaskAction");
      if (typeof ak !== "string") out.push({ severity: "error", message: "action.kind missing", path: "$.action" });
      else if (valid.length && !valid.includes(ak)) out.push({ severity: "error", message: `'${ak}' is not a valid task action kind`, path: "$.action" });
      else {
        const dn = kindToDefinition.get(ak);
        if (dn) checkUnknownProps(action, dn, "$.action", out);
      }
    }
    if (Array.isArray(doc.inputs)) {
      (doc.inputs as unknown[]).forEach((inp, i) => {
        if (!isObject(inp)) return;
        const dn = typeof inp.kind === "string" ? kindToDefinition.get(inp.kind) : undefined;
        if (!dn) out.push({ severity: "error", message: `inputs[${i}] needs kind AutomaticTaskInput or ManualTaskInput`, path: `$.inputs[${i}]` });
        else checkUnknownProps(inp, dn, `$.inputs[${i}]`, out);
      });
    }
  } else if (kind === "GptComponentMetadata") {
    if (!doc.displayName) out.push({ severity: "warning", message: "displayName is recommended" });
    if (!doc.instructions) out.push({ severity: "warning", message: "instructions are recommended" });
  } else if (kind === "ExternalTriggerConfiguration") {
    const src = doc.externalTriggerSource;
    if (!isObject(src)) out.push({ severity: "error", message: "externalTriggerSource is required" });
    else if (typeof src.kind === "string") {
      const dn = kindToDefinition.get(src.kind);
      if (dn) checkUnknownProps(src, dn, "$.externalTriggerSource", out);
    }
  }

  // Duplicate ids
  const ids = new Map<string, number>();
  collect(doc, (node) => {
    if (typeof node.id === "string") ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
  });
  for (const [id, n] of ids) if (n > 1) out.push({ severity: "error", message: `Duplicate id '${id}' (${n} occurrences)` });

  // Placeholders
  const placeholders = (rawText.match(/_REPLACE/g) ?? []).length;
  if (placeholders > 0) out.push({ severity: "error", message: `${placeholders} unresolved '_REPLACE' placeholder(s)` });
  if (/<[A-Z][A-Za-z _]+>/.test(rawText)) out.push({ severity: "warning", message: "Angle-bracket placeholder like <Topic Name> still present" });

  // Power Fx and variable scopes
  collect(doc, (node, atPath) => {
    if (typeof node.condition === "string" && !node.condition.startsWith("=")) {
      out.push({ severity: "warning", message: `condition '${node.condition}' may need a leading '='`, path: atPath });
    }
    if (typeof node.variable === "string") {
      const v = node.variable.replace(/^init:/, "");
      if (!VARIABLE_SCOPES.some((s) => v.startsWith(s))) {
        out.push({ severity: "warning", message: `variable '${node.variable}' lacks a scope prefix (Topic., Global., System., User.)`, path: atPath });
      }
    }
  });

  // inputs vs inputType
  if (Array.isArray(doc.inputs) && isObject(doc.inputType)) {
    const names = new Set((doc.inputs as Node[]).map((i) => i?.propertyName).filter((x): x is string => typeof x === "string"));
    const typed = new Set(Object.keys((doc.inputType.properties as Node | undefined) ?? {}));
    for (const n of names) if (!typed.has(n)) out.push({ severity: "warning", message: `input '${n}' missing from inputType.properties` });
    for (const t of typed) if (!names.has(t)) out.push({ severity: "warning", message: `inputType property '${t}' has no matching input` });
  }

  return out;
}
