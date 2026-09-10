/**
 * Talk to a published agent. Two transports:
 *  - DirectLine v3 for agents with no authentication or manual authentication
 *    (token endpoint derived from environment id + schema name, no app needed)
 *  - Copilot Studio client SDK for Entra-SSO agents (needs a user token with
 *    the CopilotStudio.Copilots.Invoke scope from the caller's own app)
 */
import { requestJson, type FetchLike } from "./http.js";

export interface Activity {
  type?: string;
  id?: string;
  text?: string;
  speak?: string;
  from?: { id?: string; role?: string; name?: string };
  attachments?: { contentType?: string; content?: unknown }[];
  suggestedActions?: unknown;
  value?: unknown;
  name?: string;
  conversation?: { id?: string };
  [k: string]: unknown;
}

export interface ChatResult {
  protocol: "directline" | "sdk";
  conversationId: string;
  utterance: string;
  replies: string[];
  activities: Activity[];
  signInUrl: string | null;
  watermark?: string;
}

/** The environment-scoped DirectLine token endpoint for a Copilot Studio agent. */
export function directLineTokenEndpoint(environmentId: string, schemaName: string): string {
  const id = environmentId.replace(/-/g, "");
  const prefix = id.slice(0, -2);
  const suffix = id.slice(-2);
  return `https://${prefix}.${suffix}.environment.api.powerplatform.com/powervirtualagents/botsbyschema/${schemaName}/directline/token?api-version=2022-03-01-preview`;
}

export function findSignInUrl(activities: Activity[]): string | null {
  for (const a of activities) {
    for (const att of a.attachments ?? []) {
      if (att.contentType === "application/vnd.microsoft.card.signin" || att.contentType === "application/vnd.microsoft.card.oauth") {
        const c = att.content as { buttons?: { value?: string }[]; tokenExchangeResource?: { uri?: string } } | undefined;
        const url = c?.buttons?.[0]?.value ?? c?.tokenExchangeResource?.uri;
        if (url) return url;
      }
    }
  }
  return null;
}

export function botReplies(activities: Activity[]): string[] {
  return activities
    .filter((a) => a.type === "message" && a.from?.role !== "user" && typeof a.text === "string" && a.text.trim())
    .map((a) => a.text as string);
}

// ---------------------------------------------------------------------------
// DirectLine
// ---------------------------------------------------------------------------

interface DirectLineSession {
  domain: string;
  token: string;
  watermark?: string;
  /**
   * When the token stops being accepted. Absent when the session runs on a
   * DirectLine secret, which does not expire and cannot be refreshed.
   */
  expiresAt?: number;
  lastUsed: number;
}

const sessions = new Map<string, DirectLineSession>();

/**
 * How long an idle conversation is kept. DirectLine abandons a conversation
 * after about the same window, so a session older than this is already dead on
 * the service side; keeping it only leaks the token and the domain.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
/** A hard ceiling, so a burst of conversations cannot grow the map without bound. */
export const SESSION_MAX = 100;
/** Refresh this far ahead of expiry, so a slow poll cannot outlive the token. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** DirectLine's own default when a response omits expires_in. */
const DEFAULT_TOKEN_TTL_S = 1800;

/** Drop idle sessions, then the least recently used ones over the cap. */
function pruneSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
  }
  if (sessions.size > SESSION_MAX) {
    const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id] of oldestFirst.slice(0, sessions.size - SESSION_MAX)) sessions.delete(id);
  }
}

/** Forget one conversation. The next call with that id starts a new one. */
export function endDirectLineSession(conversationId: string): boolean {
  return sessions.delete(conversationId);
}

/** Live session count, for tests and diagnostics. */
export function directLineSessionCount(): number {
  return sessions.size;
}

/**
 * Trade a conversation token that is near expiry for a fresh one. DirectLine
 * tokens last about 30 minutes, and this server used to mint one per
 * conversation and keep it forever, so continuing a conversation past that
 * window failed with an authorisation error the caller could not act on.
 *
 * A session running on a raw secret has no expiry and is left alone. When the
 * refresh itself fails the session is dropped, because its token can no longer
 * be repaired and the caller needs to know the thread is gone rather than
 * receive a 403 from the next unrelated request.
 */
