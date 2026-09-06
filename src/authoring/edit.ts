/**
 * Day-two authoring: edit and remove existing components. Every edit keeps
 * the file's comment header and touches only the fields named in the spec.
 */
import fs from "node:fs";
import path from "node:path";
import { readWorkspace, type ComponentInfo, type WorkspaceInfo } from "../workspace.js";
import { buildActions, type ActionSpec } from "./topics.js";
import { readConnectionReferences, upsertConnectionReference, type ToolInput } from "./tools.js";
import { loadWithHeader, saveWithHeader, yamlDump, fileStem } from "./util.js";

export type ComponentKind = "topic" | "knowledge" | "tool" | "trigger" | "variable" | "flow";

type Doc = Record<string, unknown>;

function poolFor(ws: WorkspaceInfo, kind: ComponentKind): ComponentInfo[] {
  switch (kind) {
    case "topic":
      return ws.topics;
    case "knowledge":
      return ws.knowledge;
    case "tool":
      return ws.actions;
    case "trigger":
      return ws.triggers;
    case "variable":
      return ws.variables;
    case "flow":
      return ws.workflows.map((w) => ({ name: (w.metadata?.displayName as string) ?? w.name, description: null, kind: "CloudFlowDefinition", file: w.dir, relPath: path.relative(ws.root, w.dir), details: {} }));
  }
}

/** Find a component by display name, file stem or relative path (case-insensitive). */
export function findComponent(ws: WorkspaceInfo, kind: ComponentKind, ref: string): ComponentInfo | null {
  const q = ref.trim().toLowerCase();
  const pool = poolFor(ws, kind);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    pool.find((c) => c.name.toLowerCase() === q) ??
    pool.find((c) => c.relPath.toLowerCase() === q.replace(/\\/g, "/")) ??
    pool.find((c) => fileStem(c.file).toLowerCase() === q) ??
    pool.find((c) => norm(c.name) === norm(ref) || norm(fileStem(c.file)) === norm(ref)) ??
    null
  );
}

function requireComponent(root: string, kind: ComponentKind, ref: string): { ws: WorkspaceInfo; component: ComponentInfo } {
  const ws = readWorkspace(root);
  const component = findComponent(ws, kind, ref);
  if (!component) {
    const names = poolFor(ws, kind).map((c) => c.name);
    throw new Error(`No ${kind} named '${ref}'. Known: ${names.length ? names.join(", ") : "(none)"}`);
  }
  return { ws, component };
}

