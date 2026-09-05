import assert from "node:assert/strict";
import test from "node:test";

import { parseAuthList, parseCopilotList, parseVersion, explainFailure } from "../dist/pac.js";
import { buildTestSetCsv, evaluateReplies, parseConversationTests, suggestTestCases } from "../dist/evals.js";
import { summarizeRun } from "../dist/cloud/ppapi.js";
import { directLineTokenEndpoint, findSignInUrl, botReplies } from "../dist/cloud/chat.js";

test("parseVersion reads the pac banner", () => {
  assert.equal(parseVersion("Microsoft PowerPlatform CLI\nVersion: 2.11.2+g47bc199 (.NET 10.0.11)\n"), "2.11.2+g47bc199");
  assert.equal(parseVersion("nothing here"), null);
});

test("parseAuthList handles friendly names with spaces", () => {
  const out = parseAuthList(
    "Index Active Kind      Name Friendly Name                   Url                                 User                                     Cloud  Type\n" +
      "[1]   *      UNIVERSAL      Personal Productivity (Default) https://x.crm.dynamics.com/         user@contoso.onmicrosoft.com             Public User\n" +
      "[2]          UNIVERSAL      Dev https://y.crm4.dynamics.com/ dev@contoso.com Public User\n",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].index, 1);
  assert.equal(out[0].active, true);
  assert.equal(out[0].url, "https://x.crm.dynamics.com/");
  assert.equal(out[0].user, "user@contoso.onmicrosoft.com");
  assert.equal(out[0].cloud, "Public");
  assert.equal(out[1].active, false);
});

test("parseCopilotList anchors on the two GUID columns", () => {
  const stdout =
    "Connected as user@contoso.org\n" +
    "Name                           Bot ID                               Component State Is Managed Solution ID                          Status Code State Code\n" +
    "Ask Me Anything Copilot       584e012c-dc95-46d6-af5a-1263b6a44342 Published       Unmanaged  285af946-6383-49a0-8615-4e2afafeaf38 Active      Provisioned\n" +
    "New Test Copilot               9ee3f7aa-ab79-4cf6-a726-d85c8c18cc3e Published       Managed  285af946-6383-49a0-8615-4e2afafeaf38 Active      Provisioned\n";
  const rows = parseCopilotList(stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Ask Me Anything Copilot");
  assert.equal(rows[0].botId, "584e012c-dc95-46d6-af5a-1263b6a44342");
  assert.equal(rows[0].isManaged, false);
  assert.equal(rows[1].isManaged, true);
  assert.equal(rows[1].stateCode, "Provisioned");
});

test("parseCopilotList accepts JSON output", () => {
  const rows = parseCopilotList(JSON.stringify([{ Name: "A", BotId: "1", ComponentState: "Published", IsManaged: false }]));
  assert.equal(rows[0].name, "A");
  assert.equal(rows[0].botId, "1");
});

test("explainFailure adds hints for known pac errors", () => {
  const base = { ok: false, code: 1, stdout: "", stderr: "Error: workspace not found", command: "pac copilot push", durationMs: 1 };
  assert.match(explainFailure(base), /pac copilot clone/);
  assert.match(explainFailure({ ...base, stderr: "Unsupported directory" }), /outside/);
});

test("buildTestSetCsv writes the portal header and quotes cells", () => {
  const { csv, warnings } = buildTestSetCsv([
    { question: 'What is "X"?', expectedResponse: "A, B" },
    { question: "Line\nbreak" },
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "Question,Expected response");
  assert.equal(lines[1], '"What is ""X""?","A, B"');
  assert.equal(lines[2], '"Line break",""');
  assert.equal(warnings.length, 0);
});

test("buildTestSetCsv enforces the 100-case limit", () => {
  const cases = Array.from({ length: 120 }, (_, i) => ({ question: `q${i}` }));
  const { csv, warnings } = buildTestSetCsv(cases);
  assert.equal(csv.trim().split("\r\n").length, 101);
  assert.equal(warnings.length, 1);
});

test("suggestTestCases derives cases from topics and starters", () => {
  const ws = {
    topics: [{ name: "Order Status", description: "tracks orders", details: { triggerPhrases: ["where is my order", "track order", "order status"] } }],
    agent: { conversationStarters: [{ title: "Hi", text: "What can you do?" }] },
    knowledge: [{ name: "Docs", details: { site: "https://docs.example.com" } }],
  };
  const cases = suggestTestCases(ws, 50);
  assert.ok(cases.some((c) => c.question === "where is my order"));
  assert.ok(cases.some((c) => c.question === "What can you do?"));
  assert.ok(cases.some((c) => c.expectedResponse.includes("Docs")));
  assert.ok(cases.some((c) => c.question === "Hello"));
});

test("parseConversationTests and evaluateReplies", () => {
  const file = parseConversationTests("tests:\n  - name: a\n    utterance: hi\n    expect:\n      containsAny: [help, assist]\n");
  assert.equal(file.tests.length, 1);
  assert.equal(evaluateReplies(["I can help you"], file.tests[0].expect, null).pass, true);
  const r = evaluateReplies(["nope"], { contains: ["yes"], notContains: ["nope"], minLength: 10 }, "https://signin");
  assert.equal(r.pass, false);
  assert.equal(r.failures.length, 4);
  assert.throws(() => parseConversationTests("foo: bar"));
});

test("summarizeRun buckets metrics per case", () => {
  const run = {
    id: "r1",
    state: "Completed",
    totalTestCases: 3,
    testCasesProcessed: 3,
    testCasesResults: [
      { testCaseId: "1", state: "Completed", metricsResults: [{ type: "GeneralQuality", status: "Passed", errorReason: null, aiResultReason: "ok", result: {} }] },
      { testCaseId: "2", state: "Completed", metricsResults: [{ type: "GeneralQuality", status: "Failed", errorReason: null, aiResultReason: "bad", result: {} }] },
      { testCaseId: "3", state: "Completed", metricsResults: [{ type: "ExactMatch", status: "Error", errorReason: "timeout", aiResultReason: null, result: {} }] },
    ],
  };
  const s = summarizeRun(run);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.errored, 1);
  assert.equal(s.byMetric.GeneralQuality.passed, 1);
  assert.equal(s.cases[2].metrics[0].reason, "timeout");
});

test("directLineTokenEndpoint splits the environment id", () => {
  const url = directLineTokenEndpoint("2e250e7a-5607-4fea-aa4e-1aeb7bf79118", "cr123_agent");
  assert.equal(url, "https://2e250e7a56074feaaa4e1aeb7bf791.18.environment.api.powerplatform.com/powervirtualagents/botsbyschema/cr123_agent/directline/token?api-version=2022-03-01-preview");
});

test("findSignInUrl and botReplies", () => {
  const activities = [
    { type: "message", from: { role: "user" }, text: "hi" },
    { type: "message", from: { role: "bot" }, text: "Please sign in", attachments: [{ contentType: "application/vnd.microsoft.card.oauth", content: { buttons: [{ value: "https://login" }] } }] },
    { type: "message", from: { role: "bot" }, text: "Hello!" },
  ];
  assert.equal(findSignInUrl(activities), "https://login");
  assert.deepEqual(botReplies(activities), ["Please sign in", "Hello!"]);
});
