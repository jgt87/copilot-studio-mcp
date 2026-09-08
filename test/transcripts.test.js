/**
 * Conversation transcripts, against recorded Dataverse responses. The column
 * names and the content shape are taken from documentation, not a live run, so
 * these tests pin the parsing and the heuristics rather than prove the query.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { listTranscripts, parseContent, questionsFromTranscripts, summarizeTranscript, summarizeTranscripts } from "../dist/cloud/dataverse.js";

const ENV = "https://contoso.crm4.dynamics.com";
const BOT = "11111111-2222-3333-4444-555555555555";

const activity = (role, text, extra = {}) => ({ type: "message", from: { role }, text, timestamp: "2026-09-01T10:00:00Z", ...extra });
const withTopic = (name) => ({ channelData: { topicName: name } });

function row(id, activities, extra = {}) {
  return { conversationtranscriptid: id, createdon: "2026-09-01T10:00:00Z", conversationstarttime: "2026-09-01T09:59:00Z", content: JSON.stringify({ activities }), ...extra };
}

/** A fetch that replies to the first URL matching a pattern and records the calls. */
function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      for (const [pattern, reply] of routes) {
        if (String(url).includes(pattern)) return reply();
      }
      return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404, headers: { "content-type": "application/json" } });
    },
  };
}

const ok = (body) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (code) => () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: code, headers: { "content-type": "application/json" } });

test("parseContent accepts the object shape, the bare array and junk", () => {
  assert.equal(parseContent(JSON.stringify({ activities: [1, 2] })).length, 2);
  assert.equal(parseContent(JSON.stringify({ Activities: [1] })).length, 1);
  assert.equal(parseContent(JSON.stringify([1, 2, 3])).length, 3);
  assert.deepEqual(parseContent("not json"), []);
  assert.deepEqual(parseContent(null), []);
  assert.deepEqual(parseContent(JSON.stringify({ other: true })), []);
});

test("a transcript becomes turns with topics and tools attributed", () => {
  const t = summarizeTranscript(
    row("t1", [
      activity("user", "where is my order"),
      activity("bot", "Let me check.", withTopic("Order Status")),
      { type: "message", from: { role: "bot" }, text: "", channelData: { actionName: "LookupOrder" } },
      activity("bot", "It ships tomorrow.", withTopic("Order Status")),
    ]),
  );
  assert.equal(t.transcriptId, "t1");
  assert.equal(t.userTurns, 1);
  assert.equal(t.agentTurns, 3);
  assert.equal(t.firstUserMessage, "where is my order");
  assert.deepEqual(t.topics, ["Order Status"]);
  assert.deepEqual(t.tools, ["LookupOrder"]);
  assert.equal(t.outcome, "resolved");
});

test("outcomes: escalation beats everything, then unanswered, then a dangling user turn", () => {
  const escalated = summarizeTranscript(row("e", [activity("user", "this is broken"), activity("bot", "Transferring you to a human agent.")]));
  assert.equal(escalated.outcome, "escalated");

  const unresolved = summarizeTranscript(row("u", [activity("user", "what is the refund window"), activity("bot", "Sorry, I couldn't find an answer to that.")]));
  assert.equal(unresolved.outcome, "unresolved");

  const abandoned = summarizeTranscript(row("a", [activity("user", "hello"), activity("bot", "Hi!"), activity("user", "and my invoice?")]));
  assert.equal(abandoned.outcome, "abandoned");

  const empty = summarizeTranscript(row("n", [activity("bot", "Hello, how can I help?")]));
  assert.equal(empty.outcome, "abandoned");
  assert.match(empty.outcomeReason, /no user message/);
});

test("the resolved reason does not claim the user was satisfied", () => {
  const t = summarizeTranscript(row("r", [activity("user", "hi"), activity("bot", "Hello.")]));
  assert.equal(t.outcome, "resolved");
  assert.match(t.outcomeReason, /not a statement that the user was satisfied/);
});

