import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseSolutionList, parseConnectionList, inventorySolutionFolder, summarizeInventory, applyDeploymentSettings, readDeploymentSettings, unmappedSettings, writeManifest, readManifest, componentTypeLabel } from "../dist/solutions.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("parseSolutionList reads the pac table", () => {
  const rows = parseSolutionList(
    "Listing all Solutions...\n" +
      " Unique Name                Friendly Name              Version      Managed\n" +
      " Default                    Default Solution           1.0          False\n" +
      " orc_OracleDefaultAgent     Oracle Default Agent       1.0.0.3      False\n" +
      " msdyn_ContextualHelp       Contextual Help            9.2.1.5      True\n",
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { uniqueName: "orc_OracleDefaultAgent", friendlyName: "Oracle Default Agent", version: "1.0.0.3", isManaged: false });
  assert.equal(rows[2].isManaged, true);
});

test("parseConnectionList anchors on the GUID and finds the connector", () => {
  const rows = parseConnectionList(
    "Connection ID                          Name                  Connector ID                                                   Owner\n" +
      "3f2e1d0c-1111-2222-3333-444455556666   SharePoint (jgt)      /providers/Microsoft.PowerApps/apis/shared_sharepointonline    user@contoso.com\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].connectionId, "3f2e1d0c-1111-2222-3333-444455556666");
  assert.equal(rows[0].connectorId, "shared_sharepointonline");
});

test("inventorySolutionFolder reads agents, components, flows, connection references and environment variables", () => {
  const inv = inventorySolutionFolder(join(FIXTURES, "unpacked-solution"));
  assert.equal(inv.uniqueName, "orc_OracleDefaultAgent");
  assert.equal(inv.version, "1.0");
  assert.equal(inv.managed, false);
  assert.equal(inv.publisher.prefix, "orc");
  assert.equal(inv.agents.length, 1);
  assert.equal(inv.agents[0].name, "Oracle Default Agent");
  assert.equal(inv.agents[0].authenticationMode, 2);
  assert.equal(inv.agents[0].recognizer, "GenerativeAIRecognizer");
  assert.equal(inv.agents[0].componentCount, 14);
  const topics = inv.botComponents.filter((c) => c.kind === "AdaptiveDialog");
  assert.equal(topics.length, 13);
  assert.ok(inv.botComponents.some((c) => c.kind === "GptComponentMetadata" && c.componentType === 15));
  assert.equal(inv.flows.length, 1);
  assert.equal(inv.flows[0].name, "Lookup Order");
  assert.equal(inv.flows[0].workflowId, "11111111-2222-3333-4444-555555555555");
  assert.equal(inv.flows[0].category, "Modern flow");
  assert.equal(inv.flows[0].state, "Activated");
  assert.equal(inv.connectionReferences.length, 1);
  assert.equal(inv.connectionReferences[0].logicalName, "orc_sharedsharepointonline_9d1a2");
  assert.equal(inv.connectionReferences[0].connectorId, "/providers/Microsoft.PowerApps/apis/shared_sharepointonline");
  assert.equal(inv.environmentVariables.length, 1);
  assert.equal(inv.environmentVariables[0].type, "String");
  assert.equal(inv.environmentVariables[0].defaultValue, "https://api.example.com");
  assert.equal(inv.environmentVariables[0].currentValue, "https://api.contoso.com");
  assert.deepEqual(inv.customConnectors, ["orc_MyApi"]);
  const s = summarizeInventory(inv);
  assert.equal(s.counts.agents, 1);
  assert.equal(s.agents[0].harness, "standard");
  assert.equal(s.agents[0].components.AdaptiveDialog, 13);
  assert.equal(componentTypeLabel(9), "Topic");
});

test("deployment settings apply and report unmapped entries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "settings.json");
  // Shape produced by `pac solution create-settings` 2.11.2, including the CopilotAgents section.
  writeFileSync(
    file,
    JSON.stringify({
      EnvironmentVariables: [
        { SchemaName: "orc_ApiUrl", Value: "", DefaultValue: "", Name: { Default: "API URL", ByLcid: { 1033: "API URL" } }, TypeId: 100000000, IsRequired: false },
        { SchemaName: "orc_HasDefault", Value: "", DefaultValue: "x", TypeId: 100000000, IsRequired: false },
      ],
      ConnectionReferences: [
        { LogicalName: "orc_sp", ConnectionId: "", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_sharepointonline" },
        { LogicalName: "orc_o365", ConnectionId: "", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_office365" },
      ],
      CopilotAgents: [{ AadGroupId: "00000000-0000-0000-0000-000000000000", Name: "orc_OracleDefaultAgent" }],
    }),
  );
  const before = unmappedSettings(readDeploymentSettings(file));
  assert.equal(before.connectionReferences.length, 2);
  assert.deepEqual(before.environmentVariables, ["orc_ApiUrl"]);
  assert.deepEqual(before.copilotAgentsWithoutGroup, ["orc_OracleDefaultAgent"]);
  const r = applyDeploymentSettings(file, {
    connectionReferences: { orc_sp: "3f2e1d0c-1111-2222-3333-444455556666", nope: "x" },
    environmentVariables: { orc_ApiUrl: "https://prod.example.com" },
    copilotAgents: { orc_OracleDefaultAgent: "9b9b9b9b-1111-2222-3333-444455556666" },
  });
  assert.deepEqual(r.applied, ["orc_sp", "orc_ApiUrl", "orc_OracleDefaultAgent"]);
  assert.deepEqual(r.unknown, ["nope"]);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.EnvironmentVariables[0].Name.Default, "API URL", "extra fields must survive a rewrite");
  assert.equal(written.CopilotAgents[0].AadGroupId, "9b9b9b9b-1111-2222-3333-444455556666");
  const after = unmappedSettings(readDeploymentSettings(file));
  assert.deepEqual(after.connectionReferences, ["orc_o365 (shared_office365)"]);
  assert.deepEqual(after.environmentVariables, []);
  assert.deepEqual(after.copilotAgentsWithoutGroup, []);
});

test("manifest round-trips", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mcp-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = { solution: "orc_X", sourceEnvironment: "env", pulledAt: "now", packagetype: "Both", exports: { unmanaged: "a.zip", managed: null }, srcFolder: "src", settingsFile: null, agents: [{ schemaName: "orc_X", name: "X", workspace: null, cloneError: null }] };
  writeManifest(dir, m);
  assert.deepEqual(readManifest(dir), m);
  assert.equal(readManifest(join(dir, "missing")), null);
});
