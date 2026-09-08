/**
 * Tools (`actions/<name>.mcs.yml`): every TaskAction kind the schema knows,
 * either as a typed spec (connector, MCP, flow, prompt, connected agent,
 * child agent) or as a raw action for the rest, plus the connection-reference
 * registry file.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { newId, pascal, readYamlFile, writeComponentFile, yamlDump } from "./util.js";

/**
 * How each schema TaskAction kind is exposed. `typed` kinds have a dedicated
 * spec in cs_add_tool; `raw` kinds are written through `type: "raw"` with the
 * action object supplied by the caller. A test compares this table with the
 * schema so a new kind cannot appear without being classified here.
 */
export const TOOL_KIND_SUPPORT: Record<string, "typed" | "raw"> = {
  InvokeConnectorTaskAction: "typed",
  InvokeExternalAgentTaskAction: "typed",
  InvokeFlowTaskAction: "typed",
  InvokeAIBuilderModelTaskAction: "typed",
  InvokeConnectedAgentTaskAction: "typed",
  InvokeAgentTaskAction: "typed",
  InvokeAIPluginTaskAction: "raw",
  InvokeSkillTaskAction: "raw",
  InvokeClientTaskAction: "raw",
  InvokeComputerUsingAgentTaskAction: "raw",
};

export type ToolInput =
  | { kind: "automatic"; name: string; description: string; entity?: string; shouldPromptUser?: boolean }
  | { kind: "manual"; name: string; value: string };

export interface ToolSpecBase {
  name: string;
  description: string;
  /** Text the orchestrator sees when deciding to call the tool. Defaults to `description`. */
  modelDescription?: string;
  modelDisplayName?: string;
  inputs?: ToolInput[];
  outputs?: string[];
  outputMode?: "All" | "Specific";
  overwrite?: boolean;
}

export interface ConnectorToolSpec extends ToolSpecBase {
  type: "connector";
  /** e.g. shared_office365, shared_sharepointonline, shared_visualstudioteamservices */
  connectorId: string;
  operationId: string;
  connectionReference?: string;
  connectionMode?: "Invoker" | "Maker";
}

export interface McpToolSpec extends ToolSpecBase {
  type: "mcp";
  connectorId: string;
  operationId?: string;
  connectionReference?: string;
  connectionMode?: "Invoker" | "Maker";
}

export interface FlowToolSpec extends ToolSpecBase {
  type: "flow";
  flowId: string;
}

export interface PromptToolSpec extends ToolSpecBase {
  type: "prompt";
  /** AI Builder model id (from cs_list_prompts) */
  aiModelId: string;
}

export interface ConnectedAgentToolSpec extends ToolSpecBase {
  type: "connected-agent";
  /** Schema name of the other Copilot Studio agent */
  botSchemaName: string;
  shouldSendStartConversation?: boolean;
}

export interface ChildAgentToolSpec extends ToolSpecBase {
  type: "child-agent";
  /** Schema name of the child agent's GPT component, e.g. <agent>.gpt.<Name> */
  gptComponentSchemaName: string;
}

export interface RawToolSpec extends ToolSpecBase {
  type: "raw";
  /** Full TaskAction object, e.g. { kind: "InvokeSkillTaskAction", skillId, actionId } */
  action: Record<string, unknown>;
}

export type ToolSpec = ConnectorToolSpec | McpToolSpec | FlowToolSpec | PromptToolSpec | ConnectedAgentToolSpec | ChildAgentToolSpec | RawToolSpec;

export interface ToolResult {
  file: string;
  componentName: string;
  actionKind: string;
  connectionReference: string | null;
  connectionReferencesFile: string | null;
  portalStep: string | null;
  note: string;
}

function buildInputs(inputs: ToolInput[] | undefined): Record<string, unknown>[] | undefined {
  if (!inputs || inputs.length === 0) return undefined;
  return inputs.map((i) =>
    i.kind === "manual"
      ? { kind: "ManualTaskInput", propertyName: i.name, value: i.value }
      : {
          kind: "AutomaticTaskInput",
          propertyName: i.name,
          description: i.description,
          entity: i.entity ? (i.entity.endsWith("PrebuiltEntity") ? i.entity : `${i.entity}PrebuiltEntity`) : "StringPrebuiltEntity",
          ...(i.shouldPromptUser === undefined ? {} : { shouldPromptUser: i.shouldPromptUser }),
        },
  );
}

