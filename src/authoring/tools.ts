/**
 * Tools (`actions/<name>.mcs.yml`): connector actions, MCP servers, and cloud
 * flows, plus the connection-reference registry file.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { newId, pascal, readYamlFile, writeComponentFile, yamlDump } from "./util.js";

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

export type ToolSpec = ConnectorToolSpec | McpToolSpec | FlowToolSpec;

export interface ToolResult {
  file: string;
  componentName: string;
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

export function addTool(root: string, spec: ToolSpec, agentSchemaName?: string): ToolResult {
  const componentName = pascal(spec.name);
  const header = [`Name: ${spec.name}`, `Description: ${spec.description}`];
  const doc: Record<string, unknown> = {
    "mcs.metadata": { componentName: spec.name, description: spec.description },
    kind: "TaskDialog",
  };
  const inputs = buildInputs(spec.inputs);
  if (inputs) doc.inputs = inputs;
  doc.modelDisplayName = spec.modelDisplayName ?? spec.name;
  doc.modelDescription = spec.modelDescription ?? spec.description;
  if (spec.outputs && spec.outputs.length) doc.outputs = spec.outputs.map((o) => ({ propertyName: o }));

  let connectionReference: string | null = null;
  let crFile: string | null = null;
  let portalStep: string | null = null;

  if (spec.type === "flow") {
    doc.action = { kind: "InvokeFlowTaskAction", flowId: spec.flowId };
  } else {
    const prefix = agentSchemaName ?? "<AGENT_SCHEMA>";
    connectionReference = spec.connectionReference ?? `${prefix}.${spec.connectorId}.${newId("x").slice(2).toLowerCase()}`;
    const existing = readConnectionReferences(root).entries.find((e) => e.connectionReferenceLogicalName === connectionReference);
    crFile = upsertConnectionReference(root, {
      connectionReferenceLogicalName: connectionReference,
      connectorId: existing?.connectorId ?? spec.connectorId,
      displayName: existing?.displayName ?? `${spec.name} connection`,
      ...(existing?.connectionId ? { connectionId: existing.connectionId } : {}),
    });
    if (!existing?.connectionId) {
      portalStep = [
        `Connector '${spec.connectorId}' needs an authorised connection before this tool can run.`,
        "In Copilot Studio open the agent > Tools > Add a tool, pick the same connector/operation, sign in to create the connection, then pull the workspace so the connection id lands in connectionreferences.mcs.yml.",
        "Alternatively bind the connection reference after pushing, in the agent's Tools page.",
      ].join(" ");
    }
    if (spec.type === "connector") {
      doc.action = {
        kind: "InvokeConnectorTaskAction",
        connectionReference,
        connectionProperties: { mode: spec.connectionMode ?? "Invoker" },
        operationId: spec.operationId,
      };
    } else {
      doc.action = {
        kind: "InvokeExternalAgentTaskAction",
        connectionReference,
        connectionProperties: { mode: spec.connectionMode ?? "Invoker" },
        operationDetails: { kind: "ModelContextProtocolMetadata", operationId: spec.operationId ?? "InvokeMCP" },
      };
    }
  }
  doc.outputMode = spec.outputMode ?? "All";

  const file = writeComponentFile(path.join(root, "actions", `${pascal(spec.name)}.mcs.yml`), header, doc, { overwrite: spec.overwrite });
  return {
    file,
    componentName,
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
