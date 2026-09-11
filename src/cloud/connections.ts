/**
 * Connections: the authorised accounts a flow or a tool actually calls with.
 *
 * A connection is not a connector. The connector (`shared_office365`) is the
 * definition; the connection is one person's authorised instance of it, and a
 * flow's connection reference has to name one before the flow can be switched
 * on. They live in the Power Apps API next to the connector registry
 * (`src/catalog.ts`) and take the same token.
 *
 * `pac connection list` returns the same inventory and `cs_list_connections`
 * exposes it; this exists because binding has to match a connection to one
 * connector programmatically, which means the connector id as the service
 * spells it rather than a display name in a table.
 */
import { requestJson, type FetchLike } from "./http.js";

const POWERAPPS_API = "https://api.powerapps.com";
const API_VERSION = "2016-11-01";

export interface ConnectionRow {
  /** The short name the flow's `connectionName` refers to, usually a hex string. */
  name: string;
  /** Full resource id: /providers/Microsoft.PowerApps/apis/<connector>/connections/<name>. */
  id: string;
  /** e.g. shared_office365. */
  connectorId: string;
  displayName: string | null;
  /** "Connected" when it is usable; "Error" when the account has to sign in again. */
  status: string | null;
  statusDetail: string | null;
  createdBy: string | null;
}

function connectorFromApiId(apiId: string | null | undefined, fallback: string): string {
  const m = /\/apis\/([^/?]+)/.exec(apiId ?? "");
  return m ? m[1] : fallback;
}

function toRow(c: Record<string, unknown>, connectorId: string): ConnectionRow {
  const p = (c.properties ?? {}) as Record<string, unknown>;
  const apiId = ((p.apiId as string | undefined) ?? (asRecord(p.api)?.id as string | undefined)) ?? null;
  const statuses = (p.statuses ?? []) as { status?: string; error?: { message?: string } }[];
  const createdBy = asRecord(p.createdBy);
  return {
    name: String(c.name ?? ""),
    id: String(c.id ?? ""),
    connectorId: connectorFromApiId(apiId, connectorId),
    displayName: (p.displayName as string | null) ?? null,
    status: statuses[0]?.status ?? null,
    statusDetail: statuses.find((s) => s.error?.message)?.error?.message ?? null,
    createdBy: (createdBy?.userPrincipalName as string | undefined) ?? (createdBy?.displayName as string | undefined) ?? null,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** True when the connection can be used right now, rather than needing the owner to sign in again. */
export function isUsable(c: ConnectionRow): boolean {
  return c.status === null || /^connected$/i.test(c.status);
}

/**
 * Connections in one environment, for one connector or all of them.
 *
 * The per-connector route is the reliable one; there is no environment-wide
 * connections route under the Process Simple provider, which is why a caller
 * that wants everything pays one request per connector instead.
 */
export async function listConnections(token: string, environmentId: string, opts: { connectorId?: string; fetchImpl?: FetchLike } = {}): Promise<ConnectionRow[]> {
  const filter = encodeURIComponent(`environment eq '${environmentId}'`);
  const first = opts.connectorId
    ? `${POWERAPPS_API}/providers/Microsoft.PowerApps/apis/${encodeURIComponent(opts.connectorId)}/connections?api-version=${API_VERSION}&$filter=${filter}`
    : `${POWERAPPS_API}/providers/Microsoft.PowerApps/connections?api-version=${API_VERSION}&$filter=${filter}`;
  const out: ConnectionRow[] = [];
  let next: string | null = first;
  let guard = 0;
  while (next && guard++ < 50) {
    const page: { value?: Record<string, unknown>[]; nextLink?: string } | null = await requestJson<{ value?: Record<string, unknown>[]; nextLink?: string }>(next, {
      token,
      fetchImpl: opts.fetchImpl,
      hints: {
        401: "token rejected for the Power Apps API; run cs_login",
        403: "the signed-in user cannot list connections in this environment",
        404: "environment not found, or the connector has no connections here",
      },
    });
    for (const c of page?.value ?? []) out.push(toRow(c, opts.connectorId ?? ""));
    next = page?.nextLink ?? null;
  }
  return out.sort((a, b) => a.connectorId.localeCompare(b.connectorId) || (a.displayName ?? "").localeCompare(b.displayName ?? ""));
}
