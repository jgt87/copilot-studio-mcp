/**
 * Tools: day-two authoring.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { runPac } from "../pac.js";
import { readWorkspace } from "../workspace.js";
import { editKnowledge, editTool, editTopic, removeComponent } from "../authoring/edit.js";
import { renderReviewMarkdown, reviewWorkspace } from "../review.js";

import { confirmArg, dryRun, envOrProfile, fail, pacSummary, resolveRoot, server, text, validateWorkspaceFiles, workspaceArg } from "./shared.js";
import { actionSpec, toolInput } from "./authoring.js";

// ---- day-two authoring: edit, remove, delete, review ----------------------

server.registerTool(
  "cs_edit_topic",
  {
    title: "Edit a topic",
    description: "Change an existing topic in place, keeping its comment header: rename, description, trigger phrases (set / add / remove), priority, append or insert nodes (same node spec as cs_add_topic), remove top-level nodes by id. Validates the file afterwards.",
    inputSchema: {
      workspace: workspaceArg,
      topic: z.string().describe("Topic name, file stem or path"),
      rename: z.string().optional(),
      description: z.string().optional(),
      setTriggerPhrases: z.array(z.string()).optional(),
      addTriggerPhrases: z.array(z.string()).optional(),
      removeTriggerPhrases: z.array(z.string()).optional(),
      priority: z.number().nullable().optional().describe("null removes the priority"),
      appendActions: z.array(actionSpec).optional(),
      insertActions: z.object({ at: z.number(), actions: z.array(actionSpec) }).optional(),
      removeActionIds: z.array(z.string()).optional().describe("ids of top-level nodes (see cs_describe_workspace or the file)"),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = editTopic(root, { ...a, agentSchemaName: readWorkspace(root).schemaName ?? undefined });
      return text({ ...r, validation: validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [] });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_edit_tool",
  {
    title: "Edit a tool",
    description: "Change an existing tool file: name, description, modelDescription / modelDisplayName (what the orchestrator routes on), operationId, connection mode or reference, output mode, and inputs (set / add / remove). Validates afterwards.",
    inputSchema: {
      workspace: workspaceArg,
      tool: z.string().describe("Tool name, file stem or path"),
      rename: z.string().optional(),
      description: z.string().optional(),
      modelDescription: z.string().optional(),
      modelDisplayName: z.string().optional(),
      operationId: z.string().optional(),
      connectionMode: z.enum(["Invoker", "Maker"]).optional(),
      connectionReference: z.string().optional(),
      outputMode: z.enum(["All", "Specific"]).optional(),
      setInputs: z.array(toolInput).optional(),
      addInputs: z.array(toolInput).optional(),
      removeInputs: z.array(z.string()).optional().describe("propertyNames to drop"),
    },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = editTool(root, a);
      return text({ ...r, validation: validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [] });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_edit_knowledge",
  { title: "Edit a knowledge source", description: "Change a knowledge source file: name, description, site URL, includeSubPages, trigger condition (null removes it), additional search terms.", inputSchema: { workspace: workspaceArg, knowledge: z.string(), rename: z.string().optional(), description: z.string().optional(), site: z.string().optional(), includeSubPages: z.boolean().optional(), triggerCondition: z.string().nullable().optional(), additionalSearchTerms: z.string().nullable().optional() } },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      const r = editKnowledge(root, a);
      return text({ ...r, validation: validateWorkspaceFiles(root, r.file).files[0]?.diagnostics ?? [] });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_remove_component",
  {
    title: "Remove a component from the workspace",
    description: "Delete a topic, knowledge source, tool, trigger, variable or flow from the workspace files (the live agent changes on the next cs_push). For tools, the connection reference is dropped too unless another tool uses it. Reports topics that still redirect to a removed topic. Deletes files: requires confirm: true.",
    inputSchema: { workspace: workspaceArg, kind: z.enum(["topic", "knowledge", "tool", "trigger", "variable", "flow"]), name: z.string(), pruneConnectionReference: z.boolean().optional(), confirm: confirmArg },
  },
  async (a) => {
    try {
      const root = resolveRoot(a.workspace);
      if (!a.confirm) return dryRun(`delete the ${a.kind} '${a.name}' from ${root} (files only; the live agent changes on the next cs_push)`);
      return text(removeComponent(root, a));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool("cs_delete_agent", { title: "Delete an agent", description: "pac copilot delete: permanently delete an agent from the environment. Requires confirm: true.", inputSchema: { bot: z.string().describe("Agent id or schema name"), environment: envOrProfile, confirm: confirmArg } }, async ({ bot, environment, confirm }) => {
  try {
    if (!confirm) return dryRun(`permanently delete agent ${bot} from ${environment ?? "the active profile's environment"}`);
    return text(pacSummary(await runPac(["copilot", "delete", "--bot", bot, "--confirm", ...(environment ? ["--environment", environment] : [])], { timeoutMs: 10 * 60_000 })));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool("cs_delete_solution", { title: "Delete a solution", description: "pac solution delete: delete an unmanaged solution container (its components stay in the environment) or uninstall a managed one (its components are removed). Requires confirm: true.", inputSchema: { name: z.string().describe("Solution unique name"), environment: envOrProfile, confirm: confirmArg } }, async ({ name, environment, confirm }) => {
  try {
    if (!confirm) return dryRun(`delete solution ${name} from ${environment ?? "the active profile's environment"}; for a managed solution this removes every component it installed`);
    return text(pacSummary(await runPac(["solution", "delete", "--solution-name", name, ...(environment ? ["--environment", environment] : [])], { timeoutMs: 30 * 60_000 })));
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_review_agent",
  {
    title: "Review the agent for common mistakes",
    description: "Judge whether the agent is any good and say what to improve, as a score out of 10 with a fix for each finding: instructions present and sized, escalation and fallback topics, trigger phrase count and overlap, tool descriptions and name collisions, unbound connections, authentication versus private knowledge, web browsing with internal sources, orchestration off with tools, duplicate names, credentials in YAML, pack-only workspace. Returns a score, findings with fixes, and optional Markdown.",
    inputSchema: { workspace: workspaceArg, markdown: z.boolean().optional(), reportPath: z.string().optional().describe("Write the Markdown report here") },
  },
  async ({ workspace, markdown, reportPath }) => {
    try {
      const report = reviewWorkspace(resolveRoot(workspace));
      const md = renderReviewMarkdown(report);
      if (reportPath) fs.writeFileSync(reportPath, md, "utf8");
      return text({ ...report, ...(markdown ? { markdown: md } : {}), ...(reportPath ? { reportPath } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
