/**
 * Tools: conversation transcripts.
 *
 * What people actually asked a published agent, and how those sessions ended.
 * Every call here is read-only, and every outcome is a heuristic over the
 * transcript rather than something Dataverse reports; the tools say so in their
 * results so a caller does not quote them as facts.
 *
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { errorMessage } from "../log.js";
import { getToken } from "../auth.js";
import { dataverseScope, getTranscript, listTranscripts, questionsFromTranscripts, summarizeTranscripts, type Transcript } from "../cloud/dataverse.js";
import { buildTestSetCsv, evaluationPageUrl } from "../evals.js";
import { botArg, clientArg, cloudContext, envArg, fail, resolveRoot, server, tenantArg, text, workspaceArg } from "./shared.js";

// ---- conversation transcripts ---------------------------------------------

const transcriptArgs = { workspace: workspaceArg, environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg };

const HEURISTIC_NOTE =
  "Outcomes are derived from the transcript text, not reported by Copilot Studio: 'resolved' means nothing marked the session as failed, not that the user was satisfied. Read a transcript before acting on a number.";

/** Dataverse URL and token for the agent the caller means. */
async function transcriptContext(a: Record<string, unknown>): Promise<{ url: string; token: string; botId: string; environmentId: string | null }> {
  const ctx = await cloudContext(a, { dataverse: true, bot: true });
  const tok = await getToken(ctx.authCfg, [dataverseScope(ctx.dataverseUrl as string)]);
  return { url: ctx.dataverseUrl as string, token: tok.accessToken, botId: ctx.botId as string, environmentId: (ctx.environmentId as string) ?? null };
}

