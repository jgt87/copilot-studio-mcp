/**
 * Tools: authoring.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { describeWorkspace, readWorkspace, type WorkspaceInfo } from "../workspace.js";
import { listKinds, lookupDefinition, resolveDefinition, searchDefinitions, summarizeDefinition } from "../schema.js";
import { addTopic, type ActionSpec, type TopicSpec } from "../authoring/topics.js";
import { addKnowledgeSource } from "../authoring/knowledge.js";
import { addTool, type ToolSpec } from "../authoring/tools.js";
import { catalogDir, checkOperation, inputsFromOperation, loadSeed, readConnectorDefinition, readConnectorList, searchConnectors } from "../catalog.js";
import { needsInput, rankChoices, type NeedChoice } from "../needs.js";
import { nextSteps } from "../guide.js";
import { readStamp } from "../drift.js";

import { fail, layoutNote, resolveRoot, server, text, validateWorkspaceFiles, workspaceArg } from "./shared.js";

// ---- authoring ------------------------------------------------------------

server.registerTool("cs_describe_workspace", { title: "Describe the workspace", description: "Inventory of an agent workspace: settings, instructions, topics (with trigger phrases), knowledge sources, tools, flows, triggers, variables, connection references, sync metadata.", inputSchema: { workspace: workspaceArg } }, async ({ workspace }) => {
  try {
    const root = resolveRoot(workspace);
    const ws = readWorkspace(root);
    const stamp = readStamp(root);
    return text({ ...describeWorkspace(ws), lastSync: stamp ? { operation: stamp.operation, syncedAt: stamp.syncedAt, remoteComponents: stamp.remote ? Object.keys(stamp.remote.components).length : null } : null, nextSteps: nextSteps(ws) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_validate",
  { title: "Validate workspace YAML", description: "Structural validation of every component file against the Copilot Studio authoring schema (kinds, unknown/missing properties, duplicate ids, placeholders, Power Fx prefixes, variable scopes) plus cross-file checks (connection references, topic redirects). Run before cs_push.", inputSchema: { workspace: workspaceArg, file: z.string().optional().describe("Validate a single file (relative to workspace)") } },
  async ({ workspace, file }) => {
    try {
      const root = resolveRoot(workspace);
      const v = validateWorkspaceFiles(root, file);
      return text({ valid: v.errors === 0, errors: v.errors, warnings: v.warnings, files: v.files.filter((f) => f.diagnostics.length > 0), checked: v.files.length });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_lookup_schema",
  { title: "Look up the YAML schema", description: "Inspect the Copilot Studio authoring schema: summarize or resolve a definition (e.g. Question, SearchAndSummarizeContent, KnowledgeSourceConfiguration), search by keyword, or list all kinds.", inputSchema: { name: z.string().optional(), search: z.string().optional(), resolve: z.boolean().optional().describe("Return the full resolved JSON instead of a summary"), depth: z.number().optional(), listKinds: z.boolean().optional() } },
  async ({ name, search, resolve, depth, listKinds: lk }) => {
    try {
      if (lk) return text({ kinds: listKinds() });
      if (search) return text({ matches: searchDefinitions(search) });
      if (!name) return fail("Pass name, search, or listKinds");
      if (resolve) return text(resolveDefinition(lookupDefinition(name)?.name ?? name, depth ?? 3));
      return text(summarizeDefinition(name));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

export const actionSpec: z.ZodType<ActionSpec> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), text: z.union([z.string(), z.array(z.string())]), speak: z.union([z.string(), z.array(z.string())]).optional() }),
    z.object({
      type: z.literal("question"),
      prompt: z.string(),
      variable: z.string().describe("Topic.Name (prefix optional)"),
      entity: z.enum(["String", "Boolean", "Number", "Email", "Date", "DateTime", "PhoneNumber", "URL", "Money", "PersonName", "City", "CountryOrRegion", "Organization", "Percentage", "Age", "Duration", "Color", "Language", "ZipCode", "StreetAddress", "File"]).optional(),
      choices: z.array(z.string()).optional().describe("Multiple-choice options (closed list) instead of an entity"),
      allowInterruption: z.boolean().optional(),
    }),
    z.object({ type: z.literal("condition"), cases: z.array(z.object({ condition: z.string().describe("Power Fx, e.g. Topic.Choice = \"Yes\""), actions: z.array(actionSpec) })), else: z.array(actionSpec).optional() }),
    z.object({ type: z.literal("redirect"), topic: z.string().describe("Topic name or full reference"), replace: z.boolean().optional() }),
    z.object({ type: z.literal("setVariable"), variable: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ type: z.literal("searchKnowledge"), variable: z.string().optional(), endIfAnswered: z.boolean().optional(), sources: z.array(z.string()).optional().describe("Restrict to these knowledge sources (file stems from knowledge/, or full references)"), autoSend: z.boolean().optional() }),
    z.object({ type: z.literal("card"), card: z.union([z.record(z.unknown()), z.string()]).describe("Adaptive Card JSON (object or string), version 1.5"), outputs: z.record(z.string()).optional().describe("Input card: card field id -> Topic variable; omit for a display-only card"), outputTypes: z.record(z.enum(["String", "Number", "Boolean"])).optional() }),
    z.object({ type: z.literal("transfer"), message: z.string().optional().describe("Message to the human agent"), phoneNumber: z.string().optional().describe("Transfer to a phone number instead of an agent") }),
    z.object({ type: z.literal("endConversation") }),
    z.object({ type: z.literal("http"), method: z.enum(["Get", "Post", "Put", "Patch", "Delete"]).optional(), url: z.string(), headers: z.record(z.string()).optional(), body: z.unknown().optional(), responseVariable: z.string() }),
    z.object({ type: z.literal("invokeFlow"), flowId: z.string(), input: z.record(z.string()).optional(), output: z.record(z.string()).optional() }),
    z.object({ type: z.literal("end"), clearTopicQueue: z.boolean().optional() }),
    z.object({ type: z.literal("raw"), node: z.record(z.unknown()).describe("A full DialogAction node; 'id' is added if missing") }),
  ]),
) as z.ZodType<ActionSpec>;

server.registerTool(
  "cs_add_topic",
  {
    title: "Add a topic",
    description: "Create topics/<name>.topic.mcs.yml from a declarative spec: trigger phrases (or a system trigger) plus message / question / condition / redirect / setVariable / searchKnowledge / http / invokeFlow / end / raw nodes. Validates the result. Push to apply.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      triggerPhrases: z.array(z.string()).optional().describe("User phrases that start the topic (OnRecognizedIntent)"),
      triggerKind: z.enum(["conversationStart", "unknownIntent", "escalate", "inactivity", "error", "signIn", "redirect", "planComplete"]).optional().describe("System trigger instead of phrases"),
      priority: z.number().optional(),
      actions: z.array(actionSpec),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const trigger: TopicSpec["trigger"] = a.triggerPhrases?.length ? { kind: "phrases", phrases: a.triggerPhrases } : a.triggerKind ? { kind: a.triggerKind } : { kind: "phrases", phrases: [] };
      const r = addTopic(root, { name: a.name, description: a.description, trigger, priority: a.priority, actions: a.actions, agentSchemaName: ws.schemaName ?? undefined, overwrite: a.overwrite });
      const v = validateWorkspaceFiles(root, r.file);
      return text({ ...r, validation: v.files[0]?.diagnostics ?? [], yaml: fs.readFileSync(r.file, "utf8") });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_add_knowledge_source",
  {
    title: "Add a knowledge source",
    description: "Add knowledge as YAML: kind 'public-site' (Bing-scoped website, max 2 path levels), 'sharepoint' (direct folder URL), 'graph-connector' (Microsoft Graph connector via environment variable), or 'files' (copy documents into knowledge/files for upload on push). Dataverse, AI Search and SQL knowledge are portal-only.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      kind: z.enum(["public-site", "sharepoint", "graph-connector", "files"]),
      site: z.string().optional(),
      includeSubPages: z.boolean().optional(),
      connectionEnvironmentVariable: z.string().optional(),
      connectionName: z.string().optional(),
      contentSourceDisplayName: z.string().optional(),
      files: z.array(z.string()).optional().describe("Absolute paths of documents (pdf, docx, txt, ...)"),
      triggerCondition: z.string().optional().describe("Power Fx condition restricting when this source is searched"),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      if ((a.kind === "public-site" || a.kind === "sharepoint") && !a.site) {
        return text(
          needsInput("cs_add_knowledge_source", [
            {
              argument: "site",
              question: a.kind === "sharepoint" ? "Which SharePoint site or document library should the agent search? Paste the URL." : "Which website should the agent search? Paste the URL.",
              why: a.kind === "sharepoint" ? "A SharePoint source points at one folder URL, and the signed-in user's permissions apply." : "A public website source is scoped to one URL, at most two path levels deep.",
            },
          ]),
        );
      }
      if (a.kind === "files" && !a.files?.length) {
        return text(needsInput("cs_add_knowledge_source", [{ argument: "files", question: "Which documents should the agent use? Give their full paths.", why: "File knowledge copies the documents into the workspace and uploads them on push." }]));
      }
      if (a.kind === "graph-connector" && !a.connectionEnvironmentVariable) {
        return text(needsInput("cs_add_knowledge_source", [{ argument: "connectionEnvironmentVariable", question: "Which environment variable holds the Graph connector connection?", why: "A Graph connector source is bound through an environment variable so it can differ per environment.", moreWith: "cs_describe_solution (environment variables)" }]));
      }
      const r = addKnowledgeSource(root, a);
      const yamlFile = r.files.find((f) => f.endsWith(".yml"));
      const validation = yamlFile ? validateWorkspaceFiles(root, yamlFile).files[0]?.diagnostics ?? [] : [];
      return text({ ...r, validation, layoutNote: layoutNote(readWorkspace(root)), ...(yamlFile ? { yaml: fs.readFileSync(yamlFile, "utf8") } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

export const toolInput = z.union([
  z.object({ kind: z.literal("automatic"), name: z.string(), description: z.string(), entity: z.string().optional(), shouldPromptUser: z.boolean().optional() }),
  z.object({ kind: z.literal("manual"), name: z.string(), value: z.string().describe("Literal or Power Fx (=System.User.Email)") }),
]);

server.registerTool(
  "cs_add_tool",
  {
    title: "Add a tool (connector, MCP server, flow, prompt, agent, or raw)",
    description:
      "Create actions/<name>.mcs.yml. type 'connector': a connector operation (connectorId like shared_office365, operationId like SendEmailV2; use cs_list_connectors / cs_describe_connector to find them). type 'mcp': an MCP server exposed through a connector. type 'flow': a cloud flow by id. type 'prompt': an AI Builder prompt by model id (cs_list_prompts). type 'connected-agent': another Copilot Studio agent by schema name. type 'child-agent': a child agent's GPT component. type 'raw': any other TaskAction kind with the action object supplied. When the connector definition is cached, the operationId is checked and required inputs are filled from the catalog unless inputs are given. Connector and MCP tools need a connection that only the portal can authorise; the tool writes the connection-reference stub and returns the portal step.",
    inputSchema: {
      workspace: workspaceArg,
      type: z.enum(["connector", "mcp", "flow", "prompt", "connected-agent", "child-agent", "raw"]),
      name: z.string(),
      description: z.string().describe("Also used as modelDescription unless overridden; the orchestrator routes on it"),
      modelDescription: z.string().optional(),
      connectorId: z.string().optional().describe("shared_<name> or a display name from the catalog"),
      operationId: z.string().optional(),
      connectionReference: z.string().optional().describe("Existing logical name from connectionreferences.mcs.yml"),
      connectionMode: z.enum(["Invoker", "Maker"]).optional().describe("Invoker = end user's connection; Maker = the maker's shared connection"),
      flowId: z.string().optional(),
      aiModelId: z.string().optional().describe("type prompt: AI Builder model id"),
      botSchemaName: z.string().optional().describe("type connected-agent"),
      gptComponentSchemaName: z.string().optional().describe("type child-agent"),
      action: z.record(z.unknown()).optional().describe("type raw: full TaskAction object with kind"),
      inputs: z.array(toolInput).optional(),
      inputsFromCatalog: z.boolean().optional().describe("Default true: when no inputs are given and the connector definition is cached, add automatic inputs for the operation's required parameters"),
      outputs: z.array(z.string()).optional(),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      const catalog: Record<string, unknown> = {};
      const needsConnector = a.type === "connector" || a.type === "mcp";
      if (needsConnector && !a.connectorId) {
        const { choices, total, source } = connectorChoices(root, ws.sync.environmentId, a.name);
        return text(
          needsInput("cs_add_tool", [
            {
              argument: "connectorId",
              question: a.type === "mcp" ? "Which MCP server should this tool call?" : "Which connector should this tool use?",
              why: `The connector decides what the tool can do and which connection has to be authorised. Listed from the ${source}.`,
              choices,
              totalChoices: total,
              moreWith: "cs_list_connectors (search, mcpOnly, customOnly)",
            },
          ]),
        );
      }
      const connector = resolveConnectorId(root, ws, a.connectorId, catalog);
      if ("error" in connector) {
        const { choices, total } = connectorChoices(root, ws.sync.environmentId, a.connectorId);
        if (!choices.length) return fail(connector.error);
        return text(
          needsInput("cs_add_tool", [
            { argument: "connectorId", question: `'${a.connectorId}' matches more than one connector. Which one did you mean?`, choices, totalChoices: total, moreWith: "cs_list_connectors" },
          ]),
        );
      }
      if (needsConnector && connector.id && !a.operationId) {
        const ops = operationChoices(root, ws.sync.environmentId, connector.id, a.name);
        return text(
          needsInput("cs_add_tool", [
            {
              argument: "operationId",
              question: `Which operation of ${connector.id} should the tool call?`,
              why: ops ? "One tool calls one operation." : `The connector definition is not cached yet, so the operations cannot be listed here.`,
              ...(ops ? { choices: ops.choices, totalChoices: ops.total } : {}),
              moreWith: `cs_describe_connector connector=${connector.id}`,
            },
          ]),
        );
      }
      if (a.type === "flow" && !a.flowId) {
        return text(needsInput("cs_add_tool", [{ argument: "flowId", question: "Which cloud flow should the agent be able to call?", why: "A flow tool refers to an existing flow by id.", moreWith: "cs_list_flows" }]));
      }
      if (a.type === "prompt" && !a.aiModelId) {
        return text(needsInput("cs_add_tool", [{ argument: "aiModelId", question: "Which AI Builder prompt should the tool run?", moreWith: "cs_list_prompts" }]));
      }
      if (a.type === "connected-agent" && !a.botSchemaName) {
        return text(needsInput("cs_add_tool", [{ argument: "botSchemaName", question: "Which agent should this agent be able to hand work to?", why: "A connected agent is referenced by its schema name.", moreWith: "cs_list_agents" }]));
      }
      const inputs = a.type === "connector" && connector.id && a.operationId ? catalogInputs({ root, environmentId: ws.sync.environmentId, connectorId: connector.id, operationId: a.operationId }, a, catalog) : { inputs: a.inputs };
      if ("error" in inputs) return fail(inputs.error);
      const spec = buildToolSpec({ ...a, connectorId: connector.id, inputs: inputs.inputs });
      if (typeof spec === "string") return fail(spec);
      const r = addTool(root, spec, ws.schemaName ?? undefined);
      const validation = validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [];
      return text({ ...r, catalog, validation, layoutNote: layoutNote(ws), yaml: fs.readFileSync(r.file, "utf8") });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

type AddToolArgs = {
  type: "connector" | "mcp" | "flow" | "prompt" | "connected-agent" | "child-agent" | "raw";
  name: string;
  description: string;
  modelDescription?: string;
  connectorId?: string;
  operationId?: string;
  connectionReference?: string;
  connectionMode?: "Invoker" | "Maker";
  flowId?: string;
  aiModelId?: string;
  botSchemaName?: string;
  gptComponentSchemaName?: string;
  action?: Record<string, unknown>;
  inputs?: z.infer<typeof toolInput>[];
  inputsFromCatalog?: boolean;
  outputs?: string[];
  overwrite?: boolean;
};

/** Connectors to offer when the caller has not picked one, ranked by what the user said. */
function connectorChoices(root: string | undefined, environmentId: string | null, search?: string): { choices: NeedChoice[]; total: number; source: string } {
  const cached = root && environmentId ? readConnectorList(catalogDir(root), environmentId)?.connectors : null;
  // The environment catalog and the offline seed carry different fields; reduce both to a choice.
  const all: NeedChoice[] = cached
    ? cached.map((c) => ({ value: c.name, label: c.displayName, ...(c.mcpLikely ? { detail: "MCP server" } : c.isCustom ? { detail: "custom connector" } : {}) }))
    : loadSeed().map((c) => ({ value: c.name, label: c.displayName }));
  const ranked = search ? rankChoices(all, search, (c) => `${c.label ?? ""} ${c.value}`) : all;
  // A search that matches nothing must not leave the user with no options to pick from.
  const matched = ranked.length > 0;
  const list = matched ? ranked : all;
  const where = cached ? "environment catalog" : "offline seed of public connectors";
  return {
    choices: list.slice(0, 200),
    total: list.length,
    source: !search ? where : matched ? `${where}, ranked against '${search}'` : `${where}; nothing matched '${search}', so all of them are listed`,
  };
}

