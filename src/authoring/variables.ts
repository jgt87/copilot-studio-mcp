/**
 * Global variables (`variables/<name>.variable.mcs.yml`).
 */
import path from "node:path";
import { pascal, writeComponentFile } from "./util.js";

export interface VariableSpec {
  name: string;
  description?: string;
  defaultValue?: string | number | boolean;
  /** "UseInAIContext" (default) lets the orchestrator see the value; "Hidden" keeps it out of prompts. */
  aiVisibility?: "UseInAIContext" | "Hidden";
  agentSchemaName?: string;
  overwrite?: boolean;
}

export function addGlobalVariable(root: string, spec: VariableSpec): { file: string; reference: string; note: string } {
  const name = pascal(spec.name);
  const schemaPrefix = spec.agentSchemaName ?? "<AGENT_SCHEMA>";
  const doc: Record<string, unknown> = {
    name,
    aIVisibility: spec.aiVisibility ?? "UseInAIContext",
    scope: "Conversation",
    ...(spec.description ? { description: spec.description } : {}),
    schemaName: `${schemaPrefix}.globalvariable.${name}`,
    kind: "GlobalVariableComponent",
    ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
  };
  const file = writeComponentFile(path.join(root, "variables", `${name}.mcs.yml`), [`Name: ${spec.name}`, spec.description ?? `Global variable ${name}`], doc, {
    overwrite: spec.overwrite,
  });
  return {
    file,
    reference: `Global.${name}`,
    note: `Reference it in Power Fx as Global.${name}.${spec.agentSchemaName ? "" : " Agent schema name unknown: replace <AGENT_SCHEMA> in schemaName before pushing."}`,
  };
}
