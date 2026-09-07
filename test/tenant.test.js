import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backupTenant, parseAdminEnvironments, summarizeBackup } from "../dist/tenantBackup.js";
import { PAC_COMMANDS, buildPacArgs, isAdminCommand, zodShapeFor } from "../dist/pacCommands.js";
import { ENVIRONMENT_WRITE_TOOLS } from "../dist/policy.js";

const ADMIN_LIST = `Environment Name          Environment Id                          Type        URL
[1] Contoso Dev           11111111-1111-1111-1111-111111111111    Sandbox     https://dev.crm.dynamics.com/
[2] Contoso Prod          22222222-2222-2222-2222-222222222222    Production  https://prod.crm.dynamics.com/`;

const DLP_LIST = "Policy Name                 Policy Id\nBlock risky connectors      33333333-3333-3333-3333-333333333333";

// The two-GUID column layout pac 2.11.2 prints, which parseCopilotList anchors on.
const COPILOT_LIST =
  "Name                     Bot ID                               Component State Is Managed Solution ID                          Status Code State Code\n" +
  "Helpdesk                 44444444-4444-4444-4444-444444444444 Published       Unmanaged  55555555-5555-5555-5555-555555555555 Active      Provisioned\n";

/** A pac stand-in: answers per command, records what was asked, and can fail on cue. */
function fakePac({ fail = [], write = {} } = {}) {
  const calls = [];
  const runner = async (args) => {
    const key = args.join(" ");
    calls.push(key);
    if (fail.some((f) => key.startsWith(f))) return { ok: false, code: 1, command: `pac ${key}`, stdout: "", stderr: "Access denied: you need the Power Platform Administrator role", durationMs: 1 };
    let stdout = `ran ${key}`;
    if (key.startsWith("admin list ")) stdout = ADMIN_LIST;
    else if (key === "admin list") stdout = ADMIN_LIST;
    else if (key.startsWith("admin dlp-policy list")) stdout = DLP_LIST;
    else if (key.startsWith("copilot list")) stdout = COPILOT_LIST;
    for (const [prefix, writer] of Object.entries(write)) if (key.startsWith(prefix)) writer(args);
    return { ok: true, code: 0, command: `pac ${key}`, stdout, stderr: "", durationMs: 1 };
  };
  runner.calls = calls;
  return runner;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "cs-tenant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

test("parseAdminEnvironments reads id, name and url from the admin list", () => {
  const envs = parseAdminEnvironments(ADMIN_LIST);
  assert.equal(envs.length, 2);
  assert.equal(envs[0].id, "11111111-1111-1111-1111-111111111111");
  assert.match(envs[0].name, /Contoso Dev/);
  assert.equal(envs[0].url, "https://dev.crm.dynamics.com/");
  assert.deepEqual(parseAdminEnvironments("nothing here"), []);
});

test("backupTenant captures the tenant level and every environment, and parses what it can", async (t) => {
  const dir = tempDir(t);
  const { writeFileSync } = await import("node:fs");
  const run = fakePac({ write: { "admin list-tenant-settings": (args) => writeFileSync(args[args.indexOf("--settings-file") + 1], '{"powerPlatform":{"search":{}}}') } });
  const report = await backupTenant({ dir, run, dataverse: async (env) => ({ bots: [{ botId: "b1", name: `Bot in ${env.id}` }], flows: [] }), now: new Date("2026-09-07T09:00:00Z") });

  assert.equal(report.takenAt, "2026-09-07T09:00:00.000Z");
  assert.ok(existsSync(join(dir, "backup.json")), "a manifest is written");
  assert.ok(existsSync(join(dir, "tenant", "tenant-settings.json")), "pac writes the settings file, and the backup keeps it");
  assert.ok(existsSync(join(dir, "tenant", "environments.txt")));
  assert.ok(existsSync(join(dir, "tenant", "dlp-policies", "33333333-3333-3333-3333-333333333333.txt")), "each DLP policy is detailed");

  const captured = report.tenant.filter((c) => c.ok).map((c) => c.name);
  for (const name of ["tenant-settings", "environments", "environment-groups", "service-principals", "entra-applications", "app-templates", "dlp-policies"]) {
    assert.ok(captured.includes(name), `${name} missing from ${captured.join(", ")}`);
  }

  assert.equal(report.environments.length, 2, "both environments from the admin list");
  const first = report.environments[0];
  assert.ok(existsSync(join(first.dir, "environment.json")));
  assert.ok(existsSync(join(first.dir, "agents.json")), "agents are parsed into rows, not only raw text");
  assert.equal(JSON.parse(readFileSync(join(first.dir, "agents.json"), "utf8"))[0].name, "Helpdesk");
  assert.equal(JSON.parse(readFileSync(join(first.dir, "dataverse.json"), "utf8")).bots[0].name, "Bot in 11111111-1111-1111-1111-111111111111");
  assert.ok(run.calls.includes("solution list --environment https://dev.crm.dynamics.com/"), run.calls.join(" | "));
  assert.ok(run.calls.some((c) => c.startsWith("admin list-roles")) && run.calls.some((c) => c.startsWith("admin list-backups")));
  assert.ok(report.files > 15, `${report.files} files`);
});

test("a capture the account may not run is reported, and the rest of the backup still completes", async (t) => {
  const dir = tempDir(t);
  const run = fakePac({ fail: ["admin list-tenant-settings", "admin dlp-policy list"] });
  const report = await backupTenant({ dir, run, dataverse: null, maxEnvironments: 1 });
  const summary = summarizeBackup(report);
  assert.ok(summary.skipped.some((s) => /tenant-settings.*Access denied/.test(s)), JSON.stringify(summary.skipped));
  assert.ok(summary.skipped.some((s) => /dlp-policies/.test(s)));
  assert.ok(summary.tenantCaptures.includes("service-principals"), "unrelated captures still ran");
  assert.equal(report.environments.length, 1, "maxEnvironments is honoured");
  assert.ok(report.notes.some((n) => /2 environments found/.test(n)));
  assert.ok(existsSync(join(dir, "backup.json")));
});

test("tenant level only, and explicit environments", async (t) => {
  const dir = tempDir(t);
  const run = fakePac();
  const report = await backupTenant({ dir, run, includeEnvironments: false, dataverse: null });
  assert.equal(report.environments.length, 0);
  assert.ok(!run.calls.some((c) => c.startsWith("solution list")), "no per-environment work");

  const dir2 = tempDir(t);
  const run2 = fakePac();
  const r2 = await backupTenant({ dir: dir2, run: run2, environments: [{ id: "e1", name: "Only One" }], includeRoles: false, includeBackups: false, dataverse: null });
  assert.deepEqual(r2.environments.map((e) => e.name), ["Only One"]);
  assert.ok(!run2.calls.some((c) => c.startsWith("admin list-roles")), "includeRoles false");
  assert.ok(!run2.calls.some((c) => c.startsWith("admin list-backups")), "includeBackups false");
});

test("the admin commands are wrapped, classified and take a profile", () => {
  const admin = PAC_COMMANDS.filter(isAdminCommand);
  assert.ok(admin.length >= 25, `${admin.length} admin commands wrapped`);
  const names = admin.map((s) => s.tool);
  for (const expected of ["cs_admin_list_environments", "cs_admin_list_tenant_settings", "cs_admin_update_tenant_settings", "cs_admin_list_dlp_policies", "cs_admin_show_dlp_policy", "cs_admin_list_security_roles", "cs_admin_assign_user", "cs_admin_create_environment", "cs_admin_delete_environment", "cs_admin_set_governance_config", "cs_admin_query"]) {
    assert.ok(names.includes(expected), `${expected} missing`);
  }
  // Reading tenant configuration never needs confirmation; changing it always does.
  for (const name of ["cs_admin_list_environments", "cs_admin_list_tenant_settings", "cs_admin_list_dlp_policies", "cs_admin_list_security_roles", "cs_admin_list_backups", "cs_admin_query"]) {
    assert.ok(!ENVIRONMENT_WRITE_TOOLS.has(name), `${name} is read-only`);
  }
  for (const name of ["cs_admin_update_tenant_settings", "cs_admin_delete_environment", "cs_admin_reset_environment", "cs_admin_restore_environment", "cs_admin_copy_environment", "cs_admin_assign_user", "cs_admin_set_governance_config", "cs_admin_self_elevate"]) {
    assert.ok(ENVIRONMENT_WRITE_TOOLS.has(name), `${name} must require confirmation`);
  }
  for (const spec of PAC_COMMANDS) assert.ok("profile" in zodShapeFor(spec), `${spec.tool} must accept a profile`);
  assert.deepEqual(buildPacArgs(PAC_COMMANDS.find((s) => s.tool === "cs_admin_show_dlp_policy"), { policyName: "p1" }), ["admin", "dlp-policy", "show", "--policy-name", "p1"]);
  assert.deepEqual(buildPacArgs(PAC_COMMANDS.find((s) => s.tool === "cs_admin_set_governance_config"), { environment: "e1", protectionLevel: "Standard", disableGroupSharing: true }), ["admin", "set-governance-config", "--environment", "e1", "--protection-level", "Standard", "--disable-group-sharing"]);
  assert.throws(() => buildPacArgs(PAC_COMMANDS.find((s) => s.tool === "cs_admin_set_governance_config"), { environment: "e1", protectionLevel: "Loose" }), /must be one of Standard, Basic/);
});
