// CHANGELOG.md is the running record a release's notes are written from. A version bump that
// leaves the entries under [Unreleased] ships a release whose changelog still names the previous
// version as the newest, so the newest released heading must be the version in package.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm)].map((m) => ({
  version: m[1],
  date: m[2],
}));

test("changelog keeps an Unreleased section at the top", () => {
  assert.equal(headings[0]?.version, "Unreleased", "the first ## heading must be [Unreleased]");
});

test("the newest released changelog entry is the package.json version", () => {
  const released = headings.filter((h) => h.version !== "Unreleased");
  assert.ok(released.length > 0, "no released versions found");
  assert.equal(
    released[0].version,
    pkg.version,
    "after npm version, move the [Unreleased] entries under ## [<version>] - <date>",
  );
  for (const h of released) assert.match(h.date ?? "", /^\d{4}-\d{2}-\d{2}$/, `[${h.version}] needs a date`);
});

test("every changelog heading has a link reference", () => {
  for (const h of headings) {
    assert.match(changelog, new RegExp(`^\\[${h.version.replace(/\./g, "\\.")}\\]: https://`, "m"), `[${h.version}] has no link`);
  }
});
