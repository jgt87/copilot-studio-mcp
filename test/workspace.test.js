import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { describeWorkspace, findWorkspaceRoot, readWorkspace } from "../dist/workspace.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function scaffold(t, fixture = "pac-default") {
  const dir = mkdtempSync(join(tmpdir(), "cs-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, "agent");
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  return root;
}

test("the pac scaffold is read as a standard-harness workspace with its topics", (t) => {
  const ws = readWorkspace(scaffold(t));
  assert.equal(ws.harness, "standard");
  assert.equal(ws.schemaName, "orc_OracleDefaultAgent");
  assert.equal(ws.settings.displayName, "Oracle Default Agent");
  assert.equal(ws.agent.model, "GPT5Chat");
  assert.deepEqual(ws.agent.conversationStarters, []);
  assert.ok(ws.topics.length >= 10, `${ws.topics.length} topics`);
  const greeting = ws.topics.find((x) => x.name === "Greeting");
  assert.equal(greeting.details.triggerKind, "OnRecognizedIntent");
  assert.ok(greeting.details.triggerPhrases.length > 0);
  assert.equal(typeof greeting.details.actionCount, "number");
  assert.equal(greeting.relPath, "topics/Greeting.mcs.yml", "component paths are posix-style and relative");
  // Nothing else is present in a fresh scaffold.
  for (const empty of [ws.knowledge, ws.actions, ws.triggers, ws.variables, ws.workflows, ws.connectionReferences, ws.knowledgeFiles]) assert.deepEqual(empty, []);
  assert.equal(ws.sync.source, "none", "an init-only workspace is not sync-connected");
});

test("the GitHub Copilot harness is recognised by its authoring model", (t) => {
  const ws = readWorkspace(scaffold(t, "pac-clicopilot"));
  assert.equal(ws.harness, "github-copilot");
  assert.equal(ws.sync.source, "pac", "agent.sync.yaml marks a pac-synced workspace");
});

test("tools/ and triggers/ are read as well as actions/ and trigger/", (t) => {
  const root = scaffold(t, "agent-with-mcp-action");
  const ws = readWorkspace(root);
  assert.equal(ws.actions.length, 2, "the fixture keeps its tools in actions/");
  const mcp = ws.actions.find((a) => a.name === "CustomMCP" || a.relPath.endsWith("CustomMCP.mcs.yml"));
  assert.ok(mcp, ws.actions.map((a) => a.relPath).join(", "));

  renameSync(join(root, "actions"), join(root, "tools"));
  const renamed = readWorkspace(root);
  assert.equal(renamed.actions.length, 2, "the alternate folder name is read the same way");
  assert.ok(renamed.actions.every((a) => a.relPath.startsWith("tools/")));

  mkdirSync(join(root, "triggers"), { recursive: true });
  writeFileSync(join(root, "triggers", "OnRow.mcs.yml"), "kind: ExternalTrigger\nexternalTriggerSource:\n  kind: ConnectorEventTrigger\n  flowId: f1\n");
  const withTrigger = readWorkspace(root);
  assert.equal(withTrigger.triggers.length, 1);
  assert.equal(withTrigger.triggers[0].details.flowId, "f1");
});

test("connection references are read from either document shape, and from the misspelled file", (t) => {
  const root = scaffold(t);
  const entry = { connectionReferenceLogicalName: "orc_sp", connectorId: "shared_sharepointonline" };
  writeFileSync(join(root, "connectionreferences.mcs.yml"), `connectionReferences:\n  - connectionReferenceLogicalName: orc_sp\n    connectorId: shared_sharepointonline\n`);
  assert.deepEqual(readWorkspace(root).connectionReferences, [entry], "a document with a connectionReferences list");

  writeFileSync(join(root, "connectionreferences.mcs.yml"), `- connectionReferenceLogicalName: orc_sp\n  connectorId: shared_sharepointonline\n`);
  assert.deepEqual(readWorkspace(root).connectionReferences, [entry], "a bare list");

  writeFileSync(join(root, "connectionreferences.mcs.yml"), "connectionReferences: not-a-list\n");
  assert.deepEqual(readWorkspace(root).connectionReferences, [], "anything else yields none rather than throwing");

  rmSync(join(root, "connectionreferences.mcs.yml"));
  writeFileSync(join(root, "connectioreferences.mcs.yml"), `connectionReferences:\n  - connectionReferenceLogicalName: orc_sp\n    connectorId: shared_sharepointonline\n`);
  assert.deepEqual(readWorkspace(root).connectionReferences, [entry], "pac has been seen to write this name");
});

test("workflows and uploaded knowledge files are inventoried", (t) => {
  const root = scaffold(t);
  mkdirSync(join(root, "workflows", "Lookup Order"), { recursive: true });
  writeFileSync(join(root, "workflows", "Lookup Order", "metadata.yaml"), "kind: CloudFlowDefinition\ndisplayName: Lookup Order\n");
  writeFileSync(join(root, "workflows", "Lookup Order", "workflow.json"), "{}");
  mkdirSync(join(root, "workflows", "No definition"), { recursive: true });
  mkdirSync(join(root, "knowledge", "files"), { recursive: true });
  writeFileSync(join(root, "knowledge", "files", "handbook.pdf"), "%PDF-1.4");

  const ws = readWorkspace(root);
  assert.deepEqual(ws.workflows.map((w) => [w.name, w.hasDefinition, w.metadata?.displayName ?? null]).sort(), [["Lookup Order", true, "Lookup Order"], ["No definition", false, null]]);
  assert.deepEqual(ws.knowledgeFiles, ["knowledge/files/handbook.pdf"]);
  assert.ok(!ws.otherFiles.some((f) => f.startsWith("workflows/") || f.startsWith("knowledge/files/")), "those are reported in their own lists, not as loose files");
});

test("a component that does not parse is reported, not thrown", (t) => {
  const root = scaffold(t);
  writeFileSync(join(root, "topics", "Broken.mcs.yml"), "kind: AdaptiveDialog\n  bad indent: [\n");
  const ws = readWorkspace(root);
  const broken = ws.topics.find((x) => x.relPath === "topics/Broken.mcs.yml");
  assert.ok(broken.parseError, "the parse error travels with the component");
  assert.deepEqual(broken.details, {}, "details are left empty rather than half-read");
  assert.ok(ws.topics.length > 1, "the other topics are still read");
});

test("sync metadata comes from the VS Code extension file when present", (t) => {
  const root = scaffold(t);
  mkdirSync(join(root, ".mcs"), { recursive: true });
  writeFileSync(
    join(root, ".mcs", "conn.json"),
    JSON.stringify({ EnvironmentId: "e1", AgentId: "b1", DataverseEndpoint: "https://org.crm.dynamics.com/", AccountInfo: { TenantId: "t1" } }),
  );
  const ws = readWorkspace(root);
  assert.equal(ws.sync.source, "vscode-extension");
  assert.equal(ws.sync.environmentId, "e1");
  assert.equal(ws.sync.agentId, "b1");
  assert.equal(ws.sync.tenantId, "t1");
  assert.equal(ws.sync.dataverseUrl, "https://org.crm.dynamics.com", "the trailing slash is trimmed");
});

test("findWorkspaceRoot accepts the root, a subfolder and a parent of one workspace", (t) => {
  const root = scaffold(t);
  assert.equal(findWorkspaceRoot(root), root);
  assert.equal(findWorkspaceRoot(join(root, "topics")), root, "from inside the workspace");
  assert.equal(findWorkspaceRoot(join(root, "..")), root, "a parent holding exactly one workspace");
  const empty = mkdtempSync(join(tmpdir(), "cs-ws-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true, maxRetries: 3 }));
  assert.equal(findWorkspaceRoot(empty), null);
});

test("describeWorkspace summarises without the raw documents", (t) => {
  const ws = readWorkspace(scaffold(t));
  const d = describeWorkspace(ws);
  assert.equal(d.root, ws.root);
  assert.equal(d.harness, "standard");
  assert.equal(d.displayName, "Oracle Default Agent");
  assert.equal(d.counts.topics, ws.topics.length);
  assert.deepEqual(d.sync, { source: "none", environmentId: null, agentId: null, tenantId: null, dataverseUrl: null });
  assert.ok(!JSON.stringify(d).includes("beginDialog"), "the summary carries details, not whole documents");
});