/** Operations of a connector whose definition is cached. */
function operationChoices(root: string | undefined, environmentId: string | null, connectorId: string, search?: string): { choices: NeedChoice[]; total: number } | null {
  if (!root) return null;
  const def = readConnectorDefinition(catalogDir(root), environmentId, connectorId);
  if (!def?.operations?.length) return null;
  const ranked = rankChoices(def.operations, search, (o) => `${o.summary ?? ""} ${o.operationId}`);
  const list = search ? ranked : def.operations;
  return { choices: list.map((o) => ({ value: o.operationId, label: o.summary ?? o.operationId, ...(o.description ? { detail: String(o.description).slice(0, 120) } : {}) })), total: list.length };
}

/** A display name such as "Office 365 Outlook" is resolved through the cached list or the seed; shared_ names pass through. */
function resolveConnectorId(root: string, ws: WorkspaceInfo, connectorId: string | undefined, catalog: Record<string, unknown>): { id: string | undefined } | { error: string } {
  if (!connectorId || /^shared_/i.test(connectorId) || /^[a-z0-9_]+$/i.test(connectorId)) return { id: connectorId };
  const cached = ws.sync.environmentId ? readConnectorList(catalogDir(root), ws.sync.environmentId)?.connectors : null;
  const hit = searchConnectors(connectorId, cached ?? loadSeed());
  if (hit.length !== 1) return { error: `connectorId '${connectorId}' is ambiguous or unknown (${hit.length} matches: ${hit.slice(0, 8).map((h) => h.name).join(", ")}). Use cs_list_connectors and pass the shared_ name.` };
  catalog.resolvedConnector = { from: connectorId, to: hit[0].name, displayName: hit[0].displayName };
  return { id: hit[0].name };
}

