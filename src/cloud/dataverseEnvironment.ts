/**
 * Environment-level configuration rows: connection references and environment
 * variables, the two things a solution import has to be told about.
 */
import { requestJson, type FetchLike } from "./http.js";
import { ODATA_HEADERS, api } from "./dataverseApi.js";

export interface ConnectionReferenceRow {
  logicalName: string;
  displayName: string | null;
  connectorId: string | null;
  connectionId: string | null;
}

export async function listConnectionReferences(envUrl: string, token: string, fetchImpl?: FetchLike): Promise<ConnectionReferenceRow[]> {
  const select = "connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid";
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(`${api(envUrl)}/connectionreferences?$select=${select}&$orderby=connectionreferencelogicalname`, { token, fetchImpl, headers: ODATA_HEADERS });
  return (data?.value ?? []).map((c) => ({
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
