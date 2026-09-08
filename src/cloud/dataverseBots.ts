/**
 * The bot tables: agents (`bot`), their components (`botcomponent`), and
 * publishing through the `PvaPublish` bound action.
 */
import { HttpError, requestJson, type FetchLike } from "./http.js";
import { FORMATTED_HEADERS, ODATA_HEADERS, api, formatted } from "./dataverseApi.js";

export interface BotRow {
  botId: string;
  name: string;
  schemaName: string | null;
  ownerId: string | null;
  ownedByCurrentUser: boolean;
  publishedOn: string | null;
  modifiedOn: string | null;
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
  opts: { ownerOnly?: boolean; includeManaged?: boolean; fetchImpl?: FetchLike } = {},
): Promise<BotRow[]> {
  const me = await whoAmI(envUrl, token, opts.fetchImpl);
  const select = "botid,name,schemaname,_ownerid_value,publishedon,modifiedon,authenticationmode,ismanaged";
  const filters: string[] = [];
  if (!opts.includeManaged) filters.push("ismanaged eq false");
  if (opts.ownerOnly) filters.push(`_ownerid_value eq ${me.userId}`);
  const filter = filters.length ? `&$filter=${encodeURIComponent(filters.join(" and "))}` : "";
  const url = `${api(envUrl)}/bots?$select=${encodeURIComponent(select)}${filter}&$orderby=name`;
  const data = await requestJson<{ value?: Record<string, unknown>[] }>(url, { token, fetchImpl: opts.fetchImpl, headers: ODATA_HEADERS });
  return (data?.value ?? []).map((b) => ({
    botId: String(b.botid),
    name: String(b.name ?? ""),
    schemaName: (b.schemaname as string | null) ?? null,
    ownerId: (b._ownerid_value as string | null) ?? null,
    ownedByCurrentUser: b._ownerid_value === me.userId,
    publishedOn: (b.publishedon as string | null) ?? null,
    modifiedOn: (b.modifiedon as string | null) ?? null,
    authenticationMode: typeof b.authenticationmode === "number" ? b.authenticationmode : null,
    isManaged: typeof b.ismanaged === "boolean" ? b.ismanaged : null,
  }));
}


export interface BotDetails {
  botId: string;
  name: string;
  schemaName: string | null;
  publishedOn: string | null;
  modifiedOn: string | null;
  /** Display name of the user who last changed the bot row (formatted value), when returned. */
  modifiedBy: string | null;
  authenticationMode: number | null;
}

export async function getBot(envUrl: string, token: string, botId: string, fetchImpl?: FetchLike): Promise<BotDetails> {
  const select = "botid,name,schemaname,publishedon,modifiedon,_modifiedby_value,authenticationmode";
  const b = await requestJson<Record<string, unknown>>(`${api(envUrl)}/bots(${botId})?$select=${select}`, { token, fetchImpl, headers: FORMATTED_HEADERS });
  if (!b) throw new Error(`Bot ${botId} not found`);
  return {
    botId: String(b.botid),
    name: String(b.name ?? ""),
    schemaName: (b.schemaname as string | null) ?? null,
    publishedOn: (b.publishedon as string | null) ?? null,
    modifiedOn: (b.modifiedon as string | null) ?? null,
    modifiedBy: formatted(b, "_modifiedby_value"),
    authenticationMode: typeof b.authenticationmode === "number" ? b.authenticationmode : null,
  };
}

export interface BotComponentRow {
  componentId: string;
  name: string;
  schemaName: string | null;
  componentType: number | null;
  /** Option-set label from the formatted value (e.g. "Topic", "Knowledge Source"), when returned. */
  componentTypeLabel: string | null;
  modifiedOn: string | null;
  modifiedBy: string | null;
  modifiedById: string | null;
  state: number | null;
}

function toComponentRow(c: Record<string, unknown>): BotComponentRow {
  return {
    componentId: String(c.botcomponentid),
    name: String(c.name ?? ""),
    schemaName: (c.schemaname as string | null) ?? null,
    componentType: typeof c.componenttype === "number" ? c.componenttype : null,
    componentTypeLabel: formatted(c, "componenttype"),
    modifiedOn: (c.modifiedon as string | null) ?? null,
    modifiedBy: formatted(c, "_modifiedby_value"),
    modifiedById: (c._modifiedby_value as string | null) ?? null,
    state: typeof c.statecode === "number" ? c.statecode : null,
  };
}

/**
 * Every component row (topics, knowledge sources, tools, triggers, variables, ...)
 * of one agent with its modification stamp. The bot-to-component link is the
 * `bot_botcomponent` relationship; the navigation form is tried first and the
 * `parentbotid` filter second, because which one an environment accepts has not
 * been verified live. Follows `@odata.nextLink` paging.
 */
export async function listBotComponents(envUrl: string, token: string, botId: string, fetchImpl?: FetchLike): Promise<BotComponentRow[]> {
  const select = "botcomponentid,name,schemaname,componenttype,modifiedon,_modifiedby_value,statecode";
  const candidates = [
    `${api(envUrl)}/bots(${botId})/bot_botcomponent?$select=${select}&$orderby=modifiedon desc`,
    `${api(envUrl)}/botcomponents?$select=${select}&$filter=${encodeURIComponent(`_parentbotid_value eq ${botId}`)}&$orderby=modifiedon desc`,
  ];
  let lastError: unknown = null;
  for (const first of candidates) {
    try {
      const rows: BotComponentRow[] = [];
      let url: string | null = first;
      while (url) {
        const data: { value?: Record<string, unknown>[]; "@odata.nextLink"?: string } | null = await requestJson(url, { token, fetchImpl, headers: FORMATTED_HEADERS });
        rows.push(...(data?.value ?? []).map(toComponentRow));
        url = data?.["@odata.nextLink"] ?? null;
      }
      return rows;
    } catch (err) {
      lastError = err;
      if (!(err instanceof HttpError) || (err.status !== 400 && err.status !== 404)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("listBotComponents failed");
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
