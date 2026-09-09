/**
 * Tools: cloud flows.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { buildFlow, buildFlowUpdate, type FlowBuildSpec, type FlowStepSpec, type FlowTriggerSpec } from "../authoring/flowBuilder.js";

import { getToken } from "../auth.js";
import { createFlow, dataverseScope, getFlow, listFlows, setFlowState, updateFlow } from "../cloud/dataverse.js";
import { FLOW_SCOPE, getFlowRun, listFlowRuns, startFlowRun } from "../cloud/flowruns.js";
import { clientArg, cloudContext, confirmArg, dryRun, envArg, fail, server, tenantArg, text, workspaceArg } from "./shared.js";

// ---- cloud flows (Dataverse workflow rows) ---------------------------------

const flowParam = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "object", "array"]).optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

const flowOutput = z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "object", "array"]).optional(), value: z.unknown().optional() });

/** One step. Nested steps (condition, foreach, scope) take the same shape, expressed loosely so zod stays finite. */
const flowStep: z.ZodType<FlowStepSpec> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("connector"), name: z.string(), connectorId: z.string().describe("e.g. shared_office365 (cs_list_connectors)"), operationId: z.string().describe("cs_describe_connector lists them"), parameters: z.record(z.unknown()).optional(), connectionReference: z.string().optional(), description: z.string().optional() }),
    z.object({ type: z.literal("http"), name: z.string(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(), uri: z.string(), headers: z.record(z.string()).optional(), body: z.unknown().optional() }),
    z.object({ type: z.literal("compose"), name: z.string(), value: z.unknown() }),
    z.object({ type: z.literal("initializeVariable"), name: z.string(), variable: z.string(), valueType: z.enum(["string", "number", "boolean", "object", "array"]).optional(), value: z.unknown().optional() }),
    z.object({ type: z.literal("setVariable"), name: z.string(), variable: z.string(), value: z.unknown() }),
    z.object({ type: z.literal("condition"), name: z.string(), expression: z.string().describe("Logic Apps expression, e.g. @equals(triggerBody()?['status'],'open')"), then: z.array(flowStep), else: z.array(flowStep).optional() }),
    z.object({ type: z.literal("foreach"), name: z.string(), items: z.string().describe("Expression yielding the collection, e.g. @body('List_rows')?['value']"), actions: z.array(flowStep) }),
    z.object({ type: z.literal("scope"), name: z.string(), actions: z.array(flowStep) }),
    z.object({ type: z.literal("terminate"), name: z.string(), status: z.enum(["Succeeded", "Failed", "Cancelled"]).optional(), message: z.string().optional() }),
    z.object({ type: z.literal("response"), name: z.string().optional(), outputs: z.array(flowOutput).optional() }),
    z.object({ type: z.literal("raw"), name: z.string(), json: z.record(z.unknown()) }),
  ]) as unknown as z.ZodType<FlowStepSpec>,
);

