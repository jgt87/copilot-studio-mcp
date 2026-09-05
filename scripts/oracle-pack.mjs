#!/usr/bin/env node
/**
 * Offline acceptance check: scaffold a workspace with `pac copilot init`,
 * add one of every component the authoring layer can write, then run
 * `pac copilot pack`. Pack validates the workspace layout locally, so a
 * green run means the generated files are at least structurally accepted.
 *
 * Usage: node scripts/oracle-pack.mjs [scratchDir]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { findPac, dotnetRootDefault } from "../dist/pac.js";
import { addTopic } from "../dist/authoring/topics.js";
import { addKnowledgeSource } from "../dist/authoring/knowledge.js";
import { addTool } from "../dist/authoring/tools.js";
import { scaffoldFlow } from "../dist/authoring/flows.js";
import { addTrigger } from "../dist/authoring/triggers.js";
import { addGlobalVariable } from "../dist/authoring/variables.js";
import { updateAgent } from "../dist/authoring/agent.js";
import { readWorkspace } from "../dist/workspace.js";

const pac = findPac();
if (!pac) {
  console.error("pac not found");
  process.exit(2);
}
const env = { ...process.env, ...dotnetRootDefault(), PAC_CLI_TELEMETRY_OPTOUT: "1" };
const scratch = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "cs-mcp-oracle-"));
fs.mkdirSync(scratch, { recursive: true });

function run(args, cwd) {
  const r = spawnSync(pac, args, { cwd, env, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function packOf(root, label) {
  const out = path.join(scratch, `out-${label}`);
  fs.rmSync(out, { recursive: true, force: true });
  const r = run(["copilot", "pack", "--publisher-prefix", "orc", "--project-dir", root, "--output-path", out], scratch);
  const lines = r.out.split(/\r?\n/).filter((l) => l.trim());
  const unsupported = /Unsupported (directory|file)/.test(r.out);
  console.log(`\n=== pack ${label}: ${r.ok ? "OK" : unsupported ? "REJECTED BY PACK LAYOUT (expected: pack only packages topics; push handles the rest)" : "FAILED (" + r.code + ")"} ===`);
  console.log(lines.slice(-6).join("\n"));
  return r.ok ? "pack-ok" : unsupported ? "pack-layout-unsupported" : "pack-FAILED";
}

/** Remove folders pack cannot package so later steps still exercise pack on topics. */
function pruneUnsupported(root) {
  for (const d of ["knowledge", "actions", "tools", "trigger", "variables", "workflows"]) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  for (const f of ["connectionreferences.mcs.yml"]) fs.rmSync(path.join(root, f), { force: true });
}

const root = path.join(scratch, "agent");
fs.rmSync(root, { recursive: true, force: true });
const init = run(["copilot", "init", "--name", "Oracle Agent", "--publisher-prefix", "orc", "--project-dir", root], scratch);
if (!init.ok) {
  console.error(init.out);
  process.exit(1);
}
console.log("scaffolded", root);
const ws = readWorkspace(root);
const schema = ws.schemaName;
console.log("schemaName", schema, "harness", ws.harness);

const steps = [
  ["baseline", () => undefined],
  [
    "topic",
    () =>
      addTopic(root, {
        name: "Order Status",
        description: "Looks up an order",
        trigger: { kind: "phrases", phrases: ["where is my order", "track my order"] },
        agentSchemaName: schema,
        actions: [
          { type: "message", text: "Let me check." },
          { type: "question", prompt: "Order number?", variable: "OrderNumber", entity: "Number" },
          { type: "question", prompt: "Region?", variable: "Region", choices: ["EU", "US"] },
          { type: "condition", cases: [{ condition: 'Topic.Region = "EU"', actions: [{ type: "message", text: "EU" }] }], else: [{ type: "redirect", topic: "Escalate" }] },
          { type: "searchKnowledge" },
          { type: "end" },
        ],
      }),
  ],
  ["instructions", () => updateAgent(root, { instructions: "You help customers track orders. Be brief." })],
  ["knowledge-public", () => addKnowledgeSource(root, { name: "Public Docs", kind: "public-site", site: "https://learn.microsoft.com/microsoft-copilot-studio" })],
  ["knowledge-sharepoint", () => addKnowledgeSource(root, { name: "HR Policies", kind: "sharepoint", site: "https://contoso.sharepoint.com/sites/HR/Shared%20Documents/Policies" })],
  ["knowledge-file", () => {
    const f = path.join(scratch, "faq.txt");
    fs.writeFileSync(f, "Q: hours? A: 9-5");
    return addKnowledgeSource(root, { name: "FAQ", kind: "files", files: [f] });
  }],
  ["tool-connector", () => addTool(root, { type: "connector", name: "Send Email", description: "Sends an email", connectorId: "shared_office365", operationId: "SendEmailV2", inputs: [{ kind: "automatic", name: "To", description: "recipient", entity: "Email" }] }, schema)],
  ["tool-mcp", () => addTool(root, { type: "mcp", name: "Learn MCP", description: "Search docs", connectorId: "shared_microsoftlearndocsmcpserver" }, schema)],
  ["variable", () => addGlobalVariable(root, { name: "User Region", defaultValue: "EU", agentSchemaName: schema })],
  ["flow", () => scaffoldFlow(root, { name: "Lookup Order", inputs: [{ name: "OrderNumber", type: "number" }], outputs: [{ name: "Status" }] })],
  ["tool-flow", () => {
    const meta = readWorkspace(root).workflows[0]?.metadata;
    return addTool(root, { type: "flow", name: "Lookup Order Tool", description: "Runs the lookup flow", flowId: meta?.workflowId ?? "00000000-0000-0000-0000-000000000001" }, schema);
  }],
  ["trigger", () => addTrigger(root, { name: "New Ticket", flowId: "00000000-0000-0000-0000-000000000002" })],
];

const results = [];
for (const [label, fn] of steps) {
  try {
    const r = fn();
    if (r) console.log(`\n--- ${label}: wrote ${JSON.stringify(r.file ?? r.files ?? r.dir ?? r)}`);
  } catch (err) {
    console.log(`\n--- ${label}: authoring error ${err.message}`);
    results.push([label, "authoring-error"]);
    continue;
  }
  const outcome = packOf(root, label);
  results.push([label, outcome]);
  if (outcome === "pack-layout-unsupported") pruneUnsupported(root);
}
console.log("\n=== summary ===");
for (const [l, s] of results) console.log(`${s.padEnd(12)} ${l}`);
console.log("scratch:", scratch);
