// Helpers for the page-requests tests (docs/spec.md "Page requests"): a page that declares
// `requests`, people with content cookies minted through the real gate and enter flow (with
// ALLOW_PAGE_REQUESTS on), requests the way the runtime makes them, and the app's and agents' REST
// calls with the same switch.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { COOKIES, CSRF_HEADER, type Role } from "@plinth/shared";
import { accessGrants, sessions } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { hashToken, newToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import {
  APP,
  agent,
  browserSession,
  contentOrigin,
  createToken,
  createUser,
  db,
  enterContent,
  json,
  publish,
} from "./helpers.ts";

/** ALLOW_PAGE_REQUESTS on: every request of these tests runs with it. */
export const ON: Record<string, string> = { ALLOW_PAGE_REQUESTS: "true" };

export const REQUESTS_PAGE = `<!doctype html><title>Ask</title>
<meta name="plinth-capabilities" content="requests">
<meta name="plinth-requests-to" content="claude"><p>ask</p>`;
export const NO_TARGET_PAGE = `<!doctype html><title>Ask</title>
<meta name="plinth-capabilities" content="requests"><p>ask</p>`;
export const DATA_ONLY = `<!doctype html><title>Tally</title>
<meta name="plinth-capabilities" content="data"><p>tally</p>`;

const CSRF = "csrf-test-token-0123456789";

/** Run a request through the Worker with ALLOW_PAGE_REQUESTS on (and `vars`). */
export async function run(
  url: string,
  init: RequestInit = {},
  vars: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url.startsWith("http") ? url : `${APP}${url}`, { redirect: "manual", ...init }),
    { ...env, ...ON, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export interface ApiOpts {
  method?: string;
  cookie?: string | null;
  body?: unknown;
  /** Replaces the default browser-like headers (null removes one). */
  headers?: Record<string, string | null>;
  vars?: Record<string, string>;
}

/** A requests API call the way the runtime makes it: same-origin fetch with the custom header. */
export function requestsApi(id: string, path: string, opts: ApiOpts = {}): Promise<Response> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const base: Record<string, string | null> = {
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    origin: method === "GET" ? null : contentOrigin(id),
    "content-type": opts.body === undefined ? null : "application/json",
    cookie: opts.cookie ?? null,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) }))
    if (v !== null) headers.set(k, v);
  const body =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string" || opts.body instanceof ReadableStream
        ? opts.body
        : JSON.stringify(opts.body);
  return run(
    `${contentOrigin(id)}/__plinth/api/v1/requests${path}`,
    { method, headers, body },
    opts.vars,
  );
}

/** File one request; returns the response and its JSON. */
export async function file(id: string, cookie: string, body: Record<string, unknown>, vars = {}) {
  const res = await requestsApi(id, "", { cookie, body, vars });
  return { res, json: await json(res) };
}

/** The caller's GET /requests. */
export async function mine(id: string, cookie: string, vars = {}) {
  const res = await requestsApi(id, "", { cookie, vars });
  return { res, json: await json(res) };
}

export async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

export async function cookieFor(
  id: string,
  headers?: Record<string, string>,
  vars: Record<string, string> = {},
): Promise<string> {
  const { cookie, gate } = await enterContent(id, { headers, vars: { ...ON, ...vars } });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return cookie;
}

/** The gate as this browser sees it, with ALLOW_PAGE_REQUESTS on (and `vars`). */
export async function gateFor(id: string, headers: Record<string, string>, vars = {}) {
  return json(await run(`/api/v1/view/${id}`, { headers }, vars));
}

export interface Person {
  email: string;
  userId: string;
  cookie: string;
  /** App-host headers: session cookie, CSRF pair, Origin. */
  headers: Record<string, string>;
}

/** A published page; its owner (with an agent token for `@claude`, and a browser and cookie). */
export async function setup(html = REQUESTS_PAGE, visibility = "allowlist") {
  const owner = await agent({ clientType: "claude", label: "Build bot" });
  const { body } = await publish(owner.auth, { html, visibility });
  const id = body.id as string;
  const s = await browserSession(owner.user.id);
  const ownerP: Person = {
    userId: owner.user.id,
    email: owner.user.email,
    cookie: await cookieFor(id, s.headers),
    headers: s.headers,
  };
  return { owner, id, slug: body.slug as string, ownerP };
}

/** A signed-in person with a grant on the artifact, and their content cookie. */
export async function person(id: string, role: Role): Promise<Person> {
  const user = await createUser();
  await grant(id, user.email, role);
  const s = await browserSession(user.id);
  return {
    userId: user.id,
    email: user.email,
    cookie: await cookieFor(id, s.headers),
    headers: s.headers,
  };
}

/** A person's own agent token (another user's agent). */
export async function agentOf(userId: string, label = "Their agent") {
  const t = await createToken(userId, { clientType: "claude", label });
  return { ...t, auth: { Authorization: `Bearer ${t.token}` } };
}

/** A confirmed allowlist viewer without an account (app-host viewer cookie), as a cookie pair. */
export async function viewerCookie(email: string): Promise<string> {
  const value = newToken("v_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      viewerEmail: email,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  return `${COOKIES.viewer}=${value}`;
}

/** App-host headers for a browser holding these cookies. */
export function appHeaders(...cookies: string[]): Record<string, string> {
  return {
    Cookie: [...cookies, `${COOKIES.csrf}=${CSRF}`].join("; "),
    [CSRF_HEADER]: CSRF,
    Origin: APP,
  };
}

/** A REST call on the app host with ALLOW_PAGE_REQUESTS on. */
export async function rest(
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
) {
  const res = await run(`/api/v1${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: res.status === 204 ? null : await json(res) };
}

export const errOf = async (res: Response) =>
  (await json(res)).error as { code: string; message: string; details?: any };

/** The artifact's current access epoch. */
export async function epochOf(artifactId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT access_epoch FROM artifacts WHERE id = ?1")
    .bind(artifactId)
    .first<{ access_epoch: number }>();
  return row?.access_epoch ?? 0;
}

export async function taskOf(commentId: string) {
  return env.DB.prepare("SELECT * FROM mention_tasks WHERE comment_id = ?1")
    .bind(commentId)
    .first<Record<string, any>>();
}

export async function commentRow(id: string) {
  return env.DB.prepare("SELECT * FROM comments WHERE id = ?1")
    .bind(id)
    .first<Record<string, any>>();
}
