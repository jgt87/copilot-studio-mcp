import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { editTopic, editTool, editKnowledge, removeComponent, findComponent } from "../dist/authoring/edit.js";
import { addTool } from "../dist/authoring/tools.js";
import { addKnowledgeSource } from "../dist/authoring/knowledge.js";
import { addTopic } from "../dist/authoring/topics.js";
import { readWorkspace } from "../dist/workspace.js";
import { validateWorkspace } from "../dist/validate.js";
import { reviewWorkspace, renderReviewMarkdown } from "../dist/review.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function scaffold(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-edit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, "agent");
  cpSync(join(FIXTURES, "pac-default"), root, { recursive: true });
  return root;
}

test("findComponent matches by name, stem and path", (t) => {
  const ws = readWorkspace(scaffold(t));
  assert.equal(findComponent(ws, "topic", "Greeting").name, "Greeting");
  assert.equal(findComponent(ws, "topic", "topics/Greeting.mcs.yml").name, "Greeting");
  assert.equal(findComponent(ws, "topic", "conversational boosting").name, "Conversational boosting");
  assert.equal(findComponent(ws, "topic", "Search").name, "Conversational boosting");
  assert.equal(findComponent(ws, "topic", "nope"), null);
});

test("editTopic changes phrases, priority and actions while keeping the header", (t) => {
  const root = scaffold(t);
  const file = join(root, "topics", "Greeting.mcs.yml");
  writeFileSync(file, "# Name: Greeting\n# keep me\n" + readFileSync(file, "utf8"));
  const r = editTopic(root, {
    topic: "Greeting",
    addTriggerPhrases: ["Howdy", "hello"],
    removeTriggerPhrases: ["Hey"],
    priority: 5,
    appendActions: [{ type: "message", text: "Anything else?" }],
    insertActions: { at: 0, actions: [{ type: "setVariable", variable: "Greeted", value: true }] },
    removeActionIds: ["cancelAllDialogs_01At22"],
    agentSchemaName: "orc_OracleDefaultAgent",
  });
  assert.ok(r.changed.includes("triggerPhrases"));
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("# Name: Greeting\n# keep me"));
  const doc = yaml.load(text);
  const phrases = doc.beginDialog.intent.triggerQueries;
  assert.ok(phrases.includes("Howdy"));
  assert.ok(!phrases.includes("Hey"));
  assert.equal(phrases.filter((p) => p.toLowerCase() === "hello").length, 1, "duplicate phrase not added twice");
  assert.equal(doc.beginDialog.priority, 5);
  assert.equal(doc.beginDialog.actions[0].kind, "SetVariable");
  assert.equal(doc.beginDialog.actions.at(-1).kind, "SendActivity");
  assert.ok(!doc.beginDialog.actions.some((a) => a.id === "cancelAllDialogs_01At22"));
  assert.equal(validateWorkspace(root, "topics/Greeting.mcs.yml").errors, 0);
  assert.throws(() => editTopic(root, { topic: "Fallback", addTriggerPhrases: ["x"] }), /not by phrases/);
  assert.throws(() => editTopic(root, { topic: "Greeting", removeActionIds: ["missing"] }), /No top-level action/);
});

test("editTool and removeComponent handle inputs, descriptions and connection references", (t) => {
  const root = scaffold(t);
  addTool(root, { type: "connector", name: "Send Email", description: "Sends an email", connectorId: "shared_office365", operationId: "SendEmailV2", inputs: [{ kind: "automatic", name: "To", description: "recipient" }] }, "orc_OracleDefaultAgent");
  addTool(root, { type: "connector", name: "Send Email Again", description: "Sends another email", connectorId: "shared_office365", operationId: "SendEmailV2", connectionReference: readWorkspace(root).actions[0].details.connectionReference }, "orc_OracleDefaultAgent");
  const r = editTool(root, { tool: "Send Email", modelDescription: "Sends an email to a colleague on behalf of the user; needs a recipient and a subject.", addInputs: [{ kind: "automatic", name: "Subject", description: "subject line" }], removeInputs: ["To"], connectionMode: "Maker", operationId: "SendEmailV3" });
  assert.ok(r.changed.includes("modelDescription"));
  const doc = yaml.load(readFileSync(r.file, "utf8"));
  assert.deepEqual(doc.inputs.map((i) => i.propertyName), ["Subject"]);
  assert.equal(doc.action.connectionProperties.mode, "Maker");
  assert.equal(doc.action.operationId, "SendEmailV3");
  assert.equal(validateWorkspace(root, r.file).errors, 0);
  const first = removeComponent(root, { kind: "tool", name: "Send Email" });
  assert.equal(first.removed.length, 1);
  assert.ok(first.notes.some((n) => /kept/.test(n)), "shared reference must be kept while another tool uses it");
  const second = removeComponent(root, { kind: "tool", name: "Send Email Again" });
  assert.ok(second.notes.some((n) => /removed connection reference/.test(n)));
  assert.equal(readWorkspace(root).actions.length, 0);
  assert.equal(readWorkspace(root).connectionReferences.length, 0);
  assert.throws(() => removeComponent(root, { kind: "tool", name: "Send Email" }), /No tool named/);
});

