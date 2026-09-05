/**
 * Edits to `agent.mcs.yml` (instructions, conversation starters, model) and
 * `settings.mcs.yml`, preserving leading comment headers.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { yamlDump } from "./util.js";

function splitHeader(text: string): { header: string; body: string } {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === "")) i++;
  return { header: lines.slice(0, i).join("\n"), body: lines.slice(i).join("\n") };
}

function loadWithHeader(file: string): { header: string; doc: Record<string, unknown> } {
  const text = fs.readFileSync(file, "utf8");
  const { header, body } = splitHeader(text);
  const doc = (yaml.load(body) as Record<string, unknown>) ?? {};
  return { header: header.trim(), doc };
}

function saveWithHeader(file: string, header: string, doc: Record<string, unknown>): void {
  fs.writeFileSync(file, `${header ? header + "\n" : ""}${yamlDump(doc)}`, "utf8");
}

function agentFile(root: string): string {
  for (const n of ["agent.mcs.yml", "agent.mcs.yaml"]) {
    const f = path.join(root, n);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`No agent.mcs.yml in ${root}. For GitHub Copilot harness (cli-copilot) agents edit settings.mcs.yml instead.`);
}

function settingsFile(root: string): string {
  for (const n of ["settings.mcs.yml", "settings.mcs.yaml"]) {
    const f = path.join(root, n);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`No settings.mcs.yml in ${root}`);
}

export interface AgentPatch {
  instructions?: string;
  appendInstructions?: string;
  displayName?: string;
  conversationStarters?: { title: string; text: string }[];
  addConversationStarters?: { title: string; text: string }[];
  modelNameHint?: string;
}

export function updateAgent(root: string, patch: AgentPatch): { file: string; changed: string[] } {
  const file = agentFile(root);
  const { header, doc } = loadWithHeader(file);
  const changed: string[] = [];
  if (patch.instructions !== undefined) {
    doc.instructions = patch.instructions;
    changed.push("instructions");
  }
  if (patch.appendInstructions) {
    doc.instructions = `${((doc.instructions as string) ?? "").replace(/\s+$/, "")}\n\n${patch.appendInstructions}\n`;
    changed.push("instructions (appended)");
  }
  if (patch.displayName !== undefined) {
    doc.displayName = patch.displayName;
    changed.push("displayName");
  }
  if (patch.conversationStarters) {
    doc.conversationStarters = patch.conversationStarters;
    changed.push("conversationStarters");
  }
  if (patch.addConversationStarters?.length) {
    doc.conversationStarters = [...((doc.conversationStarters as unknown[]) ?? []), ...patch.addConversationStarters];
    changed.push("conversationStarters (appended)");
  }
  if (patch.modelNameHint) {
    const ai = ((doc.aISettings as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    ai.model = { ...((ai.model as Record<string, unknown>) ?? {}), modelNameHint: patch.modelNameHint };
    doc.aISettings = ai;
    changed.push("aISettings.model.modelNameHint");
  }
  if (changed.length === 0) throw new Error("Nothing to change");
  saveWithHeader(file, header, doc);
  return { file, changed };
}

/**
 * GitHub Copilot harness (cli-copilot) agents keep instructions in
 * settings.mcs.yml under configuration.agentSettings.instructions.segments.
 */
export function updateCliCopilotInstructions(root: string, instructions: string): { file: string } {
  const file = settingsFile(root);
  const { header, doc } = loadWithHeader(file);
  const configuration = ((doc.configuration as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const agentSettings = ((configuration.agentSettings as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  agentSettings.instructions = { segments: [{ kind: "StaticSegment", value: instructions }] };
  configuration.agentSettings = agentSettings;
  doc.configuration = configuration;
  saveWithHeader(file, header, doc);
  return { file };
}

/** Shallow-merge a patch into settings.mcs.yml (dot paths allowed: "configuration.settings.GenerativeActionsEnabled"). */
export function updateSettings(root: string, patch: Record<string, unknown>): { file: string; changed: string[] } {
  const file = settingsFile(root);
  const { header, doc } = loadWithHeader(file);
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split(".");
    let cur: Record<string, unknown> = doc;
    for (const p of parts.slice(0, -1)) {
      const next = cur[p];
      if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
    changed.push(key);
  }
  saveWithHeader(file, header, doc);
  return { file, changed };
}
