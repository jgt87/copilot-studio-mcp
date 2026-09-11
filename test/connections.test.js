/**
 * Connections and the two ways a flow names one.
 *
 * Which shape a flow uses decides where the binding is written: into the
 * flow's own clientdata, or into a connectionreference row. Getting that wrong
 * writes a binding nothing reads, so both shapes are pinned here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isUsable, listConnections } from "../dist/cloud/connections.js";
import { bindConnectionInClientData, bindConnectionReference, connectionReferenceLogicalName, connectionReferenceShape, connectorOfReference, deleteFlow, flowConnectionReferences } from "../dist/cloud/dataverse.js";

const ENV_ID = "11111111-2222-3333-4444-555555555555";
const ENV_URL = "https://org.crm.dynamics.com";

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    for (const [match, respond] of routes) {
      if (match(url, init)) {
        const r = respond();
        return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
      }
    }
    return new Response("no route", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const connection = (name, over = {}) => ({
  name,
  id: `/providers/Microsoft.PowerApps/apis/shared_office365/connections/${name}`,
  properties: { displayName: `${name}@example.com`, apiId: "/providers/Microsoft.PowerApps/apis/shared_office365", statuses: [{ status: "Connected" }], createdBy: { userPrincipalName: `${name}@example.com` }, ...over },
});

/** A flow that names its connection directly: the shape a flow built outside a solution has. */
const INVOKER_CLIENT_DATA = {
  properties: {
    connectionReferences: { shared_office365: { connectionName: "old-conn", source: "Invoker", id: "/providers/Microsoft.PowerApps/apis/shared_office365", tier: "NotSpecified" } },
    definition: { triggers: {}, actions: {} },
  },
};

/** A flow that arrived in a solution: it points at a connectionreference row instead. */
const SOLUTION_CLIENT_DATA = {
  properties: {
    connectionReferences: { shared_sharepointonline: { api: { name: "shared_sharepointonline" }, connection: { connectionReferenceLogicalName: "orc_sharedsharepointonline_a1b2" }, runtimeSource: "embedded" } },
    definition: { triggers: {}, actions: {} },
  },
};

test("listConnections asks the per-connector route and shapes each row", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ value: [connection("b1"), connection("a2", { statuses: [{ status: "Error", error: { message: "The credentials have expired" } }] })] })]]);
  const rows = await listConnections("tok", ENV_ID, { connectorId: "shared_office365", fetchImpl });
  const url = fetchImpl.calls[0].url;
  assert.match(url, /api\.powerapps\.com\/providers\/Microsoft\.PowerApps\/apis\/shared_office365\/connections/);
  assert.match(url, /api-version=2016-11-01/);
  assert.match(decodeURIComponent(url), new RegExp(`environment eq '${ENV_ID}'`));
  assert.equal(rows.length, 2);
  const [a2, b1] = rows;
  assert.deepEqual([a2.name, a2.connectorId, a2.status, a2.statusDetail], ["a2", "shared_office365", "Error", "The credentials have expired"]);
  assert.equal(b1.createdBy, "b1@example.com");
  assert.ok(isUsable(b1) && !isUsable(a2), "a connection whose credentials expired cannot be bound");
});

test("listConnections without a connector uses the environment-wide route and follows nextLink", async () => {
  let page = 0;
  const fetchImpl = mockFetch([[() => true, () => (page++ === 0 ? { value: [connection("p1")], nextLink: "https://api.powerapps.com/next" } : { value: [connection("p2")] })]]);
  const rows = await listConnections("tok", ENV_ID, { fetchImpl });
  assert.match(fetchImpl.calls[0].url, /Microsoft\.PowerApps\/connections\?/);
  assert.equal(fetchImpl.calls[1].url, "https://api.powerapps.com/next");
  assert.deepEqual(rows.map((r) => r.name), ["p1", "p2"]);
  assert.equal(rows[0].connectorId, "shared_office365", "the connector comes from the row's own apiId when none was asked for");
});

test("a connection reference is read as one of the two shapes the product produces", () => {
  assert.equal(connectionReferenceShape(INVOKER_CLIENT_DATA.properties.connectionReferences.shared_office365), "invoker");
  assert.equal(connectionReferenceShape(SOLUTION_CLIENT_DATA.properties.connectionReferences.shared_sharepointonline), "solution");
  assert.equal(connectionReferenceShape({}), "unknown");
  assert.equal(connectionReferenceLogicalName(SOLUTION_CLIENT_DATA.properties.connectionReferences.shared_sharepointonline), "orc_sharedsharepointonline_a1b2");
  assert.equal(connectionReferenceLogicalName(INVOKER_CLIENT_DATA.properties.connectionReferences.shared_office365), null);

  assert.equal(connectorOfReference("shared_office365_1", {}), "shared_office365", "a second connection to the same connector is suffixed");
  assert.equal(connectorOfReference("anything", { api: { name: "shared_sql" } }), "shared_sql");
  assert.equal(connectorOfReference("anything", { id: "/providers/Microsoft.PowerApps/apis/shared_teams" }), "shared_teams");
});

