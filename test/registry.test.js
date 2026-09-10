// server.json is the MCP Registry's view of package.json. The registry verifies ownership by
// reading `mcpName` from the published npm tarball, and lists whatever version server.json
// names, so the two files must agree before a release is cut.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

test("server.json mirrors package.json", () => {
  assert.equal(server.name, pkg.mcpName, "server.json name must equal package.json mcpName");
  assert.match(server.name, /^io\.github\.jgt87\//, "GitHub auth only publishes under io.github.jgt87/");
  assert.equal(server.version, pkg.version, "bump server.json together with npm version");
  assert.equal(server.packages.length, 1);
  const [p] = server.packages;
  assert.equal(p.registryType, "npm");
  assert.equal(p.identifier, pkg.name);
  assert.equal(p.version, pkg.version, "the package entry carries the version a second time");
  assert.equal(p.transport.type, "stdio");
});
