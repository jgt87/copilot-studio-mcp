/**
 * The Power Platform API `copilotstudio` client against a recorded fetch: the
 * request bodies and URLs the reference documents, and the byte download path
 * in http.ts that the snapshot and channel manifest tools use.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { fileNameFromDisposition, requestBytes } from "../dist/cloud/http.js";
import { downloadChannelManifest, downloadSnapshot, getConnectorConsentBypass, runIsFinished, runRequestBody, setConnectorConsentBypass, startRun } from "../dist/cloud/ppapi.js";

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const zip = (bytes, name) => new Response(bytes, { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"` } });

test("runRequestBody sends only what was given, and the documented shapes", () => {
  assert.deepEqual(runRequestBody(), { runOnPublishedBot: false });
  assert.deepEqual(runRequestBody({ runOnPublishedBot: true, evaluationRunName: "nightly", mcsConnectionId: "conn-1" }), { runOnPublishedBot: true, evaluationRunName: "nightly", mcsConnectionId: "conn-1" });
  const body = runRequestBody({
    toolsConnections: [{ connections: [{ connectorId: "shared_office365", connectionId: "c1" }] }, { botId: "child-bot", botSchemaName: "cr_Child", connections: [{ connectorId: "shared_sharepointonline", connectionId: "c2", connectionReferenceName: "cr_sp" }] }],
  });
  assert.deepEqual(body.toolsConnections, [
    { connections: [{ connectorId: "shared_office365", connectionId: "c1" }] },
    { botId: "child-bot", botSchemaName: "cr_Child", connections: [{ connectorId: "shared_sharepointonline", connectionId: "c2", connectionReferenceName: "cr_sp" }] },
  ]);
  assert.equal(runRequestBody({ toolsConnections: [] }).toolsConnections, undefined, "an empty list is the same as none");
});

test("startRun posts to the test set's run route at api-version 2024-10-01", async () => {
  const fetchImpl = recorder(() => json({ runId: "run-1", state: "Queued", executionState: "Initializing", totalTestCases: 3, testCasesProcessed: 0 }));
  const run = await startRun("tok", "env-1", "bot-1", "set-1", { mcsConnectionId: "conn-1" }, fetchImpl);
  assert.equal(run.id, "run-1");
  assert.equal(run.state, "Queued");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://api.powerplatform.com/copilotstudio/environments/env-1/bots/bot-1/api/makerevaluation/testsets/set-1/run?api-version=2024-10-01");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), { runOnPublishedBot: false, mcsConnectionId: "conn-1" });
  assert.equal(call.init.headers.Authorization, "Bearer tok");
});

test("runIsFinished recognises the documented terminal states in either field", () => {
  for (const s of ["Completed", "Failed", "Cancelled", "Abandoned", "Deleted"]) assert.ok(runIsFinished({ state: s, executionState: null }), s);
  assert.ok(runIsFinished({ state: "InProgress", executionState: "Completed" }));
  for (const s of ["Queued", "InProgress", "Unknown", null]) assert.ok(!runIsFinished({ state: s, executionState: "EvaluatingRun" }), String(s));
});

test("downloadSnapshot fetches the run's snapshot as bytes and keeps the server's file name", async () => {
  const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const fetchImpl = recorder(() => zip(payload, "snapshot-run-1.zip"));
  const file = await downloadSnapshot("tok", "env-1", "bot-1", "run-1", fetchImpl);
  assert.deepEqual([...file.bytes], [...payload]);
  assert.equal(file.fileName, "snapshot-run-1.zip");
  assert.equal(file.contentType, "application/zip");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://api.powerplatform.com/copilotstudio/environments/env-1/bots/bot-1/api/makerevaluation/testruns/run-1/snapshot?api-version=2024-10-01");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.Accept, "*/*", "a download does not ask for JSON");
});

test("connector consent bypass: GET reads the flag, PUT sends it and is not retried", async () => {
  const get = recorder(() => json({ adminConsentBypass: true }));
  const read = await getConnectorConsentBypass("tok", "env-1", "bot-1", get);
  assert.equal(read.adminConsentBypass, true);
  assert.equal(get.calls[0].url, "https://api.powerplatform.com/copilotstudio/environments/env-1/bots/bot-1/api/connectorConsentBypass?api-version=2024-10-01");
  assert.equal(get.calls[0].init.method, "GET");

  const put = recorder(() => json({ adminConsentBypass: false }));
  const set = await setConnectorConsentBypass("tok", "env-1", "bot-1", false, put);
  assert.equal(set.adminConsentBypass, false);
  assert.equal(put.calls[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(put.calls[0].init.body), { adminConsentBypass: false });

  const empty = recorder(() => new Response(null, { status: 204 }));
  assert.equal((await setConnectorConsentBypass("tok", "env-1", "bot-1", true, empty)).adminConsentBypass, true, "an empty 204 means the service accepted what was sent");

  const flaky = recorder(() => new Response("busy", { status: 503 }));
  await assert.rejects(() => setConnectorConsentBypass("tok", "env-1", "bot-1", true, flaky), /HTTP 503/);
  assert.equal(flaky.calls.length, 1, "a write is never retried");
});

test("downloadChannelManifest addresses the agents route and passes includeAgentSchema only when asked", async () => {
  const fetchImpl = recorder(() => zip(new Uint8Array([1]), "Contoso.zip"));
  await downloadChannelManifest("tok", "env-1", "bot-1", {}, fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://api.powerplatform.com/copilotstudio/environments/env-1/agents/bot-1/channels/M365/download?api-version=2024-10-01");
  await downloadChannelManifest("tok", "env-1", "bot-1", { includeAgentSchema: true }, fetchImpl);
  assert.equal(fetchImpl.calls[1].url, "https://api.powerplatform.com/copilotstudio/environments/env-1/agents/bot-1/channels/M365/download?includeAgentSchema=true&api-version=2024-10-01");
});

test("requestBytes retries a transient failure like a JSON GET, and refuses an oversized body", async () => {
  const sleeps = [];
  const fetchImpl = recorder((_url, _init, n) => (n === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "1" } }) : zip(new Uint8Array([7, 8]), "x.zip")));
  const file = await requestBytes("https://example.test/file", { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual([...file.bytes], [7, 8]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [1000], "Retry-After is honoured");

  const notFound = recorder(() => new Response("nope", { status: 404 }));
  await assert.rejects(() => requestBytes("https://example.test/missing", { fetchImpl: notFound, hints: { 404: "gone" } }), /HTTP 404 .* - gone/);
  assert.equal(notFound.calls.length, 1, "a 404 is the caller's problem, not retried");

  const big = recorder(() => zip(new Uint8Array(32), "big.zip"));
  await assert.rejects(() => requestBytes("https://example.test/big", { fetchImpl: big, maxBytes: 16 }), /over the 16-byte cap/);
});

test("fileNameFromDisposition prefers the encoded form and copes with bare and quoted names", () => {
  assert.equal(fileNameFromDisposition('attachment; filename="report.zip"'), "report.zip");
  assert.equal(fileNameFromDisposition("attachment; filename=report.zip"), "report.zip");
  assert.equal(fileNameFromDisposition("attachment; filename=\"a.zip\"; filename*=UTF-8''b%20c.zip"), "b c.zip");
  assert.equal(fileNameFromDisposition("inline"), null);
  assert.equal(fileNameFromDisposition(null), null);
});
