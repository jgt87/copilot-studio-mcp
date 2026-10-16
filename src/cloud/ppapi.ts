/**
 * Power Platform API, `copilotstudio` namespace: the per-agent operations.
 *
 * Maker evaluation: test sets can only be listed and run here (creation is
 * UI-only, CSV import); runs are listed and read, and the content snapshot a
 * run was scored against can be downloaded. Two admin settings live beside it
 * under the same bot path: connector consent bypass (read and set) and the
 * channel manifest download (`agents/{id}/channels/{channel}/download`).
 *
 * All at api-version 2024-10-01, the stable version. The evaluation calls are
 * verified live; the snapshot, consent bypass and channel manifest calls follow
 * the published reference (added April to July 2026) and are UNVERIFIED against
 * a live tenant.
 */
import { requestBytes, requestJson, type BytesResponse, type FetchLike } from "./http.js";

export const PPAPI_SCOPE = "https://api.powerplatform.com/.default";
const API_VERSION = "2024-10-01";
const HOST = "https://api.powerplatform.com/copilotstudio";

/** `.../bots/{bot}/api`: the evaluation and admin-setting routes hang off this. */
function botBase(environmentId: string, botId: string): string {
  return `${HOST}/environments/${encodeURIComponent(environmentId)}/bots/${encodeURIComponent(botId)}/api`;
}

