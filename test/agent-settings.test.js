import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { updateAgent } from "../dist/authoring/agent.js";
import { validateWorkspace } from "../dist/validate.js";
import { readWorkspace } from "../dist/workspace.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function scaffold(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-agent-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, "agent");
  cpSync(join(FIXTURES, "pac-default"), root, { recursive: true });
  return root;
}

const agentDoc = (root) => yaml.load(readFileSync(join(root, "agent.mcs.yml"), "utf8"));

test("response instructions, mode, history and moderation land in agent.mcs.yml and validate", (t) => {
  const root = scaffold(t);
  const r = updateAgent(root, {
    responseInstructions: "Answer in at most five sentences. Use a bulleted list for steps. Always cite the knowledge source.",
    defaultResponseMode: "ThinkDeeper",
    history: "conversation",
    historyMessages: 8,
    contentModeration: "High",
    useModelKnowledge: false,
    isSemanticSearchEnabled: true,
  });
  assert.ok(r.changed.includes("responseInstructions"));
  assert.ok(r.changed.includes("defaultResponseMode"));
  assert.ok(r.changed.includes("historyType"));
  assert.ok(r.changed.includes("aISettings.contentModeration"));

  const doc = agentDoc(root);
  assert.match(doc.responseInstructions, /five sentences/);
  assert.equal(doc.defaultResponseMode, "ThinkDeeper");
  assert.deepEqual(doc.historyType, { kind: "ConversationHistory", numberOfPastUserMessagesToInclude: 8 });
  assert.equal(doc.aISettings.contentModeration, "High");
  assert.equal(doc.aISettings.useModelKnowledge, false);
  assert.equal(doc.aISettings.isSemanticSearchEnabled, true);
  assert.equal(doc.aISettings.model.modelNameHint, "GPT5Chat", "the model hint that was already there survives");
  assert.equal(validateWorkspace(root, "agent.mcs.yml").errors, 0, "the result validates against the authoring schema");
});

test("capability toggles merge instead of replacing, and history can be turned off", (t) => {
  const root = scaffold(t);
  assert.equal(agentDoc(root).gptCapabilities.webBrowsing, true, "the scaffold has web browsing on");
  updateAgent(root, { capabilities: { codeInterpreter: true, searchOneDriveAndSharePoint: true } });
  let doc = agentDoc(root);
  assert.equal(doc.gptCapabilities.webBrowsing, true, "an untouched toggle keeps its value");
  assert.equal(doc.gptCapabilities.codeInterpreter, true);
  assert.equal(doc.gptCapabilities.searchOneDriveAndSharePoint, true);

  const r = updateAgent(root, { capabilities: { webBrowsing: false }, history: "none" });
  doc = agentDoc(root);
  assert.equal(doc.gptCapabilities.webBrowsing, false);
  assert.equal(doc.gptCapabilities.codeInterpreter, true);
  assert.deepEqual(doc.historyType, { kind: "NoHistory" });
  assert.ok(r.changed.includes("gptCapabilities.webBrowsing"));
  assert.equal(validateWorkspace(root, "agent.mcs.yml").errors, 0);
});

test("appending response instructions keeps what is there, and the header survives", (t) => {
  const root = scaffold(t);
  const file = join(root, "agent.mcs.yml");
  writeFileSync(file, "# Agent definition\n" + readFileSync(file, "utf8"));
  updateAgent(root, { responseInstructions: "Be brief." });
  updateAgent(root, { appendResponseInstructions: "Never invent a policy number." });
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("# Agent definition"), "the comment header is preserved");
  const doc = yaml.load(text);
  assert.match(doc.responseInstructions, /Be brief\./);
  assert.match(doc.responseInstructions, /Never invent a policy number\./);

  const fresh = scaffold(t);
  updateAgent(fresh, { appendResponseInstructions: "First line." });
  assert.equal(agentDoc(fresh).responseInstructions.trim(), "First line.", "appending to nothing does not leave blank lines");
});

test("values outside the schema enumerations are refused", (t) => {
  const root = scaffold(t);
  assert.throws(() => updateAgent(root, { defaultResponseMode: "Fast" }), /must be one of Auto, ThinkDeeper, QuickResponse/);
  assert.throws(() => updateAgent(root, { contentModeration: "Off" }), /must be one of Minimum, Low, Medium, High, Maximum/);
  assert.throws(() => updateAgent(root, {}), /Nothing to change/);
  updateAgent(root, { history: "none" });
  assert.throws(() => updateAgent(root, { historyMessages: 5 }), /needs conversation history/);
  assert.deepEqual(agentDoc(root).historyType, { kind: "NoHistory" }, "a refused change leaves the file alone");
});

test("the workspace inventory still reads an agent with the new fields", (t) => {
  const root = scaffold(t);
  updateAgent(root, { responseInstructions: "Cite sources.", defaultResponseMode: "QuickResponse", capabilities: { generateImages: true } });
  const ws = readWorkspace(root);
  // The scaffold keeps the display name in settings.mcs.yml; agent.mcs.yml carries the definition.
  assert.equal(ws.settings.displayName, "Oracle Default Agent");
  assert.equal(ws.agent.model, "GPT5Chat");
  assert.equal(validateWorkspace(root).errors, 0);
});