async function refreshIfNearExpiry(session: DirectLineSession, conversationId: string, fetchImpl?: FetchLike): Promise<void> {
  if (session.expiresAt === undefined) return;
  if (Date.now() < session.expiresAt - REFRESH_MARGIN_MS) return;
  try {
    const r = await requestJson<{ token?: string; expires_in?: number }>(`${session.domain}/v3/directline/tokens/refresh`, { method: "POST", token: session.token, fetchImpl });
    if (!r?.token) throw new Error("the refresh endpoint returned no token");
    session.token = r.token;
    session.expiresAt = Date.now() + (r.expires_in ?? DEFAULT_TOKEN_TTL_S) * 1000;
  } catch (err) {
    sessions.delete(conversationId);
    throw new Error(`The DirectLine token for conversation ${conversationId} expired and could not be refreshed (${err instanceof Error ? err.message : String(err)}). Call again without conversationId to start a new conversation; the previous thread's context is gone.`);
  }
}

async function regionalDomain(tokenEndpoint: string, fetchImpl?: FetchLike): Promise<string> {
  try {
    const origin = new URL(tokenEndpoint).origin;
    const data = await requestJson<{ channelUrlsById?: Record<string, string> }>(`${origin}/powervirtualagents/regionalchannelsettings?api-version=2022-03-01-preview`, { fetchImpl });
    const d = data?.channelUrlsById?.directline?.replace(/\/+$/, "");
    if (d) return d;
  } catch {
    // fall back
  }
  return "https://directline.botframework.com";
}

async function pollActivities(
  session: DirectLineSession,
  conversationId: string,
  opts: { idleMs: number; maxMs: number; fetchImpl?: FetchLike; sleep: (ms: number) => Promise<void> },
): Promise<Activity[]> {
  const started = Date.now();
  let lastActivity = Date.now();
  const collected: Activity[] = [];
  while (Date.now() - started < opts.maxMs) {
    const url = `${session.domain}/v3/directline/conversations/${conversationId}/activities${session.watermark ? `?watermark=${encodeURIComponent(session.watermark)}` : ""}`;
    const data = await requestJson<{ activities?: Activity[]; watermark?: string }>(url, { token: session.token, fetchImpl: opts.fetchImpl });
    if (data?.watermark) session.watermark = data.watermark;
    const fresh = (data?.activities ?? []).filter((a) => a.from?.role !== "user");
    if (fresh.length) {
      collected.push(...fresh);
      lastActivity = Date.now();
      if (fresh.some((a) => a.type === "endOfConversation") || findSignInUrl(fresh)) break;
    } else if (collected.length && Date.now() - lastActivity > opts.idleMs) {
      break;
    }
    await opts.sleep(800);
  }
  return collected;
}

