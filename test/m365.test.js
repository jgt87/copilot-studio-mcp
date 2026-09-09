import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAPH_PACKAGES_SCOPE,
  GRAPH_PACKAGES_WRITE_SCOPE,
  buildFilter,
  getPackage,
  listPackages,
  listUrl,
  reassignPackage,
  setPackageBlocked,
  summarizePackages,
  toPackage,
} from "../dist/cloud/graphPackages.js";

const ID = "P_19ae1zz1-56bc-505a-3d42-156df75a4xxy";

const pkg = (over = {}) => ({
  id: ID,
  displayName: "Contoso HR Agent",
  type: "custom",
  shortDescription: "Agent that can answer HR questions",
  isBlocked: false,
  supportedHosts: ["Copilot"],
  elementTypes: ["DeclarativeAgent"],
  platform: "Copilot Studio",
  availableTo: "all",
  deployedTo: "all",
  lastModifiedDateTime: "2026-01-06T00:07:20.1467852Z",
  ...over,
});

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
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

test("the Graph scopes are delegated and distinct from the Power Platform ones", () => {
  assert.match(GRAPH_PACKAGES_SCOPE, /graph\.microsoft\.com\/CopilotPackages\.Read\.All$/);
  assert.match(GRAPH_PACKAGES_WRITE_SCOPE, /graph\.microsoft\.com\/CopilotPackages\.ReadWrite\.All$/);
  // .default would ask for every consented permission on the resource; these ask for one.
  assert.ok(!GRAPH_PACKAGES_SCOPE.endsWith("/.default"));
  assert.ok(!GRAPH_PACKAGES_SCOPE.includes("powerplatform"));
});

test("filters use the documented shapes, and only the documented fields", () => {
  assert.equal(buildFilter({ platform: "Copilot Studio" }), "platform eq 'Copilot Studio'");
  assert.equal(buildFilter({ host: "Copilot" }), "supportedHosts/any(h:h eq 'Copilot')");
  assert.equal(buildFilter({ elementType: "DeclarativeAgent" }), "elementTypes/any(e:e eq 'DeclarativeAgent')");
  assert.equal(buildFilter({ modifiedSince: "2026-01-01T00:00:00Z" }), "lastModifiedDateTime gt 2026-01-01T00:00:00Z");
  assert.equal(buildFilter({}), null);

  assert.equal(
    buildFilter({ platform: "Copilot Studio", host: "Teams" }),
    "platform eq 'Copilot Studio' and supportedHosts/any(h:h eq 'Teams')",
  );
  // a raw filter is parenthesised so it cannot change how the built clauses bind
  assert.equal(buildFilter({ platform: "X", filter: "a eq 1 or b eq 2" }), "platform eq 'X' and (a eq 1 or b eq 2)");
});

test("a quote in a filter value is escaped, not injected", () => {
  assert.equal(buildFilter({ platform: "O'Brien" }), "platform eq 'O''Brien'");
});

test("the list URL defaults to v1.0 and encodes the filter", () => {
  assert.equal(listUrl({}), "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages");
  assert.match(listUrl({ version: "beta" }), /^https:\/\/graph\.microsoft\.com\/beta\//);

  const url = listUrl({ platform: "Copilot Studio", top: 50 });
  assert.ok(url.includes("$filter=platform%20eq%20'Copilot%20Studio'"), url);
  assert.ok(url.includes("$top=50"));
});

test("listPackages maps the documented fields and leaves absent ones null", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ value: [pkg(), pkg({ id: "P_2", displayName: null, isBlocked: true, platform: null })] })]]);
  const r = await listPackages("tok", { fetchImpl });

  assert.equal(r.packages.length, 2);
  assert.equal(r.more, false);
  assert.equal(r.pages, 1);

  const [first, second] = r.packages;
  assert.equal(first.displayName, "Contoso HR Agent");
  assert.equal(first.platform, "Copilot Studio");
  assert.deepEqual(first.supportedHosts, ["Copilot"]);
  assert.equal(first.deployedTo, "all");
  assert.equal(first.isBlocked, false);

  assert.equal(second.displayName, null);
  assert.equal(second.platform, null);
  assert.equal(second.isBlocked, true);
  // absent collections are empty arrays, never undefined
  assert.deepEqual(second.supportedHosts, ["Copilot"]);
});

