#!/usr/bin/env node
/**
 * Replace tenant identifiers in a filled-in verification report with stable
 * pseudonyms, so the result can be shared from a public repo.
 *
 * The same value always becomes the same symbol, so the report still reads as
 * one story: <env-1> in phase A is <env-1> in phase G.
 *
 * Usage: node scripts/redact-verification.mjs verification-results.md [out.md]
 *
 * This is a safety net, not a guarantee. It cannot know that a topic name, an
 * agent name or the text of a customer's message is sensitive. Read the output
 * before you share it.
 */
import fs from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/redact-verification.mjs <results.md> [out.md]");
  process.exit(2);
}
const output = process.argv[3] ?? input.replace(/(\.md)?$/, ".redacted.md");

let text = fs.readFileSync(input, "utf8");

/** Pseudonyms per kind, so the same value keeps the same symbol. */
const seen = new Map();
const counts = new Map();
function symbolFor(kind, value) {
  const key = `${kind}:${value.toLowerCase()}`;
  const existing = seen.get(key);
  if (existing) return existing;
  const n = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, n);
  const symbol = `<${kind}-${n}>`;
  seen.set(key, symbol);
  return symbol;
}

/**
 * Order matters: the more specific patterns run first, so a GUID inside an org
 * URL is not replaced before the URL is recognised as a whole.
 */
const RULES = [
  // https://contoso.crm4.dynamics.com -> <org-1>
  { kind: "org", re: /https:\/\/[a-z0-9-]+\.crm[0-9]*\.dynamics\.com/gi },
  // Power Platform environment API hosts
  { kind: "envhost", re: /https:\/\/[a-z0-9.-]+\.environment\.api\.powerplatform\.com/gi },
  // user@contoso.com and UPNs
  { kind: "user", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // bare GUIDs, with or without braces
  { kind: "id", re: /\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?/g },
  // Windows user profile paths
  { kind: "path", re: /[A-Za-z]:\\Users\\[^\\\s"']+/g },
  { kind: "path", re: /\/(?:home|Users)\/[^/\s"']+/g },
];

const tally = [];
for (const rule of RULES) {
  let hits = 0;
  text = text.replace(rule.re, (match) => {
    hits++;
    return symbolFor(rule.kind, match.replace(/[{}]/g, ""));
  });
  if (hits) tally.push({ kind: rule.kind, replacements: hits });
}

// Bearer tokens and anything that looks like a secret should never survive.
let secrets = 0;
text = text.replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, () => {
  secrets++;
  return "<jwt-removed>";
});
text = text.replace(/("(?:accessToken|secret|password|clientSecret|directLineSecret)"\s*:\s*)"[^"]*"/gi, (_m, k) => {
  secrets++;
  return `${k}"<removed>"`;
});

fs.writeFileSync(output, text, "utf8");

console.log(`wrote ${path.relative(process.cwd(), output)}`);
for (const t of tally) console.log(`  ${t.kind}: ${t.replacements} replaced (${[...seen.keys()].filter((k) => k.startsWith(`${t.kind}:`)).length} distinct)`);
if (secrets) console.log(`  secrets/tokens removed: ${secrets}`);
console.log("\nRead the file before sharing it. Agent names, topic names, connector names and any");
console.log("message text are left as they are: this cannot tell which of those are sensitive.");
