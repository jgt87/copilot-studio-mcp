import assert from "node:assert/strict";
import test from "node:test";

import { actionKey, buildFlow, flowMetadata } from "../dist/authoring/flowBuilder.js";

const def = (built) => built.definition;

test("the default flow is agent-callable, typed, and answers with the outputs", () => {
  const built = buildFlow({
    name: "Lookup Order",
    trigger: { kind: "agent", inputs: [{ name: "orderId", description: "The order to look up" }, { name: "includeLines", type: "boolean", required: false }] },
    steps: [{ type: "http", name: "Call order API", method: "GET", uri: "https://api.contoso.com/orders/@{triggerBody()?['orderId']}" }],
    outputs: [{ name: "status", value: "@{body('Call_order_API')?['status']}" }, { name: "total", type: "number", value: "@{body('Call_order_API')?['total']}" }],
  });
  const d = def(built);
  assert.equal(d.$schema, "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#");
  const trigger = d.triggers.When_an_agent_calls_the_flow;
  assert.deepEqual([trigger.type, trigger.kind], ["Request", "Skills"]);
  assert.deepEqual(trigger.inputs.schema.properties.orderId, { type: "string", description: "The order to look up", title: "orderId" });
  assert.deepEqual(trigger.inputs.schema.required, ["orderId"], "a step marked required: false is not required");

  assert.deepEqual(Object.keys(d.actions), ["Call_order_API", "Respond_to_the_agent"], "spaces become underscores and a response is appended");
  assert.deepEqual(d.actions.Call_order_API.runAfter, {}, "the first step runs immediately");
  assert.deepEqual(d.actions.Respond_to_the_agent.runAfter, { Call_order_API: ["Succeeded"] }, "each step waits for the previous one");
  assert.equal(d.actions.Respond_to_the_agent.inputs.body.total, "@{body('Call_order_API')?['total']}");
  assert.equal(d.actions.Respond_to_the_agent.inputs.schema.properties.total.type, "number");
  assert.deepEqual(built.connections, [], "no connectors, no connection references");
  assert.equal(built.clientData.properties.definition, d);
});

test("connector steps produce OpenApiConnection actions and collect connection references", () => {
  const built = buildFlow({
    name: "Notify team",
    connectionReferencePrefix: "contoso",
    steps: [
      { type: "connector", name: "List rows", connectorId: "shared_commondataserviceforapps", operationId: "ListRecords", parameters: { entityName: "accounts", $filter: "statecode eq 0" } },
      { type: "connector", name: "Send an email", connectorId: "shared_office365", operationId: "SendEmailV2", parameters: { emailMessage: { To: "ops@contoso.com", Subject: "Accounts" } }, description: "Tell the ops team" },
      { type: "connector", name: "Send another email", connectorId: "shared_office365", operationId: "SendEmailV2", parameters: {} },
    ],
    outputs: [{ name: "sent", type: "boolean", value: "@{true}" }],
  });
  const d = def(built);
  const list = d.actions.List_rows;
  assert.equal(list.type, "OpenApiConnection");
  assert.deepEqual(list.inputs.host, { apiId: "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps", connectionName: "shared_commondataserviceforapps", operationId: "ListRecords" });
  assert.equal(list.inputs.parameters.entityName, "accounts");
  assert.equal(list.inputs.authentication, "@parameters('$authentication')");
  assert.equal(d.actions.Send_an_email.description, "Tell the ops team");

  assert.deepEqual(
    built.connections.map((c) => c.connectionReference),
    ["contoso_commondataserviceforapps", "contoso_office365"],
    "one reference per connector, reused by the second Office 365 step",
  );
  assert.deepEqual(Object.keys(built.connectionReferences), ["shared_commondataserviceforapps", "shared_office365"]);
  assert.equal(built.connectionReferences.shared_office365.connection.connectionReferenceLogicalName, "contoso_office365");
  assert.match(built.notes.join(" "), /2 connection reference\(s\) are needed/);
  assert.match(built.notes.join(" "), /only turns on once they are bound/);
});

