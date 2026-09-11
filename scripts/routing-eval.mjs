#!/usr/bin/env node
/**
 * Routing eval: does a model reading this server's tool list pick the right
 * tool for what a user actually said?
 *
 * Every other check in this repo is structural - the tool exists, it declares
 * confirm, the preset count is honest. None of them catch the failure that
 * matters most in practice: the user says "why did my flow fail" and the model
 * calls cs_get_flow_run, which answers a different question. With 142 tools and
 * about 50k tokens of schema, that is a routing problem, and a routing problem
 * has to be measured rather than asserted.
 *
 * What this measures is deliberately narrow: given the tool list exactly as an
 * MCP client sees it, and one user utterance, which tool does the model reach
 * for first? That isolates the tool list itself. It does not test the guides,
 * multi-step plans, or argument filling.
 *
 *   node scripts/routing-eval.mjs --dry-run              # free: prompt + corpus check
 *   node scripts/routing-eval.mjs --yes                  # full run, default preset
 *   node scripts/routing-eval.mjs --preset core --yes
 *   node scripts/routing-eval.mjs --probe --yes          # only the confusable-pair cases
 *   node scripts/routing-eval.mjs --yes --json out.json  # machine-readable report
 *
 * Backends, chosen automatically:
 *   api  - ANTHROPIC_API_KEY set. Sends the tool list once as a cached prefix,
 *          so the run costs cents. This is the measurement.
 *   cli  - the `claude` CLI, using the sign-in this machine already has. It
 *          works with no key, but Claude Code's own system prompt and tools sit
 *          in the context alongside ours, so treat it as an approximation, and
 *          note that each call carries that overhead in cost.
 *
 * Every run that calls a model spends real money, so nothing runs without
 * --yes; --dry-run shows the prompt, the corpus and the estimate for free.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = path.join(ROOT, "dist", "index.js");
// reference/ ships in the npm package, so an installed copy can run this too.
const DEFAULT_CASES = path.join(ROOT, "reference", "routing-cases.json");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { preset: "full", model: null, backend: null, cases: DEFAULT_CASES, concurrency: 4, limit: 0, repeat: 1, probe: false, area: null, yes: false, dryRun: false, json: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--preset") o.preset = next();
    else if (a === "--model") o.model = next();
    else if (a === "--backend") o.backend = next();
    else if (a === "--cases") o.cases = path.resolve(next());
    else if (a === "--concurrency") o.concurrency = Number(next());
    else if (a === "--limit") o.limit = Number(next());
    else if (a === "--repeat") o.repeat = Number(next());
    else if (a === "--area") o.area = next();
    else if (a === "--probe") o.probe = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = path.resolve(next());
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`Unknown argument: ${a}. Try --help.`);
  }
  return o;
}

const HELP = `routing-eval - does a model pick the right tool for what a user said?

  --preset <name>     tool preset to expose (full, core, authoring, admin, solutions). Default full.
  --model <id>        model to route with. Default claude-opus-5 on the api backend, the CLI's own default otherwise.
  --backend api|cli   default: api when ANTHROPIC_API_KEY is set, else cli.
  --cases <path>      corpus. Default reference/routing-cases.json (your own file works too)
  --probe             only cases that exist to separate a confusable pair.
  --area <a,b>        only cases in these areas (flows, admin, sync, session, ...).
  --limit <n>         first n cases only.
  --concurrency <n>   parallel calls. Default 4.
  --repeat <n>        run the whole corpus n times and report run-to-run spread and which cases flap. Default 1.
  --dry-run           print the prompt, the corpus summary and the cost estimate. Calls no model, costs nothing.
  --yes               actually run. Required, because a run spends money.
  --json <path>       write the full report as JSON.
  --verbose           print every case as it is scored.`;

// ---------------------------------------------------------------------------
// The tool list, exactly as a client sees it
// ---------------------------------------------------------------------------

/** One JSON-RPC round trip at a time against a freshly spawned server. */
async function toolsFor(preset) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CPS_TOOLS: preset === "full" ? "" : preset } });
  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buffer += d.toString("utf8");
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* notifications are not replies */
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout: ${method}`))), 30_000);
    });
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "routing-eval", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return (await rpc("tools/list", {})).result.tools;
  } finally {
    child.kill();
  }
}

/**
 * The system prompt. The tool list goes in verbatim, because the point is to
 * measure the descriptions this server actually ships, not a summary of them.
 */
function buildSystem(tools) {
  const rendered = tools.map((t) => `${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").trim()}`).join("\n\n");
  const rules = [
    "You are the tool-selection layer of an MCP client connected to one server.",
    "The user says something in their own words. Name the single tool you would call FIRST to make progress on it.",
    "",
    "Rules:",
    "- Answer with the tool name alone, e.g. cs_list_flows. No explanation, no punctuation, nothing else.",
    "- Pick from the list below and nothing else. If several could apply, pick the one that most directly answers what the user asked.",
    "- Name the tool whose JOB is what the user described. If it needs an id the user did not give, that is an argument to fill in afterwards - still name the tool that does the job, not the tool that would find the id.",
    "- Do not name a setup, inventory or session tool unless the user actually asked about setup, an inventory or the session.",
    "",
    "Available tools:",
  ].join("\n");
  return { rules, rendered };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const TOOL_NAME = /\bcs_[a-z_]+\b/;

/**
 * The user turn. It has to insist on a bare tool name: a model left free to be
 * helpful answers "tell me which flow and I will look it up", which is good
 * assistant behaviour and useless as a measurement.
 */
function frame(utterance) {
  return [
    "A user of this MCP server said:",
    "",
    `"${utterance}"`,
    "",
    "Which single tool would you call FIRST? Do not ask clarifying questions, do not explain, do not offer to help.",
    "Output only the tool name, e.g. cs_list_flows. Your entire reply must be one tool name.",
  ].join("\n");
}

/** Claude Code's own tools, which the cli backend must keep the model away from. */
const HARNESS_TOOLS = ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "Edit", "Write", "NotebookEdit"];

