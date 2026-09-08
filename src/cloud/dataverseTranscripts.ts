/**
 * Conversation transcripts (`conversationtranscript`): what people actually
 * said to a published agent, and what it said back.
 *
 * Copilot Studio writes one row per session with the activities in a JSON
 * `content` column. This module reads those rows and turns each into a turn
 * list the rest of the server can reason about; nothing here writes.
 *
 * Unverified live. The lookup from a transcript to its agent is the part most
 * likely to differ between environments, so `listTranscripts` tries the
 * documented shapes in turn and keeps the one the environment accepts, the way
 * `listBotComponents` does. The outcome fields are heuristics over the
 * activities, not something Dataverse reports: `outcome` says how a session
 * ended as far as the transcript shows, which is not the same as whether the
 * user got what they wanted.
 */
import { HttpError, requestJson, type FetchLike } from "./http.js";
import { ODATA_HEADERS, api } from "./dataverseApi.js";

export interface TranscriptTurn {
  role: "user" | "agent" | "event";
  text: string;
  timestamp: string | null;
  /** Topic or dialog the activity was attributed to, when the transcript says. */
  topic: string | null;
  /** Tool / action invoked on this turn, when the transcript says. */
  tool: string | null;
}

export type SessionOutcome = "escalated" | "resolved" | "unresolved" | "abandoned" | "unknown";

export interface TranscriptSummary {
  transcriptId: string;
  startedAt: string | null;
  createdOn: string | null;
  turns: number;
  userTurns: number;
  agentTurns: number;
  firstUserMessage: string | null;
  topics: string[];
  tools: string[];
  outcome: SessionOutcome;
  /** Why `outcome` says what it does, so a caller can judge the heuristic. */
  outcomeReason: string;
}

export interface Transcript extends TranscriptSummary {
  turns_: TranscriptTurn[];
}

const SELECT = "conversationtranscriptid,createdon,conversationstarttime,content,schematype,metadata";

/** The lookups Copilot Studio has used to tie a transcript to its agent. */
function transcriptUrls(envUrl: string, botId: string, top: number, since?: string): string[] {
  const base = `${api(envUrl)}/conversationtranscripts?$select=${SELECT}&$top=${top}&$orderby=createdon desc`;
  const window = since ? ` and createdon ge ${since}` : "";
  return [
    `${base}&$filter=${encodeURIComponent(`_bot_conversationtranscriptid_value eq ${botId}${window}`)}`,
    `${base}&$filter=${encodeURIComponent(`_regardingobjectid_value eq ${botId}${window}`)}`,
    `${api(envUrl)}/bots(${botId})/bot_conversationtranscript?$select=${SELECT}&$top=${top}&$orderby=createdon desc`,
  ];
}

