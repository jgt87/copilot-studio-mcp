import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudContext, VERSION, text } from "../dist/tools/shared.js";
import { quickDrift, writeStamp, remoteStateFrom, briefQuick } from "../dist/drift.js";
import { readWorkspace } from "../dist/workspace.js";
import { workspaceFingerprints } from "../dist/compare.js";
import { buildFlowUpdate } from "../dist/authoring/flowBuilder.js";
import { updateFlow } from "../dist/cloud/dataverseFlows.js";
import { startJob, publicView } from "../dist/jobs.js";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "cs-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("test/fixtures/pac-default", root, { recursive: true });
  mkdirSync(join(root, ".mcs"));
  writeFileSync(join(root, ".mcs", "conn.json"), JSON.stringify({ EnvironmentId: "source-id", AgentId: "source-bot", TenantId: "source-tenant", DataverseEndpoint: "https://source.example" }));
  return root;
}

test("explicit target IDs resolve their own URL, including the snapshot context path", async (t) => {
  const root = workspace(t);
  const old = process.env.CPS_ENVIRONMENT_URL;
  process.env.CPS_ENVIRONMENT_URL = "https://source.example";
  t.after(() => old === undefined ? delete process.env.CPS_ENVIRONMENT_URL : process.env.CPS_ENVIRONMENT_URL = old);
  const calls = [];
  const resolve = async (auth, id) => { calls.push({ auth, id }); return "https://target.example"; };
  const target = await cloudContext({ workspace: root, environmentId: "target-id" }, { dataverse: true }, resolve);
  assert.equal(target.dataverseUrl, "https://target.example");
  assert.equal(target.botId, null);
  assert.equal(target.schemaName, null);
  assert.equal(target.tenantId, "organizations");
  assert.deepEqual(calls.map(c => c.id), ["target-id"]);
  const snapshot = await cloudContext({ workspace: root, environmentId: "target-id" });
  assert.equal(snapshot.dataverseUrl, null, "snapshot reader must resolve the target rather than reuse the workspace URL");
  const url = await cloudContext({ workspace: root, dataverseUrl: "https://target.example" }, { dataverse: true }, resolve);
  assert.equal(url.environmentId, null);
  assert.equal(url.botId, null);
  const source = await cloudContext({ workspace: root, environmentId: "source-id" }, { dataverse: true }, resolve);
  assert.equal(source.dataverseUrl, "https://source.example");
  assert.equal(source.botId, "source-bot");
  assert.equal(calls.length, 1);
});

test("quick preflight includes agent settings conflicts and deleted topics, including legacy stamps", (t) => {
  const root = workspace(t);
  const t0 = "2026-09-01T00:00:00Z", t1 = "2026-09-02T00:00:00Z";
  const bot = { modifiedOn: t0, publishedOn: t0 };
  const row = { componentId: "one", schemaName: "orc_OracleDefaultAgent.topic.Greeting", name: "Greeting", modifiedOn: t0, componentType: 8 };
  const stamp = writeStamp(root, { operation: "clone", remote: remoteStateFrom(bot, [row]) });
  const local = { ...workspaceFingerprints(root), "agent.mcs.yml": "changed" };
  const settings = quickDrift({ ws: readWorkspace(root), stamp, bot: { ...bot, modifiedOn: t1 }, components: [row], localFingerprints: local });
  assert.deepEqual(settings.conflicts.map(c => c.file), ["agent.mcs.yml"]);
  assert.equal(briefQuick(settings).conflicts.length, 1);
  assert.equal(quickDrift({ ws: readWorkspace(root), stamp, bot, components: [row], localFingerprints: local }).conflicts.length, 0);
  rmSync(join(root, "topics", "Greeting.mcs.yml"));
  for (const legacy of [false, true]) {
    if (legacy) delete stamp.remote.components[row.schemaName].file;
    const result = quickDrift({ ws: readWorkspace(root), stamp, bot, components: [{ ...row, modifiedOn: t1 }] });
    assert.deepEqual(result.conflicts.map(c => c.file), ["topics/Greeting.mcs.yml"]);
    assert.equal(quickDrift({ ws: readWorkspace(root), stamp, bot, components: [] }).conflicts.length, 0, "the same deletion on both sides is not a conflict");
  }
});

test("flow tool updates persist new references while preserving existing bound metadata", async () => {
  const binding = { runtimeSource: "embedded", connection: { connectionReferenceLogicalName: "existing_mail", id: "bound-connection" }, api: { name: "shared_office365" } };
  const before = { name: "Test", clientData: { custom: "keep", properties: { definition: {}, connectionReferences: { shared_office365: binding } } } };
  const steps = [{ type: "connector", name: "Mail", connectorId: "shared_office365", operationId: "SendEmailV2" }, { type: "connector", name: "Files", connectorId: "shared_sharepointonline", operationId: "GetItems" }];
  const { rebuilt, changes } = buildFlowUpdate(before, { steps });
  let patched;
  await updateFlow("https://offline.example", "fake", "1", changes, async (_url, init) => {
    if (init.method === "PATCH") { patched = JSON.parse(init.body); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ workflowid: "1", name: before.name, clientdata: JSON.stringify(before.clientData) }));
  });
  const saved = JSON.parse(patched.clientdata);
  assert.equal(saved.custom, "keep");
  assert.deepEqual(saved.properties.connectionReferences.shared_office365, binding);
  for (const c of rebuilt.connections) assert.equal(saved.properties.connectionReferences[c.connectorId].connection.connectionReferenceLogicalName, c.connectionReference);
  assert.throws(() => buildFlowUpdate(before, { steps: [{ ...steps[0], connectionReference: "different" }] }), /explicitly replace/);
  const replacement = { ...binding, connection: { connectionReferenceLogicalName: "different" } };
  const explicit = buildFlowUpdate(before, { steps: [{ ...steps[0], connectionReference: "different" }], connectionReferences: { shared_office365: replacement } });
  assert.deepEqual(explicit.changes.connectionReferences.shared_office365, replacement);
  assert.throws(() => buildFlowUpdate(before, { steps, definition: {} }), /single source/);
});

test("failed job verdict and MCP error preserve the PAC diagnostic payload", async () => {
  const result = { ok: false, exitCode: 1, explanation: "Publish failed", stdout: "diagnostic" };
  const job = startJob({ tool: "cs_publish", label: "offline" }, async () => result);
  await new Promise(r => setImmediate(r));
  const view = publicView(job);
  assert.equal(view.state, "failed");
  assert.equal(view.error, "Publish failed");
  assert.deepEqual(view.result, result);
  assert.equal(text(view).isError, true);
  assert.equal(text(result).isError, true);
});

test("the MCP version matches the distributed package", () => {
  assert.equal(VERSION, JSON.parse(readFileSync("package.json", "utf8")).version);
});
