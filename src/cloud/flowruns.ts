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
  trigger: { name?: string; status?: string; startTime?: string } | null;
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
    trigger: trigger ? { name: trigger.name as string | undefined, status: trigger.status as string | undefined, startTime: trigger.startTime as string | undefined } : null,
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
