import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { readWorkspace, findWorkspaceRoot, describeWorkspace } from "../dist/workspace.js";
import { validateDocument, listKinds, summarizeDefinition, validKindsFromOneOf, lookupDefinition } from "../dist/schema.js";
import { addTopic, buildTopicDocument, topicReference } from "../dist/authoring/topics.js";
import { addKnowledgeSource, normalizeSharePointUrl } from "../dist/authoring/knowledge.js";
import { addTool, readConnectionReferences } from "../dist/authoring/tools.js";
import { scaffoldFlow } from "../dist/authoring/flows.js";
import { addTrigger } from "../dist/authoring/triggers.js";
import { addGlobalVariable } from "../dist/authoring/variables.js";
import { updateAgent, updateSettings } from "../dist/authoring/agent.js";
import { kebab, pascal } from "../dist/authoring/util.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function fixtureCopy(t, name) {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const target = join(dir, name);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

function validate(file) {
  const raw = readFileSync(file, "utf8");
  return validateDocument(yaml.load(raw), raw);
}

test("naming helpers", () => {
  assert.equal(kebab("Order Status FAQ!"), "order-status-faq");
  assert.equal(pascal("order status faq"), "OrderStatusFaq");
  assert.equal(topicReference("cr1_agent", "Order Status"), "cr1_agent.topic.OrderStatus");
  assert.equal(topicReference("cr1_agent", "x.topic.Y"), "x.topic.Y");
});

test("schema loads and knows the core kinds", () => {
  const kinds = listKinds();
  for (const k of ["AdaptiveDialog", "TaskDialog", "KnowledgeSourceConfiguration", "SendActivity", "Question", "OnRecognizedIntent", "InvokeConnectorTaskAction", "GptComponentMetadata"]) {
    assert.ok(kinds.includes(k), `missing kind ${k}`);
  }
  assert.ok(validKindsFromOneOf("DialogAction").includes("SendActivity"));
  assert.ok(validKindsFromOneOf("KnowledgeSource").includes("SharePointSearchSource"));
  assert.match(summarizeDefinition("Question"), /variable/);
  assert.equal(lookupDefinition("question").name, "Question");
});

test("readWorkspace inventories the mcp-action fixture", () => {
  const root = findWorkspaceRoot(join(FIXTURES, "agent-with-mcp-action"));
  const ws = readWorkspace(root);
  assert.equal(ws.harness, "standard");
  assert.equal(ws.schemaName, "eval_testAgent");
  assert.equal(ws.topics.length, 1);
  assert.equal(ws.topics[0].details.triggerKind, "OnConversationStart");
  assert.equal(ws.actions.length, 2);
  const mcp = ws.actions.find((a) => a.name === "Custom MCP Server");
  assert.equal(mcp.details.actionKind, "InvokeExternalAgentTaskAction");
  assert.equal(mcp.details.operationId, "InvokeMCP");
  assert.equal(ws.sync.source, "none");
  const d = describeWorkspace(ws);
  assert.equal(d.counts.actions, 2);
  assert.equal(d.displayName, "Eval Test Agent");
});

test("findWorkspaceRoot finds a single child workspace", () => {
  assert.equal(findWorkspaceRoot(join(FIXTURES, "agent-with-mcp-action", "topics")), join(FIXTURES, "agent-with-mcp-action"));
  assert.equal(findWorkspaceRoot(tmpdir()), null);
});

test("validateDocument passes fixtures and catches classic mistakes", () => {
  for (const f of ["agent-with-mcp-action/topics/Greeting.topic.mcs.yml", "agent-with-mcp-action/actions/CustomMCP.mcs.yml", "agent-with-mcp-action/actions/SearchDocs.mcs.yml", "agent-with-mcp-action/agent.mcs.yml"]) {
    const diags = validate(join(FIXTURES, f));
    assert.deepEqual(diags.filter((d) => d.severity === "error"), [], `${f}: ${JSON.stringify(diags)}`);
  }
  const bad = `kind: AdaptiveDialog
beginDialog:
  kind: OnRecognizedIntent
  id: main
  intent:
    triggerQueries: [hi]
  actions:
    - kind: SendActivity
      id: a1
      activity: hello
    - kind: SendActivity
      id: a1
      activity: dup id
    - kind: NotARealNode
      id: a2
    - kind: Question
      id: q_REPLACE
      variable: Choice
      prompt: pick
      entity: StringPrebuiltEntity
      bogusProp: 1
    - kind: ConditionGroup
      id: c1
      conditions:
        - id: c1a
          condition: Topic.Choice = "x"
          actions: []
`;
  const diags = validateDocument(yaml.load(bad), bad);
  const msgs = diags.map((d) => d.message);
  assert.ok(msgs.some((m) => /Duplicate id 'a1'/.test(m)));
  assert.ok(msgs.some((m) => /NotARealNode/.test(m)));
  assert.ok(msgs.some((m) => /_REPLACE/.test(m)));
  assert.ok(msgs.some((m) => /Unknown property 'bogusProp'/.test(m)));
  assert.ok(msgs.some((m) => /scope prefix/.test(m)));
  assert.ok(msgs.some((m) => /leading '='/.test(m)));
});

