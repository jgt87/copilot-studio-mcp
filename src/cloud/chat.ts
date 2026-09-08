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
}

const sessions = new Map<string, DirectLineSession>();

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

  let conversationId = opts.conversationId;
  let session = conversationId ? sessions.get(conversationId) : undefined;
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
    const conv = await requestJson<{ conversationId?: string; token?: string }>(`${domain}/v3/directline/conversations`, { method: "POST", token, body: {}, fetchImpl });
    if (!conv?.conversationId) throw new Error("DirectLine did not return a conversationId");
    conversationId = conv.conversationId;
    session = { domain, token: conv.token ?? token };
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
