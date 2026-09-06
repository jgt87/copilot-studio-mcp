import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import test from "node:test";

import { browserLaunchSpec, browserLaunchSpecs, launchDetached } from "../dist/auth.js";

// An Entra authorize URL as MSAL builds it: several `&`-separated parameters, percent-encoding, and (for the escaping check) an apostrophe.
const AUTHORIZE_URL =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=51f81489-12ee-4a9e-aaae-a2591f45987d&scope=https%3A%2F%2Fapi.powerplatform.com%2F.default%20openid%20profile%20offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A53211&response_type=code&state=it's";

test("browserLaunchSpecs on Windows: PowerShell literal first, rundll32 and quoted start as fallbacks", () => {
  const specs = browserLaunchSpecs(AUTHORIZE_URL, "win32");
  assert.equal(specs.length, 3);
  const [ps, rundll, cmd] = specs;
  assert.match(ps.command, /powershell\.exe$/i);
  if (process.platform === "win32") assert.ok(isAbsolute(ps.command), "on Windows the launcher is addressed by its full path, not by PATH lookup");
  assert.ok(!ps.args.includes("-EncodedCommand"), "plain -Command: encoded commands are flagged by endpoint security tools");
  assert.deepEqual(ps.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(ps.args[3], `Start-Process -FilePath '${AUTHORIZE_URL.replace("it's", "it''s")}'`);
  assert.match(rundll.command, /rundll32\.exe$/i);
  assert.deepEqual(rundll.args, ["url.dll,FileProtocolHandler", AUTHORIZE_URL]);
  assert.match(cmd.command, /cmd\.exe$/i);
  assert.equal(cmd.verbatim, true, "cmd needs the pre-quoted form so start receives one argument");
  assert.deepEqual(cmd.args, ["/c", "start", '""', `"${AUTHORIZE_URL}"`]);
  assert.deepEqual(browserLaunchSpec(AUTHORIZE_URL, "win32"), ps);
});

test("browserLaunchSpecs on macOS and Linux hand the URL straight to open / xdg-open", () => {
  assert.deepEqual(browserLaunchSpecs(AUTHORIZE_URL, "darwin"), [{ command: "open", args: [AUTHORIZE_URL] }]);
  assert.deepEqual(browserLaunchSpecs(AUTHORIZE_URL, "linux"), [{ command: "xdg-open", args: [AUTHORIZE_URL] }]);
});

test("PowerShell receives the exact URL through the -Command form", { skip: process.platform !== "win32" }, () => {
  const [ps] = browserLaunchSpecs(AUTHORIZE_URL, "win32");
  const args = [...ps.args];
  args[3] = args[3].replace("Start-Process -FilePath", "Write-Output");
  const out = execFileSync(ps.command, args, { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(out, AUTHORIZE_URL);
});

test("launchDetached reports a launcher that does not exist instead of crashing the process", async () => {
  // Without an 'error' listener the asynchronous ENOENT would be an unhandled event and end the test process.
  const failed = new Promise((resolve, reject) => {
    launchDetached("no-such-launcher-xyz.exe", ["x"], { onError: (err) => resolve(err.message) });
    setTimeout(() => reject(new Error("onError was not called")), 3000);
  });
  assert.match(await failed, /ENOENT|not found/i);
});
