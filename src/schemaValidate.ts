/**
 * Structural validation of one component document against the authoring
 * schema: unknown and missing properties, the checks that depend on the
 * document's kind, and the cross-cutting ones (duplicate ids, leftover
 * placeholders, Power Fx prefixes, inputs against inputType).
 *
 * Policy: unknown properties at the document root are warnings, because the
 * published schema lags the product; unknown properties inside dialog actions
 * are errors, because that part of the schema is reliable.
 */
import { definitionForKind, loadSchema, validKindsFromOneOf, validProperties, type Node } from "./schema.js";

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

/** AdaptiveDialog and AgentDialog: the trigger, its properties, and the actions below it. */
function checkDialogDocument(doc: Node, kind: string, rootDef: string | undefined, out: Diagnostic[]): void {
  const { kindToDefinition } = loadSchema();
  const actionKinds = validKindsFromOneOf("DialogAction");
  const bd = doc.beginDialog;
  if (!isObject(bd)) {
    out.push({ severity: "error", message: `${kind} requires 'beginDialog'` });
    return;
  }
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
  if (kind !== "AgentDialog") {
    validateActions(bd.actions, "$.beginDialog.actions", out, actionKinds);
    return;
  }
  if (bd.kind !== "OnToolSelected") out.push({ severity: "warning", message: "Child agents normally use beginDialog.kind OnToolSelected", path: "$.beginDialog" });
  if (!bd.description) out.push({ severity: "warning", message: "beginDialog.description missing; the parent orchestrator routes on it", path: "$.beginDialog" });
  if (Array.isArray(bd.actions) && bd.actions.length > 0) {
    out.push({ severity: "error", message: "AgentDialog must not contain beginDialog.actions; put behaviour in settings.instructions", path: "$.beginDialog.actions" });
  }
  const settings = doc.settings as Node | undefined;
  if (!settings?.instructions) out.push({ severity: "warning", message: "settings.instructions missing for child agent" });
}

/** A block whose `kind` must be one of a `oneOf` group, then checked against its own definition. */
function checkKindedBlock(block: unknown, o: { oneOf: string; atPath: string; missing: string; invalid: (kind: string) => string; required: boolean; requiredMessage: string }, out: Diagnostic[]): void {
  if (!isObject(block)) {
    out.push({ severity: o.required ? "error" : "warning", message: o.requiredMessage });
    return;
  }
  const kind = block.kind;
  const valid = validKindsFromOneOf(o.oneOf);
  if (typeof kind !== "string") {
    out.push({ severity: "error", message: o.missing, path: o.atPath });
    return;
  }
  if (valid.length && !valid.includes(kind)) {
    out.push({ severity: "error", message: o.invalid(kind), path: o.atPath });
    return;
  }
  const defName = loadSchema().kindToDefinition.get(kind);
  if (defName) checkUnknownProps(block, defName, o.atPath, out);
}

/** TaskDialog: the action block plus the declared inputs. */
function checkTaskDialog(doc: Node, out: Diagnostic[]): void {
  checkKindedBlock(doc.action, {
    oneOf: "TaskAction",
    atPath: "$.action",
    missing: "action.kind missing",
    invalid: (k) => `'${k}' is not a valid task action kind`,
    required: false,
    requiredMessage: "TaskDialog has no 'action'",
  }, out);
  if (!Array.isArray(doc.inputs)) return;
  const { kindToDefinition } = loadSchema();
  (doc.inputs as unknown[]).forEach((inp, i) => {
    if (!isObject(inp)) return;
    const dn = typeof inp.kind === "string" ? kindToDefinition.get(inp.kind) : undefined;
    if (!dn) out.push({ severity: "error", message: `inputs[${i}] needs kind AutomaticTaskInput or ManualTaskInput`, path: `$.inputs[${i}]` });
    else checkUnknownProps(inp, dn, `$.inputs[${i}]`, out);
  });
}

