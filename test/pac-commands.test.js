import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { PAC_COMMANDS, buildPacArgs, describeSpec, isMutating, redactArgs, secretValues, zodShapeFor } from "../dist/pacCommands.js";
import { activePreset, parsePatterns, toolEnabled } from "../dist/toolFilter.js";

const spec = (tool) => {
  const s = PAC_COMMANDS.find((x) => x.tool === tool);
  if (!s) throw new Error(`no spec ${tool}`);
  return s;
};

test("every spec is well formed and tool names are unique", () => {
  const names = new Set();
  for (const s of PAC_COMMANDS) {
    assert.match(s.tool, /^cs_[a-z_]+$/, s.tool);
    assert.ok(!names.has(s.tool), `duplicate ${s.tool}`);
    names.add(s.tool);
    assert.ok(s.command.length >= 1 && s.command.length <= 3, s.tool); // admin dlp-policy list has three segments
    for (const [key, p] of Object.entries(s.params)) {
      assert.match(p.flag, /^--[A-Za-z-]+$/, `${s.tool}.${key}`);
      assert.ok(p.description.length > 5, `${s.tool}.${key} description`);
    }
    assert.match(describeSpec(s), new RegExp(`pac ${s.command.join(" ")}`));
  }
  assert.ok(PAC_COMMANDS.length >= 29, `${PAC_COMMANDS.length} specs`);
});

test("buildPacArgs maps params to flags in spec order and skips absent optionals", () => {
  const args = buildPacArgs(spec("cs_extract_agent_template"), { bot: "contoso_HelpDesk", templateFile: "C:/tmp/helpdesk.yml", overwrite: true, templateVersion: "" });
  assert.deepEqual(args, ["copilot", "extract-template", "--bot", "contoso_HelpDesk", "--templateFileName", "C:/tmp/helpdesk.yml", "--overwrite"]);
  assert.throws(() => buildPacArgs(spec("cs_extract_agent_template"), { bot: "x" }), /'templateFile' is required \(--templateFileName\)/);
  assert.throws(() => buildPacArgs(spec("cs_extract_translations"), { format: "xml" }), /must be one of resx, json/);
  assert.deepEqual(buildPacArgs(spec("cs_extract_translations"), { environment: "env-1", format: "json", all: true, overwrite: false }), ["copilot", "extract-translation", "--environment", "env-1", "--format", "json", "--all"]);
});

test("boolstring, repeated and comma-joined lists, numbers", () => {
  assert.deepEqual(buildPacArgs(spec("cs_quarantine_agent"), { botId: "b1", quarantine: false }), ["copilot", "quarantine", "--bot-id", "b1", "--status", "false"]);
  assert.deepEqual(buildPacArgs(spec("cs_quarantine_agent"), { botId: "b1", quarantine: true }), ["copilot", "quarantine", "--bot-id", "b1", "--status", "true"]);
  assert.deepEqual(buildPacArgs(spec("cs_merge_translations"), { files: ["a.resx", "b.resx"], whatIf: true }), ["copilot", "merge-translation", "--file", "a.resx", "--file", "b.resx", "--whatif"]);
  assert.throws(() => buildPacArgs(spec("cs_merge_translations"), { files: [] }), /files/);
  assert.deepEqual(buildPacArgs(spec("cs_check_solution"), { path: "out/*.zip", excludedFiles: ["a.js", "b.js"] }), ["solution", "check", "--path", "out/*.zip", "--excludedFiles", "a.js,b.js"]);
  assert.deepEqual(buildPacArgs(spec("cs_clone_solution"), { name: "Sol", maxAsyncWaitTime: 15, async: true, packageType: "Managed" }), ["solution", "clone", "--name", "Sol", "--packagetype", "Managed", "--async", "--max-async-wait-time", "15"]);
  assert.deepEqual(buildPacArgs(spec("cs_select_auth_profile"), { index: 2 }), ["auth", "select", "--index", "2"]);
  assert.deepEqual(buildPacArgs(spec("cs_auth_who"), {}), ["auth", "who"]);
});

test("secrets are collected and masked", () => {
  const s = spec("cs_create_connection");
  const input = { tenantId: "t", name: "SP", applicationId: "app", clientSecret: "s3cr3t-value" };
  const args = buildPacArgs(s, input);
  assert.ok(args.includes("s3cr3t-value"));
  assert.deepEqual(secretValues(s, input), ["s3cr3t-value"]);
  const shown = redactArgs(args, secretValues(s, input));
  assert.ok(!shown.includes("s3cr3t-value") && shown.includes("***"));
  assert.deepEqual(secretValues(spec("cs_create_auth_profile"), { applicationId: "a", clientSecret: "x", certificatePassword: "y" }), ["x", "y"]);
  assert.deepEqual(redactArgs(["auth", "who"], []), ["auth", "who"]);
});

test("mutation is decided per spec, and per input where it depends on it", () => {
  assert.equal(isMutating(spec("cs_deploy_pipeline"), {}), true);
  assert.equal(isMutating(spec("cs_env_list"), {}), false);
  assert.equal(isMutating(spec("cs_solution_online_version"), { solutionName: "S" }), false);
  assert.equal(isMutating(spec("cs_solution_online_version"), { solutionName: "S", solutionVersion: "1.2.0.0" }), true);
  assert.equal(isMutating(spec("cs_merge_translations"), { files: ["a"], whatIf: true }), false);
  assert.equal(isMutating(spec("cs_merge_translations"), { files: ["a"] }), true);
  assert.equal(isMutating(spec("cs_check_solution"), { path: "x" }), false);
  assert.equal(isMutating(spec("cs_check_solution"), { path: "x", saveResults: true }), true);
});

