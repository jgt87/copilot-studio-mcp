/**
 * Why a flow run failed, why this run differs from one that worked, and
 * whether a flow is reliable.
 *
 * The run list alone answers "it failed" and nothing else, which is the wrong
 * half of the question. Three things make the difference:
 *
 *  1. **A failed connector action has no `error` property.** The service puts
 *     the real message in the action's outputs blob (`outputsLink.uri`), a
 *     SAS-signed URI that expires after a few days. Reading only the action row
 *     leaves you with "ActionFailed" and no cause, so `explainRun` follows the
 *     link and digs the message out of whatever shape the connector wrote.
 *  2. **A failure is rarely about the action that failed.** It is about what an
 *     earlier action handed it, so each failure is paired with the outputs of
 *     the actions that ran just before it.
 *  3. **"It worked yesterday" is a diff, not a mystery.** `compareRuns` lines a
 *     failed run up against a successful one and names the action where they
 *     part company, which separates a data-dependent failure (same definition,
 *     different trigger data) from a logic or environment one.
 *
 * Everything here reads. Nothing in this module can change an environment.
 *
 * UNVERIFIED against a live tenant, like the rest of the Power Automate
 * service client it builds on: the run, action and content-link shapes come
 * from the service's documented responses, not a capture.
 */
import { listFlowRuns, listRunActions, readContentLink, type ContentLink, type FlowRun, type LinkContent, type RunAction } from "./cloud/flowruns.js";
import { getFlowRun } from "./cloud/flowruns.js";
import type { FetchLike } from "./cloud/http.js";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/** The service's terminal failure statuses. "Cancelled" is a person, not a fault. */
export function isFailure(status: string | null | undefined): boolean {
  return /^(Failed|TimedOut|Aborted|Faulted)$/i.test(status ?? "");
}

export function isSuccess(status: string | null | undefined): boolean {
  return /^Succeeded$/i.test(status ?? "");
}

/** Still going: neither a success nor a fault, so it must not count towards a failure rate. */
export function isPending(status: string | null | undefined): boolean {
  return /^(Running|Waiting|Paused|Resuming|Suspended)$/i.test(status ?? "");
}

function byStartTime(a: { startTime: string | null }, b: { startTime: string | null }): number {
  return Date.parse(a.startTime ?? "") - Date.parse(b.startTime ?? "") || 0;
}

// ---------------------------------------------------------------------------
// Pulling a message out of a connector's outputs
// ---------------------------------------------------------------------------

