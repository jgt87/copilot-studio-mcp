import assert from "node:assert/strict";
import test from "node:test";

import { FLOW_SCOPE, getFlowRun, listFlowRuns, startFlowRun } from "../dist/cloud/flowruns.js";
import { createFlow } from "../dist/cloud/dataverse.js";

const ENV_ID = "11111111-2222-3333-4444-555555555555";
const FLOW = "w1";

const run = (over = {}) => ({
  id: `/providers/Microsoft.ProcessSimple/environments/${ENV_ID}/flows/${FLOW}/runs/08585`,
  name: "08585",
  properties: {
    status: "Succeeded",
    startTime: "2026-09-07T10:00:00Z",
    endTime: "2026-09-07T10:00:04Z",
    trigger: { name: "manual", status: "Succeeded", startTime: "2026-09-07T10:00:00Z" },
    ...over,
  },
});

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

test("the Flow service scope is a resource of its own and can be overridden", () => {
  assert.match(FLOW_SCOPE, /service\.flow\.microsoft\.com/);
  assert.ok(!FLOW_SCOPE.includes("powerplatform"), "the Power Automate service is not the Power Platform API");
});

test("listFlowRuns calls the Process Simple endpoint and summarises each run", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ value: [run(), run({ status: "Failed", endTime: "2026-09-07T10:00:09Z", error: { code: "ActionFailed", message: "SharePoint returned 403" } })] })]]);
  const runs = await listFlowRuns("tok", ENV_ID, FLOW, { top: 5, fetchImpl });
  const url = fetchImpl.calls[0].url;
  assert.match(url, /api\.flow\.microsoft\.com\/providers\/Microsoft\.ProcessSimple\/environments\//);
  assert.match(url, new RegExp(`environments/${ENV_ID}/flows/${FLOW}/runs`));
  assert.match(url, /api-version=2016-11-01/);
  assert.match(url, /\$top=5/);
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].status, runs[0].durationMs, runs[0].trigger.name], ["Succeeded", 4000, "manual"]);
  assert.equal(runs[0].error, null);
  assert.deepEqual(runs[1].error, { code: "ActionFailed", message: "SharePoint returned 403" });
  assert.equal(runs[1].durationMs, 9000);
});

test("getFlowRun reads one run and reports a missing one", async () => {
  const ok = mockFetch([[() => true, () => run()]]);
  const r = await getFlowRun("tok", ENV_ID, FLOW, "08585", ok);
  assert.match(ok.calls[0].url, /runs\/08585\?api-version=/);
  assert.equal(r.name, "08585");
  assert.equal(r.status, "Succeeded");

  const empty = mockFetch([[() => true, () => new Response(null, { status: 204 })]]);
  await assert.rejects(getFlowRun("tok", ENV_ID, FLOW, "nope", empty), /not found/);
  const denied = mockFetch([[() => true, () => new Response("forbidden", { status: 403 })]]);
  await assert.rejects(getFlowRun("tok", ENV_ID, FLOW, "08585", denied), /owner or co-owner/);
});

test("startFlowRun posts to the trigger, defaulting to 'manual'", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ ok: true })]]);
  const r = await startFlowRun("tok", ENV_ID, FLOW, { payload: { orderId: "A-1" }, fetchImpl });
  assert.match(fetchImpl.calls[0].url, /triggers\/manual\/run\?api-version=2016-11-01/);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.deepEqual(fetchImpl.calls[0].body, { orderId: "A-1" });
  assert.equal(r.triggerName, "manual");
  assert.equal(r.started, true);

  const named = mockFetch([[() => true, () => new Response(null, { status: 202 })]]);
  await startFlowRun("tok", ENV_ID, FLOW, { triggerName: "When_an_agent_calls_the_flow", fetchImpl: named });
  assert.match(named.calls[0].url, /triggers\/When_an_agent_calls_the_flow\/run/);
  assert.deepEqual(named.calls[0].body, {}, "an empty body when no payload is given");

  const wrong = mockFetch([[() => true, () => new Response("no such trigger", { status: 404 })]]);
  await assert.rejects(startFlowRun("tok", ENV_ID, FLOW, { triggerName: "recurrence", fetchImpl: wrong }), /only manually started flows/);
});

test("createFlow writes a modern cloud flow row, switched off, optionally into a solution", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ workflowid: "new-1" })]]);
  const definition = { $schema: "https://schema.management.azure.com/x#", triggers: { manual: { type: "Request", kind: "Skills" } }, actions: {} };
  const r = await createFlow("https://org.crm.dynamics.com", "tok", { name: "Lookup Order", definition, description: "Reads an order", solutionUniqueName: "orc_Agents", connectionReferences: { shared_sharepointonline: {} } }, fetchImpl);
  const call = fetchImpl.calls[0];
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/api\/data\/v9\.2\/workflows$/);
  assert.equal(call.headers["MSCRM.SolutionUniqueName"], "orc_Agents");
  assert.match(call.headers.Prefer, /return=representation/);
  assert.equal(call.body.category, 5, "modern cloud flow");
  assert.equal(call.body.type, 1);
  assert.equal(call.body.primaryentity, "none");
  assert.deepEqual([call.body.statecode, call.body.statuscode], [0, 1], "created switched off");
  const sent = JSON.parse(call.body.clientdata);
  assert.deepEqual(sent.properties.definition, definition);
  assert.deepEqual(Object.keys(sent.properties.connectionReferences), ["shared_sharepointonline"]);
  assert.deepEqual(r, { workflowId: "new-1", name: "Lookup Order", state: "Draft", solution: "orc_Agents" });

  const plain = mockFetch([[() => true, () => ({ workflowid: "new-2" })]]);
  await createFlow("https://org.crm.dynamics.com", "tok", { name: "Standalone", definition }, plain);
  assert.ok(!("MSCRM.SolutionUniqueName" in plain.calls[0].headers), "no solution header when no solution is given");
  await assert.rejects(createFlow("https://org.crm.dynamics.com", "tok", { name: "No definition" }, plain), /needs a definition/);
});
