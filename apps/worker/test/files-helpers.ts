// Helpers for the tests of files people add to a page: a published page that declares `files`,
// people with content cookies minted through the real gate and enter flow (with ALLOW_FILES on),
// requests the way the runtime makes them, an upload, file fixtures and a takedown.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FILE_LIMITS, type Role } from "@plinth/shared";
import { expect } from "vitest";
import { parseConfig } from "../src/config.ts";
import { accessGrants } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  APP,
  agent,
  browserSession,
  contentOrigin,
  createUser,
  db,
  enterContent,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";

export const SECRET = "test-token-signing-key-0123456789abcdef012345";
/** ALLOW_FILES on: every request of these tests runs with it. */
export const ON: Record<string, string> = { ALLOW_FILES: "true" };

export const FILES_PAGE = `<!doctype html><title>Gallery</title>
<meta name="plinth-capabilities" content="files viewer"><p>gallery</p>`;
export const FILES_ONLY = `<!doctype html><title>Drop</title>
<meta name="plinth-capabilities" content="files"><p>drop</p>`;
export const DATA_ONLY = `<!doctype html><title>Tally</title>
<meta name="plinth-capabilities" content="data"><p>tally</p>`;

/** Run a request through the Worker with ALLOW_FILES on (and `vars`), waiting for its waitUntil. */
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

/** A files API request the way the runtime makes it: same-origin fetch with the custom header. */
export function filesApi(id: string, path: string, opts: ApiOpts = {}): Promise<Response> {
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
    `${contentOrigin(id)}/__plinth/api/v1/files${path}`,
    { method, headers, body },
    opts.vars,
  );
}

/** A file's bytes the way <img> loads them. */
export function fileGet(
  id: string,
  fileId: string,
  opts: {
    cookie?: string | null;
    headers?: Record<string, string | null>;
    query?: string;
    method?: string;
    vars?: Record<string, string>;
  } = {},
): Promise<Response> {
  const base: Record<string, string | null> = {
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-dest": "image",
    cookie: opts.cookie ?? null,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) }))
    if (v !== null) headers.set(k, v);
  return run(
    `${contentOrigin(id)}/__plinth/files/${fileId}${opts.query ?? ""}`,
    { method: opts.method ?? "GET", headers },
    opts.vars,
  );
}

export async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

export async function cookieFor(id: string, headers?: Record<string, string>): Promise<string> {
  const { cookie, gate } = await enterContent(id, { headers, vars: ON });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return cookie;
}

export interface Person {
  email: string;
  cookie: string;
  viewerId: string;
  userId: string;
  headers: Record<string, string>;
}

/** A published page with its owner able to open it. */
export async function setup(html = FILES_PAGE, visibility = "allowlist") {
  const owner = await agent();
  const { body } = await publish(owner.auth, { html, visibility });
  const id = body.id as string;
  const s = await browserSession(owner.user.id);
  const ownerP: Person = {
    userId: owner.user.id,
    email: owner.user.email,
    cookie: await cookieFor(id, s.headers),
    viewerId: await viewerIdFor(SECRET, id, owner.user.email),
    headers: s.headers,
  };
  return { owner, id, ownerP };
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
    viewerId: await viewerIdFor(SECRET, id, user.email),
    headers: s.headers,
  };
}

export const errOf = async (res: Response) =>
  (await json(res)).error as { code: string; message: string; details?: any };

// ---------- fixtures ----------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `n` bytes starting with `head`, the rest a repeating pattern. */
export function bytesOf(head: readonly number[] | string, n: number): Uint8Array {
  const h = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  const out = new Uint8Array(n);
  out.set(h.slice(0, n));
  for (let i = h.length; i < n; i++) out[i] = (i * 31) & 0xff;
  return out;
}

export const png = (n = 300) => bytesOf(PNG_SIG, n);
export const jpeg = (n = 300) => bytesOf([0xff, 0xd8, 0xff, 0xe0], n);
export const pdf = (n = 300) => bytesOf("%PDF-1.7\n", n);
export const mp4 = (n: number) =>
  bytesOf([0, 0, 0, 0x18, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), 0, 0, 2, 0], n);
export const svg = () =>
  bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 80);
export const html = () => bytesOf("<!doctype html><script>alert(document.cookie)</script>", 80);

/** Base64 of bytes, in chunks. */
export function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Start an upload and send every part; returns the final answer's file. */
export async function upload(
  id: string,
  who: Person,
  bytes: Uint8Array,
  type: string,
  name = "photo.png",
): Promise<{ id: string; created: any; last: any }> {
  const res = await filesApi(id, "", {
    cookie: who.cookie,
    body: { name, type, size: bytes.byteLength },
  });
  const created = await json(res);
  expect(res.status, JSON.stringify(created)).toBe(201);
  const fileId = created.file.id as string;
  let last: any = null;
  for (let n = 1; n <= created.parts; n++) {
    const part = bytes.subarray((n - 1) * FILE_LIMITS.partBytes, n * FILE_LIMITS.partBytes);
    const r = await filesApi(id, `/${fileId}/parts/${n}`, {
      method: "PUT",
      cookie: who.cookie,
      body: { data: b64(part) },
    });
    last = await json(r);
    expect(r.status, JSON.stringify(last)).toBe(200);
  }
  return { id: fileId, created, last };
}

/** The artifact's file usage row, or zeros. */
export async function usage(id: string) {
  return (
    (await env.DB.prepare(
      "SELECT files, bytes, seq FROM artifact_file_usage WHERE artifact_id = ?1",
    )
      .bind(id)
      .first<{ files: number; bytes: number; seq: number }>()) ?? { files: 0, bytes: 0, seq: 0 }
  );
}

export async function fileRow(fileId: string) {
  return env.DB.prepare("SELECT * FROM artifact_files WHERE id = ?1")
    .bind(fileId)
    .first<Record<string, any>>();
}

// ---------- takedown ----------

/** Report the artifact and have an admin take it down through the admin endpoint. */
export async function takeDown(artifactId: string): Promise<void> {
  const email = uniqueEmail("admin");
  const vars = { ADMIN_EMAIL: email };
  const config = parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>);
  const user = await getOrCreateUser(db(), config, email, { verified: true });
  const s = await browserSession(user.id);
  const reportId = `r${Math.random().toString(36).slice(2, 12)}`;
  await env.DB.prepare(
    "INSERT INTO reports (id, artifact_id, reason, state, created_at) VALUES (?1, ?2, ?3, 'open', ?4)",
  )
    .bind(reportId, artifactId, "Abuse in the uploaded files", nowIso())
    .run();
  const decided = await run(
    `/api/v1/admin/reports/${reportId}`,
    {
      method: "POST",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ state: "actioned" }),
    },
    vars,
  );
  expect(decided.status).toBe(200);
}

/** The artifact's current access epoch, for passes signed by hand. */
export async function epochOf(artifactId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT access_epoch FROM artifacts WHERE id = ?1")
    .bind(artifactId)
    .first<{ access_epoch: number }>();
  return row?.access_epoch ?? 0;
}
