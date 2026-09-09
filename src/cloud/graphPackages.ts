/**
 * Microsoft 365 Copilot Package Management API: the organisation's agent
 * catalogue.
 *
 *   https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages
 *
 * A "package" is an agent as Microsoft 365 sees it, which is a different view
 * from the Power Platform one the rest of this server uses. `cs_list_agents`
 * reads the Dataverse `bots` table of one environment; this reads every agent
 * in the tenant, whatever environment it came from, and adds the part Power
 * Platform cannot see: whether the agent actually reached users
 * (`availableTo`, `deployedTo`), whether an admin has blocked it, and which
 * hosts it surfaces in. `platform` distinguishes agents built in Copilot
 * Studio from ones built in the Microsoft 365 Copilot Agent Builder.
 *
 * Requires a Microsoft Agent 365 licence, and is global-cloud only (no GCC,
 * DoD or 21Vianet). Reads take the delegated `CopilotPackages.Read.All`
 * scope; block, unblock and reassign take `CopilotPackages.ReadWrite.All`
 * and exist only on `/beta`, so they are pinned there.
 *
 * UNVERIFIED against a live tenant: shapes come from the published reference,
 * not from a recorded response.
 */
import { requestJson, type FetchLike } from "./http.js";

/** Delegated read scope. Application permissions also exist for reads, but this server is delegated-only. */
export const GRAPH_PACKAGES_SCOPE = process.env.CPS_GRAPH_SCOPE ?? "https://graph.microsoft.com/CopilotPackages.Read.All";
/** Delegated write scope. Block, unblock and reassign have no application permission at all. */
export const GRAPH_PACKAGES_WRITE_SCOPE = process.env.CPS_GRAPH_WRITE_SCOPE ?? "https://graph.microsoft.com/CopilotPackages.ReadWrite.All";

const HOST = "https://graph.microsoft.com";

export type GraphVersion = "v1.0" | "beta";

/** Platform an agent was built with, as the catalogue reports it. */
export const PLATFORMS = ["Copilot Studio", "Microsoft 365 Copilot Agent Builder"] as const;
export const HOSTS = ["Copilot", "Outlook", "Teams", "M365"] as const;
export const ELEMENT_TYPES = ["Bots", "DeclarativeAgent", "CustomEngineAgent"] as const;

function base(version: GraphVersion): string {
  return `${HOST}/${version}/copilot/admin/catalog/packages`;
}

const HINTS = {
  400: "the catalogue rejected the query; only supportedHosts, elementTypes, lastModifiedDateTime and platform can be filtered",
  401: "token rejected for Microsoft Graph; run cs_login with scope 'graph'",
  403: "the signed-in user cannot read the agent catalogue: this needs a Microsoft Agent 365 licence and the CopilotPackages.Read.All permission consented for the app",
  404: "package not found in the organisation catalogue (cs_list_org_agents)",
};