test("flowConnectionReferences inventories what a flow needs and what is already bound", () => {
  assert.deepEqual(flowConnectionReferences(INVOKER_CLIENT_DATA), [{ key: "shared_office365", connectorId: "shared_office365", shape: "invoker", connectionName: "old-conn", logicalName: null }]);
  assert.deepEqual(flowConnectionReferences(SOLUTION_CLIENT_DATA), [{ key: "shared_sharepointonline", connectorId: "shared_sharepointonline", shape: "solution", connectionName: null, logicalName: "orc_sharedsharepointonline_a1b2" }]);
  assert.deepEqual(flowConnectionReferences(null), [], "a flow with unreadable clientdata has no references, not an error");
});

test("bindConnectionInClientData replaces one binding and leaves every other key alone", () => {
  const two = { properties: { connectionReferences: { ...INVOKER_CLIENT_DATA.properties.connectionReferences, shared_sql: { connectionName: "sql-1", source: "Invoker", id: "/providers/Microsoft.PowerApps/apis/shared_sql" } } } };
  const refs = bindConnectionInClientData(two, "shared_office365", "new-conn");
  assert.equal(refs.shared_office365.connectionName, "new-conn");
  assert.equal(refs.shared_office365.tier, "NotSpecified", "fields the server does not understand survive the edit");
  assert.equal(refs.shared_office365.source, "Invoker");
  assert.deepEqual(refs.shared_sql, two.properties.connectionReferences.shared_sql, "the other connection is untouched");

  const fresh = bindConnectionInClientData({ properties: { connectionReferences: { shared_teams_1: {} } } }, "shared_teams_1", "c9");
  assert.deepEqual(fresh.shared_teams_1, { connectionName: "c9", id: "/providers/Microsoft.PowerApps/apis/shared_teams", source: "Invoker" }, "an entry with nothing in it is filled in from the key");
});

test("bindConnectionReference writes the connection onto the row, and names a reference that is not there", async () => {
  const rows = { value: [{ connectionreferenceid: "cr-1", connectionreferencelogicalname: "orc_sharedsharepointonline_a1b2", connectionreferencedisplayname: "SharePoint", connectorid: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline", connectionid: null }] };
  const fetchImpl = mockFetch([
    [(u, i) => (i.method ?? "GET") === "GET", () => rows],
    [() => true, () => new Response(null, { status: 204 })],
  ]);
  const r = await bindConnectionReference(ENV_URL, "tok", "ORC_SharedSharePointOnline_a1b2", "conn-9", fetchImpl);
  const patch = fetchImpl.calls[1];
  assert.equal(patch.method, "PATCH");
  assert.match(patch.url, /\/connectionreferences\(cr-1\)$/);
  assert.deepEqual(patch.body, { connectionid: "conn-9" }, "the row stores the connection's short name, not its resource id");
  assert.deepEqual(r, { logicalName: "orc_sharedsharepointonline_a1b2", connectionId: "conn-9", previousConnectionId: null });

  const empty = mockFetch([[() => true, () => ({ value: [] })]]);
  await assert.rejects(bindConnectionReference(ENV_URL, "tok", "orc_missing", "conn-9", empty), /No connection reference 'orc_missing'/);
});

test("deleteFlow refuses a managed flow before it asks Dataverse", async () => {
  const managed = mockFetch([[() => true, () => ({ workflowid: "w1", name: "Imported", statecode: 1, ismanaged: true, clientdata: "{}" })]]);
  await assert.rejects(deleteFlow(ENV_URL, "tok", "w1", managed), /managed/);
  assert.equal(managed.calls.length, 1, "no DELETE is sent for a flow that cannot be deleted");

  const own = mockFetch([
    [(u, i) => (i.method ?? "GET") === "GET", () => ({ workflowid: "w2", name: "Lookup Order", statecode: 0, ismanaged: false, clientdata: "{}" })],
    [() => true, () => new Response(null, { status: 204 })],
  ]);
  const r = await deleteFlow(ENV_URL, "tok", "w2", own);
  assert.equal(own.calls[1].method, "DELETE");
  assert.match(own.calls[1].url, /\/workflows\(w2\)$/);
  assert.deepEqual(r, { workflowId: "w2", name: "Lookup Order", deleted: true });
});