const flowTrigger: z.ZodType<FlowTriggerSpec> = z.union([
  z.object({ kind: z.literal("agent"), inputs: z.array(flowParam).optional() }),
  z.object({ kind: z.literal("manual"), inputs: z.array(flowParam).optional() }),
  z.object({ kind: z.literal("http"), inputs: z.array(flowParam).optional(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional() }),
  z.object({ kind: z.literal("recurrence"), frequency: z.enum(["Minute", "Hour", "Day", "Week", "Month"]), interval: z.number().optional(), startTime: z.string().optional(), timeZone: z.string().optional() }),
  z.object({ kind: z.literal("connector"), connectorId: z.string(), operationId: z.string(), parameters: z.record(z.unknown()).optional(), connectionReference: z.string().optional(), recurrence: z.object({ frequency: z.string(), interval: z.number() }).optional() }),
  z.object({ kind: z.literal("raw"), name: z.string().optional(), json: z.record(z.unknown()) }),
]) as unknown as z.ZodType<FlowTriggerSpec>;

const flowSpecArgs = {
  steps: z.array(flowStep).optional().describe("Steps in order; each waits for the previous one to succeed"),
  trigger: flowTrigger.optional().describe("Default: 'agent' (When an agent calls the flow)"),
  outputs: z.array(flowOutput).optional().describe("What the flow answers with (agent-callable and HTTP flows)"),
  connectionReferencePrefix: z.string().optional().describe("Prefix for generated connection reference names, usually your publisher prefix"),
};

server.registerTool(
  "cs_build_flow_definition",
  {
    title: "Build a flow definition from steps",
    description:
      "Compose a Power Automate cloud flow definition from a step spec, without touching any environment: a trigger (agent-callable by default, or manual, HTTP, schedule or a connector trigger) plus steps (connector operations, HTTP calls, conditions, loops, scopes, variables, compose, terminate, response, or raw JSON). Steps run in order. Returns the definition, the connection references it needs and any notes, and can write it to a file. Feed the same spec to cs_create_flow to create the flow, or cs_update_flow to replace an existing one. Use cs_list_connectors and cs_describe_connector to find connector ids, operation ids and their parameters first.",
    inputSchema: { name: z.string(), description: z.string().optional(), ...flowSpecArgs, outputFile: z.string().optional().describe("Write the definition JSON here as well") },
  },
  async (a) => {
    try {
      const built = buildFlow(a as unknown as FlowBuildSpec);
      let file: string | null = null;
      if (a.outputFile) {
        file = path.resolve(a.outputFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(built.clientData, null, 2)}\n`);
      }
      return text({ name: a.name, actions: built.actionNames, connections: built.connections, notes: built.notes, ...(file ? { file } : {}), definition: built.definition, connectionReferences: built.connectionReferences });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

const flowArgs = { environmentId: envArg, dataverseUrl: z.string().optional().describe("Dataverse URL; default: from the workspace or the environment"), workspace: workspaceArg, tenantId: tenantArg, clientId: clientArg };

/** Dataverse URL and token for a flow tool (interactive sign-in allowed, unlike the drift reader). */
async function flowContext(a: { environmentId?: string; dataverseUrl?: string; workspace?: string; tenantId?: string; clientId?: string }): Promise<{ url: string; token: string }> {
  const ctx = await cloudContext(a, { dataverse: true });
  const tok = await getToken(ctx.authCfg, [dataverseScope(ctx.dataverseUrl as string)]);
  return { url: ctx.dataverseUrl as string, token: tok.accessToken };
}

server.registerTool(
  "cs_list_flows",
  {
    title: "List cloud flows",
    description: "Cloud flows (Power Automate) in the environment with their state, owner and last change: what the agent's flow tools can call, and what a solution import left switched off. Read-only.",
    inputSchema: { ...flowArgs, search: z.string().optional().describe("Only flows whose name contains this text"), includeManaged: z.boolean().optional().describe("Default true; false lists only unmanaged flows"), top: z.number().optional().describe("Maximum rows") },
  },
  async (a) => {
    try {
      const dv = await flowContext(a);
      const flows = await listFlows(dv.url, dv.token, { search: a.search, includeManaged: a.includeManaged, top: a.top });
      return text({ count: flows.length, flows, ...(flows.some((f) => f.state !== "Activated") ? { note: "Flows that are not Activated do not run. cs_set_flow_state turns one on once its connections are bound." } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_get_flow",
  {
    title: "Read one cloud flow",
    description: "One flow with its definition: trigger and action names, connection references, and the full Power Automate definition when 'includeDefinition' is set. Read-only. Use it before cs_update_flow, and to see why a flow cannot be switched on.",
    inputSchema: { ...flowArgs, flowId: z.string().describe("Flow (workflow) id; cs_list_flows shows it"), includeDefinition: z.boolean().optional().describe("Include the full definition JSON (large)") },
  },
  async (a) => {
    try {
      const dv = await flowContext(a);
      const f = await getFlow(dv.url, dv.token, a.flowId);
      const { clientData, clientDataRaw, ...rest } = f;
      return text({ ...rest, ...(a.includeDefinition ? { definition: (clientData?.properties as Record<string, unknown> | undefined)?.definition ?? null, clientData } : { definitionOmitted: "pass includeDefinition: true for the full JSON" }) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_set_flow_state",
  {
    title: "Turn a cloud flow on or off",
    description: "Switch a flow on (Activated) or off (Draft). This is the step a solution import leaves for you: flows whose connection references were unbound at import time land switched off. A flow can only be turned on once its connections are bound and its definition is valid. Changes a live environment: requires confirm: true.",
    inputSchema: { ...flowArgs, flowId: z.string().describe("Flow (workflow) id"), state: z.enum(["on", "off"]).describe("on = Activated, off = Draft"), confirm: confirmArg },
  },
  async (a) => {
    try {
      const dv = await flowContext(a);
      const before = await getFlow(dv.url, dv.token, a.flowId);
      if (!a.confirm) return dryRun(`turn flow '${before.name}' ${a.state} (currently ${before.state}) in ${dv.url}`, { flowId: a.flowId, connectionReferences: before.connectionReferences });
      return text(await setFlowState(dv.url, dv.token, a.flowId, a.state));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_update_flow",
  {
    title: "Update a cloud flow",
    description: "Change a flow's name, description or definition in the environment. Pass 'steps' (and optionally 'trigger') to rebuild the definition the way cs_build_flow_definition does, or 'definition' for a ready-made one; either replaces properties.definition inside the existing clientdata and keeps the connection references. 'clientData' replaces the whole document. Read the current one with cs_get_flow includeDefinition first. Managed flows cannot be edited in place; edit them in their source environment or through a solution. Changes a live environment: requires confirm: true.",
    inputSchema: {
      ...flowArgs,
      flowId: z.string().describe("Flow (workflow) id"),
      name: z.string().optional(),
      description: z.string().optional(),
      ...flowSpecArgs,
      definition: z.record(z.unknown()).optional().describe("Power Automate definition object (properties.definition), instead of steps"),
      clientData: z.record(z.unknown()).optional().describe("The whole clientdata document; overrides 'definition'"),
      connectionReferences: z.record(z.unknown()).optional().describe("Connection reference entries to add or explicitly replace; existing entries are otherwise preserved"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const dv = await flowContext(a);
      const before = await getFlow(dv.url, dv.token, a.flowId);
      const { rebuilt, changes } = buildFlowUpdate(before, a);
      const fields = Object.entries(changes).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (!fields.length) return fail("Nothing to update: pass name, description, definition or clientData");
      if (!a.confirm) return dryRun(`update flow '${before.name}' (${fields.join(", ")}) in ${dv.url}`, { flowId: a.flowId, isManaged: before.isManaged, state: before.state, ...(before.isManaged ? { warning: "This flow is managed; Dataverse refuses in-place edits of managed flows." } : {}) });
      return text({ ...(await updateFlow(dv.url, dv.token, a.flowId, changes)), ...(rebuilt ? { actions: rebuilt.actionNames, connections: rebuilt.connections, notes: rebuilt.notes } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_create_flow",
  {
    title: "Create a cloud flow",
    description:
      "Create a new Power Automate cloud flow, from a step spec (see cs_build_flow_definition: trigger plus connector, HTTP, condition, loop, variable and response steps) or from a ready-made definition, optionally straight into a solution. The flow is created switched off, because a flow can only be activated once its connection references are bound: bind them, then cs_set_flow_state on. To let an agent call it, use a trigger of type Request/kind Skills and add it as a tool with cs_add_tool type 'flow'. Changes a live environment: requires confirm: true.",
    inputSchema: {
      ...flowArgs,
      name: z.string().describe("Flow display name"),
      ...flowSpecArgs,
      definition: z.record(z.unknown()).optional().describe("A ready-made Power Automate definition, instead of steps"),
      clientData: z.record(z.unknown()).optional().describe("The whole clientdata document, when you have one (from cs_get_flow of another flow, for example)"),
      connectionReferences: z.record(z.unknown()).optional().describe("properties.connectionReferences, when you pass a definition rather than steps"),
      description: z.string().optional(),
      solution: z.string().optional().describe("Unique name of the solution to create it in"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const built = a.steps || a.trigger ? buildFlow({ name: a.name, description: a.description, steps: a.steps, trigger: a.trigger, outputs: a.outputs, connectionReferencePrefix: a.connectionReferencePrefix }) : null;
      if (!a.definition && !a.clientData && !built) return fail("Pass steps (with an optional trigger) to build the flow, or a definition, or a whole clientData document.");
      const dv = await flowContext(a);
      const spec = { name: a.name, definition: a.definition, clientData: a.clientData ?? built?.clientData, description: a.description, solutionUniqueName: a.solution, connectionReferences: a.connectionReferences };
      if (!a.confirm) {
        const definition = (a.definition ?? built?.definition ?? (a.clientData?.properties as Record<string, unknown> | undefined)?.definition ?? {}) as Record<string, unknown>;
        return dryRun(`create cloud flow '${a.name}'${a.solution ? ` in solution ${a.solution}` : ""} in ${dv.url} (switched off)`, {
          triggers: Object.keys((definition.triggers as Record<string, unknown>) ?? {}),
          actions: Object.keys((definition.actions as Record<string, unknown>) ?? {}),
          connections: built?.connections ?? Object.keys(a.connectionReferences ?? {}),
          ...(built?.notes.length ? { notes: built.notes } : {}),
        });
      }
      const r = await createFlow(dv.url, dv.token, spec);
      return text({ ...r, ...(built ? { actions: built.actionNames, connections: built.connections, notes: built.notes } : {}), next: "Bind its connections, then cs_set_flow_state state='on'. cs_add_tool type='flow' with this id makes it callable by an agent." });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

/** Power Automate service token (a different resource from Dataverse), plus the environment id the run API needs. */
async function flowRunContext(a: { environmentId?: string; workspace?: string; tenantId?: string; clientId?: string }): Promise<{ environmentId: string; token: string }> {
  const ctx = await cloudContext(a, { environment: true });
  const tok = await getToken(ctx.authCfg, [FLOW_SCOPE]);
  return { environmentId: ctx.environmentId as string, token: tok.accessToken };
}

server.registerTool(
  "cs_list_flow_runs",
  {
    title: "List flow runs",
    description: "Run history of one cloud flow (most recent first): status, start and end time, duration and the error of a failed run. Read-only. Uses the Power Automate service, which is a separate sign-in from Dataverse (cs_login scope 'flow'). Unverified against a live tenant.",
    inputSchema: { environmentId: envArg, workspace: workspaceArg, tenantId: tenantArg, clientId: clientArg, flowId: z.string().describe("Flow id (cs_list_flows)"), top: z.number().optional().describe("Maximum runs to return") },
  },
  async (a) => {
    try {
      const ctx = await flowRunContext(a);
      const runs = await listFlowRuns(ctx.token, ctx.environmentId, a.flowId, { top: a.top });
      const failed = runs.filter((r) => /fail/i.test(r.status ?? ""));
      return text({ count: runs.length, failed: failed.length, runs });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_get_flow_run",
  {
    title: "Read one flow run",
    description: "One run of a cloud flow with its status, timing, trigger and error. Read-only. Uses the Power Automate service (cs_login scope 'flow'). Unverified against a live tenant.",
    inputSchema: { environmentId: envArg, workspace: workspaceArg, tenantId: tenantArg, clientId: clientArg, flowId: z.string().describe("Flow id (cs_list_flows)"), runId: z.string().describe("Run id (cs_list_flow_runs)") },
  },
  async (a) => {
    try {
      const ctx = await flowRunContext(a);
      return text(await getFlowRun(ctx.token, ctx.environmentId, a.flowId, a.runId));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_run_flow",
  {
    title: "Start a flow run",
    description:
      "Start a run of a manually triggered cloud flow, with an optional payload. Only flows whose trigger is manual or agent-callable can be started this way; scheduled and event-driven flows run on their own. Whatever the flow does (sending mail, writing records) happens for real, so this changes a live environment: requires confirm: true. Uses the Power Automate service (cs_login scope 'flow'). Unverified against a live tenant.",
    inputSchema: {
      environmentId: envArg,
      workspace: workspaceArg,
      tenantId: tenantArg,
      clientId: clientArg,
      flowId: z.string().describe("Flow id (cs_list_flows)"),
      triggerName: z.string().optional().describe("Trigger key inside the definition (cs_get_flow lists them); default 'manual'"),
      payload: z.record(z.unknown()).optional().describe("Body for the trigger"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const ctx = await flowRunContext(a);
      if (!a.confirm) return dryRun(`start flow ${a.flowId} (trigger '${a.triggerName ?? "manual"}') in environment ${ctx.environmentId}`, { warning: "The flow's actions run for real: it may send mail, write records or call external systems." });
      const r = await startFlowRun(ctx.token, ctx.environmentId, a.flowId, { triggerName: a.triggerName, payload: a.payload });
      return text({ ...r, next: "cs_list_flow_runs shows the run and its outcome." });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
