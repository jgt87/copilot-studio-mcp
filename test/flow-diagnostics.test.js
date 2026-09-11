/**
 * Flow run diagnostics, against recorded Power Automate service responses.
 *
 * The shapes here are the ones the module claims to handle: an action whose
 * error the service reports directly, a connector action whose error is only
 * in its outputs blob, and a content link that has expired.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFlowHealth, classifyFailure, compareRuns, comparisonVerdict, differingKeys, divergence, durationStats, errorFromOutputs, explainRun, healthVerdict, isFailure, isPending, pickBaseline } from "../dist/flowDiagnostics.js";
import { listRunActions, readContentLink } from "../dist/cloud/flowruns.js";

const ENV_ID = "11111111-2222-3333-4444-555555555555";
const FLOW = "w1";

/** Routes are [predicate, respond] pairs; the first match answers. */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    for (const [match, respond] of routes) {
      if (match(url)) {
        const r = respond(url);
        return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
      }
    }
    return new Response("no route", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const action = (name, over = {}) => ({
  name,
  id: `/actions/${name}`,
  properties: { status: "Succeeded", startTime: "2026-09-07T10:00:00Z", endTime: "2026-09-07T10:00:01Z", ...over },
});

const link = (key) => ({ uri: `https://blob.core.windows.net/${key}?sig=abc`, contentSize: 120 });

const runBody = (over = {}) => ({
  id: `/providers/Microsoft.ProcessSimple/environments/${ENV_ID}/flows/${FLOW}/runs/08585`,
  name: "08585",
  properties: { status: "Failed", startTime: "2026-09-07T10:00:00Z", endTime: "2026-09-07T10:00:09Z", trigger: { name: "manual", status: "Succeeded", outputsLink: link("trigger-failed") }, ...over },
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("status vocabulary separates faults, successes and runs still going", () => {
  assert.ok(isFailure("Failed") && isFailure("TimedOut") && isFailure("Aborted"));
  assert.ok(!isFailure("Cancelled"), "a cancelled run is a person's decision, not a fault");
  assert.ok(!isFailure("Succeeded") && !isFailure(null));
  assert.ok(isPending("Running") && isPending("Waiting"));
  assert.ok(!isPending("Failed"), "a failure has finished and must count towards the failure rate");
});

test("errorFromOutputs digs the message out of the shapes connectors actually write", () => {
  assert.deepEqual(errorFromOutputs({ statusCode: 403, headers: {}, body: { error: { code: "Forbidden", message: "Access denied to the site" } } }), { message: "Access denied to the site", code: "Forbidden", statusCode: 403 });
  assert.deepEqual(errorFromOutputs({ statusCode: 400, body: { message: "The item does not exist" } }), { message: "The item does not exist", statusCode: 400 });
  assert.deepEqual(errorFromOutputs({ error: { code: "BadGateway", message: "Upstream failed" } }), { message: "Upstream failed", code: "BadGateway" });
  assert.deepEqual(errorFromOutputs({ statusCode: 500, body: "Internal server error" }), { message: "Internal server error", statusCode: 500 });
  assert.deepEqual(errorFromOutputs("plain text failure"), { message: "plain text failure" });
  assert.equal(errorFromOutputs({ statusCode: 200, body: { value: [] } }), null, "a successful body carries no error");
  assert.equal(errorFromOutputs(null), null);
});

test("classifyFailure tells a connector fault from a definition fault", () => {
  assert.equal(classifyFailure({ status: "Failed", code: "ActionFailed" }, { message: "denied", statusCode: 403, source: "outputs" }), "connector");
  assert.equal(classifyFailure({ status: "Failed", code: "InvalidTemplate" }, { message: "unable to process template", source: "action" }), "expression");
  assert.equal(classifyFailure({ status: "TimedOut", code: null }, null), "timeout");
  assert.equal(classifyFailure({ status: "Cancelled", code: null }, null), "cancelled");
  assert.equal(classifyFailure({ status: "Failed", code: null }, null), "other");
});

test("durationStats reports the spread, not just an average", () => {
  const s = durationStats([1000, 2000, 3000, 4000, 100000]);
  assert.deepEqual([s.count, s.minMs, s.medianMs, s.maxMs], [5, 1000, 3000, 100000]);
  assert.ok(s.p90Ms >= s.medianMs);
  assert.equal(durationStats([]), null);
  assert.equal(durationStats([Number.NaN]), null, "runs with no end time are not durations");
});

test("pickBaseline takes the most recent success and never the run being explained", () => {
  const runs = [
    { name: "c", status: "Failed", startTime: "2026-09-07T12:00:00Z" },
    { name: "b", status: "Succeeded", startTime: "2026-09-07T11:00:00Z" },
    { name: "a", status: "Succeeded", startTime: "2026-09-07T09:00:00Z" },
  ];
  assert.equal(pickBaseline(runs, "c").name, "b");
  assert.equal(pickBaseline(runs, "b").name, "a", "the failed run is excluded even when it succeeded");
  assert.equal(pickBaseline([runs[0]], "c"), null);
});

test("divergence names the first action that did not do what the baseline did", () => {
  const failed = [
    { name: "Get_items", status: "Succeeded", startTime: "2026-09-07T10:00:00Z" },
    { name: "Send_mail", status: "Failed", startTime: "2026-09-07T10:00:02Z" },
  ];
  const baseline = new Map([
    ["Get_items", { name: "Get_items", status: "Succeeded", startTime: "2026-09-06T10:00:00Z" }],
    ["Send_mail", { name: "Send_mail", status: "Succeeded", startTime: "2026-09-06T10:00:02Z" }],
  ]);
  assert.deepEqual(divergence(failed, baseline), { action: "Send_mail", baseline: "Succeeded", failed: "Failed" });
  assert.deepEqual(divergence(failed, new Map()), { action: "Get_items", baseline: null, failed: "Succeeded" }, "an action the baseline never had is itself the divergence");
  assert.equal(divergence([failed[0]], baseline), null);
});

test("differingKeys compares trigger payloads by key and never returns a value", () => {
  const d = differingKeys({ body: { orderId: "A-2", region: "EU", extra: 1 } }, { body: { orderId: "A-1", region: "EU" } });
  assert.deepEqual(d.changed, ["orderId"]);
  assert.deepEqual(d.onlyInFailed, ["extra"]);
  assert.deepEqual(d.onlyInBaseline, []);
  assert.ok(!JSON.stringify(d).includes("A-2"), "key names only: the values are the user's data");
  assert.equal(differingKeys("text", {}), null);
});

test("the verdicts say what to do, and a definition change outranks a data difference", () => {
  const shapeChanged = comparisonVerdict({ divergesAt: { action: "New_step", baseline: null, failed: "Failed" }, onlyInFailed: ["New_step"], onlyInBaseline: [], triggerData: { compared: false } });
  assert.match(shapeChanged, /definition changed/i);
  const sameInput = comparisonVerdict({ divergesAt: { action: "Send_mail", baseline: "Succeeded", failed: "Failed" }, onlyInFailed: [], onlyInBaseline: [], triggerData: { compared: true, identical: true } });
  assert.match(sameInput, /not a bad input/i);
  const differentInput = comparisonVerdict({ divergesAt: { action: "Send_mail", baseline: "Succeeded", failed: "Failed" }, onlyInFailed: [], onlyInBaseline: [], triggerData: { compared: true, identical: false, changed: ["orderId"], onlyInFailed: [] } });
  assert.match(differentInput, /data-dependent/i);

  assert.match(healthVerdict({ completed: 0, failed: 0, failureRate: null, failingActions: [], triggerFailures: 0, failuresSampled: 0 }), /nothing to judge/i);
  assert.match(healthVerdict({ completed: 20, failed: 0, failureRate: 0, failingActions: [], triggerFailures: 0, failuresSampled: 0 }), /All 20/);
  assert.match(healthVerdict({ completed: 20, failed: 5, failureRate: 0.25, failingActions: [{ action: "Send_mail", runs: 5, share: 1 }], triggerFailures: 0, failuresSampled: 5 }), /concentrate on one action, 'Send_mail'/);
  assert.match(healthVerdict({ completed: 20, failed: 5, failureRate: 0.25, failingActions: [{ action: "A", runs: 2, share: 0.4 }, { action: "B", runs: 2, share: 0.4 }, { action: "C", runs: 1, share: 0.2 }], triggerFailures: 0, failuresSampled: 5 }), /spread over 3 actions/);
  assert.match(healthVerdict({ completed: 10, failed: 4, failureRate: 0.4, failingActions: [], triggerFailures: 4, failuresSampled: 4 }), /trigger/i);
});

// ---------------------------------------------------------------------------
// The service calls
// ---------------------------------------------------------------------------

test("listRunActions reads the actions route and keeps the content links", async () => {
  const fetchImpl = mockFetch([[() => true, () => ({ value: [action("Send_mail", { status: "Failed", code: "Forbidden", outputsLink: link("out"), inputsLink: link("in"), retryHistory: [{}, {}] })] })]]);
  const [a] = await listRunActions("tok", ENV_ID, FLOW, "08585", { fetchImpl });
  assert.match(fetchImpl.calls[0].url, new RegExp(`flows/${FLOW}/runs/08585/actions\\?api-version=2016-11-01`));
  assert.deepEqual([a.name, a.status, a.code, a.retryCount, a.durationMs], ["Send_mail", "Failed", "Forbidden", 2, 1000]);
  assert.match(a.outputsLink.uri, /blob\.core\.windows\.net/);
});

test("readContentLink sends no bearer token, and says so when the link has expired", async () => {
  const ok = mockFetch([[() => true, () => ({ statusCode: 403, body: { error: { message: "denied" } } })]]);
  const got = await readContentLink(link("out"), { fetchImpl: ok });
  assert.equal(got.value.statusCode, 403);
  assert.ok(!("Authorization" in ok.calls[0].headers), "a SAS URI plus a bearer token makes Azure Blob refuse the read");

  const expired = mockFetch([[() => true, () => new Response("Signature not valid", { status: 403 })]]);
  const gone = await readContentLink(link("out"), { fetchImpl: expired });
  assert.equal(gone.value, null);
  assert.match(gone.error, /expired/);

  const huge = await readContentLink({ uri: "https://blob/x", contentSize: 10_000_000 }, { fetchImpl: mockFetch([]) });
  assert.match(huge.error, /over the .*-byte cap/);
  assert.equal(huge.truncated, true);

  const notJson = mockFetch([[() => true, () => new Response("<html>oops</html>", { status: 200 })]]);
  assert.equal((await readContentLink(link("out"), { fetchImpl: notJson })).value, "<html>oops</html>", "a non-JSON blob is content, not an error");

  assert.match((await readContentLink(null)).error, /no content link/);
});

test("explainRun resolves a connector error from the outputs blob and pairs it with upstream context", async () => {
  const fetchImpl = mockFetch([
    [(u) => /\/runs\/08585\/actions/.test(u), () => ({
      value: [
        action("Load_settings", { outputsLink: link("settings") }),
        action("Get_items", { startTime: "2026-09-07T10:00:01Z", endTime: "2026-09-07T10:00:02Z", outputsLink: link("items") }),
        action("Send_mail", { status: "Failed", code: "ActionFailed", startTime: "2026-09-07T10:00:03Z", endTime: "2026-09-07T10:00:04Z", outputsLink: link("send-out"), inputsLink: link("send-in") }),
        action("Log_result", { status: "Skipped", startTime: "2026-09-07T10:00:05Z" }),
      ],
    })],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody()],
    [(u) => /send-out/.test(u), () => ({ statusCode: 403, body: { error: { code: "Forbidden", message: "The mailbox is not accessible" } } })],
    [(u) => /send-in/.test(u), () => ({ method: "post", body: { To: "nobody@example.com" } })],
    [(u) => /items/.test(u), () => ({ body: { value: [{ id: 1 }] } })],
    [(u) => /settings/.test(u), () => ({ body: { mode: "live" } })],
  ]);

  const r = await explainRun("tok", ENV_ID, FLOW, "08585", { fetchImpl });
  assert.equal(r.actionCount, 4);
  assert.equal(r.failed.length, 1);
  const failed = r.failed[0];
  assert.equal(failed.name, "Send_mail");
  assert.deepEqual(failed.resolvedError, { message: "The mailbox is not accessible", code: "Forbidden", statusCode: 403, source: "outputs" });
  assert.equal(failed.kind, "connector");
  assert.deepEqual(failed.inputs.body, { To: "nobody@example.com" });
  assert.match(r.verdict, /'Send_mail' failed: The mailbox is not accessible/);
  assert.match(r.verdict, /connection is still authorised/);
  assert.deepEqual(r.upstream.map((u) => u.name), ["Load_settings", "Get_items"], "the successes before the failure, in order");
  assert.deepEqual(r.upstream[1].outputs.body, { value: [{ id: 1 }] });
  assert.ok(r.notes.some((n) => /Skipped/.test(n)), "skipped actions are consequences and must be labelled as such");
});

test("explainRun prefers the service's own error, and reports a trigger failure as such", async () => {
  const direct = mockFetch([
    [(u) => /\/actions/.test(u), () => ({ value: [action("Compute_batches", { status: "Failed", code: "InvalidTemplate", error: { code: "InvalidTemplate", message: "Unable to process template language expressions" } })] })],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody()],
    [() => true, () => new Response("should not be fetched", { status: 500 })],
  ]);
  const r = await explainRun("tok", ENV_ID, FLOW, "08585", { fetchImpl: direct, includeInputs: false });
  assert.equal(r.failed[0].resolvedError.source, "action");
  assert.equal(r.failed[0].kind, "expression");
  assert.match(r.verdict, /definition is at fault/);

  const triggerFailed = mockFetch([
    [(u) => /\/actions/.test(u), () => ({ value: [] })],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody({ trigger: { name: "When_a_row_is_added", status: "Failed" } })],
  ]);
  const t = await explainRun("tok", ENV_ID, FLOW, "08585", { fetchImpl: triggerFailed });
  assert.match(t.verdict, /trigger 'When_a_row_is_added' failed/);
  assert.ok(t.notes.some((n) => /none of the flow's actions ran/.test(n)));
});

test("compareRuns finds its own baseline and separates a data difference from a logic one", async () => {
  const actionsFor = (runId) =>
    runId === "08585"
      ? { value: [action("Get_items"), action("Send_mail", { status: "Failed", startTime: "2026-09-07T10:00:03Z" })] }
      : { value: [action("Get_items"), action("Send_mail", { startTime: "2026-09-06T10:00:03Z" })] };
  const fetchImpl = mockFetch([
    [(u) => /\/runs\?/.test(u), () => ({ value: [runBody(), { name: "08500", properties: { status: "Succeeded", startTime: "2026-09-06T10:00:00Z", endTime: "2026-09-06T10:00:05Z", trigger: { name: "manual", status: "Succeeded", outputsLink: link("trigger-baseline") } } }] })],
    [(u) => /\/runs\/08585\/actions/.test(u), () => actionsFor("08585")],
    [(u) => /\/runs\/08500\/actions/.test(u), () => actionsFor("08500")],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody()],
    [(u) => /trigger-failed/.test(u), () => ({ body: { orderId: "A-2", region: "EU" } })],
    [(u) => /trigger-baseline/.test(u), () => ({ body: { orderId: "A-1", region: "EU" } })],
  ]);

  const c = await compareRuns("tok", ENV_ID, FLOW, "08585", { compareTriggerData: true, fetchImpl });
  assert.equal(c.baselineRunId, "08500");
  assert.deepEqual(c.divergesAt, { action: "Send_mail", baseline: "Succeeded", failed: "Failed" });
  assert.deepEqual(c.statusChanges, [{ action: "Send_mail", baseline: "Succeeded", failed: "Failed" }]);
  assert.deepEqual([c.onlyInFailed, c.onlyInBaseline], [[], []]);
  assert.deepEqual(c.triggerData.changed, ["orderId"]);
  assert.equal(c.triggerData.identical, false);
  assert.match(c.verdict, /data-dependent/);
});

test("compareRuns says so when there is no successful run to compare against", async () => {
  const fetchImpl = mockFetch([
    [(u) => /\/runs\?/.test(u), () => ({ value: [runBody()] })],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody()],
  ]);
  const c = await compareRuns("tok", ENV_ID, FLOW, "08585", { fetchImpl });
  assert.equal(c.baselineRunId, null);
  assert.match(c.verdict, /no successful run/i);
  assert.ok(c.notes.some((n) => /never worked/.test(n)));
});

