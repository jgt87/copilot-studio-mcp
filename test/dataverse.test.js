import assert from "node:assert/strict";
import test from "node:test";

import { dataverseScope, listBots, listConnectionReferences, listEnvironmentVariables, publishBot, whoAmI } from "../dist/cloud/dataverse.js";

const ENV = "https://org.crm.dynamics.com";
const ME = "11111111-1111-1111-1111-111111111111";

/** Answers requests from a list of [predicate, response] pairs and records every call. */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
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

const whoAmIRoute = [(url) => url.endsWith("/WhoAmI"), () => ({ UserId: ME, OrganizationId: "org-1" })];

const botRow = (over = {}) => ({
  botid: "b1",
  name: "Helpdesk",
  schemaname: "orc_Helpdesk",
  _ownerid_value: ME,
  publishedon: "2026-09-01T00:00:00Z",
  modifiedon: "2026-09-02T00:00:00Z",
  authenticationmode: 2,
  ismanaged: false,
  ...over,
});

test("dataverseScope trims the trailing slash and asks for the default scope", () => {
  assert.equal(dataverseScope(ENV), `${ENV}/.default`);
  assert.equal(dataverseScope(`${ENV}///`), `${ENV}/.default`);
});

test("whoAmI returns the signed-in user and organisation", async () => {
  const fetchImpl = mockFetch([whoAmIRoute]);
  assert.deepEqual(await whoAmI(ENV, "tok", fetchImpl), { userId: ME, organizationId: "org-1" });
  assert.match(fetchImpl.calls[0].url, /\/api\/data\/v9\.2\/WhoAmI$/);
  await assert.rejects(whoAmI(ENV, "tok", mockFetch([[() => true, () => new Response(null, { status: 204 })]])), /no body/);
});

test("listBots filters managed agents out by default and marks the caller's own", async () => {
  const fetchImpl = mockFetch([whoAmIRoute, [() => true, () => ({ value: [botRow(), botRow({ botid: "b2", name: "Other", _ownerid_value: "someone-else" })] })]]);
  const bots = await listBots(ENV, "tok", { fetchImpl });
  const listUrl = decodeURIComponent(fetchImpl.calls[1].url);
  assert.match(listUrl, /\/bots\?/);
  assert.match(listUrl, /ismanaged eq false/);
  assert.ok(!listUrl.includes("_ownerid_value eq"), "every owner by default");
  assert.match(listUrl, /\$orderby=name/);
  assert.deepEqual(
    bots.map((b) => [b.name, b.schemaName, b.ownedByCurrentUser, b.authenticationMode, b.isManaged]),
    [
      ["Helpdesk", "orc_Helpdesk", true, 2, false],
      ["Other", "orc_Helpdesk", false, 2, false],
    ],
  );
});

test("listBots can include managed agents and restrict to the caller's own", async () => {
  const fetchImpl = mockFetch([whoAmIRoute, [() => true, () => ({ value: [] })]]);
  await listBots(ENV, "tok", { includeManaged: true, ownerOnly: true, fetchImpl });
  // Only the filter matters here: `ismanaged` is also one of the selected columns.
  const filter = decodeURIComponent(/\$filter=([^&]*)/.exec(fetchImpl.calls[1].url)[1]);
  assert.ok(!filter.includes("ismanaged"), "managed agents are included");
  assert.match(filter, new RegExp(`_ownerid_value eq ${ME}`));

  const none = mockFetch([whoAmIRoute, [() => true, () => new Response(null, { status: 204 })]]);
  assert.deepEqual(await listBots(ENV, "tok", { fetchImpl: none }), [], "an empty body is no agents, not a crash");
});

test("publishBot posts the bound action and polls until the publish date changes", async () => {
  let published = "2026-09-01T00:00:00Z";
  const fetchImpl = mockFetch([
    [(url) => url.includes("PvaPublish"), () => new Response(null, { status: 204 })],
    [() => true, () => ({ botid: "b1", name: "Helpdesk", schemaname: "orc_Helpdesk", publishedon: published, modifiedon: null, authenticationmode: 2 })],
  ]);
  const sleeps = [];
  const r = await publishBot(ENV, "tok", "b1", {
    fetchImpl,
    pollMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
      published = "2026-09-08T12:00:00Z"; // the platform finishes publishing while we wait
    },
  });
  assert.equal(r.completed, true);
  assert.equal(r.previousPublishedOn, "2026-09-01T00:00:00Z");
  assert.equal(r.publishedOn, "2026-09-08T12:00:00Z");
  assert.equal(typeof r.durationMs, "number");
  assert.deepEqual(sleeps, [10]);
  const post = fetchImpl.calls.find((c) => c.method === "POST");
  assert.match(post.url, /\/bots\(b1\)\/Microsoft\.Dynamics\.CRM\.PvaPublish$/);
});

test("publishBot gives up rather than hanging when the publish date never moves", async () => {
  const fetchImpl = mockFetch([
    [(url) => url.includes("PvaPublish"), () => new Response(null, { status: 204 })],
    [() => true, () => ({ botid: "b1", name: "Helpdesk", publishedon: "2026-09-01T00:00:00Z", authenticationmode: 1 })],
  ]);
  let waited = 0;
  const r = await publishBot(ENV, "tok", "b1", { fetchImpl, timeoutMs: 45, pollMs: 10, sleep: async (ms) => void (waited += ms) });
  assert.equal(r.completed, false);
  assert.equal(r.publishedOn, null);
  assert.ok(waited >= 40, `polled for ${waited}ms before giving up`);
});

test("connection references and environment variables are read with their values", async () => {
  const refs = mockFetch([[() => true, () => ({ value: [{ connectionreferenceid: "cr-1", connectionreferencelogicalname: "orc_sp", connectionreferencedisplayname: "SharePoint", connectorid: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline", connectionid: null }] })]]);
  // The row id comes back too: binding the reference to a connection is a PATCH by id.
  assert.deepEqual(await listConnectionReferences(ENV, "tok", refs), [{ id: "cr-1", logicalName: "orc_sp", displayName: "SharePoint", connectorId: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline", connectionId: null }]);
  assert.match(decodeURIComponent(refs.calls[0].url), /connectionreferences\?/);

  const vars = mockFetch([
    [
      () => true,
      () => ({
        value: [
          { schemaname: "orc_ApiUrl", displayname: "API URL", type: 100000000, defaultvalue: "https://dev", environmentvariabledefinition_environmentvariablevalue: [{ value: "https://test" }] },
          { schemaname: "orc_Flag", displayname: "Flag", type: 100000002, defaultvalue: "false", environmentvariabledefinition_environmentvariablevalue: [] },
        ],
      }),
    ],
  ]);
  const list = await listEnvironmentVariables(ENV, "tok", vars);
  assert.deepEqual(list.map((v) => [v.schemaName, v.type, v.defaultValue, v.currentValue]), [
    ["orc_ApiUrl", "String", "https://dev", "https://test"],
    ["orc_Flag", "Boolean", "false", null],
  ]);
  assert.match(decodeURIComponent(vars.calls[0].url), /\$expand=environmentvariabledefinition_environmentvariablevalue/);
});

test("an error carries the status and a hint the caller can act on", async () => {
  const denied = mockFetch([whoAmIRoute, [() => true, () => new Response("privilege missing", { status: 403 })]]);
  await assert.rejects(listBots(ENV, "tok", { fetchImpl: denied }), (err) => {
    assert.match(err.message, /403/);
    assert.match(err.message, /permission/i);
    return true;
  });
});
