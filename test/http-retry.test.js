/**
 * What requestJson retries, and what it must never retry.
 *
 * Every cloud call in this server was single-shot, so one throttled or briefly
 * broken response failed a whole tool call. Retrying is only safe where
 * repeating the request is: a GET is idempotent by contract, but a publish or a
 * solution import that timed out may already have been applied, and sending it
 * again is worse than failing. These tests pin that boundary.
 *
 * Backoff is asserted through an injected sleep, so nothing here waits.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { backoffMs, HttpError, NetworkError, parseRetryAfter, requestJson } from "../dist/cloud/http.js";

/** Replays the given responses in order; a status of 0 means the fetch throws. */
function replay(...steps) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step.status === 0) throw new TypeError("fetch failed");
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: new Map(Object.entries(step.headers ?? {})),
      text: async () => step.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

const waits = () => {
  const slept = [];
  return { slept, sleep: async (ms) => void slept.push(ms) };
};

const ok = { status: 200, body: JSON.stringify({ value: "ok" }) };

test("a GET retries a transient failure and returns the eventual body", async () => {
  const { fetchImpl, calls } = replay({ status: 503 }, { status: 503 }, ok);
  const { slept, sleep } = waits();
  const out = await requestJson("https://x/api", { fetchImpl, sleep });
  assert.deepEqual(out, { value: "ok" });
  assert.equal(calls.length, 3);
  assert.equal(slept.length, 2, "one wait between each pair of tries");
  assert.ok(slept[1] > slept[0], `backoff must grow: ${slept.join(", ")}`);
});

test("a write is never retried, however transient the failure looks", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const { fetchImpl, calls } = replay({ status: 503 }, ok);
    const { slept, sleep } = waits();
    await assert.rejects(() => requestJson("https://x/api", { method, body: {}, fetchImpl, sleep }), HttpError);
    assert.equal(calls.length, 1, `${method} must be sent exactly once`);
    assert.equal(slept.length, 0);
  }
});

test("a non-GET that only reads can opt in", async () => {
  const { fetchImpl, calls } = replay({ status: 503 }, ok);
  const { sleep } = waits();
  const out = await requestJson("https://x/query", { method: "POST", body: {}, idempotent: true, fetchImpl, sleep });
  assert.deepEqual(out, { value: "ok" });
  assert.equal(calls.length, 2);
});

test("retry: false turns it off for a GET", async () => {
  const { fetchImpl, calls } = replay({ status: 503 }, ok);
  await assert.rejects(() => requestJson("https://x/api", { fetchImpl, retry: false, sleep: async () => {} }), HttpError);
  assert.equal(calls.length, 1);
});

test("the caller's own errors are not retried", async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const { fetchImpl, calls } = replay({ status }, ok);
    await assert.rejects(() => requestJson("https://x/api", { fetchImpl, sleep: async () => {} }), (err) => {
      assert.equal(err.status, status);
      return true;
    });
    assert.equal(calls.length, 1, `${status} must not be retried`);
  }
});

test("throttling and transient server failures are retried", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const { fetchImpl, calls } = replay({ status }, ok);
    await requestJson("https://x/api", { fetchImpl, sleep: async () => {} });
    assert.equal(calls.length, 2, `${status} should have been retried`);
  }
});

test("a transport failure is retried and named when it does not recover", async () => {
  const { fetchImpl, calls } = replay({ status: 0 });
  const { slept, sleep } = waits();
  await assert.rejects(() => requestJson("https://x/api", { fetchImpl, sleep }), (err) => {
    assert.ok(err instanceof NetworkError);
    assert.match(err.message, /Could not reach https:\/\/x\/api/);
    assert.match(err.message, /fetch failed/);
    return true;
  });
  assert.equal(calls.length, 3, "the default is three tries");
  assert.equal(slept.length, 2);
});

test("Retry-After is honoured over the computed backoff", async () => {
  const { fetchImpl } = replay({ status: 429, headers: { "retry-after": "2" } }, ok);
  const { slept, sleep } = waits();
  await requestJson("https://x/api", { fetchImpl, sleep });
  assert.deepEqual(slept, [2000]);
});

test("a Retry-After longer than the cap is not waited out", async () => {
  // The client cuts the tool call off at ~60s, so obeying a 120s Retry-After
  // would lose the call. Cap the wait and let the failure surface instead.
  const { fetchImpl } = replay({ status: 429, headers: { "retry-after": "120" } }, ok);
  const { slept, sleep } = waits();
  await requestJson("https://x/api", { fetchImpl, sleep, retry: { maxDelayMs: 5000 } });
  assert.deepEqual(slept, [5000]);
});

test("a body that is not JSON is the server's answer, not a blip", async () => {
  const { fetchImpl, calls } = replay({ status: 200, body: "<html>maintenance</html>" });
  await assert.rejects(() => requestJson("https://x/api", { fetchImpl, sleep: async () => {} }), SyntaxError);
  assert.equal(calls.length, 1, "a parse failure must not be retried");
});

test("204 and an empty body stay null, and are not retried", async () => {
  const empty = replay({ status: 204 });
  assert.equal(await requestJson("https://x/api", { fetchImpl: empty.fetchImpl }), null);
  assert.equal(empty.calls.length, 1);
  const blank = replay({ status: 200, body: "   " });
  assert.equal(await requestJson("https://x/api", { fetchImpl: blank.fetchImpl }), null);
  assert.equal(blank.calls.length, 1);
});

test("attempts is the total number of tries, not the number of retries", async () => {
  const { fetchImpl, calls } = replay({ status: 503 });
  await assert.rejects(() => requestJson("https://x/api", { fetchImpl, sleep: async () => {}, retry: { attempts: 5 } }), HttpError);
  assert.equal(calls.length, 5);
});

test("parseRetryAfter reads both the seconds and the date form", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("Fri, 11 Sep 2026 12:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("in a bit"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("-5"), 0, "a past date or negative wait means go now");
});

test("backoff doubles, stays inside the cap, and is jittered", () => {
  const policy = { attempts: 3, baseMs: 400, maxDelayMs: 5000 };
  // Jitter is 50-100% of the step, so bounds rather than exact values.
  for (const [attempt, step] of [[1, 400], [2, 800], [3, 1600]]) {
    const low = backoffMs(attempt, new HttpError(503, "u", ""), policy, () => 0);
    const high = backoffMs(attempt, new HttpError(503, "u", ""), policy, () => 1);
    assert.equal(low, step / 2, `attempt ${attempt} floor`);
    assert.equal(high, step, `attempt ${attempt} ceiling`);
  }
  assert.equal(backoffMs(9, new HttpError(503, "u", ""), policy, () => 1), 5000, "the cap holds however many tries in");
});