/** Check the operation against the cached connector definition and, when no inputs were given, derive them from it. */
function catalogInputs(target: { root: string; environmentId: string | null; connectorId: string; operationId: string }, a: Pick<AddToolArgs, "inputs" | "inputsFromCatalog">, catalog: Record<string, unknown>): { inputs: AddToolArgs["inputs"] } | { error: string } {
  const chk = checkOperation(catalogDir(target.root), target.environmentId, target.connectorId, target.operationId);
  catalog.operationCheck = chk;
  if (chk.known && chk.operationFound === false) return { error: chk.message ?? "operation not found in the cached connector definition" };
  const callerGaveInputs = Boolean(a.inputs && a.inputs.length > 0);
  if (!chk.known || callerGaveInputs || a.inputsFromCatalog === false) return { inputs: a.inputs };
  const def = readConnectorDefinition(catalogDir(target.root), target.environmentId, target.connectorId);
  const op = def?.operations.find((o) => o.operationId === target.operationId);
  if (!op) return { inputs: a.inputs };
  const inputs = inputsFromOperation(op);
  catalog.inputsFromCatalog = inputs.map((i) => i.name);
  return { inputs };
}

/**
 * Per-type spec builders for addTool: which arguments the type needs, the
 * message when one is missing, and how to shape the spec.
 */
