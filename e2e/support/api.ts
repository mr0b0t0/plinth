// REST helpers for e2e tests. Works with any APIRequestContext: the `request` fixture, page.request
// (shares the browser's cookies) or one from newApiContext().
import { type APIRequestContext, request as playwrightRequest } from "@playwright/test";

export const APP_ORIGIN = "http://app.localhost:8787";
export const CONTENT_HOST = "content.localhost:8787";
export const API_BASE = `${APP_ORIGIN}/api/v1`;
export const CSRF_COOKIE = "plinth_csrf";
export const CSRF_HEADER = "x-plinth-csrf";

/** Origin of one artifact on the content host. */
export const contentOrigin = (artifactId: string) => `http://${artifactId}.${CONTENT_HOST}`;

let counter = 0;
/** A fresh address for each test, so rate limits and outbox lookups never collide. */
export function uniqueEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** A new request context for the app host, optionally with a bearer token. Dispose it after use. */
export function newApiContext(opts: { token?: string } = {}): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: APP_ORIGIN,
    extraHTTPHeaders: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
}

/**
 * The CSRF token for this context. GET /api/v1/config sets the `plinth_csrf` cookie when the
 * context has none; the value must come back in the `x-plinth-csrf` header on writes.
 */
export async function csrfToken(request: APIRequestContext): Promise<string> {
  const find = async () =>
    (await request.storageState()).cookies.find((c) => c.name === CSRF_COOKIE)?.value;
  let token = await find();
  if (!token) {
    const res = await request.get(`${API_BASE}/config`);
    if (!res.ok()) throw new Error(`GET /config failed: ${res.status()}`);
    token = await find();
  }
  if (!token) throw new Error("GET /api/v1/config did not set the plinth_csrf cookie");
  return token;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

export interface ApiOptions {
  /** Bearer token. Bearer requests skip CSRF, as in the Worker. */
  token?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

/**
 * Call /api/v1. `path` is relative to /api/v1 (e.g. "/artifacts"). State-changing requests
 * without a bearer token carry the CSRF header and the app Origin, like the web app.
 */
export async function api<T = any>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  opts: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (method !== "GET" && !opts.token && !headers.Authorization) {
    headers[CSRF_HEADER] = await csrfToken(request);
    headers.Origin = APP_ORIGIN;
  }
  const res = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers,
    params: opts.query,
    data: body === undefined ? undefined : body,
    maxRedirects: 0,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: res.status(), body: parsed as T, headers: res.headers() };
}

export const apiGet = <T = any>(r: APIRequestContext, path: string, opts?: ApiOptions) =>
  api<T>(r, "GET", path, undefined, opts);
export const apiPost = <T = any>(
  r: APIRequestContext,
  path: string,
  body?: unknown,
  opts?: ApiOptions,
) => api<T>(r, "POST", path, body ?? {}, opts);
export const apiPut = <T = any>(
  r: APIRequestContext,
  path: string,
  body?: unknown,
  opts?: ApiOptions,
) => api<T>(r, "PUT", path, body ?? {}, opts);
export const apiPatch = <T = any>(
  r: APIRequestContext,
  path: string,
  body?: unknown,
  opts?: ApiOptions,
) => api<T>(r, "PATCH", path, body ?? {}, opts);
export const apiDelete = <T = any>(r: APIRequestContext, path: string, opts?: ApiOptions) =>
  api<T>(r, "DELETE", path, undefined, opts);

/** Publish an artifact over REST with a bearer token. Returns the PublishResult. */
export async function publishArtifact(
  request: APIRequestContext,
  token: string,
  input: { title?: string; html?: string; visibility?: string; [k: string]: unknown } = {},
) {
  const res = await apiPost<{
    id: string;
    slug: string;
    version: number;
    url: string;
    content_url: string;
    visibility: string;
  }>(
    request,
    "/artifacts",
    { title: "E2E artifact", html: "<!doctype html><h1>Hello from e2e</h1>", ...input },
    { token },
  );
  if (res.status !== 201)
    throw new Error(`publish failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
