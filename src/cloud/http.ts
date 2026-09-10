/**
 * Minimal JSON HTTP helper with an injectable fetch so cloud clients can be
 * unit-tested offline against recorded responses.
 *
 * Retries are deliberately narrow. A GET is idempotent by contract, so a
 * throttled or briefly broken one is retried; anything that can change an
 * environment is not, because a publish or a solution import that timed out
 * may well have been applied, and sending it again is worse than failing. A
 * non-GET call opts in with `idempotent: true`.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
    hint?: string,
    /** The response's Retry-After, in ms, when it sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} from ${url}${hint ? ` - ${hint}` : ""}${bodyText ? `: ${bodyText.slice(0, 400)}` : ""}`);
    this.name = "HttpError";
  }
}

/** The request never reached a response: DNS, connection reset, or the timeout. */
export class NetworkError extends Error {
  constructor(
    public readonly url: string,
    public readonly cause: unknown,
  ) {
    super(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "NetworkError";
  }
}

export interface RetryOptions {
  /** Total tries, first included. Default 3. */
  attempts?: number;
  /** First backoff step; doubles per retry. Default 400ms. */
  baseMs?: number;
  /**
   * Ceiling for one wait, Retry-After included. Default 5s: an MCP client cuts
   * a tool call off at about 60s, so honouring a minute-long Retry-After would
   * lose the call anyway. Better to fail and say why.
   */
  maxDelayMs?: number;
}

export interface JsonRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Per-status hints appended to the error message. */
  hints?: Partial<Record<number, string>>;
  /** Tune the retry policy, or pass false to disable it for this call. */
  retry?: RetryOptions | false;
  /** Retry this non-GET call anyway: it only reads, or is safe to repeat. */
  idempotent?: boolean;
  /** Injectable for tests, so backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

/** Throttling and the transient server-side failures. Every other 4xx is the caller's. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const RETRY_DEFAULTS = { attempts: 3, baseMs: 400, maxDelayMs: 5_000 };

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function retryable(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  return err instanceof HttpError && RETRYABLE_STATUS.has(err.status);
}

/**
 * Exponential backoff with jitter, or what the server asked for. Jitter spreads
 * concurrent callers that were throttled together instead of having them all
 * come back at the same instant.
 */
export function backoffMs(attempt: number, err: unknown, o: Required<RetryOptions>, random = Math.random): number {
  const asked = err instanceof HttpError ? err.retryAfterMs : undefined;
  if (asked !== undefined) return Math.min(asked, o.maxDelayMs);
  const step = Math.min(o.baseMs * 2 ** (attempt - 1), o.maxDelayMs);
  return Math.round(step * (0.5 + random() / 2));
}

/** One try. Transport failures and HTTP failures are thrown as distinct types. */
async function attemptJson<T>(url: string, req: JsonRequest, method: string): Promise<T | null> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(req.token ? { Authorization: `Bearer ${req.token}` } : {}),
    ...req.headers,
  };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      // A fresh signal per try: an aborted one stays aborted.
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new NetworkError(url, err);
  }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const defaultHints: Record<number, string> = {
      401: "token rejected; run cs_login again",
      403: "signed-in user lacks permission for this resource",
      404: "resource not found; check environment/agent ids",
      429: "rate limited; retry later",
    };
    throw new HttpError(res.status, url, text, req.hints?.[res.status] ?? defaultHints[res.status], parseRetryAfter(res.headers?.get?.("retry-after")));
  }
  if (!text.trim()) return null;
  // A body that is not JSON is the server's answer, not a blip: never retried.
  return JSON.parse(text) as T;
}

export async function requestJson<T = unknown>(url: string, req: JsonRequest = {}): Promise<T | null> {
  const method = req.method ?? "GET";
  const mayRetry = req.retry !== false && (method === "GET" || req.idempotent === true);
  if (!mayRetry) return attemptJson<T>(url, req, method);

  const policy = { ...RETRY_DEFAULTS, ...(req.retry ?? {}) };
  const sleep = req.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptJson<T>(url, req, method);
    } catch (err) {
      if (attempt >= policy.attempts || !retryable(err)) throw err;
      await sleep(backoffMs(attempt, err, policy));
    }
  }
}
