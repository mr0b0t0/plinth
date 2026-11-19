// Fetch wrapper for /api/v1: JSON in and out, CSRF header on writes, typed errors.
import {
  type AdminStats,
  API,
  API_PREFIX,
  type ArtifactFilesList,
  type ArtifactViews,
  COOKIES,
  CSRF_HEADER,
  type DataSourceInfo,
  type DataSummary,
  type DesignExportOptions,
  type ErrorBody,
  type ErrorCode,
  HOST_COOKIE_PREFIX,
  type LiveCheckpointInput,
  type LiveCheckpointResult,
  type LiveDraftText,
  type LiveInfo,
  route,
} from "@plinth/shared";
import { forgetAllConsents } from "../components/viewer/voiceProtocol.ts";

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
  // Every sign-out comes through here: forget this browser's per-page dictation consents first,
  // so the next person on a shared browser is asked again.
  if (path === API.logout && method === "POST") forgetAllConsents();
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

// ---------- files people add to a page (owner view in the share dialog) ----------

/** One page of the files people uploaded from a page (owner and editors). Metadata only. */
export function getArtifactFiles(
  ref: string,
  signal?: AbortSignal,
  cursor?: string,
): Promise<ArtifactFilesList> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return api<ArtifactFilesList>(`${route(API.files, { ref })}${q}`, { signal });
}

/** Delete one file people uploaded (owner or editor; CSRF header). */
export function deleteArtifactFile(ref: string, file: string): Promise<{ deleted: string }> {
  return api<{ deleted: string }>(route(API.file, { ref, file }), { method: "DELETE" });
}

/** Delete every file people uploaded to a page (signed-in owner; CSRF header). */
export function deleteAllFiles(ref: string): Promise<{ files: number }> {
  return api<{ files: number }>(route(API.files, { ref }), { method: "DELETE" });
}

// ---------- data sources (owner review in the share dialog) ----------

/** The artifact's data sources (owner and editors; the recipe for the owner only). */
export function getDataSources(
  ref: string,
  signal?: AbortSignal,
): Promise<{ sources: DataSourceInfo[]; untrusted: string }> {
  return api<{ sources: DataSourceInfo[]; untrusted: string }>(route(API.dataSources, { ref }), {
    signal,
  });
}

/** Confirm a data source as shown (the signed-in owner; CSRF header). */
export function confirmDataSource(
  ref: string,
  source: string,
  configHash: string,
): Promise<DataSourceInfo> {
  return api<DataSourceInfo>(route(API.dataSourceConfirm, { ref, source }), {
    method: "POST",
    body: { config_hash: configHash },
  });
}

/** Remove a data source (the owner; CSRF header). */
export function removeDataSource(ref: string, source: string): Promise<{ removed: string }> {
  return api<{ removed: string }>(route(API.dataSource, { ref, source }), { method: "DELETE" });
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

// ---------- on-page doc editing (#36; owners and editors, signed in) ----------

/** Whether a doc has unsaved page edits, and the autosave settings. */
export function liveInfo(ref: string, signal?: AbortSignal): Promise<LiveInfo> {
  return api<LiveInfo>(route(API.live, { ref }), { signal });
}

/** The live draft's text, to review a conflict. */
export function liveDraft(ref: string, signal?: AbortSignal): Promise<LiveDraftText> {
  return api<LiveDraftText>(route(API.liveDraft, { ref }), { signal });
}

/** Save the live draft as a version (Save, Done, or an idle autosave). */
export function liveCheckpoint(
  ref: string,
  body: LiveCheckpointInput,
): Promise<LiveCheckpointResult> {
  return api<LiveCheckpointResult>(route(API.liveCheckpoint, { ref }), { method: "POST", body });
}

/** Drop the unsaved page edits at draft revision `rev`. */
export function liveDiscard(ref: string, rev: number): Promise<void> {
  return api<void>(`${route(API.liveDraft, { ref })}?rev=${rev}`, { method: "DELETE" });
}

// ---------- design export (PNG and PDF rendered by the server) ----------

/** A design version's artboards and the formats it downloads as (anyone who may view it). */
export function getDesignExportOptions(
  ref: string,
  version: number,
  signal?: AbortSignal,
): Promise<DesignExportOptions> {
  return api<DesignExportOptions>(`${route(API.designExportOptions, { ref })}?version=${version}`, {
    signal,
  });
}

export interface DesignExportRequest {
  format: "png" | "pdf";
  version: number;
  /** Required for png; for pdf, only this board. */
  board?: string;
  /** png only. */
  scale?: 1 | 2;
}

/** The export's URL on the app host (same origin, so the session cookie goes with it). */
export function designExportUrl(ref: string, r: DesignExportRequest): string {
  const q = new URLSearchParams({ format: r.format, version: String(r.version) });
  if (r.board) q.set("board", r.board);
  if (r.format === "png" && r.scale) q.set("scale", String(r.scale));
  return `${API_PREFIX}${route(API.designExport, { ref })}?${q}`;
}

/** The file name the server gave (Content-Disposition), or `fallback`. */
export function attachmentName(header: string | null, fallback: string): string {
  const m = header ? /filename="([A-Za-z0-9._-]{1,200})"/.exec(header) : null;
  return m?.[1] ?? fallback;
}

/**
 * Render and fetch a design export. Resolves with the file, or throws ApiRequestError with the
 * server's message (rate limited, unavailable, off), so the dialog can say what went wrong instead
 * of the browser saving an error as a file.
 */
export async function fetchDesignExport(
  ref: string,
  r: DesignExportRequest,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(designExportUrl(ref, r), { credentials: "same-origin", signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let err: ErrorBody["error"] | undefined;
    try {
      err = (JSON.parse(text) as ErrorBody).error;
    } catch {
      // fall through
    }
    throw new ApiRequestError(
      res.status,
      err?.code ?? "internal",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  const filename = attachmentName(res.headers.get("Content-Disposition"), `design.${r.format}`);
  return { blob: await res.blob(), filename };
}
