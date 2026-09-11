/**
 * Power Automate (Process Simple) API: run history and starting a run.
 *
 * UNVERIFIED against a live tenant. Dataverse holds a flow's definition and
 * state, but not its runs, so these come from the service the Power Automate
 * portal itself calls:
 *
 *   https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple
 *     /environments/{environmentId}/flows/{flowId}/runs?api-version=2016-11-01
 *
 * The flow id is the Dataverse `workflowid`. The scope is the Flow service
 * (`CPS_FLOW_SCOPE` overrides it), which is a different resource from the
 * Power Platform API and Dataverse, so it needs its own consent.
 */
import { requestJson, type FetchLike } from "./http.js";

export const FLOW_SCOPE = process.env.CPS_FLOW_SCOPE ?? "https://service.flow.microsoft.com/.default";
const API_VERSION = "2016-11-01";
const HOST = "https://api.flow.microsoft.com";

function base(environmentId: string, flowId: string): string {
  return `${HOST}/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(environmentId)}/flows/${encodeURIComponent(flowId)}`;
}

const HINTS = {
  401: "token rejected for the Power Automate service; run cs_login with scope 'flow'",
  403: "the signed-in user cannot see this flow's runs; they need to be an owner or co-owner of the flow",
  404: "flow or environment not found; the flow id is the Dataverse workflowid (cs_list_flows)",
};

export interface FlowRun {
  id: string;
  name: string;
  status: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  /** Error of a failed run, when the service reports one. */
  error: { code?: string; message?: string } | null;
  /** `outputsLink` is what the trigger handed the flow: the run's input data. */
  trigger: { name?: string; status?: string; startTime?: string; code?: string; outputsLink?: ContentLink | null } | null;
}

function toRun(r: Record<string, unknown>): FlowRun {
  const p = (r.properties ?? {}) as Record<string, unknown>;
  const start = (p.startTime as string | null) ?? null;
  const end = (p.endTime as string | null) ?? null;
  const ms = start && end ? Date.parse(end) - Date.parse(start) : null;
  const trigger = (p.trigger ?? null) as Record<string, unknown> | null;
  const error = (p.error ?? null) as { code?: string; message?: string } | null;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    status: (p.status as string | null) ?? null,
    startTime: start,
    endTime: end,
    durationMs: Number.isFinite(ms as number) ? (ms as number) : null,
    error: error && (error.code || error.message) ? { code: error.code, message: error.message } : null,
    trigger: trigger
      ? {
          name: trigger.name as string | undefined,
          status: trigger.status as string | undefined,
          startTime: trigger.startTime as string | undefined,
          ...(typeof trigger.code === "string" ? { code: trigger.code } : {}),
          outputsLink: toLink(trigger.outputsLink),
        }
      : null,
  };
}

/** Most recent runs first, as the service returns them. `top` caps the page. */
export async function listFlowRuns(token: string, environmentId: string, flowId: string, opts: { top?: number; fetchImpl?: FetchLike } = {}): Promise<FlowRun[]> {
  const top = opts.top ? `&$top=${opts.top}` : "";
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(`${base(environmentId, flowId)}/runs?api-version=${API_VERSION}${top}`, { token, fetchImpl: opts.fetchImpl, hints: HINTS });
  return (data?.value ?? []).map(toRun);
}

export async function getFlowRun(token: string, environmentId: string, flowId: string, runId: string, fetchImpl?: FetchLike): Promise<FlowRun> {
  const r = await requestJson<Record<string, unknown>>(`${base(environmentId, flowId)}/runs/${encodeURIComponent(runId)}?api-version=${API_VERSION}`, { token, fetchImpl, hints: HINTS });
  if (!r) throw new Error(`Run ${runId} not found for flow ${flowId}`);
  return toRun(r);
}

/**
 * Start a run of a manually triggered flow. `triggerName` is the trigger key
 * inside the definition (`cs_get_flow` lists them); the usual names are
 * `manual` and `When_an_agent_calls_the_flow`. A flow whose trigger fires on
 * an event (a schedule, a new item) cannot be started this way.
 */
export async function startFlowRun(
  token: string,
  environmentId: string,
  flowId: string,
  opts: { triggerName?: string; payload?: Record<string, unknown>; fetchImpl?: FetchLike } = {},
): Promise<{ started: true; triggerName: string; response: unknown }> {
  const triggerName = opts.triggerName ?? "manual";
  const response = await requestJson(`${base(environmentId, flowId)}/triggers/${encodeURIComponent(triggerName)}/run?api-version=${API_VERSION}`, {
    method: "POST",
    token,
    fetchImpl: opts.fetchImpl,
    body: opts.payload ?? {},
    timeoutMs: 120_000,
    hints: { ...HINTS, 400: "the service refused the payload or the trigger name; cs_get_flow lists the trigger keys of this flow", 404: "trigger not found on this flow; only manually started flows can be run this way" },
  });
  return { started: true, triggerName, response: response ?? null };
}