const CR_FILE_CANDIDATES = ["connectionreferences.mcs.yml", "connectionreferences.mcs.yaml"];

export interface ConnectionReferenceEntry {
  id?: string;
  connectionReferenceLogicalName: string;
  connectorId?: string;
  displayName?: string;
  connectionId?: string;
}

/** Read `connectionreferences.mcs.yml` (kind ConnectionReferencesSourceFile). */
export function readConnectionReferences(root: string): { file: string | null; entries: ConnectionReferenceEntry[] } {
  for (const c of CR_FILE_CANDIDATES) {
    const f = path.join(root, c);
    if (fs.existsSync(f)) {
      const doc = readYamlFile<Record<string, unknown> | ConnectionReferenceEntry[] | null>(f);
      if (Array.isArray(doc)) return { file: f, entries: doc };
      const list = (doc as Record<string, unknown> | null)?.connectionReferences;
      return { file: f, entries: Array.isArray(list) ? (list as ConnectionReferenceEntry[]) : [] };
    }
  }
  return { file: null, entries: [] };
}

/** Add or update an entry; keeps the file's other content intact. */
export function upsertConnectionReference(root: string, entry: ConnectionReferenceEntry): string {
  const existing = readConnectionReferences(root);
  const file = existing.file ?? path.join(root, CR_FILE_CANDIDATES[0]);
  let doc: Record<string, unknown> = { kind: "ConnectionReferencesSourceFile", connectionReferences: [] };
  if (existing.file) {
    const loaded = readYamlFile<Record<string, unknown> | null>(existing.file);
    if (loaded && !Array.isArray(loaded)) doc = loaded;
  }
  const list = (Array.isArray(doc.connectionReferences) ? doc.connectionReferences : []) as ConnectionReferenceEntry[];
  const idx = list.findIndex((e) => e.connectionReferenceLogicalName === entry.connectionReferenceLogicalName);
  const merged: ConnectionReferenceEntry = { id: entry.id ?? newId("cr").replace("cr_", ""), ...(idx >= 0 ? list[idx] : {}), ...entry };
  if (idx >= 0) list[idx] = merged;
  else list.push(merged);
  doc.connectionReferences = list;
  fs.writeFileSync(file, yamlDump(doc), "utf8");
  return file;
}

/** Connector name (shared_x) from a connection reference logical name such as `<schema>.shared_x.abc123`. */
export function connectorFromReference(logicalName: string, entries: ConnectionReferenceEntry[] = []): string | null {
  const entry = entries.find((e) => e.connectionReferenceLogicalName === logicalName);
  const fromEntry = entry?.connectorId?.split("/").pop();
  if (fromEntry) return fromEntry;
  const m = /(shared_[a-z0-9_]+)/i.exec(logicalName);
  return m ? m[1] : null;
}

/** Everything about the tool except what it invokes: metadata, what the orchestrator routes on, inputs and outputs. */
function toolDocument(spec: ToolSpec): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    "mcs.metadata": { componentName: spec.name, description: spec.description },
    kind: "TaskDialog",
  };
  const inputs = buildInputs(spec.inputs);
  if (inputs) doc.inputs = inputs;
  doc.modelDisplayName = spec.modelDisplayName ?? spec.name;
  doc.modelDescription = spec.modelDescription ?? spec.description;
  if (spec.outputs && spec.outputs.length) doc.outputs = spec.outputs.map((o) => ({ propertyName: o }));
  return doc;
}

/** What the tool invokes, plus whatever a connector-backed tool needs on the side. */
interface BuiltAction {
  action: Record<string, unknown>;
  connectionReference: string | null;
  /** connectionreferences.mcs.yml, when this tool added an entry to it. */
  crFile: string | null;
  /** The step only a person can do in the portal, when the connection is not bound yet. */
  portalStep: string | null;
}

/**
 * Connector and MCP tools reach their service through a connection reference:
 * reuse the one named, or mint one, register it, and say what the maker still
 * has to authorise.
 */
