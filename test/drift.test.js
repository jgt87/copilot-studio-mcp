import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as yaml from "js-yaml";

import { briefQuick, classifyFiles, compareWithClone, componentFileFor, gitState, localChanges, quickDrift, readStamp, remoteStateFrom, stampPath, writeStamp } from "../dist/drift.js";
import { workspaceFingerprints } from "../dist/compare.js";
import { getBot, listBotComponents } from "../dist/cloud/dataverse.js";
import { readWorkspace } from "../dist/workspace.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const AGENT = "orc_OracleDefaultAgent";

function scaffold(t, name = "agent") {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-drift-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const root = join(dir, name);
  cpSync(join(FIXTURES, "pac-default"), root, { recursive: true });
  mkdirSync(join(root, ".mcs"), { recursive: true });
  writeFileSync(join(root, ".mcs", "conn.json"), JSON.stringify({ EnvironmentId: "env-1", AgentId: "bot-1", DataverseEndpoint: "https://org.crm.dynamics.com" }));
  return root;
}

/** Relative path of a topic picked by trigger kind or display name. */
function topicFile(root, pick) {
  const ws = readWorkspace(root);
  const hit = ws.topics.find((x) => x.details.triggerKind === pick) ?? ws.topics.find((x) => x.name === pick);
  if (!hit) throw new Error(`no topic ${pick} in ${ws.topics.map((x) => `${x.name}/${x.details.triggerKind}`).join(", ")}`);
  return hit.relPath;
}

/** Change the YAML content (comments alone would not change the fingerprint). */
function editYaml(root, rel, marker) {
  const f = join(root, rel);
  const doc = yaml.load(readFileSync(f, "utf8"));
  doc.beginDialog.actions = [...(doc.beginDialog.actions ?? []), { kind: "SendActivity", id: `drift_${marker}`, activity: marker }];
  writeFileSync(f, yaml.dump(doc));
}

const row = (schemaName, name, modifiedOn, extra = {}) => ({ componentId: `id-${name}`, name, schemaName, componentType: 8, componentTypeLabel: "Topic", modifiedOn, modifiedBy: "Jane Maker", modifiedById: "u1", state: 0, ...extra });
const bot = (modifiedOn, publishedOn) => ({ botId: "bot-1", name: "Oracle", schemaName: AGENT, publishedOn, modifiedOn, modifiedBy: "Jane Maker", authenticationMode: 2 });

test("writeStamp records fingerprints and remote stamps under .mcs and reads back", (t) => {
  const root = scaffold(t);
  const remote = remoteStateFrom(bot("2026-09-01T10:00:00Z", "2026-09-01T09:00:00Z"), [row(`${AGENT}.topic.Greeting`, "Greeting", "2026-09-01T08:00:00Z")]);
  const s = writeStamp(root, { operation: "pull", botId: "bot-1", environmentId: "env-1", remote });
  assert.ok(existsSync(join(root, ".mcs", "cs-sync.json")));
  assert.equal(stampPath(root), join(root, ".mcs", "cs-sync.json"));
  assert.ok(Object.keys(s.files).includes("topics/Greeting.mcs.yml"));
  assert.ok(!Object.keys(s.files).some((p) => p.startsWith(".mcs/")), "the stamp itself is never fingerprinted");
  assert.deepEqual(readStamp(root), s);
  assert.equal(s.remote.components[`${AGENT}.topic.Greeting`].type, "Topic");
  assert.equal(localChanges(s, workspaceFingerprints(root)).length, 0);
  editYaml(root, "topics/Greeting.mcs.yml", "local");
  assert.deepEqual(localChanges(s, workspaceFingerprints(root)), ["topics/Greeting.mcs.yml"]);
  writeFileSync(stampPath(root), "not json");
  assert.equal(readStamp(root), null);
});

