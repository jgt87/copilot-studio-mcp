/**
 * Environment-level configuration rows: connection references and environment
 * variables, the two things a solution import has to be told about.
 */
import { requestJson, type FetchLike } from "./http.js";
import { ODATA_HEADERS, api } from "./dataverseApi.js";

export interface ConnectionReferenceRow {
  /** Row id, needed to write the binding back. */
  id: string;
  logicalName: string;
  displayName: string | null;
  connectorId: string | null;
  connectionId: string | null;
}

export async function listConnectionReferences(envUrl: string, token: string, fetchImpl?: FetchLike): Promise<ConnectionReferenceRow[]> {
  const select = "connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid";
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(`${api(envUrl)}/connectionreferences?$select=${select}&$orderby=connectionreferencelogicalname`, { token, fetchImpl, headers: ODATA_HEADERS });
  return (data?.value ?? []).map((c) => ({
    id: String(c.connectionreferenceid ?? ""),
    logicalName: String(c.connectionreferencelogicalname ?? ""),
    displayName: (c.connectionreferencedisplayname as string | null) ?? null,
    connectorId: (c.connectorid as string | null) ?? null,
    connectionId: (c.connectionid as string | null) ?? null,
  }));
}

export interface EnvironmentVariableRow {
  schemaName: string;
  displayName: string | null;
  type: string | null;
  defaultValue: string | null;
  currentValue: string | null;
}

const ENV_VAR_TYPES: Record<number, string> = { 100000000: "String", 100000001: "Number", 100000002: "Boolean", 100000003: "JSON", 100000004: "DataSource", 100000005: "Secret" };

export async function listEnvironmentVariables(envUrl: string, token: string, fetchImpl?: FetchLike): Promise<EnvironmentVariableRow[]> {
  const url = `${api(envUrl)}/environmentvariabledefinitions?$select=schemaname,displayname,type,defaultvalue&$expand=environmentvariabledefinition_environmentvariablevalue($select=value)&$orderby=schemaname`;
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(url, { token, fetchImpl, headers: ODATA_HEADERS });
  return (data?.value ?? []).map((v) => {
    const values = (v.environmentvariabledefinition_environmentvariablevalue as { value?: string }[] | undefined) ?? [];
    return {
      schemaName: String(v.schemaname ?? ""),
      displayName: (v.displayname as string | null) ?? null,
      type: typeof v.type === "number" ? (ENV_VAR_TYPES[v.type] ?? String(v.type)) : null,
      defaultValue: (v.defaultvalue as string | null) ?? null,
      currentValue: values[0]?.value ?? null,
    };
  });
}

/**
 * Bind a connection reference to a connection.
 *
 * `connectionid` holds the connection's short name (the one
 * `cs_list_connections` shows), not its full resource id. This is the same
 * write a deployment settings file performs during a solution import, done
 * after the fact for a flow that arrived unbound.
 */
export async function bindConnectionReference(
  envUrl: string,
  token: string,
  logicalName: string,
  connectionId: string,
  fetchImpl?: FetchLike,
): Promise<{ logicalName: string; connectionId: string; previousConnectionId: string | null }> {
  const all = await listConnectionReferences(envUrl, token, fetchImpl);
  const row = all.find((c) => c.logicalName.toLowerCase() === logicalName.toLowerCase());
  if (!row) throw new Error(`No connection reference '${logicalName}' in this environment. cs_get_flow lists the ones a flow points at.`);
  await requestJson(`${api(envUrl)}/connectionreferences(${row.id})`, {
    method: "PATCH",
    token,
    fetchImpl,
    headers: ODATA_HEADERS,
    body: { connectionid: connectionId },
    hints: { 400: "Dataverse refused the binding; check the connection belongs to the same connector as the reference and is in this environment" },
  });
  return { logicalName: row.logicalName, connectionId, previousConnectionId: row.connectionId };
}
