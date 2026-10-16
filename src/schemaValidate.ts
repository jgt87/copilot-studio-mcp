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
const TOLERATED_PROPS: Record<string, string[]> = {
  GptComponentMetadata: ["displayName", "description", "modelDescription"],
  // The workspace file is flat (name / aIVisibility / scope / defaultValue), as in
  // Microsoft's own template; the schema describes the Dataverse row, which nests
  // these under `variable`. Holding the file to the row would block every push.
  GlobalVariableComponent: ["name", "aIVisibility", "scope", "defaultValue"],
};

/** Required properties the workspace file legitimately leaves out, for the same reason. */
const EXEMPT_REQUIRED: Record<string, string[]> = { GlobalVariableComponent: ["variable"] };

function checkUnknownProps(obj: Node, definitionName: string, atPath: string, out: Diagnostic[], ignore: Set<string> = new Set(), unknownSeverity: Diagnostic["severity"] = "error"): void {
  const def = loadSchema().definitions[definitionName];
  if (!def || def.additionalProperties !== false || !def.properties) return;
  const allowed = validProperties(definitionName);
  const tolerated = new Set(TOLERATED_PROPS[definitionName] ?? []);
  for (const key of Object.keys(obj)) {
    if (ignore.has(key) || allowed.has(key) || tolerated.has(key)) continue;
    out.push({ severity: unknownSeverity, message: `Unknown property '${key}' for ${definitionName}`, path: atPath });
  }
  const exempt = new Set(EXEMPT_REQUIRED[definitionName] ?? []);
  const required = ((def.required as string[] | undefined) ?? []).filter((r) => !exempt.has(r));
  for (const r of required) {
    if (obj[r] === undefined) out.push({ severity: "error", message: `Missing required property '${r}' for ${definitionName}`, path: atPath });
  }
}

/**
 * Kinds that hand control away: whatever follows them in the same list never
 * runs. GotoAction is not one - another goto can land on the node after it.
 */
const TERMINAL_KINDS = new Set(["EndDialog", "EndConversation", "CancelAllDialogs", "ReplaceDialog"]);

/** Kinds people write from older documentation, and what the schema calls them now. */
const KIND_HINTS: Record<string, string> = { SendMessage: "use kind SendActivity with 'activity:' (the code-editor sample on Microsoft Learn still shows SendMessage / message:)" };

function validateActions(actions: unknown, atPath: string, out: Diagnostic[], validActionKinds: string[]): void {
  if (!Array.isArray(actions)) return;
  const terminal = actions.findIndex((a) => isObject(a) && TERMINAL_KINDS.has(String(a.kind)) && a.disabled !== true);
  if (terminal >= 0 && terminal < actions.length - 1) {
    const kind = String((actions[terminal] as Node).kind);
    out.push({ severity: "warning", message: `${actions.length - terminal - 1} node(s) after ${kind} never run`, path: `${atPath}[${terminal + 1}]` });
  }
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
      const hint = KIND_HINTS[kind] ? `: ${KIND_HINTS[kind]}` : " (see DialogAction)";
      out.push({ severity: "error", message: `'${kind}' is not a valid action kind${hint}`, path: p });
      return;
    }
    if (kind === "AdaptiveCardPrompt") checkAdaptiveCard(action, p, out);
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

/**
 * An "Ask with adaptive card" node whose card is JSON (a card written as a Power
 * Fx formula starts with '=' and is left alone). Rules from Microsoft Learn,
 * "Ask with Adaptive Cards", and Microsoft's add-adaptive-card skill: the node
 * waits for a submit, so a card without one never returns; 1.6 is the newest
 * schema Copilot Studio renders and Teams stops at 1.5; Web Chat cannot run
 * Action.Execute; a required input without a label is rejected.
 */
