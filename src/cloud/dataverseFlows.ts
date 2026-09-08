/**
 * Cloud flows: the `workflow` table (category 5), whose `clientdata` column
 * holds the Power Automate definition.
 */
import { requestJson, type FetchLike } from "./http.js";
import { FORMATTED_HEADERS, ODATA_HEADERS, api, formatted } from "./dataverseApi.js";

export interface FlowRow {
  workflowId: string;
  name: string;
  state: "Draft" | "Activated" | "Suspended" | string;
  modifiedOn: string | null;
  isManaged: boolean | null;
  description?: string | null;
  modifiedBy?: string | null;
  owner?: string | null;
}

/** statecode / statuscode pairs Dataverse expects for a cloud flow. */
export const FLOW_STATES = { on: { statecode: 1, statuscode: 2 }, off: { statecode: 0, statuscode: 1 } } as const;
export type FlowState = keyof typeof FLOW_STATES;
const FLOW_STATE_LABELS: Record<number, string> = { 0: "Draft", 1: "Activated", 2: "Suspended" };

function toFlowRow(w: Record<string, unknown>): FlowRow {
  return {
    workflowId: String(w.workflowid),
    name: String(w.name ?? ""),
    state: typeof w.statecode === "number" ? (FLOW_STATE_LABELS[w.statecode] ?? String(w.statecode)) : String(w.statecode ?? ""),
    modifiedOn: (w.modifiedon as string | null) ?? null,
    isManaged: typeof w.ismanaged === "boolean" ? w.ismanaged : null,
    description: (w.description as string | null) ?? null,
    modifiedBy: formatted(w, "_modifiedby_value"),
    owner: formatted(w, "_ownerid_value"),
  };
}

/**
 * Modern cloud flows (category 5) in the environment. `search` matches the
 * name, case-insensitively; `includeManaged` defaults to true because flows
 * that arrived with a managed solution are exactly the ones a deployment has
 * to switch on.
 */
export async function listFlows(
  envUrl: string,
  token: string,
  opts: { search?: string; includeManaged?: boolean; top?: number; fetchImpl?: FetchLike } = {},
): Promise<FlowRow[]> {
  const select = "workflowid,name,description,statecode,modifiedon,ismanaged,_modifiedby_value,_ownerid_value";
  const filters = ["category eq 5"];
  if (opts.includeManaged === false) filters.push("ismanaged eq false");
  if (opts.search) filters.push(`contains(name,'${opts.search.replace(/'/g, "''")}')`);
  const top = opts.top ? `&$top=${opts.top}` : "";
  const url = `${api(envUrl)}/workflows?$select=${select}&$filter=${encodeURIComponent(filters.join(" and "))}&$orderby=name${top}`;
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(url, { token, fetchImpl: opts.fetchImpl, headers: FORMATTED_HEADERS });
  return (data?.value ?? []).map(toFlowRow);
}

export interface FlowDetails extends FlowRow {
  /** Parsed `clientdata`: `properties.definition` is the Power Automate definition, plus its connection references. */
  clientData: Record<string, unknown> | null;
  /** Raw `clientdata` string, so an update can put back exactly what it did not touch. */
  clientDataRaw: string | null;
  triggers: string[];
  actions: string[];
  connectionReferences: string[];
}

function definitionOf(clientData: Record<string, unknown> | null): Record<string, unknown> | null {
  const props = (clientData?.properties ?? {}) as Record<string, unknown>;
  const def = props.definition;
  return def && typeof def === "object" ? (def as Record<string, unknown>) : null;
}

export async function getFlow(envUrl: string, token: string, workflowId: string, fetchImpl?: FetchLike): Promise<FlowDetails> {
  const select = "workflowid,name,description,statecode,modifiedon,ismanaged,clientdata,_modifiedby_value,_ownerid_value";
  const w = await requestJson<Record<string, unknown>>(`${api(envUrl)}/workflows(${workflowId})?$select=${select}`, { token, fetchImpl, headers: FORMATTED_HEADERS });
  if (!w) throw new Error(`Flow ${workflowId} not found`);
  const raw = (w.clientdata as string | null) ?? null;
  let clientData: Record<string, unknown> | null = null;
  if (raw) {
    try {
      clientData = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      clientData = null;
    }
  }
  const def = definitionOf(clientData);
  const props = (clientData?.properties ?? {}) as Record<string, unknown>;
  return {
    ...toFlowRow(w),
    clientData,
    clientDataRaw: raw,
    triggers: Object.keys((def?.triggers as Record<string, unknown> | undefined) ?? {}),
    actions: Object.keys((def?.actions as Record<string, unknown> | undefined) ?? {}),
    connectionReferences: Object.keys((props.connectionReferences as Record<string, unknown> | undefined) ?? {}),
  };
}

