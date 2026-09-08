/**
 * Tools: tool catalog.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { readWorkspace } from "../workspace.js";
import { addTool } from "../authoring/tools.js";
import { catalogDir, fetchConnectorList, fetchConnectorSwagger, listPrompts, loadSeed, readConnectorDefinition, readConnectorList, searchConnectors, toDefinition, writeConnectorDefinition, writeConnectorList, type ConnectorDefinition } from "../catalog.js";
import { scaffoldFlow } from "../authoring/flows.js";
import { addTrigger } from "../authoring/triggers.js";
import { addGlobalVariable } from "../authoring/variables.js";
import { updateAgent, updateCliCopilotInstructions, updateSettings } from "../authoring/agent.js";

import { BAP_SCOPE, getToken, resolveTenantId, type AuthConfig } from "../auth.js";
import { clientArg, envArg, fail, layoutNote, resolveRoot, server, tenantArg, text, tryWorkspace, validateWorkspaceFiles, workspaceArg } from "./shared.js";

// ---- tool catalog ---------------------------------------------------------

async function powerAppsToken(args: { tenantId?: string; clientId?: string; workspace?: string }): Promise<string> {
  const ws = tryWorkspace(args.workspace);
  const cfg: AuthConfig = { tenantId: resolveTenantId(args.tenantId ?? ws?.sync.tenantId ?? undefined), clientId: args.clientId };
  return (await getToken(cfg, [BAP_SCOPE])).accessToken;
}

server.registerTool(
  "cs_list_connectors",
  {
    title: "List connectors available in an environment",
    description: "The environment's connector registry (the same list the portal's Add a tool shows): Microsoft-published and custom connectors, with an mcpLikely flag for MCP servers. Cached under .cs-catalog/<environment>/connectors.json for offline use; with search and no sign-in, falls back to the offline seed of public connectors.",
    inputSchema: { environmentId: envArg, search: z.string().optional(), customOnly: z.boolean().optional(), mcpOnly: z.boolean().optional(), refresh: z.boolean().optional().describe("Fetch again even if cached"), offline: z.boolean().optional().describe("Use cache or seed only"), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (a) => {
    try {
      const ws = tryWorkspace(a.workspace);
      const root = ws?.root;
      const environmentId = a.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID ?? null;
      const dir = catalogDir(root);
      let source = "cache";
      let list = environmentId ? (readConnectorList(dir, environmentId)?.connectors ?? null) : null;
      if ((!list || a.refresh) && !a.offline && environmentId) {
        const token = await powerAppsToken(a);
        list = await fetchConnectorList(environmentId, token);
        writeConnectorList(dir, environmentId, list);
        source = "registry";
      }
      if (!list) {
        list = loadSeed().map((s) => ({ name: s.name, id: `/providers/Microsoft.PowerApps/apis/${s.name}`, displayName: s.displayName, description: null, publisher: "Microsoft (seed)", tier: null, isCustom: false, mcpLikely: /mcp/i.test(s.name) || /\bmcp\b/i.test(s.displayName), iconUri: null }));
        source = "seed (public connector reference; confirm ids against the environment)";
      }
      let out = list;
      if (a.customOnly) out = out.filter((c) => c.isCustom);
      if (a.mcpOnly) out = out.filter((c) => c.mcpLikely);
      if (a.search) out = searchConnectors(a.search, out) as typeof out;
      return text({ environmentId, source, total: list.length, returned: Math.min(out.length, 200), connectors: out.slice(0, 200).map(({ iconUri: _i, ...c }) => c) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_describe_connector",
  {
    title: "Describe a connector's operations",
    description: "Fetch (or read from cache) a connector's OpenAPI definition and list its operations with operationId, parameters (required, type, description) and response fields; marks MCP-capable connectors (x-ms-agentic-protocol). Exactly what cs_add_tool needs. Cached under .cs-catalog/<environment>/connectors/<name>.json and used by cs_validate.",
    inputSchema: { connector: z.string().describe("shared_<name> or a display name"), environmentId: envArg, operation: z.string().optional().describe("Filter operations by id or summary"), includeInternal: z.boolean().optional(), refresh: z.boolean().optional(), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (a) => {
    try {
      const ws = tryWorkspace(a.workspace);
      const root = ws?.root;
      const environmentId = a.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID ?? null;
      const dir = catalogDir(root);
      let name = a.connector;
      if (!/^shared_/i.test(name)) {
        const pool = (environmentId ? readConnectorList(dir, environmentId)?.connectors : null) ?? loadSeed();
        const hit = searchConnectors(name, pool);
        if (hit.length !== 1) return fail(`'${name}' matched ${hit.length} connectors: ${hit.slice(0, 10).map((h) => `${h.name} (${h.displayName})`).join(", ")}. Pass the shared_ name.`);
        name = hit[0].name;
      }
      let def: ConnectorDefinition | null = a.refresh ? null : readConnectorDefinition(dir, environmentId, name);
      let source = "cache";
      if (!def) {
        if (!environmentId) return fail("environmentId is required to fetch a connector definition (or use a synced workspace)");
        const token = await powerAppsToken(a);
        const { api, swagger } = await fetchConnectorSwagger(environmentId, name, token);
        def = toDefinition(api, swagger);
        writeConnectorDefinition(dir, environmentId, def);
        source = swagger ? "registry" : "registry (no OpenAPI definition returned)";
      }
      let ops = def.operations;
      if (!a.includeInternal) ops = ops.filter((o) => o.visibility !== "internal");
      if (a.operation) {
        const q = a.operation.toLowerCase();
        ops = ops.filter((o) => o.operationId.toLowerCase().includes(q) || (o.summary ?? "").toLowerCase().includes(q));
      }
      return text({
        source,
        connector: { name: def.name, displayName: def.displayName, isCustom: def.isCustom, mcp: def.mcp, fetchedAt: def.fetchedAt },
        operationCount: def.operations.length,
        operations: ops.slice(0, 100).map((o) => ({ operationId: o.operationId, summary: o.summary, method: o.method, mcp: o.mcp, visibility: o.visibility, requiredParameters: o.parameters.filter((p) => p.required).map((p) => `${p.name}${p.type ? `:${p.type}` : ""}`), optionalParameters: o.parameters.filter((p) => !p.required).map((p) => p.name), responseProperties: o.responseProperties })),
        usage: def.mcp ? `cs_add_tool type=mcp connectorId=${def.name}` : `cs_add_tool type=connector connectorId=${def.name} operationId=<operationId>`,
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_list_prompts", { title: "List AI Builder prompts / models", description: "pac copilot model list: AI Builder models (including custom prompts) in the environment, with ids for cs_add_tool type 'prompt'.", inputSchema: { environment: z.string().optional().describe("Environment id or URL; default active pac profile"), activeOnly: z.boolean().optional(), search: z.string().optional() } }, async ({ environment, activeOnly, search }) => {
  try {
    let rows = await listPrompts(environment);
    if (activeOnly) rows = rows.filter((r) => /^active$/i.test(r.state));
    if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
    return text({ count: rows.length, prompts: rows });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_add_flow",
  {
    title: "Scaffold a cloud flow (experimental)",
    description: "EXPERIMENTAL: write workflows/<Name>/metadata.yaml + workflow.json for a flow with the 'when an agent calls the flow' trigger and a response, optionally exposing it as a tool. Format follows the schema's CloudFlowDefinition and the Power Automate solution JSON; verify with cs_pack and in the portal after push.",
    inputSchema: {
      workspace: workspaceArg,
      name: z.string(),
      description: z.string().optional(),
      inputs: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]).optional(), description: z.string().optional() })).optional(),
      outputs: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean"]).optional(), value: z.string().optional().describe("Power Automate expression for the response value") })).optional(),
      actions: z.record(z.unknown()).optional().describe("Extra Power Automate actions (name -> definition) inserted before the response"),
      addTool: z.boolean().optional().describe("Also create actions/<name>.mcs.yml invoking this flow"),
      overwrite: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = scaffoldFlow(root, a);
      const ws = readWorkspace(root);
      let tool: unknown = null;
      if (a.addTool) tool = addTool(root, { type: "flow", name: a.name, description: a.description ?? `Runs the ${a.name} flow`, flowId: r.workflowId, overwrite: a.overwrite }, ws.schemaName ?? undefined);
      return text({ ...r, tool, layoutNote: layoutNote(ws) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_add_trigger", { title: "Add an event trigger", description: "Create trigger/<name>.trigger.mcs.yml pointing at a cloud flow that starts the agent (WorkflowExternalTrigger).", inputSchema: { workspace: workspaceArg, name: z.string(), description: z.string().optional(), flowId: z.string(), overwrite: z.boolean().optional() } }, async (a) => {
  try {
    const root = resolveRoot(a.workspace);
    const r = addTrigger(root, a);
    return text({ ...r, validation: validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [], layoutNote: layoutNote(readWorkspace(root)) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool("cs_add_variable", { title: "Add a global variable", description: "Create variables/<name>.variable.mcs.yml (GlobalVariableComponent, conversation scope).", inputSchema: { workspace: workspaceArg, name: z.string(), description: z.string().optional(), defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(), aiVisibility: z.enum(["UseInAIContext", "Hidden"]).optional(), overwrite: z.boolean().optional() } }, async (a) => {
  try {
    const root = resolveRoot(a.workspace);
    const ws = readWorkspace(root);
    return text({ ...addGlobalVariable(root, { ...a, agentSchemaName: ws.schemaName ?? undefined }), layoutNote: layoutNote(ws) });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_update_agent",
  {
    title: "Update the agent's settings",
    description: "Edit agent.mcs.yml (standard harness): instructions, display name, conversation starters, model hint, and the settings the portal groups under responses and generative AI: response instructions (wording and formatting), response mode, conversation history, capability toggles (web browsing, code interpreter, image generation, Teams / SharePoint / email / meeting / people search), whether the model may use its own general knowledge, content moderation level, file analysis and semantic search. Local file change; cs_push applies it. For GitHub Copilot harness (cli-copilot) workspaces the instructions go into settings.mcs.yml.",
    inputSchema: {
      workspace: workspaceArg,
      instructions: z.string().optional().describe("Replace the instructions"),
      appendInstructions: z.string().optional().describe("Add a paragraph to the instructions"),
      displayName: z.string().optional(),
      conversationStarters: z.array(z.object({ title: z.string(), text: z.string() })).optional(),
      addConversationStarters: z.array(z.object({ title: z.string(), text: z.string() })).optional(),
      modelNameHint: z.string().optional().describe("Model hint, e.g. GPT5Chat"),
      responseInstructions: z.string().optional().describe("How answers should be worded and formatted (the portal's response instructions), separate from the main instructions"),
      appendResponseInstructions: z.string().optional(),
      defaultResponseMode: z.enum(["Auto", "ThinkDeeper", "QuickResponse"]).optional().describe("Response mode: Auto, ThinkDeeper (more reasoning, slower) or QuickResponse"),
      history: z.enum(["none", "conversation"]).optional().describe("Whether the agent sees conversation history"),
      historyMessages: z.number().optional().describe("How many past user messages to include (with history: conversation)"),
      capabilities: z
        .object({
          webBrowsing: z.boolean().optional(),
          codeInterpreter: z.boolean().optional(),
          generateImages: z.boolean().optional(),
          searchTeams: z.boolean().optional(),
          searchOneDriveAndSharePoint: z.boolean().optional(),
          searchEmails: z.boolean().optional(),
          searchMeetings: z.boolean().optional(),
          searchPeople: z.boolean().optional(),
          searchPeopleIncludeRelatedContent: z.boolean().optional(),
        })
        .optional()
        .describe("Capability toggles; only the ones you pass are changed"),
      useModelKnowledge: z.boolean().optional().describe("Whether the model may answer from its own general knowledge as well as the knowledge sources"),
      contentModeration: z.enum(["Minimum", "Low", "Medium", "High", "Maximum"]).optional(),
      isFileAnalysisEnabled: z.boolean().optional(),
      isSemanticSearchEnabled: z.boolean().optional(),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const ws = readWorkspace(root);
      if (ws.harness === "github-copilot") {
        if (!a.instructions) return fail("cli-copilot workspaces only support 'instructions' here");
        return text(updateCliCopilotInstructions(root, a.instructions));
      }
      return text(updateAgent(root, a));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_update_settings", { title: "Update settings.mcs.yml", description: "Set values in settings.mcs.yml by dot path, e.g. {\"configuration.settings.GenerativeActionsEnabled\": true}. Do not change authoringModel/recognizer/template.", inputSchema: { workspace: workspaceArg, patch: z.record(z.unknown()) } }, async ({ workspace, patch }) => {
  try {
    const forbidden = Object.keys(patch).filter((k) => /authoringModel|recognizer\.kind|^template$/.test(k));
    if (forbidden.length) return fail(`Refusing to change ${forbidden.join(", ")}: the tooling relies on them`);
    return text(updateSettings(resolveRoot(workspace), patch));
  } catch (err) {
    return fail(errorMessage(err));
  }
});