test("analyzeFlowHealth attributes failures to actions and counts only finished runs", async () => {
  const runs = [
    runBody(),
    { name: "08584", properties: { status: "Failed", startTime: "2026-09-07T09:00:00Z", endTime: "2026-09-07T09:00:08Z", trigger: { name: "manual", status: "Succeeded" } } },
    { name: "08583", properties: { status: "Succeeded", startTime: "2026-09-07T08:00:00Z", endTime: "2026-09-07T08:00:02Z", trigger: { name: "manual", status: "Succeeded" } } },
    { name: "08582", properties: { status: "Running", startTime: "2026-09-07T07:00:00Z", trigger: { name: "manual", status: "Succeeded" } } },
  ];
  const fetchImpl = mockFetch([
    [(u) => /\/runs\?/.test(u), () => ({ value: runs })],
    [(u) => /\/actions/.test(u), () => ({ value: [action("Get_items"), action("Send_mail", { status: "Failed" })] })],
  ]);

  const h = await analyzeFlowHealth("tok", ENV_ID, FLOW, { fetchImpl });
  assert.equal(h.runsExamined, 4);
  assert.equal(h.completed, 3, "the Running run is not a completed one");
  assert.equal(h.failed, 2);
  assert.ok(Math.abs(h.failureRate - 2 / 3) < 1e-9);
  assert.deepEqual(h.byStatus, { Failed: 2, Succeeded: 1, Running: 1 });
  assert.deepEqual(h.failingActions, [{ action: "Send_mail", runs: 2, share: 1 }]);
  assert.equal(h.duration.count, 3);
  assert.match(h.verdict, /concentrate on one action, 'Send_mail'/);
});

