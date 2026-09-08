/**
 * Build a Power Automate cloud flow definition from a small step spec, the way
 * `topics.ts` builds a topic from nodes.
 *
 * The caller says what the flow should do (a trigger plus steps: connector
 * operations, Dataverse rows, HTTP calls, conditions, loops, variables, a
 * response); this module emits the Logic Apps definition Power Automate
 * expects, chains `runAfter` in order, and collects the connection references
 * every connector step needs.
 *
 * UNVERIFIED: the shapes follow the definitions of exported solutions and the
 * Logic Apps workflow schema. Nothing here has been imported into a live
 * environment yet, so treat a generated flow as a draft to check.
 *
 * Power Fx is not used here: expressions are Logic Apps expressions
 * (`@{triggerBody()?['name']}`), which is what this format takes.
 */
import { pascal } from "./util.js";

export type FlowValueType = "string" | "number" | "boolean" | "object" | "array";

export interface FlowParam {
  name: string;
  type?: FlowValueType;
  description?: string;
  required?: boolean;
}

export type FlowTriggerSpec =
  /** "When an agent calls the flow": the trigger a Copilot Studio tool needs. */
  | { kind: "agent"; inputs?: FlowParam[] }
  /** Manually started (the Power Automate button trigger). */
  | { kind: "manual"; inputs?: FlowParam[] }
  /** HTTP request trigger. */
  | { kind: "http"; inputs?: FlowParam[]; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }
  /** On a schedule. */
  | { kind: "recurrence"; frequency: "Minute" | "Hour" | "Day" | "Week" | "Month"; interval?: number; startTime?: string; timeZone?: string }
  /** A connector trigger, e.g. Dataverse "when a row is added". */
  | { kind: "connector"; connectorId: string; operationId: string; parameters?: Record<string, unknown>; connectionReference?: string; recurrence?: { frequency: string; interval: number } }
  /** Anything else, written verbatim. */
  | { kind: "raw"; name?: string; json: Record<string, unknown> };

export type FlowStepSpec =
  | { type: "connector"; name: string; connectorId: string; operationId: string; parameters?: Record<string, unknown>; connectionReference?: string; description?: string }
  | { type: "http"; name: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; uri: string; headers?: Record<string, string>; body?: unknown }
  | { type: "compose"; name: string; value: unknown }
  | { type: "initializeVariable"; name: string; variable: string; valueType?: FlowValueType; value?: unknown }
  | { type: "setVariable"; name: string; variable: string; value: unknown }
  | { type: "condition"; name: string; expression: string; then: FlowStepSpec[]; else?: FlowStepSpec[] }
  | { type: "foreach"; name: string; items: string; actions: FlowStepSpec[] }
  | { type: "scope"; name: string; actions: FlowStepSpec[] }
  | { type: "terminate"; name: string; status?: "Succeeded" | "Failed" | "Cancelled"; message?: string }
  /** Answer the caller (agent or HTTP trigger); placed last if omitted. */
  | { type: "response"; name?: string; outputs?: { name: string; type?: FlowValueType; value?: unknown }[] }
  | { type: "raw"; name: string; json: Record<string, unknown> };

export interface FlowBuildSpec {
  name: string;
  description?: string;
  trigger?: FlowTriggerSpec;
  steps?: FlowStepSpec[];
  /** Outputs for the response step when the steps do not include one. */
  outputs?: { name: string; type?: FlowValueType; value?: unknown }[];
  /** Prefix for generated connection reference logical names (usually the publisher prefix). */
  connectionReferencePrefix?: string;
}

export interface BuiltFlow {
  /** The whole `clientdata` document: properties.definition plus connectionReferences. */
  clientData: Record<string, unknown>;
  definition: Record<string, unknown>;
  connectionReferences: Record<string, unknown>;
  /** Connector name to connection reference logical name, for the deployment settings file. */
  connections: { connectorId: string; connectionReference: string }[];
  /** Action names in order, for a summary. */
  actionNames: string[];
  notes: string[];
}

const DEFINITION_SCHEMA = "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#";
const JSON_TYPE: Record<FlowValueType, string> = { string: "string", number: "number", boolean: "boolean", object: "object", array: "array" };

/** Power Automate keys actions by name and uses underscores where the display name has spaces. */
export function actionKey(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "_");
  return cleaned || "Action";
}

function apiId(connectorId: string): string {
  return connectorId.startsWith("/") ? connectorId : `/providers/Microsoft.PowerApps/apis/${connectorId}`;
}

function connectorName(connectorId: string): string {
  return connectorId.split("/").filter(Boolean).pop() ?? connectorId;
}

