import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONDITIONAL_WRITE_TOOLS, ENVIRONMENT_WRITE_TOOLS, LOCAL_DESTRUCTIVE_TOOLS, hiddenByReadOnly, readOnlyMode, readOnlyRefusal } from "../dist/policy.js";
import { PAC_COMMANDS } from "../dist/pacCommands.js";

const indexJs = readFileSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)), "utf8");

/** Bespoke tools whose input schema declares `confirm`, read from the built server. */
function toolsDeclaringConfirm() {
  const names = new Set();
  for (const part of indexJs.split(/registerTool\(/).slice(1)) {
    const m = /^\s*"(cs_[a-z_]+)"/.exec(part);
    if (!m) continue;
    const body = part.slice(0, 6000);
    if (/confirm:\s*confirmArg/.test(body)) names.add(m[1]);
  }
  return names;
}

test("every tool that asks for confirmation is classified in the policy", () => {
  const declared = toolsDeclaringConfirm();
  assert.ok(declared.size >= 10, `expected the bespoke mutating tools, found ${declared.size}`);
  const classified = new Set([...ENVIRONMENT_WRITE_TOOLS, ...CONDITIONAL_WRITE_TOOLS, ...LOCAL_DESTRUCTIVE_TOOLS]);
  for (const name of declared) {
    assert.ok(classified.has(name), `'${name}' takes confirm but policy.ts does not classify it as an always-writing, conditionally-writing or local-destructive tool`);
  }
  assert.ok(!ENVIRONMENT_WRITE_TOOLS.has("cs_pac") && CONDITIONAL_WRITE_TOOLS.has("cs_pac"), "cs_pac stays registered and gates itself, so read-only pac commands keep working");
});

test("the environment-write list covers the pac wrappers that mutate, and nothing that does not", () => {
  for (const spec of PAC_COMMANDS) {
    assert.equal(ENVIRONMENT_WRITE_TOOLS.has(spec.tool), spec.mutating === true, `${spec.tool} always-writes?`);
    assert.equal(CONDITIONAL_WRITE_TOOLS.has(spec.tool), typeof spec.mutating === "function", `${spec.tool} conditionally-writes?`);
  }
  for (const name of ["cs_check_solution", "cs_merge_translations", "cs_solution_online_version", "cs_init_agent"]) {
    assert.ok(CONDITIONAL_WRITE_TOOLS.has(name), `${name} writes only for some inputs and must stay usable in read-only mode`);
    assert.ok(!ENVIRONMENT_WRITE_TOOLS.has(name));
  }
  for (const name of ["cs_push", "cs_publish", "cs_deploy_solution", "cs_run_evaluation", "cs_import_solution", "cs_delete_agent", "cs_delete_solution", "cs_create_solution", "cs_deploy_pipeline", "cs_create_connection", "cs_quarantine_agent"]) {
    assert.ok(ENVIRONMENT_WRITE_TOOLS.has(name), `${name} must be an environment write`);
  }
  for (const name of ["cs_validate", "cs_add_topic", "cs_edit_tool", "cs_describe_workspace", "cs_check_drift", "cs_review_agent", "cs_guide", "cs_pull", "cs_clone_agent", "cs_env_list"]) {
    assert.ok(!ENVIRONMENT_WRITE_TOOLS.has(name), `${name} does not change an environment and must stay available in read-only mode`);
  }
});

test("read-only mode is off by default and recognises the usual switches", () => {
  assert.equal(readOnlyMode({}), false);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "" }), false);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "0" }), false);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "false" }), false);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "no" }), false);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "1" }), true);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "true" }), true);
  assert.equal(readOnlyMode({ CPS_READ_ONLY: "yes" }), true);
  assert.deepEqual(hiddenByReadOnly({}), []);
  assert.equal(hiddenByReadOnly({ CPS_READ_ONLY: "1" }).length, ENVIRONMENT_WRITE_TOOLS.size);
  assert.match(readOnlyRefusal("pac solution import"), /CPS_READ_ONLY.*pac solution import/s);
});

test("the confirm contract is visible in every environment-write tool description", () => {
  for (const part of indexJs.split(/registerTool\(/).slice(1)) {
    const m = /^\s*"(cs_[a-z_]+)"/.exec(part);
    if (!m || !(ENVIRONMENT_WRITE_TOOLS.has(m[1]) || CONDITIONAL_WRITE_TOOLS.has(m[1]))) continue;
    const body = part.slice(0, 6000);
    assert.match(body, /confirm/i, `${m[1]} must mention confirm in its description or schema`);
  }
});
