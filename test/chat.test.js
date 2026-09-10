/**
 * DirectLine session lifecycle: what the server keeps between calls, and for
 * how long. Sessions used to be held in a Map that was written and never swept,
 * so every conversation leaked its token and domain for the life of the
 * process, and a conversation continued past the token's ~30 minute life failed
 * with an authorisation error the caller could not act on.
 *
 * Time is controlled rather than waited out: `sleep` advances a fake clock that
 * Date.now reads, so the poll loops terminate immediately and the 30 minute
 * idle window is a real assertion instead of a constant. Every test drives
 * chatDirectLine with a recorded fetch, so nothing here reaches a tenant.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { chatDirectLine, directLineSessionCount, endDirectLineSession, SESSION_IDLE_MS } from "../dist/cloud/chat.js";

const realNow = Date.now;
let clock = 1_700_000_000_000;

beforeEach(() => {
  clock = 1_700_000_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

/** Advancing the clock is what waiting means here. */
const sleep = (ms) => {
  clock += ms;
  return Promise.resolve();
};
const advance = (ms) => {
  clock += ms;
};

const TOKEN_ENDPOINT = "https://x.y.environment.api.powerplatform.com/t";

/**
 * A DirectLine stand-in. `tokenTtlS` is what the conversation start reports as
 * expires_in; `onRefresh` returning null makes POST /tokens/refresh fail.
 */
function fakeDirectLine({ conversationId = "conv-1", tokenTtlS = 1800, onRefresh = () => ({ token: "refreshed-token", expires_in: 1800 }), endOfConversation = false, omitConversationToken = false } = {}) {
  const calls = [];
  const json = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body), json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, auth: (init.headers ?? {}).Authorization });

    if (url === TOKEN_ENDPOINT) return json({ token: "endpoint-token" });
    if (url.includes("regionalchannelsettings")) return json({ channelUrlsById: { directline: "https://directline.example" } });
    if (url.endsWith("/v3/directline/conversations") && method === "POST") {
      return json({ conversationId, ...(omitConversationToken ? {} : { token: "conversation-token", expires_in: tokenTtlS }) });
    }
    if (url.includes("/tokens/refresh")) {
      const r = onRefresh();
      if (r === null) return { ok: false, status: 403, headers: new Map(), text: async () => "forbidden", json: async () => ({}) };
      return json(r);
    }
    if (url.includes("/activities") && method === "POST") return json({ id: "1" });
    if (url.includes("/activities")) {
      const activities = [{ type: "message", from: { role: "bot" }, text: "hello" }];
      if (endOfConversation) activities.push({ type: "endOfConversation", from: { role: "bot" } });
      return json({ activities, watermark: "w1" });
    }
    return json({});
  };
  const refreshes = () => calls.filter((c) => c.url.includes("/tokens/refresh"));
  const starts = () => calls.filter((c) => c.url.endsWith("/v3/directline/conversations") && c.method === "POST");
  return { fetchImpl, calls, refreshes, starts };
}

const talk = (fetchImpl, opts = {}) => chatDirectLine("hi", { tokenEndpoint: TOKEN_ENDPOINT, fetchImpl, sleep, idleMs: 100, maxMs: 5_000, ...opts });

test("a conversation is remembered so the next turn continues it", async () => {
  const { fetchImpl, starts } = fakeDirectLine({ conversationId: "conv-keep" });
  const before = directLineSessionCount();
  const first = await talk(fetchImpl);
  assert.equal(first.conversationId, "conv-keep");
  assert.equal(directLineSessionCount(), before + 1);
  assert.equal(starts().length, 1);

  await talk(fetchImpl, { conversationId: "conv-keep" });
  assert.equal(starts().length, 1, "continuing must not open a second conversation");
  endDirectLineSession("conv-keep");
});

test("endDirectLineSession forgets one conversation", async () => {
  const { fetchImpl } = fakeDirectLine({ conversationId: "conv-end" });
  await talk(fetchImpl);
  const before = directLineSessionCount();
  assert.equal(endDirectLineSession("conv-end"), true);
  assert.equal(directLineSessionCount(), before - 1);
  assert.equal(endDirectLineSession("conv-end"), false, "a second release is a no-op, not an error");
});