test("classifyFiles: three-way statuses against the stamp, two-way without it", () => {
  const stamp = { version: 1, operation: "pull", syncedAt: "2026-09-01T00:00:00Z", botId: null, environmentId: null, remote: null, files: { same: "1", localMod: "1", remoteMod: "1", both: "1", bothSame: "1", localDel: "1", remoteDel: "1", bothDel: "1" } };
  const local = { same: "1", localMod: "2", remoteMod: "1", both: "2", bothSame: "2", remoteDel: "1", localAdd: "1", bothAdd: "1" };
  const remote = { same: "1", localMod: "1", remoteMod: "2", both: "3", bothSame: "2", localDel: "1", remoteAdd: "1", bothAdd: "2" };
  const by = Object.fromEntries(classifyFiles(stamp, local, remote).map((f) => [f.path, f]));
  assert.equal(by.same, undefined);
  assert.equal(by.bothDel, undefined);
  assert.equal(by.localMod.status, "local-modified");
  assert.equal(by.localMod.conflict, false);
  assert.equal(by.remoteMod.status, "remote-modified");
  assert.equal(by.both.status, "both-modified");
  assert.equal(by.both.conflict, true);
  assert.equal(by.bothSame.status, "both-modified-same");
  assert.equal(by.bothSame.conflict, false);
  assert.equal(by.localDel.status, "local-deleted");
  assert.equal(by.remoteDel.status, "remote-deleted");
  assert.equal(by.localAdd.status, "local-added");
  assert.equal(by.remoteAdd.status, "remote-added");
  assert.equal(by.bothAdd.status, "both-added");
  assert.equal(by.bothAdd.conflict, true);
  const two = classifyFiles(null, local, remote);
  assert.deepEqual(Object.fromEntries(two.map((f) => [f.path, f.status])), { localMod: "differs", remoteMod: "differs", both: "differs", remoteDel: "only-local", localAdd: "only-local", localDel: "only-remote", remoteAdd: "only-remote", bothAdd: "differs" });
  assert.ok(two.every((f) => !f.conflict), "no conflicts can be claimed without a baseline");
});

test("componentFileFor maps Dataverse schema names to workspace files", (t) => {
  const ws = readWorkspace(scaffold(t));
  assert.equal(componentFileFor(ws, `${AGENT}.topic.Greeting`), "topics/Greeting.mcs.yml");
  assert.equal(componentFileFor(ws, `${AGENT}.topic.greeting`), "topics/Greeting.mcs.yml");
  assert.equal(componentFileFor(ws, `${AGENT}.unknownkind.Greeting`), "topics/Greeting.mcs.yml", "unknown kinds search every folder");
  assert.equal(componentFileFor(ws, `${AGENT}.knowledge.Nope`), null);
  assert.equal(componentFileFor(ws, null), null);
  assert.equal(componentFileFor(ws, "no-dots"), null);
});