function schemaOf(params: FlowParam[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: JSON_TYPE[p.type ?? "string"], ...(p.description ? { description: p.description } : {}), title: p.name }])),
    required: params.filter((p) => p.required !== false).map((p) => p.name),
  };
}

/** Collects the connection references while steps are built. */
class ConnectionCollector {
  readonly refs: Record<string, unknown> = {};
  readonly list: { connectorId: string; connectionReference: string }[] = [];
  constructor(private readonly prefix: string) {}

  use(connectorId: string, explicit?: string): string {
    const name = connectorName(connectorId);
    const existing = this.list.find((c) => connectorName(c.connectorId) === name);
    if (existing && !explicit) return existing.connectionReference;
    const logical = explicit ?? `${this.prefix}_${name.replace(/^shared_/, "")}`;
    this.refs[name] = { runtimeSource: "embedded", connection: { connectionReferenceLogicalName: logical }, api: { name } };
    if (!existing) this.list.push({ connectorId, connectionReference: logical });
    return logical;
  }
}

function connectorAction(step: Extract<FlowStepSpec, { type: "connector" }>, conn: ConnectionCollector): Record<string, unknown> {
  const name = connectorName(step.connectorId);
  conn.use(step.connectorId, step.connectionReference);
  return {
    type: "OpenApiConnection",
    ...(step.description ? { description: step.description } : {}),
    inputs: {
      parameters: step.parameters ?? {},
      host: { apiId: apiId(step.connectorId), connectionName: name, operationId: step.operationId },
      authentication: "@parameters('$authentication')",
    },
  };
}

function responseAction(outputs: { name: string; type?: FlowValueType; value?: unknown }[]): Record<string, unknown> {
  return {
    type: "Response",
    kind: "Skills",
    inputs: {
      statusCode: 200,
      body: Object.fromEntries(outputs.map((o) => [o.name, o.value ?? ""])),
      schema: { type: "object", properties: Object.fromEntries(outputs.map((o) => [o.name, { type: JSON_TYPE[o.type ?? "string"], title: o.name }])) },
    },
  };
}

/** One step to one action, without runAfter (the caller chains). */
function buildStep(step: FlowStepSpec, conn: ConnectionCollector, notes: string[]): { key: string; action: Record<string, unknown> } {
  const key = actionKey(step.type === "response" ? (step.name ?? "Respond to the agent") : step.name);
  switch (step.type) {
    case "connector":
      return { key, action: connectorAction(step, conn) };
    case "http":
      return { key, action: { type: "Http", inputs: { method: step.method ?? "GET", uri: step.uri, ...(step.headers ? { headers: step.headers } : {}), ...(step.body !== undefined ? { body: step.body } : {}) } } };
    case "compose":
      return { key, action: { type: "Compose", inputs: step.value } };
    case "initializeVariable":
      return { key, action: { type: "InitializeVariable", inputs: { variables: [{ name: step.variable, type: JSON_TYPE[step.valueType ?? "string"], ...(step.value !== undefined ? { value: step.value } : {}) }] } } };
    case "setVariable":
      return { key, action: { type: "SetVariable", inputs: { name: step.variable, value: step.value } } };
    case "condition":
      return {
        key,
        action: {
          type: "If",
          expression: step.expression,
          actions: chain(step.then, conn, notes),
          ...(step.else?.length ? { else: { actions: chain(step.else, conn, notes) } } : {}),
        },
      };
    case "foreach":
      return { key, action: { type: "Foreach", foreach: step.items, actions: chain(step.actions, conn, notes) } };
    case "scope":
      return { key, action: { type: "Scope", actions: chain(step.actions, conn, notes) } };
    case "terminate":
      return { key, action: { type: "Terminate", inputs: { runStatus: step.status ?? "Succeeded", ...(step.message ? { runError: { message: step.message } } : {}) } } };
    case "response":
      return { key, action: responseAction(step.outputs ?? []) };
    case "raw":
      return { key, action: step.json };
    default: {
      const bad = step as { type?: string };
      throw new Error(`Unknown flow step type '${String(bad.type)}'`);
    }
  }
}

/** Build a run of steps, each waiting for the previous one to succeed. */
function chain(steps: FlowStepSpec[], conn: ConnectionCollector, notes: string[]): Record<string, unknown> {
  const actions: Record<string, unknown> = {};
  let previous: string | null = null;
  for (const step of steps) {
    const { key, action } = buildStep(step, conn, notes);
    if (actions[key]) throw new Error(`Two steps are named '${key}'; action names must be unique within a flow`);
    actions[key] = { ...action, runAfter: previous ? { [previous]: ["Succeeded"] } : {} };
    previous = key;
  }
  return actions;
}