export interface CopilotPackage {
  id: string;
  displayName: string | null;
  /** "custom" for agents built in the tenant, "external" for acquired ones. */
  type: string | null;
  shortDescription: string | null;
  isBlocked: boolean | null;
  supportedHosts: string[];
  elementTypes: string[];
  platform: string | null;
  publisher: string | null;
  /** Who may use it, and where an admin has deployed it: the two fields Power Platform cannot answer. */
  availableTo: string | null;
  deployedTo: string | null;
  version: string | null;
  manifestId: string | null;
  appId: string | null;
  lastModifiedDateTime: string | null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function toPackage(p: Record<string, unknown>): CopilotPackage {
  return {
    id: String(p.id ?? ""),
    displayName: str(p.displayName),
    type: str(p.type),
    shortDescription: str(p.shortDescription),
    isBlocked: typeof p.isBlocked === "boolean" ? p.isBlocked : null,
    supportedHosts: strings(p.supportedHosts),
    elementTypes: strings(p.elementTypes),
    platform: str(p.platform),
    publisher: str(p.publisher),
    availableTo: str(p.availableTo),
    deployedTo: str(p.deployedTo),
    version: str(p.version),
    manifestId: str(p.manifestId),
    appId: str(p.appId),
    lastModifiedDateTime: str(p.lastModifiedDateTime),
  };
}

export interface ListPackagesOptions {
  /** Exact platform string, e.g. "Copilot Studio". Omit for every platform. */
  platform?: string | null;
  /** One of HOSTS; matched with the `any` form the reference documents. */
  host?: string | null;
  /** One of ELEMENT_TYPES; matched with the `any` form. */
  elementType?: string | null;
  /** ISO instant; returns packages modified strictly after it. */
  modifiedSince?: string | null;
  /** Raw $filter, appended to whatever the options above build. */
  filter?: string | null;
  top?: number | null;
  /** Follow @odata.nextLink. Off by default so one call is one request. */
  allPages?: boolean;
  version?: GraphVersion;
  fetchImpl?: FetchLike;
}

/** OData literal: single quotes are escaped by doubling them. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function buildFilter(o: ListPackagesOptions): string | null {
  const parts: string[] = [];
  if (o.platform) parts.push(`platform eq ${quote(o.platform)}`);
  if (o.host) parts.push(`supportedHosts/any(h:h eq ${quote(o.host)})`);
  if (o.elementType) parts.push(`elementTypes/any(e:e eq ${quote(o.elementType)})`);
  if (o.modifiedSince) parts.push(`lastModifiedDateTime gt ${o.modifiedSince}`);
  if (o.filter) parts.push(`(${o.filter})`);
  return parts.length ? parts.join(" and ") : null;
}

export function listUrl(o: ListPackagesOptions = {}): string {
  const params: string[] = [];
  const filter = buildFilter(o);
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);
  if (o.top) params.push(`$top=${o.top}`);
  const url = base(o.version ?? "v1.0");
  return params.length ? `${url}?${params.join("&")}` : url;
}

/** Hard stop so a tenant with thousands of packages cannot run away with the call budget. */
const MAX_PAGES = 20;

export async function listPackages(token: string, o: ListPackagesOptions = {}): Promise<{ packages: CopilotPackage[]; pages: number; more: boolean }> {
  let url: string | null = listUrl(o);
  const out: CopilotPackage[] = [];
  let pages = 0;
  let more = false;
  while (url) {
    const data: { value?: Record<string, unknown>[]; "@odata.nextLink"?: string } | null = await requestJson(url, { token, fetchImpl: o.fetchImpl, hints: HINTS });
    pages += 1;
    for (const p of data?.value ?? []) out.push(toPackage(p));
    const next: string | null = data?.["@odata.nextLink"] ?? null;
    if (!next || !o.allPages) {
      more = Boolean(next);
      break;
    }
    if (pages >= MAX_PAGES) {
      more = true;
      break;
    }
    url = next;
  }
  return { packages: out, pages, more };
}

/**
 * One package with whatever extra detail the catalogue carries. The reference
 * documents a richer resource than the list rows, so the mapped fields are
 * returned alongside the raw body rather than instead of it.
 */
export async function getPackage(token: string, id: string, o: { version?: GraphVersion; fetchImpl?: FetchLike } = {}): Promise<{ package: CopilotPackage; raw: Record<string, unknown> }> {
  const url = `${base(o.version ?? "v1.0")}/${encodeURIComponent(id)}`;
  const data = await requestJson<Record<string, unknown>>(url, { token, fetchImpl: o.fetchImpl, hints: HINTS });
  const raw = data ?? {};
  return { package: toPackage(raw), raw };
}

/**
 * Block or unblock a package across the organisation. Blocking stops everyone
 * in the tenant from using the agent, so it is a governance action, not a
 * deployment one: it does not delete or unpublish anything.
 */
export async function setPackageBlocked(token: string, id: string, blocked: boolean, o: { fetchImpl?: FetchLike } = {}): Promise<{ id: string; blocked: boolean; status: string }> {
  const url = `${base("beta")}/${encodeURIComponent(id)}/${blocked ? "block" : "unblock"}`;
  await requestJson(url, { method: "POST", token, fetchImpl: o.fetchImpl, hints: HINTS });
  return { id, blocked, status: blocked ? "blocked" : "unblocked" };
}

/** Hand ownership of a package to another user, by their Entra object id. */
export async function reassignPackage(token: string, id: string, userId: string, o: { fetchImpl?: FetchLike } = {}): Promise<{ id: string; userId: string; status: string }> {
  const url = `${base("beta")}/${encodeURIComponent(id)}/reassign`;
  await requestJson(url, { method: "POST", token, body: { userId }, fetchImpl: o.fetchImpl, hints: HINTS });
  return { id, userId, status: "reassigned" };
}

/** Counts worth leading with when the catalogue is long. */
export function summarizePackages(packages: CopilotPackage[]): Record<string, unknown> {
  const by = (pick: (p: CopilotPackage) => string | null) => {
    const counts: Record<string, number> = {};
    for (const p of packages) {
      const k = pick(p);
      if (k) counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  };
  return {
    total: packages.length,
    blocked: packages.filter((p) => p.isBlocked === true).length,
    byPlatform: by((p) => p.platform),
    byDeployedTo: by((p) => p.deployedTo),
  };
}
