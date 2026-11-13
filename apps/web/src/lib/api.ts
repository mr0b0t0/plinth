// Fetch wrapper for /api/v1: JSON in and out, CSRF header on writes, typed errors.
import { API_PREFIX, CSRF_HEADER, type ErrorBody, type ErrorCode } from "@plinth/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = /(?:^|;\s*)plinth_csrf=([^;]+)/.exec(document.cookie);
  return m?.[1] ?? "";
}

/** Make sure the CSRF cookie exists (GET /config sets it). */
let csrfReady: Promise<void> | null = null;
export function ensureCsrf(): Promise<void> {
  if (csrfToken()) return Promise.resolve();
  csrfReady ??= fetch(`${API_PREFIX}/config`, { credentials: "same-origin" }).then(() => undefined);
  return csrfReady;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET" && method !== "HEAD") {
    await ensureCsrf();
    headers[CSRF_HEADER] = csrfToken();
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // fall through
  }
  if (!res.ok) {
    const err = (data as ErrorBody | null)?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? "internal",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}