/**
 * Anthropic Messages API. The tool list is a cached system block, so the 50k
 * tokens of schema are paid for once and read back at a tenth of the price for
 * every case after the first.
 *
 * No temperature: sampling parameters are rejected on the current models, and
 * the determinism they used to buy comes from the task being a one-word answer.
 */
async function apiBackend(model) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error("The api backend needs @anthropic-ai/sdk: npm install --save-dev @anthropic-ai/sdk, or run with --backend cli.");
  }
  const client = new Anthropic();
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  return {
    name: "api",
    model,
    usage,
    async ask({ rules, rendered }, utterance) {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        output_config: { effort: "low" },
        system: [
          { type: "text", text: rules },
          { type: "text", text: rendered, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: frame(utterance) }],
      });
      usage.input += res.usage?.input_tokens ?? 0;
      usage.output += res.usage?.output_tokens ?? 0;
      usage.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;
      usage.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
      if (res.stop_reason === "refusal") return { raw: "", chosen: null, note: "the model declined the request" };
      const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
      return { raw: text.trim(), chosen: TOOL_NAME.exec(text)?.[0] ?? null };
    },
  };
}

/**
 * The `claude` CLI in print mode. It uses the sign-in this machine already has,
 * which is why it exists, but Claude Code's own system prompt and tool list sit
 * in the context next to ours: the routing question is the same, the conditions
 * are not identical to a bare client. The system prompt goes through a file
 * because the full tool list is far past any command-line length limit.
 */
