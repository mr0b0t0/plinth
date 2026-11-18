// Helpers for the who-is-viewing tests (viewer-names.test.ts, people.test.ts): pages that declare
// `data viewer people`, display names set the way the app sets them (PATCH /api/v1/me), and
// requests to the content host the way the runtime makes them.
import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { browserSession, call, contentOrigin, createUser, json } from "./helpers.ts";
import { cookieFor, grant, run, type Vars } from "./room-helpers.ts";

export const SECRET = "test-token-signing-key-0123456789abcdef012345";

/** A page that declares shared data, viewer identity and, unless told not to, the people list. */
export const peoplePage = (opts: { people?: boolean; viewer?: boolean; room?: boolean } = {}) => {
  const caps = [
    "data",
    opts.viewer === false ? "" : "viewer",
    opts.room ? "room" : "",
    opts.people === false ? "" : "people",
  ]
    .filter(Boolean)
    .join(" ");
  return `<!doctype html><title>Team</title>
<meta name="plinth-capabilities" content="${caps}">
<p>team</p>`;
};

/** Set a signed-in person's display name through PATCH /api/v1/me. */
export async function setName(userId: string, name: string): Promise<Response> {
  const s = await browserSession(userId);
  return call("/api/v1/me", {
    method: "PATCH",
    headers: { ...s.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** Store a name directly, bypassing the write rules (a name stored before they existed). */
export async function storeRawName(userId: string, name: string | null): Promise<void> {
  await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, userId).run();
}

export interface Holder {
  email: string;
  userId: string | null;
  cookie: string;
  viewerId: string;
}

/** A signed-in person with a grant (and a name, when given), with their content cookie. */
export async function holder(id: string, role: Role, name?: string): Promise<Holder> {
  const user = await createUser();
  if (name !== undefined) expectOk(await setName(user.id, name));
  await grant(id, user.email, role);
  const s = await browserSession(user.id);
  return {
    email: user.email,
    userId: user.id,
    cookie: await cookieFor(id, s.headers),
    viewerId: await viewerIdFor(SECRET, id, user.email),
  };
}

function expectOk(res: Response): void {
  if (res.status !== 200) throw new Error(`PATCH /me: ${res.status}`);
}

export interface ApiOpts {
  method?: string;
  cookie?: string | null;
  body?: unknown;
  /** Merged over the default browser-like headers; null removes one. */
  headers?: Record<string, string | null>;
  vars?: Vars;
}

/** A request the way the runtime makes it: same-origin fetch with the custom header. */
export function api(id: string, path: string, opts: ApiOpts = {}): Promise<Response> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "PUT");
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
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) })) {
    if (v !== null) headers.set(k, v);
  }
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return run(`${contentOrigin(id)}/__plinth/api/v1${path}`, { method, headers, body }, opts.vars);
}

/** The error code and details of a JSON error response. */
export async function errOf(res: Response): Promise<{ code: string; details?: any }> {
  return (await json(res)).error;
}
