import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compareSnapshots, compareWorkspaces, compareChain, renderReportMarkdown, writeSnapshot, readSnapshot, writeReport } from "../dist/compare.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function snapshotDir(base, label, mutate) {
  const dir = join(base, label);
  const ws = join(dir, "agents", "Oracle Default Agent");
  cpSync(join(FIXTURES, "pac-default"), ws, { recursive: true });
  mkdirSync(join(ws, ".mcs"), { recursive: true });
  writeFileSync(join(ws, ".mcs", "conn.json"), JSON.stringify({ EnvironmentId: label, AgentId: "b1" }));
  const snap = {
    label,
    environment: `env-${label}`,
    takenAt: "2026-09-05T10:00:00.000Z",
    solution: "orc_OracleDefaultAgent",
    solutionRow: { uniqueName: "orc_OracleDefaultAgent", friendlyName: "Oracle", version: "1.0.0.3", isManaged: label !== "DEV" },
    agents: [{ schemaName: "orc_OracleDefaultAgent", botId: "b1", name: "Oracle Default Agent", workspace: ws, cloneError: null, publishedOn: "2026-09-01T00:00:00Z", modifiedOn: "2026-09-01T00:00:00Z", authenticationMode: 2, isManaged: false }],
    flows: [{ workflowId: "w1", name: "Lookup Order", state: "Activated", modifiedOn: null, isManaged: false }],
    connectionReferences: [{ logicalName: "orc_sp", displayName: "SharePoint", connectorId: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline", connectionId: `conn-${label}` }],
    environmentVariables: [{ schemaName: "orc_ApiUrl", displayName: "API URL", type: "String", defaultValue: "https://dev", currentValue: `https://${label.toLowerCase()}` }],
    notes: [],
  };
  if (mutate) mutate(ws, snap);
  writeSnapshot(dir, snap);
  return dir;
}

test("identical snapshots report no drift, environment-specific values are expected", (t) => {
  const base = mkdtempSync(join(tmpdir(), "cs-mcp-cmp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = snapshotDir(base, "DEV");
  const b = snapshotDir(base, "TEST");
  const r = compareSnapshots(a, b);
  assert.equal(r.drift, false, JSON.stringify(r.driftSummary));
  assert.equal(r.agents[0].status, "identical");
  assert.equal(r.solution.status, "managed-differs");
  assert.equal(r.connectionReferences[0].status, "same");
  assert.equal(r.environmentVariables[0].status, "value-differs");
  assert.ok(r.expectedDifferences.length >= 2);
  const md = renderReportMarkdown(r);
  assert.match(md, /no drift/);
  assert.match(md, /Expected differences/);
});

test("changed topic, missing flow, unbound connection and unpublished changes are drift", (t) => {
  const base = mkdtempSync(join(tmpdir(), "cs-mcp-cmp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = snapshotDir(base, "DEV", (ws, snap) => {
    writeFileSync(join(ws, "topics", "Extra.mcs.yml"), "kind: AdaptiveDialog\nbeginDialog:\n  kind: OnConversationStart\n  id: main\n  actions: []\n");
    snap.agents[0].modifiedOn = "2026-09-04T00:00:00Z";
  });
  const b = snapshotDir(base, "TEST", (ws, snap) => {
    const f = join(ws, "topics", "Greeting.mcs.yml");
    writeFileSync(f, readFileSync(f, "utf8").replace("Hello, how can I help you today?", "Hi there, what can I do for you?"));
    snap.flows = [];
    snap.connectionReferences[0].connectionId = null;
    snap.environmentVariables[0].currentValue = null;
    snap.environmentVariables[0].defaultValue = null;
  });
  const r = compareSnapshots(a, b);
  assert.equal(r.drift, true);
  const agent = r.agents[0];
  assert.equal(agent.status, "changed");
  assert.equal(agent.changedFiles, 2);
  const greeting = agent.files.find((f) => f.path === "topics/Greeting.mcs.yml");
  assert.equal(greeting.status, "changed");
  assert.match(greeting.diff, /-.*Hello, how can I help you today\?/);
  assert.match(greeting.diff, /\+.*Hi there, what can I do for you\?/);
  assert.equal(agent.files.find((f) => f.path === "topics/Extra.mcs.yml").status, "only-in-a");
  assert.equal(agent.publish.a.unpublishedChanges, true);
  assert.equal(r.flows[0].status, "only-in-a");
  assert.equal(r.connectionReferences[0].status, "unbound-in-b");
  assert.equal(r.environmentVariables[0].status, "no-value-in-b");
  assert.ok(r.driftSummary.some((d) => /unpublished changes/.test(d)));
  const md = renderReportMarkdown(r);
  assert.match(md, /DRIFT/);
  assert.match(md, /```diff/);
  const out = writeReport(base, "dev-vs-test", r);
  assert.ok(existsSync(out.markdown) && existsSync(out.json));
});

test("compareWorkspaces ignores noisy keys and non-agent files", (t) => {
  const base = mkdtempSync(join(tmpdir(), "cs-mcp-cmp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = join(base, "a");
  const b = join(base, "b");
  cpSync(join(FIXTURES, "pac-default"), a, { recursive: true });
  cpSync(join(FIXTURES, "pac-default"), b, { recursive: true });
  mkdirSync(join(a, ".mcs"));
  writeFileSync(join(a, ".mcs", "conn.json"), "{}");
  writeFileSync(join(a, "connectionreferences.mcs.yml"), "kind: ConnectionReferencesSourceFile\nconnectionReferences:\n  - id: x\n    connectionReferenceLogicalName: orc_sp\n    connectionId: aaa\n    auditInfo: { createdOn: 1 }\n");
  writeFileSync(join(b, "connectionreferences.mcs.yml"), "kind: ConnectionReferencesSourceFile\nconnectionReferences:\n  - id: x\n    connectionReferenceLogicalName: orc_sp\n    connectionId: bbb\n    auditInfo: { createdOn: 2 }\n");
  const files = compareWorkspaces(a, b);
  assert.ok(files.every((f) => f.status === "identical"), JSON.stringify(files.filter((f) => f.status !== "identical")));
  assert.ok(!files.some((f) => f.path.startsWith(".mcs")));
});

test("compareChain compares adjacent pairs and snapshots round-trip", (t) => {
  const base = mkdtempSync(join(tmpdir(), "cs-mcp-cmp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dirs = ["DEV", "TEST", "ACC"].map((l) => snapshotDir(base, l));
  const reports = compareChain(dirs, { includeDiffs: false });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].a.label, "DEV");
  assert.equal(reports[1].b.label, "ACC");
  assert.equal(readSnapshot(dirs[0]).label, "DEV");
});