export interface DirectLineChatOptions {
  tokenEndpoint?: string;
  secret?: string;
  domain?: string;
  conversationId?: string;
  idleMs?: number;
  maxMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export async function chatDirectLine(utterance: string, opts: DirectLineChatOptions): Promise<ChatResult> {
  const fetchImpl = opts.fetchImpl;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const idleMs = opts.idleMs ?? 2500;
  // MCP clients cut a tool call off at about 60s; a 45s poll plus the token
  // fetch and conversation start could exceed that, and the caller then saw a
  // client timeout rather than the agent's reply. Stay well inside the budget
  // by default and let a caller who is waiting on purpose raise it.
  const maxMs = opts.maxMs ?? 25_000;

  pruneSessions();
  let conversationId = opts.conversationId;
  let session = conversationId ? sessions.get(conversationId) : undefined;
  if (session && conversationId) await refreshIfNearExpiry(session, conversationId, fetchImpl);
  const startActivities: Activity[] = [];

  if (!session) {
    let token: string;
    let domain: string;
    if (opts.secret) {
      token = opts.secret;
      domain = opts.domain ?? "https://directline.botframework.com";
    } else if (opts.tokenEndpoint) {
      const t = await requestJson<{ token?: string }>(opts.tokenEndpoint, { fetchImpl });
      if (!t?.token) throw new Error("DirectLine token endpoint returned no token (is the agent published with the web channel enabled?)");
      token = t.token;
      domain = opts.domain ?? (await regionalDomain(opts.tokenEndpoint, fetchImpl));
    } else {
      throw new Error("Need tokenEndpoint or secret to start a DirectLine conversation");
    }
    const conv = await requestJson<{ conversationId?: string; token?: string; expires_in?: number }>(`${domain}/v3/directline/conversations`, { method: "POST", token, body: {}, fetchImpl });
    if (!conv?.conversationId) throw new Error("DirectLine did not return a conversationId");
    conversationId = conv.conversationId;
    // Only a conversation-scoped token expires; falling back to the secret does not.
    session = { domain, token: conv.token ?? token, lastUsed: Date.now(), ...(conv.token ? { expiresAt: Date.now() + (conv.expires_in ?? DEFAULT_TOKEN_TTL_S) * 1000 } : {}) };
    sessions.set(conversationId, session);
    await requestJson(`${domain}/v3/directline/conversations/${conversationId}/activities`, {
      method: "POST",
      token: session.token,
      body: { type: "event", name: "startConversation", from: { id: "user1", role: "user" } },
      fetchImpl,
    });
    startActivities.push(...(await pollActivities(session, conversationId, { idleMs: 1500, maxMs: 15_000, fetchImpl, sleep })));
  }
  const cid = conversationId as string;

  await requestJson(`${session.domain}/v3/directline/conversations/${cid}/activities`, {
    method: "POST",
    token: session.token,
    body: { type: "message", from: { id: "user1", role: "user" }, text: utterance },
    fetchImpl,
  });
  const replies = await pollActivities(session, cid, { idleMs, maxMs, fetchImpl, sleep });
  const all = [...startActivities, ...replies];
  session.lastUsed = Date.now();
  // The bot closed the thread: the session cannot be continued, so do not hold
  // its token until the idle sweep. A later call with this id starts a new one.
  if (all.some((a) => a.type === "endOfConversation")) sessions.delete(cid);
  return {
    protocol: "directline",
    conversationId: cid,
    utterance,
    replies: botReplies(replies),
    activities: all,
    signInUrl: findSignInUrl(all),
    watermark: session.watermark,
  };
}

// ---------------------------------------------------------------------------
// Copilot Studio client SDK
// ---------------------------------------------------------------------------

export interface SdkChatOptions {
  environmentId: string;
  schemaName: string;
  tenantId?: string;
  token: string;
  conversationId?: string;
}

export async function chatSdk(utterance: string, opts: SdkChatOptions): Promise<ChatResult> {
  const sdk = await import("@microsoft/agents-copilotstudio-client");
  const activityMod = await import("@microsoft/agents-activity");
  const client = new sdk.CopilotStudioClient(
    { environmentId: opts.environmentId, agentIdentifier: opts.schemaName, cloud: sdk.PowerPlatformCloud.Prod, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) } as never,
    opts.token,
  );
  let conversationId = opts.conversationId;
  const startActivities: Activity[] = [];
  if (!conversationId) {
    for await (const a of client.startConversationStreaming(true)) {
      const act = JSON.parse(JSON.stringify(a)) as Activity;
      startActivities.push(act);
      if (act.conversation?.id) conversationId = act.conversation.id;
    }
    if (!conversationId) throw new Error("Could not obtain a conversation id from the Copilot Studio client");
  }
  const message = activityMod.Activity.fromObject({ type: "message", text: utterance, conversation: { id: conversationId } });
  const replies: Activity[] = [];
  for await (const a of client.sendActivityStreaming(message, conversationId)) {
    replies.push(JSON.parse(JSON.stringify(a)) as Activity);
  }
  const all = [...startActivities, ...replies];
  return { protocol: "sdk", conversationId, utterance, replies: botReplies(replies), activities: all, signInUrl: findSignInUrl(all) };
}
