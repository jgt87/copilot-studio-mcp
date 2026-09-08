/**
 * Reads a Copilot Studio agent workspace (as produced by `pac copilot clone`,
 * `pac copilot init`, or the VS Code extension) into a structured inventory.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { componentDescriptionFromText, componentNameFromText, fileStem, isYamlFile, listFilesRecursive } from "./authoring/util.js";

export type Harness = "standard" | "github-copilot" | "unknown";

export interface ComponentInfo {
  name: string;
  description: string | null;
  kind: string | null;
  file: string;
  relPath: string;
  details: Record<string, unknown>;
  parseError?: string;
}

export interface SyncInfo {
  source: "vscode-extension" | "pac" | "none";
  environmentId: string | null;
  agentId: string | null;
  tenantId: string | null;
  dataverseUrl: string | null;
  agentManagementUrl: string | null;
  raw: Record<string, unknown> | null;
}

export interface WorkspaceInfo {
  root: string;
  harness: Harness;
  settings: Record<string, unknown> | null;
  agent: { file: string | null; displayName: string | null; instructions: string | null; conversationStarters: { title?: string; text?: string }[]; model: string | null } | null;
  schemaName: string | null;
  sync: SyncInfo;
  topics: ComponentInfo[];
  knowledge: ComponentInfo[];
  knowledgeFiles: string[];
  actions: ComponentInfo[];
  triggers: ComponentInfo[];
  variables: ComponentInfo[];
  workflows: { name: string; dir: string; hasDefinition: boolean; metadata: Record<string, unknown> | null }[];
  connectionReferences: Record<string, unknown>[];
  otherFiles: string[];
}

const MARKERS = ["agent.mcs.yml", "agent.mcs.yaml", "settings.mcs.yml", "settings.mcs.yaml", "agent.sync.yaml", "agent.sync.yml"];

function hasMarker(dir: string): boolean {
  return MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Find the workspace root: the start dir itself, one of its direct children,
 * or an ancestor. Returns null when nothing looks like an agent workspace.
 */
export function findWorkspaceRoot(start: string): string | null {
  const abs = path.resolve(start);
  if (hasMarker(abs)) return abs;
  try {
    const children = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules");
    const matches = children.filter((c) => hasMarker(path.join(abs, c.name)));
    if (matches.length === 1) return path.join(abs, matches[0].name);
  } catch {
    // ignore
  }
  let cur = abs;
  for (let i = 0; i < 6; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
    if (hasMarker(cur)) return cur;
  }
  return null;
}

