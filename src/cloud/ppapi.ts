/**
 * Power Platform API: Copilot Studio maker evaluation endpoints.
 * Test sets can only be listed and run here; creation is UI-only (CSV import).
 */
import { requestJson, type FetchLike } from "./http.js";

export const PPAPI_SCOPE = "https://api.powerplatform.com/.default";
const API_VERSION = "2024-10-01";

function base(environmentId: string, botId: string): string {
  return `https://api.powerplatform.com/copilotstudio/environments/${encodeURIComponent(environmentId)}/bots/${encodeURIComponent(botId)}/api/makerevaluation`;
}

function v(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
}

export interface TestSet {
  id: string;
  displayName: string;
  description: string | null;
  state: string | null;
  totalTestCases: number | null;
  raw?: unknown;
}

export interface TestCaseResult {
  testCaseId: string;
  state: string | null;
  metricsResults: {
    type: string;
    status: string | null;
    errorReason: string | null;
    aiResultReason: string | null;
    result: unknown;
  }[];
}

export interface TestRun {
  id: string;
  name: string | null;
  state: string | null;
  executionState: string | null;
  testSetId: string | null;
  startTime: string | null;
  endTime: string | null;
  totalTestCases: number | null;
  testCasesProcessed: number | null;
  testCasesResults?: TestCaseResult[];
  raw?: unknown;
}

const HINTS = {
  403: "the signed-in user needs maker access to this agent (Power Platform API scope)",
  409: "an evaluation run is already in progress for this agent",
  429: "limit is 20 evaluation runs per agent per 24 hours",
};

function toTestSet(r: Record<string, unknown>): TestSet {
  return {
    id: String(r.id),
    displayName: String(r.displayName ?? ""),
    description: (r.description as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    totalTestCases: typeof r.totalTestCases === "number" ? r.totalTestCases : null,
    raw: r,
  };
}

function toRun(r: Record<string, unknown>): TestRun {
  const results = Array.isArray(r.testCasesResults) ? (r.testCasesResults as Record<string, unknown>[]) : undefined;
  return {
    id: String(r.id ?? r.runId ?? ""),
    name: (r.name as string | null) ?? (r.evaluationRunName as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    executionState: (r.executionState as string | null) ?? null,
    testSetId: (r.testSetId as string | null) ?? null,
    startTime: (r.startTime as string | null) ?? null,
    endTime: (r.endTime as string | null) ?? null,
    totalTestCases: typeof r.totalTestCases === "number" ? r.totalTestCases : null,
    testCasesProcessed: typeof r.testCasesProcessed === "number" ? r.testCasesProcessed : null,
    testCasesResults: results?.map((tc) => ({
      testCaseId: String(tc.testCaseId ?? tc.id ?? ""),
      state: (tc.state as string | null) ?? null,
      metricsResults: (Array.isArray(tc.metricsResults) ? (tc.metricsResults as Record<string, unknown>[]) : []).map((m) => ({
        type: String(m.type ?? ""),
        status: (m.status as string | null) ?? null,
        errorReason: (m.errorReason as string | null) ?? null,
        aiResultReason: (m.aiResultReason as string | null) ?? null,
        result: m.result,
      })),
    })),
    raw: r,
  };
}

export async function listTestSets(token: string, environmentId: string, botId: string, fetchImpl?: FetchLike): Promise<TestSet[]> {
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(v(`${base(environmentId, botId)}/testsets`), { token, fetchImpl, hints: HINTS });
  return (data?.value ?? []).map(toTestSet);
}

export async function getTestSet(token: string, environmentId: string, botId: string, testSetId: string, fetchImpl?: FetchLike): Promise<TestSet> {
  const data = await requestJson<Record<string, unknown>>(v(`${base(environmentId, botId)}/testsets/${encodeURIComponent(testSetId)}`), { token, fetchImpl, hints: HINTS });
  if (!data) throw new Error(`Test set ${testSetId} not found`);
  return toTestSet(data);
}

export interface StartRunOptions {
  runOnPublishedBot?: boolean;
  evaluationRunName?: string;
  mcsConnectionId?: string;
}

export async function startRun(
  token: string,
  environmentId: string,
  botId: string,
  testSetId: string,
  opts: StartRunOptions = {},
  fetchImpl?: FetchLike,
): Promise<TestRun> {
  const body: Record<string, unknown> = { runOnPublishedBot: Boolean(opts.runOnPublishedBot) };
  if (opts.evaluationRunName) body.evaluationRunName = opts.evaluationRunName;
  if (opts.mcsConnectionId) body.mcsConnectionId = opts.mcsConnectionId;
  const data = await requestJson<Record<string, unknown>>(v(`${base(environmentId, botId)}/testsets/${encodeURIComponent(testSetId)}/run`), {
    method: "POST",
    token,
    body,
    fetchImpl,
    hints: HINTS,
  });
  if (!data) throw new Error("Run request accepted but no body returned");
  return toRun(data);
}

export async function listRuns(token: string, environmentId: string, botId: string, fetchImpl?: FetchLike): Promise<TestRun[]> {
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(v(`${base(environmentId, botId)}/testruns`), { token, fetchImpl, hints: HINTS });
  return (data?.value ?? []).map(toRun);
}

export async function getRun(token: string, environmentId: string, botId: string, runId: string, fetchImpl?: FetchLike): Promise<TestRun> {
  const data = await requestJson<Record<string, unknown>>(v(`${base(environmentId, botId)}/testruns/${encodeURIComponent(runId)}`), { token, fetchImpl, hints: HINTS });
  if (!data) throw new Error(`Run ${runId} not found`);
  return toRun(data);
}

export interface RunSummary {
  runId: string;
  state: string | null;
  totalTestCases: number | null;
  processed: number | null;
  passed: number;
  failed: number;
  errored: number;
  other: number;
  byMetric: Record<string, { passed: number; failed: number; errored: number; other: number }>;
  cases: { testCaseId: string; state: string | null; metrics: { type: string; status: string | null; reason: string | null }[] }[];
}

const PASS = /^(pass|passed|success|succeeded)$/i;
const FAIL = /^(fail|failed)$/i;
const ERR = /^(error|errored|failedtorun|skipped)$/i;

export function summarizeRun(run: TestRun): RunSummary {
  const summary: RunSummary = {
    runId: run.id,
    state: run.state,
    totalTestCases: run.totalTestCases,
    processed: run.testCasesProcessed,
    passed: 0,
    failed: 0,
    errored: 0,
    other: 0,
    byMetric: {},
    cases: [],
  };
  for (const tc of run.testCasesResults ?? []) {
    let casePassed = true;
    let caseErrored = false;
    let caseFailed = false;
    const metrics = tc.metricsResults.map((m) => {
      const bucket = (summary.byMetric[m.type] ??= { passed: 0, failed: 0, errored: 0, other: 0 });
      const st = m.status ?? "";
      if (PASS.test(st)) bucket.passed++;
      else if (FAIL.test(st)) {
        bucket.failed++;
        caseFailed = true;
        casePassed = false;
      } else if (ERR.test(st) || m.errorReason) {
        bucket.errored++;
        caseErrored = true;
        casePassed = false;
      } else {
        bucket.other++;
        casePassed = false;
      }
      return { type: m.type, status: m.status, reason: m.errorReason ?? m.aiResultReason ?? null };
    });
    if (metrics.length === 0) casePassed = false;
    if (casePassed) summary.passed++;
    else if (caseErrored) summary.errored++;
    else if (caseFailed) summary.failed++;
    else summary.other++;
    summary.cases.push({ testCaseId: tc.testCaseId, state: tc.state, metrics });
  }
  return summary;
}