test("quickDrift: component baseline flags modified, added, removed and conflicts", (t) => {
  const root = scaffold(t);
  const t0 = "2026-09-01T10:00:00Z";
  const escalate = topicFile(root, "OnEscalate");
  const before = [row(`${AGENT}.topic.Greeting`, "Greeting", t0), row(`${AGENT}.topic.${escalate.replace(/^topics\//, "").replace(/\.mcs\.yml$/, "")}`, "Escalate", t0), row(`${AGENT}.topic.Gone`, "Gone", t0)];
  const stamp = writeStamp(root, { operation: "pull", botId: "bot-1", environmentId: "env-1", remote: remoteStateFrom(bot(t0, t0), before) });
  editYaml(root, "topics/Greeting.mcs.yml", "local");
  const after = [row(`${AGENT}.topic.Greeting`, "Greeting", "2026-09-02T10:00:00Z"), before[1], row(`${AGENT}.topic.Brand`, "Brand", "2026-09-02T11:00:00Z")];
  const r = quickDrift({ ws: readWorkspace(root), stamp, bot: bot(t0, t0), components: after });
  assert.equal(r.baseline, "components");
  const by = Object.fromEntries(r.components.map((c) => [c.name, c]));
  assert.equal(by.Greeting.status, "modified");
  assert.equal(by.Greeting.file, "topics/Greeting.mcs.yml");
  assert.equal(by.Greeting.localModified, true);
  assert.equal(by.Greeting.conflict, true);
  assert.equal(by.Greeting.modifiedBy, "Jane Maker");
  assert.equal(by.Brand.status, "added");
  assert.equal(by.Brand.file, null);
  assert.equal(by.Gone.status, "removed");
  assert.equal(by.Escalate, undefined, "unchanged components are not listed");
  assert.deepEqual(r.conflicts.map((c) => c.name), ["Greeting"]);
  assert.equal(r.bot.settingsChanged, false);
  assert.equal(r.bot.unpublishedChanges, true);
  assert.deepEqual(r.localChanges, ["topics/Greeting.mcs.yml"]);
  assert.equal(r.remoteComponentCount, 3);
  assert.match(r.summary, /1 modified, 1 added, 1 removed/);
  assert.match(r.summary, /conflict/);
  const brief = briefQuick(r);
  assert.equal(brief.changes.length, 3);
  assert.equal(brief.localChanges, 1);
  const r2 = quickDrift({ ws: readWorkspace(root), stamp, bot: bot("2026-09-03T00:00:00Z", "2026-09-03T01:00:00Z"), components: before });
  assert.equal(r2.bot.settingsChanged, true);
  assert.equal(r2.components.length, 0);
  assert.equal(r2.bot.unpublishedChanges, false);
  assert.match(r2.summary, /agent settings changed/);
});

test("quickDrift: syncedAt baseline uses a skew margin; no stamp means no baseline", (t) => {
  const root = scaffold(t);
  const stamp = writeStamp(root, { operation: "push", botId: "bot-1", environmentId: "env-1", remote: null, now: new Date("2026-09-05T12:00:00Z") });
  const rows = [row(`${AGENT}.topic.Greeting`, "Greeting", "2026-09-05T11:59:30Z"), row(`${AGENT}.topic.Other`, "Other", "2026-09-05T12:05:00Z")];
  const r = quickDrift({ ws: readWorkspace(root), stamp, bot: bot("2026-09-05T11:00:00Z", null), components: rows });
  assert.equal(r.baseline, "syncedAt");
  assert.deepEqual(r.components.map((c) => `${c.status}:${c.name}`), ["modified:Other"], "a stamp written just after the push itself is not drift");
  assert.equal(r.bot.settingsChanged, false);
  assert.equal(r.bot.unpublishedChanges, null);
  assert.match(r.summary, /None of them changed locally/);
  const none = quickDrift({ ws: readWorkspace(root), stamp: null, bot: bot("2026-09-05T11:00:00Z", null), components: rows });
  assert.equal(none.baseline, "none");
  assert.equal(none.components.length, 0);
  assert.match(none.summary, /No sync stamp/);
});

test("compareWithClone classifies local, remote and conflicting edits with diffs", (t) => {
  const root = scaffold(t, "local");
  writeStamp(root, { operation: "clone", botId: "bot-1", environmentId: "env-1" });
  const remote = join(dirname(root), "remote");
  cpSync(root, remote, { recursive: true });
  const escalate = topicFile(root, "OnEscalate");
  const fallback = topicFile(root, "OnUnknownIntent");
  const victim = readWorkspace(root).topics.find((x) => !["topics/Greeting.mcs.yml", escalate, fallback].includes(x.relPath)).relPath;
  editYaml(root, "topics/Greeting.mcs.yml", "local");
  editYaml(remote, escalate, "portal");
  editYaml(root, fallback, "local");
  editYaml(remote, fallback, "portal");
  writeFileSync(join(remote, "topics", "New.mcs.yml"), "kind: AdaptiveDialog\nbeginDialog:\n  kind: OnConversationStart\n  id: main\n  actions: []\n");
  rmSync(join(root, victim));
  const r = compareWithClone(root, remote);
  const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(r.baseline, "stamp");
  assert.equal(by["topics/Greeting.mcs.yml"].status, "local-modified");
  assert.equal(by[escalate].status, "remote-modified");
  assert.match(by[escalate].diff, /\+.*portal/);
  assert.equal(by[fallback].status, "both-modified");
  assert.equal(by[fallback].conflict, true);
  assert.equal(by["topics/New.mcs.yml"].status, "remote-added");
  assert.equal(by[victim].status, "local-deleted");
  assert.equal(r.files.length, 5);
  assert.deepEqual(r.conflicts.map((f) => f.path), [fallback]);
  assert.match(r.summary, /1 conflict/);
  assert.ok(r.localChanges.includes(victim));
  assert.ok(compareWithClone(root, remote, { includeDiffs: false }).files.every((f) => !f.diff));
  const two = compareWithClone(root, remote, { stamp: null });
  assert.equal(two.baseline, "none");
  assert.ok(two.files.every((f) => !f.conflict));
  assert.match(two.summary, /No sync stamp/);
});

