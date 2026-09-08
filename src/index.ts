#!/usr/bin/env node
/**
 * copilot-studio-mcp: MCP server for Microsoft Copilot Studio agent development.
 *
 * Three layers behind one tool list:
 *  - sync: pac copilot / solution / admin, run as a child process
 *  - authoring: YAML files in the workspace, validated against the schema
 *  - cloud: Power Platform API, Dataverse, BAP, Power Automate, DirectLine
 *
 * Every call that mutates a live environment takes `confirm: true`; without it
 * the tool returns a dry run for the calling agent to put to the user. The
 * tools live in `tools/`, one module per area, and `tools/shared.ts` holds the
 * server instance, the registration gates and what those modules have in
 * common. This file only wires them together, in tool-list order, and starts
 * the transport.
 *
 * stdout is the MCP transport. All diagnostics go through `log()` to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findPac } from "./pac.js";
import { errorMessage, log } from "./log.js";
import { VERSION, server, skippedTools, withheldTools } from "./tools/shared.js";
import { activePreset } from "./toolFilter.js";

// Imported for their registrations; this order is the order of tools/list.
import "./tools/session.js";
import "./tools/environments.js";
import "./tools/sync.js";
import "./tools/flows.js";
import "./tools/tenant.js";
import "./tools/guidance.js";
import "./tools/pacWrappers.js";
import "./tools/authoring.js";
import "./tools/dayTwo.js";
import "./tools/catalog.js";
import "./tools/evaluations.js";
import "./tools/transcripts.js";
import "./tools/chat.js";
import "./tools/solutions.js";
import "./tools/jobs.js";
import "./tools/compare.js";

// A crash shows up in MCP clients as a broken pipe with no explanation. Log and keep serving;
// the affected call fails on its own and every other tool stays reachable.
process.on("uncaughtException", (err) => log(`uncaught exception (server kept running): ${errorMessage(err)}`));
process.on("unhandledRejection", (reason) => log(`unhandled rejection (server kept running): ${errorMessage(reason)}`));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`copilot-studio-mcp ${VERSION} ready (pac: ${findPac() ?? "not found"})`);
  if (withheldTools.length) log(`read-only mode (CPS_READ_ONLY): ${withheldTools.length} environment-changing tool(s) not registered`);
  const preset = activePreset();
  if (skippedTools.length) log(`tool filter${preset ? ` (preset ${preset})` : ""}: ${skippedTools.length} tool(s) hidden by CPS_TOOLS / CPS_TOOLS_EXCLUDE`);
}

main().catch((err) => {
  log(`fatal: ${errorMessage(err)}`);
  process.exit(1);
});
