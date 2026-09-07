import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { PAC_COMMANDS, buildPacArgs, describeSpec, isMutating, redactArgs, secretValues, zodShapeFor } from "../dist/pacCommands.js";
import { parsePatterns, toolEnabled } from "../dist/toolFilter.js";

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
  assert.equal(toolEnabled("cs_push", { CPS_TOOLS: "cs_doctor, cs_describe_workspace" }), false);
  assert.equal(toolEnabled("cs_doctor", { CPS_TOOLS: "cs_doctor, cs_describe_workspace" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "cs_add_*,cs_edit_*" }), true);
  assert.equal(toolEnabled("cs_add_topic", { CPS_TOOLS: "cs_add_*", CPS_TOOLS_EXCLUDE: "*topic" }), false);
  assert.equal(toolEnabled("cs_deploy_pipeline", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), false);
  assert.equal(toolEnabled("cs_env_who", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), false);
  assert.equal(toolEnabled("cs_pull", { CPS_TOOLS_EXCLUDE: "cs_*_pipeline,cs_env_*" }), true);
  assert.equal(parsePatterns(undefined).length, 0);
  assert.equal(parsePatterns("cs.push")[0].test("csXpush"), false, "dots are literal");
});
