import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateWorkspace, collectDialogReferences } from "../dist/validate.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function workspaceCopy(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-validate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, "agent");
  cpSync(join(FIXTURES, "pac-default"), root, { recursive: true });
  return root;
}

const messages = (v, file) => (v.files.find((f) => f.file === file)?.diagnostics ?? []).map((d) => `${d.severity}: ${d.message}`);

test("the pac scaffold validates without errors", (t) => {
  const v = validateWorkspace(workspaceCopy(t));
  assert.equal(v.errors, 0, JSON.stringify(v.files.filter((f) => f.diagnostics.some((d) => d.severity === "error"))));
  assert.ok(v.files.length >= 14, `${v.files.length} files checked`);
  assert.ok(v.files.some((f) => f.file === "agent.mcs.yml"));
});

test("only= validates a single file, relative or absolute", (t) => {
  const root = workspaceCopy(t);
  const rel = validateWorkspace(root, "topics/Greeting.mcs.yml");
  assert.equal(rel.files.length, 1);
  assert.equal(rel.files[0].file, "topics/Greeting.mcs.yml");
  const abs = validateWorkspace(root, join(root, "topics", "Greeting.mcs.yml"));
  assert.equal(abs.files[0].file, "topics/Greeting.mcs.yml");
});

test("redirects: unknown local topic warns, system topics and placeholders are handled", (t) => {
  const root = workspaceCopy(t);
  writeFileSync(
    join(root, "topics", "Router.mcs.yml"),
    [
      "kind: AdaptiveDialog",
      "beginDialog:",
      "  kind: OnConversationStart",
      "  id: main",
      "  actions:",
      "    - kind: BeginDialog",
      "      id: b1",
      "      dialog: orc_OracleDefaultAgent.topic.Escalate",
      "    - kind: BeginDialog",
      "      id: b2",
      "      dialog: orc_OracleDefaultAgent.topic.DoesNotExist",
      "    - kind: BeginDialog",
      "      id: b3",
      "      dialog: <AGENT_SCHEMA>.topic.Greeting",
      "",
    ].join("\n"),
  );
  const v = validateWorkspace(root, "topics/Router.mcs.yml");
  const msgs = messages(v, "topics/Router.mcs.yml");
  assert.ok(msgs.some((m) => m.startsWith("warning:") && m.includes("DoesNotExist")), msgs.join("\n"));
  assert.ok(!msgs.some((m) => m.includes("topic.Escalate")), "system topic must not warn");
  assert.ok(msgs.some((m) => m.startsWith("error:") && m.includes("<AGENT_SCHEMA>")));
  assert.equal(v.errors, 1);
  assert.equal(v.warnings, 2, "redirect target warning plus the schema validator placeholder-text warning");
});

test("connection references: placeholder is an error, unlisted reference warns, catalog miss is informational", (t) => {
  const root = workspaceCopy(t);
  mkdirSync(join(root, "actions"));
  writeFileSync(join(root, "connectionreferences.mcs.yml"), "kind: ConnectionReferencesSourceFile\nconnectionReferences:\n  - id: x1\n    connectionReferenceLogicalName: orc_agent.shared_office365.abc\n    connectorId: shared_office365\n");
  const tool = (cr) => `kind: TaskDialog\nmodelDisplayName: T\nmodelDescription: T\naction:\n  kind: InvokeConnectorTaskAction\n  connectionReference: ${cr}\n  connectionProperties:\n    mode: Invoker\n  operationId: SendEmailV2\noutputMode: All\n`;
  writeFileSync(join(root, "actions", "Listed.mcs.yml"), tool("orc_agent.shared_office365.abc"));
  writeFileSync(join(root, "actions", "Unlisted.mcs.yml"), tool("orc_agent.shared_teams.zzz"));
  writeFileSync(join(root, "actions", "Placeholder.mcs.yml"), tool("<AGENT_SCHEMA>.shared_office365.abc"));
  const v = validateWorkspace(root);
  assert.ok(messages(v, "actions/Listed.mcs.yml").some((m) => m.startsWith("info:") && /no cached definition/.test(m)));
  assert.ok(!messages(v, "actions/Listed.mcs.yml").some((m) => m.startsWith("warning:")));
  assert.ok(messages(v, "actions/Unlisted.mcs.yml").some((m) => m.startsWith("warning:") && m.includes("not listed")));
  assert.ok(messages(v, "actions/Placeholder.mcs.yml").some((m) => m.startsWith("error:") && m.includes("<AGENT_SCHEMA>")));
  assert.equal(v.errors, 1);
});

test("a YAML parse error is reported as an error, not thrown", (t) => {
  const root = workspaceCopy(t);
  writeFileSync(join(root, "topics", "Broken.mcs.yml"), "kind: AdaptiveDialog\nbeginDialog: [unclosed\n");
  const v = validateWorkspace(root, "topics/Broken.mcs.yml");
  assert.equal(v.errors, 1);
  assert.match(v.files[0].diagnostics[0].message, /YAML parse error/);
});

test("collectDialogReferences walks nested actions and conditions", () => {
  const refs = collectDialogReferences({ beginDialog: { actions: [{ kind: "ConditionGroup", conditions: [{ actions: [{ kind: "BeginDialog", dialog: "a.topic.X" }] }], elseActions: [{ kind: "ReplaceDialog", dialog: "a.topic.Y" }] }] } });
  assert.deepEqual(refs, ["a.topic.X", "a.topic.Y"]);
});
