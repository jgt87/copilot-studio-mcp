import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { parseSwaggerOperations, toDefinition, writeConnectorDefinition, readConnectorDefinition, writeConnectorList, readConnectorList, checkOperation, inputsFromOperation, searchConnectors, loadSeed, parseModelList } from "../dist/catalog.js";
import { addTool, TOOL_KIND_SUPPORT, connectorFromReference } from "../dist/authoring/tools.js";
import { validKindsFromOneOf } from "../dist/schema.js";
import { validateDocument } from "../dist/schemaValidate.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const SWAGGER = {
  swagger: "2.0",
  info: { title: "Test" },
  paths: {
    "/mail/send": {
      post: {
        operationId: "SendEmailV2",
        summary: "Send an email (V2)",
        "x-ms-visibility": "important",
        parameters: [
          { name: "emailMessage", in: "body", required: true, schema: { $ref: "#/definitions/EmailMessage" } },
          { name: "x-internal", in: "header", required: false, "x-ms-visibility": "internal" },
        ],
        responses: { "200": { description: "ok", schema: { type: "object", properties: { id: { type: "string" } } } } },
      },
    },
    "/calendars/{calendarId}/events": {
      get: {
        operationId: "GetEventsV3",
        summary: "Get events (V3)",
        parameters: [
          { name: "calendarId", in: "path", required: true, type: "string", "x-ms-summary": "Calendar id", "x-ms-dynamic-values": { operationId: "CalendarGetTables" } },
          { name: "$top", in: "query", required: false, type: "integer" },
        ],
        responses: { "200": { description: "ok", schema: { $ref: "#/definitions/EventList" } } },
      },
    },
    "/mcp": {
      "x-ms-agentic-protocol": "mcp-streamable-1.0",
      post: { operationId: "InvokeMCP", summary: "MCP endpoint", parameters: [], responses: { "200": { description: "ok" } } },
    },
  },
  definitions: {
    EmailMessage: { type: "object", required: ["To", "Subject"], properties: { To: { type: "string", description: "Recipients" }, Subject: { type: "string" }, Body: { type: "string", "x-ms-visibility": "advanced" }, Importance: { type: "string", "x-ms-visibility": "internal" } } },
    EventList: { type: "object", properties: { value: { type: "array" } } },
  },
};

test("parseSwaggerOperations extracts operations, body parameters and the MCP marker", () => {
  const { operations, mcp } = parseSwaggerOperations(SWAGGER);
  assert.equal(mcp, true);
  assert.deepEqual(operations.map((o) => o.operationId), ["GetEventsV3", "InvokeMCP", "SendEmailV2"]);
  const send = operations.find((o) => o.operationId === "SendEmailV2");
  assert.equal(send.method, "POST");
  assert.deepEqual(send.parameters.filter((p) => p.required).map((p) => p.name), ["To", "Subject"]);
  assert.equal(send.parameters.find((p) => p.name === "Importance").visibility, "internal");
  assert.deepEqual(send.responseProperties, ["id"]);
  const events = operations.find((o) => o.operationId === "GetEventsV3");
  assert.equal(events.parameters[0].dynamicValues, true);
  assert.equal(events.parameters[0].summary, "Calendar id");
  assert.equal(operations.find((o) => o.operationId === "InvokeMCP").mcp, true);
  assert.equal(send.mcp, false);
});

test("inputsFromOperation keeps required non-internal parameters and maps types", () => {
  const { operations } = parseSwaggerOperations(SWAGGER);
  const inputs = inputsFromOperation(operations.find((o) => o.operationId === "SendEmailV2"));
  assert.deepEqual(inputs.map((i) => i.name), ["To", "Subject"]);
  assert.equal(inputs[0].description, "Recipients");
  const ev = inputsFromOperation({ ...operations.find((o) => o.operationId === "GetEventsV3"), parameters: [{ name: "n", in: "query", required: true, type: "integer", description: null, summary: null, visibility: null, dynamicValues: false }] });
  assert.equal(ev[0].entity, "Number");
});

