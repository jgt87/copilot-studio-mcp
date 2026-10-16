/**
 * Minimal JSON HTTP helper with an injectable fetch so cloud clients can be
 * unit-tested offline against recorded responses.
 *
 * Retries are deliberately narrow. A GET is idempotent by contract, so a
 * throttled or briefly broken one is retried; anything that can change an
 * environment is not, because a publish or a solution import that timed out
 * may well have been applied, and sending it again is worse than failing. A
 * non-GET call opts in with `idempotent: true`.
 *
 * `requestBytes` is the same contract for a download (a zip, a manifest): GET
 * only, same retry policy, the body handed back as bytes with the file name the
 * server suggested.
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

/** A GET whose body is a file, not JSON. */
export interface BytesRequest {
  token?: string;
  headers?: Record<string, string>;
  /** Default 120s: downloads are larger than API replies, but still inside one tool call. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  hints?: Partial<Record<number, string>>;
  retry?: RetryOptions | false;
  sleep?: (ms: number) => Promise<void>;
  /** Refuse a body over this size instead of holding it in memory. Default 50 MB. */
  maxBytes?: number;
}

export interface BytesResponse {
  bytes: Uint8Array;
  contentType: string | null;
  /** From Content-Disposition, when the server named the file. */
  fileName: string | null;
}

/** Throttling and the transient server-side failures. Every other 4xx is the caller's. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const RETRY_DEFAULTS = { attempts: 3, baseMs: 400, maxDelayMs: 5_000 };

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const DEFAULT_HINTS: Record<number, string> = {
  401: "token rejected; run cs_login again",
  403: "signed-in user lacks permission for this resource",
  404: "resource not found; check environment/agent ids",
  429: "rate limited; retry later",
};

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * The file name in a Content-Disposition header: the RFC 5987 `filename*` form
 * first (it carries the encoding), then the plain quoted or bare `filename`.
 */
export function fileNameFromDisposition(value: string | null | undefined): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*(?:[\w-]*)''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim()) || null;
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name || null;
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

/** Run one attempt, and again after a transient failure when the call may be repeated. */
async function withRetry<T>(attempt: () => Promise<T>, mayRetry: boolean, retry: RetryOptions | false | undefined, sleep?: (ms: number) => Promise<void>): Promise<T> {
  if (!mayRetry) return attempt();
  const policy = { ...RETRY_DEFAULTS, ...(retry ?? {}) };
  const wait = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= policy.attempts || !retryable(err)) throw err;
      await wait(backoffMs(n, err, policy));
    }
  }
}

async function failed(res: Response, url: string, hints: Partial<Record<number, string>> | undefined): Promise<HttpError> {
  const text = await res.text().catch(() => "");
  return new HttpError(res.status, url, text, hints?.[res.status] ?? DEFAULT_HINTS[res.status], parseRetryAfter(res.headers?.get?.("retry-after")));
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
  if (!res.ok) throw await failed(res, url, req.hints);
  const text = await res.text().catch(() => "");
  if (!text.trim()) return null;
  // A body that is not JSON is the server's answer, not a blip: never retried.
  return JSON.parse(text) as T;
}

export async function requestJson<T = unknown>(url: string, req: JsonRequest = {}): Promise<T | null> {
  const method = req.method ?? "GET";
  const mayRetry = req.retry !== false && (method === "GET" || req.idempotent === true);
  return withRetry(() => attemptJson<T>(url, req, method), mayRetry, req.retry, req.sleep);
}

async function attemptBytes(url: string, req: BytesRequest): Promise<BytesResponse> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    Accept: "*/*",
    ...(req.token ? { Authorization: `Bearer ${req.token}` } : {}),
    ...req.headers,
  };
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(req.timeoutMs ?? 120_000) });
  } catch (err) {
    throw new NetworkError(url, err);
  }
  if (!res.ok) throw await failed(res, url, req.hints);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.byteLength > maxBytes) throw new Error(`Response from ${url} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte cap`);
  return {
    bytes,
    contentType: res.headers?.get?.("content-type") ?? null,
    fileName: fileNameFromDisposition(res.headers?.get?.("content-disposition")),
  };
}

/** Download a file with a GET: same retry policy as a JSON GET, body returned as bytes. */
export async function requestBytes(url: string, req: BytesRequest = {}): Promise<BytesResponse> {
  return withRetry(() => attemptBytes(url, req), req.retry !== false, req.retry, req.sleep);
}