/** ISO timestamp `days` before now, for the OData window. */
function sinceIso(days?: number): string | undefined {
  if (!days) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function loadTranscripts(a: { days?: number; top?: number } & Record<string, unknown>): Promise<{ transcripts: Transcript[]; ctx: Awaited<ReturnType<typeof transcriptContext>> }> {
  const ctx = await transcriptContext(a);
  const transcripts = await listTranscripts(ctx.url, ctx.token, ctx.botId, { top: a.top ?? 100, since: sinceIso(a.days) });
  return { transcripts, ctx };
}

server.registerTool(
  "cs_list_transcripts",
  {
    title: "List conversation transcripts",
    description:
      "Sessions people had with the published agent, newest first: when, how many turns, the first thing the user asked, which topics and tools fired, and how the session ended. Read-only. Needs a cached cs_login. Use it to find the session behind a bad answer, then cs_get_transcript for the full turn list.",
    inputSchema: {
      ...transcriptArgs,
      days: z.number().optional().describe("Only sessions from the last N days"),
      top: z.number().optional().describe("Maximum sessions (default 100, max 500)"),
      outcome: z.enum(["escalated", "resolved", "unresolved", "abandoned", "unknown"]).optional().describe("Only sessions that ended this way"),
      search: z.string().optional().describe("Only sessions whose first user message contains this text"),
    },
  },
  async (a) => {
    try {
      const { transcripts } = await loadTranscripts(a);
      let rows = transcripts;
      if (a.outcome) rows = rows.filter((t) => t.outcome === a.outcome);
      if (a.search) rows = rows.filter((t) => (t.firstUserMessage ?? "").toLowerCase().includes((a.search as string).toLowerCase()));
      return text({
        count: rows.length,
        ofSessionsRead: transcripts.length,
        sessions: rows.map(({ turns_: _turns, ...s }) => s),
        note: HEURISTIC_NOTE,
        ...(transcripts.length === 0 ? { hint: "No transcripts. They exist only for a published agent that people have used, and the environment must have transcript storage on." } : {}),
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_get_transcript",
  {
    title: "Read one conversation transcript",
    description: "The full turn list of one session: who said what, in order, with the topic and tool attributed to each turn where the transcript records them. Read-only.",
    inputSchema: { ...transcriptArgs, transcriptId: z.string().describe("conversationtranscriptid, from cs_list_transcripts") },
  },
  async (a) => {
    try {
      const ctx = await transcriptContext(a);
      const t = await getTranscript(ctx.url, ctx.token, a.transcriptId);
      const { turns_, ...summary } = t;
      return text({ ...summary, turnList: turns_, note: HEURISTIC_NOTE });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_summarize_transcripts",
  {
    title: "Summarise how the agent is doing in production",
    description:
      "Aggregate over recent sessions: how they ended, the escalation rate, average turns, how many never matched a topic, the topics and tools that actually fire, and the questions behind the sessions that went badly. Read-only. This is the input for deciding what to fix next, and for cs_create_test_set_csv fromTranscripts.",
    inputSchema: { ...transcriptArgs, days: z.number().optional().describe("Window in days (default: everything returned)"), top: z.number().optional().describe("Maximum sessions to read (default 100, max 500)"), topN: z.number().optional().describe("How many topics/tools/questions to list (default 10)") },
  },
  async (a) => {
    try {
      const { transcripts } = await loadTranscripts(a);
      const stats = summarizeTranscripts(transcripts, a.topN ?? 10);
      return text({
        ...stats,
        note: HEURISTIC_NOTE,
        ...(stats.sessionsWithoutTopic > 0
          ? { hint: `${stats.sessionsWithoutTopic} session(s) matched no topic. Those questions are the gap: pass them to cs_create_test_set_csv with fromTranscripts, or add knowledge or a topic for them.` }
          : {}),
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_test_set_from_transcripts",
  {
    title: "Build an evaluation test set from real conversations",
    description:
      "Write the portal's import CSV from questions people actually asked, most frequent first, instead of guessing from the workspace. onlyFailed (default true) keeps the sessions that escalated, went unanswered or were abandoned, which are the ones worth turning into regression cases. Read-only apart from writing the file; import it once in the portal, then cs_run_evaluation automates the runs.",
    inputSchema: {
      ...transcriptArgs,
      days: z.number().optional().describe("Only sessions from the last N days"),
      top: z.number().optional().describe("Maximum sessions to read (default 100, max 500)"),
      onlyFailed: z.boolean().optional().describe("Default true: only sessions that escalated, went unresolved or were abandoned"),
      maxCases: z.number().optional().describe("Maximum cases in the CSV (portal limit is 100)"),
      outputPath: z.string().optional().describe("Default <workspace>/../<agent>-transcript-testset.csv"),
    },
  },
  async (a) => {
    try {
      const { transcripts, ctx } = await loadTranscripts(a);
      const onlyFailed = a.onlyFailed !== false;
      const questions = questionsFromTranscripts(transcripts, { onlyFailed, max: a.maxCases ?? 100 });
      if (questions.length === 0) {
        return text({
          cases: 0,
          sessionsRead: transcripts.length,
          hint: onlyFailed
            ? "No session ended badly in this window, so there is nothing to turn into a regression case. Widen 'days', or set onlyFailed: false to build from every question asked."
            : "No user questions in this window. Check that the agent is published and has been used.",
        });
      }
      const { csv, warnings } = buildTestSetCsv(questions.map((q) => ({ question: q.question })));
      const root = resolveRoot(a.workspace);
      const out = a.outputPath ?? path.join(path.dirname(root), `${path.basename(root)}-transcript-testset.csv`);
      fs.writeFileSync(out, csv, "utf8");
      return text({
        file: out,
        cases: questions.length,
        sessionsRead: transcripts.length,
        source: onlyFailed ? "sessions that escalated, went unresolved or were abandoned" : "every session with a user question",
        questions,
        warnings,
        importSteps: [
          ctx.environmentId && ctx.botId ? `Open ${evaluationPageUrl(ctx.environmentId, ctx.botId)} and go to the Evaluation tab` : "Open the agent in Copilot Studio and go to the Evaluation tab",
          "New evaluation > Single responses > Import > upload this CSV",
          "Fill in the expected responses for the cases you care about, then Save",
          "cs_list_test_sets shows the id; cs_run_evaluation runs it.",
        ],
        note: "The CSV has no expected responses: these are real questions, not answers. Add them in the portal for the Compare meaning and Exact match methods.",
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
