/**
 * Copilot Studio agents: templates, translations and quarantine.
 *
 * One entry per command; the flags come from `pac copilot <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_extract_agent_template",
    title: "Extract an agent template",
    description: "Write a reusable YAML template from an existing agent (its topics, settings and components), for cs_create_agent_from_template in another environment or solution.",
    command: ["copilot", "extract-template"],
    params: {
      environment: ENV,
      bot: { flag: "--bot", type: "string", required: true, description: "Agent id or schema name" },
      templateFile: { flag: "--templateFileName", type: "string", required: true, description: "Path of the YAML template to write" },
      overwrite: { flag: "--overwrite", type: "boolean", description: "Overwrite the file if it exists" },
      templateName: { flag: "--templateName", type: "string", description: "Template name (default kickStartTemplate)" },
      templateVersion: { flag: "--templateVersion", type: "string", description: "Template version X.Y.Z (default 1.0.0)" },
    },
    mutating: false,
    timeoutMs: 10 * 60_000,
  },
  {
    tool: "cs_create_agent_from_template",
    title: "Create an agent from a template",
    description: "Create a new agent in a solution from a template produced by cs_extract_agent_template.",
    command: ["copilot", "create"],
    params: {
      environment: ENV,
      schemaName: { flag: "--schemaName", type: "string", required: true, description: "Schema (unique) name of the new agent, e.g. contoso_HelpDesk" },
      templateFile: { flag: "--templateFileName", type: "string", required: true, description: "Template YAML from cs_extract_agent_template" },
      displayName: { flag: "--displayName", type: "string", required: true, description: "Display name of the new agent" },
      solution: { flag: "--solution", type: "string", required: true, description: "Unique name of the solution to create the agent in" },
    },
    mutating: true,
    timeoutMs: 15 * 60_000,
    note: "Clone the new agent with cs_clone_agent to get a sync-connected workspace.",
  },
  {
    tool: "cs_extract_translations",
    title: "Extract translation files",
    description: "Export the localisable strings of one or all agents as .resx or .json files, from the environment or from an unpacked solution folder.",
    command: ["copilot", "extract-translation"],
    params: {
      environment: ENV,
      sourceDir: { flag: "--sourcedir", type: "string", description: "Unpacked solution folder to read instead of the environment" },
      bot: { flag: "--bot", type: "string", description: "Agent id or schema name; omit for every agent" },
      outDir: { flag: "--outdir", type: "string", description: "Output directory" },
      format: { flag: "--format", type: "string", values: ["resx", "json"], description: "resx (default) or json" },
      all: { flag: "--all", type: "boolean", description: "Write files for every supported language, not only the primary one" },
      overwrite: { flag: "--overwrite", type: "boolean", description: "Overwrite existing files" },
    },
    mutating: false,
    timeoutMs: 15 * 60_000,
  },
  {
    tool: "cs_merge_translations",
    title: "Merge translation files",
    description: "Import translated .resx or .json files back into one or more agents (environment or unpacked solution folder). whatIf previews the merge without writing.",
    command: ["copilot", "merge-translation"],
    params: {
      environment: ENV,
      sourceDir: { flag: "--sourcedir", type: "string", description: "Unpacked solution folder to update instead of the environment" },
      files: { flag: "--file", type: "string[]", required: true, description: "Translation files; glob patterns allowed" },
      whatIf: { flag: "--whatif", type: "boolean", description: "Report what would change without changing anything" },
      verbose: { flag: "--verbose", type: "boolean", description: "More diagnostic output" },
      solution: { flag: "--solution", type: "string", description: "Solution unique name" },
    },
    mutating: (input) => input.whatIf !== true,
    timeoutMs: 15 * 60_000,
  },
  {
    tool: "cs_quarantine_agent",
    title: "Quarantine or release an agent",
    description: "Put an agent in quarantine (users cannot talk to it) or release it. Admin operation.",
    command: ["copilot", "quarantine"],
    params: {
      environment: ENV,
      botId: { flag: "--bot-id", type: "string", required: true, description: "Agent id (GUID)" },
      quarantine: { flag: "--status", type: "boolstring", description: "true to quarantine (default), false to release" },
    },
    mutating: true,
  }
];
