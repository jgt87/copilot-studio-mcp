/**
 * Topics (`topics/<name>.topic.mcs.yml`) built from a small declarative spec
 * so a calling agent never has to hand-write AdaptiveDialog YAML for the
 * common node types. Anything exotic goes through `raw` nodes.
 */
import path from "node:path";
import { kebab, newId, pascal, writeComponentFile } from "./util.js";

export type TriggerSpec =
  | { kind: "phrases"; phrases: string[]; displayName?: string }
  | { kind: "conversationStart" | "unknownIntent" | "escalate" | "inactivity" | "error" | "signIn" | "redirect" | "planComplete" };

export type EntityName =
  | "String"
  | "Boolean"
  | "Number"
  | "Email"
  | "Date"
  | "DateTime"
  | "PhoneNumber"
  | "URL"
  | "Money"
  | "PersonName"
  | "City"
  | "CountryOrRegion"
  | "Organization"
  | "Percentage"
  | "Age"
  | "Duration"
  | "Color"
  | "Language"
  | "ZipCode"
  | "StreetAddress"
  | "File";

export type ActionSpec =
  | { type: "message"; text: string | string[]; speak?: string | string[] }
  | { type: "question"; prompt: string; variable: string; entity?: EntityName; choices?: string[]; allowInterruption?: boolean }
  | { type: "condition"; cases: { condition: string; actions: ActionSpec[] }[]; else?: ActionSpec[] }
  | { type: "redirect"; topic: string; replace?: boolean }
  | { type: "setVariable"; variable: string; value: string | number | boolean }
  | { type: "searchKnowledge"; variable?: string; endIfAnswered?: boolean; sources?: string[]; autoSend?: boolean }
  | { type: "http"; method?: "Get" | "Post" | "Put" | "Patch" | "Delete"; url: string; headers?: Record<string, string>; body?: unknown; responseVariable: string }
  | { type: "invokeFlow"; flowId: string; input?: Record<string, string>; output?: Record<string, string> }
  | { type: "card"; card: Record<string, unknown> | string; outputs?: Record<string, string>; outputTypes?: Record<string, "String" | "Number" | "Boolean"> }
  | { type: "transfer"; message?: string; phoneNumber?: string }
  | { type: "endConversation" }
  | { type: "end"; clearTopicQueue?: boolean }
  | { type: "raw"; node: Record<string, unknown> };

export interface TopicSpec {
  name: string;
  description?: string;
  trigger: TriggerSpec;
  priority?: number;
  actions: ActionSpec[];
  /** Agent schema name (from settings.mcs.yml) used to build topic references. */
  agentSchemaName?: string;
  overwrite?: boolean;
}

const TRIGGER_KINDS: Record<Exclude<TriggerSpec["kind"], "phrases">, string> = {
  conversationStart: "OnConversationStart",
  unknownIntent: "OnUnknownIntent",
  escalate: "OnEscalate",
  inactivity: "OnInactivity",
  error: "OnError",
  signIn: "OnSignIn",
  redirect: "OnRedirect",
  planComplete: "OnPlanComplete",
};

function scoped(variable: string): string {
  return /^(init:)?(Topic|Global|System|User|Env)\./.test(variable) ? variable : `Topic.${variable}`;
}

function pfx(value: string): string {
  return value.startsWith("=") ? value : `=${value}`;
}

/** `<schema>.topic.<Name>` reference; accepts an already-qualified reference. */
export function topicReference(agentSchemaName: string | undefined, topic: string): string {
  if (topic.includes(".topic.")) return topic;
  if (!agentSchemaName) return `<AGENT_SCHEMA>.topic.${pascal(topic)}`;
  return `${agentSchemaName}.topic.${pascal(topic)}`;
}

function activity(text: string | string[], speak?: string | string[]): unknown {
  const texts = Array.isArray(text) ? text : [text];
  if (!speak && texts.length === 1) return texts[0];
  return { text: texts, ...(speak ? { speak: Array.isArray(speak) ? speak : [speak] } : {}) };
}