test("catalog cache round-trips and checkOperation uses it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = { name: "shared_office365", id: "/providers/Microsoft.PowerApps/apis/shared_office365", properties: { displayName: "Office 365 Outlook", tier: "Standard", isCustomApi: false } };
  const def = toDefinition(api, SWAGGER);
  assert.equal(def.displayName, "Office 365 Outlook");
  assert.equal(def.mcp, true);
  writeConnectorDefinition(dir, "env-1", def);
  assert.equal(readConnectorDefinition(dir, "env-1", "shared_office365").operations.length, 3);
  assert.equal(readConnectorDefinition(dir, null, "shared_office365").name, "shared_office365");
  assert.equal(readConnectorDefinition(dir, "env-2", "shared_office365"), null);
  writeConnectorList(dir, "env-1", [{ name: "shared_office365", id: api.id, displayName: "Office 365 Outlook", description: null, publisher: null, tier: null, isCustom: false, mcpLikely: false, iconUri: null }]);
  assert.equal(readConnectorList(dir, "env-1").connectors.length, 1);
  const ok = checkOperation(dir, "env-1", "shared_office365", "SendEmailV2");
  assert.equal(ok.known, true);
  assert.equal(ok.operationFound, true);
  const bad = checkOperation(dir, "env-1", "shared_office365", "SendEmailV9");
  assert.equal(bad.operationFound, false);
  assert.ok(bad.suggestions.includes("SendEmailV2"));
  assert.equal(checkOperation(dir, "env-1", "shared_unknown", "X").known, false);
});

test("seed and search resolve display names to connector ids", () => {
  const seed = loadSeed();
  assert.ok(seed.length > 500, `seed has ${seed.length} connectors`);
  const outlook = searchConnectors("Office 365 Outlook", seed);
  assert.equal(outlook.length, 1);
  assert.equal(outlook[0].name, "shared_office365");
  assert.equal(searchConnectors("office365", seed)[0].name, "shared_office365");
  assert.ok(searchConnectors("sharepoint", seed).some((c) => c.name === "shared_sharepointonline"));
});

test("parseModelList reads pac copilot model list", () => {
  const rows = parseModelList("Id                                   State    Name\n32a9e265-1149-4155-af54-d2856d2b83f5 Active   Document Processing 2023/09/20, 12:21:40\n3fbd4e5c-32bc-40fc-acce-59c2821cf113 Inactive Empty Dynamic Prompt\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Document Processing 2023/09/20, 12:21:40");
  assert.equal(rows[1].state, "Inactive");
});

test("every TaskAction kind in the schema is classified in TOOL_KIND_SUPPORT", () => {
  const kinds = validKindsFromOneOf("TaskAction");
  assert.ok(kinds.length >= 10);
  for (const k of kinds) assert.ok(k in TOOL_KIND_SUPPORT, `schema kind ${k} is not classified in TOOL_KIND_SUPPORT (add it as typed or raw)`);
  for (const k of Object.keys(TOOL_KIND_SUPPORT)) assert.ok(kinds.includes(k), `TOOL_KIND_SUPPORT lists ${k}, which the schema no longer has`);
});

test("addTool writes prompt, connected-agent, child-agent and raw tools", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "basic-agent");
  cpSync(join(FIXTURES, "basic-agent"), root, { recursive: true });
  const prompt = addTool(root, { type: "prompt", name: "Summarise Ticket", description: "Summarises a ticket", aiModelId: "11111111-2222-3333-4444-555555555555" }, "eval_testAgent");
  const connected = addTool(root, { type: "connected-agent", name: "HR Agent", description: "Hands HR questions to the HR agent", botSchemaName: "cr1_hrAgent" }, "eval_testAgent");
  const child = addTool(root, { type: "child-agent", name: "Billing", description: "Billing specialist", gptComponentSchemaName: "eval_testAgent.gpt.Billing" }, "eval_testAgent");
  const raw = addTool(root, { type: "raw", name: "Legacy Skill", description: "Bot Framework skill", action: { kind: "InvokeSkillTaskAction", skillId: "s1", actionId: "a1" } }, "eval_testAgent");
  for (const r of [prompt, connected, child, raw]) {
    const text = readFileSync(r.file, "utf8");
    const diags = validateDocument(yaml.load(text), text);
    assert.deepEqual(diags.filter((d) => d.severity === "error"), [], `${r.file}: ${JSON.stringify(diags)}`);
  }
  assert.equal(prompt.actionKind, "InvokeAIBuilderModelTaskAction");
  assert.equal(yaml.load(readFileSync(prompt.file, "utf8")).action.aIModelId, "11111111-2222-3333-4444-555555555555");
  assert.equal(yaml.load(readFileSync(connected.file, "utf8")).action.botSchemaName, "cr1_hrAgent");
  assert.equal(child.actionKind, "InvokeAgentTaskAction");
  assert.equal(raw.actionKind, "InvokeSkillTaskAction");
  assert.throws(() => addTool(root, { type: "raw", name: "Bad", description: "x", action: { kind: "NotAKind" } }), /Unknown TaskAction kind/);
  assert.equal(connectorFromReference("eval_testAgent.shared_office365.abc123"), "shared_office365");
  assert.equal(connectorFromReference("orc_ref", [{ connectionReferenceLogicalName: "orc_ref", connectorId: "/providers/Microsoft.PowerApps/apis/shared_teams" }]), "shared_teams");
});