function checkAdaptiveCard(node: Node, atPath: string, out: Diagnostic[]): void {
  if (typeof node.card !== "string" || node.card.trim().startsWith("=")) return;
  let card: unknown;
  try {
    card = JSON.parse(node.card);
  } catch {
    out.push({ severity: "warning", message: "card is neither JSON nor a Power Fx formula (a formula starts with '=')", path: `${atPath}.card` });
    return;
  }
  if (!isObject(card)) return;
  const at = `${atPath}.card`;
  const version = Number.parseFloat(String(card.version ?? ""));
  if (Number.isNaN(version)) out.push({ severity: "warning", message: "card has no 'version'", path: at });
  else if (version > 1.6) out.push({ severity: "warning", message: `card version ${card.version}: Copilot Studio renders up to 1.6`, path: at });
  else if (version > 1.5) out.push({ severity: "info", message: `card version ${card.version}: Teams renders up to 1.5`, path: at });
  const types: string[] = [];
  const unlabelled: string[] = [];
  collect(card, (n) => {
    if (typeof n.type !== "string") return;
    types.push(n.type);
    if (n.type.startsWith("Input.") && n.isRequired === true && !n.label) unlabelled.push(String(n.id ?? n.type));
  });
  if (!types.includes("Action.Submit")) out.push({ severity: "warning", message: "card has no Action.Submit, so the node waits for an answer that cannot arrive", path: at });
  if (types.includes("Action.Execute")) out.push({ severity: "warning", message: "card uses Action.Execute, which Web Chat does not support; use Action.Submit", path: at });
  for (const id of unlabelled) out.push({ severity: "warning", message: `required input '${id}' has no label`, path: at });
}

/**
 * Trigger phrases on one topic: the product caps them at 200 (Microsoft Learn,
 * quotas), and a repeat within the topic is noise the editor would not accept twice.
 */
function checkTriggerPhrases(bd: Node, out: Diagnostic[]): void {
  const phrases = (bd.intent as Node | undefined)?.triggerQueries;
  if (!Array.isArray(phrases)) return;
  if (phrases.length > 200) out.push({ severity: "error", message: `${phrases.length} trigger phrases; a topic takes at most 200`, path: "$.beginDialog.intent.triggerQueries" });
  const seen = new Set<string>();
  for (const p of phrases) {
    const key = String(p).trim().toLowerCase();
    if (seen.has(key)) out.push({ severity: "warning", message: `trigger phrase '${String(p)}' is listed twice`, path: "$.beginDialog.intent.triggerQueries" });
    seen.add(key);
  }
}

/**
 * Topic inputs and outputs under generative orchestration: the orchestrator fills
 * an input and reads an output by its description (Microsoft Learn, "Manage topic
 * inputs and outputs"), so one without is a parameter it cannot use well.
 */
function checkTopicParameters(doc: Node, out: Diagnostic[]): void {
  if (Array.isArray(doc.inputs)) {
    (doc.inputs as unknown[]).forEach((inp, i) => {
      if (isObject(inp) && !inp.description) out.push({ severity: "warning", message: `topic input '${String(inp.propertyName ?? i)}' has no description; the orchestrator fills it from the description`, path: `$.inputs[${i}]` });
    });
  }
  const props = isObject(doc.outputType) && isObject(doc.outputType.properties) ? doc.outputType.properties : null;
  for (const [name, p] of Object.entries(props ?? {})) {
    if (isObject(p) && !p.description) out.push({ severity: "warning", message: `topic output '${name}' has no description`, path: `$.outputType.properties.${name}` });
  }
}

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
    checkTriggerPhrases(bd, out);
    checkTopicParameters(doc, out);
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
  // <AGENT_SCHEMA> is the authoring tools' own marker; validate.ts reports it as an error.
  if (/<(?!AGENT_SCHEMA>)[A-Z][A-Za-z _]+>/.test(rawText)) out.push({ severity: "warning", message: "Angle-bracket placeholder like <Topic Name> still present" });
}

/**
 * Keys that take either a literal or a Power Fx formula. A literal is fine, so
 * only a value that reads like a formula - it names a scoped variable - is
 * flagged: without the '=' it is stored as that text.
 */
