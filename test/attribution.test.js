/**
 * Reading what an agent actually did off its activities, and asserting on it.
 *
 * A conversation test that only checks wording passes whether the agent called
 * its tool or invented an answer that reads correctly. These cover the
 * attribution extractor and the expectations built on it.
 *
 * The channelData shapes here are the ones the extractor claims to accept, not
 * ones captured from a tenant: docs/test-verification.md is the runbook that
 * settles which are real. Treat a change to these fixtures as a change to that
 * claim.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { attributionOf, invokedCitations, invokedTools, invokedTopics, missingNames, nameMatches, presentNames } from "../dist/attribution.js";
import { evaluateReplies } from "../dist/evals.js";

const say = (text, channelData) => ({ type: "message", from: { role: "bot" }, text, ...(channelData ? { channelData } : {}) });

test("topic and tool are read from every casing the extractor claims", () => {
  assert.equal(attributionOf(say("a", { topicName: "Greeting" })).topic, "Greeting");
  assert.equal(attributionOf(say("a", { TopicName: "Greeting" })).topic, "Greeting");
  assert.equal(attributionOf(say("a", { enclosingScope: { topicName: "Greeting" } })).topic, "Greeting");
  assert.equal(attributionOf(say("a", { actionName: "OrderLookup" })).tool, "OrderLookup");
  assert.equal(attributionOf(say("a", { ActionName: "OrderLookup" })).tool, "OrderLookup");
  assert.equal(attributionOf(say("a", { toolName: "OrderLookup" })).tool, "OrderLookup");
  assert.equal(attributionOf(say("a", { ChannelData: "wrong shape" })).topic, null);
});

test("an activity with no attribution reads as null, not as a guess", () => {
  const bare = attributionOf(say("just text"));
  assert.deepEqual(bare, { topic: null, tool: null, citations: [] });
  assert.deepEqual(attributionOf({}), { topic: null, tool: null, citations: [] });
});

test("citations come from schema.org entities and from channelData", () => {
  const viaEntity = { type: "message", entities: [{ type: "https://schema.org/Message", citation: [{ appearance: { name: "Returns policy" } }] }] };
  assert.deepEqual(attributionOf(viaEntity).citations, ["Returns policy"]);
  const viaChannel = say("a", { citations: [{ title: "Shipping FAQ" }, { url: "https://example/doc" }] });
  assert.deepEqual(attributionOf(viaChannel).citations, ["Shipping FAQ", "https://example/doc"]);
});

test("names are collected once each, in the order first seen", () => {
  const activities = [say("a", { topicName: "Order", actionName: "Lookup" }), say("b", { topicName: "Order", actionName: "Lookup" }), say("c", { topicName: "Refund" })];
  assert.deepEqual(invokedTopics(activities), ["Order", "Refund"]);
  assert.deepEqual(invokedTools(activities), ["Lookup"]);
  assert.deepEqual(invokedCitations(activities), []);
});

test("a qualified name still matches the tool a test names", () => {
  // A transcript may report "contoso_orderLookup.Run" where the test says
  // "orderLookup"; failing on qualification would teach nothing.
  assert.equal(nameMatches("contoso_orderLookup.Run", "orderLookup"), true);
  assert.equal(nameMatches("OrderLookup", "orderlookup"), true);
  assert.equal(nameMatches("OrderLookup", "Refund"), false);
  assert.deepEqual(missingNames(["OrderLookup"], ["OrderLookup", "Refund"]), ["Refund"]);
  assert.deepEqual(presentNames(["OrderLookup"], ["OrderLookup", "Refund"]), ["OrderLookup"]);
});

// --- the expectations -------------------------------------------------------

const withTool = [say("Order 12345 ships tomorrow", { topicName: "OrderStatus", actionName: "OrderLookup" })];

test("usedTool passes when the tool fired and fails when it did not", () => {
  assert.equal(evaluateReplies(["ok"], { usedTool: ["OrderLookup"] }, null, withTool).pass, true);
  const missed = evaluateReplies(["ok"], { usedTool: ["Refund"] }, null, withTool);
  assert.equal(missed.pass, false);
  assert.match(missed.failures[0], /tool "Refund" was not used \(used: OrderLookup\)/);
});

test("the answer that sounds right without calling the tool is caught", () => {
  // The whole point: wording passes, behaviour does not.
  const improvised = [say("Order 12345 ships tomorrow", { topicName: "Fallback" })];
  const wording = evaluateReplies(["Order 12345 ships tomorrow"], { contains: ["12345"] }, null, improvised);
  assert.equal(wording.pass, true, "wording alone cannot tell the difference");
  const behaviour = evaluateReplies(["Order 12345 ships tomorrow"], { contains: ["12345"], usedTool: ["OrderLookup"] }, null, improvised);
  assert.equal(behaviour.pass, false);
  assert.match(behaviour.failures.join(" "), /OrderLookup/);
});

test("notUsedTool and notUsedTopic catch the wrong route", () => {
  const fallback = [say("I did not understand", { topicName: "Fallback" })];
  const r = evaluateReplies(["I did not understand"], { notUsedTopic: ["Fallback"] }, null, fallback);
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /topic "Fallback" was reached and should not have been/);
  assert.equal(evaluateReplies(["ok"], { notUsedTool: ["Refund"] }, null, withTool).pass, true);
});

test("citedKnowledge asserts grounding in both directions", () => {
  const grounded = [say("Returns take 30 days", { citations: [{ title: "Returns policy" }] })];
  assert.equal(evaluateReplies(["ok"], { citedKnowledge: true }, null, grounded).pass, true);
  const ungrounded = evaluateReplies(["ok"], { citedKnowledge: true }, null, withTool);
  assert.equal(ungrounded.pass, false);
  assert.match(ungrounded.failures[0], /cited no knowledge source/);
  const shouldNot = evaluateReplies(["ok"], { citedKnowledge: false }, null, grounded);
  assert.equal(shouldNot.pass, false);
  assert.match(shouldNot.failures[0], /Returns policy/);
});

test("a transport that attributes nothing says so once, not per name", () => {
  // "cannot be judged" and "the agent misbehaved" are different problems with
  // different fixes, so they must not produce the same failure text.
  const blind = evaluateReplies(["ok"], { usedTool: ["A", "B"], usedTopic: ["C"] }, null, [say("ok")]);
  assert.equal(blind.pass, false);
  assert.equal(blind.failures.length, 1, `expected one explanation, got: ${blind.failures.join(" | ")}`);
  assert.match(blind.failures[0], /no tool, topic or citation attribution/);
  assert.match(blind.failures[0], /test-verification/);

  const noActivities = evaluateReplies(["ok"], { usedTool: ["A"] }, null, []);
  assert.match(noActivities.failures[0], /no activities were returned/);
});

test("wording-only expectations are unaffected by missing attribution", () => {
  // The existing three-argument callers must keep working unchanged.
  assert.equal(evaluateReplies(["I can help"], { containsAny: ["help"] }, null).pass, true);
  assert.equal(evaluateReplies(["nope"], { contains: ["yes"] }, null).pass, false);
});

test("every run reports what was observed, asserted on or not", () => {
  const r = evaluateReplies(["ok"], { contains: ["ok"] }, null, withTool);
  assert.equal(r.pass, true);
  assert.deepEqual(r.observed, { topic: "OrderStatus", tool: "OrderLookup", citations: [] });
});
