// Every authoring builder, then the whole workspace through cs_validate's own
// entry point. The per-builder tests validate one file each; this one exists
// because cs_add_variable wrote a file cs_validate rejected and nothing noticed:
// a builder whose output blocks cs_push is the bug, whichever builder it is.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readWorkspace } from "../dist/workspace.js";
import { validateWorkspace, topicReferenceNames } from "../dist/validate.js";
import { addTopic } from "../dist/authoring/topics.js";
import { addKnowledgeSource } from "../dist/authoring/knowledge.js";
import { addTool } from "../dist/authoring/tools.js";
import { addTrigger } from "../dist/authoring/triggers.js";
import { addGlobalVariable } from "../dist/authoring/variables.js";
import { editTopic, editTool, editKnowledge } from "../dist/authoring/edit.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function fixtureCopy(t, name) {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const target = join(dir, name);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

const problems = (v, severities) => v.files.flatMap((f) => f.diagnostics.filter((d) => severities.includes(d.severity)).map((d) => `${f.file}: ${d.message}`));

test("every builder and editor leaves a workspace cs_validate passes", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  const schema = "eval_testAgent";

  addKnowledgeSource(root, { name: "Public Docs", kind: "public-site", site: "https://docs.example.com/product" });
  addKnowledgeSource(root, { name: "HR", kind: "sharepoint", site: "https://contoso.sharepoint.com/sites/HR" });
  addKnowledgeSource(root, { name: "ServiceNow", kind: "graph-connector", connectionEnvironmentVariable: "orc_SnowConn", connectionName: "servicenow" });

  // A display name that is not its own file stem: the redirect below must still resolve.
  addTopic(root, { name: "order status", agentSchemaName: schema, trigger: { kind: "phrases", phrases: ["where is my order", "track my order"] }, actions: [{ type: "message", text: "Let me check." }] });
  addTopic(root, {
    name: "Caller",
    agentSchemaName: schema,
    trigger: { kind: "phrases", phrases: ["help me with an order", "order question"] },
    actions: [
      { type: "message", text: ["Text with # a hash, a colon: here", "yes"] },
      { type: "question", prompt: "Which region?", variable: "Region", choices: ["EU", "US"] },
      { type: "setVariable", variable: "Checked", value: true },
      { type: "searchKnowledge", sources: ["Public Docs"] },
      { type: "condition", cases: [{ condition: "Topic.Region = \"EU\"", actions: [{ type: "redirect", topic: "order status" }] }], else: [{ type: "redirect", topic: "Escalate" }] },
      { type: "end" },
    ],
  });

  addTool(root, { type: "connector", name: "Send Email", description: "Sends an email to a colleague", connectorId: "shared_office365", operationId: "SendEmailV2", inputs: [{ kind: "automatic", name: "To", description: "recipient", entity: "Email" }], outputs: ["Response"] }, schema);
  addTool(root, { type: "mcp", name: "Learn MCP", description: "Microsoft Learn documentation", connectorId: "shared_microsoftlearndocsmcpserver" }, schema);
  addTool(root, { type: "flow", name: "Lookup Order", description: "Looks up an order", flowId: "00000000-0000-0000-0000-000000000002" }, schema);
  addTrigger(root, { name: "New Ticket", flowId: "00000000-0000-0000-0000-000000000003" });
  addGlobalVariable(root, { name: "User Region", defaultValue: "EU", description: "Region of the signed-in user", agentSchemaName: schema });

  editTopic(root, { topic: "Caller", addTriggerPhrases: ["status of my order"], appendActions: [{ type: "message", text: "Anything else?" }], agentSchemaName: schema });
  editTool(root, { tool: "Send Email", modelDescription: "Sends an email to a colleague on behalf of the user; needs a recipient.", addInputs: [{ kind: "automatic", name: "Subject", description: "subject line" }] });
  editKnowledge(root, { knowledge: "Public Docs", triggerCondition: "Global.UserRegion = \"EU\"" });

  const v = validateWorkspace(root);
  assert.deepEqual(problems(v, ["error"]), []);
  assert.deepEqual(problems(v, ["warning"]).filter((m) => /redirect target|Unknown property|Missing required/.test(m)), []);
  assert.equal(readWorkspace(root).variables.length, 1);
});

test("a builder run without the agent schema name leaves an error, not a push", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  addGlobalVariable(root, { name: "Region" });
  const v = validateWorkspace(root, "variables/Region.mcs.yml");
  assert.ok(problems(v, ["error"]).some((m) => /<AGENT_SCHEMA>/.test(m)), JSON.stringify(v));
  assert.ok(!problems(v, ["warning"]).some((m) => /Angle-bracket/.test(m)), "the marker is reported once, as an error");
});

test("the variable file is held to its own rules, not the Dataverse row", (t) => {
  const root = fixtureCopy(t, "basic-agent");
  mkdirSync(join(root, "variables"), { recursive: true });
  const file = join(root, "variables", "Bad.mcs.yml");
  writeFileSync(file, "name: Bad\naIVisibility: HideFromAIContext\nscope: Conversation\nschemaName: x.globalvariable.Other\nkind: GlobalVariableComponent\n");
  const v = validateWorkspace(root, file);
  assert.ok(problems(v, ["error"]).some((m) => /aIVisibility 'HideFromAIContext'/.test(m)));
  assert.ok(problems(v, ["warning"]).some((m) => /should end in \.globalvariable\.Bad/.test(m)));
  assert.ok(!problems(v, ["error"]).some((m) => /Missing required property 'variable'/.test(m)));
});

test("topic references resolve by file stem as well as display name", () => {
  const names = topicReferenceNames({ topics: [{ name: "order status", file: "/w/topics/OrderStatus.mcs.yml" }, { name: "Orders", file: "/w/topics/orders.topic.mcs.yml" }] });
  for (const n of ["OrderStatus", "orderstatus", "orders", "orders.topic", "Orders"]) assert.ok(names.has(n), n);
});