export interface ResolvedError {
  message: string;
  code?: string;
  /** The HTTP status the connector's own call returned, when the blob records one. */
  statusCode?: number;
  /** `action` when the service reported it directly, `outputs` when it came from the blob. */
  source: "action" | "outputs";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Find the human-readable message in an action's outputs.
 *
 * Connectors do not agree on a shape. The common ones, in the order they are
 * tried: `{statusCode, body: {error: {code, message}}}` (most first-party
 * connectors), `{statusCode, body: {message}}`, `{error: {code, message}}`,
 * a bare `{message}`, and a body that is simply a string.
 */
export function errorFromOutputs(content: unknown): Omit<ResolvedError, "source"> | null {
  if (typeof content === "string") return content.trim() ? { message: content.trim() } : null;
  const top = asRecord(content);
  if (!top) return null;
  const statusCode = typeof top.statusCode === "number" ? top.statusCode : undefined;
  const withStatus = (e: { message: string; code?: string }): Omit<ResolvedError, "source"> => (statusCode === undefined ? e : { ...e, statusCode });

  for (const candidate of [top.body, top.error, top]) {
    if (typeof candidate === "string") {
      if (candidate.trim()) return withStatus({ message: candidate.trim() });
      continue;
    }
    const rec = asRecord(candidate);
    if (!rec) continue;
    const nested = asRecord(rec.error) ?? rec;
    const message = typeof nested.message === "string" ? nested.message : typeof rec.message === "string" ? rec.message : null;
    if (message?.trim()) return withStatus({ message: message.trim(), ...(typeof nested.code === "string" ? { code: nested.code } : {}) });
  }
  return null;
}

/** What kind of problem this is, which decides what the user should look at next. */
export type FailureKind = "connector" | "expression" | "timeout" | "cancelled" | "other";

const EXPRESSION_CODES = /InvalidTemplate|ExpressionEvaluationFailed|TemplateValidation|InvalidJSON|BadRequest.*expression/i;

export function classifyFailure(action: { status: string | null; code: string | null }, error: ResolvedError | null): FailureKind {
  if (/^TimedOut$/i.test(action.status ?? "")) return "timeout";
  if (/^(Cancelled|Aborted)$/i.test(action.status ?? "")) return "cancelled";
  if (EXPRESSION_CODES.test(action.code ?? "") || EXPRESSION_CODES.test(error?.code ?? "")) return "expression";
  if (error?.statusCode !== undefined || error?.source === "outputs") return "connector";
  return "other";
}

const FIX_FOR: Record<FailureKind, string> = {
  connector: "The connector's own call failed. Check the connection is still authorised (cs_list_connections), the account has access to the resource, and the parameters the action sent.",
  expression: "The definition is at fault, not the data source: an expression referenced something that was not there. Read the failed action's inputs below and cs_get_flow includeDefinition, then fix it with cs_update_flow.",
  timeout: "The action ran past its timeout. Either the downstream system is slow or the flow is asking for too much at once.",
  cancelled: "The run was cancelled rather than failing on its own.",
  other: "No message was recoverable. Open the run in Power Automate; the service keeps detail this API does not return.",
};

// ---------------------------------------------------------------------------
// explainRun
// ---------------------------------------------------------------------------

export interface ExplainedAction extends RunAction {
  kind?: FailureKind;
  resolvedError?: ResolvedError | null;
  /** What the action was given, for a failure, or produced, for upstream context. */
  inputs?: unknown;
  outputs?: unknown;
  notes?: string[];
}

export interface RunExplanation {
  runId: string;
  status: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  /** The run-level error, when the service reports one. */
  error: { code?: string; message?: string } | null;
  actionCount: number;
  failed: ExplainedAction[];
  /** Actions that succeeded just before the first failure, with what they produced. */
  upstream: ExplainedAction[];
  verdict: string;
  notes: string[];
}

export interface ExplainOptions {
  /** Succeeded actions to include with their outputs, ending at the first failure. Default 3. */
  upstreamCount?: number;
  /** Fetch each failed action's inputs as well as its outputs. Default true. */
  includeInputs?: boolean;
  maxBytes?: number;
  fetchImpl?: FetchLike;
}

async function read(link: ContentLink | null, opts: ExplainOptions): Promise<LinkContent> {
  return readContentLink(link, { fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes });
}

function noteFrom(content: LinkContent, what: string): string[] {
  const out: string[] = [];
  if (content.error) out.push(`${what}: ${content.error}`);
  else if (content.truncated) out.push(`${what} was truncated at the size cap.`);
  return out;
}

/**
 * One failed run, explained: every failed action with its real message, and
 * the outputs of the actions that ran immediately before the first failure.
 */
export async function explainRun(token: string, environmentId: string, flowId: string, runId: string, opts: ExplainOptions = {}): Promise<RunExplanation> {
  const [run, actions] = await Promise.all([getFlowRun(token, environmentId, flowId, runId, opts.fetchImpl), listRunActions(token, environmentId, flowId, runId, { fetchImpl: opts.fetchImpl })]);
  const ordered = [...actions].sort(byStartTime);
  const notes: string[] = [];

  const failedActions = ordered.filter((a) => isFailure(a.status));
  const failed: ExplainedAction[] = [];
  for (const a of failedActions) {
    const out = await read(a.outputsLink, opts);
    const fromOutputs = errorFromOutputs(out.value);
    const resolved: ResolvedError | null = a.error?.message
      ? { message: a.error.message, ...(a.error.code ? { code: a.error.code } : {}), source: "action" }
      : fromOutputs
        ? { ...fromOutputs, source: "outputs" }
        : null;
    const entry: ExplainedAction = { ...a, kind: classifyFailure(a, resolved), resolvedError: resolved, notes: noteFrom(out, "outputs") };
    if (opts.includeInputs !== false && a.inputsLink) {
      const inp = await read(a.inputsLink, opts);
      entry.inputs = inp.value;
      entry.notes = [...(entry.notes ?? []), ...noteFrom(inp, "inputs")];
    }
    if (!resolved && !out.error) entry.notes = [...(entry.notes ?? []), "The outputs carried no recognisable error message; the raw outputs are the best evidence there is."];
    if (!resolved) entry.outputs = out.value;
    if (!entry.notes?.length) delete entry.notes;
    failed.push(entry);
  }

  // Upstream context: what the flow knew just before it broke. An action with no timestamp must
  // not silently empty this out, so an unparseable time means "no cut-off" rather than "nothing".
  const at = (value: string | null | undefined, fallback: number) => {
    const ms = Date.parse(value ?? "");
    return Number.isNaN(ms) ? fallback : ms;
  };
  const firstFailureAt = failedActions.length ? at(failedActions[0].startTime, Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const before = ordered.filter((a) => isSuccess(a.status) && at(a.endTime ?? a.startTime, Number.NEGATIVE_INFINITY) <= firstFailureAt);
  const upstream: ExplainedAction[] = [];
  for (const a of before.slice(-(opts.upstreamCount ?? 3))) {
    const out = await read(a.outputsLink, opts);
    const entry: ExplainedAction = { ...a, outputs: out.value, notes: noteFrom(out, "outputs") };
    if (!entry.notes?.length) delete entry.notes;
    upstream.push(entry);
  }

  const triggerFailed = isFailure(run.trigger?.status);
  if (triggerFailed) notes.push("The trigger itself failed, so none of the flow's actions ran. The fault is in the trigger's connection or its parameters, not in the flow's logic.");
  if (!actions.length) notes.push("The service returned no actions for this run. A run that never started has none, and so does one whose detail has aged out.");
  if (ordered.some((a) => /^(Skipped)$/i.test(a.status ?? ""))) notes.push("Actions marked Skipped did not run because an action they depend on failed; they are consequences, not causes.");

  return {
    runId: run.name || runId,
    status: run.status,
    startTime: run.startTime,
    endTime: run.endTime,
    durationMs: run.durationMs,
    error: run.error,
    actionCount: actions.length,
    failed,
    upstream,
    verdict: verdictFor(run, failed, triggerFailed),
    notes,
  };
}

function verdictFor(run: FlowRun, failed: ExplainedAction[], triggerFailed: boolean): string {
  if (isSuccess(run.status) && !failed.length) return "The run succeeded. Nothing to explain.";
  if (triggerFailed) return `The trigger '${run.trigger?.name ?? "unknown"}' failed, so the flow never ran.`;
  if (!failed.length) return `The run is ${run.status ?? "in an unknown state"} but no single action reports a failure; check the run-level error and whether the run is still going.`;
  const first = failed[0];
  const where = failed.length === 1 ? `'${first.name}'` : `'${first.name}' (and ${failed.length - 1} more)`;
  const why = first.resolvedError?.message ?? first.code ?? "no message the service would give up";
  return `${where} failed: ${why}. ${FIX_FOR[first.kind ?? "other"]}`;
}

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

/** The most recent successful run that is not the one being explained. */
export function pickBaseline(runs: FlowRun[], failedRunId: string): FlowRun | null {
  return runs.filter((r) => isSuccess(r.status) && r.name !== failedRunId).sort((a, b) => Date.parse(b.startTime ?? "") - Date.parse(a.startTime ?? ""))[0] ?? null;
}

export interface StatusChange {
  action: string;
  baseline: string | null;
  failed: string | null;
}

/** The first action, in the order the failed run ran them, that did not do what the baseline did. */
export function divergence(failedActions: RunAction[], baseline: Map<string, RunAction>): StatusChange | null {
  for (const a of [...failedActions].sort(byStartTime)) {
    const b = baseline.get(a.name);
    if (!b) return { action: a.name, baseline: null, failed: a.status };
    if ((b.status ?? "") !== (a.status ?? "")) return { action: a.name, baseline: b.status, failed: a.status };
  }
  return null;
}

/** Top-level keys whose values differ between two trigger payloads. Keys only: the values are the user's data. */
export function differingKeys(a: unknown, b: unknown): { changed: string[]; onlyInFailed: string[]; onlyInBaseline: string[] } | null {
  const ra = asRecord(a);
  const rb = asRecord(b);
  if (!ra || !rb) return null;
  const body = (r: Record<string, unknown>) => asRecord(r.body) ?? r;
  const fa = body(ra);
  const fb = body(rb);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const changed: string[] = [];
  const onlyInFailed: string[] = [];
  const onlyInBaseline: string[] = [];
  for (const k of keys) {
    const inA = k in fa;
    const inB = k in fb;
    if (inA && !inB) onlyInFailed.push(k);
    else if (!inA && inB) onlyInBaseline.push(k);
    else if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) changed.push(k);
  }
  return { changed: changed.sort(), onlyInFailed: onlyInFailed.sort(), onlyInBaseline: onlyInBaseline.sort() };
}

export interface RunComparison {
  failedRunId: string;
  baselineRunId: string | null;
  failedStatus: string | null;
  baselineStatus: string | null;
  divergesAt: StatusChange | null;
  statusChanges: StatusChange[];
  onlyInFailed: string[];
  onlyInBaseline: string[];
  triggerData: { compared: boolean; identical?: boolean; changed?: string[]; onlyInFailed?: string[]; onlyInBaseline?: string[]; note?: string };
  verdict: string;
  notes: string[];
}

export interface CompareOptions {
  baselineRunId?: string;
  /** Fetch both runs' trigger outputs and report which top-level keys differ. Costs two more reads. */
  compareTriggerData?: boolean;
  /** How far back to look for a successful baseline when none is given. Default 50. */
  searchRuns?: number;
  maxBytes?: number;
  fetchImpl?: FetchLike;
}

/**
 * A failed run against one that worked. The question it answers is whether the
 * flow changed or the data did.
 */
export async function compareRuns(token: string, environmentId: string, flowId: string, failedRunId: string, opts: CompareOptions = {}): Promise<RunComparison> {
  const notes: string[] = [];
  const failedRun = await getFlowRun(token, environmentId, flowId, failedRunId, opts.fetchImpl);

  let baselineRun: FlowRun | null = null;
  if (opts.baselineRunId) {
    baselineRun = await getFlowRun(token, environmentId, flowId, opts.baselineRunId, opts.fetchImpl);
    if (!isSuccess(baselineRun.status)) notes.push(`The baseline run ${baselineRun.name} is ${baselineRun.status}, not Succeeded, so "what changed" is measured against another failure.`);
  } else {
    const history = await listFlowRuns(token, environmentId, flowId, { top: opts.searchRuns ?? 50, fetchImpl: opts.fetchImpl });
    baselineRun = pickBaseline(history, failedRunId);
    if (!baselineRun) notes.push(`No successful run in the last ${history.length} to compare against. If the flow has never worked, cs_explain_flow_run on the failure is the whole story.`);
  }

  if (!baselineRun) {
    return {
      failedRunId: failedRun.name || failedRunId,
      baselineRunId: null,
      failedStatus: failedRun.status,
      baselineStatus: null,
      divergesAt: null,
      statusChanges: [],
      onlyInFailed: [],
      onlyInBaseline: [],
      triggerData: { compared: false, note: "no baseline run" },
      verdict: "There is no successful run to compare against.",
      notes,
    };
  }

  const [failedActions, baselineActions] = await Promise.all([
    listRunActions(token, environmentId, flowId, failedRun.name || failedRunId, { fetchImpl: opts.fetchImpl }),
    listRunActions(token, environmentId, flowId, baselineRun.name, { fetchImpl: opts.fetchImpl }),
  ]);
  const baselineByName = new Map(baselineActions.map((a) => [a.name, a]));
  const failedByName = new Map(failedActions.map((a) => [a.name, a]));

  const statusChanges: StatusChange[] = [];
  for (const a of [...failedActions].sort(byStartTime)) {
    const b = baselineByName.get(a.name);
    if (b && (b.status ?? "") !== (a.status ?? "")) statusChanges.push({ action: a.name, baseline: b.status, failed: a.status });
  }
  const onlyInFailed = failedActions.filter((a) => !baselineByName.has(a.name)).map((a) => a.name);
  const onlyInBaseline = baselineActions.filter((a) => !failedByName.has(a.name)).map((a) => a.name);

  let triggerData: RunComparison["triggerData"] = { compared: false, note: "pass compareTriggerData: true to check whether the two runs were given different input" };
  if (opts.compareTriggerData) {
    const [fa, ba] = await Promise.all([
      readContentLink(failedRun.trigger?.outputsLink ?? null, { fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes }),
      readContentLink(baselineRun.trigger?.outputsLink ?? null, { fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes }),
    ]);
    const problem = fa.error ?? ba.error;
    const diff = problem ? null : differingKeys(fa.value, ba.value);
    triggerData = problem
      ? { compared: false, note: `trigger data could not be read: ${problem}` }
      : diff
        ? { compared: true, identical: !diff.changed.length && !diff.onlyInFailed.length && !diff.onlyInBaseline.length, ...diff }
        : { compared: false, note: "the trigger payloads are not objects, so they cannot be compared key by key" };
  }

  const divergesAt = divergence(failedActions, baselineByName);
  return {
    failedRunId: failedRun.name || failedRunId,
    baselineRunId: baselineRun.name,
    failedStatus: failedRun.status,
    baselineStatus: baselineRun.status,
    divergesAt,
    statusChanges,
    onlyInFailed,
    onlyInBaseline,
    triggerData,
    verdict: comparisonVerdict({ divergesAt, onlyInFailed, onlyInBaseline, triggerData }),
    notes,
  };
}

export function comparisonVerdict(c: Pick<RunComparison, "divergesAt" | "onlyInFailed" | "onlyInBaseline" | "triggerData">): string {
  const shapeChanged = c.onlyInFailed.length > 0 || c.onlyInBaseline.length > 0;
  const where = c.divergesAt ? `The runs part company at '${c.divergesAt.action}' (${c.divergesAt.baseline ?? "absent"} in the baseline, ${c.divergesAt.failed ?? "absent"} here).` : "Every action that ran reached the same status in both runs; the difference is in the data they produced, not in what ran.";
  if (shapeChanged) return `${where} The two runs did not have the same actions, so the flow's definition changed between them: compare it with cs_get_flow includeDefinition rather than chasing the data.`;
  if (c.triggerData.compared && c.triggerData.identical) return `${where} Both runs were given the same trigger data, so this is not a bad input: look at the connector, the connection or the system it calls.`;
  if (c.triggerData.compared && c.triggerData.changed?.length) return `${where} The trigger data differs in ${c.triggerData.changed.concat(c.triggerData.onlyInFailed ?? []).join(", ")}, so the failure is most likely data-dependent: the flow does not handle this input.`;
  return `${where} Pass compareTriggerData: true to see whether the two runs were given different input, which is what separates a data problem from a logic one.`;
}

// ---------------------------------------------------------------------------
// analyzeFlowHealth
// ---------------------------------------------------------------------------

export interface DurationStats {
  count: number;
  minMs: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

export function durationStats(values: number[]): DurationStats | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { count: sorted.length, minMs: sorted[0], medianMs: at(0.5), p90Ms: at(0.9), maxMs: sorted[sorted.length - 1] };
}

export interface FailingAction {
  action: string;
  runs: number;
  /** Share of the sampled failures this action appears in, 0 to 1. */
  share: number;
}

export interface FlowHealth {
  flowId: string;
  runsExamined: number;
  byStatus: Record<string, number>;
  completed: number;
  failed: number;
  /** Failures over completed runs; null when nothing has finished yet. */
  failureRate: number | null;
  duration: DurationStats | null;
  failuresSampled: number;
  failingActions: FailingAction[];
  triggerFailures: number;
  verdict: string;
  notes: string[];
}

/**
 * Where the failures concentrate decides what to do about them. One action
 * responsible for most of them is a fault in that step; failures spread over
 * many actions, or in the trigger, are the connection or the environment.
 */
export function healthVerdict(h: Pick<FlowHealth, "completed" | "failed" | "failureRate" | "failingActions" | "triggerFailures" | "failuresSampled">): string {
  if (!h.completed) return "No completed runs in the window examined, so there is nothing to judge.";
  if (!h.failed) return `All ${h.completed} completed runs succeeded.`;
  const rate = `${h.failed} of ${h.completed} completed runs failed (${Math.round((h.failureRate ?? 0) * 100)}%).`;
  if (h.triggerFailures >= Math.max(1, h.failuresSampled * 0.6)) return `${rate} Most failures are in the trigger, so the flow's logic is not the problem: check the trigger's connection and the system it listens to.`;
  const worst = h.failingActions[0];
  if (worst && worst.share >= 0.6) return `${rate} They concentrate on one action, '${worst.action}' (${worst.runs} of ${h.failuresSampled} sampled failures). Fix that step: cs_explain_flow_run on one of them gives the message.`;
  if (!h.failingActions.length) return `${rate} No action-level detail was recoverable for the sampled failures, so the cause is not visible from here; open one in Power Automate.`;
  return `${rate} They are spread over ${h.failingActions.length} actions, which points at something shared - a connection that keeps expiring, throttling, or an unreliable downstream system - rather than one broken step.`;
}

export interface HealthOptions {
  /** Runs to look at. Default 50. */
  lastN?: number;
  /** Failed runs to open for action-level attribution. Default 5. */
  sampleFailures?: number;
  fetchImpl?: FetchLike;
}

export async function analyzeFlowHealth(token: string, environmentId: string, flowId: string, opts: HealthOptions = {}): Promise<FlowHealth> {
  const lastN = opts.lastN ?? 50;
  const sampleFailures = opts.sampleFailures ?? 5;
  const runs = await listFlowRuns(token, environmentId, flowId, { top: lastN, fetchImpl: opts.fetchImpl });
  const notes: string[] = [];

  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status ?? "unknown"] = (byStatus[r.status ?? "unknown"] ?? 0) + 1;
  const completedRuns = runs.filter((r) => !isPending(r.status));
  const failedRuns = runs.filter((r) => isFailure(r.status));
  const duration = durationStats(completedRuns.map((r) => r.durationMs ?? Number.NaN));