test("isBlocked false and isBlocked missing are different answers", () => {
  assert.equal(toPackage({ id: "a", isBlocked: false }).isBlocked, false);
  assert.equal(toPackage({ id: "a" }).isBlocked, null);
});

test("paging is off by default and reports that more exists", async () => {
  const fetchImpl = mockFetch([
    [(u) => !u.includes("skiptoken"), () => ({ value: [pkg()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=2" })],
    [() => true, () => ({ value: [pkg({ id: "P_2" })] })],
  ]);

  const one = await listPackages("tok", { fetchImpl });
  assert.equal(one.packages.length, 1);
  assert.equal(one.more, true, "one call is one request unless allPages is asked for");
  assert.equal(fetchImpl.calls.length, 1);

  const all = await listPackages("tok", { fetchImpl, allPages: true });
  assert.equal(all.packages.length, 2);
  assert.equal(all.more, false);
  assert.equal(all.pages, 2);
});

test("allPages stops at the page cap instead of following a runaway catalogue", async () => {
  // every page offers another one, forever
  const fetchImpl = mockFetch([[() => true, () => ({ value: [pkg()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=x" })]]);
  const r = await listPackages("tok", { fetchImpl, allPages: true });
  assert.equal(r.pages, 20);
  assert.equal(r.more, true, "stopping at the cap is not the same as reaching the end");
});

test("getPackage returns the mapped fields and the raw body", async () => {
  const raw = pkg({ somethingNew: "the reference documents more than the list rows" });
  const fetchImpl = mockFetch([[() => true, () => raw]]);
  const r = await getPackage("tok", ID, { fetchImpl });

  assert.equal(r.package.id, ID);
  assert.equal(r.raw.somethingNew, "the reference documents more than the list rows");
  assert.equal(fetchImpl.calls[0].url, `https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages/${encodeURIComponent(ID)}`);
});

test("block and unblock post to the right verb with no body, on beta only", async () => {
  const fetchImpl = mockFetch([[() => true, () => new Response(null, { status: 204 })]]);

  const blocked = await setPackageBlocked("tok", ID, true, { fetchImpl });
  assert.deepEqual(blocked, { id: ID, blocked: true, status: "blocked" });

  await setPackageBlocked("tok", ID, false, { fetchImpl });

  const [b, u] = fetchImpl.calls;
  assert.equal(b.method, "POST");
  assert.equal(b.body, null, "the reference says not to supply a request body");
  assert.ok(b.url.endsWith("/block"), b.url);
  assert.ok(u.url.endsWith("/unblock"), u.url);
  // these actions exist only on beta, whatever version a read used
  assert.ok(b.url.startsWith("https://graph.microsoft.com/beta/"), b.url);
});

test("reassign sends userId and nothing else", async () => {
  const fetchImpl = mockFetch([[() => true, () => new Response(null, { status: 204 })]]);
  const r = await reassignPackage("tok", ID, "12345678-1234-1234-1234-123456789012", { fetchImpl });

  assert.deepEqual(r, { id: ID, userId: "12345678-1234-1234-1234-123456789012", status: "reassigned" });
  const call = fetchImpl.calls[0];
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { userId: "12345678-1234-1234-1234-123456789012" });
  assert.ok(call.url.endsWith("/reassign"));
  assert.ok(call.url.startsWith("https://graph.microsoft.com/beta/"));
});

test("a missing licence is reported as such, not as a generic permission error", async () => {
  const fetchImpl = mockFetch([[() => true, () => new Response(JSON.stringify({ error: { code: "Forbidden" } }), { status: 403 })]]);
  await assert.rejects(
    () => listPackages("tok", { fetchImpl }),
    (err) => {
      assert.match(err.message, /Agent 365/);
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test("summarizePackages counts what an admin looks at first", () => {
  const packages = [
    pkg(),
    pkg({ id: "P_2", isBlocked: true }),
    pkg({ id: "P_3", platform: "Microsoft 365 Copilot Agent Builder", deployedTo: "none" }),
  ].map(toPackage);

  const s = summarizePackages(packages);
  assert.equal(s.total, 3);
  assert.equal(s.blocked, 1);
  assert.deepEqual(s.byPlatform, { "Copilot Studio": 2, "Microsoft 365 Copilot Agent Builder": 1 });
  assert.deepEqual(s.byDeployedTo, { all: 2, none: 1 });
});
