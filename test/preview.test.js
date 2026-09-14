/**
 * Every change to an agent is shown before it is made. Two mechanisms back
 * that: the prose preview for the instructions (src/instructions.ts), and
 * capture mode for everything the authoring tools write (src/authoring/
 * capture.ts + src/changePreview.ts). Both are pinned here, including the one
 * property that matters most - a preview writes nothing.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FIELD_LIMITS, INSTRUCTIONS_LIMIT, RESPONSE_INSTRUCTIONS_LIMIT, buildAgentPreview, changeMode, limitForField, limitRefusal, previewField, singleFieldPreview, textStats, valueAt } from "../dist/instructions.js";
import { buildChangePreview, fileChange } from "../dist/changePreview.js";
import { captureWrite, capturing, withCapture } from "../dist/authoring/capture.js";
import { planAgentUpdate, commitAgentUpdate, readCliCopilotInstructions } from "../dist/authoring/agent.js";
import { addTopic } from "../dist/authoring/topics.js";
import { readWorkspace } from "../dist/workspace.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function fixtureCopy(t, name) {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const target = join(dir, name);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

// ---------------------------------------------------------------------------
// Counting and the modes
// ---------------------------------------------------------------------------

test("text is counted in characters and lines", () => {
  assert.deepEqual(textStats(""), { characters: 0, lines: 0 });
  assert.deepEqual(textStats("one"), { characters: 3, lines: 1 });
  assert.deepEqual(textStats("one\ntwo"), { characters: 7, lines: 2 });
});

test("the mode says whether there was anything there before", () => {
  assert.equal(changeMode("", "new text"), "add");
  assert.equal(changeMode("   \n", "new text"), "add");
  assert.equal(changeMode("old", "old\n\nmore\n"), "append");
  assert.equal(changeMode("old", "different"), "replace");
  assert.equal(changeMode("old", "old"), "replace");
});

test("adding instructions has no current side and carries the whole proposed text", () => {
  const p = previewField("instructions", "", "You are a support agent.", INSTRUCTIONS_LIMIT);
  assert.equal(p.mode, "add");
  assert.equal(p.current, null);
  assert.equal(p.proposedText, "You are a support agent.");
  assert.equal(p.proposed.characters, 24);
  assert.equal(p.withinLimit, true);
  assert.equal(p.remaining, INSTRUCTIONS_LIMIT - 24);
});

test("changing instructions diffs the lines that change, in context", () => {
  const before = ["Line one.", "Line two.", "Line three.", "Line four.", "Line five."].join("\n");
  const after = before.replace("Line three.", "Line three, rewritten.");
  const p = previewField("instructions", before, after, INSTRUCTIONS_LIMIT);
  assert.equal(p.mode, "replace");
  assert.deepEqual(p.current, { characters: before.length, lines: 5 });
  assert.match(p.diff, /-Line three\./);
  assert.match(p.diff, /\+Line three, rewritten\./);
  assert.match(p.diff, /Line two\./, "the surrounding lines are shown as context");
  assert.equal(p.identical, false);
});

test("the 8000-character limit is counted and reported, not discovered at push time", () => {
  const long = "x".repeat(INSTRUCTIONS_LIMIT + 25);
  const p = previewField("instructions", "short", long, INSTRUCTIONS_LIMIT);
  assert.equal(p.withinLimit, false);
  assert.equal(p.overBy, 25);
  assert.equal(p.remaining, 0);
  assert.match(limitRefusal("instructions", long.length), /8025 characters; Copilot Studio allows 8000/);
  assert.match(limitRefusal("instructions", long.length), /Shorten it by 25/);
});

test("a field with no cap at all reports the count and no limit", () => {
  const p = previewField("displayName", "", "Contoso Support", null);
  assert.equal(p.limit, null);
  assert.equal(p.withinLimit, true);
  assert.equal(p.proposed.characters, 15);
});

test("response formatting is capped at 500, not at the instructions' 8000", () => {
  assert.equal(FIELD_LIMITS.responseInstructions, RESPONSE_INSTRUCTIONS_LIMIT);
  assert.equal(RESPONSE_INSTRUCTIONS_LIMIT, 500);
  assert.equal(limitForField("responseInstructions"), 500);
  assert.equal(limitForField("configuration.agentSettings.responseInstructions"), 500, "the dot paths cs_update_settings takes resolve to the same cap");
  assert.equal(limitForField("instructions"), 8000);
  assert.equal(limitForField("displayName"), null);

  const ok = buildAgentPreview({ file: "agent.mcs.yml", before: { responseInstructions: "Be brief." }, after: { responseInstructions: "x".repeat(500) }, changed: ["responseInstructions"] });
  assert.equal(ok.responseInstructions.withinLimit, true);
  assert.equal(ok.responseInstructions.remaining, 0);
  assert.equal(ok.blocked, undefined, "exactly 500 fits");

  const over = buildAgentPreview({ file: "agent.mcs.yml", before: { responseInstructions: "Be brief." }, after: { responseInstructions: "x".repeat(501) }, changed: ["responseInstructions"] });
  assert.equal(over.responseInstructions.overBy, 1);
  assert.match(over.blocked, /501 characters; Copilot Studio allows 500/);
});

test("valueAt reads a dotted path and tolerates a missing one", () => {
  const doc = { aISettings: { model: { modelNameHint: "GPT5Chat" } } };
  assert.equal(valueAt(doc, "aISettings.model.modelNameHint"), "GPT5Chat");
  assert.equal(valueAt(doc, "aISettings.missing.deeper"), undefined);
  assert.equal(valueAt(null, "anything"), undefined);
});

// ---------------------------------------------------------------------------
// The whole-agent preview
// ---------------------------------------------------------------------------

test("the agent preview separates the prose from the other settings", () => {
  const before = { instructions: "Old.", defaultResponseMode: "Auto", gptCapabilities: { webBrowsing: false } };
  const after = { instructions: "New.", defaultResponseMode: "ThinkDeeper", gptCapabilities: { webBrowsing: true } };
  const p = buildAgentPreview({ file: "agent.mcs.yml", before, after, changed: ["instructions", "defaultResponseMode", "gptCapabilities.webBrowsing"] });
  assert.equal(p.preview, true);
  assert.equal(p.needsConfirmation, true);
  assert.equal(p.instructions.mode, "replace");
  assert.deepEqual(
    p.otherChanges,
    [
      { field: "defaultResponseMode", current: "Auto", proposed: "ThinkDeeper" },
      { field: "gptCapabilities.webBrowsing", current: false, proposed: true },
    ],
    "a non-prose change is shown as current -> proposed",
  );
  assert.match(p.hint, /confirm: true/);
  assert.equal(p.blocked, undefined);
});

test("an over-long instruction edit is blocked in the preview, before anything is written", () => {
  const p = buildAgentPreview({ file: "agent.mcs.yml", before: { instructions: "Old." }, after: { instructions: "y".repeat(9000) }, changed: ["instructions"] });
  assert.match(p.blocked, /9000 characters; Copilot Studio allows 8000/);
  assert.match(p.hint, /Nothing was written/);
});

test("the appended variants are previewed against the same field", () => {
  const p = buildAgentPreview({ file: "agent.mcs.yml", before: { instructions: "Old." }, after: { instructions: "Old.\n\nMore.\n" }, changed: ["instructions (appended)"] });
  assert.equal(p.instructions.mode, "append");
  assert.equal(p.otherChanges.length, 0);
});

test("the cli-copilot harness previews the instructions out of settings.mcs.yml", () => {
  const settings = { configuration: { agentSettings: { instructions: { segments: [{ kind: "StaticSegment", value: "Current text." }] } } } };
  assert.equal(readCliCopilotInstructions(settings), "Current text.");
  const p = singleFieldPreview({ file: "settings.mcs.yml", field: "instructions", before: readCliCopilotInstructions(settings), after: "Replacement text." });
  assert.equal(p.instructions.mode, "replace");
  assert.match(p.instructions.diff, /-Current text\./);
});

test("planning an agent update does not write it; committing does", (t) => {
  const root = fixtureCopy(t, "pac-default");
  const plan = planAgentUpdate(root, { instructions: "Brand new instructions." });
  const onDisk = () => readFileSync(plan.file, "utf8");
  assert.ok(!onDisk().includes("Brand new instructions."), "plan alone leaves the file as it was");
  const preview = buildAgentPreview(plan);
  assert.equal(preview.instructions.proposed.characters, 23);
  commitAgentUpdate(plan);
  assert.ok(onDisk().includes("Brand new instructions."));
});

// ---------------------------------------------------------------------------
// Capture mode
// ---------------------------------------------------------------------------

test("capture is off outside withCapture, so an ordinary call still writes", (t) => {
  const root = fixtureCopy(t, "pac-default");
  assert.equal(capturing(), false);
  const ws = readWorkspace(root);
  const { file } = addTopic(root, { name: "Ordinary", trigger: { kind: "phrases", phrases: ["hello"] }, actions: [], agentSchemaName: ws.schemaName ?? undefined });
  assert.ok(existsSync(file));
});

test("a captured authoring call records the file it would write and writes nothing", async (t) => {
  const root = fixtureCopy(t, "pac-default");
  const ws = readWorkspace(root);
  const { result, writes } = await withCapture(() => addTopic(root, { name: "Order Status", trigger: { kind: "phrases", phrases: ["where is my order"] }, actions: [], agentSchemaName: ws.schemaName ?? undefined }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, result.file);
  assert.equal(writes[0].before, null, "the topic does not exist yet");
  assert.match(writes[0].after, /where is my order/);
  assert.ok(!existsSync(result.file), "the preview left the disk alone");
});

test("running the same call again with capture off writes what the preview showed", async (t) => {
  const root = fixtureCopy(t, "pac-default");
  const ws = readWorkspace(root);
  const spec = { name: "Order Status", trigger: { kind: "phrases", phrases: ["where is my order"] }, actions: [], agentSchemaName: ws.schemaName ?? undefined };
  const { writes } = await withCapture(() => addTopic(root, spec));
  const { file } = addTopic(root, spec);
  assert.ok(existsSync(file));
  const written = readFileSync(file, "utf8");
  // Node ids are random per call, so compare the shape rather than the bytes.
  assert.equal(written.split(/\r?\n/).length, writes[0].after.split(/\r?\n/).length);
  assert.match(written, /where is my order/);
});

test("a file written twice in one call keeps the content it started with", async () => {
  const { writes } = await withCapture(() => {
    captureWrite("C:/nowhere/thing.yml", "first");
    captureWrite("C:/nowhere/thing.yml", "second");
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].before, null);
  assert.equal(writes[0].after, "second");
});

test("captures do not leak between concurrent calls", async () => {
  const [a, b] = await Promise.all([
    withCapture(async () => {
      await new Promise((r) => setTimeout(r, 5));
      captureWrite("C:/nowhere/a.yml", "a");
    }),
    withCapture(async () => {
      captureWrite("C:/nowhere/b.yml", "b");
    }),
  ]);
  assert.deepEqual(
    a.writes.map((w) => w.after),
    ["a"],
  );
  assert.deepEqual(
    b.writes.map((w) => w.after),
    ["b"],
  );
});

// ---------------------------------------------------------------------------
// The change preview built from captured writes
// ---------------------------------------------------------------------------

test("a new file is shown in full, an edited one as a diff", () => {
  const created = fileChange({ file: "/ws/topics/New.mcs.yml", before: null, after: "kind: AdaptiveDialog\nbeginDialog: x\n" });
  assert.equal(created.action, "create");
  assert.equal(created.content, "kind: AdaptiveDialog\nbeginDialog: x\n");
  assert.equal(created.diff, undefined);
  assert.deepEqual(created.lines, { before: 0, after: 3 });

  const edited = fileChange({ file: "/ws/agent.mcs.yml", before: "a\nb\nc\n", after: "a\nB\nc\n" });
  assert.equal(edited.action, "modify");
  assert.match(edited.diff, /-b/);
  assert.match(edited.diff, /\+B/);
});

test("a write that changes nothing says so instead of asking for confirmation", () => {
  const p = buildChangePreview("cs_edit_topic", [{ file: "/ws/topics/Same.mcs.yml", before: "same\n", after: "same\n" }]);
  assert.equal(p.files[0].action, "unchanged");
  assert.match(p.hint, /Nothing would change/);
});

test("the preview names the tool to call again and the files it would touch", () => {
  const p = buildChangePreview("cs_add_topic", [{ file: "/ws/topics/New.mcs.yml", before: null, after: "x\n" }], "/ws");
  assert.equal(p.files[0].file.split(sep).join("/"), "topics/New.mcs.yml", "paths are shown relative to the workspace");
  assert.match(p.hint, /cs_add_topic again with the same arguments plus confirm: true/);
});

test("a long file is clipped so the preview stays readable", () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const c = fileChange({ file: "/ws/big.yml", before: null, after: long });
  assert.equal(c.truncated, true);
  assert.match(c.content, /more line\(s\)/);
  assert.ok(c.content.split("\n").length < 250);
  assert.equal(c.lines.after, 500, "the count stays honest even when the text is cut");
});

test("a copied knowledge file is reported as a copy, not diffed", () => {
  const c = fileChange({ file: "/ws/knowledge/files/manual.pdf", before: null, after: null, copiedFrom: "C:/docs/manual.pdf" });
  assert.equal(c.action, "copy");
  assert.equal(c.copiedFrom, "C:/docs/manual.pdf");
  assert.equal(c.diff, undefined);
});
