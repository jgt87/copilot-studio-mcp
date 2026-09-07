import assert from "node:assert/strict";
import test from "node:test";

import { FLOW_STATES, getFlow, listFlows, setFlowState, updateFlow } from "../dist/cloud/dataverse.js";

const ENV = "https://org.crm.dynamics.com";

const CLIENT_DATA = {
  properties: {
    connectionReferences: { shared_sharepointonline: { connection: { connectionReferenceLogicalName: "orc_sp" } } },
    definition: {
      $schema: "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
      triggers: { When_an_agent_calls_the_flow: { type: "Request", kind: "Skills" } },
      actions: { Get_items: { type: "OpenApiConnection" }, Respond: { type: "Response" } },
    },
  },
  schemaVersion: "1.0.0.0",
};

const flowRow = (over = {}) => ({
  workflowid: "w1",
  name: "Lookup Order",
  description: "Reads an order",
  statecode: 1,
  modifiedon: "2026-09-05T10:00:00Z",
  ismanaged: false,
  "_modifiedby_value@OData.Community.Display.V1.FormattedValue": "Jane Maker",
  "_ownerid_value@OData.Community.Display.V1.FormattedValue": "Ops Team",
  ...over,
});

/** Records every request and answers from a script of [predicate, response] pairs. */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, prefer: init.headers?.Prefer });
    for (const [match, respond] of routes) {
      if (match(url, init)) {
        const r = respond(calls.length);
        return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
      }
    }
    return new Response("no route", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

test("listFlows filters on category, name and managed state, and reads formatted values", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ value: [flowRow(), flowRow({ workflowid: "w2", name: "Draft one", statecode: 0 })] })]]);
  const flows = await listFlows(ENV, "tok", { search: "Order", includeManaged: false, top: 10, fetchImpl });
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /\/workflows\?/);
  assert.match(url, /category eq 5/);
  assert.match(url, /ismanaged eq false/);
  assert.match(url, /contains\(name,'Order'\)/);
  assert.match(fetchImpl.calls[0].url, /\$top=10/);
  assert.match(fetchImpl.calls[0].prefer, /FormattedValue/);
  assert.deepEqual(flows.map((f) => [f.name, f.state, f.modifiedBy, f.owner]), [["Lookup Order", "Activated", "Jane Maker", "Ops Team"], ["Draft one", "Draft", "Jane Maker", "Ops Team"]]);
  const plain = mockFetch([[() => true, () => ({ value: [] })]]);
  await listFlows(ENV, "tok", { fetchImpl: plain });
  const filter = /\$filter=([^&]*)/.exec(plain.calls[0].url)[1];
  assert.ok(!decodeURIComponent(filter).includes("ismanaged"), "managed flows are listed by default");
});

test("getFlow parses clientdata into triggers, actions and connection references", async () => {
  const fetchImpl = mockFetch([[() => true, () => flowRow({ clientdata: JSON.stringify(CLIENT_DATA) })]]);
  const f = await getFlow(ENV, "tok", "w1", fetchImpl);
  assert.equal(f.name, "Lookup Order");
  assert.equal(f.state, "Activated");
  assert.deepEqual(f.triggers, ["When_an_agent_calls_the_flow"]);
  assert.deepEqual(f.actions, ["Get_items", "Respond"]);
  assert.deepEqual(f.connectionReferences, ["shared_sharepointonline"]);
  assert.equal(f.clientData.schemaVersion, "1.0.0.0");
  assert.equal(typeof f.clientDataRaw, "string");

  const broken = mockFetch([[() => true, () => flowRow({ clientdata: "{not json" })]]);
  const f2 = await getFlow(ENV, "tok", "w1", broken);
  assert.equal(f2.clientData, null, "unparseable clientdata must not throw");
  assert.deepEqual(f2.triggers, []);

  const missing = mockFetch([[() => true, () => new Response(null, { status: 204 })]]);
  await assert.rejects(getFlow(ENV, "tok", "nope", missing), /not found/);
});

test("setFlowState patches the documented statecode pairs and reports the transition", async () => {
  let state = 0;
  const fetchImpl = mockFetch([
    [(url, init) => (init.method ?? "GET") === "PATCH", () => new Response(null, { status: 204 })],
    [() => true, () => flowRow({ statecode: state, clientdata: JSON.stringify(CLIENT_DATA) })],
  ]);
  const r = await setFlowState(ENV, "tok", "w1", "on", (url, init) => {
    if ((init?.method ?? "GET") === "PATCH") state = 1;
    return fetchImpl(url, init);
  });
  const patch = fetchImpl.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { statecode: 1, statuscode: 2 });
  assert.match(patch.url, /workflows\(w1\)$/);
  assert.deepEqual(r, { workflowId: "w1", name: "Lookup Order", previousState: "Draft", state: "Activated" });
  assert.deepEqual(FLOW_STATES.off, { statecode: 0, statuscode: 1 });

  const refuse = mockFetch([
    [(url, init) => (init.method ?? "GET") === "PATCH", () => new Response("connection reference is not bound", { status: 400 })],
    [() => true, () => flowRow({ statecode: 0, clientdata: JSON.stringify(CLIENT_DATA) })],
  ]);
  await assert.rejects(setFlowState(ENV, "tok", "w1", "on", refuse), /connection references are bound/);
});

test("updateFlow swaps only the definition and keeps the connection references", async () => {
  const fetchImpl = mockFetch([
    [(url, init) => (init.method ?? "GET") === "PATCH", () => new Response(null, { status: 204 })],
    [() => true, () => flowRow({ clientdata: JSON.stringify(CLIENT_DATA) })],
  ]);
  const definition = { triggers: { When_an_agent_calls_the_flow: { type: "Request", kind: "Skills" } }, actions: { Respond: { type: "Response" } } };
  const r = await updateFlow(ENV, "tok", "w1", { definition, description: "Now simpler" }, fetchImpl);
  const patch = fetchImpl.calls.find((c) => c.method === "PATCH");
  const sent = JSON.parse(patch.body.clientdata);
  assert.deepEqual(sent.properties.definition, definition, "the new definition is written");
  assert.deepEqual(sent.properties.connectionReferences, CLIENT_DATA.properties.connectionReferences, "connection references survive");
  assert.equal(sent.schemaVersion, "1.0.0.0", "untouched fields survive");
  assert.equal(patch.body.description, "Now simpler");
  assert.deepEqual(r.changed, ["description", "definition"]);

  const whole = mockFetch([
    [(url, init) => (init.method ?? "GET") === "PATCH", () => new Response(null, { status: 204 })],
    [() => true, () => flowRow({ clientdata: JSON.stringify(CLIENT_DATA) })],
  ]);
  await updateFlow(ENV, "tok", "w1", { clientData: { properties: { definition: {} } } }, whole);
  assert.deepEqual(JSON.parse(whole.calls.find((c) => c.method === "PATCH").body.clientdata), { properties: { definition: {} } });

  const noData = mockFetch([[() => true, () => flowRow({ clientdata: null })]]);
  await assert.rejects(updateFlow(ENV, "tok", "w1", { definition }, noData), /no readable clientdata/);
  const nothing = mockFetch([[() => true, () => flowRow({ clientdata: JSON.stringify(CLIENT_DATA) })]]);
  await assert.rejects(updateFlow(ENV, "tok", "w1", {}, nothing), /Nothing to update/);
});