function setMetadata(doc: Doc, name?: string, description?: string): string[] {
  const changed: string[] = [];
  const meta = ((doc["mcs.metadata"] as Doc) ?? {}) as Doc;
  if (name !== undefined) {
    meta.componentName = name;
    changed.push("name");
  }
  if (description !== undefined) {
    meta.description = description;
    changed.push("description");
  }
  if (changed.length) doc["mcs.metadata"] = meta;
  return changed;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface TopicEdit {
  topic: string;
  rename?: string;
  description?: string;
  setTriggerPhrases?: string[];
  addTriggerPhrases?: string[];
  removeTriggerPhrases?: string[];
  priority?: number | null;
  /** Append nodes at the end of beginDialog.actions */
  appendActions?: ActionSpec[];
  /** Insert nodes at a 0-based position */
  insertActions?: { at: number; actions: ActionSpec[] };
  /** Remove nodes by id (top level of beginDialog.actions) */
  removeActionIds?: string[];
  agentSchemaName?: string;
}

export interface EditResult {
  file: string;
  changed: string[];
  yaml: string;
}

export function editTopic(root: string, e: TopicEdit): EditResult {
  const { ws, component } = requireComponent(root, "topic", e.topic);
  const { header, doc } = loadWithHeader<Doc>(component.file);
  const changed = setMetadata(doc, e.rename, e.description);
  const beginDialog = ((doc.beginDialog as Doc) ?? {}) as Doc;
  doc.beginDialog = beginDialog;

  if (e.setTriggerPhrases || e.addTriggerPhrases || e.removeTriggerPhrases) {
    if (beginDialog.kind !== "OnRecognizedIntent") throw new Error(`Topic '${component.name}' is triggered by ${String(beginDialog.kind)}, not by phrases`);
    const intent = ((beginDialog.intent as Doc) ?? {}) as Doc;
    let phrases = Array.isArray(intent.triggerQueries) ? [...(intent.triggerQueries as string[])] : [];
    if (e.setTriggerPhrases) phrases = [...e.setTriggerPhrases];
    if (e.addTriggerPhrases) for (const p of e.addTriggerPhrases) if (!phrases.some((x) => x.toLowerCase() === p.toLowerCase())) phrases.push(p);
    if (e.removeTriggerPhrases) {
      const drop = new Set(e.removeTriggerPhrases.map((p) => p.toLowerCase()));
      phrases = phrases.filter((p) => !drop.has(p.toLowerCase()));
    }
    if (phrases.length === 0) throw new Error("A phrase-triggered topic needs at least one trigger phrase");
    intent.triggerQueries = phrases;
    if (!intent.displayName) intent.displayName = component.name;
    beginDialog.intent = intent;
    changed.push("triggerPhrases");
  }
  if (e.priority !== undefined) {
    if (e.priority === null) delete beginDialog.priority;
    else beginDialog.priority = e.priority;
    changed.push("priority");
  }
  const actions = Array.isArray(beginDialog.actions) ? [...(beginDialog.actions as Doc[])] : [];
  const schema = e.agentSchemaName ?? ws.schemaName ?? undefined;
  if (e.removeActionIds?.length) {
    const drop = new Set(e.removeActionIds);
    const before = actions.length;
    const kept = actions.filter((a) => !drop.has(String(a.id)));
    if (kept.length === before) throw new Error(`No top-level action with id ${e.removeActionIds.join(", ")}; ids present: ${actions.map((a) => a.id).join(", ")}`);
    actions.splice(0, actions.length, ...kept);
    changed.push(`removed ${before - kept.length} action(s)`);
  }
  if (e.insertActions) {
    const at = Math.max(0, Math.min(actions.length, e.insertActions.at));
    actions.splice(at, 0, ...buildActions(e.insertActions.actions, schema));
    changed.push(`inserted ${e.insertActions.actions.length} action(s) at ${at}`);
  }
  if (e.appendActions?.length) {
    actions.push(...buildActions(e.appendActions, schema));
    changed.push(`appended ${e.appendActions.length} action(s)`);
  }
  beginDialog.actions = actions;
  if (!changed.length) throw new Error("Nothing to change");
  saveWithHeader(component.file, header, doc);
  return { file: component.file, changed, yaml: fs.readFileSync(component.file, "utf8") };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolEdit {
  tool: string;
  rename?: string;
  description?: string;
  modelDescription?: string;
  modelDisplayName?: string;
  operationId?: string;
  connectionMode?: "Invoker" | "Maker";
  connectionReference?: string;
  outputMode?: "All" | "Specific";
  setInputs?: ToolInput[];
  addInputs?: ToolInput[];
  removeInputs?: string[];
}

function inputNode(i: ToolInput): Doc {
  return i.kind === "manual"
    ? { kind: "ManualTaskInput", propertyName: i.name, value: i.value }
    : { kind: "AutomaticTaskInput", propertyName: i.name, description: i.description, entity: i.entity ? (i.entity.endsWith("PrebuiltEntity") ? i.entity : `${i.entity}PrebuiltEntity`) : "StringPrebuiltEntity", ...(i.shouldPromptUser === undefined ? {} : { shouldPromptUser: i.shouldPromptUser }) };
}

export function editTool(root: string, e: ToolEdit): EditResult {
  const { component } = requireComponent(root, "tool", e.tool);
  const { header, doc } = loadWithHeader<Doc>(component.file);
  const changed = setMetadata(doc, e.rename, e.description);
  const simple: [keyof ToolEdit, string][] = [
    ["modelDescription", "modelDescription"],
    ["modelDisplayName", "modelDisplayName"],
    ["outputMode", "outputMode"],
  ];
  for (const [key, prop] of simple) {
    if (e[key] !== undefined) {
      doc[prop] = e[key];
      changed.push(prop);
    }
  }
  const action = ((doc.action as Doc) ?? {}) as Doc;
  if (e.operationId !== undefined) {
    if (action.kind === "InvokeExternalAgentTaskAction") {
      const od = ((action.operationDetails as Doc) ?? {}) as Doc;
      od.operationId = e.operationId;
      action.operationDetails = od;
    } else action.operationId = e.operationId;
    changed.push("operationId");
  }
  if (e.connectionMode !== undefined) {
    action.connectionProperties = { ...((action.connectionProperties as Doc) ?? {}), mode: e.connectionMode };
    changed.push("connectionMode");
  }
  if (e.connectionReference !== undefined) {
    action.connectionReference = e.connectionReference;
    changed.push("connectionReference");
  }
  if (Object.keys(action).length) doc.action = action;
  let inputs = Array.isArray(doc.inputs) ? [...(doc.inputs as Doc[])] : [];
  if (e.setInputs) {
    inputs = e.setInputs.map(inputNode);
    changed.push("inputs");
  }
  if (e.removeInputs?.length) {
    const drop = new Set(e.removeInputs);
    inputs = inputs.filter((i) => !drop.has(String(i.propertyName)));
    changed.push("inputs (removed)");
  }
  if (e.addInputs?.length) {
    const existing = new Set(inputs.map((i) => String(i.propertyName)));
    inputs.push(...e.addInputs.filter((i) => !existing.has(i.name)).map(inputNode));
    changed.push("inputs (added)");
  }
  if (inputs.length) doc.inputs = inputs;
  else delete doc.inputs;
  if (!changed.length) throw new Error("Nothing to change");
  saveWithHeader(component.file, header, doc);
  return { file: component.file, changed, yaml: fs.readFileSync(component.file, "utf8") };
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export interface KnowledgeEdit {
  knowledge: string;
  rename?: string;
  description?: string;
  site?: string;
  includeSubPages?: boolean;
  triggerCondition?: string | null;
  additionalSearchTerms?: string | null;
}

export function editKnowledge(root: string, e: KnowledgeEdit): EditResult {
  const { component } = requireComponent(root, "knowledge", e.knowledge);
  const { header, doc } = loadWithHeader<Doc>(component.file);
  const changed = setMetadata(doc, e.rename, e.description);
  const source = ((doc.source as Doc) ?? {}) as Doc;
  if (e.site !== undefined) {
    source.site = e.site;
    changed.push("site");
  }
  if (e.includeSubPages !== undefined) {
    source.includeSubPages = e.includeSubPages;
    changed.push("includeSubPages");
  }
  if (e.triggerCondition !== undefined) {
    if (e.triggerCondition === null) delete source.triggerCondition;
    else source.triggerCondition = e.triggerCondition.startsWith("=") ? e.triggerCondition : `=${e.triggerCondition}`;
    changed.push("triggerCondition");
  }
  if (e.additionalSearchTerms !== undefined) {
    if (e.additionalSearchTerms === null) delete source.additionalSearchTerms;
    else source.additionalSearchTerms = e.additionalSearchTerms;
    changed.push("additionalSearchTerms");
  }
  doc.source = source;
  if (!changed.length) throw new Error("Nothing to change");
  saveWithHeader(component.file, header, doc);
  return { file: component.file, changed, yaml: fs.readFileSync(component.file, "utf8") };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export interface RemoveSpec {
  kind: ComponentKind;
  name: string;
  /** For tools: also drop the connection reference entry when no other tool uses it (default true) */
  pruneConnectionReference?: boolean;
}

export interface RemoveResult {
  removed: string[];
  notes: string[];
}

export function removeComponent(root: string, r: RemoveSpec): RemoveResult {
  const { ws, component } = requireComponent(root, r.kind, r.name);
  const removed: string[] = [];
  const notes: string[] = [];
  if (r.kind === "flow") {
    fs.rmSync(component.file, { recursive: true, force: true });
    removed.push(component.file);
  } else {
    if (r.kind === "tool" && r.pruneConnectionReference !== false) {
      const cr = ((component.details.connectionReference as string | null) ?? null) as string | null;
      if (cr) {
        const stillUsed = ws.actions.some((a) => a.file !== component.file && a.details.connectionReference === cr);
        if (!stillUsed) {
          const reg = readConnectionReferences(root);
          if (reg.file && reg.entries.some((e) => e.connectionReferenceLogicalName === cr)) {
            const remaining = reg.entries.filter((e) => e.connectionReferenceLogicalName !== cr);
            fs.writeFileSync(reg.file, yamlDump({ kind: "ConnectionReferencesSourceFile", connectionReferences: remaining }), "utf8");
            notes.push(`removed connection reference ${cr} from ${path.basename(reg.file)}`);
          }
        } else notes.push(`connection reference ${cr} kept: other tools use it`);
      }
    }
    fs.rmSync(component.file, { force: true });
    removed.push(component.file);
  }
  const redirects = ws.topics.filter((t) => t.file !== component.file && fs.readFileSync(t.file, "utf8").includes(`.topic.${fileStem(component.file)}`));
  if (r.kind === "topic" && redirects.length) notes.push(`topics still redirecting to it: ${redirects.map((t) => t.name).join(", ")}`);
  return { removed, notes };
}

/** Re-export so callers editing tools can bind a reference without importing tools.ts. */
export { upsertConnectionReference };
