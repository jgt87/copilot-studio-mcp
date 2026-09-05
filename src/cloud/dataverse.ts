/**
 * Dataverse Web API calls the server needs: list agents (bots table), read one
 * bot, and publish via the PvaPublish bound action.
 */
import { requestJson, type FetchLike } from "./http.js";

export function dataverseScope(envUrl: string): string {
  return `${envUrl.replace(/\/+$/, "")}/.default`;
}

function api(envUrl: string): string {
  return `${envUrl.replace(/\/+$/, "")}/api/data/v9.2`;
}

const ODATA_HEADERS = { "OData-MaxVersion": "4.0", "OData-Version": "4.0" };

export interface BotRow {
  botId: string;
  name: string;
  schemaName: string | null;
  ownerId: string | null;
  ownedByCurrentUser: boolean;
  publishedOn: string | null;
  /** 1 = no auth, 2 = integrated (Entra SSO), 3 = manual */
  authenticationMode: number | null;
  isManaged: boolean | null;
}

export async function whoAmI(envUrl: string, token: string, fetchImpl?: FetchLike): Promise<{ userId: string; organizationId: string }> {
  const r = await requestJson<{ UserId: string; OrganizationId: string }>(`${api(envUrl)}/WhoAmI`, { token, fetchImpl, headers: ODATA_HEADERS });
  if (!r) throw new Error("WhoAmI returned no body");
  return { userId: r.UserId, organizationId: r.OrganizationId };
}

export async function listBots(
  envUrl: string,
  token: string,
  opts: { ownerOnly?: boolean; fetchImpl?: FetchLike } = {},
): Promise<BotRow[]> {
  const me = await whoAmI(envUrl, token, opts.fetchImpl);
  const select = "botid,name,schemaname,_ownerid_value,publishedon,authenticationmode,ismanaged";
  const filters = ["ismanaged eq false"];
  if (opts.ownerOnly) filters.push(`_ownerid_value eq ${me.userId}`);
  const url = `${api(envUrl)}/bots?$select=${encodeURIComponent(select)}&$filter=${encodeURIComponent(filters.join(" and "))}&$orderby=name`;
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(url, { token, fetchImpl: opts.fetchImpl, headers: ODATA_HEADERS });
  return (data?.value ?? []).map((b) => ({
    botId: String(b.botid),
    name: String(b.name ?? ""),
    schemaName: (b.schemaname as string | null) ?? null,
    ownerId: (b._ownerid_value as string | null) ?? null,
    ownedByCurrentUser: b._ownerid_value === me.userId,
    publishedOn: (b.publishedon as string | null) ?? null,
    authenticationMode: typeof b.authenticationmode === "number" ? b.authenticationmode : null,
    isManaged: typeof b.ismanaged === "boolean" ? b.ismanaged : null,
  }));
}

export interface BotDetails {
  botId: string;
  name: string;
  schemaName: string | null;
  publishedOn: string | null;
  authenticationMode: number | null;
}

export async function getBot(envUrl: string, token: string, botId: string, fetchImpl?: FetchLike): Promise<BotDetails> {
  const select = "botid,name,schemaname,publishedon,authenticationmode";
  const b = await requestJson<Record<string, unknown>>(`${api(envUrl)}/bots(${botId})?$select=${select}`, { token, fetchImpl, headers: ODATA_HEADERS });
  if (!b) throw new Error(`Bot ${botId} not found`);
  return {
    botId: String(b.botid),
    name: String(b.name ?? ""),
    schemaName: (b.schemaname as string | null) ?? null,
    publishedOn: (b.publishedon as string | null) ?? null,
    authenticationMode: typeof b.authenticationmode === "number" ? b.authenticationmode : null,
  };
}

export interface PublishResult {
  botId: string;
  previousPublishedOn: string | null;
  publishedOn: string | null;
  completed: boolean;
  durationMs: number;
}

/**
 * Trigger PvaPublish and poll `publishedon` until it changes. Returns
 * `completed: false` on timeout; the publish may still finish server-side.
 */
export async function publishBot(
  envUrl: string,
  token: string,
  botId: string,
  opts: { timeoutMs?: number; pollMs?: number; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PublishResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const before = await getBot(envUrl, token, botId, opts.fetchImpl);
  const started = Date.now();
  await requestJson(`${api(envUrl)}/bots(${botId})/Microsoft.Dynamics.CRM.PvaPublish`, {
    method: "POST",
    token,
    fetchImpl: opts.fetchImpl,
    headers: ODATA_HEADERS,
    body: {},
    timeoutMs: 120_000,
  });
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 10_000;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    const now = await getBot(envUrl, token, botId, opts.fetchImpl);
    if (now.publishedOn && now.publishedOn !== before.publishedOn) {
      return { botId, previousPublishedOn: before.publishedOn, publishedOn: now.publishedOn, completed: true, durationMs: Date.now() - started };
    }
  }
  return { botId, previousPublishedOn: before.publishedOn, publishedOn: null, completed: false, durationMs: Date.now() - started };
}
