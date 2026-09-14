/**
 * The questions cs_create_agent asks before it creates anything, and the words
 * it asks them in. These are user-facing: a publisher prefix is permanent and a
 * project directory has to be empty, and neither is something a model should
 * invent. Change the wording and change this test with it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentNeeds, prefixExplanation, solutionGuidance, suggestedProjectDir } from "../dist/createAgentGuidance.js";

const CWD = "C:/work";

test("the suggested folder is named after the agent, next to where the session is", () => {
  assert.match(suggestedProjectDir(CWD, "Order Status Bot").replace(/\\/g, "/"), /^C:\/work\/order-status-bot$/);
  assert.match(suggestedProjectDir(CWD, undefined).replace(/\\/g, "/"), /agent$/);
});

test("a missing folder is asked for, with the suggestion as a choice and the reason it matters", () => {
  const [need] = createAgentNeeds({ name: "Order Bot" }, { cwd: CWD });
  assert.equal(need.argument, "projectDir");
  assert.match(need.question, /order-bot/);
  assert.match(need.why, /folder of YAML/);
  assert.match(need.why, /refuses a folder that already has files/, "the constraint that bites later is said up front");
  assert.equal(need.choices.length, 1);
});

test("a missing prefix is asked for with the publishers that exist", () => {
  const needs = createAgentNeeds(
    { name: "Order Bot", projectDir: "C:/work/order-bot", environment: "env-1" },
    { cwd: CWD, publishers: [{ prefix: "cr1f2", name: "CDS Default Publisher", isDefault: true }, { prefix: "contoso", name: "Contoso" }] },
  );
  assert.deepEqual(
    needs.map((n) => n.argument),
    ["publisherPrefix"],
  );
  assert.deepEqual(
    needs[0].choices.map((c) => c.value),
    ["cr1f2", "contoso"],
  );
  assert.match(needs[0].choices[0].detail, /default publisher/);
  assert.equal(needs[0].totalChoices, 2);
});

test("when the solution is known its publisher answers the prefix question", () => {
  const needs = createAgentNeeds(
    { name: "Order Bot", projectDir: "C:/work/order-bot", environment: "env-1", solutionName: "Core" },
    { cwd: CWD, solutions: [{ uniqueName: "Core", friendlyName: "Core", publisherPrefix: "contoso" }], publishers: [{ prefix: "other", name: "Other" }] },
  );
  assert.match(needs[0].question, /'contoso'/);
  assert.deepEqual(
    needs[0].choices.map((c) => c.value),
    ["contoso"],
    "the publisher of the target solution is the only workable answer, so it is the only one offered",
  );
  assert.match(needs[0].why, /must use that prefix/);
});

test("the prefix explanation says what it costs to get wrong", () => {
  assert.match(prefixExplanation(), /cannot be changed afterwards/);
  assert.match(prefixExplanation(), /2-8 lowercase letters or digits/);
  assert.match(prefixExplanation({ uniqueName: "Core", friendlyName: "Core" }), /must match the publisher of solution 'Core'/);
});

test("nothing is asked once both answers are in", () => {
  assert.deepEqual(createAgentNeeds({ name: "Order Bot", projectDir: "C:/work/order-bot", publisherPrefix: "contoso" }, { cwd: CWD }), []);
});

test("the solution sentence offers the alternatives instead of blocking on them", () => {
  const none = solutionGuidance({ name: "Order Bot" }, { cwd: CWD, solutions: [{ uniqueName: "Core", friendlyName: "Core" }] });
  assert.match(none, /pac creates one named after the agent/);
  assert.match(none, /unit you export and import/);
  assert.match(none, /Core/);

  const known = solutionGuidance({ name: "Order Bot", solutionName: "Core" }, { cwd: CWD, solutions: [{ uniqueName: "Core", friendlyName: "Core solution" }] });
  assert.match(known, /existing unmanaged solution 'Core'/);

  const missing = solutionGuidance({ name: "Order Bot", solutionName: "Nope" }, { cwd: CWD, solutions: [{ uniqueName: "Core", friendlyName: "Core" }] });
  assert.match(missing, /does not exist/);
  assert.match(missing, /createSolution: true/);

  const unread = solutionGuidance({ name: "Order Bot", solutionName: "Core" }, { cwd: CWD });
  assert.match(unread, /must exist and be unmanaged/, "with no list read, say the requirement rather than a wrong fact");
});
