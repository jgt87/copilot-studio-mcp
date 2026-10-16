// The YAML checks added from Microsoft Learn, Microsoft's authoring skills and
// the VS Code extension's issue tracker. Each test names the failure it guards
// against; the sources are cited where the check is implemented.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { validateDocument, findCommentTruncation } from "../dist/schemaValidate.js";
import { validateWorkspace } from "../dist/validate.js";
import { reviewWorkspace } from "../dist/review.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const TEMPLATES = fileURLToPath(new URL("../reference/templates/", import.meta.url));

function fixtureCopy(t, name = "basic-agent") {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const target = join(dir, name);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

const check = (text) => validateDocument(yaml.load(text), text).map((d) => `${d.severity}: ${d.message}`);
const topic = (actions, extra = "") => `kind: AdaptiveDialog\n${extra}beginDialog:\n  kind: OnRecognizedIntent\n  id: main\n  intent:\n    triggerQueries:\n      - where is my order\n  actions:\n${actions}`;
const fileMessages = (v, file) => (v.files.find((f) => f.file === file)?.diagnostics ?? []).map((d) => `${d.severity}: ${d.message}`);

test("Microsoft's own templates raise nothing beyond their placeholders", () => {
  for (const dir of readdirSync(TEMPLATES)) {
    for (const f of readdirSync(join(TEMPLATES, dir))) {
      // The templates end with '// Instructions' notes that are not YAML.
      const raw = readFileSync(join(TEMPLATES, dir, f), "utf8").split(/\r?\n\/\/ /)[0];
      const left = validateDocument(yaml.load(raw), raw).filter((d) => d.severity !== "info" && !/_REPLACE|Angle-bracket/.test(d.message));
      assert.deepEqual(left, [], `${dir}/${f}`);
    }
  }
});

test("an unquoted ' #' is flagged, quoted and block text is not", () => {
  const raw = [
    "# Name: header comments are fine",
    "kind: AdaptiveDialog",
    "description: Handles ticket #324 escalations",
    "other: 'quoted # is literal'",
    "url: https://example.com/page#anchor",
    "card: |",
    "  { \"text\": \"a # inside a block\" }",
    "list:",
    "  - item #2",
  ].join("\n");
  assert.deepEqual(findCommentTruncation(raw), [3, 9]);
});

test("nodes after a terminal node, the SendMessage hint and formula-looking literals", () => {
  const msgs = check(topic([
    "    - kind: SendMessage",
    "      id: m0",
    "      message: hi",
    "    - kind: SetVariable",
    "      id: s1",
    "      variable: Topic.Copy",
    "      value: Topic.Original",
    "    - kind: EndDialog",
    "      id: e1",
    "    - kind: SendActivity",
    "      id: m1",
    "      activity: never sent",
    "",
  ].join("\n")));
  assert.ok(msgs.some((m) => /^error: 'SendMessage'.*SendActivity/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /^warning: 1 node\(s\) after EndDialog never run/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /^warning: value 'Topic.Original' reads like a Power Fx formula/.test(m)), msgs.join("\n"));
  const fine = check(topic("    - kind: SetVariable\n      id: s1\n      variable: Topic.Greeting\n      value: Hello {Topic.Name}\n    - kind: EndDialog\n      id: e1\n      disabled: false\n"));
  assert.ok(!fine.some((m) => /reads like|never run/.test(m)), fine.join("\n"));
});

test("trigger phrases: the 200 cap and repeats within a topic", () => {
  const many = Array.from({ length: 201 }, (_, i) => `      - phrase number ${i}`).join("\n");
  const text = `kind: AdaptiveDialog\nbeginDialog:\n  kind: OnRecognizedIntent\n  id: main\n  intent:\n    triggerQueries:\n${many}\n      - Phrase Number 0\n  actions: []\n`;
  const msgs = check(text);
  assert.ok(msgs.some((m) => /^error: 202 trigger phrases; a topic takes at most 200/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /^warning: trigger phrase 'Phrase Number 0' is listed twice/.test(m)));
});

test("topic inputs and outputs need descriptions", () => {
  const extra = "inputs:\n  - kind: AutomaticTaskInput\n    propertyName: OrderId\noutputType:\n  properties:\n    answered:\n      type: Boolean\n";
  const msgs = check(topic("    - kind: EndDialog\n      id: e1\n", extra));
  assert.ok(msgs.some((m) => /topic input 'OrderId' has no description/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /topic output 'answered' has no description/.test(m)));
});

test("adaptive card prompts: submit, version, Action.Execute, labels; formulas are left alone", () => {
  const card = (json) => topic(`    - kind: AdaptiveCardPrompt\n      id: c1\n      card: |\n        ${json}\n`);
  const bad = check(card('{"type":"AdaptiveCard","version":"1.6","body":[{"type":"Input.Text","id":"name","isRequired":true}],"actions":[{"type":"Action.Execute"}]}'));
  assert.ok(bad.some((m) => /no Action.Submit/.test(m)), bad.join("\n"));
  assert.ok(bad.some((m) => /Action.Execute/.test(m)));
  assert.ok(bad.some((m) => /required input 'name' has no label/.test(m)));
  assert.ok(bad.some((m) => /^info: card version 1.6: Teams renders up to 1.5/.test(m)));
  const good = check(card('{"type":"AdaptiveCard","version":"1.5","body":[{"type":"Input.Text","id":"name","label":"Name","isRequired":true}],"actions":[{"type":"Action.Submit"}]}'));
  assert.ok(!good.some((m) => /card|label/.test(m)), good.join("\n"));
  assert.ok(!check(topic('    - kind: AdaptiveCardPrompt\n      id: c1\n      card: ="{}"\n')).some((m) => /card/.test(m)));
});

test("workspace: conflict markers, file names, topic names with a period, support files", (t) => {
  const root = fixtureCopy(t);
  const topics = join(root, "topics");
  mkdirSync(topics, { recursive: true });
  writeFileSync(join(topics, "Merged.mcs.yml"), topic("    - kind: SendActivity\n      id: m1\n      activity: mine\n") + "<<<<<<< HEAD\n");
  writeFileSync(join(topics, "Café Hours.mcs.yml"), topic("    - kind: SendActivity\n      id: m1\n      activity: hi\n"));
  writeFileSync(join(topics, "Version.mcs.yml"), "mcs.metadata:\n  componentName: Release 2.0 notes\n" + topic("    - kind: SendActivity\n      id: m1\n      activity: hi\n"));
  writeFileSync(join(root, "settings.mcs.yml"), "a: 1\n=======\nb: 2\n");
  const v = validateWorkspace(root);
  assert.ok(fileMessages(v, "topics/Merged.mcs.yml").some((m) => /^error: line \d+: unresolved merge conflict marker '<<<<<<<'/.test(m)), JSON.stringify(v.files));
  assert.ok(fileMessages(v, "topics/Café Hours.mcs.yml").some((m) => /^error: file name 'Café Hours'/.test(m)));
  assert.ok(fileMessages(v, "topics/Version.mcs.yml").some((m) => /^warning: topic name 'Release 2.0 notes' contains a period/.test(m)), JSON.stringify(fileMessages(v, "topics/Version.mcs.yml")));
  assert.ok(fileMessages(v, "settings.mcs.yml").some((m) => /merge conflict/.test(m)), JSON.stringify(v.files.map((f) => f.file)));
});

test("an explicit schema name over 100 characters is an error", (t) => {
  const root = fixtureCopy(t);
  mkdirSync(join(root, "variables"), { recursive: true });
  const long = `cr123_${"a".repeat(80)}.globalvariable.Region`;
  writeFileSync(join(root, "variables", "Region.mcs.yml"), `name: Region\naIVisibility: UseInAIContext\nscope: Conversation\nschemaName: ${long}\nkind: GlobalVariableComponent\n`);
  const v = validateWorkspace(root, "variables/Region.mcs.yml");
  assert.ok(fileMessages(v, "variables/Region.mcs.yml").some((m) => /^error: schema name .* is \d+ characters; Dataverse allows 100/.test(m)));
});

test("review: single-word phrases and topics that describe themselves the same way", (t) => {
  const root = fixtureCopy(t);
  const body = (desc, phrases) => `kind: AdaptiveDialog\nmodelDescription: ${desc}\nbeginDialog:\n  kind: OnRecognizedIntent\n  id: main\n  intent:\n    triggerQueries:\n${phrases.map((p) => `      - ${p}`).join("\n")}\n  actions:\n    - kind: SendActivity\n      id: m1\n      activity: hi\n`;
  writeFileSync(join(root, "topics", "Orders.mcs.yml"), body("Answers questions about orders.", ["orders", "where is my order", "track my order"]));
  writeFileSync(join(root, "topics", "Shipping.mcs.yml"), body("Answers questions about orders", ["when does it ship", "shipping time", "delivery date"]));
  const rules = reviewWorkspace(root).findings.map((x) => x.rule);
  assert.ok(rules.includes("topic-phrase-single-word"), rules.join(","));
  assert.ok(rules.includes("topic-description-duplicate"), rules.join(","));
});
