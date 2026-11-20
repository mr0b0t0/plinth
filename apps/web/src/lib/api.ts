// Fetch wrapper for /api/v1: JSON in and out, CSRF header on writes, typed errors.
import {
  type AdminStats,
  API,
  API_PREFIX,
  type ArtifactStats,
  type ArtifactStatsSummary,
  COOKIES,
  CSRF_HEADER,
  type DataSummary,
  type ErrorBody,
  type ErrorCode,
  HOST_COOKIE_PREFIX,
  type LiveCheckpointInput,
  type LiveCheckpointResult,
  type LiveInfo,
  route,
  type StatsRange,
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

// ---------- artifact stats and admin stats ----------

/** Who opened an artifact over the last `days` UTC days (the owner only). */
export function getArtifactStats(
  ref: string,
  days: StatsRange,
  signal?: AbortSignal,
): Promise<ArtifactStats> {
  return api<ArtifactStats>(`${route(API.artifactStats, { ref })}?days=${days}`, { signal });
}

/** Opens across the caller's own artifacts (7 and 30 days, last opened). */
export function getStatsSummary(signal?: AbortSignal): Promise<ArtifactStatsSummary> {
  return api<ArtifactStatsSummary>(API.statsArtifacts, { signal });
}

/** Instance-wide aggregates over the last `days` UTC days (instance admins only; 404 otherwise). */
export function getAdminStats(days: 7 | 30 | 90, signal?: AbortSignal): Promise<AdminStats> {
  return api<AdminStats>(`${API.adminStats}?days=${days}`, { signal });
}

// ---------- on-page doc editing (#36; owners and editors, signed in) ----------

/** Whether a doc has unsaved page edits, and the autosave settings. */
export function liveInfo(ref: string, signal?: AbortSignal): Promise<LiveInfo> {
  return api<LiveInfo>(route(API.live, { ref }), { signal });
}

/** Publish the live draft as a version (Publish, Done, an idle autosave, or "Publish your changes"). */
export function liveCheckpoint(
  ref: string,
  body: LiveCheckpointInput,
): Promise<LiveCheckpointResult> {
  return api<LiveCheckpointResult>(route(API.liveCheckpoint, { ref }), { method: "POST", body });
}

/**
 * Drop the unpublished page edits at draft revision `rev`; with `conflictVersion`, only a draft
 * frozen against exactly that version ("Discard your changes" in the review).
 */
export function liveDiscard(ref: string, rev: number, conflictVersion?: number): Promise<void> {
  const q = `?rev=${rev}${conflictVersion !== undefined ? `&conflict_version=${conflictVersion}` : ""}`;
  return api<void>(`${route(API.liveDraft, { ref })}${q}`, { method: "DELETE" });
}