function buildTrigger(spec: FlowTriggerSpec | undefined, conn: ConnectionCollector): { key: string; trigger: Record<string, unknown>; agentCallable: boolean } {
  const t = spec ?? { kind: "agent" as const };
  switch (t.kind) {
    case "agent":
      return { key: "When_an_agent_calls_the_flow", trigger: { type: "Request", kind: "Skills", inputs: { schema: schemaOf(t.inputs ?? []) } }, agentCallable: true };
    case "manual":
      return { key: "manual", trigger: { type: "Request", kind: "Button", inputs: { schema: schemaOf(t.inputs ?? []) } }, agentCallable: false };
    case "http":
      return { key: "manual", trigger: { type: "Request", kind: "Http", inputs: { schema: schemaOf(t.inputs ?? []), method: t.method ?? "POST" } }, agentCallable: false };
    case "recurrence":
      return { key: "Recurrence", trigger: { type: "Recurrence", recurrence: { frequency: t.frequency, interval: t.interval ?? 1, ...(t.startTime ? { startTime: t.startTime } : {}), ...(t.timeZone ? { timeZone: t.timeZone } : {}) } }, agentCallable: false };
    case "connector": {
      const name = connectorName(t.connectorId);
      conn.use(t.connectorId, t.connectionReference);
      return {
        key: actionKey(`When ${t.operationId}`),
        trigger: {
          type: "OpenApiConnection",
          inputs: { parameters: t.parameters ?? {}, host: { apiId: apiId(t.connectorId), connectionName: name, operationId: t.operationId }, authentication: "@parameters('$authentication')" },
          ...(t.recurrence ? { recurrence: t.recurrence } : { recurrence: { frequency: "Minute", interval: 5 } }),
        },
        agentCallable: false,
      };
    }
    case "raw":
      return { key: actionKey(t.name ?? "Trigger"), trigger: t.json, agentCallable: false };
    default: {
      const bad = t as { kind?: string };
      throw new Error(`Unknown flow trigger kind '${String(bad.kind)}'`);
    }
  }
}

/**
 * Compose the whole flow. Steps run in order; a response step is appended for
 * agent-callable and HTTP flows when the caller did not write one.
 */
export function buildFlow(spec: FlowBuildSpec): BuiltFlow {
  if (!spec.name?.trim()) throw new Error("A flow needs a name");
  const notes: string[] = [];
  const conn = new ConnectionCollector(spec.connectionReferencePrefix ?? "cr");
  const { key: triggerKey, trigger, agentCallable } = buildTrigger(spec.trigger, conn);

  const steps = [...(spec.steps ?? [])];
  const wasEmpty = steps.length === 0;
  const hasResponse = steps.some((s) => s.type === "response");
  if (agentCallable && !hasResponse) {
    steps.push({ type: "response", outputs: spec.outputs ?? [] });
    if (!spec.outputs?.length) notes.push("No outputs given: the flow answers the agent with an empty body. Add outputs so the agent gets something back.");
  } else if (!agentCallable && spec.outputs?.length && !hasResponse) {
    notes.push("Outputs were given but this trigger does not answer a caller; they were ignored.");
  }
  if (wasEmpty) notes.push("The flow has no steps: it will run and do nothing.");

  const actions = chain(steps, conn, notes);
  const definition = {
    $schema: DEFINITION_SCHEMA,
    contentVersion: "1.0.0.0",
    parameters: { $connections: { defaultValue: {}, type: "Object" }, $authentication: { defaultValue: {}, type: "SecureObject" } },
    triggers: { [triggerKey]: trigger },
    actions,
  };
  if (conn.list.length) notes.push(`${conn.list.length} connection reference(s) are needed: ${conn.list.map((c) => c.connectionReference).join(", ")}. The connections themselves must exist in the environment (cs_list_connections), and a flow only turns on once they are bound.`);

  return {
    clientData: { properties: { connectionReferences: conn.refs, definition }, schemaVersion: "1.0.0.0" },
    definition,
    connectionReferences: conn.refs,
    connections: conn.list,
    actionNames: Object.keys(actions),
    notes,
  };
}

/** Workspace metadata for `workflows/<Name>/metadata.yaml`. */
export function flowMetadata(spec: FlowBuildSpec, schemaName?: string): Record<string, unknown> {
  return {
    kind: "CloudFlowDefinition",
    displayName: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    schemaName: schemaName ?? `<PUBLISHER_PREFIX>_${pascal(spec.name)}`,
  };
}
