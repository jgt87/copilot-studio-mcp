import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assignArgs, assignUsers, describePlan, expandAssignments, parseAssignmentCsv, parseCsv, readAssignmentCsv, splitRoles } from "../dist/adminAssign.js";

const ENV = "11111111-2222-3333-4444-555555555555";

/** A pac that succeeds, unless the args match one of the failure patterns. */
function fakePac(failOn = []) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    const bad = failOn.find((f) => line.includes(f));
    return bad
      ? { ok: false, code: 1, stdout: "", stderr: `Error: principal ${bad} was not found`, command: `pac ${line}`, durationMs: 1 }
      : { ok: true, code: 0, stdout: "Assigned.", stderr: "", command: `pac ${line}`, durationMs: 1 };
  };
  run.calls = calls;
  return run;
}

test("parseCsv handles quoted cells, doubled quotes and CRLF", () => {
  const rows = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\nplain,2\r\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x,1", 'he said "hi"'],
    ["plain", "2"],
  ]);
});

test("a trailing newline does not invent an empty row", () => {
  assert.equal(parseCsv("a,b\n1,2\n").length, 2);
  assert.equal(parseCsv("a,b\n1,2").length, 2);
});

test("roles split on comma, semicolon or pipe", () => {
  assert.deepEqual(splitRoles("System Customizer, Basic User"), ["System Customizer", "Basic User"]);
  assert.deepEqual(splitRoles("A;B|C"), ["A", "B", "C"]);
  assert.deepEqual(splitRoles("  "), []);
});

test("the roster reads the documented columns and their aliases", () => {
  const csv = 'UPN,Security Roles,Business Unit\nalice@contoso.com,"System Customizer,Basic User",Sales\nbob@contoso.com,Environment Maker,\n';
  const { assignments, warnings } = parseAssignmentCsv(csv);

  assert.deepEqual(warnings, []);
  assert.equal(assignments.length, 2);
  assert.deepEqual(assignments[0], { user: "alice@contoso.com", roles: ["System Customizer", "Basic User"], businessUnit: "Sales" });
  assert.deepEqual(assignments[1], { user: "bob@contoso.com", roles: ["Environment Maker"] });
});

test("a user on several rows accumulates roles instead of replacing them", () => {
  const { assignments } = parseAssignmentCsv("user,role\nalice@contoso.com,Basic User\nALICE@contoso.com,System Customizer\n");
  assert.equal(assignments.length, 1, "matched case-insensitively");
  assert.deepEqual(assignments[0].roles, ["Basic User", "System Customizer"]);
  assert.equal(assignments[0].user, "alice@contoso.com", "the first spelling is kept");
});

test("rows missing a user or a role are warned about, not silently dropped", () => {
  const { assignments, warnings } = parseAssignmentCsv("user,role\n,Basic User\nbob@contoso.com,\n\ncarol@contoso.com,Basic User\n");
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].user, "carol@contoso.com");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Line 2: no user/);
  assert.match(warnings[1], /Line 3: bob@contoso.com has no roles/);
});

test("a header without the required columns fails with what it wanted and what it found", () => {
  const { assignments, warnings } = parseAssignmentCsv("name,job\nalice,dev\n");
  assert.equal(assignments.length, 0);
  assert.match(warnings[0], /needs a user column/);
  assert.match(warnings[0], /Found: name, job/);
});

test("applicationUser is read from the roster", () => {
  const { assignments } = parseAssignmentCsv("user,role,applicationUser\nsvc-id,System Administrator,yes\nalice@contoso.com,Basic User,no\n");
  assert.equal(assignments[0].applicationUser, true);
  assert.equal(assignments[1].applicationUser, undefined);
});

test("expansion is one pair per user and role, in order, deduped", () => {
  const pairs = expandAssignments([
    { user: "alice@contoso.com", roles: ["Basic User", "System Customizer", "basic user"] },
    { user: "bob@contoso.com", roles: ["Basic User"] },
  ]);
  assert.equal(pairs.length, 3, "alice's duplicate role is dropped case-insensitively");
  assert.deepEqual(
    pairs.map((p) => `${p.user}:${p.role}`),
    ["alice@contoso.com:Basic User", "alice@contoso.com:System Customizer", "bob@contoso.com:Basic User"],
  );
});