const FORMULA_OR_LITERAL_KEYS = ["value", "triggerCondition", "items", "userInput"];
const LOOKS_LIKE_FORMULA = /(^|[^{A-Za-z])(Topic|Global|System|Env)\.[A-Za-z]/;

/**
 * An unquoted value with ' #' in it: YAML reads the rest of the line as a
 * comment, and the cut-off text is what reaches the agent (reported against the
 * VS Code extension as microsoft/vscode-copilotstudio#326). The authoring tools
 * quote such values themselves; this catches hand edits. Lines inside a block
 * scalar (| or >) are literal text and skipped.
 */
export function findCommentTruncation(rawText: string): number[] {
  const lines = rawText.split(/\r?\n/);
  const hits: number[] = [];
  let blockIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) return;
      blockIndent = -1;
    }
    if (/:\s*[|>][-+0-9]*\s*$/.test(line) || /^\s*-\s+[|>][-+0-9]*\s*$/.test(line)) {
      blockIndent = indent;
      return;
    }
    const value = /^\s*(?:-\s+)?(?:[^\s:'"#][^:'"#]*:\s+)?(.*)$/.exec(line)?.[1] ?? "";
    if (!value || /^['"#|>&*!]/.test(value)) return;
    if (/\s#/.test(value)) hits.push(i + 1);
  });
  return hits;
}

/** Power Fx conditions need a leading '=', and variables need a scope prefix. */
function checkExpressions(doc: Node, out: Diagnostic[]): void {
  collect(doc, (node, atPath) => {
    if (typeof node.condition === "string" && !node.condition.startsWith("=")) {
      out.push({ severity: "warning", message: `condition '${node.condition}' may need a leading '='`, path: atPath });
    }
    for (const key of FORMULA_OR_LITERAL_KEYS) {
      const v = node[key];
      if (typeof v === "string" && !v.startsWith("=") && LOOKS_LIKE_FORMULA.test(v)) {
        out.push({ severity: "warning", message: `${key} '${v}' reads like a Power Fx formula but has no leading '=', so it is stored as text`, path: `${atPath}.${key}` });
      }
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
  if (kind === "GlobalVariableComponent") {
    checkGlobalVariable(doc, out);
    return;
  }
  if (kind === "ExternalTriggerConfiguration") checkExternalTrigger(doc, out);
}

/**
 * The flat variable file. aIVisibility takes only these two values (one of
 * Microsoft's own skills says HideFromAIContext, which the schema rejects), and
 * Conversation is the only scope a global variable has.
 */
const AI_VISIBILITY = ["UseInAIContext", "Hidden"];

function checkGlobalVariable(doc: Node, out: Diagnostic[]): void {
  if (doc.aIVisibility !== undefined && !AI_VISIBILITY.includes(String(doc.aIVisibility))) {
    out.push({ severity: "error", message: `aIVisibility '${String(doc.aIVisibility)}' must be ${AI_VISIBILITY.join(" or ")}`, path: "$.aIVisibility" });
  }
  if (doc.scope !== undefined && doc.scope !== "Conversation") {
    out.push({ severity: "warning", message: `scope '${String(doc.scope)}': global variables only have scope Conversation`, path: "$.scope" });
  }
  if (typeof doc.schemaName === "string" && typeof doc.name === "string" && !doc.schemaName.endsWith(`.globalvariable.${doc.name}`)) {
    out.push({ severity: "warning", message: `schemaName '${doc.schemaName}' should end in .globalvariable.${doc.name}`, path: "$.schemaName" });
  }
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
  for (const line of findCommentTruncation(rawText)) {
    out.push({ severity: "warning", message: `line ${line}: everything after ' #' is a YAML comment and is dropped; quote the value if the # belongs to it` });
  }
  checkExpressions(doc, out);
  checkInputsAgainstInputType(doc, out);
  return out;
}