// ---------------------------------------------------------------------------
// Action-level reads: what each step of a run did.
// ---------------------------------------------------------------------------

/**
 * A pointer to the inputs or outputs of one action. The service does not
 * inline them: it hands out a SAS-signed URI into blob storage, which expires
 * after a few days. `contentSize` is the byte count, so a caller can decline
 * to fetch a huge one.
 */
export interface ContentLink {
  uri: string;
  contentSize: number | null;
}

export interface RunAction {
  name: string;
  status: string | null;
  /** The service's short code, e.g. "ActionFailed", "Forbidden", "BadRequest". */
  code: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  /** Present for expression and orchestration failures; absent for most connector failures. */
  error: { code?: string; message?: string } | null;
  inputsLink: ContentLink | null;
  outputsLink: ContentLink | null;
  /** How many times the service retried this action before giving up. */
  retryCount: number;
}

function toLink(v: unknown): ContentLink | null {
  const l = v as { uri?: unknown; contentSize?: unknown } | null;
  return l && typeof l.uri === "string" ? { uri: l.uri, contentSize: typeof l.contentSize === "number" ? l.contentSize : null } : null;
}

function toAction(a: Record<string, unknown>): RunAction {
  const p = (a.properties ?? {}) as Record<string, unknown>;
  const start = (p.startTime as string | null) ?? null;
  const end = (p.endTime as string | null) ?? null;
  const ms = start && end ? Date.parse(end) - Date.parse(start) : null;
  const error = (p.error ?? null) as { code?: string; message?: string } | null;
  return {
    name: String(a.name ?? ""),
    status: (p.status as string | null) ?? null,
    code: (p.code as string | null) ?? null,
    startTime: start,
    endTime: end,
    durationMs: Number.isFinite(ms as number) ? (ms as number) : null,
    error: error && (error.code || error.message) ? { code: error.code, message: error.message } : null,
    inputsLink: toLink(p.inputsLink),
    outputsLink: toLink(p.outputsLink),
    retryCount: Array.isArray(p.retryHistory) ? p.retryHistory.length : 0,
  };
}

/**
 * Every action of one run, in the order the service lists them. Actions inside
 * a `foreach` or an `until` appear once, as the loop scope; their per-iteration
 * detail lives under `/actions/{name}/repetitions`, which this does not read.
 */
export async function listRunActions(token: string, environmentId: string, flowId: string, runId: string, opts: { fetchImpl?: FetchLike } = {}): Promise<RunAction[]> {
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(`${base(environmentId, flowId)}/runs/${encodeURIComponent(runId)}/actions?api-version=${API_VERSION}`, {
    token,
    fetchImpl: opts.fetchImpl,
    hints: { ...HINTS, 404: "run not found on this flow; cs_list_flow_runs shows the run ids" },
  });
  return (data?.value ?? []).map(toAction);
}

/** Refuse to pull more than this from a content link; the rest is truncated. */
export const MAX_CONTENT_BYTES = 64 * 1024;

export interface LinkContent {
  /** Parsed JSON when the blob held JSON, the raw text otherwise, null when it could not be read. */
  value: unknown;
  truncated: boolean;
  /** Why nothing was read: an expired signature, a blob that is too big, a transport failure. */
  error: string | null;
}

/**
 * Read what a content link points at.
 *
 * Two things make this its own function rather than a `requestJson` call.
 * The URI is already SAS-signed, and sending our bearer token to Azure Blob
 * on top of that makes it answer 400 ("Server failed to authenticate the
 * request"), so no Authorization header goes out. And the blob is whatever
 * the action produced: JSON usually, but plain text or XML when a connector
 * echoes a raw response, so a parse failure is content, not an error.
 */
export async function readContentLink(link: ContentLink | null, opts: { fetchImpl?: FetchLike; maxBytes?: number } = {}): Promise<LinkContent> {
  if (!link) return { value: null, truncated: false, error: "no content link on this action" };
  const maxBytes = opts.maxBytes ?? MAX_CONTENT_BYTES;
  if (link.contentSize !== null && link.contentSize > maxBytes) {
    return { value: null, truncated: true, error: `content is ${link.contentSize} bytes, over the ${maxBytes}-byte cap; open the run in Power Automate to see it` };
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  let res: Response;
  try {
    res = await fetchImpl(link.uri, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { value: null, truncated: false, error: `could not reach the content link: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    const expired = res.status === 403 || res.status === 404;
    return { value: null, truncated: false, error: expired ? `the content link returned ${res.status}: the run's inputs and outputs are kept for a limited time and this one has expired` : `the content link returned ${res.status}` };
  }
  const raw = await res.text().catch(() => "");
  const truncated = raw.length > maxBytes;
  const text = truncated ? raw.slice(0, maxBytes) : raw;
  if (!text.trim()) return { value: null, truncated, error: null };
  try {
    return { value: JSON.parse(text) as unknown, truncated, error: null };
  } catch {
    return { value: text, truncated, error: null };
  }
}
