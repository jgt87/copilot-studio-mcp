/**
 * Edits to `agent.mcs.yml` (instructions, conversation starters, model) and
 * `settings.mcs.yml`, preserving leading comment headers.
 */
import fs from "node:fs";
import path from "node:path";
import { loadWithHeader, saveWithHeader } from "./util.js";

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

export type ResponseMode = "Auto" | "ThinkDeeper" | "QuickResponse";
export type ContentModerationLevel = "Minimum" | "Low" | "Medium" | "High" | "Maximum";

/** The booleans behind the agent's capability toggles (GptCapabilities in the schema). */
export interface AgentCapabilities {
  webBrowsing?: boolean;
  codeInterpreter?: boolean;
  generateImages?: boolean;
  searchTeams?: boolean;
  searchOneDriveAndSharePoint?: boolean;
  searchEmails?: boolean;
  searchMeetings?: boolean;
  searchPeople?: boolean;
  searchPeopleIncludeRelatedContent?: boolean;
}

export interface AgentPatch {
  instructions?: string;
  appendInstructions?: string;
  displayName?: string;
  conversationStarters?: { title: string; text: string }[];
  addConversationStarters?: { title: string; text: string }[];
  modelNameHint?: string;
  /** How answers should be worded and formatted, separate from the instructions. */
  responseInstructions?: string;
  appendResponseInstructions?: string;
  /** Auto, ThinkDeeper (slower, more reasoning) or QuickResponse. */
  defaultResponseMode?: ResponseMode;
  /** Conversation history the agent sees: "none", or the last N user messages. */
  history?: "none" | "conversation";
  historyMessages?: number;
  /** Capability toggles; only the ones passed are changed. */
  capabilities?: AgentCapabilities;
  /** Whether the model may answer from its own general knowledge. */
  useModelKnowledge?: boolean;
  contentModeration?: ContentModerationLevel;
  isFileAnalysisEnabled?: boolean;
  isSemanticSearchEnabled?: boolean;
}

const RESPONSE_MODES: ResponseMode[] = ["Auto", "ThinkDeeper", "QuickResponse"];
const MODERATION_LEVELS: ContentModerationLevel[] = ["Minimum", "Low", "Medium", "High", "Maximum"];

/** Merge into a nested object without dropping what is already there. */
function mergeInto(doc: Record<string, unknown>, key: string, values: Record<string, unknown>): void {
  doc[key] = { ...((doc[key] as Record<string, unknown>) ?? {}), ...values };
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
  if (patch.responseInstructions !== undefined) {
    doc.responseInstructions = patch.responseInstructions;
    changed.push("responseInstructions");
  }
  if (patch.appendResponseInstructions) {
    doc.responseInstructions = `${((doc.responseInstructions as string) ?? "").replace(/\s+$/, "")}\n\n${patch.appendResponseInstructions}\n`.replace(/^\n+/, "");
    changed.push("responseInstructions (appended)");
  }
  if (patch.defaultResponseMode !== undefined) {
    if (!RESPONSE_MODES.includes(patch.defaultResponseMode)) throw new Error(`defaultResponseMode must be one of ${RESPONSE_MODES.join(", ")}`);
    doc.defaultResponseMode = patch.defaultResponseMode;
    changed.push("defaultResponseMode");
  }
  if (patch.history !== undefined) {
    doc.historyType = patch.history === "none" ? { kind: "NoHistory" } : { kind: "ConversationHistory", ...(patch.historyMessages !== undefined ? { numberOfPastUserMessagesToInclude: patch.historyMessages } : {}) };
    changed.push("historyType");
  } else if (patch.historyMessages !== undefined) {
    const h = ((doc.historyType as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    if (h.kind === "NoHistory") throw new Error("historyMessages needs conversation history: pass history: 'conversation'");
    doc.historyType = { kind: "ConversationHistory", ...h, numberOfPastUserMessagesToInclude: patch.historyMessages };
    changed.push("historyType.numberOfPastUserMessagesToInclude");
  }
  if (patch.capabilities && Object.keys(patch.capabilities).length) {
    const set = Object.fromEntries(Object.entries(patch.capabilities).filter(([, v]) => v !== undefined));
    mergeInto(doc, "gptCapabilities", set);
    changed.push(...Object.keys(set).map((k) => `gptCapabilities.${k}`));
  }
  const ai: Record<string, unknown> = {};
  if (patch.useModelKnowledge !== undefined) ai.useModelKnowledge = patch.useModelKnowledge;
  if (patch.isFileAnalysisEnabled !== undefined) ai.isFileAnalysisEnabled = patch.isFileAnalysisEnabled;
  if (patch.isSemanticSearchEnabled !== undefined) ai.isSemanticSearchEnabled = patch.isSemanticSearchEnabled;
  if (patch.contentModeration !== undefined) {
    if (!MODERATION_LEVELS.includes(patch.contentModeration)) throw new Error(`contentModeration must be one of ${MODERATION_LEVELS.join(", ")}`);
    ai.contentModeration = patch.contentModeration;
  }
  if (Object.keys(ai).length) {
    mergeInto(doc, "aISettings", ai);
    changed.push(...Object.keys(ai).map((k) => `aISettings.${k}`));
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