test("addTopic builds a valid AdaptiveDialog with every node type", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  const r = addTopic(root, {
    name: "Order Status",
    description: "Look up an order",
    trigger: { kind: "phrases", phrases: ["where is my order", "track my order"] },
    agentSchemaName: "eval_testAgent",
    actions: [
      { type: "message", text: ["Sure, let me check.", "On it."] },
      { type: "question", prompt: "What is the order number?", variable: "OrderNumber", entity: "Number" },
      { type: "question", prompt: "Which region?", variable: "Region", choices: ["EU", "US"] },
      { type: "setVariable", variable: "Checked", value: true },
      { type: "http", method: "Get", url: "https://api.example.com/orders", headers: { Accept: "application/json" }, responseVariable: "OrderData" },
      { type: "condition", cases: [{ condition: "Topic.Region = \"EU\"", actions: [{ type: "message", text: "EU shipping" }] }], else: [{ type: "redirect", topic: "Escalate" }] },
      { type: "searchKnowledge" },
      { type: "invokeFlow", flowId: "00000000-0000-0000-0000-000000000001", input: { OrderNumber: "=Topic.OrderNumber" } },
      { type: "end" },
      { type: "raw", node: { kind: "SendActivity", activity: "raw node" } },
    ],
  });
  assert.ok(existsSync(r.file));
  assert.equal(r.componentName, "OrderStatus");
  assert.equal(r.reference, "eval_testAgent.topic.OrderStatus");
  const diags = validate(r.file);
  assert.deepEqual(diags.filter((d) => d.severity === "error"), [], JSON.stringify(diags));
  const doc = yaml.load(readFileSync(r.file, "utf8"));
  assert.equal(doc.beginDialog.kind, "OnRecognizedIntent");
  assert.deepEqual(doc.beginDialog.intent.triggerQueries, ["where is my order", "track my order"]);
  const q = doc.beginDialog.actions.find((a) => a.kind === "Question" && a.variable === "init:Topic.Region");
  assert.equal(q.entity.kind, "EmbeddedEntity");
  assert.equal(q.entity.definition.items.length, 2);
  const redirect = doc.beginDialog.actions.find((a) => a.kind === "ConditionGroup").elseActions[0];
  assert.equal(redirect.dialog, "eval_testAgent.topic.Escalate");
  assert.throws(() => addTopic(root, { name: "Order Status", trigger: { kind: "phrases", phrases: ["x"] }, actions: [] }), /Refusing to overwrite/);
  const ws = readWorkspace(root);
  assert.equal(ws.topics.length, 2);
});

test("buildTopicDocument supports system triggers", () => {
  const doc = buildTopicDocument({ name: "Fallback", trigger: { kind: "unknownIntent" }, priority: -1, actions: [{ type: "message", text: "?" }] });
  assert.equal(doc.beginDialog.kind, "OnUnknownIntent");
  assert.equal(doc.beginDialog.priority, -1);
  assert.throws(() => buildTopicDocument({ name: "x", trigger: { kind: "phrases", phrases: [] }, actions: [] }));
});

test("addKnowledgeSource writes the three YAML kinds and copies files", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  const pub = addKnowledgeSource(root, { name: "Public Docs", kind: "public-site", site: "https://docs.example.com/product" });
  const sp = addKnowledgeSource(root, { name: "HR", kind: "sharepoint", site: "https://contoso.sharepoint.com/sites/HR/Forms/AllItems.aspx?id=%2Fsites%2FHR%2FShared%20Documents%2FPolicies&viewid=abc" });
  const gc = addKnowledgeSource(root, { name: "ServiceNow", kind: "graph-connector", connectionEnvironmentVariable: "orc_SnowConn", connectionName: "servicenow" });
  for (const r of [pub, sp, gc]) {
    const diags = validate(r.files[0]);
    assert.deepEqual(diags.filter((d) => d.severity === "error"), [], JSON.stringify(diags));
  }
  const spDoc = yaml.load(readFileSync(sp.files[0], "utf8"));
  assert.equal(spDoc.source.site, "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Policies");
  const gcDoc = yaml.load(readFileSync(gc.files[0], "utf8"));
  assert.deepEqual(gcDoc.source.connectionId, { schemaName: "orc_SnowConn" });
  const docPath = join(root, "policy.txt");
  writeFileSync(docPath, "hello");
  const files = addKnowledgeSource(root, { name: "Docs", kind: "files", files: [docPath] });
  assert.ok(existsSync(join(root, "knowledge", "files", "policy.txt")));
  assert.equal(files.files.length, 1);
  assert.equal(readWorkspace(root).knowledge.length, 3);
  assert.equal(readWorkspace(root).knowledgeFiles.length, 1);
  assert.match(normalizeSharePointUrl("https://x.sharepoint.com/:f:/s/Site/abc").note, /sharing link/);
});

