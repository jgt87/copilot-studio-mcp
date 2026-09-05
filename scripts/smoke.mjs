#!/usr/bin/env node
/**
 * Drive the built server over stdio like an MCP client would:
 * initialize -> tools/list -> a few read-only tools/call. Fails if anything
 * other than JSON-RPC appears on stdout.
 *
 * Usage: node scripts/smoke.mjs [workspacePath]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "dist", "index.js");
const workspace = process.argv[2] ?? path.join(here, "..", "test", "fixtures", "pac-default");

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
const pending = new Map();
let nextId = 1;
const nonJson = [];

child.stdout.on("data", (d) => {
  buffer += d.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      nonJson.push(line);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function callTool(name, args) {
  return request("tools/call", { name, arguments: args }).then((r) => {
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    const text = r.result?.content?.[0]?.text ?? "";
    return { isError: Boolean(r.result?.isError), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  });
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("initialize", init.result?.serverInfo?.name === "copilot-studio-mcp", init.result?.serverInfo?.version);
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list", names.length >= 30, `${names.length} tools`);
  for (const n of ["cs_doctor", "cs_describe_workspace", "cs_validate", "cs_add_topic", "cs_push", "cs_run_evaluation", "cs_chat", "cs_pull_solution", "cs_deploy_solution", "cs_create_deployment_settings"]) check(`tool ${n} registered`, names.includes(n));

  const doctor = await callTool("cs_doctor", { workspace });
  check("cs_doctor", !doctor.isError && doctor.json?.serverVersion, doctor.json?.pac?.version ? `pac ${doctor.json.pac.version}` : "pac not found");

  const desc = await callTool("cs_describe_workspace", { workspace });
  check("cs_describe_workspace", !desc.isError && desc.json?.counts?.topics >= 1, `${desc.json?.counts?.topics} topics, harness ${desc.json?.harness}`);

  const val = await callTool("cs_validate", { workspace });
  check("cs_validate", !val.isError && val.json?.errors === 0, `${val.json?.checked} files, ${val.json?.warnings} warnings`);

  const schema = await callTool("cs_lookup_schema", { name: "Question" });
  check("cs_lookup_schema", !schema.isError && /variable/.test(schema.text));

  const push = await callTool("cs_push", { workspace });
  check("cs_push dry-run without confirm", !push.isError && push.json?.dryRun === true);

  const pac = await callTool("cs_pac", { args: ["solution", "import", "--path", "x.zip"] });
  check("cs_pac requires confirm for mutations", pac.json?.dryRun === true);

  const connectors = await callTool("cs_list_connectors", { offline: true, search: "Office 365 Outlook" });
  check("cs_list_connectors offline seed", connectors.json?.connectors?.[0]?.name === "shared_office365", connectors.json?.source);

  const fixtureSolution = path.join(here, "..", "test", "fixtures", "unpacked-solution");
  const deploy = await callTool("cs_deploy_solution", { targetEnvironment: "00000000-0000-0000-0000-000000000000", zip: "nonexistent.zip", srcFolder: fixtureSolution });
  check("cs_deploy_solution dry-run without confirm", deploy.json?.dryRun === true, deploy.json?.wouldDo?.slice(0, 60));

  check("stdout carried only JSON-RPC", nonJson.length === 0, nonJson.length ? nonJson[0].slice(0, 80) : "");
} catch (err) {
  check("smoke run", false, err.message);
} finally {
  child.kill();
}
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
