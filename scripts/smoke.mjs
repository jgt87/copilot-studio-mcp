#!/usr/bin/env node
/**
 * Drive the built server over stdio like an MCP client would:
 * initialize -> tools/list -> a few read-only tools/call. Fails if anything
 * other than JSON-RPC appears on stdout.
 *
 * Usage: node scripts/smoke.mjs [workspacePath]
 */
import { spawn } from "node:child_process";
import os from "node:os";
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

/** The complete lines in a chunk; a partial last line stays buffered for the next one. */
function takeLines(chunk) {
  buffer += chunk;
  const lines = [];
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) lines.push(line);
  }
  return lines;
}

/** One line of stdout: the reply a request is waiting for, or something that does not belong there. */
function deliver(line) {
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

child.stdout.on("data", (d) => {
  for (const line of takeLines(d.toString("utf8"))) deliver(line);
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

const readOnly = Boolean(process.env.CPS_READ_ONLY && !["", "0", "false", "no"].includes(process.env.CPS_READ_ONLY.toLowerCase()));
if (readOnly) console.log("(CPS_READ_ONLY is set: expecting the environment-changing tools to be withheld)");

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("initialize", init.result?.serverInfo?.name === "copilot-studio-mcp", init.result?.serverInfo?.version);
  notify("notifications/initialized", {});

  check("handshake carries usage instructions", /cs_guide/.test(init.result?.instructions ?? ""), `${(init.result?.instructions ?? "").length} chars`);

  const list = await request("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list", names.length >= 30, `${names.length} tools`);
  const always = ["cs_init", "cs_describe_workspace", "cs_validate", "cs_add_topic", "cs_guide", "cs_chat", "cs_pull_solution", "cs_create_deployment_settings"];
  const writers = ["cs_push", "cs_run_evaluation", "cs_deploy_solution"];
  for (const n of always) check(`tool ${n} registered`, names.includes(n));
  for (const n of writers) {
    check(`tool ${n} ${readOnly ? "withheld in read-only mode" : "registered"}`, names.includes(n) === !readOnly);
  }

  const prompts = await request("prompts/list", {}).catch(() => null);
  check("prompts/list", (prompts?.result?.prompts ?? []).length >= 5, `${(prompts?.result?.prompts ?? []).length} prompts`);

  const guide = await callTool("cs_guide", { topic: "tools", workspace });
  check("cs_guide returns a walkthrough", !guide.isError && /# Tools/.test(guide.text) && /Next steps here/.test(guide.text));

  const start = await callTool("cs_init", { workspace });
  check("cs_init", !start.isError && start.json?.serverVersion, start.json?.pac?.version ? `pac ${start.json.pac.version}` : "pac not found");

  const desc = await callTool("cs_describe_workspace", { workspace });
  check("cs_describe_workspace", !desc.isError && desc.json?.counts?.topics >= 1, `${desc.json?.counts?.topics} topics, harness ${desc.json?.harness}`);

  const val = await callTool("cs_validate", { workspace });
  check("cs_validate", !val.isError && val.json?.errors === 0, `${val.json?.checked} files, ${val.json?.warnings} warnings`);

  const schema = await callTool("cs_lookup_schema", { name: "Question" });
  check("cs_lookup_schema", !schema.isError && /variable/.test(schema.text));

  if (!readOnly) {
    const push = await callTool("cs_push", { workspace });
    check("cs_push dry-run without confirm", !push.isError && push.json?.dryRun === true);
  }

  const pac = await callTool("cs_pac", { args: ["solution", "import", "--path", "x.zip"] });
  check(readOnly ? "cs_pac refuses a write in read-only mode" : "cs_pac requires confirm for mutations", readOnly ? pac.isError && /CPS_READ_ONLY/.test(pac.text) : pac.json?.dryRun === true);

  const pacRead = await callTool("cs_pac", { args: ["help"] });
  check("cs_pac still runs read-only commands", !pacRead.isError || !/CPS_READ_ONLY/.test(pacRead.text));

  const initLocal = await callTool("cs_create_agent", { name: "Smoke", publisherPrefix: "smk", projectDir: path.join(os.tmpdir(), "cs-smoke-never-created"), environment: "00000000-0000-0000-0000-000000000000" });
  check(readOnly ? "cs_create_agent refuses the environment path in read-only mode" : "cs_create_agent dry-run without confirm", readOnly ? initLocal.isError && /CPS_READ_ONLY/.test(initLocal.text) : initLocal.json?.dryRun === true);

  const connectors = await callTool("cs_list_connectors", { offline: true, search: "Office 365 Outlook" });
  check("cs_list_connectors offline seed", connectors.json?.connectors?.[0]?.name === "shared_office365", connectors.json?.source);

  if (!readOnly) {
    const fixtureSolution = path.join(here, "..", "test", "fixtures", "unpacked-solution");
    const deploy = await callTool("cs_deploy_solution", { targetEnvironment: "00000000-0000-0000-0000-000000000000", zip: "nonexistent.zip", srcFolder: fixtureSolution });
    check("cs_deploy_solution dry-run without confirm", deploy.json?.dryRun === true, deploy.json?.wouldDo?.slice(0, 60));
  }

  check("stdout carried only JSON-RPC", nonJson.length === 0, nonJson.length ? nonJson[0].slice(0, 80) : "");
} catch (err) {
  check("smoke run", false, err.message);
} finally {
  child.kill();
}
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