test("editKnowledge and removing a redirected topic", (t) => {
  const root = scaffold(t);
  addKnowledgeSource(root, { name: "Docs", kind: "public-site", site: "https://docs.example.com" });
  const r = editKnowledge(root, { knowledge: "Docs", site: "https://docs.example.com/v2", triggerCondition: "Global.Region = \"EU\"", includeSubPages: false });
  const doc = yaml.load(readFileSync(r.file, "utf8"));
  assert.equal(doc.source.site, "https://docs.example.com/v2");
  assert.equal(doc.source.triggerCondition, '=Global.Region = "EU"');
  assert.equal(doc.source.includeSubPages, false);
  addTopic(root, { name: "Router", trigger: { kind: "phrases", phrases: ["route me", "send me somewhere", "where do I go"] }, actions: [{ type: "redirect", topic: "Docs Help" }], agentSchemaName: "orc_OracleDefaultAgent" });
  addTopic(root, { name: "Docs Help", trigger: { kind: "phrases", phrases: ["help with docs", "docs help", "documentation"] }, actions: [{ type: "message", text: "Here are the docs." }], agentSchemaName: "orc_OracleDefaultAgent" });
  const rm = removeComponent(root, { kind: "topic", name: "Docs Help" });
  assert.ok(rm.notes.some((n) => /still redirecting/.test(n) && /Router/.test(n)));
  assert.ok(!existsSync(join(root, "topics", "DocsHelp.mcs.yml")));
});

test("reviewWorkspace scores the scaffold and flags the classic mistakes", (t) => {
  const root = scaffold(t);
  const base = reviewWorkspace(root);
  assert.ok(base.findings.some((x) => x.rule === "instructions-missing"), "scaffold has empty instructions");
  assert.ok(!base.findings.some((x) => x.rule === "no-escalation"), "scaffold keeps the Escalate topic");
  assert.ok(!base.findings.some((x) => x.rule === "no-fallback"));
  // Make it worse: a tool without description, two topics sharing a phrase, SharePoint knowledge with auth None, a secret.
  addTool(root, { type: "connector", name: "Mystery", description: "x", connectorId: "shared_office365", operationId: "Op" }, "orc_OracleDefaultAgent");
  addTopic(root, { name: "A", trigger: { kind: "phrases", phrases: ["order status", "where is my order"] }, actions: [{ type: "message", text: "a" }] });
  addTopic(root, { name: "B", trigger: { kind: "phrases", phrases: ["order status", "track order", "track my order"] }, actions: [{ type: "message", text: "b" }] });
  addKnowledgeSource(root, { name: "HR", kind: "sharepoint", site: "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Policies" });
  writeFileSync(join(root, "settings.mcs.yml"), readFileSync(join(root, "settings.mcs.yml"), "utf8").replace("authenticationMode: Integrated", "authenticationMode: None"));
  mkdirSync(join(root, "variables"), { recursive: true });
  writeFileSync(join(root, "variables", "Leak.mcs.yml"), "name: Leak\nscope: Conversation\nkind: GlobalVariableComponent\nschemaName: x.globalvariable.Leak\ndefaultValue: password=SuperSecret123\n");
  const r = reviewWorkspace(root);
  const rulesHit = new Set(r.findings.map((x) => x.rule));
  for (const rule of ["tool-description", "topic-few-phrases", "topic-phrase-overlap", "auth-none-with-private-knowledge", "secret-in-yaml", "connection-unbound", "pack-only-workspace"]) assert.ok(rulesHit.has(rule), `expected ${rule}; got ${[...rulesHit].join(", ")}`);
  assert.ok(r.score < base.score);
  assert.match(renderReviewMarkdown(r), /Score \d/);
});