  const sample = failedRuns.slice(0, sampleFailures);
  const counts = new Map<string, number>();
  let triggerFailures = 0;
  for (const r of sample) {
    if (isFailure(r.trigger?.status)) triggerFailures++;
    try {
      const actions = await listRunActions(token, environmentId, flowId, r.name, { fetchImpl: opts.fetchImpl });
      for (const name of new Set(actions.filter((a) => isFailure(a.status)).map((a) => a.name))) counts.set(name, (counts.get(name) ?? 0) + 1);
    } catch (err) {
      notes.push(`Could not read the actions of run ${r.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const failingActions: FailingAction[] = [...counts.entries()]
    .map(([action, n]) => ({ action, runs: n, share: sample.length ? n / sample.length : 0 }))
    .sort((a, b) => b.runs - a.runs || a.action.localeCompare(b.action));

  if (runs.length === lastN) notes.push(`Only the most recent ${lastN} runs were examined; raise lastN for a longer window.`);
  if (failedRuns.length > sample.length) notes.push(`${failedRuns.length} runs failed but only ${sample.length} were opened for action-level detail; raise sampleFailures for a fuller picture.`);

  const failureRate = completedRuns.length ? failedRuns.length / completedRuns.length : null;
  return {
    flowId,
    runsExamined: runs.length,
    byStatus,
    completed: completedRuns.length,
    failed: failedRuns.length,
    failureRate,
    duration,
    failuresSampled: sample.length,
    failingActions,
    triggerFailures,
    verdict: healthVerdict({ completed: completedRuns.length, failed: failedRuns.length, failureRate, failingActions, triggerFailures, failuresSampled: sample.length }),
    notes,
  };
}
