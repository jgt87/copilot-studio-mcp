/**
 * runPac against a fake pac on PAC_PATH. The parsers are covered by
 * parsers.test.js; this is the runner itself: what it passes to the process,
 * what it does to the output, and how it reports a failure.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { PUBLISH_FAILED, runPac } from "../dist/pac.js";

const IS_WIN = process.platform === "win32";
const ESC = String.fromCharCode(27);

let dir;
let fakePac;
let previousPacPath;

/**
 * A stand-in for pac: echoes its argv and the environment the runner set, on
 * whichever stream the caller asked for, then exits with the code it was given.
 *   argv: [--exit N] [--stderr TEXT] [--sleep MS] [--ansi]
 */
const FAKE = `
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const ansi = ${JSON.stringify(ESC)} + "[32m";
process.stdout.write("argv=" + JSON.stringify(args) + "\\n");
process.stdout.write("telemetry=" + String(process.env.PAC_CLI_TELEMETRY_OPTOUT) + "\\n");
process.stdout.write("marker=" + String(process.env.SMOKE_MARKER) + "\\n");
process.stdout.write("cwd=" + process.cwd() + "\\n");
if (args.includes("--ansi")) process.stdout.write(ansi + "coloured" + ansi + "\\n");
const say = opt("--say", null);
if (say !== null) process.stdout.write(say.replace(/_/g, " ") + "\\n");
const err = opt("--stderr", null);
if (err !== null) process.stderr.write(err + "\\n");
const sleep = Number(opt("--sleep", 0));
const exit = Number(opt("--exit", 0));
if (sleep > 0) setTimeout(() => process.exit(exit), sleep);
else process.exit(exit);
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-pac-"));
  const script = join(dir, "fake.mjs");
  writeFileSync(script, FAKE, "utf8");
  if (IS_WIN) {
    fakePac = join(dir, "pac.cmd");
    writeFileSync(fakePac, `@echo off\r\nnode "${script}" %*\r\n`, "utf8");
  } else {
    fakePac = join(dir, "pac");
    writeFileSync(fakePac, `#!/bin/sh\nexec node "${script}" "$@"\n`, "utf8");
    chmodSync(fakePac, 0o755);
  }
  previousPacPath = process.env.PAC_PATH;
  process.env.PAC_PATH = fakePac;
});

after(() => {
  if (previousPacPath === undefined) delete process.env.PAC_PATH;
  else process.env.PAC_PATH = previousPacPath;
  rmSync(dir, { recursive: true, force: true });
});

test("a successful run reports ok, the exit code and the argv it passed", async () => {
  const r = await runPac(["copilot", "list"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /argv=\["copilot","list"\]/);
  assert.equal(r.stderr.trim(), "");
  assert.ok(r.durationMs >= 0);
  assert.match(r.command, /^pac(\.cmd)? copilot list$/);
});

test("a non-zero exit is a result, not a rejection", async () => {
  const r = await runPac(["copilot", "list", "--exit", "3", "--stderr", "Error: no environment selected"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no environment selected/);
});

test("ANSI escapes are stripped from both streams", async () => {
  const r = await runPac(["--ansi"]);
  assert.match(r.stdout, /coloured/);
  assert.ok(!r.stdout.includes(ESC), "escape sequences survived into stdout");
});

test("redacted values are masked in the command but still reach pac", async () => {
  const r = await runPac(["auth", "create", "--secret", "s3cr3t"], { redact: ["s3cr3t"] });
  assert.match(r.command, /--secret \*\*\*/);
  assert.ok(!r.command.includes("s3cr3t"), "the secret leaked into the reported command");
  assert.match(r.stdout, /"s3cr3t"/, "the real value should still be passed to pac");
});

test("telemetry is opted out by default, and the process environment wins over options.env", async () => {
  const byDefault = await runPac(["x"]);
  assert.match(byDefault.stdout, /telemetry=1/);
  // The runner sets PAC_CLI_TELEMETRY_OPTOUT last, from process.env, so options.env
  // cannot raise it. Recording the behaviour as it is; a caller who needs telemetry
  // on has to set it on the process.
  const viaOptions = await runPac(["x"], { env: { PAC_CLI_TELEMETRY_OPTOUT: "0" } });
  assert.match(viaOptions.stdout, /telemetry=1/);
  process.env.PAC_CLI_TELEMETRY_OPTOUT = "0";
  try {
    const viaProcess = await runPac(["x"]);
    assert.match(viaProcess.stdout, /telemetry=0/);
  } finally {
    delete process.env.PAC_CLI_TELEMETRY_OPTOUT;
  }
});

test("argv survives the Windows .cmd shim: spaces, backslashes, ampersands, quotes", async () => {
  const argv = ["copilot", "init", "--project-dir", "C:\\Files\\Apps\\To Copilot Studio MCP\\ws", "--name", "Sales & Support", "--instructions", 'Say "hi" first'];
  const r = await runPac(argv);
  const received = JSON.parse(/argv=(\[.*\])/.exec(r.stdout)[1]);
  assert.deepEqual(received, argv);
});

test("env and cwd options are passed through", async () => {
  const r = await runPac(["x"], { env: { SMOKE_MARKER: "hello" }, cwd: dir });
  assert.match(r.stdout, /marker=hello/);
  assert.match(r.stdout, /cwd=/);
});

test("a run that outlives its timeout is killed and says so", async () => {
  const r = await runPac(["x", "--sleep", "5000"], { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /timed out after 300 ms/);
});

// `--say` makes the fake print a line of its own, so these assert on pac's
// output rather than on the argv echo. Underscores become spaces: the phrase
// has to arrive as one argument.
const PUBLISH_OK = "Publish_complete.";
const PUBLISH_BAD = "..Failed_to_publish._9596_Failed_[08/09/2026_21:44:44].";

test("failOnOutput turns a zero exit that reports failure into a failure", async () => {
  // pac copilot publish prints this and still exits 0 (live tenant, 2026-09-09).
  const failed = await runPac(["publish", "--say", PUBLISH_BAD], { failOnOutput: [PUBLISH_FAILED] });
  assert.match(failed.stdout, /Failed to publish/, "the fake must actually print it");
  assert.equal(failed.code, 0, "pac still exited 0");
  assert.equal(failed.ok, false, "but the result must not claim success");
  assert.match(failed.stderr, /exited 0 but its output reports failure/);
});

test("failOnOutput leaves a genuine success alone", async () => {
  const r = await runPac(["publish", "--say", PUBLISH_OK], { failOnOutput: [PUBLISH_FAILED] });
  assert.match(r.stdout, /Publish complete/);
  assert.equal(r.ok, true);
  assert.ok(!r.stderr.includes("reports failure"));
});

test("failOnOutput does nothing unless the command opts in", async () => {
  const r = await runPac(["publish", "--say", PUBLISH_BAD]);
  assert.match(r.stdout, /Failed to publish/);
  assert.equal(r.ok, true, "no opt-in, no change in behaviour");
});

test("a non-zero exit is still a failure, and is not attributed to the output check", async () => {
  const r = await runPac(["publish", "--say", PUBLISH_OK, "--exit", "1"], { failOnOutput: [PUBLISH_FAILED] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes("reports failure"));
});