const TOOL_SPEC_BUILDERS: Record<AddToolArgs["type"], { requires: (keyof AddToolArgs)[]; missing: string; build: (a: AddToolArgs) => ToolSpec }> = {
  flow: { requires: ["flowId"], missing: "flowId is required for type 'flow'", build: (a) => ({ ...toolBase(a), type: "flow", flowId: a.flowId as string }) },
  connector: {
    requires: ["connectorId", "operationId"],
    missing: "connectorId and operationId are required for type 'connector'",
    build: (a) => ({ ...toolBase(a), ...toolConnection(a), type: "connector", connectorId: a.connectorId as string, operationId: a.operationId as string }),
  },
  mcp: {
    requires: ["connectorId"],
    missing: "connectorId is required for type 'mcp' (the connector that wraps the MCP server)",
    build: (a) => ({ ...toolBase(a), ...toolConnection(a), type: "mcp", connectorId: a.connectorId as string, operationId: a.operationId }),
  },
  prompt: { requires: ["aiModelId"], missing: "aiModelId is required for type 'prompt' (see cs_list_prompts)", build: (a) => ({ ...toolBase(a), type: "prompt", aiModelId: a.aiModelId as string }) },
  "connected-agent": { requires: ["botSchemaName"], missing: "botSchemaName is required for type 'connected-agent'", build: (a) => ({ ...toolBase(a), type: "connected-agent", botSchemaName: a.botSchemaName as string }) },
  "child-agent": { requires: ["gptComponentSchemaName"], missing: "gptComponentSchemaName is required for type 'child-agent'", build: (a) => ({ ...toolBase(a), type: "child-agent", gptComponentSchemaName: a.gptComponentSchemaName as string }) },
  raw: { requires: ["action"], missing: "action is required for type 'raw'", build: (a) => ({ ...toolBase(a), type: "raw", action: a.action as Record<string, unknown> }) },
};

function toolBase(a: AddToolArgs) {
  return { name: a.name, description: a.description, modelDescription: a.modelDescription, inputs: a.inputs, outputs: a.outputs, overwrite: a.overwrite };
}

function toolConnection(a: AddToolArgs) {
  return { connectionReference: a.connectionReference, connectionMode: a.connectionMode };
}

/** Per-type spec for addTool; returns an error message when a required field for the type is missing. */
function buildToolSpec(a: AddToolArgs): ToolSpec | string {
  const builder = TOOL_SPEC_BUILDERS[a.type] ?? TOOL_SPEC_BUILDERS.raw;
  const missing = builder.requires.some((key) => !a[key]);
  return missing ? builder.missing : builder.build(a);
}