test("zodShapeFor builds a schema with required params, cwd/timeout and confirm only where it can mutate", () => {
  const deploy = z.object(zodShapeFor(spec("cs_deploy_pipeline")));
  assert.ok("confirm" in deploy.shape && "cwd" in deploy.shape && "timeoutSeconds" in deploy.shape);
  assert.equal(deploy.safeParse({ solutionName: "S", stageId: "st", currentVersion: "1", newVersion: "2" }).success, true);
  assert.equal(deploy.safeParse({ solutionName: "S" }).success, false, "required stageId/currentVersion/newVersion");
  const who = z.object(zodShapeFor(spec("cs_auth_who")));
  assert.ok(!("confirm" in who.shape));
  const tr = z.object(zodShapeFor(spec("cs_extract_translations")));
  assert.equal(tr.safeParse({ format: "xml" }).success, false, "enum enforced by the schema");
  assert.equal(tr.safeParse({ format: "json" }).success, true);
  assert.match(z.object(zodShapeFor(spec("cs_create_connection"))).shape.clientSecret.description, /masked/);
});

test("tool filter: allow-list with wildcards, then deny-list", () => {
  assert.equal(toolEnabled("cs_push", {}), true);
  assert.equal(toolEnabled("cs_push", { CPS_TOOLS: "cs_init, cs_describe_workspace" }), false);
  assert.equal(toolEnabled("cs_init", { CPS_TOOLS: "cs_init, cs_describe_workspace" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "cs_add_*,cs_edit_*" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "cs_add_*", CPS_TOOLS_EXCLUDE: "*topic" }), false);
  assert.equal(toolEnabled("cs_deploy_pipeline", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), false);
  assert.equal(toolEnabled("cs_env_who", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), false);
  assert.equal(toolEnabled("cs_pull", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), true);
  assert.equal(parsePatterns(undefined).length, 0);
  assert.equal(parsePatterns("cs.push")[0].test("csXpush"), false, "dots are literal");
});

test("every pac wrapper takes background, and auth create is marked interactive", () => {
  const create = PAC_COMMANDS.find((s) => s.tool === "cs_create_auth_profile");
  assert.ok(create, "cs_create_auth_profile should exist");
  assert.equal(create.interactive, true, "interactive sign-in must be flagged so the schema says how to run it");

  for (const spec of PAC_COMMANDS) {
    assert.ok(zodShapeFor(spec).background, `${spec.tool} should accept background`);
  }
  assert.match(zodShapeFor(create).background.description, /sign-in/i);
});

test("cs_create_auth_profile builds the admin sign-in argv", () => {
  const spec = PAC_COMMANDS.find((s) => s.tool === "cs_create_auth_profile");
  assert.deepEqual(buildPacArgs(spec, { name: "admin", environment: "https://contoso.crm4.dynamics.com" }), ["auth", "create", "--name", "admin", "--environment", "https://contoso.crm4.dynamics.com"]);
  // background is ours, not pac's: it must never reach the command line.
  assert.deepEqual(buildPacArgs(spec, { name: "admin", background: true }), ["auth", "create", "--name", "admin"]);
});

test("tool presets: default exposes everything, core is a strict subset, admin keeps the admin tools", () => {
  const all = [...PAC_COMMANDS.map((s) => s.tool), "cs_init", "cs_push", "cs_add_topic", "cs_chat", "cs_backup_tenant", "cs_job_status", "cs_list_transcripts", "cs_pac"];

  // No CPS_TOOLS means no filtering at all: presets must never shrink the default.
  for (const name of all) assert.equal(toolEnabled(name, {}), true, `${name} should be registered by default`);

  const core = all.filter((n) => toolEnabled(n, { CPS_TOOLS: "core" }));
  assert.ok(core.includes("cs_push") && core.includes("cs_add_topic") && core.includes("cs_chat"));
  assert.ok(core.includes("cs_pac"), "cs_pac must stay: it is the escape hatch for what core hides");
  assert.ok(!core.includes("cs_backup_tenant"), "core should not carry the tenant tools");
  assert.ok(core.length < all.length, "core must be a strict subset");

  // The admin account still gets every admin tool.
  assert.equal(toolEnabled("cs_admin_list_environments", { CPS_TOOLS: "admin" }), true);
  assert.equal(toolEnabled("cs_backup_tenant", { CPS_TOOLS: "admin" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "admin" }), false);

  // Presets compose with globs and with each other.
  assert.equal(toolEnabled("cs_admin_list_environments", { CPS_TOOLS: "core,cs_admin_*" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "core,admin" }), true);

  // An unknown name is treated as a literal tool name, not silently as "everything".
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "notapreset" }), false);
  assert.equal(activePreset({ CPS_TOOLS: "core" }), "core");
  assert.equal(activePreset({ CPS_TOOLS: "cs_add_*" }), null);
  assert.equal(activePreset({}), null);
});