/**
 * Turn a flow on or off (`statecode`/`statuscode` on the workflow row).
 * Turning one on fails while its connection references are unbound, which is
 * the state flows land in after a solution import.
 */
/**
 * Create a cloud flow. A modern cloud flow is a `workflow` row with
 * `category` 5 and `type` 1 whose `clientdata` holds the definition;
 * `primaryentity` is "none" for flows that are not bound to a table. It is
 * created switched off, because a flow can only be activated once its
 * connection references are bound. `solutionUniqueName` puts it straight
 * into a solution (the `MSCRM.SolutionUniqueName` header).
 */
export async function createFlow(
  envUrl: string,
  token: string,
  spec: { name: string; definition?: Record<string, unknown>; clientData?: Record<string, unknown>; description?: string; solutionUniqueName?: string; connectionReferences?: Record<string, unknown> },
  fetchImpl?: FetchLike,
): Promise<{ workflowId: string | null; name: string; state: string; solution: string | null }> {
  if (!spec.definition && !spec.clientData) throw new Error("createFlow needs a definition (or a whole clientData document)");
  const clientData = spec.clientData ?? { properties: { connectionReferences: spec.connectionReferences ?? {}, definition: spec.definition } };
  const body: Record<string, unknown> = {
    name: spec.name,
    category: 5,
    type: 1,
    primaryentity: "none",
    statecode: FLOW_STATES.off.statecode,
    statuscode: FLOW_STATES.off.statuscode,
    clientdata: JSON.stringify(clientData),
    ...(spec.description ? { description: spec.description } : {}),
  };
  const created = await requestJson<Record<string, unknown>>(`${api(envUrl)}/workflows`, {
    method: "POST",
    token,
    fetchImpl,
    headers: { ...ODATA_HEADERS, Prefer: "return=representation", ...(spec.solutionUniqueName ? { "MSCRM.SolutionUniqueName": spec.solutionUniqueName } : {}) },
    body,
    hints: { 400: "Dataverse refused the flow; check the definition against the Power Automate schema and that the publisher prefix and solution exist" },
  });
  return {
    workflowId: created?.workflowid ? String(created.workflowid) : null,
    name: spec.name,
    state: "Draft",
    solution: spec.solutionUniqueName ?? null,
  };
}

export async function setFlowState(envUrl: string, token: string, workflowId: string, state: FlowState, fetchImpl?: FetchLike): Promise<{ workflowId: string; name: string; previousState: string; state: string }> {
  const before = await getFlow(envUrl, token, workflowId, fetchImpl);
  await requestJson(`${api(envUrl)}/workflows(${workflowId})`, {
    method: "PATCH",
    token,
    fetchImpl,
    headers: ODATA_HEADERS,
    body: FLOW_STATES[state],
    hints: { 400: "Dataverse refused the state change; a flow can only be turned on when its connection references are bound and its definition is valid" },
  });
  const after = await getFlow(envUrl, token, workflowId, fetchImpl);
  return { workflowId, name: before.name, previousState: before.state, state: after.state };
}

/**
 * Replace a flow's definition. `definition` swaps `properties.definition`
 * inside the existing `clientdata` and keeps everything else (connection
 * references above all); `clientData` replaces the whole document.
 */
export async function updateFlow(
  envUrl: string,
  token: string,
  workflowId: string,
  changes: { name?: string; description?: string; definition?: Record<string, unknown>; clientData?: Record<string, unknown> },
  fetchImpl?: FetchLike,
): Promise<{ workflowId: string; name: string; changed: string[] }> {
  const before = await getFlow(envUrl, token, workflowId, fetchImpl);
  const body: Record<string, unknown> = {};
  const changed: string[] = [];
  if (changes.name !== undefined) {
    body.name = changes.name;
    changed.push("name");
  }
  if (changes.description !== undefined) {
    body.description = changes.description;
    changed.push("description");
  }
  if (changes.clientData) {
    body.clientdata = JSON.stringify(changes.clientData);
    changed.push("clientData");
  } else if (changes.definition) {
    if (!before.clientData) throw new Error(`Flow ${workflowId} has no readable clientdata; pass the whole clientData instead of a definition`);
    const next = { ...before.clientData, properties: { ...((before.clientData.properties as Record<string, unknown>) ?? {}), definition: changes.definition } };
    body.clientdata = JSON.stringify(next);
    changed.push("definition");
  }
  if (!changed.length) throw new Error("Nothing to update: pass name, description, definition or clientData");
  await requestJson(`${api(envUrl)}/workflows(${workflowId})`, { method: "PATCH", token, fetchImpl, headers: ODATA_HEADERS, body, hints: { 400: "Dataverse refused the update; check the definition against the Power Automate schema and that the flow is unmanaged" } });
  return { workflowId, name: changes.name ?? before.name, changed };
}