function firstExisting(root: string, names: string[]): string | null {
  for (const n of names) {
    const p = path.join(root, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readYamlSafe(file: string): { doc: unknown; text: string; error?: string } {
  const text = fs.readFileSync(file, "utf8");
  try {
    return { doc: yaml.load(text), text };
  } catch (err) {
    return { doc: null, text, error: (err as Error).message };
  }
}

function readComponent(root: string, file: string, detail: (doc: Record<string, unknown>) => Record<string, unknown>): ComponentInfo {
  const { doc, text, error } = readYamlSafe(file);
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  return {
    name: componentNameFromText(text, doc, file),
    description: componentDescriptionFromText(text, doc),
    kind: typeof d.kind === "string" ? d.kind : null,
    file,
    relPath: path.relative(root, file).split(path.sep).join("/"),
    details: error ? {} : detail(d),
    parseError: error,
  };
}

function yamlFilesIn(root: string, sub: string | string[]): string[] {
  const subs = Array.isArray(sub) ? sub : [sub];
  const out: string[] = [];
  for (const s of subs) {
    const dir = path.join(root, s);
    if (!fs.existsSync(dir)) continue;
    out.push(...listFilesRecursive(dir, (f) => isYamlFile(f) && !f.includes(`${path.sep}files${path.sep}`), 2));
  }
  return out;
}

function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function pick(flat: Record<string, unknown>, pattern: RegExp): string | null {
  for (const [k, v] of Object.entries(flat)) {
    if (pattern.test(k) && typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function readSync(root: string): SyncInfo {
  const conn = path.join(root, ".mcs", "conn.json");
  if (fs.existsSync(conn)) {
    try {
      const c = JSON.parse(fs.readFileSync(conn, "utf8")) as Record<string, unknown>;
      const acct = (c.AccountInfo ?? {}) as Record<string, unknown>;
      return {
        source: "vscode-extension",
        environmentId: (c.EnvironmentId as string) ?? null,
        agentId: (c.AgentId as string) ?? null,
        tenantId: (acct.TenantId as string) ?? null,
        dataverseUrl: ((c.DataverseEndpoint as string) ?? null)?.replace(/\/+$/, "") ?? null,
        agentManagementUrl: (c.AgentManagementEndpoint as string) ?? null,
        raw: c,
      };
    } catch {
      // fall through
    }
  }
  const sync = firstExisting(root, ["agent.sync.yaml", "agent.sync.yml"]);
  if (sync) {
    const { doc } = readYamlSafe(sync);
    const raw = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
    const flat = flatten(raw);
    return {
      source: "pac",
      environmentId: pick(flat, /environment.?id$/i),
      agentId: pick(flat, /(bot|agent|copilot).?id$/i),
      tenantId: pick(flat, /tenant.?id$/i),
      dataverseUrl: pick(flat, /(dataverse|environment|org).?url$/i)?.replace(/\/+$/, "") ?? null,
      agentManagementUrl: pick(flat, /management.?(url|endpoint)$/i),
      raw,
    };
  }
  return { source: "none", environmentId: null, agentId: null, tenantId: null, dataverseUrl: null, agentManagementUrl: null, raw: null };
}

/** `agent.mcs.yml`: the parts of the agent definition the inventory reports. */
function readAgent(root: string): WorkspaceInfo["agent"] {
  const agentFile = firstExisting(root, ["agent.mcs.yml", "agent.mcs.yaml"]);
  if (!agentFile) return null;
  const a = (readYamlSafe(agentFile).doc ?? {}) as Record<string, unknown>;
  const ai = (a.aISettings ?? {}) as Record<string, unknown>;
  const model = (ai.model ?? {}) as Record<string, unknown>;
  return {
    file: agentFile,
    displayName: (a.displayName as string) ?? null,
    instructions: (a.instructions as string) ?? null,
    conversationStarters: Array.isArray(a.conversationStarters) ? (a.conversationStarters as { title?: string; text?: string }[]) : [],
    model: (model.modelNameHint as string) ?? (model.series as string) ?? null,
  };
}

/** Every component of one kind, from whichever folder name the layout uses. */
function readComponents(root: string, sub: string | string[], detail: (doc: Record<string, unknown>) => Record<string, unknown>): ComponentInfo[] {
  return yamlFilesIn(root, sub).map((f) => readComponent(root, f, detail));
}

function readTopics(root: string): ComponentInfo[] {
  return readComponents(root, "topics", (d) => {
    const bd = (d.beginDialog ?? {}) as Record<string, unknown>;
    const intent = (bd.intent ?? {}) as Record<string, unknown>;
    const actions = Array.isArray(bd.actions) ? (bd.actions as Record<string, unknown>[]) : [];
    return {
      triggerKind: bd.kind ?? null,
      priority: bd.priority ?? null,
      triggerPhrases: Array.isArray(intent.triggerQueries) ? intent.triggerQueries : [],
      actionKinds: actions.map((a) => a?.kind).filter(Boolean),
      actionCount: actions.length,
    };
  });
}

function readKnowledge(root: string): ComponentInfo[] {
  return readComponents(root, "knowledge", (d) => {
    const src = (d.source ?? {}) as Record<string, unknown>;
    return { sourceKind: src.kind ?? null, site: src.site ?? null, connectionName: src.connectionName ?? null, triggerCondition: src.triggerCondition ?? null };
  });
}

/** Uploaded knowledge documents, listed by path rather than parsed. */
function readKnowledgeFiles(root: string): string[] {
  const filesDir = path.join(root, "knowledge", "files");
  if (!fs.existsSync(filesDir)) return [];
  return listFilesRecursive(filesDir, () => true, 2).map((f) => path.relative(root, f).split(path.sep).join("/"));
}

function readActions(root: string): ComponentInfo[] {
  return readComponents(root, ["actions", "tools"], (d) => {
    const act = (d.action ?? {}) as Record<string, unknown>;
    const od = (act.operationDetails ?? {}) as Record<string, unknown>;
    const inputs = Array.isArray(d.inputs) ? (d.inputs as Record<string, unknown>[]) : [];
    return {
      actionKind: act.kind ?? null,
      operationId: act.operationId ?? od.operationId ?? null,
      connectionReference: act.connectionReference ?? null,
      flowId: act.flowId ?? null,
      modelDisplayName: d.modelDisplayName ?? null,
      modelDescription: d.modelDescription ?? null,
      inputs: inputs.map((i) => ({ kind: i.kind, propertyName: i.propertyName })),
    };
  });
}

function readTriggers(root: string): ComponentInfo[] {
  return readComponents(root, ["trigger", "triggers"], (d) => {
    const src = (d.externalTriggerSource ?? {}) as Record<string, unknown>;
    return { sourceKind: src.kind ?? null, flowId: src.flowId ?? null };
  });
}

function readVariables(root: string): ComponentInfo[] {
  return readComponents(root, "variables", (d) => ({ name: d.name ?? null, scope: d.scope ?? null, defaultValue: d.defaultValue ?? null, aIVisibility: d.aIVisibility ?? null }));
}

/** `workflows/<Name>/`: one entry per folder, with its metadata when present. */
function readWorkflows(root: string): WorkspaceInfo["workflows"] {
  const workflows: WorkspaceInfo["workflows"] = [];
  const wfDir = path.join(root, "workflows");
  if (!fs.existsSync(wfDir)) return workflows;
  for (const e of fs.readdirSync(wfDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(wfDir, e.name);
    const meta = firstExisting(dir, ["metadata.yaml", "metadata.yml"]);
    workflows.push({
      name: e.name,
      dir,
      hasDefinition: fs.existsSync(path.join(dir, "workflow.json")),
      metadata: meta ? ((readYamlSafe(meta).doc ?? null) as Record<string, unknown> | null) : null,
    });
  }
  return workflows;
}

/**
 * `connectionreferences.mcs.yml`: either a document with a
 * `connectionReferences` list or a bare list. The misspelled file name is one
 * pac has been seen to write.
 */
function readConnectionReferences(root: string): Record<string, unknown>[] {
  const crFile = firstExisting(root, ["connectionreferences.mcs.yml", "connectionreferences.mcs.yaml", "connectioreferences.mcs.yml"]);
  if (!crFile) return [];
  const doc = readYamlSafe(crFile).doc as Record<string, unknown> | null;
  const list = doc?.connectionReferences;
  if (Array.isArray(list)) return list as Record<string, unknown>[];
  if (Array.isArray(doc)) return doc as Record<string, unknown>[];
  return [];
}

/** Files in the workspace that are not a component, a workflow or a knowledge document. */
function readOtherFiles(root: string, components: ComponentInfo[]): string[] {
  const known = new Set(components.map((c) => c.file));
  return listFilesRecursive(root, (f) => !known.has(f) && !f.includes(`${path.sep}workflows${path.sep}`) && !f.includes(`${path.sep}knowledge${path.sep}files${path.sep}`), 1).map((f) => path.relative(root, f).split(path.sep).join("/"));
}

export function readWorkspace(root: string): WorkspaceInfo {
  const settingsFile = firstExisting(root, ["settings.mcs.yml", "settings.mcs.yaml"]);
  const settings = settingsFile ? ((readYamlSafe(settingsFile).doc ?? null) as Record<string, unknown> | null) : null;
  const configuration = (settings?.configuration ?? {}) as Record<string, unknown>;
  const authoringModel = configuration.authoringModel as string | undefined;
  const harness: Harness = authoringModel === "CliCopilot" ? "github-copilot" : settings ? "standard" : "unknown";

  const topics = readTopics(root);
  const knowledge = readKnowledge(root);
  const actions = readActions(root);
  const triggers = readTriggers(root);
  const variables = readVariables(root);

  return {
    root,
    harness,
    settings,
    agent: readAgent(root),
    schemaName: (settings?.schemaName as string) ?? null,
    sync: readSync(root),
    topics,
    knowledge,
    knowledgeFiles: readKnowledgeFiles(root),
    actions,
    triggers,
    variables,
    workflows: readWorkflows(root),
    connectionReferences: readConnectionReferences(root),
    otherFiles: readOtherFiles(root, [...topics, ...knowledge, ...actions, ...triggers, ...variables]),
  };
}

/** Compact inventory for tool output (no raw docs). */
export function describeWorkspace(info: WorkspaceInfo): Record<string, unknown> {
  const brief = (c: ComponentInfo) => ({ name: c.name, kind: c.kind, file: c.relPath, ...(c.parseError ? { parseError: c.parseError } : {}), ...c.details, ...(c.description ? { description: c.description } : {}) });
  return {
    root: info.root,
    harness: info.harness,
    displayName: (info.settings?.displayName as string) ?? info.agent?.displayName ?? null,
    schemaName: info.schemaName,
    authenticationMode: (info.settings?.authenticationMode as string) ?? null,
    sync: { source: info.sync.source, environmentId: info.sync.environmentId, agentId: info.sync.agentId, tenantId: info.sync.tenantId, dataverseUrl: info.sync.dataverseUrl },
    agent: info.agent ? { file: path.basename(info.agent.file ?? ""), instructionsChars: info.agent.instructions?.length ?? 0, conversationStarters: info.agent.conversationStarters.length, model: info.agent.model } : null,
    counts: {
      topics: info.topics.length,
      knowledge: info.knowledge.length,
      knowledgeFiles: info.knowledgeFiles.length,
      actions: info.actions.length,
      triggers: info.triggers.length,
      variables: info.variables.length,
      workflows: info.workflows.length,
      connectionReferences: info.connectionReferences.length,
    },
    topics: info.topics.map(brief),
    knowledge: info.knowledge.map(brief),
    knowledgeFiles: info.knowledgeFiles,
    actions: info.actions.map(brief),
    triggers: info.triggers.map(brief),
    variables: info.variables.map(brief),
    workflows: info.workflows.map((w) => ({ name: w.name, hasDefinition: w.hasDefinition, displayName: (w.metadata?.displayName as string) ?? null, workflowId: (w.metadata?.workflowId as string) ?? null })),
    connectionReferences: info.connectionReferences.map((c) => ({
      logicalName: c.connectionReferenceLogicalName ?? c.logicalName ?? null,
      connectorId: c.connectorId ?? null,
      connectionId: c.connectionId ?? null,
      displayName: c.displayName ?? null,
    })),
    otherFiles: info.otherFiles,
  };
}
