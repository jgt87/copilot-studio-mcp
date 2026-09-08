/**
 * Tools: chat / conversation tests.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import fs from "node:fs";
import { z } from "zod";


import { errorMessage, log } from "../log.js";

import { COPILOT_INVOKE_SCOPE, getToken } from "../auth.js";
import { dataverseScope, getBot } from "../cloud/dataverse.js";
import { chatDirectLine, chatSdk, directLineTokenEndpoint, type ChatResult } from "../cloud/chat.js";
import { CONVERSATION_TESTS_EXAMPLE, evaluateReplies, parseConversationTests, type ConversationTest } from "../evals.js";
import { CloudContext, backgroundArg, botArg, clientArg, cloudContext, envArg, fail, maybeBackground, server, tenantArg, text, workspaceArg } from "./shared.js";

type ChatArgs = { workspace?: string; conversationId?: string; transport?: string; tokenEndpoint?: string; directLineSecret?: string; environmentId?: string; schemaName?: string; tenantId?: string; clientId?: string; dataverseUrl?: string; botId?: string };
type ChatMode = "directline" | "sdk";

/** DirectLine target when the caller forced DirectLine or supplied its credentials. */
async function explicitDirectLineTarget(args: ChatArgs): Promise<{ tokenEndpoint?: string; secret?: string } | null> {
  const forced = args.transport === "directline" || Boolean(args.tokenEndpoint) || Boolean(args.directLineSecret);
  if (!forced) return null;
  if (args.tokenEndpoint || args.directLineSecret) return { tokenEndpoint: args.tokenEndpoint, secret: args.directLineSecret };
  const ctx = await cloudContext(args, { environment: true });
  const schemaName = args.schemaName ?? ctx.schemaName;
  if (!schemaName) throw new Error("schemaName is required for DirectLine (from settings.mcs.yml or pass it)");
  return { tokenEndpoint: directLineTokenEndpoint(ctx.environmentId as string, schemaName) };
}

/** Ask Dataverse which authentication mode the agent uses; falls back to DirectLine when that is not possible. */
async function detectChatMode(args: ChatArgs, ctx: CloudContext, schemaName: string | null): Promise<{ mode: ChatMode; schemaName: string | null }> {
  try {
    const c2 = await cloudContext(args, { environment: true, bot: true, dataverse: true });
    const dv = await getToken(ctx.authCfg, [dataverseScope(c2.dataverseUrl as string)]);
    const bot = await getBot(c2.dataverseUrl as string, dv.accessToken, c2.botId as string);
    const mode: ChatMode = bot.authenticationMode === 2 ? "sdk" : "directline";
    log(`agent ${bot.name} authenticationmode=${bot.authenticationMode} -> ${mode}`);
    return { mode, schemaName: schemaName ?? bot.schemaName };
  } catch (err) {
    log(`auth-mode detection skipped (${errorMessage(err)}); defaulting to DirectLine`);
    return { mode: "directline", schemaName };
  }
}

async function runChat(utterance: string, args: ChatArgs): Promise<ChatResult> {
  const explicit = await explicitDirectLineTarget(args);
  if (explicit) return chatDirectLine(utterance, { ...explicit, conversationId: args.conversationId });

  const ctx = await cloudContext(args, { environment: true });
  const requested = args.transport ?? "auto";
  const detected = requested === "auto" ? await detectChatMode(args, ctx, args.schemaName ?? ctx.schemaName ?? null) : { mode: (requested === "sdk" ? "sdk" : "directline") as ChatMode, schemaName: args.schemaName ?? ctx.schemaName ?? null };
  if (!detected.schemaName) throw new Error("schemaName is required (from settings.mcs.yml, Dataverse, or pass it)");
  if (detected.mode === "directline") {
    return chatDirectLine(utterance, { tokenEndpoint: directLineTokenEndpoint(ctx.environmentId as string, detected.schemaName), conversationId: args.conversationId });
  }
  const clientId = args.clientId ?? process.env.CPS_CLIENT_ID;
  if (!clientId) throw new Error("This agent uses Entra SSO (integrated authentication). Pass clientId of an app registration with the CopilotStudio.Copilots.Invoke delegated permission (redirect URI http://localhost).");
  const token = await getToken({ tenantId: ctx.tenantId, clientId }, [COPILOT_INVOKE_SCOPE]);
  return chatSdk(utterance, { environmentId: ctx.environmentId as string, schemaName: detected.schemaName, tenantId: ctx.tenantId === "organizations" ? undefined : ctx.tenantId, token: token.accessToken, conversationId: args.conversationId });
}

