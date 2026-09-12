#!/usr/bin/env node
/**
 * Build the VSIX.
 *
 * The extension ships the server rather than fetching it at run time, so the
 * install is offline and pinned. That means this script has to assemble
 * `server/` the way npm would: the compiled `dist/`, the `reference/` data it
 * reads through `dist/../reference`, and a production-only `node_modules`
 * installed from the repository's own lockfile.
 *
 *   node build.mjs                  build and package
 *   node build.mjs --skip-package   assemble server/ and compile only
 *   node build.mjs --skip-build     reuse the existing dist/ and server/node_modules
 *   node build.mjs --target win32-x64
 *
 * The version is never written here: it is copied from the server's
 * package.json, which stays the single source of truth.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const serverDir = path.join(here, "server");

const args = process.argv.slice(2);
const skipPackage = args.includes("--skip-package");
const skipBuild = args.includes("--skip-build");
const target = args[args.indexOf("--target") + 1];
const hasTarget = args.includes("--target") && target && !target.startsWith("--");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, commandArgs, cwd) {
  console.log(`> ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

/**
 * Never spawn the .cmd shim: node concatenates argv without escaping, so a
 * repository path containing a space arrives as several arguments. vsce is
 * plain JS, so run its entry point directly.
 */
function runNode(script, scriptArgs, cwd) {
  console.log(`> node ${script} ${scriptArgs.join(" ")}`);
  execFileSync(process.execPath, [script, ...scriptArgs], { cwd, stdio: "inherit" });
}

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else fs.copyFileSync(src, dst);
  }
}

function size(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
}

// 1. The server's version is the extension's version.
const serverPkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const extPkgPath = path.join(here, "package.json");
const extPkg = JSON.parse(fs.readFileSync(extPkgPath, "utf8"));
if (extPkg.version !== serverPkg.version) {
  console.log(`version ${extPkg.version} -> ${serverPkg.version} (from ../package.json)`);
  extPkg.version = serverPkg.version;
  fs.writeFileSync(extPkgPath, `${JSON.stringify(extPkg, null, 2)}\n`);
}

// 2. Compile the server.
if (!skipBuild) run(npm, ["run", "build"], repo);
if (!fs.existsSync(path.join(repo, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing; run npm run build in the repository root");
}

// 3. Assemble server/: dist, reference, and a production-only node_modules.
const keepModules = skipBuild && fs.existsSync(path.join(serverDir, "node_modules"));
if (keepModules) {
  for (const name of fs.readdirSync(serverDir)) {
    if (name !== "node_modules") fs.rmSync(path.join(serverDir, name), { recursive: true, force: true });
  }
} else {
  fs.rmSync(serverDir, { recursive: true, force: true });
}
fs.mkdirSync(serverDir, { recursive: true });

copyDir(path.join(repo, "dist"), path.join(serverDir, "dist"), (src) => src.endsWith(".map"));
copyDir(path.join(repo, "reference"), path.join(serverDir, "reference"));
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(serverDir, "LICENSE"));

// npm ci needs the lockfile and a package.json that agrees with it; the scripts
// are dropped so prepublishOnly (which runs the test suite) cannot fire here.
const runtimePkg = { ...serverPkg };
delete runtimePkg.scripts;
delete runtimePkg.devDependencies;
fs.writeFileSync(path.join(serverDir, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);
fs.copyFileSync(path.join(repo, "package-lock.json"), path.join(serverDir, "package-lock.json"));

if (!keepModules) run(npm, ["ci", "--omit=dev"], serverDir);
fs.rmSync(path.join(serverDir, "package-lock.json"), { force: true });

console.log(`server/ assembled: ${(size(serverDir) / 1024 / 1024).toFixed(1)} MB on disk`);

// 4. Compile the extension.
run(npm, ["run", "compile"], here);

// 5. Package.
if (skipPackage) {
  console.log("--skip-package: stopping before vsce");
  process.exit(0);
}
const vsix = hasTarget
  ? `copilot-studio-mcp-${target}-${serverPkg.version}.vsix`
  : `copilot-studio-mcp-${serverPkg.version}.vsix`;
const vsceArgs = ["package", "--no-dependencies", "--out", vsix];
if (hasTarget) vsceArgs.push("--target", target);
runNode(path.join(here, "node_modules", "@vscode", "vsce", "vsce"), vsceArgs, here);

const bytes = fs.statSync(path.join(here, vsix)).size;
console.log(`\n${vsix}  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
