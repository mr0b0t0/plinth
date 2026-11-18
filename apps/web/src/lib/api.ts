// Fetch wrapper for /api/v1: JSON in and out, CSRF header on writes, typed errors.
import {
  type AdminStats,
  API,
  API_PREFIX,
  type ArtifactViews,
  COOKIES,
  CSRF_HEADER,
  type DataSummary,
  type ErrorBody,
  type ErrorCode,
  HOST_COOKIE_PREFIX,
  route,
} from "@plinth/shared";

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

/**
 * The CSRF cookie's name here, by the Worker's rule (lib/cookies.ts appCookieName): `__Host-`
 * prefixed wherever cookies can be Secure (https, and localhost); a plain-http instance on another
 * name uses the unprefixed name. Never both, so a leftover cookie under the other name is ignored.
 */
export function csrfCookieName(loc: { protocol: string; hostname: string } = location): string {
  const secure = loc.protocol === "https:" || /(^|\.)localhost$/.test(loc.hostname);
  return secure ? COOKIES.csrf : COOKIES.csrf.slice(HOST_COOKIE_PREFIX.length);
}

/** The double-submit token: the value of the CSRF cookie, or "" when there is none. */
export function csrfToken(
  cookies: string = document.cookie,
  name: string = csrfCookieName(),
): string {
  for (const part of cookies.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
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

// ---------- shared data (owner view in the share dialog) ----------

/** Totals and declaration of an artifact's shared data (owner and editors). */
export function getDataSummary(ref: string, signal?: AbortSignal): Promise<DataSummary> {
  return api<DataSummary>(route(API.data, { ref }), { signal });
}

/** Delete every shared data document of an artifact (signed-in owner; CSRF header). */
export function deleteAllData(ref: string): Promise<{ deleted: number }> {
  return api<{ deleted: number }>(route(API.data, { ref }), { method: "DELETE" });
}

// ---------- open counts and admin stats ----------

/** How often other people opened an artifact (the owner only). */
export function getArtifactViews(ref: string, signal?: AbortSignal): Promise<ArtifactViews> {
  return api<ArtifactViews>(route(API.artifactViews, { ref }), { signal });
}

/** Instance-wide aggregates over the last `days` UTC days (instance admins only; 404 otherwise). */
export function getAdminStats(days: 7 | 30 | 90, signal?: AbortSignal): Promise<AdminStats> {
  return api<AdminStats>(`${API.adminStats}?days=${days}`, { signal });
}