test("a conversation the bot ended is not kept", async () => {
  const { fetchImpl } = fakeDirectLine({ conversationId: "conv-over", endOfConversation: true });
  const before = directLineSessionCount();
  const r = await talk(fetchImpl);
  assert.equal(r.conversationId, "conv-over");
  assert.equal(directLineSessionCount(), before, "endOfConversation must release the session immediately");
});

test("an idle conversation is swept after the 30 minute window", async () => {
  const { fetchImpl, starts } = fakeDirectLine({ conversationId: "conv-idle" });
  await talk(fetchImpl);
  const held = directLineSessionCount();

  advance(SESSION_IDLE_MS + 1);
  // The sweep runs on the next call, so this turn both prunes and reopens.
  await talk(fetchImpl, { conversationId: "conv-idle" });
  assert.equal(starts().length, 2, "the swept conversation must be reopened, not resumed on a dead token");
  assert.equal(directLineSessionCount(), held, "sweeping must not leave the map larger than before");
  endDirectLineSession("conv-idle");
});

test("a token near expiry is refreshed instead of being used until it fails", async () => {
  // 60s of life is inside the 5 minute refresh margin, so the second turn refreshes.
  const { fetchImpl, calls, refreshes } = fakeDirectLine({ conversationId: "conv-refresh", tokenTtlS: 60 });
  await talk(fetchImpl);
  assert.equal(refreshes().length, 0, "a just-minted token must not be refreshed");

  await talk(fetchImpl, { conversationId: "conv-refresh" });
  assert.equal(refreshes().length, 1);
  assert.equal(refreshes()[0].method, "POST");
  assert.equal(refreshes()[0].auth, "Bearer conversation-token", "refresh authenticates with the token being replaced");

  const after = calls.slice(calls.indexOf(refreshes()[0]) + 1).filter((c) => c.auth);
  assert.ok(after.length > 0, "the turn must continue after refreshing");
  for (const c of after) assert.equal(c.auth, "Bearer refreshed-token", `stale token reused on ${c.method} ${c.url}`);
  endDirectLineSession("conv-refresh");
});

test("a long-lived token is left alone", async () => {
  const { fetchImpl, refreshes } = fakeDirectLine({ conversationId: "conv-fresh", tokenTtlS: 1800 });
  await talk(fetchImpl);
  await talk(fetchImpl, { conversationId: "conv-fresh" });
  assert.equal(refreshes().length, 0);
  endDirectLineSession("conv-fresh");
});

test("a secret has no expiry, so it is never sent to the refresh endpoint", async () => {
  // No token in the start response: the session falls back to the secret.
  const { fetchImpl, refreshes } = fakeDirectLine({ conversationId: "conv-secret", omitConversationToken: true });
  const opts = { secret: "s3cret", fetchImpl, sleep, idleMs: 100, maxMs: 5_000 };
  await chatDirectLine("hi", opts);
  advance(60 * 60_000 - 1); // an hour on, still inside the idle window by a whisker
  await chatDirectLine("hi again", { ...opts, conversationId: "conv-secret" });
  assert.equal(refreshes().length, 0, "a secret cannot be refreshed and must not be sent to that endpoint");
  endDirectLineSession("conv-secret");
});

test("a refresh that fails drops the session and says the thread is gone", async () => {
  const { fetchImpl } = fakeDirectLine({ conversationId: "conv-dead", tokenTtlS: 60, onRefresh: () => null });
  await talk(fetchImpl);
  const before = directLineSessionCount();
  await assert.rejects(
    () => talk(fetchImpl, { conversationId: "conv-dead" }),
    (err) => {
      assert.match(err.message, /conv-dead/);
      assert.match(err.message, /without conversationId/);
      return true;
    },
  );
  assert.equal(directLineSessionCount(), before - 1, "an unrepairable session must not be kept");
});