test("a row's own business unit beats the default", () => {
  const pairs = expandAssignments([{ user: "a", roles: ["R"], businessUnit: "Sales" }, { user: "b", roles: ["R"] }], { businessUnit: "Root" });
  assert.equal(pairs[0].businessUnit, "Sales");
  assert.equal(pairs[1].businessUnit, "Root");
});

test("assignArgs builds the documented pac argv", () => {
  assert.deepEqual(assignArgs(ENV, { user: "alice@contoso.com", role: "Basic User", applicationUser: false }), [
    "admin",
    "assign-user",
    "--environment",
    ENV,
    "--user",
    "alice@contoso.com",
    "--role",
    "Basic User",
  ]);
  const app = assignArgs(ENV, { user: "svc", role: "R", applicationUser: true, businessUnit: "BU" });
  assert.ok(app.includes("--application-user"));
  assert.deepEqual(app.slice(-2), ["--business-unit", "BU"]);
});

test("the plan counts users, pairs and roles before anything runs", () => {
  const plan = describePlan(ENV, [
    { user: "alice@contoso.com", roles: ["Basic User", "System Customizer"] },
    { user: "bob@contoso.com", roles: ["Basic User"] },
  ]);
  assert.equal(plan.users, 2);
  assert.equal(plan.assignments, 3);
  assert.deepEqual(plan.roles, { "Basic User": 2, "System Customizer": 1 });
  assert.equal(plan.pairs.length, 3);
  assert.equal(plan.pairs[0], "alice@contoso.com -> Basic User");
});

test("the whole roster runs, one pac call per pair", async () => {
  const run = fakePac();
  const report = await assignUsers({
    environment: ENV,
    assignments: [
      { user: "alice@contoso.com", roles: ["Basic User", "System Customizer"] },
      { user: "bob@contoso.com", roles: ["Environment Maker"] },
    ],
    run,
  });

  assert.equal(report.total, 3);
  assert.equal(report.succeeded, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.users, 2);
  assert.equal(run.calls.length, 3);
  assert.ok(run.calls.every((c) => c[0] === "admin" && c[1] === "assign-user"));
});

test("one bad row is recorded and the rest still run", async () => {
  const run = fakePac(["bob@contoso.com"]);
  const report = await assignUsers({
    environment: ENV,
    assignments: [
      { user: "alice@contoso.com", roles: ["Basic User"] },
      { user: "bob@contoso.com", roles: ["Basic User"] },
      { user: "carol@contoso.com", roles: ["Basic User"] },
    ],
    run,
  });

  assert.equal(report.total, 3);
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 1);
  assert.equal(run.calls.length, 3, "the roster was not abandoned at the failure");

  const bad = report.results.find((r) => !r.ok);
  assert.equal(bad.user, "bob@contoso.com");
  assert.match(bad.error, /was not found/, "the pac message is kept, not swallowed");
  assert.equal(report.stoppedAfter, undefined);
});

test("continueOnError false stops at the first failure and says where", async () => {
  const run = fakePac(["bob@contoso.com"]);
  const report = await assignUsers({
    environment: ENV,
    assignments: [
      { user: "alice@contoso.com", roles: ["Basic User"] },
      { user: "bob@contoso.com", roles: ["Basic User"] },
      { user: "carol@contoso.com", roles: ["Basic User"] },
    ],
    continueOnError: false,
    run,
  });

  assert.equal(report.stoppedAfter, 2);
  assert.equal(run.calls.length, 2, "carol was never attempted");
  assert.equal(report.succeeded, 1);
  assert.equal(report.failed, 1);
});

test("an empty roster runs nothing rather than everything", async () => {
  const run = fakePac();
  const report = await assignUsers({ environment: ENV, assignments: [], run });
  assert.equal(report.total, 0);
  assert.equal(run.calls.length, 0);
});

test("readAssignmentCsv reads a real file and refuses a missing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-roster-"));
  const file = path.join(dir, "devs.csv");
  fs.writeFileSync(file, "user,roles\nalice@contoso.com,\"Basic User;System Customizer\"\n");

  const { assignments } = readAssignmentCsv(file);
  assert.deepEqual(assignments[0].roles, ["Basic User", "System Customizer"]);

  assert.throws(() => readAssignmentCsv(path.join(dir, "nope.csv")), /Roster file not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});
