import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";

import { browserLaunchSpec, launchDetached } from "../dist/auth.js";

// An Entra authorize URL as MSAL builds it: several `&`-separated parameters, percent-encoding, and (for the escaping check) an apostrophe.
const AUTHORIZE_URL =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=51f81489-12ee-4a9e-aaae-a2591f45987d&scope=https%3A%2F%2Fapi.powerplatform.com%2F.default%20openid%20profile%20offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A53211&response_type=code&state=it's";

test("browserLaunchSpec on Windows passes the whole URL through an encoded PowerShell command", () => {
  const spec = browserLaunchSpec(AUTHORIZE_URL, "win32");
  assert.match(spec.command, /powershell\.exe$/i);
  if (process.platform === "win32") assert.ok(isAbsolute(spec.command), "on Windows the launcher is addressed by its full path, not by PATH lookup");
  assert.ok(!spec.args.includes("start") && !spec.args.includes("/c"), "cmd start must not be used: it truncates the URL at the first &");
  const i = spec.args.indexOf("-EncodedCommand");
  assert.ok(i > 0);
  const script = Buffer.from(spec.args[i + 1], "base64").toString("utf16le");
  assert.equal(script, `Start-Process -FilePath '${AUTHORIZE_URL.replace("it's", "it''s")}'`);
  assert.ok(script.includes("&scope=https%3A%2F%2Fapi.powerplatform.com"), "the scope parameter survives intact");
  assert.ok(spec.args.includes("-NonInteractive") && spec.args.includes("-NoProfile"));
});

test("browserLaunchSpec on macOS and Linux hands the URL straight to open / xdg-open", () => {
  assert.deepEqual(browserLaunchSpec(AUTHORIZE_URL, "darwin"), { command: "open", args: [AUTHORIZE_URL] });
  assert.deepEqual(browserLaunchSpec(AUTHORIZE_URL, "linux"), { command: "xdg-open", args: [AUTHORIZE_URL] });
});

test("launchDetached survives a launcher that does not exist instead of crashing the process", async () => {
  // Without an 'error' listener the asynchronous ENOENT would be an unhandled event and end the test process.
  launchDetached("no-such-launcher-xyz.exe", ["x"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(true, "still running");
});