// ---- chat / conversation tests -------------------------------------------

const chatArgs = {
  workspace: workspaceArg,
  conversationId: z.string().optional().describe("Continue an earlier conversation from cs_chat"),
  transport: z.enum(["auto", "directline", "sdk"]).optional().describe("auto detects the agent's authentication mode via Dataverse; directline for no-auth/manual-auth agents; sdk for Entra SSO agents"),
  tokenEndpoint: z.string().optional().describe("Explicit DirectLine token endpoint"),
  directLineSecret: z.string().optional(),
  environmentId: envArg,
  botId: botArg,
  schemaName: z.string().optional(),
  dataverseUrl: z.string().optional(),
  tenantId: tenantArg,
  clientId: clientArg,
};

server.registerTool("cs_chat", { title: "Chat with the published agent", description: "Send one utterance to the published agent and return its replies (and raw activities). Use conversationId to continue. If the agent answers with a sign-in card, signInUrl is returned.", inputSchema: { utterance: z.string(), ...chatArgs, maxMs: z.number().optional().describe("How long to wait for replies, ms (default 25000, kept under the client call budget)"), background: backgroundArg } }, async (a) => {
  try {
    return await maybeBackground({ tool: "cs_chat", label: `chat: ${a.utterance.slice(0, 60)}`, background: a.background }, async () => {
      const r = await runChat(a.utterance, a);
      return {
        protocol: r.protocol,
        conversationId: r.conversationId,
        replies: r.replies,
        signInUrl: r.signInUrl,
        activityCount: r.activities.length,
        activities: r.activities.map((x) => ({ type: x.type, text: x.text, name: x.name, attachments: x.attachments?.map((at) => at.contentType), value: x.value })),
        // A silent agent and a broken route look identical without this.
        ...(r.replies.length === 0
          ? { note: `No reply within the poll budget over '${r.protocol}'. The agent may be slow, unpublished, or not reachable on this route: raise maxMs, or pass background: true and poll cs_job_status. For a DirectLine agent, passing directLineSecret bypasses the derived token endpoint and tells you which of the two is at fault.` }
          : {}),
      };
    });
  } catch (err) {
    return fail(errorMessage(err));
  }
});

server.registerTool(
  "cs_run_conversation_tests",
  {
    title: "Run local conversation tests",
    description: "Run a YAML test file (tests: name, utterance, expect {contains, containsAny, notContains, regex, minLength}, continueConversation) against the published agent through cs_chat and report pass/fail. The CLI-native complement to portal evaluations. Pass writeExample to create a starter file.",
    inputSchema: { file: z.string().optional(), tests: z.array(z.object({ name: z.string().optional(), utterance: z.string(), expect: z.record(z.unknown()).optional(), continueConversation: z.boolean().optional() })).optional(), writeExample: z.string().optional().describe("Path to write an example test file, then return"), stopOnFail: z.boolean().optional(), ...chatArgs },
  },
  async (a) => {
    try {
      if (a.writeExample) {
        fs.writeFileSync(a.writeExample, CONVERSATION_TESTS_EXAMPLE, "utf8");
        return text({ wrote: a.writeExample, example: CONVERSATION_TESTS_EXAMPLE });
      }
      let tests: ConversationTest[];
      if (a.file) tests = parseConversationTests(fs.readFileSync(a.file, "utf8")).tests;
      else if (a.tests?.length) tests = a.tests.map((t, i) => ({ name: t.name ?? `test ${i + 1}`, utterance: t.utterance, expect: (t.expect ?? {}) as ConversationTest["expect"], continueConversation: Boolean(t.continueConversation) }));
      else return fail("Pass file or tests (or writeExample)");
      const results: Record<string, unknown>[] = [];
      let conversationId: string | undefined;
      let passed = 0;
      for (const t of tests) {
        const started = Date.now();
        try {
          const r = await runChat(t.utterance, { ...a, conversationId: t.continueConversation ? conversationId : undefined });
          conversationId = r.conversationId;
          const ev = evaluateReplies(r.replies, t.expect ?? {}, r.signInUrl);
          if (ev.pass) passed++;
          results.push({ name: t.name, utterance: t.utterance, pass: ev.pass, failures: ev.failures, replies: r.replies, durationMs: Date.now() - started });
          if (!ev.pass && a.stopOnFail) break;
        } catch (err) {
          results.push({ name: t.name, utterance: t.utterance, pass: false, failures: [errorMessage(err)], durationMs: Date.now() - started });
          if (a.stopOnFail) break;
        }
      }
      return text({ total: tests.length, passed, failed: results.filter((r) => !r.pass).length, results });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
