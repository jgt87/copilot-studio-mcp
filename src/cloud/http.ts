/**
 * Minimal JSON HTTP helper with an injectable fetch so cloud clients can be
 * unit-tested offline against recorded responses.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
    hint?: string,
  ) {
    super(`HTTP ${status} from ${url}${hint ? ` - ${hint}` : ""}${bodyText ? `: ${bodyText.slice(0, 400)}` : ""}`);
    this.name = "HttpError";
  }
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
}

export async function requestJson<T = unknown>(url: string, req: JsonRequest = {}): Promise<T | null> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(req.token ? { Authorization: `Bearer ${req.token}` } : {}),
    ...req.headers,
  };
  const res = await fetchImpl(url, {
    method: req.method ?? "GET",
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const defaultHints: Record<number, string> = {
      401: "token rejected; run cs_login again",
      403: "signed-in user lacks permission for this resource",
      404: "resource not found; check environment/agent ids",
      429: "rate limited; retry later",
    };
    throw new HttpError(res.status, url, text, req.hints?.[res.status] ?? defaultHints[res.status]);
  }
  if (!text.trim()) return null;
  return JSON.parse(text) as T;
}