test("listTranscripts falls back to the next lookup shape on 400 or 404", async () => {
  const { calls, fetchImpl } = fakeFetch([
    ["_bot_conversationtranscriptid_value", status(400)],
    ["_regardingobjectid_value", status(404)],
    ["bot_conversationtranscript", ok({ value: [row("t1", [activity("user", "hi")])] })],
  ]);
  const rows = await listTranscripts(ENV, "tok", BOT, { fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 3, "should have tried all three shapes in order");
});

test("listTranscripts does not swallow a real failure", async () => {
  const { fetchImpl } = fakeFetch([["conversationtranscript", status(500)]]);
  await assert.rejects(() => listTranscripts(ENV, "tok", BOT, { fetchImpl }), /500/);
});

test("listTranscripts clamps top and passes the since window", async () => {
  const { calls, fetchImpl } = fakeFetch([["conversationtranscripts", ok({ value: [] })]]);
  await listTranscripts(ENV, "tok", BOT, { fetchImpl, top: 9000, since: "2026-08-01T00:00:00Z" });
  assert.match(calls[0], /\$top=500/);
  assert.match(decodeURIComponent(calls[0]), /createdon ge 2026-08-01T00:00:00Z/);

  const small = fakeFetch([["conversationtranscripts", ok({ value: [] })]]);
  await listTranscripts(ENV, "tok", BOT, { fetchImpl: small.fetchImpl, top: 0 });
  assert.match(small.calls[0], /\$top=1/);
});

test("summarizeTranscripts counts outcomes, ranks topics and surfaces the failing questions", () => {
  const transcripts = [
    row("1", [activity("user", "where is my order"), activity("bot", "Shipped.", withTopic("Order Status"))]),
    row("2", [activity("user", "Where is my order"), activity("bot", "Sorry, I couldn't find an answer.")]),
    row("3", [activity("user", "where is my order"), activity("bot", "Sorry, I couldn't find an answer.")]),
    row("4", [activity("user", "cancel my plan"), activity("bot", "Transferring you to a human agent.")]),
    row("5", [activity("user", "hi"), activity("bot", "Hello.", withTopic("Greeting"))]),
  ].map(summarizeTranscript);

  const stats = summarizeTranscripts(transcripts);
  assert.equal(stats.sessions, 5);
  assert.equal(stats.outcomes.resolved, 2);
  assert.equal(stats.outcomes.unresolved, 2);
  assert.equal(stats.outcomes.escalated, 1);
  assert.equal(stats.escalationRate, 0.2);
  assert.equal(stats.sessionsWithoutTopic, 3);
  assert.deepEqual(
    stats.topTopics.map((t) => t.name),
    ["Greeting", "Order Status"],
  );
  // Two of the three askings failed; the resolved one is not counted here.
  assert.equal(stats.unansweredQuestions[0].sessions, 2);
  assert.match(stats.unansweredQuestions[0].question, /where is my order/i);
});

test("questionsFromTranscripts prefers the failing sessions and dedupes case-insensitively", () => {
  const transcripts = [
    row("1", [activity("user", "Reset my password"), activity("bot", "Sorry, I couldn't find an answer.")]),
    row("2", [activity("user", "reset my password"), activity("bot", "Sorry, I couldn't find an answer.")]),
    row("3", [activity("user", "open a ticket"), activity("bot", "Done.", withTopic("Tickets"))]),
  ].map(summarizeTranscript);

  const failed = questionsFromTranscripts(transcripts, { onlyFailed: true });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].sessions, 2);

  const all = questionsFromTranscripts(transcripts, { onlyFailed: false });
  assert.equal(all.length, 2);
  assert.equal(all[0].sessions, 2, "most frequent first");

  assert.equal(questionsFromTranscripts(transcripts, { onlyFailed: false, max: 1 }).length, 1);
});

test("empty input produces zeroes, not NaN", () => {
  const stats = summarizeTranscripts([]);
  assert.equal(stats.sessions, 0);
  assert.equal(stats.escalationRate, 0);
  assert.equal(stats.averageUserTurns, 0);
  assert.deepEqual(stats.window, { from: null, to: null });
  assert.deepEqual(questionsFromTranscripts([]), []);
});