function connectorAction(root: string, spec: Extract<ToolSpec, { type: "connector" | "mcp" }>, agentSchemaName?: string): BuiltAction {
  const prefix = agentSchemaName ?? "<AGENT_SCHEMA>";
  const connectionReference = spec.connectionReference ?? `${prefix}.${spec.connectorId}.${newId("x").slice(2).toLowerCase()}`;
  const existing = readConnectionReferences(root).entries.find((e) => e.connectionReferenceLogicalName === connectionReference);
  const crFile = upsertConnectionReference(root, {
    connectionReferenceLogicalName: connectionReference,
    connectorId: existing?.connectorId ?? spec.connectorId,
    displayName: existing?.displayName ?? `${spec.name} connection`,
    ...(existing?.connectionId ? { connectionId: existing.connectionId } : {}),
  });
  const portalStep = existing?.connectionId
    ? null
    : [
        `Connector '${spec.connectorId}' needs an authorised connection before this tool can run.`,
        "In Copilot Studio open the agent > Tools > Add a tool, pick the same connector/operation, sign in to create the connection, then pull the workspace so the connection id lands in connectionreferences.mcs.yml.",
        "Alternatively bind the connection reference after pushing, in the agent's Tools page.",
      ].join(" ");
  const mode = spec.connectionMode ?? "Invoker";
  const action =
    spec.type === "connector"
      ? { kind: "InvokeConnectorTaskAction", connectionReference, connectionProperties: { mode }, operationId: spec.operationId }
      : { kind: "InvokeExternalAgentTaskAction", connectionReference, connectionProperties: { mode }, operationDetails: { kind: "ModelContextProtocolMetadata", operationId: spec.operationId ?? "InvokeMCP" } };
  return { action, connectionReference, crFile, portalStep };
}

function buildAction(root: string, spec: ToolSpec, agentSchemaName?: string): BuiltAction {
  const plain = (action: Record<string, unknown>): BuiltAction => ({ action, connectionReference: null, crFile: null, portalStep: null });
  switch (spec.type) {
    case "flow":
      return plain({ kind: "InvokeFlowTaskAction", flowId: spec.flowId });
    case "prompt":
      return plain({ kind: "InvokeAIBuilderModelTaskAction", aIModelId: spec.aiModelId });
    case "connected-agent":
      return plain({ kind: "InvokeConnectedAgentTaskAction", botSchemaName: spec.botSchemaName, ...(spec.shouldSendStartConversation === undefined ? {} : { shouldSendStartConversation: spec.shouldSendStartConversation }) });
    case "child-agent":
      return plain({ kind: "InvokeAgentTaskAction", gptComponentSchemaName: spec.gptComponentSchemaName });
    case "raw": {
      if (typeof spec.action.kind !== "string") throw new Error("raw tool needs action.kind");
      if (!(spec.action.kind in TOOL_KIND_SUPPORT)) throw new Error(`Unknown TaskAction kind '${spec.action.kind}'. Known: ${Object.keys(TOOL_KIND_SUPPORT).join(", ")}`);
      const cr = spec.action.connectionReference;
      return { ...plain(spec.action), connectionReference: typeof cr === "string" ? cr : null };
    }
    case "connector":
    case "mcp":
      return connectorAction(root, spec, agentSchemaName);
    default:
      throw new Error(`Unknown tool type ${(spec as { type: string }).type}`);
  }
}

export function addTool(root: string, spec: ToolSpec, agentSchemaName?: string): ToolResult {
  const componentName = pascal(spec.name);
  const header = [`Name: ${spec.name}`, `Description: ${spec.description}`];
  const doc = toolDocument(spec);
  const { action, connectionReference, crFile, portalStep } = buildAction(root, spec, agentSchemaName);
  doc.action = action;
  doc.outputMode = spec.outputMode ?? "All";

  const file = writeComponentFile(path.join(root, "actions", `${pascal(spec.name)}.mcs.yml`), header, doc, { overwrite: spec.overwrite });
  return {
    file,
    componentName,
    actionKind: String(action.kind),
    connectionReference,
    connectionReferencesFile: crFile,
    portalStep,
    note: `Wrote ${path.relative(root, file)}${crFile ? ` and updated ${path.basename(crFile)}` : ""}. Push the workspace to apply.`,
  };
}

/** Parse an existing tool file for editing (returns doc + header comment lines). */
export function readToolFile(file: string): { header: string[]; doc: Record<string, unknown> } {
  const text = fs.readFileSync(file, "utf8");
  const header = text
    .split(/\r?\n/)
    .filter((l, i, arr) => l.startsWith("#") && arr.slice(0, i).every((p) => p.startsWith("#")))
    .map((l) => l.replace(/^#\s?/, ""));
  return { header, doc: (yaml.load(text) as Record<string, unknown>) ?? {} };
}
