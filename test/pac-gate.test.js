/**
 * The decisions src/tools/sync.ts makes before it runs anything.
 *
 * cs_pac decides whether the command only reads (so it needs no confirm and
 * survives CPS_READ_ONLY) and which pac auth profile runs it; cs_create_agent
 * decides whether an input reaches a live environment at all. All three used to
 * be inline expressions in their handlers. These are the cases that decide
 * whether a write can slip through without approval.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentGate, defaultPacProfile, isReadOnlyPac } from "../dist/tools/sync.js";

const READ_ONLY = [
  ["help"],
  ["--version"],
  ["-v"],
  ["auth", "list"],
  ["auth", "who"],
  ["org", "who"],
  ["org", "list"],
  ["org", "fetch"],
  ["env", "list"],
  ["env", "who"],
  ["env", "fetch"],
  ["copilot", "list"],
  ["copilot", "status"],
  ["copilot", "model", "list"],
  ["solution", "list"],
  ["solution", "version"],
  ["admin", "list"],
  ["admin", "list-tenant-settings"],
  ["admin", "status"],
  ["connection", "list"],
  ["connector", "list"],
  ["pipeline", "list"],
];

const MUTATING = [
  ["solution", "import", "--path", "x.zip"],
  ["solution", "delete", "--solution-name", "x"],
  ["copilot", "publish", "--bot", "x"],
  ["copilot", "delete", "--bot", "x"],
  ["admin", "reset-environment", "--environment", "x"],
  ["admin", "delete-environment", "--environment", "x"],
  ["admin", "copy-environment"],
  ["env", "select", "--environment", "x"],
  ["auth", "create", "--name", "x"],
  ["auth", "delete", "--name", "x"],
  ["connection", "delete"],
  ["pipeline", "deploy"],
  [],
];

test("read-only pac commands are recognised, whatever follows them", () => {
  for (const args of READ_ONLY) {
    assert.equal(isReadOnlyPac(args), true, `should be read-only: pac ${args.join(" ")}`);
    // Trailing flags must not change the verdict: the match is on the command head.
    assert.equal(isReadOnlyPac([...args, "--json"]), true, `should stay read-only with a flag: pac ${args.join(" ")} --json`);
  }
});

test("anything that can change something is not read-only, so it needs confirm", () => {
  for (const args of MUTATING) {
    assert.equal(isReadOnlyPac(args), false, `must NOT be read-only: pac ${args.join(" ")}`);
  }
});

test("a command that merely starts like a read-only one is not waved through", () => {
  // "admin list" reads; "admin list-and-delete" is not a real command, but the
  // matcher must anchor rather than prefix-match its way into a write.
  assert.equal(isReadOnlyPac(["admin", "reset-environment"]), false);
  assert.equal(isReadOnlyPac(["solution", "import"]), false);
  assert.equal(isReadOnlyPac(["copilot", "publish"]), false);
});

test("admin commands default to the admin profile, everything else to the maker profile", () => {
  const previousAdmin = process.env.CPS_ADMIN_PROFILE;
  const previousMaker = process.env.CPS_PAC_PROFILE;
  process.env.CPS_ADMIN_PROFILE = "admin-account";
  process.env.CPS_PAC_PROFILE = "maker-account";
  try {
    assert.equal(defaultPacProfile(["admin", "list"]), "admin-account");
    assert.equal(defaultPacProfile(["solution", "list"]), "maker-account");
    assert.equal(defaultPacProfile(["copilot", "push"]), "maker-account");
    assert.equal(defaultPacProfile([]), "maker-account");
  } finally {
    if (previousAdmin === undefined) delete process.env.CPS_ADMIN_PROFILE;
    else process.env.CPS_ADMIN_PROFILE = previousAdmin;
    if (previousMaker === undefined) delete process.env.CPS_PAC_PROFILE;
    else process.env.CPS_PAC_PROFILE = previousMaker;
  }
});

// --- cs_create_agent: which path an input takes -----------------------------

const LOCAL = { name: "Agent", publisherPrefix: "cps", projectDir: "C:/ws/agent" };

test("without an environment nothing reaches a tenant, so init runs unconfirmed", () => {
  // The local scaffold needs no sign-in and no approval: it only writes files.
  assert.deepEqual(createAgentGate(LOCAL, false), { action: "init" });
  assert.deepEqual(createAgentGate({ ...LOCAL, confirm: true }, false), { action: "init" });
});

test("a local scaffold is still allowed under CPS_READ_ONLY", () => {
  // CPS_READ_ONLY withholds the tools that change an environment. This input
  // changes none, so refusing it would withhold offline authoring too.
  assert.deepEqual(createAgentGate(LOCAL, true), { action: "init" });
});

test("an environment plus CPS_READ_ONLY is refused before the confirm contract", () => {
  const gate = createAgentGate({ ...LOCAL, environment: "env-1", confirm: true }, true);
  assert.equal(gate.action, "refuse");
  assert.match(gate.reason, /CPS_READ_ONLY/);
});

test("an environment without confirm is a dry run naming what it would do", () => {
  const gate = createAgentGate({ ...LOCAL, environment: "env-1" }, false);
  assert.equal(gate.action, "dryRun");
  assert.match(gate.plan, /create agent 'Agent' in environment env-1/);
  assert.match(gate.plan, /in a solution named after the agent/);
});

test("the dry run names the solution, and whether it would be created", () => {
  const named = createAgentGate({ ...LOCAL, environment: "env-1", solutionName: "Core" }, false);
  assert.equal(named.action, "dryRun");
  assert.match(named.plan, /inside solution Core$/);
  const created = createAgentGate({ ...LOCAL, environment: "env-1", solutionName: "Core", createSolution: true }, false);
  assert.equal(created.action, "dryRun");
  assert.match(created.plan, /inside solution Core \(created if missing\)/);
});

test("environment plus solutionName plus confirm takes the bootstrap path", () => {
  assert.deepEqual(createAgentGate({ ...LOCAL, environment: "env-1", solutionName: "Core", confirm: true }, false), { action: "bootstrapSolution" });
});

test("environment plus confirm without a solution takes plain init", () => {
  assert.deepEqual(createAgentGate({ ...LOCAL, environment: "env-1", confirm: true }, false), { action: "init" });
});

test("solutionName without an environment is refused, confirmed or not", () => {
  for (const confirm of [undefined, true]) {
    const gate = createAgentGate({ ...LOCAL, solutionName: "Core", confirm }, false);
    assert.equal(gate.action, "refuse", `confirm: ${String(confirm)}`);
    assert.equal(gate.reason, "solutionName needs environment");
  }
});