test("addTool writes connector, mcp and flow tools plus connection references", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  const c = addTool(root, { type: "connector", name: "Send Email", description: "Sends an email", connectorId: "shared_office365", operationId: "SendEmailV2", inputs: [{ kind: "automatic", name: "To", description: "recipient", entity: "Email" }, { kind: "manual", name: "From", value: "=System.User.Email" }], outputs: ["Response"] }, "eval_testAgent");
  assert.ok(c.connectionReference.startsWith("eval_testAgent.shared_office365."));
  assert.ok(c.portalStep);
  const m = addTool(root, { type: "mcp", name: "Learn MCP", description: "Docs", connectorId: "shared_microsoftlearndocsmcpserver" }, "eval_testAgent");
  const f = addTool(root, { type: "flow", name: "Lookup Order", description: "Runs a flow", flowId: "00000000-0000-0000-0000-000000000002" }, "eval_testAgent");
  for (const r of [c, m, f]) {
    const diags = validate(r.file);
    assert.deepEqual(diags.filter((d) => d.severity === "error"), [], JSON.stringify(diags));
  }
  const cDoc = yaml.load(readFileSync(c.file, "utf8"));
  assert.equal(cDoc.action.kind, "InvokeConnectorTaskAction");
  assert.equal(cDoc.inputs[0].kind, "AutomaticTaskInput");
  assert.equal(cDoc.inputs[0].entity, "EmailPrebuiltEntity");
  const mDoc = yaml.load(readFileSync(m.file, "utf8"));
  assert.equal(mDoc.action.operationDetails.kind, "ModelContextProtocolMetadata");
  const fDoc = yaml.load(readFileSync(f.file, "utf8"));
  assert.equal(fDoc.action.flowId, "00000000-0000-0000-0000-000000000002");
  const crs = readConnectionReferences(root);
  assert.equal(crs.entries.length, 2);
  assert.equal(readWorkspace(root).actions.length, 3);
  assert.equal(readWorkspace(root).connectionReferences.length, 2);
});

test("scaffoldFlow, addTrigger and addGlobalVariable", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  const flow = scaffoldFlow(root, { name: "Lookup Order", inputs: [{ name: "OrderNumber", type: "number" }], outputs: [{ name: "Status", value: "shipped" }] });
  assert.ok(existsSync(flow.metadataFile));
  const def = JSON.parse(readFileSync(flow.definitionFile, "utf8"));
  assert.equal(def.properties.definition.triggers.manual.kind, "Skills");
  assert.equal(def.properties.definition.actions.Respond_to_the_agent.inputs.body.Status, "shipped");
  const meta = yaml.load(readFileSync(flow.metadataFile, "utf8"));
  assert.equal(meta.kind, "CloudFlowDefinition");
  assert.equal(meta.workflowId, flow.workflowId);
  const trig = addTrigger(root, { name: "New Ticket", flowId: flow.workflowId });
  assert.deepEqual(validate(trig.file).filter((d) => d.severity === "error"), []);
  const v = addGlobalVariable(root, { name: "User Region", defaultValue: "EU", agentSchemaName: "eval_testAgent" });
  assert.equal(v.reference, "Global.UserRegion");
  const ws = readWorkspace(root);
  assert.equal(ws.workflows.length, 1);
  assert.equal(ws.workflows[0].hasDefinition, true);
  assert.equal(ws.triggers.length, 1);
  assert.equal(ws.variables.length, 1);
});

test("updateAgent and updateSettings keep headers and merge", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  writeFileSync(join(root, "agent.mcs.yml"), "# Name: Basic\n" + readFileSync(join(root, "agent.mcs.yml"), "utf8"));
  const r = updateAgent(root, { appendInstructions: "Always be brief.", addConversationStarters: [{ title: "Hours", text: "When are you open?" }], modelNameHint: "GPT5" });
  assert.equal(r.changed.length, 3);
  const text = readFileSync(join(root, "agent.mcs.yml"), "utf8");
  assert.ok(text.startsWith("# Name: Basic"));
  const doc = yaml.load(text);
  assert.match(doc.instructions, /Always be brief/);
  assert.equal(doc.conversationStarters.length, 3);
  assert.equal(doc.aISettings.model.modelNameHint, "GPT5");
  updateSettings(root, { "configuration.settings.GenerativeActionsEnabled": true, displayName: "Renamed" });
  const s = yaml.load(readFileSync(join(root, "settings.mcs.yml"), "utf8"));
  assert.equal(s.configuration.settings.GenerativeActionsEnabled, true);
  assert.equal(s.displayName, "Renamed");
  assert.equal(s.schemaName, "eval_testAgent");
});
