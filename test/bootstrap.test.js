import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { solutionXml, writeEmptySolutionSource, buildInstructionsBrief, cleanPredictOutput, validatePrefix } from "../dist/bootstrap.js";
import { inventorySolutionFolder } from "../dist/solutions.js";
import { findPac, dotnetRootDefault } from "../dist/pac.js";

test("solutionXml carries unique name, display name and publisher prefix", () => {
  const xml = solutionXml({ uniqueName: "orc_Agents", displayName: "Agents & Co", publisherPrefix: "orc", version: "1.0.0.0", optionValuePrefix: 12345 });
  assert.match(xml, /<UniqueName>orc_Agents<\/UniqueName>/);
  assert.match(xml, /LocalizedName description="Agents &amp; Co"/);
  assert.match(xml, /<CustomizationPrefix>orc<\/CustomizationPrefix>/);
  assert.match(xml, /<CustomizationOptionValuePrefix>12345<\/CustomizationOptionValuePrefix>/);
  assert.throws(() => solutionXml({ uniqueName: "1bad", publisherPrefix: "orc" }), /uniqueName/);
  assert.throws(() => validatePrefix("TooLongPrefix"), /publisherPrefix/);
});

test("writeEmptySolutionSource produces a folder the inventory parser reads and pac can pack", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-sol-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "src");
  writeEmptySolutionSource(src, { uniqueName: "orc_Empty", displayName: "Empty", publisherPrefix: "orc" });
  const inv = inventorySolutionFolder(src);
  assert.equal(inv.uniqueName, "orc_Empty");
  assert.equal(inv.friendlyName, "Empty");
  assert.equal(inv.publisher.prefix, "orc");
  assert.equal(inv.agents.length, 0);
  const pac = findPac();
  if (!pac) {
    t.diagnostic("pac not installed; skipping pack check");
    return;
  }
  const zip = join(dir, "orc_Empty.zip");
  execFileSync(pac, ["solution", "pack", "--zipfile", zip, "--folder", src, "--packagetype", "Unmanaged"], { env: { ...process.env, ...dotnetRootDefault() }, stdio: "pipe", timeout: 120_000 });
  assert.ok(existsSync(zip), "pac solution pack produced the zip");
});

test("buildInstructionsBrief covers the brief and the refine mode", () => {
  const brief = buildInstructionsBrief({ purpose: "Help employees with IT tickets", audience: "Employees", tone: "Friendly", boundaries: ["never reset passwords"], capabilities: ["ServiceNow tickets tool"], examples: ["my laptop is slow"] });
  assert.match(brief, /PURPOSE: Help employees with IT tickets/);
  assert.match(brief, /- never reset passwords/);
  assert.match(brief, /- ServiceNow tickets tool/);
  assert.match(brief, /Return only the instructions/);
  const refine = buildInstructionsBrief({ purpose: "", currentInstructions: "You help with IT.", changeRequest: "Add escalation to a human after two failed answers." });
  assert.match(refine, /CURRENT INSTRUCTIONS:\nYou help with IT\./);
  assert.match(refine, /CHANGE REQUEST:/);
});

test("cleanPredictOutput strips the pac banner and keeps the model text", () => {
  const raw = "Microsoft PowerPlatform CLI\r\nVersion: 2.11.2+g47bc199 (.NET 10.0.11)\r\nOnline documentation: https://aka.ms/PowerPlatformCLI\r\nFeedback, Suggestions, Issues: https://github.com/x\r\nConnected as user@contoso.com\r\nConnected to... Contoso\r\n\r\nYou are the IT helpdesk agent.\r\n- Be brief.\r\n";
  assert.equal(cleanPredictOutput(raw), "You are the IT helpdesk agent.\n- Be brief.");
});