async function cliBackend(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-eval-"));
  let cost = 0;
  return {
    name: "cli",
    model: model ?? "(the CLI's default)",
    get usage() {
      return { costUsd: cost };
    },
    async ask({ rules, rendered }, utterance) {
      const file = path.join(dir, `sys-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(file, `${rules}\n${rendered}`);
      try {
        // The utterance goes in on stdin, never as an argument: it is free text
        // with quotes and punctuation in it, and keeping it off the command line
        // removes a whole class of quoting bugs.
        //
        // --max-turns 2 with the deny list: left to itself the model calls one of
        // Claude Code's own tools instead of answering, the turn limit trips, and
        // the process exits 1 with nothing on stderr.
        const args = ["-p", "--system-prompt-file", file, "--output-format", "json", "--permission-mode", "plan", "--max-turns", "2", "--disallowed-tools", ...HARNESS_TOOLS];
        if (model) args.push("--model", model);
        const out = await run("claude", args, frame(utterance));
        const parsed = JSON.parse(out);
        cost += parsed.total_cost_usd ?? 0;
        const text = String(parsed.result ?? "");
        return { raw: text.trim(), chosen: TOOL_NAME.exec(text)?.[0] ?? null };
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
}

/**
 * The CLI is a real executable, not a .cmd shim, so it is spawned directly with
 * no shell and no cmd wrapper: nothing re-parses the arguments, and the
 * quoting hazard CLAUDE.md records for .cmd shims does not arise. On Windows
 * the extension is explicit because a bare name is not resolved without a shell.
 */
function executable(cmd) {
  return process.platform === "win32" ? `${cmd}.exe` : cmd;
}

function run(cmd, args, stdin, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const exe = executable(cmd);
    if (process.env.ROUTING_EVAL_DEBUG) console.error(`
[debug] ${exe} ${args.join(" ")}`);
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400) || "(no stderr)"}`));
    });
    child.stdin.end(stdin ?? "");
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function score(cases, answers, registered) {
  const rows = cases.map((c, i) => {
    const a = answers[i];
    const chosen = a.chosen;
    const verdict = a.error ? "error" : chosen === c.expect ? "hit" : (c.alsoFine ?? []).includes(chosen) ? "acceptable" : "miss";
    return { ...c, chosen, raw: a.raw, error: a.error, verdict, chosenExists: chosen ? registered.has(chosen) : null };
  });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    rows,
    hit: count("hit"),
    acceptable: count("acceptable"),
    miss: count("miss"),
    error: count("error"),
    total: rows.length,
    hallucinated: rows.filter((r) => r.chosen && r.chosenExists === false).length,
  };
}

function report(result, opts, backend) {
  const { rows, hit, acceptable, miss, error, total } = result;
  const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`ROUTING  preset=${opts.preset}  backend=${backend.name}  model=${backend.model}  cases=${total}`);
  console.log("=".repeat(72));
  console.log(`  exact          ${String(hit).padStart(3)}  ${pct(hit)}`);
  console.log(`  acceptable     ${String(acceptable).padStart(3)}  ${pct(acceptable)}   (a listed reasonable first step)`);
  console.log(`  MISROUTED      ${String(miss).padStart(3)}  ${pct(miss)}`);
  if (error) console.log(`  errors         ${String(error).padStart(3)}`);
  if (result.hallucinated) console.log(`  named a tool that does not exist: ${result.hallucinated}`);

  const misses = rows.filter((r) => r.verdict === "miss");
  if (misses.length) {
    console.log(`\nMISROUTES, worst-confused pair first:`);
    const pairs = new Map();
    for (const m of misses) {
      const k = `${m.expect} -> ${m.chosen ?? "(nothing)"}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push(m);
    }
    for (const [pair, items] of [...pairs.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${pair}   (${items.length})`);
      for (const m of items) console.log(`     "${m.utterance}"${m.probe ? `   [probe: ${m.probe}]` : ""}`);
    }
  }

  const byArea = new Map();
  for (const r of rows) {
    const a = byArea.get(r.area) ?? { hit: 0, acceptable: 0, miss: 0, total: 0 };
    a[r.verdict] = (a[r.verdict] ?? 0) + 1;
    a.total++;
    byArea.set(r.area, a);
  }
  console.log(`\nBY AREA (exact / acceptable / misrouted):`);
  for (const [area, a] of [...byArea.entries()].sort((x, y) => (y[1].miss ?? 0) - (x[1].miss ?? 0))) {
    console.log(`  ${area.padEnd(12)} ${String(a.hit ?? 0).padStart(3)} / ${String(a.acceptable ?? 0).padStart(3)} / ${String(a.miss ?? 0).padStart(3)}   of ${a.total}`);
  }

  const u = backend.usage;
  if (u?.costUsd !== undefined) console.log(`\nCost: $${u.costUsd.toFixed(2)} (reported by the CLI, includes its own overhead)`);
  else if (u) console.log(`\nTokens: ${u.input} in, ${u.output} out, ${u.cacheWrite} cached, ${u.cacheRead} read from cache`);
  console.log(`\n${miss === 0 ? "No misroutes." : `${miss} misroute(s). Each pair above is a description that does not say when to reach for the tool.`}`);
}