/** A row's activities, whichever of the two content shapes the environment wrote. */
export function parseContent(content: unknown): Record<string, unknown>[] {
  if (!content) return [];
  let doc: unknown = content;
  if (typeof content === "string") {
    try {
      doc = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (Array.isArray(doc)) return doc as Record<string, unknown>[];
  const obj = doc as { activities?: unknown; Activities?: unknown };
  const activities = obj.activities ?? obj.Activities;
  return Array.isArray(activities) ? (activities as Record<string, unknown>[]) : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** The channel data Copilot Studio attaches: topic and tool names live here. */
function channelData(a: Record<string, unknown>): Record<string, unknown> {
  const cd = a.channelData ?? a.ChannelData;
  return cd && typeof cd === "object" ? (cd as Record<string, unknown>) : {};
}

function turnOf(a: Record<string, unknown>): TranscriptTurn | null {
  const type = str(a.type) ?? str(a.Type) ?? "";
  const from = (a.from ?? a.From) as { role?: string; id?: string; name?: string } | undefined;
  const role = str(from?.role)?.toLowerCase();
  const text = str(a.text) ?? str(a.Text) ?? "";
  const cd = channelData(a);
  const topic = str(cd.topicName) ?? str(cd.TopicName) ?? str((cd.enclosingScope as Record<string, unknown> | undefined)?.topicName) ?? null;
  const tool = str(cd.actionName) ?? str(cd.ActionName) ?? str(cd.toolName) ?? null;
  const timestamp = str(a.timestamp) ?? str(a.Timestamp) ?? null;
  if (type && type.toLowerCase() !== "message") {
    // Events carry the outcome markers even though they have no text.
    return { role: "event", text: str(cd.eventName) ?? str(a.name) ?? type, timestamp, topic, tool };
  }
  if (!text && !tool) return null;
  return { role: role === "user" ? "user" : "agent", text, timestamp, topic, tool };
}

const ESCALATION = /escalat|transfer|human agent|live agent/i;
const UNRESOLVED = /didn'?t (?:find|understand)|not sure|rephrase|couldn'?t find|no answer|unable to help/i;

/** How the session ended, as far as the activities show. A heuristic, and labelled as one. */
function outcomeOf(turns: TranscriptTurn[]): { outcome: SessionOutcome; outcomeReason: string } {
  const haystack = turns.map((t) => `${t.text} ${t.topic ?? ""}`).join(" \n ");
  if (ESCALATION.test(haystack)) return { outcome: "escalated", outcomeReason: "an escalation or transfer appears in the transcript" };
  const userTurns = turns.filter((t) => t.role === "user").length;
  if (userTurns === 0) return { outcome: "abandoned", outcomeReason: "the session has no user message" };
  if (UNRESOLVED.test(haystack)) return { outcome: "unresolved", outcomeReason: "the agent said it could not answer" };
  const last = [...turns].reverse().find((t) => t.role !== "event");
  if (last?.role === "user") return { outcome: "abandoned", outcomeReason: "the last turn is the user's, with no reply after it" };
  return { outcome: "resolved", outcomeReason: "the agent answered and nothing marks the session as failed; not a statement that the user was satisfied" };
}

export function summarizeTranscript(row: Record<string, unknown>): Transcript {
  const turns = parseContent(row.content).map(turnOf).filter((t): t is TranscriptTurn => t !== null);
  const userTurns = turns.filter((t) => t.role === "user");
  const { outcome, outcomeReason } = outcomeOf(turns);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  return {
    transcriptId: String(row.conversationtranscriptid ?? ""),
    startedAt: str(row.conversationstarttime),
    createdOn: str(row.createdon),
    turns: turns.length,
    userTurns: userTurns.length,
    agentTurns: turns.filter((t) => t.role === "agent").length,
    firstUserMessage: userTurns[0]?.text ?? null,
    topics: uniq(turns.map((t) => t.topic)),
    tools: uniq(turns.map((t) => t.tool)),
    outcome,
    outcomeReason,
    turns_: turns,
  };
}

export interface ListTranscriptOptions {
  top?: number;
  /** ISO date; only sessions created at or after it. */
  since?: string;
  fetchImpl?: FetchLike;
}

export async function listTranscripts(envUrl: string, token: string, botId: string, opts: ListTranscriptOptions = {}): Promise<Transcript[]> {
  const top = Math.min(Math.max(opts.top ?? 50, 1), 500);
  let lastError: unknown = null;
  for (const url of transcriptUrls(envUrl, botId, top, opts.since)) {
    try {
      const data = await requestJson<{ value?: Record<string, unknown>[] }>(url, { token, fetchImpl: opts.fetchImpl, headers: ODATA_HEADERS });
      return (data?.value ?? []).map(summarizeTranscript);
    } catch (err) {
      lastError = err;
      if (!(err instanceof HttpError) || (err.status !== 400 && err.status !== 404)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("listTranscripts failed");
}

export async function getTranscript(envUrl: string, token: string, transcriptId: string, fetchImpl?: FetchLike): Promise<Transcript> {
  const url = `${api(envUrl)}/conversationtranscripts(${transcriptId})?$select=${SELECT}`;
  const row = await requestJson<Record<string, unknown>>(url, { token, fetchImpl, headers: ODATA_HEADERS });
  if (!row) throw new Error(`Transcript ${transcriptId} returned no body`);
  return summarizeTranscript(row);
}

export interface TranscriptStats {
  sessions: number;
  window: { from: string | null; to: string | null };
  outcomes: Record<SessionOutcome, number>;
  escalationRate: number;
  averageUserTurns: number;
  /** Sessions that never reached a topic: the agent had nothing to match. */
  sessionsWithoutTopic: number;
  topTopics: { name: string; sessions: number }[];
  topTools: { name: string; sessions: number }[];
  /** First user messages from sessions that ended badly: the questions to fix first. */
  unansweredQuestions: { question: string; sessions: number; outcome: SessionOutcome }[];
}

function tally(values: string[]): { name: string; sessions: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([name, sessions]) => ({ name, sessions })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

const FAILED: SessionOutcome[] = ["escalated", "unresolved", "abandoned"];

export function summarizeTranscripts(transcripts: Transcript[], topN = 10): TranscriptStats {
  const outcomes: Record<SessionOutcome, number> = { escalated: 0, resolved: 0, unresolved: 0, abandoned: 0, unknown: 0 };
  for (const t of transcripts) outcomes[t.outcome]++;
  const dates = transcripts.map((t) => t.createdOn ?? t.startedAt).filter((d): d is string => Boolean(d)).sort();
  const failedQuestions = transcripts.filter((t) => FAILED.includes(t.outcome) && t.firstUserMessage);
  const byQuestion = new Map<string, { question: string; sessions: number; outcome: SessionOutcome }>();
  for (const t of failedQuestions) {
    const key = (t.firstUserMessage as string).trim().toLowerCase();
    const seen = byQuestion.get(key);
    if (seen) seen.sessions++;
    else byQuestion.set(key, { question: t.firstUserMessage as string, sessions: 1, outcome: t.outcome });
  }
  return {
    sessions: transcripts.length,
    window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    outcomes,
    escalationRate: transcripts.length ? Number((outcomes.escalated / transcripts.length).toFixed(3)) : 0,
    averageUserTurns: transcripts.length ? Number((transcripts.reduce((n, t) => n + t.userTurns, 0) / transcripts.length).toFixed(2)) : 0,
    sessionsWithoutTopic: transcripts.filter((t) => t.topics.length === 0).length,
    topTopics: tally(transcripts.flatMap((t) => t.topics)).slice(0, topN),
    topTools: tally(transcripts.flatMap((t) => t.tools)).slice(0, topN),
    unansweredQuestions: [...byQuestion.values()].sort((a, b) => b.sessions - a.sessions).slice(0, topN),
  };
}

/**
 * The questions real users asked, most frequent first, for an evaluation test
 * set. `onlyFailed` keeps the ones the agent did not answer well, which is the
 * set worth turning into regression cases.
 */
export function questionsFromTranscripts(transcripts: Transcript[], opts: { onlyFailed?: boolean; max?: number } = {}): { question: string; sessions: number }[] {
  const pool = opts.onlyFailed ? transcripts.filter((t) => FAILED.includes(t.outcome)) : transcripts;
  const counts = new Map<string, { question: string; sessions: number }>();
  for (const t of pool) {
    const q = t.firstUserMessage?.trim();
    if (!q) continue;
    const key = q.toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.sessions++;
    else counts.set(key, { question: q, sessions: 1 });
  }
  return [...counts.values()].sort((a, b) => b.sessions - a.sessions || a.question.localeCompare(b.question)).slice(0, opts.max ?? 100);
}