export function buildActions(specs: ActionSpec[], agentSchemaName?: string): Record<string, unknown>[] {
  return specs.map((a) => {
    switch (a.type) {
      case "message":
        return { kind: "SendActivity", id: newId("sendMessage"), activity: activity(a.text, a.speak) };
      case "question": {
        const variable = scoped(a.variable);
        const node: Record<string, unknown> = {
          kind: "Question",
          id: newId("question"),
          alwaysPrompt: true,
          variable: variable.startsWith("init:") ? variable : `init:${variable}`,
          prompt: a.prompt,
        };
        if (a.allowInterruption === false) node.interruptionPolicy = { allowInterruption: false };
        if (a.choices && a.choices.length > 0) {
          node.entity = {
            kind: "EmbeddedEntity",
            definition: {
              kind: "ClosedListEntity",
              items: a.choices.map((c) => ({ id: kebab(c).replace(/-/g, "_"), displayName: c })),
            },
          };
        } else {
          node.entity = `${a.entity ?? "String"}PrebuiltEntity`;
        }
        return node;
      }
      case "condition":
        return {
          kind: "ConditionGroup",
          id: newId("conditionGroup"),
          conditions: a.cases.map((c) => ({ id: newId("conditionItem"), condition: pfx(c.condition), actions: buildActions(c.actions, agentSchemaName) })),
          ...(a.else && a.else.length ? { elseActions: buildActions(a.else, agentSchemaName) } : {}),
        };
      case "redirect":
        return { kind: a.replace ? "ReplaceDialog" : "BeginDialog", id: newId(a.replace ? "replaceDialog" : "beginDialog"), dialog: topicReference(agentSchemaName, a.topic) };
      case "setVariable":
        return {
          kind: "SetVariable",
          id: newId("setVariable"),
          variable: `init:${scoped(a.variable)}`,
          value: typeof a.value === "string" ? (a.value.startsWith("=") ? a.value : a.value) : a.value,
        };
      case "searchKnowledge": {
        const variable = scoped(a.variable ?? "Answer");
        const search: Record<string, unknown> = { kind: "SearchAndSummarizeContent", id: newId("searchContent"), userInput: "=System.Activity.Text", variable };
        if (a.autoSend !== undefined) search.autoSend = a.autoSend;
        if (a.sources?.length) {
          // Reference format documented by Microsoft's authoring skills: <agentSchema>.topic.<knowledge file stem>
          search.knowledgeSources = { kind: "SearchSpecificKnowledgeSources", knowledgeSources: a.sources.map((s) => (s.includes(".") ? s : `${agentSchemaName ?? "<AGENT_SCHEMA>"}.topic.${pascal(s)}`)) };
        }
        const nodes: Record<string, unknown>[] = [search];
        if (a.endIfAnswered !== false) {
          nodes.push({
            kind: "ConditionGroup",
            id: newId("conditionGroup"),
            conditions: [{ id: newId("conditionItem"), condition: `=!IsBlank(${variable})`, actions: [{ kind: "EndDialog", id: newId("endDialog"), clearTopicQueue: true }] }],
          });
        }
        return { __multi: nodes };
      }
      case "http":
        return {
          kind: "HttpRequestAction",
          id: newId("httpRequest"),
          method: a.method ?? "Get",
          url: a.url,
          ...(a.headers ? { headers: a.headers } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
          response: scoped(a.responseVariable),
        };
      case "invokeFlow":
        return {
          kind: "InvokeFlowAction",
          id: newId("invokeFlow"),
          flowId: a.flowId,
          ...(a.input ? { input: { binding: a.input } } : {}),
          ...(a.output ? { output: { binding: a.output } } : {}),
        };
      case "card": {
        const cardJson = typeof a.card === "string" ? a.card : JSON.stringify(a.card, null, 2);
        const outputs = a.outputs ?? {};
        const fields = Object.keys(outputs);
        if (fields.length === 0) {
          // Display-only card: an attachment on a message.
          return { kind: "SendActivity", id: newId("sendMessage"), activity: { attachments: [{ kind: "AdaptiveCardTemplate", cardContent: cardJson }] } };
        }
        return {
          kind: "AdaptiveCardPrompt",
          id: newId("adaptiveCardPrompt"),
          card: cardJson,
          output: { binding: Object.fromEntries(fields.map((f) => [f, scoped(outputs[f])])) },
          outputType: { properties: Object.fromEntries(fields.map((f) => [f, { type: a.outputTypes?.[f] ?? "String" }])) },
        };
      }
      case "transfer":
        return {
          kind: "TransferConversationV2",
          id: newId("transferConversation"),
          transferType: a.phoneNumber ? { kind: "TransferToPhoneNumber", phoneNumber: a.phoneNumber } : { kind: "TransferToAgent", ...(a.message ? { messageToAgent: a.message } : {}) },
        };
      case "endConversation":
        return { kind: "EndConversation", id: newId("endConversation") };
      case "end":
        return { kind: "EndDialog", id: newId("endDialog"), ...(a.clearTopicQueue ? { clearTopicQueue: true } : {}) };
      case "raw":
        return { id: newId("node"), ...a.node };
      default:
        throw new Error(`Unknown action type ${(a as { type: string }).type}`);
    }
  }).flatMap((n) => (Array.isArray((n as { __multi?: unknown }).__multi) ? ((n as { __multi: Record<string, unknown>[] }).__multi) : [n]));
}

export function buildTopicDocument(spec: TopicSpec): Record<string, unknown> {
  const beginDialog: Record<string, unknown> = {};
  if (spec.trigger.kind === "phrases") {
    if (!spec.trigger.phrases.length) throw new Error("A phrase-triggered topic needs at least one trigger phrase");
    beginDialog.kind = "OnRecognizedIntent";
    beginDialog.id = "main";
    beginDialog.intent = { displayName: spec.trigger.displayName ?? spec.name, triggerQueries: spec.trigger.phrases };
  } else {
    beginDialog.kind = TRIGGER_KINDS[spec.trigger.kind];
    beginDialog.id = "main";
  }
  if (spec.priority !== undefined) beginDialog.priority = spec.priority;
  beginDialog.actions = buildActions(spec.actions, spec.agentSchemaName);
  return {
    "mcs.metadata": { componentName: spec.name, ...(spec.description ? { description: spec.description } : {}) },
    kind: "AdaptiveDialog",
    beginDialog,
  };
}

export interface TopicResult {
  file: string;
  componentName: string;
  reference: string;
  note: string;
}

export function addTopic(root: string, spec: TopicSpec): TopicResult {
  const doc = buildTopicDocument(spec);
  const componentName = pascal(spec.name);
  const header = [`Name: ${spec.name}`, spec.description ?? `Topic: ${spec.name}`];
  const file = writeComponentFile(path.join(root, "topics", `${pascal(spec.name)}.mcs.yml`), header, doc, { overwrite: spec.overwrite });
  return {
    file,
    componentName,
    reference: topicReference(spec.agentSchemaName, componentName),
    note: spec.agentSchemaName ? "" : "Agent schema name unknown: any redirect uses the placeholder <AGENT_SCHEMA>; fix before pushing.",
  };
}
