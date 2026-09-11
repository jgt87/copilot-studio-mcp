// What the npm tarball must contain. `files` and `bin` drift apart silently: a bin whose target
// is not packaged installs a broken shim, and npm reports nothing at publish time.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** The file list npm would publish, from npm itself rather than from re-reading `files`. */
function packedFiles() {
  // npm is a .cmd shim on Windows, which node refuses to spawn without a shell, and
  // `shell: true` would concatenate argv without escaping (the rule in CLAUDE.md). Hand a
  // fixed command line to cmd verbatim instead, the same way pacRun.spawnSpec does.
  const args = ["pack", "--dry-run", "--json"];
  const out =
    process.platform === "win32"
      ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"npm.cmd ${args.join(" ")}"`], { cwd: ROOT, encoding: "utf8", windowsVerbatimArguments: true })
      : execFileSync("npm", args, { cwd: ROOT, encoding: "utf8" });
  // npm reports Windows paths with backslashes; normalise without writing an escape.
  const BACKSLASH = String.fromCharCode(92);
  return new Set(JSON.parse(out)[0].files.map((f) => f.path.split(BACKSLASH).join("/")));
}

test("every bin target is packaged and executable as written", () => {
  const packed = packedFiles();
  for (const [name, target] of Object.entries(pkg.bin)) {
    const rel = target.replace(/^\.\//, "");
    assert.ok(packed.has(rel), `bin '${name}' points at ${rel}, which the tarball does not contain`);
    assert.ok(existsSync(new URL(`../${rel}`, import.meta.url)), `${rel} does not exist on disk`);
    const first = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").split("\n", 1)[0];
    if (rel.endsWith(".mjs")) assert.match(first, /^#!\/usr\/bin\/env node/, `${rel} is a bin without a shebang`);
  }
});

test("the routing eval ships with the corpus it defaults to", () => {
  const packed = packedFiles();
  assert.ok(packed.has("scripts/routing-eval.mjs"), "the eval script must ship for the bin to work");
  assert.ok(packed.has("reference/routing-cases.json"), "its default corpus must ship alongside it");
  const script = readFileSync(new URL("../scripts/routing-eval.mjs", import.meta.url), "utf8");
  assert.match(script, /path\.join\(ROOT, "reference", "routing-cases\.json"\)/, "the default corpus path must resolve inside the package, not into test/");
  const corpus = JSON.parse(readFileSync(new URL("../reference/routing-cases.json", import.meta.url), "utf8"));
  assert.ok(corpus.cases.length > 40, `corpus has only ${corpus.cases.length} cases`);
  for (const c of corpus.cases) assert.ok(c.utterance && c.expect && c.area, `malformed case: ${JSON.stringify(c).slice(0, 80)}`);
});