function base(environmentId: string, botId: string): string {
  return `${botBase(environmentId, botId)}/makerevaluation`;
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

const ADMIN_HINTS = {
  403: "connector consent bypass is an admin setting: the signed-in user needs a Power Platform or Copilot Studio admin role, or maker access to the agent for a read",
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

/** One connector the run should call through a specific user connection. */
export interface EvaluationConnection {
  /** The tool (connector) id, e.g. shared_office365. */
  connectorId: string;
  /** The user connection id to run it with. */
  connectionId: string;
  /** The connection reference name in the agent definition, when the tool is bound through one. */
  connectionReferenceName?: string;
}

/** The connections to use for one agent's tools during a run: the evaluated agent, or a connected child agent. */
export interface EvaluationToolsConnections {
  /** Dataverse bot id; defaults to the evaluated agent. */
  botId?: string;
  botSchemaName?: string;
  connections: EvaluationConnection[];
}

export interface StartRunOptions {
  /** Score the published agent instead of the draft. Default false. */
  runOnPublishedBot?: boolean;
  evaluationRunName?: string;
  /**
   * The Copilot Studio (MCS) connection id of the user profile the run should
   * sign in as, so authenticated knowledge and tools work. Empty runs anonymously.
   */
  mcsConnectionId?: string;
  /** Per-tool connection bindings for the run. */
  toolsConnections?: EvaluationToolsConnections[];
}

/** The request body `startRun` sends, kept separate so a test can pin it. */
export function runRequestBody(opts: StartRunOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { runOnPublishedBot: Boolean(opts.runOnPublishedBot) };
  if (opts.evaluationRunName) body.evaluationRunName = opts.evaluationRunName;
  if (opts.mcsConnectionId) body.mcsConnectionId = opts.mcsConnectionId;
  if (opts.toolsConnections?.length) {
    body.toolsConnections = opts.toolsConnections.map((t) => ({
      ...(t.botId ? { botId: t.botId } : {}),
      ...(t.botSchemaName ? { botSchemaName: t.botSchemaName } : {}),
      connections: t.connections.map((c) => ({
        connectorId: c.connectorId,
        connectionId: c.connectionId,
        ...(c.connectionReferenceName ? { connectionReferenceName: c.connectionReferenceName } : {}),
      })),
    }));
  }
  return body;
}

export async function startRun(
  token: string,
  environmentId: string,
  botId: string,
  testSetId: string,
  opts: StartRunOptions = {},
  fetchImpl?: FetchLike,
): Promise<TestRun> {
  const data = await requestJson<Record<string, unknown>>(v(`${base(environmentId, botId)}/testsets/${encodeURIComponent(testSetId)}/run`), {
    method: "POST",
    token,
    body: runRequestBody(opts),
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

/** Run states the service reports as final, in either `state` or `executionState`. */
export const TERMINAL_RUN_STATES = /^(completed|succeeded|failed|cancelled|canceled|abandoned|deleted|error)$/i;

export function runIsFinished(run: Pick<TestRun, "state" | "executionState">): boolean {
  return TERMINAL_RUN_STATES.test(run.state ?? "") || TERMINAL_RUN_STATES.test(run.executionState ?? "");
}

/**
 * The agent content a run was scored against, as the service zipped it: what
 * "the agent at the time of the run" actually was, for comparing with the
 * workspace now. UNVERIFIED live.
 */
export async function downloadSnapshot(token: string, environmentId: string, botId: string, runId: string, fetchImpl?: FetchLike): Promise<BytesResponse> {
  return requestBytes(v(`${base(environmentId, botId)}/testruns/${encodeURIComponent(runId)}/snapshot`), {
    token,
    fetchImpl,
    hints: { ...HINTS, 404: "no evaluation run with that id for this agent (cs_list_evaluation_runs)" },
  });
}

export interface ConnectorConsentBypass {
  /** true: end users are not asked to consent to the agent's connectors. */
  adminConsentBypass: boolean | null;
  raw?: unknown;
}

function toConsentBypass(r: Record<string, unknown> | null): ConnectorConsentBypass {
  return { adminConsentBypass: typeof r?.adminConsentBypass === "boolean" ? r.adminConsentBypass : null, raw: r ?? undefined };
}

/** Whether an admin has switched connector consent bypass on for the agent. UNVERIFIED live. */
export async function getConnectorConsentBypass(token: string, environmentId: string, botId: string, fetchImpl?: FetchLike): Promise<ConnectorConsentBypass> {
  const data = await requestJson<Record<string, unknown>>(v(`${botBase(environmentId, botId)}/connectorConsentBypass`), { token, fetchImpl, hints: ADMIN_HINTS });
  return toConsentBypass(data);
}

/** Switch connector consent bypass on or off. A PUT, but a write, so it is never retried. UNVERIFIED live. */
export async function setConnectorConsentBypass(token: string, environmentId: string, botId: string, enabled: boolean, fetchImpl?: FetchLike): Promise<ConnectorConsentBypass> {
  const data = await requestJson<Record<string, unknown>>(v(`${botBase(environmentId, botId)}/connectorConsentBypass`), {
    method: "PUT",
    token,
    body: { adminConsentBypass: enabled },
    fetchImpl,
    hints: ADMIN_HINTS,
  });
  // The service echoes the setting; an empty reply means it accepted what was sent.
  return data ? toConsentBypass(data) : { adminConsentBypass: enabled };
}

/** The channels the manifest download supports. The reference names only M365 today. */
export const MANIFEST_CHANNELS = ["M365"] as const;
export type ManifestChannel = (typeof MANIFEST_CHANNELS)[number];

/**
 * The channel app package (manifest plus icons) for an agent, zipped: what the
 * portal's "Download .zip" on the Teams / Microsoft 365 channel gives. UNVERIFIED live.
 */
export async function downloadChannelManifest(
  token: string,
  environmentId: string,
  agentId: string,
  opts: { channel?: ManifestChannel; includeAgentSchema?: boolean } = {},
  fetchImpl?: FetchLike,
): Promise<BytesResponse> {
  const channel = opts.channel ?? "M365";
  const url = `${HOST}/environments/${encodeURIComponent(environmentId)}/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channel)}/download`;
  return requestBytes(v(opts.includeAgentSchema ? `${url}?includeAgentSchema=true` : url), {
    token,
    fetchImpl,
    hints: {
      403: "the signed-in user needs maker access to this agent, and the agent must be published to the Microsoft 365 / Teams channel",
      404: "no manifest for this agent and channel: publish the agent to the Microsoft 365 / Teams channel first, or check the agent id",
    },
  });
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

type MetricBucket = { passed: number; failed: number; errored: number; other: number };

/** Which bucket one metric result falls into. A reported error beats an unrecognised status. */
function metricOutcome(m: { status?: string | null; errorReason?: string | null }): keyof MetricBucket {
  const st = m.status ?? "";
  if (PASS.test(st)) return "passed";
  if (FAIL.test(st)) return "failed";
  if (ERR.test(st) || m.errorReason) return "errored";
  return "other";
}

/**
 * One test case: its metrics, counted into the per-metric buckets, and the
 * verdict for the case as a whole. A case passes only when every metric passed
 * and there was at least one; otherwise an error outranks a failure, which
 * outranks an unrecognised status.
 */
function summarizeCase(tc: TestCaseResult, byMetric: Record<string, MetricBucket>): { verdict: keyof MetricBucket; entry: RunSummary["cases"][number] } {
  const outcomes: (keyof MetricBucket)[] = [];
  const metrics = tc.metricsResults.map((m) => {
    const bucket = (byMetric[m.type] ??= { passed: 0, failed: 0, errored: 0, other: 0 });
    const outcome = metricOutcome(m);
    bucket[outcome]++;
    outcomes.push(outcome);
    return { type: m.type, status: m.status, reason: m.errorReason ?? m.aiResultReason ?? null };
  });
  const allPassed = outcomes.length > 0 && outcomes.every((o) => o === "passed");
  const verdict: keyof MetricBucket = allPassed ? "passed" : outcomes.includes("errored") ? "errored" : outcomes.includes("failed") ? "failed" : "other";
  return { verdict, entry: { testCaseId: tc.testCaseId, state: tc.state, metrics } };
}

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
    const { verdict, entry } = summarizeCase(tc, summary.byMetric);
    summary[verdict]++;
    summary.cases.push(entry);
  }
  return summary;
}
