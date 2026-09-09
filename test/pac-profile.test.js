import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPac } from "../dist/pac.js";
import { runPacAs, withPacProfile } from "../dist/pacProfile.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../dist/tools/shared.js";
import "../dist/tools/solutions.js";

function fake(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-profiles-"));
  const state = join(dir, "state.txt");
  const script = join(dir, "fake.mjs");
  writeFileSync(state, "1");
  writeFileSync(script, `import fs from 'node:fs';
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
const active = fs.readFileSync(state, 'utf8');
if (args[0] === 'auth' && args[1] === 'list') {
  for (const [id,name] of [['1','maker'],['2','admin']]) console.log('['+id+'] '+(active===id?'*':'')+' UNIVERSAL '+name+' https://example.test user@example.test Public');
} else if (args[0] === 'auth' && args[1] === 'select') {
  fs.writeFileSync(state, args[args.indexOf('--index')+1]);
} else if (args[0] === 'copilot' && args[1] === 'publish') console.log('Failed to publish');
else console.log('active='+active);
`);
  const exe = join(dir, process.platform === "win32" ? "pac.cmd" : "pac");
  writeFileSync(exe, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  const keys = ["PAC_PATH", "CPS_PAC_PROFILE", "CPS_ADMIN_PROFILE"];
  const previous = keys.map(k => process.env[k]);
  process.env.PAC_PATH = exe;
  delete process.env.CPS_PAC_PROFILE;
  delete process.env.CPS_ADMIN_PROFILE;
  t.after(() => { keys.forEach((k,i) => previous[i] === undefined ? delete process.env[k] : process.env[k] = previous[i]); rmSync(dir, { recursive: true, force: true }); });
  return { dir, state };
}

test("unprofiled and direct PAC calls wait for the admin transaction to restore the maker", async (t) => {
  const { state } = fake(t);
  let entered, release;
  const ready = new Promise(r => entered = r);
  const gate = new Promise(r => release = r);
  const admin = withPacProfile("admin", async () => {
    assert.equal((await runPac(["admin", "list"])).stdout.trim(), "active=2");
    entered();
    await gate;
    assert.equal((await runPac(["solution", "list"])).stdout.trim(), "active=2");
  });
  await ready;
  let finished = false;
  const maker = runPacAs(undefined, ["copilot", "list"]).then(r => { finished = true; return r; });
  const direct = runPac(["copilot", "list"]);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(finished, false);
  release();
  await admin;
  assert.equal((await maker).stdout.trim(), "active=1");
  assert.equal((await direct).stdout.trim(), "active=1");
  assert.equal(readFileSync(state, "utf8"), "1");
});

test("direct maker/admin calls honor configured defaults and restore after errors", async (t) => {
  const { state } = fake(t);
  process.env.CPS_PAC_PROFILE = "maker";
  process.env.CPS_ADMIN_PROFILE = "admin";
  writeFileSync(state, "2");
  assert.equal((await runPac(["copilot", "list"])).stdout.trim(), "active=1");
  assert.equal(readFileSync(state, "utf8"), "2");
  writeFileSync(state, "1");
  assert.equal((await runPac(["admin", "list"])).stdout.trim(), "active=2");
  await assert.rejects(withPacProfile("admin", async () => { throw new Error("work failed"); }), /work failed/);
  assert.equal(readFileSync(state, "utf8"), "1");
});

test("deployment reports a zero-exit publish failure through the real MCP handler", async (t) => {
  const { dir } = fake(t);
  writeFileSync(join(dir, "solution.json"), JSON.stringify({ exports: { managed: "fake.zip" }, settingsFile: null, agents: [{ schemaName: "test_agent" }] }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "regression", version: "1" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const response = await client.callTool({ name: "cs_deploy_solution", arguments: { solutionDir: dir, targetEnvironment: "offline-target", confirm: true } });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.import.ok, true);
    assert.equal(result.published[0].ok, false);
    assert.equal(result.ok, false);
    assert.equal(response.isError, true);
  } finally { await client.close(); await server.close(); }
});
