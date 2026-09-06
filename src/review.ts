/**
 * Static review of an agent workspace: the mistakes that evaluations only
 * reveal later. Rules are deliberately conservative and each carries a fix.
 */
import fs from "node:fs";
import { readWorkspace, type WorkspaceInfo, type ComponentInfo } from "./workspace.js";
import { loadWithHeader } from "./authoring/util.js";

export type Severity = "error" | "warning" | "info";

export interface ReviewFinding {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  fix: string;
}

export interface ReviewReport {
  root: string;
  score: number;
  counts: Record<Severity, number>;
  findings: ReviewFinding[];
}

const WEIGHT: Record<Severity, number> = { error: 2, warning: 1, info: 0.25 };
const SECRET_RE = /(password|passwd|client_secret|clientsecret|api[_-]?key|bearer\s+[a-z0-9\-_.]{20,})\s*[:=]\s*["']?[^\s"']{6,}/i;

type Rule = (ws: WorkspaceInfo) => ReviewFinding[];

const f = (rule: string, severity: Severity, message: string, fix: string, file?: string): ReviewFinding => ({ rule, severity, message, fix, ...(file ? { file } : {}) });

const rules: Rule[] = [
  // Instructions
  (ws) => {
    if (ws.harness === "github-copilot") return [];
    const text = (ws.agent?.instructions ?? "").trim();
    if (!ws.agent) return [];
    if (!text) return [f("instructions-missing", "error", "The agent has no instructions.", "Write them with cs_generate_instructions or cs_update_agent: role, scope, how to answer, when to use each tool, escalation, refusals.", "agent.mcs.yml")];
    if (text.length < 200) return [f("instructions-short", "warning", `Instructions are ${text.length} characters; that rarely covers scope, grounding and escalation.`, "Expand with cs_generate_instructions refine=true or cs_update_agent.", "agent.mcs.yml")];
    if (text.length > 8000) return [f("instructions-long", "warning", `Instructions are ${text.length} characters; very long instructions dilute the important rules.`, "Move procedures into topics or tools and keep instructions to role, scope, style and escalation.", "agent.mcs.yml")];
    return [];
  },
  (ws) => (ws.agent && ws.agent.conversationStarters.length === 0 && ws.harness !== "github-copilot" ? [f("starters-missing", "info", "No conversation starters.", "Add two or three with cs_update_agent addConversationStarters so users see what the agent can do.", "agent.mcs.yml")] : []),
  // Topics
  (ws) => {
    const out: ReviewFinding[] = [];
    const custom = ws.topics.filter((t) => t.details.triggerKind === "OnRecognizedIntent");
    for (const t of custom) {
      const phrases = (t.details.triggerPhrases as string[] | undefined) ?? [];
      if (phrases.length > 0 && phrases.length < 3) out.push(f("topic-few-phrases", "warning", `Topic '${t.name}' has ${phrases.length} trigger phrase(s).`, "Add 5 to 10 varied phrasings with cs_edit_topic addTriggerPhrases; recognition improves with variety.", t.relPath));
      if ((t.details.actionCount as number) === 0) out.push(f("topic-empty", "warning", `Topic '${t.name}' has no actions.`, "Add nodes with cs_edit_topic appendActions or remove the topic.", t.relPath));
    }
    const seen = new Map<string, string>();
    for (const t of custom) {
      for (const p of (t.details.triggerPhrases as string[] | undefined) ?? []) {
        const key = p.trim().toLowerCase();
        const other = seen.get(key);
        if (other && other !== t.name) out.push(f("topic-phrase-overlap", "warning", `Trigger phrase '${p}' appears in both '${other}' and '${t.name}'.`, "Keep each phrase in one topic; overlapping phrases make triggering arbitrary.", t.relPath));
        else seen.set(key, t.name);
      }
    }
    return out;
  },
  (ws) => {
    if (ws.harness === "github-copilot" || ws.topics.length === 0) return [];
    const out: ReviewFinding[] = [];
    if (!ws.topics.some((t) => t.details.triggerKind === "OnEscalate")) out.push(f("no-escalation", "warning", "No topic handles escalation (OnEscalate).", "Keep the Escalate system topic, or add one with cs_add_topic triggerKind=escalate that transfers or tells the user how to reach a person."));
    if (!ws.topics.some((t) => t.details.triggerKind === "OnUnknownIntent")) out.push(f("no-fallback", "warning", "No topic handles unrecognised messages (OnUnknownIntent).", "Keep the Fallback or Conversational boosting system topic, or add one with cs_add_topic triggerKind=unknownIntent."));
    return out;
  },
  // Tools
  (ws) => {
    const out: ReviewFinding[] = [];
    const names = new Map<string, ComponentInfo>();
    for (const t of ws.actions) {
      const md = ((t.details.modelDescription as string | null) ?? "").trim();
      if (md.length < 20) out.push(f("tool-description", "error", `Tool '${t.name}' has ${md ? "a very short" : "no"} modelDescription; the orchestrator routes on it.`, "Set a specific description with cs_edit_tool modelDescription: what it does, when to use it, what it needs.", t.relPath));
      const dn = ((t.details.modelDisplayName as string | null) ?? t.name).toLowerCase();
      const other = names.get(dn);
      if (other) out.push(f("tool-name-collision", "warning", `Tools '${other.name}' and '${t.name}' share the display name '${dn}'.`, "Give each tool a distinct modelDisplayName with cs_edit_tool.", t.relPath));
      else names.set(dn, t);
      const inputs = (t.details.inputs as { kind?: string; propertyName?: string }[] | undefined) ?? [];
      if (t.details.actionKind === "InvokeConnectorTaskAction" && inputs.length === 0) out.push(f("tool-no-inputs", "info", `Connector tool '${t.name}' declares no inputs.`, "If the operation takes parameters, add automatic inputs (cs_describe_connector shows the required ones; cs_edit_tool addInputs).", t.relPath));
    }
    return out;
  },
  (ws) => {
    const unbound = ws.connectionReferences.filter((c) => !c.connectionId);
    if (!unbound.length) return [];
    const sev: Severity = ws.sync.source === "none" ? "info" : "warning";
    return [f("connection-unbound", sev, `${unbound.length} connection reference(s) have no connection: ${unbound.map((c) => c.logicalName ?? c.connectionReferenceLogicalName).join(", ")}.`, "After cs_push, open the agent's Tools page, Connect each tool once, then cs_pull.", "connectionreferences.mcs.yml")];
  },
  // Knowledge and authentication
  (ws) => {
    const out: ReviewFinding[] = [];
    const auth = String(ws.settings?.authenticationMode ?? "");
    const privateSources = ws.knowledge.filter((k) => /SharePoint|Dataverse|GraphConnector|Fabric|AzureAISearch|Email|Teams|Meeting/i.test(String(k.details.sourceKind ?? "")));
    if (privateSources.length && /^None$/i.test(auth)) out.push(f("auth-none-with-private-knowledge", "error", `Authentication is None but ${privateSources.length} knowledge source(s) need a signed-in user (${privateSources.map((k) => k.name).join(", ")}).`, "Set authenticationMode to Integrated (cs_update_settings) or replace the sources with public ones.", "settings.mcs.yml"));
    const gpt = (ws.agent ? loadAgentDoc(ws) : null) as Record<string, unknown> | null;
    const webBrowsing = ((gpt?.gptCapabilities as Record<string, unknown> | undefined)?.webBrowsing as boolean | undefined) ?? false;
    if (webBrowsing && privateSources.length) out.push(f("web-browsing-with-private-knowledge", "info", "Web browsing is on while internal knowledge sources are configured; answers may mix public and internal content.", "Turn off gptCapabilities.webBrowsing in agent.mcs.yml unless public web answers are wanted.", "agent.mcs.yml"));
    if (ws.harness === "standard" && ws.knowledge.length === 0 && ws.knowledgeFiles.length === 0 && !ws.topics.some((t) => t.details.triggerKind === "OnRecognizedIntent") && ws.actions.length === 0) {
      out.push(f("agent-empty", "warning", "No custom topics, knowledge or tools: the agent can only answer from the model's own knowledge.", "Add knowledge (cs_add_knowledge_source), topics (cs_add_topic) or tools (cs_add_tool)."));
    }
    return out;
  },
  (ws) => {
    const settings = (ws.settings?.configuration as Record<string, unknown> | undefined)?.settings as Record<string, unknown> | undefined;
    if (settings?.GenerativeActionsEnabled === false && ws.actions.length) return [f("orchestration-off-with-tools", "info", `Generative orchestration is off but ${ws.actions.length} tool(s) exist; tools only run when a topic calls them.`, "Enable configuration.settings.GenerativeActionsEnabled with cs_update_settings, or call the tools from topics.", "settings.mcs.yml")];
    return [];
  },
  // Hygiene
  (ws) => {
    const out: ReviewFinding[] = [];
    const byName = new Map<string, string>();
    for (const c of [...ws.topics, ...ws.knowledge, ...ws.actions]) {
      const key = `${c.kind}:${c.name.toLowerCase()}`;
      const other = byName.get(key);
      if (other) out.push(f("duplicate-name", "warning", `Two ${c.kind} components are named '${c.name}' (${other}, ${c.relPath}).`, "Rename one with cs_edit_topic / cs_edit_tool / cs_edit_knowledge.", c.relPath));
      else byName.set(key, c.relPath);
    }
    for (const c of [...ws.topics, ...ws.knowledge, ...ws.actions, ...ws.triggers, ...ws.variables]) {
      const text = fs.readFileSync(c.file, "utf8");
      if (SECRET_RE.test(text)) out.push(f("secret-in-yaml", "error", `'${c.relPath}' looks like it contains a credential.`, "Move secrets to environment variables or connections; never keep them in the agent definition.", c.relPath));
      if (c.parseError) out.push(f("yaml-parse-error", "error", `'${c.relPath}' does not parse: ${c.parseError}`, "Fix the YAML (cs_validate shows the location).", c.relPath));
    }
    if (ws.sync.source === "none" && (ws.knowledge.length || ws.actions.length || ws.triggers.length || ws.workflows.length || ws.variables.length)) {
      out.push(f("pack-only-workspace", "info", "This workspace is not sync-connected; knowledge, tools, triggers, flows and variables are not packaged by pac copilot pack.", "Bootstrap or clone the agent (cs_init_agent with environment, cs_clone_agent) and cs_push."));
    }
    return out;
  },
];

function loadAgentDoc(ws: WorkspaceInfo): Record<string, unknown> | null {
  try {
    if (!ws.agent?.file) return null;
    return loadWithHeader<Record<string, unknown>>(ws.agent.file).doc;
  } catch {
    return null;
  }
}

export function reviewWorkspace(root: string): ReviewReport {
  const ws = readWorkspace(root);
  const findings = rules.flatMap((r) => r(ws)).sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity]);
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const x of findings) counts[x.severity]++;
  const penalty = findings.reduce((n, x) => n + WEIGHT[x.severity], 0);
  return { root, score: Math.max(0, Math.round((10 - penalty) * 10) / 10), counts, findings };
}

export function renderReviewMarkdown(r: ReviewReport): string {
  const lines = [`# Agent review: ${r.root}`, "", `Score ${r.score}/10 (${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} notes)`, ""];
  if (!r.findings.length) lines.push("No findings.");
  for (const x of r.findings) lines.push(`- **${x.severity}** \`${x.rule}\`${x.file ? ` (${x.file})` : ""}: ${x.message} Fix: ${x.fix}`);
  return lines.join("\n") + "\n";
}