/**
 * Run-to-run spread.
 *
 * One run is an anecdote: the model is sampling, so a score moves by itself
 * between runs. What matters for "did this edit work" is not the aggregate but
 * whether individual cases are stable, so this reports both, and names every
 * case that did not answer the same way every time.
 */
function varianceReport(passes, cases) {
  const hits = passes.map((p) => p.hit);
  const misses = passes.map((p) => p.miss);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = (xs) => `${Math.min(...xs)}-${Math.max(...xs)}`;
  const total = passes[0].total;

  console.log(`
${"=".repeat(72)}`);
  console.log(`RUN-TO-RUN SPREAD over ${passes.length} runs of the same build`);
  console.log("=".repeat(72));
  passes.forEach((p, i) => console.log(`  run ${i + 1}:  exact ${String(p.hit).padStart(3)}   acceptable ${String(p.acceptable).padStart(3)}   misrouted ${String(p.miss).padStart(3)}`));
  console.log(`  mean exact ${mean(hits).toFixed(1)} of ${total} (${((mean(hits) / total) * 100).toFixed(0)}%), range ${spread(hits)}`);
  console.log(`  mean misrouted ${mean(misses).toFixed(1)} (${((mean(misses) / total) * 100).toFixed(0)}%), range ${spread(misses)}`);
  console.log(`  the aggregate moves by up to ${Math.max(...hits) - Math.min(...hits)} case(s) on its own: a difference smaller than that is not evidence of anything.`);

  const byUtterance = new Map();
  for (const pass of passes) {
    for (const row of pass.rows) {
      if (!byUtterance.has(row.utterance)) byUtterance.set(row.utterance, []);
      byUtterance.get(row.utterance).push(row);
    }
  }
  const stable = { hit: [], miss: [], flap: [] };
  for (const [utterance, rows] of byUtterance) {
    const verdicts = new Set(rows.map((r) => r.verdict));
    const chosen = new Set(rows.map((r) => r.chosen));
    if (verdicts.size === 1 && verdicts.has("hit")) stable.hit.push(utterance);
    else if (verdicts.size === 1 && verdicts.has("miss")) stable.miss.push({ utterance, rows });
    else if (chosen.size > 1 || verdicts.size > 1) stable.flap.push({ utterance, rows });
  }
  console.log(`
  always right      ${String(stable.hit.length).padStart(3)}`);
  console.log(`  always misrouted  ${String(stable.miss.length).padStart(3)}   <- these are real, and worth a description edit`);
  console.log(`  unstable          ${String(stable.flap.length).padStart(3)}   <- these are noise, and prove nothing either way`);

  if (stable.miss.length) {
    console.log(`
ALWAYS MISROUTED (fix these):`);
    for (const { utterance, rows } of stable.miss) console.log(`  ${rows[0].expect.padEnd(26)} <- ${rows[0].chosen}
     "${utterance}"`);
  }
  if (stable.flap.length) {
    console.log(`
UNSTABLE (do not read a change in these as an improvement or a regression):`);
    for (const { utterance, rows } of stable.flap) console.log(`  ${rows[0].expect.padEnd(26)} <- ${rows.map((r) => r.chosen).join(", ")}
     "${utterance}"`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void console.log(HELP);
  if (!fs.existsSync(SERVER)) throw new Error(`No build at ${SERVER}. Run npm run build first.`);

  const corpus = JSON.parse(fs.readFileSync(opts.cases, "utf8"));
  let cases = corpus.cases ?? corpus;
  if (opts.probe) cases = cases.filter((c) => c.probe);
  if (opts.area) {
    const areas = new Set(opts.area.split(",").map((a) => a.trim()).filter(Boolean));
    cases = cases.filter((c) => areas.has(c.area));
  }
  if (opts.limit) cases = cases.slice(0, opts.limit);
  if (!cases.length) throw new Error("No cases selected.");

  const tools = await toolsFor(opts.preset);
  const registered = new Set(tools.map((t) => t.name));
  const prompt = buildSystem(tools);

  // A case whose expected tool the preset does not offer is not a routing
  // failure, it is a corpus that does not match the preset. Say so and drop it.
  const outOfScope = cases.filter((c) => !registered.has(c.expect));
  if (outOfScope.length) {
    console.log(`Skipping ${outOfScope.length} case(s) whose expected tool the '${opts.preset}' preset does not offer: ${[...new Set(outOfScope.map((c) => c.expect))].join(", ")}`);
    cases = cases.filter((c) => registered.has(c.expect));
  }

  const approxTokens = Math.round((prompt.rules.length + prompt.rendered.length) / 3.6);
  const calls = cases.length * Math.max(1, opts.repeat);
  console.log(`Tool list: ${tools.length} tools, ~${approxTokens.toLocaleString()} tokens. Cases: ${cases.length}${opts.repeat > 1 ? ` x ${opts.repeat} runs = ${calls} calls` : ""}.`);

  if (opts.dryRun) {
    console.log(`\n--- system prompt (first 600 chars of ${(prompt.rules.length + prompt.rendered.length).toLocaleString()}) ---\n${`${prompt.rules}\n${prompt.rendered}`.slice(0, 600)}...\n`);
    console.log(`Cases by area: ${[...cases.reduce((m, c) => m.set(c.area, (m.get(c.area) ?? 0) + 1), new Map())].map(([a, n]) => `${a} ${n}`).join(", ")}`);
    console.log(`Probe cases: ${cases.filter((c) => c.probe).length}`);
    const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    console.log(`\nBackend that would be used: ${opts.backend ?? (apiKey ? "api" : "cli")}`);
    console.log(apiKey
      ? `Rough cost on the api backend: the ${approxTokens.toLocaleString()}-token tool list is cached once, then ~${calls} short calls. Cents, not dollars.`
      : `Rough cost on the cli backend: about $0.2-0.3 per call of Claude Code overhead, so ~${(calls * (/haiku/i.test(opts.model ?? "") ? 0.05 : 0.25)).toFixed(2)} for ${calls} calls at the measured rate for ${opts.model ?? "the default model"}. Set ANTHROPIC_API_KEY to use the far cheaper api backend.`);
    console.log(`\nDry run: nothing was sent to a model. Add --yes to run.`);
    return;
  }

  if (!opts.yes) {
    console.log(`\nThis run calls a model once per case and costs real money. Re-run with --dry-run to see the estimate, or --yes to go ahead.`);
    process.exitCode = 1;
    return;
  }

  const which = opts.backend ?? (process.env.ANTHROPIC_API_KEY ? "api" : "cli");
  const backend = which === "api" ? await apiBackend(opts.model ?? "claude-opus-5") : await cliBackend(opts.model);
  if (which === "cli") console.log(`Using the claude CLI: Claude Code's own prompt shares the context, so read the result as an approximation.`);

  const passes = [];
  for (let attempt = 1; attempt <= Math.max(1, opts.repeat); attempt++) {
    let done = 0;
    if (opts.repeat > 1) console.log(`
run ${attempt} of ${opts.repeat}`);
    const answers = await pool(cases, opts.concurrency, async (c) => {
      try {
        const a = await backend.ask(prompt, c.utterance);
        if (opts.verbose) console.log(`  ${a.chosen === c.expect ? "ok  " : "??  "} ${c.expect.padEnd(26)} <- ${String(a.chosen).padEnd(26)} "${c.utterance.slice(0, 50)}"`);
        else process.stdout.write(`\r  ${++done}/${cases.length}`);
        return a;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`
  ERR  ${c.expect}: ${message}`);
        return { chosen: null, raw: "", error: message };
      }
    });
    if (!opts.verbose) process.stdout.write("\r");
    passes.push(score(cases, answers, registered));
  }
  // The headline report is the first pass; --repeat adds the spread underneath it.
  const result = passes[0];
  report(result, opts, backend);

  if (passes.length > 1) varianceReport(passes, cases);

  if (opts.json) {
    fs.writeFileSync(opts.json, `${JSON.stringify({ preset: opts.preset, backend: backend.name, model: backend.model, toolCount: tools.length, ...result, usage: backend.usage }, null, 2)}\n`);
    console.log(`Report written to ${opts.json}`);
  }
  process.exitCode = result.miss > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`routing-eval: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
