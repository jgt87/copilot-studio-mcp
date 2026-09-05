/**
 * Cloud flow scaffolding (`workflows/<Name>/metadata.yaml` + `workflow.json`).
 *
 * EXPERIMENTAL. The metadata shape follows the schema's CloudFlowDefinition
 * and the definition JSON follows the Power Automate solution format with the
 * "When an agent calls the flow" trigger (Request/Skills). Neither has been
 * round-tripped through `pac copilot push` yet; verify against a cloned flow
 * before relying on it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pascal, yamlDump } from "./util.js";

export type FlowParamType = "string" | "number" | "boolean";

export interface FlowSpec {
  name: string;
  description?: string;
  inputs?: { name: string; type?: FlowParamType; description?: string }[];
  outputs?: { name: string; type?: FlowParamType; value?: string }[];
  /** Extra Power Automate actions, keyed by action name, inserted before the response. */
  actions?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface FlowResult {
  dir: string;
  metadataFile: string;
  definitionFile: string;
  workflowId: string;
  experimental: true;
  note: string;
}

const JSON_TYPE: Record<FlowParamType, string> = { string: "string", number: "number", boolean: "boolean" };
const PFX_TYPE: Record<FlowParamType, string> = { string: "String", number: "Number", boolean: "Boolean" };

export function buildFlowDefinition(spec: FlowSpec): Record<string, unknown> {
  const inputs = spec.inputs ?? [];
  const outputs = spec.outputs ?? [];
  const inputSchema = {
    type: "object",
    properties: Object.fromEntries(inputs.map((i) => [i.name, { type: JSON_TYPE[i.type ?? "string"], ...(i.description ? { description: i.description } : {}) }])),
    required: inputs.map((i) => i.name),
  };
  const responseBody = Object.fromEntries(outputs.map((o) => [o.name, o.value ?? ""]));
  const responseSchema = {
    type: "object",
    properties: Object.fromEntries(outputs.map((o) => [o.name, { type: JSON_TYPE[o.type ?? "string"] }])),
  };
  const extra = spec.actions ?? {};
  const extraNames = Object.keys(extra);
  return {
    properties: {
      connectionReferences: {},
      definition: {
        $schema: "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        contentVersion: "1.0.0.0",
        parameters: { "$connections": { defaultValue: {}, type: "Object" }, "$authentication": { defaultValue: {}, type: "SecureObject" } },
        triggers: {
          manual: { type: "Request", kind: "Skills", inputs: { schema: inputSchema } },
        },
        actions: {
          ...extra,
          "Respond_to_the_agent": {
            type: "Response",
            kind: "Skills",
            runAfter: extraNames.length ? { [extraNames[extraNames.length - 1]]: ["Succeeded"] } : {},
            inputs: { statusCode: 200, body: responseBody, schema: responseSchema },
          },
        },
      },
    },
    schemaVersion: "1.0.0.0",
  };
}

export function buildFlowMetadata(spec: FlowSpec, workflowId: string): Record<string, unknown> {
  const rec = (items: { name: string; type?: FlowParamType; description?: string }[]) => ({
    properties: Object.fromEntries(items.map((i) => [i.name, { displayName: i.name, type: PFX_TYPE[i.type ?? "string"], ...(i.description ? { description: i.description } : {}) }])),
  });
  return {
    kind: "CloudFlowDefinition",
    displayName: spec.name,
    workflowId,
    isEnabled: true,
    triggerType: "Copilot",
    connectionType: "NoConnections",
    inputType: rec(spec.inputs ?? []),
    outputType: rec(spec.outputs ?? []),
  };
}

export function scaffoldFlow(root: string, spec: FlowSpec): FlowResult {
  const dir = path.join(root, "workflows", pascal(spec.name));
  if (fs.existsSync(dir) && !spec.overwrite) throw new Error(`Flow folder already exists: ${dir} (pass overwrite: true)`);
  fs.mkdirSync(dir, { recursive: true });
  const workflowId = randomUUID();
  const metadataFile = path.join(dir, "metadata.yaml");
  const definitionFile = path.join(dir, "workflow.json");
  fs.writeFileSync(metadataFile, `# Name: ${spec.name}\n${spec.description ? `# ${spec.description}\n` : ""}${yamlDump(buildFlowMetadata(spec, workflowId))}`, "utf8");
  fs.writeFileSync(definitionFile, JSON.stringify(buildFlowDefinition(spec), null, 2) + "\n", "utf8");
  return {
    dir,
    metadataFile,
    definitionFile,
    workflowId,
    experimental: true,
    note: "Experimental: flow scaffold written from the schema's CloudFlowDefinition and the Power Automate Request/Response (Skills) pattern. Validate with pac copilot pack, then verify in the portal after push. Use cs_add_tool type 'flow' with this workflowId to expose it to the agent.",
  };
}