function checkExternalTrigger(doc: Node, out: Diagnostic[]): void {
  const src = doc.externalTriggerSource;
  if (!isObject(src)) {
    out.push({ severity: "error", message: "externalTriggerSource is required" });
    return;
  }
  if (typeof src.kind !== "string") return;
  const dn = loadSchema().kindToDefinition.get(src.kind);
  if (dn) checkUnknownProps(src, dn, "$.externalTriggerSource", out);
}

/** An id must be unique across the whole document: a repeat breaks navigation at runtime. */
function checkDuplicateIds(doc: Node, out: Diagnostic[]): void {
  const ids = new Map<string, number>();
  collect(doc, (node) => {
    if (typeof node.id === "string") ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
  });
  for (const [id, n] of ids) if (n > 1) out.push({ severity: "error", message: `Duplicate id '${id}' (${n} occurrences)` });
}

/** Template markers a generator left behind. */
function checkPlaceholders(rawText: string, out: Diagnostic[]): void {
  const placeholders = (rawText.match(/_REPLACE/g) ?? []).length;
  if (placeholders > 0) out.push({ severity: "error", message: `${placeholders} unresolved '_REPLACE' placeholder(s)` });
  if (/<[A-Z][A-Za-z _]+>/.test(rawText)) out.push({ severity: "warning", message: "Angle-bracket placeholder like <Topic Name> still present" });
}

/** Power Fx conditions need a leading '=', and variables need a scope prefix. */
function checkExpressions(doc: Node, out: Diagnostic[]): void {
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
}

/** Declared inputs and the typed inputType must describe the same properties. */
function checkInputsAgainstInputType(doc: Node, out: Diagnostic[]): void {
  if (!Array.isArray(doc.inputs) || !isObject(doc.inputType)) return;
  const names = new Set((doc.inputs as Node[]).map((i) => i?.propertyName).filter((x): x is string => typeof x === "string"));
  const typed = new Set(Object.keys((doc.inputType.properties as Node | undefined) ?? {}));
  for (const n of names) if (!typed.has(n)) out.push({ severity: "warning", message: `input '${n}' missing from inputType.properties` });
  for (const t of typed) if (!names.has(t)) out.push({ severity: "warning", message: `inputType property '${t}' has no matching input` });
}

/** The checks that depend on the document's own kind. */
function checkByKind(doc: Node, kind: string, rootDef: string | undefined, out: Diagnostic[]): void {
  if (kind === "AdaptiveDialog" || kind === "AgentDialog") {
    checkDialogDocument(doc, kind, rootDef, out);
    return;
  }
  if (kind === "KnowledgeSourceConfiguration") {
    checkKindedBlock(doc.source, {
      oneOf: "KnowledgeSource",
      atPath: "$.source",
      missing: "source.kind missing",
      invalid: (k) => `'${k}' is not a valid knowledge source kind`,
      required: true,
      requiredMessage: "KnowledgeSourceConfiguration requires 'source'",
    }, out);
    return;
  }
  if (kind === "TaskDialog") {
    checkTaskDialog(doc, out);
    return;
  }
  if (kind === "GptComponentMetadata") {
    if (!doc.displayName) out.push({ severity: "warning", message: "displayName is recommended" });
    if (!doc.instructions) out.push({ severity: "warning", message: "instructions are recommended" });
    return;
  }
  if (kind === "ExternalTriggerConfiguration") checkExternalTrigger(doc, out);
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
  if (!rootDef) out.push({ severity: "warning", message: `Kind '${kind}' not found in schema` });
  else checkUnknownProps(doc, rootDef, "$", out, IGNORED_ROOT_KEYS, "warning");

  checkByKind(doc, kind, rootDef, out);
  checkDuplicateIds(doc, out);
  checkPlaceholders(rawText, out);
  checkExpressions(doc, out);
  checkInputsAgainstInputType(doc, out);
  return out;
}
