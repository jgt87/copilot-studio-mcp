import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GUIDE_TOPICS, SERVER_INSTRUCTIONS, TOPIC_SUMMARY, guide, nextSteps } from "../dist/guide.js";
import { readWorkspace } from "../dist/workspace.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Tool names the server actually registers: bespoke handlers plus the declarative pac wrappers. */
function registeredTools() {
  const dist = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const names = new Set();
  for (const m of dist("../dist/index.js").matchAll(/registerTool\(\s*"(cs_[a-z_]+)"/g)) names.add(m[1]);
  for (const m of dist("../dist/pacCommands.js").matchAll(/tool:\s*"(cs_[a-z_]+)"/g)) names.add(m[1]);
  return names;
}

test("every guide topic has content, a summary and a heading", () => {
  assert.equal(GUIDE_TOPICS.length, 11);
  for (const topic of GUIDE_TOPICS) {
    const text = guide(topic);
    assert.ok(text.length > 500, `${topic} is too short`);
    assert.match(text, /^# /, `${topic} needs a heading`);
    assert.ok(TOPIC_SUMMARY[topic]?.length > 10, `${topic} needs a summary`);
  }
});

test("guides, instructions and next steps only name tools the server registers", () => {
  const tools = registeredTools();
  assert.ok(tools.has("cs_guide") && tools.has("cs_push") && tools.size > 50, `found ${tools.size} tools`);
  const ws = readWorkspace(`${FIXTURES}pac-default`);
  const sources = [["SERVER_INSTRUCTIONS", SERVER_INSTRUCTIONS], ...GUIDE_TOPICS.map((t) => [t, guide(t)]), ["nextSteps", nextSteps(ws).join("\n")], ["nextSteps(empty)", nextSteps(null, { pacFound: false, pacProfile: false, signedIn: false }).join("\n")]];
  for (const [where, text] of sources) {
    for (const [, name] of text.matchAll(/\b(cs_[a-z_]+)\b/g)) {
      assert.ok(tools.has(name), `${where} names '${name}', which no tool registers`);
    }
  }
});

test("the handshake instructions carry the rules a client must know", () => {
  for (const needle of ["cs_init", "cs_guide", "confirm: true", "cs_push", "pac auth create"]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(needle), `handshake instructions must mention ${needle}`);
  }
  assert.ok(SERVER_INSTRUCTIONS.length < 3000, "keep the handshake text short; details belong in cs_guide");
});

test("nextSteps reflects the state of the workspace", (t) => {
  const none = nextSteps(null, { pacFound: false, pacProfile: false, signedIn: false });
  assert.match(none.join(" "), /Install the Power Platform CLI/);
  assert.match(none.join(" "), /pac auth create/);
  assert.match(none.join(" "), /cs_login/);
  assert.match(none.join(" "), /cs_clone_agent/);

  const ws = readWorkspace(`${FIXTURES}pac-default`);
  const steps = nextSteps(ws).join(" ");
  assert.match(steps, /no instructions/i, "the scaffold has empty instructions");
  assert.match(steps, /No knowledge sources/);
  assert.match(steps, /No tools/);
  assert.ok(!steps.includes("No custom topics"), "the scaffold already has a phrase-triggered topic (Greeting)");
  assert.match(steps, /no sync metadata/i, "the fixture is a local scaffold");
  assert.ok(!steps.includes("cs_check_drift"), "drift only matters for a sync-connected workspace");

  const noTopics = nextSteps({ ...ws, topics: ws.topics.filter((x) => x.details.triggerKind !== "OnRecognizedIntent") }).join(" ");
  assert.match(noTopics, /No custom topics/);

  const connected = { ...ws, sync: { ...ws.sync, source: "pac" }, connectionReferences: [{ logicalName: "x_sp" }] };
  const s2 = nextSteps(connected).join(" ");
  assert.match(s2, /1 connection reference\(s\) are not bound/);
  assert.match(s2, /cs_check_drift/);
  assert.ok(!s2.includes("no sync metadata"));

  const complete = { ...connected, connectionReferences: [{ logicalName: "x_sp", connectionId: "c1" }], agent: { ...ws.agent, instructions: "x".repeat(250) }, knowledge: [{ name: "Docs" }], actions: [{ name: "Tool" }], topics: [{ name: "T", details: { triggerKind: "OnRecognizedIntent" } }] };
  const s3 = nextSteps(complete);
  assert.deepEqual(s3.length, 1, s3.join(" | "));
  assert.match(s3[0], /cs_review_agent/);
});
