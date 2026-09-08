/**
 * Choosing a tool preset during a session, driven through the real server over
 * stdio. applyToolPreset works on the SDK handles the registration wrapper
 * keeps, so it cannot be exercised by importing a module: the only honest test
 * is the one that asks the server what it offers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let child;
let rpc;

before(async () => {
  child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buffer += d.toString("utf8");
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* notifications and anything else are not replies */
      }
    }
  });
  rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout: ${method}`))), 30_000);
    });

  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "presets.test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
});

after(() => child?.kill());

const toolNames = async () => (await rpc("tools/list", {})).result.tools.map((t) => t.name);
const call = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);

test("cs_init offers a preset menu with a live count and a reason per preset", async () => {
  const init = await call("cs_init");
  assert.ok(init.toolPresets, "cs_init should offer the choice");
  assert.match(init.toolPresets.question, /which set of tools/i);

  const names = init.toolPresets.options.map((o) => o.preset);
  assert.deepEqual(names.sort(), ["admin", "authoring", "core", "full", "solutions"]);
  for (const o of init.toolPresets.options) {
    assert.ok(o.offers > 0, `${o.preset} offers nothing`);
    assert.ok(o.when.length > 30, `${o.preset} has no when-to-use line`);
  }
  assert.equal(init.serverBuild.offered, (await toolNames()).length, "serverBuild.offered should match what tools/list returns");
});

test("choosing a preset changes what the server offers, and every advertised count is honest", async () => {
  const init = await call("cs_init");
  const full = (await toolNames()).length;

  for (const option of init.toolPresets.options) {
    const applied = await call("cs_set_tool_preset", { preset: option.preset });
    const listed = await toolNames();
    assert.equal(applied.preset, option.preset);
    assert.equal(listed.length, option.offers, `${option.preset}: cs_init advertised ${option.offers}, tools/list returned ${listed.length}`);
    assert.equal(applied.offered, listed.length);

    // A session must always be able to change its mind back.
    for (const control of ["cs_init", "cs_guide", "cs_set_tool_preset", "cs_job_status"]) {
      assert.ok(listed.includes(control), `${option.preset} dropped ${control}, so the session could not recover`);
    }
  }

  await call("cs_set_tool_preset", { preset: "full" });
  assert.equal((await toolNames()).length, full, "'full' must restore everything");
});

test("core hides the tenant tools but keeps the escape hatch, and keep adds tools back", async () => {
  const core = await call("cs_set_tool_preset", { preset: "core" });
  assert.ok(!core.tools.includes("cs_backup_tenant"));
  assert.ok(core.tools.includes("cs_pac"), "cs_pac is how anything core hides stays reachable");
  assert.ok(core.hidden > 0);
  assert.match(core.note, /Nothing is lost/);

  const withExtra = await call("cs_set_tool_preset", { preset: "core", keep: ["cs_backup_tenant"] });
  assert.ok(withExtra.tools.includes("cs_backup_tenant"), "keep should add a tool on top of the preset");
  assert.ok((await toolNames()).includes("cs_backup_tenant"));

  await call("cs_set_tool_preset", { preset: "full" });
});

test("a hidden tool is refused while hidden, and works again once restored", async () => {
  await call("cs_set_tool_preset", { preset: "authoring" });
  const hidden = await rpc("tools/call", { name: "cs_backup_tenant", arguments: { dir: "." } });
  assert.ok(hidden.error || hidden.result?.isError, "a disabled tool must not run");

  await call("cs_set_tool_preset", { preset: "full" });
  assert.ok((await toolNames()).includes("cs_backup_tenant"));
});