test("listBotComponents falls back to the parentbotid filter, follows paging and reads formatted values", async () => {
  const calls = [];
  const page1 = {
    value: [{ botcomponentid: "c1", name: "Greeting", schemaname: "x.topic.Greeting", componenttype: 8, "componenttype@OData.Community.Display.V1.FormattedValue": "Topic", modifiedon: "2026-09-01T00:00:00Z", _modifiedby_value: "u1", "_modifiedby_value@OData.Community.Display.V1.FormattedValue": "Jane Maker", statecode: 0 }],
    "@odata.nextLink": "https://org.crm.dynamics.com/api/data/v9.2/botcomponents?page=2",
  };
  const page2 = { value: [{ botcomponentid: "c2", name: "Docs", schemaname: "x.knowledge.Docs", componenttype: 14, "componenttype@OData.Community.Display.V1.FormattedValue": "Knowledge Source", modifiedon: "2026-09-02T00:00:00Z", _modifiedby_value: "u2", statecode: 0 }] };
  const fetchImpl = async (url, init) => {
    calls.push({ url, prefer: init.headers.Prefer });
    if (url.includes("/bot_botcomponent")) return new Response("navigation not found", { status: 404 });
    if (url.includes("page=2")) return new Response(JSON.stringify(page2), { status: 200 });
    return new Response(JSON.stringify(page1), { status: 200 });
  };
  const rows = await listBotComponents("https://org.crm.dynamics.com/", "tok", "bot-1", fetchImpl);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("bots(bot-1)/bot_botcomponent"));
  assert.ok(decodeURIComponent(calls[1].url).includes("_parentbotid_value eq bot-1"));
  assert.ok(calls[1].prefer.includes("FormattedValue"));
  assert.deepEqual(rows.map((r) => [r.name, r.componentTypeLabel, r.modifiedBy, r.modifiedById]), [["Greeting", "Topic", "Jane Maker", "u1"], ["Docs", "Knowledge Source", null, "u2"]]);
  await assert.rejects(listBotComponents("https://org.crm.dynamics.com", "tok", "bot-1", async () => new Response("denied", { status: 403 })), /403/);
  const b = await getBot("https://org.crm.dynamics.com", "tok", "bot-1", async () => new Response(JSON.stringify({ botid: "bot-1", name: "Oracle", schemaname: "x", publishedon: "2026-09-01T00:00:00Z", modifiedon: "2026-09-02T00:00:00Z", "_modifiedby_value@OData.Community.Display.V1.FormattedValue": "Jane Maker", authenticationmode: 2 }), { status: 200 }));
  assert.equal(b.modifiedBy, "Jane Maker");
  assert.equal(b.modifiedOn, "2026-09-02T00:00:00Z");
});

test("gitState reports repositories and plain folders", async (t) => {
  const outside = await gitState(scaffold(t));
  if (outside) assert.equal(outside.repo, false);
  const here = await gitState(process.cwd());
  if (here) {
    assert.equal(here.repo, true);
    assert.ok(typeof here.dirty === "number");
  }
});
