/**
 * cs_pac decides two things before it runs anything: whether the command only
 * reads (so it needs no confirm and survives CPS_READ_ONLY), and which pac auth
 * profile runs it. Both used to be inline expressions in the handler. These are
 * the cases that decide whether a write can slip through without approval.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defaultPacProfile, isReadOnlyPac } from "../dist/tools/sync.js";

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