test("conditions, loops and scopes nest their own chained actions", () => {
  const built = buildFlow({
    name: "Triage",
    steps: [
      { type: "initializeVariable", name: "Init count", variable: "count", valueType: "number", value: 0 },
      {
        type: "condition",
        name: "Is it urgent",
        expression: "@equals(triggerBody()?['priority'],'high')",
        then: [
          { type: "connector", name: "Post to Teams", connectorId: "shared_teams", operationId: "PostMessageToChannelV3" },
          { type: "setVariable", name: "Bump count", variable: "count", value: 1 },
        ],
        else: [{ type: "terminate", name: "Stop", status: "Succeeded" }],
      },
      { type: "foreach", name: "For each line", items: "@body('Post_to_Teams')?['lines']", actions: [{ type: "compose", name: "Line", value: "@item()" }] },
      { type: "scope", name: "Cleanup", actions: [{ type: "compose", name: "Note", value: "done" }] },
    ],
  });
  const d = def(built);
  const cond = d.actions.Is_it_urgent;
  assert.equal(cond.type, "If");
  assert.equal(cond.expression, "@equals(triggerBody()?['priority'],'high')");
  assert.deepEqual(Object.keys(cond.actions), ["Post_to_Teams", "Bump_count"]);
  assert.deepEqual(cond.actions.Bump_count.runAfter, { Post_to_Teams: ["Succeeded"] }, "nested steps chain too");
  assert.deepEqual(Object.keys(cond.else.actions), ["Stop"]);
  assert.equal(cond.else.actions.Stop.inputs.runStatus, "Succeeded");
  assert.equal(d.actions.For_each_line.type, "Foreach");
  assert.equal(d.actions.For_each_line.foreach, "@body('Post_to_Teams')?['lines']");
  assert.equal(d.actions.Cleanup.type, "Scope");
  assert.ok(built.connections.some((c) => c.connectorId === "shared_teams"), "a connector inside a condition still needs its connection");
  assert.equal(d.actions.Init_count.inputs.variables[0].type, "number");
});

test("the other triggers, and what they mean for the response", () => {
  const rec = buildFlow({ name: "Nightly", trigger: { kind: "recurrence", frequency: "Day", interval: 1, timeZone: "W. Europe Standard Time" }, steps: [{ type: "compose", name: "Work", value: "x" }] });
  assert.equal(def(rec).triggers.Recurrence.recurrence.frequency, "Day");
  assert.deepEqual(Object.keys(def(rec).actions), ["Work"], "a scheduled flow gets no response step");

  const http = buildFlow({ name: "Webhook", trigger: { kind: "http", method: "POST", inputs: [{ name: "payload", type: "object" }] }, steps: [] });
  assert.equal(def(http).triggers.manual.inputs.method, "POST");

  const dv = buildFlow({
    name: "On new account",
    trigger: { kind: "connector", connectorId: "shared_commondataserviceforapps", operationId: "SubscribeWebhookTrigger", parameters: { entityName: "accounts", scope: 4 } },
    steps: [{ type: "compose", name: "Note", value: "@triggerOutputs()" }],
  });
  const key = Object.keys(def(dv).triggers)[0];
  assert.equal(def(dv).triggers[key].type, "OpenApiConnection");
  assert.equal(def(dv).triggers[key].inputs.parameters.entityName, "accounts");
  assert.equal(dv.connections.length, 1, "a connector trigger needs a connection too");

  const raw = buildFlow({ name: "Custom", trigger: { kind: "raw", name: "My trigger", json: { type: "Request", kind: "Http" } }, steps: [] });
  assert.ok(def(raw).triggers.My_trigger);

  const agentNoOutputs = buildFlow({ name: "Bare", steps: [] });
  assert.ok(def(agentNoOutputs).actions.Respond_to_the_agent, "agent flows always answer");
  assert.match(agentNoOutputs.notes.join(" "), /empty body/);
  assert.match(agentNoOutputs.notes.join(" "), /no steps/);
});

test("bad specs are refused, and names are normalised predictably", () => {
  assert.throws(() => buildFlow({ name: "" }), /needs a name/);
  assert.throws(() => buildFlow({ name: "X", steps: [{ type: "compose", name: "Same", value: 1 }, { type: "compose", name: "Same", value: 2 }] }), /Two steps are named 'Same'/);
  assert.throws(() => buildFlow({ name: "X", steps: [{ type: "nonsense", name: "N" }] }), /Unknown flow step type 'nonsense'/);
  assert.throws(() => buildFlow({ name: "X", trigger: { kind: "nope" } }), /Unknown flow trigger kind 'nope'/);
  assert.equal(actionKey("Send an e-mail (v2)!"), "Send_an_e-mail_v2");
  assert.equal(actionKey("   "), "Action");
  assert.match(flowMetadata({ name: "Lookup Order" }).schemaName, /Lookup Order|LookupOrder/);
  assert.equal(flowMetadata({ name: "Lookup Order", description: "d" }, "contoso_LookupOrder").kind, "CloudFlowDefinition");
});