test("upstream context survives actions the service returned without timestamps", async () => {
  const untimed = (name, over = {}) => ({ name, id: `/actions/${name}`, properties: { status: "Succeeded", ...over } });
  const fetchImpl = mockFetch([
    [(u) => /\/actions/.test(u), () => ({ value: [untimed("Load_settings", { outputsLink: link("settings") }), untimed("Send_mail", { status: "Failed", code: "ActionFailed", outputsLink: link("send-out") })] })],
    [(u) => /\/runs\/08585\?/.test(u), () => runBody()],
    [(u) => /send-out/.test(u), () => ({ statusCode: 500, body: { message: "boom" } })],
    [(u) => /settings/.test(u), () => ({ body: { mode: "live" } })],
  ]);
  const r = await explainRun("tok", ENV_ID, FLOW, "08585", { fetchImpl });
  assert.equal(r.failed[0].name, "Send_mail");
  assert.deepEqual(r.upstream.map((u) => u.name), ["Load_settings"], "a missing timestamp must not empty the context out");
});

test("a failed run in a listing names the tool that explains it", async () => {
  // The hint is result-driven: it appears because a run failed, not because the
  // caller said anything about wanting a diagnosis.
  const { listFlowRuns } = await import("../dist/cloud/flowruns.js");
  const withFailure = mockFetch([[() => true, () => ({ value: [runBody(), { name: "08500", properties: { status: "Succeeded", startTime: "2026-09-06T10:00:00Z", endTime: "2026-09-06T10:00:05Z" } }] })]]);
  const runs = await listFlowRuns("tok", ENV_ID, FLOW, { fetchImpl: withFailure });
  assert.equal(runs.filter((r) => /fail/i.test(r.status ?? "")).length, 1, "the handler's cue for the hint is a failed status in the list");
  assert.equal(runs[0].name, "08585", "and the hint names that run id");
});
