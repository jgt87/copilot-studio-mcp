import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { addTopic, buildActions } from "../dist/authoring/topics.js";
import { validateWorkspace } from "../dist/validate.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("card, transfer, endConversation and scoped searchKnowledge nodes validate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-nodes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, "agent");
  cpSync(join(FIXTURES, "pac-default"), root, { recursive: true });
  const card = { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.5", body: [{ type: "Input.Text", id: "orderNumber", label: "Order number" }], actions: [{ type: "Action.Submit", title: "Look up" }] };
  const r = addTopic(root, {
    name: "Order Lookup",
    trigger: { kind: "phrases", phrases: ["look up my order", "order lookup", "find order"] },
    agentSchemaName: "orc_OracleDefaultAgent",
    actions: [
      { type: "card", card: { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "Welcome" }] } },
      { type: "card", card, outputs: { orderNumber: "OrderNumber" }, outputTypes: { orderNumber: "String" } },
      { type: "searchKnowledge", sources: ["Docs"], autoSend: false, endIfAnswered: false },
      { type: "transfer", message: "Customer asked about an order" },
      { type: "transfer", phoneNumber: "+31201234567" },
      { type: "endConversation" },
    ],
  });
  const text = readFileSync(r.file, "utf8");
  const doc = yaml.load(text);
  const actions = doc.beginDialog.actions;
  assert.equal(actions[0].kind, "SendActivity");
  assert.equal(actions[0].activity.attachments[0].kind, "AdaptiveCardTemplate");
  assert.match(actions[0].activity.attachments[0].cardContent, /"TextBlock"/);
  assert.equal(actions[1].kind, "AdaptiveCardPrompt");
  assert.deepEqual(actions[1].output.binding, { orderNumber: "Topic.OrderNumber" });
  assert.deepEqual(actions[1].outputType.properties, { orderNumber: { type: "String" } });
  assert.equal(actions[2].kind, "SearchAndSummarizeContent");
  assert.equal(actions[2].autoSend, false);
  assert.deepEqual(actions[2].knowledgeSources, { kind: "SearchSpecificKnowledgeSources", knowledgeSources: ["orc_OracleDefaultAgent.topic.Docs"] });
  assert.equal(actions[3].kind, "TransferConversationV2");
  assert.equal(actions[3].transferType.kind, "TransferToAgent");
  assert.equal(actions[4].transferType.kind, "TransferToPhoneNumber");
  assert.equal(actions[5].kind, "EndConversation");
  const v = validateWorkspace(root, r.file);
  assert.deepEqual(v.files[0].diagnostics.filter((d) => d.severity === "error"), [], JSON.stringify(v.files[0].diagnostics));
  assert.equal(buildActions([{ type: "endConversation" }]).length, 1);
});
