// The shared-data API on an artifact's own content origin (/__plinth/api/v1/...): the ordered
// request checks, access through the content cookie, the page rules and the limits. Cookies are
// minted through the real gate and enter flow. Design:
// docs/superpowers/specs/2026-11-14-shared-state-design.md sections 4 to 6.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Role } from "@plinth/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contentCsp } from "../src/content/csp.ts";
import { accessGrants, artifacts } from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { nowIso } from "../src/lib/time.ts";
import {
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  createUser,
  db,
  enterContent,
  json,
  publish,
} from "./helpers.ts";

const SECRET = "test-token-signing-key-0123456789abcdef012345";
const POLL = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-shared" content="tasks">
<p>poll</p>`;
const DATA_ONLY = `<!doctype html><title>Tally</title>
<meta name="plinth-capabilities" content="data"><p>tally</p>`;
const PLAIN = "<!doctype html><title>Plain</title><p>nothing declared</p>";

type Vars = Record<string, string>;

async function run(url: string, init: RequestInit = {}, vars: Vars = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { redirect: "manual", ...init }),
    { ...env, ...vars } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

interface ApiOpts {
  method?: string;
  cookie?: string | null;
  body?: unknown;
  /** Replaces the default browser-like headers (merged over them). */
  headers?: Record<string, string | null>;
  vars?: Vars;
}

/** A request the way the runtime makes it: same-origin fetch with the custom header. */
function api(id: string, path: string, opts: ApiOpts = {}): Promise<Response> {
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
  const merged = { ...base, ...(opts.headers ?? {}) };
  const headers = new Headers();
  for (const [k, v] of Object.entries(merged)) if (v !== null) headers.set(k, v);
  const body =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  return run(`${contentOrigin(id)}/__plinth/api/v1${path}`, { method, headers, body }, opts.vars);
}

async function grant(artifactId: string, email: string, role: Role) {
  await db()
    .insert(accessGrants)
    .values({ artifactId, email, role, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [accessGrants.artifactId, accessGrants.email], set: { role } })
    .run();
}

async function cookieFor(id: string, headers?: Record<string, string>): Promise<string> {
  const { cookie, gate } = await enterContent(id, { headers });
  if (!cookie) throw new Error(`no content cookie (gate ${gate.status})`);
  return cookie;
}

interface Person {
  email: string;
  cookie: string;
  viewerId: string;
  userId: string;
}

/** A published artifact with its owner able to open it. */
async function setup(
  html = POLL,
  visibility = "allowlist",
  ownerAgent?: Awaited<ReturnType<typeof agent>>,
) {
  const owner = ownerAgent ?? (await agent());
  const { body } = await publish(owner.auth, { html, visibility });
  const id = body.id as string;
  const s = await browserSession(owner.user.id);
  const me: Person = {
    userId: owner.user.id,
    email: owner.user.email,
    cookie: await cookieFor(id, s.headers),
    viewerId: await viewerIdFor(SECRET, id, owner.user.email),
  };
  return { owner, id, ownerP: me };
}

/** A signed-in person with a grant on the artifact, and their content cookie. */
async function person(id: string, role: Role): Promise<Person> {
  const user = await createUser();
  await grant(id, user.email, role);
  const s = await browserSession(user.id);
  return {
    userId: user.id,
    email: user.email,
    cookie: await cookieFor(id, s.headers),
    viewerId: await viewerIdFor(SECRET, id, user.email),
  };
}

async function anonCookie(id: string): Promise<string> {
  return cookieFor(id);
}

const errOf = async (res: Response) => (await json(res)).error as { code: string; details?: any };

function expectContentHeaders(res: Response, label = "") {
  expect(res.headers.get("content-security-policy"), label).toBe(contentCsp(config()));
  expect(res.headers.get("cache-control"), label).toBe("no-store");
  expect(res.headers.get("content-type"), label).toBe("application/json; charset=utf-8");
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  for (const [k] of res.headers)
    expect(k.startsWith("access-control-"), `${label} ${k}`).toBe(false);
  expect(res.headers.get("set-cookie"), label).toBeNull();
}

// ---------- request checks ----------

describe("request checks", () => {
  it("refuses a request without the custom header, on GET and on PUT", async () => {
    const { id, ownerP } = await setup();
    const get = await api(id, "/session", {
      cookie: ownerP.cookie,
      headers: { "x-plinth-data": null },
    });
    expect(get.status).toBe(403);
    expectContentHeaders(get, "get");
    const put = await api(id, "/data/votes/a1", {
      cookie: ownerP.cookie,
      body: { data: { v: 1 } },
      headers: { "x-plinth-data": null },
    });
    expect(put.status).toBe(403);
    const wrong = await api(id, "/session", {
      cookie: ownerP.cookie,
      headers: { "x-plinth-data": "yes" },
    });
    expect(wrong.status).toBe(403);
  });

  it("refuses same-site and cross-site fetch metadata", async () => {
    const { id, ownerP } = await setup();
    for (const site of ["same-site", "cross-site", "none"]) {
      const res = await api(id, "/data/votes/a1", {
        cookie: ownerP.cookie,
        body: { data: { v: 1 } },
        headers: { "sec-fetch-site": site },
      });
      expect(res.status, site).toBe(403);
      expectContentHeaders(res, site);
    }
    const noMeta = await api(id, "/session", {
      cookie: ownerP.cookie,
      headers: { "sec-fetch-site": null, "sec-fetch-mode": null, "sec-fetch-dest": null },
    });
    expect(noMeta.status).toBe(200);
  });

  it("refuses a foreign Origin and a null Origin", async () => {
    const { id, ownerP } = await setup();
    const { id: other } = await setup();
    for (const origin of [
      contentOrigin(other),
      "null",
      "http://app.localhost:8787",
      "https://evil.example",
    ]) {
      const res = await api(id, "/data/votes/a1", {
        cookie: ownerP.cookie,
        body: { data: { v: 1 } },
        headers: { origin },
      });
      expect(res.status, origin).toBe(403);
    }
  });

  it("refuses navigations and non-empty destinations", async () => {
    const { id, ownerP } = await setup();
    const nav = await api(id, "/session", {
      cookie: ownerP.cookie,
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty" },
    });
    expect(nav.status).toBe(403);
    expectContentHeaders(nav, "navigate");
    expect(nav.headers.get("location")).toBeNull();
    for (const dest of ["document", "iframe", "script", "image"]) {
      const res = await api(id, "/session", {
        cookie: ownerP.cookie,
        headers: { "sec-fetch-dest": dest },
      });
      expect(res.status, dest).toBe(403);
      expect(res.headers.get("location"), dest).toBeNull();
    }
  });

  it("answers OPTIONS and other methods with 405 and no CORS headers", async () => {
    const { id, ownerP } = await setup();
    for (const method of ["OPTIONS", "PATCH", "HEAD"]) {
      const res = await api(id, "/data/votes/a1", {
        method,
        cookie: ownerP.cookie,
        headers: {
          "access-control-request-method": "PUT",
          "access-control-request-headers": "x-plinth-data",
        },
      });
      expect(res.status, method).toBe(405);
      for (const [k] of res.headers) expect(k.startsWith("access-control-"), k).toBe(false);
      expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    }
  });

  it("refuses text/plain and form-encoded bodies", async () => {
    const { id, ownerP } = await setup();
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await api(id, "/data/votes/a1", {
        cookie: ownerP.cookie,
        body: JSON.stringify({ data: { v: 1 } }),
        headers: { "content-type": type },
      });
      expect(res.status, type).toBe(400);
      expectContentHeaders(res, type);
    }
    const none = await api(id, "/data/votes", {
      method: "POST",
      cookie: ownerP.cookie,
      body: JSON.stringify({ data: { v: 1 } }),
      headers: { "content-type": null },
    });
    expect(none.status).toBe(400);
    const charset = await api(id, "/data/votes/a1", {
      cookie: ownerP.cookie,
      body: { data: { v: 1 } },
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(charset.status).toBe(201);
  });

  it("refuses an over-cap body by Content-Length and by counting a chunked body", async () => {
    const { id, ownerP } = await setup();
    const cap = config().data.maxDocBytes + 1024;
    const big = JSON.stringify({ data: { s: "x".repeat(cap) } });
    const sized = await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body: big });
    expect(sized.status).toBe(413);
    expectContentHeaders(sized, "sized");

    const declared = await api(id, "/data/votes/a1", {
      cookie: ownerP.cookie,
      body: JSON.stringify({ data: { v: 1 } }),
      headers: { "content-length": String(cap + 1) },
    });
    expect(declared.status).toBe(413);

    const enc = new TextEncoder();
    const chunk = enc.encode("x".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"data":{"s":"'));
      },
      pull(c) {
        if (sent > cap * 4) {
          c.enqueue(enc.encode('"}}'));
          c.close();
          return;
        }
        sent += chunk.byteLength;
        c.enqueue(chunk);
      },
    });
    const res = await run(`${contentOrigin(id)}/__plinth/api/v1/data/votes/a1`, {
      method: "PUT",
      headers: {
        "x-plinth-data": "1",
        "content-type": "application/json",
        origin: contentOrigin(id),
        cookie: ownerP.cookie,
      },
      body: stream,
      // @ts-expect-error duplex is required for a streamed request body
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(cap * 2);
  });

  it("refuses unknown keys, such as author fields, and malformed JSON", async () => {
    const { id, ownerP } = await setup();
    for (const body of [
      { data: { v: 1 }, created_by: { email: "boss@example.com" } },
      { data: { v: 1 }, updated_by_email: "x@example.com" },
      { data: { v: 1 }, via: "agent" },
      { v: 1 },
      { data: [1, 2] },
      { data: "text" },
    ]) {
      const res = await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errOf(res)).code).toBe("invalid_input");
    }
    const post = await api(id, "/data/votes", {
      method: "POST",
      cookie: ownerP.cookie,
      body: { data: { v: 1 }, id: "chosen" },
    });
    expect(post.status).toBe(400);
    const bad = await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body: "{not json" });
    expect(bad.status).toBe(400);
  });

  it("refuses bad collection names and document ids, and unknown routes", async () => {
    const { id, ownerP } = await setup();
    for (const path of [
      "/data/Votes",
      "/data/1x",
      "/data/votes/-a",
      "/data/votes/a%2Fb",
      "/data/votes/a/b",
    ]) {
      const res = await api(id, path, { cookie: ownerP.cookie });
      expect([400, 404], path).toContain(res.status);
      expectContentHeaders(res, path);
    }
    const unknown = await api(id, "/nope", { cookie: ownerP.cookie });
    expect(unknown.status).toBe(404);
    const v2 = await api(id, "/../session", { cookie: ownerP.cookie });
    expect(v2.status).not.toBe(200);
  });
});

// ---------- access ----------

describe("access", () => {
  it("no cookie, another artifact's cookie and an old epoch get a JSON 401, never a redirect", async () => {
    const { owner, id, ownerP } = await setup();
    const { id: b } = await setup(POLL, "allowlist", owner);
    const cases: [string, string | null][] = [
      ["none", null],
      ["A on B", ownerP.cookie],
    ];
    for (const [label, cookie] of cases) {
      for (const [path, method, body] of [
        ["/session", "GET", undefined],
        ["/data/votes", "GET", undefined],
        ["/data/votes/a1", "PUT", { data: { v: 1 } }],
      ] as const) {
        const res = await api(b, path, {
          cookie,
          method,
          body,
          headers: { "sec-fetch-dest": "empty" },
        });
        expect(res.status, `${label} ${method} ${path}`).toBe(401);
        expect(res.headers.get("location")).toBeNull();
        const e = await errOf(res);
        expect(e.code).toBe("unauthorized");
        expect(e.details).toEqual({ reason: "expired" });
        expectContentHeaders(res, label);
      }
    }
    expect((await api(id, "/session", { cookie: ownerP.cookie })).status).toBe(200);
    await db()
      .update(artifacts)
      .set({ accessEpoch: sql`${artifacts.accessEpoch} + 1` })
      .where(eq(artifacts.id, id))
      .run();
    const after = await api(id, "/session", { cookie: ownerP.cookie });
    expect(after.status).toBe(401);
    expect((await errOf(after)).details).toEqual({ reason: "expired" });
  });

  it("a deleted or taken-down artifact is a JSON 404", async () => {
    const { owner, id, ownerP } = await setup();
    await db().update(artifacts).set({ takenDownAt: nowIso() }).where(eq(artifacts.id, id)).run();
    const res = await api(id, "/session", { cookie: ownerP.cookie });
    expect(res.status).toBe(404);
    expectContentHeaders(res, "taken down");
    const { id: b, ownerP: o2 } = await setup(POLL, "allowlist", owner);
    await db().update(artifacts).set({ deletedAt: nowIso() }).where(eq(artifacts.id, b)).run();
    expect((await api(b, "/data/votes", { cookie: o2.cookie })).status).toBe(404);
  });

  it("not_declared: session says so, everything else is feature_disabled", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const s = await api(id, "/session", { cookie: ownerP.cookie });
    expect(s.status).toBe(200);
    expectContentHeaders(s, "session");
    expect(await json(s)).toEqual({ available: false, reason: "not_declared" });
    for (const [path, body] of [
      ["/changes", undefined],
      ["/data/votes", undefined],
      ["/data/votes/a1", { data: { v: 1 } }],
    ] as const) {
      const res = await api(id, path, { cookie: ownerP.cookie, body });
      expect(res.status, path).toBe(403);
      const e = await errOf(res);
      expect(e.code).toBe("feature_disabled");
      expect(e.details).toEqual({ reason: "not_declared" });
    }
  });

  it("disabled and opaque_isolation: session 200 available:false, others 403", async () => {
    const { id, ownerP } = await setup();
    for (const [vars, reason] of [
      [{ ALLOW_SHARED_DATA: "false" }, "disabled"],
      [{ CONTENT_ISOLATION: "opaque" }, "opaque_isolation"],
    ] as const) {
      for (const cookie of [ownerP.cookie, null]) {
        const s = await api(id, "/session", { cookie, vars });
        expect(s.status, reason).toBe(200);
        expect(await json(s)).toEqual({ available: false, reason });
        const res = await api(id, "/data/votes/a1", { cookie, body: { data: { v: 1 } }, vars });
        expect(res.status, reason).toBe(403);
        const e = await errOf(res);
        expect(e.code).toBe("feature_disabled");
        expect(e.details).toEqual({ reason });
        expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
  });
});

// ---------- session ----------

describe("session", () => {
  it("anonymous link viewer: no viewer, no writing", async () => {
    const { id } = await setup(POLL, "unlisted");
    const res = await api(id, "/session", { cookie: await anonCookie(id) });
    expect(res.status).toBe(200);
    expectContentHeaders(res, "session");
    const d = config().data;
    expect(await json(res)).toEqual({
      available: true,
      viewer: null,
      can_write: false,
      capabilities: ["data", "viewer"],
      shared: ["tasks"],
      limits: {
        max_doc_bytes: d.maxDocBytes,
        max_docs: d.maxDocsPerArtifact,
        max_bytes: d.maxBytesPerArtifact,
      },
      usage: { docs: 0, bytes: 0 },
      seq: 0,
    });
  });

  it("identified with `viewer`: id, email and role", async () => {
    const { id } = await setup(POLL);
    const c = await person(id, "commenter");
    const s = await json(await api(id, "/session", { cookie: c.cookie }));
    expect(s.viewer).toEqual({ id: c.viewerId, email: c.email, role: "commenter" });
    expect(s.can_write).toBe(true);
  });

  it("identified without `viewer`: id and role, no email", async () => {
    const { id, ownerP } = await setup(DATA_ONLY);
    const s = await json(await api(id, "/session", { cookie: ownerP.cookie }));
    expect(s.viewer).toEqual({ id: ownerP.viewerId, email: null, role: "owner" });
    expect(s.capabilities).toEqual(["data"]);
    expect(s.shared).toEqual([]);
    expect(s.can_write).toBe(true);
  });

  it("`viewer` without `data` declares nothing: /session and the gate agree", async () => {
    const { owner, id, ownerP } = await setup(
      '<!doctype html><meta name="plinth-capabilities" content="viewer"><p>x</p>',
    );
    const s = await api(id, "/session", { cookie: ownerP.cookie });
    expect(s.status).toBe(200);
    expect(await json(s)).toEqual({ available: false, reason: "not_declared" });
    // The gate shows no data notice, so it never tells the viewer the page sees their email.
    const bs = await browserSession(owner.user.id);
    const gate = await json(await call(`/api/v1/view/${id}`, { headers: bs.headers }));
    expect(gate.status).toBe("ok");
    expect(gate.data).toBeUndefined();
  });

  it("`room` without `data` is not shared data: not_declared, no reads, no writes, no gate notice", async () => {
    const { owner, id, ownerP } = await setup(
      '<!doctype html><meta name="plinth-capabilities" content="viewer room"><meta name="plinth-room-open" content="*"><p>x</p>',
    );
    const s = await api(id, "/session", { cookie: ownerP.cookie });
    expect(s.status).toBe(200);
    expect(await json(s)).toEqual({ available: false, reason: "not_declared" });
    const list = await api(id, "/data/votes", { cookie: ownerP.cookie });
    expect(list.status).toBe(403);
    expect((await json(list)).error.details).toEqual({ reason: "not_declared" });
    const write = await api(id, "/data/votes/a1", {
      cookie: ownerP.cookie,
      body: { data: { v: 1 } },
    });
    expect(write.status).toBe(403);
    const bs = await browserSession(owner.user.id);
    const gate = await json(await call(`/api/v1/view/${id}`, { headers: bs.headers }));
    expect(gate.status).toBe("ok");
    expect(gate.data).toBeUndefined();
    // It is stored as a room declaration all the same.
    const row = await env.DB.prepare(
      "SELECT capabilities FROM versions WHERE artifact_id = ?1 AND number = 1",
    )
      .bind(id)
      .first<{ capabilities: string }>();
    expect(JSON.parse(row?.capabilities ?? "null")).toEqual({
      data: false,
      viewer: true,
      shared: [],
      room: true,
      roomOpen: ["*"],
    });
  });

  it("usage and seq follow writes; /changes returns seq", async () => {
    const { id, ownerP } = await setup();
    expect(await json(await api(id, "/changes", { cookie: ownerP.cookie }))).toEqual({ seq: 0 });
    await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body: { data: { v: 1 } } });
    await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body: { data: { v: 2 } } });
    const ch = await api(id, "/changes", { cookie: ownerP.cookie });
    expectContentHeaders(ch, "changes");
    expect(await json(ch)).toEqual({ seq: 2 });
    const s = await json(await api(id, "/session", { cookie: ownerP.cookie }));
    expect(s.seq).toBe(2);
    expect(s.usage.docs).toBe(1);
    expect(s.usage.bytes).toBe("votes".length + "a1".length + JSON.stringify({ v: 2 }).length);
  });
});

// ---------- writes ----------

describe("writes", () => {
  it("an anonymous viewer reads but cannot write (read_only)", async () => {
    const { id, ownerP } = await setup(POLL, "unlisted");
    expect(
      (await api(id, "/data/votes/a1", { cookie: ownerP.cookie, body: { data: { v: 1 } } })).status,
    ).toBe(201);
    const anon = await anonCookie(id);
    const list = await api(id, "/data/votes", { cookie: anon });
    expect(list.status).toBe(200);
    expect((await json(list)).docs.map((d: any) => d.id)).toEqual(["a1"]);
    for (const [method, path, body] of [
      ["PUT", "/data/votes/a2", { data: { v: 1 } }],
      ["PUT", "/data/votes/a1", { data: { v: 9 } }],
      ["POST", "/data/votes", { data: { v: 1 } }],
      ["DELETE", "/data/votes/a1", undefined],
      ["PUT", "/data/votes/~me", { data: { v: 1 } }],
    ] as const) {
      const res = await api(id, path, { cookie: anon, method, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      const e = await errOf(res);
      expect(e.code).toBe("forbidden");
      expect(e.details).toEqual({ reason: "read_only" });
    }
    const got = await json(await api(id, "/data/votes/a1", { cookie: anon }));
    expect(got.data).toEqual({ v: 1 });
    expect(got.rev).toBe(1);
  });

  it("a commenter creates, but cannot change another person's doc outside a shared collection", async () => {
    const { id } = await setup(POLL);
    const a = await person(id, "commenter");
    const b = await person(id, "commenter");
    const created = await api(id, "/data/votes", {
      method: "POST",
      cookie: a.cookie,
      body: { data: { v: 1 } },
    });
    expect(created.status).toBe(201);
    const doc = await json(created);
    expect(doc.id).toMatch(/^[a-z0-9]{20}$/);
    expect(doc.rev).toBe(1);
    expect(doc.mine).toBe(true);
    expect(doc.personal).toBe(false);

    const put = await api(id, `/data/votes/${doc.id}`, {
      cookie: b.cookie,
      body: { data: { v: 2 } },
    });
    expect(put.status).toBe(403);
    expect((await errOf(put)).code).toBe("forbidden");
    expect(
      (await api(id, `/data/votes/${doc.id}`, { method: "DELETE", cookie: b.cookie })).status,
    ).toBe(403);
    // The creator may.
    const own = await api(id, `/data/votes/${doc.id}`, {
      cookie: a.cookie,
      body: { data: { v: 3 } },
    });
    expect(own.status).toBe(200);
    expect((await json(own)).rev).toBe(2);

    // In the declared shared collection anyone identified may edit.
    expect(
      (await api(id, "/data/tasks/t1", { cookie: a.cookie, body: { data: { done: false } } }))
        .status,
    ).toBe(201);
    const shared = await api(id, "/data/tasks/t1", {
      cookie: b.cookie,
      body: { data: { done: true } },
    });
    expect(shared.status).toBe(200);
    expect((await json(shared)).data).toEqual({ done: true });
    // ...but never another person's personal doc, even there.
    expect(
      (await api(id, "/data/tasks/~me", { cookie: a.cookie, body: { data: { mine: 1 } } })).status,
    ).toBe(201);
    const theirs = await api(id, `/data/tasks/${a.viewerId}`, {
      cookie: b.cookie,
      body: { data: { x: 1 } },
    });
    expect(theirs.status).toBe(403);
    expect(
      (await api(id, `/data/tasks/${a.viewerId}`, { method: "DELETE", cookie: b.cookie })).status,
    ).toBe(403);
    expect((await api(id, "/data/tasks/t1", { method: "DELETE", cookie: b.cookie })).status).toBe(
      204,
    );
  });

  it("an editor and the owner moderate", async () => {
    const { id, ownerP } = await setup(POLL);
    const c = await person(id, "commenter");
    const e = await person(id, "editor");
    await api(id, "/data/votes/c1", { cookie: c.cookie, body: { data: { v: 1 } } });
    await api(id, "/data/votes/~me", { cookie: c.cookie, body: { data: { v: 1 } } });
    const ed = await api(id, "/data/votes/c1", { cookie: e.cookie, body: { data: { v: 0 } } });
    expect(ed.status).toBe(200);
    const edMe = await api(id, `/data/votes/${c.viewerId}`, {
      cookie: e.cookie,
      body: { data: { v: 0 } },
    });
    expect(edMe.status).toBe(200);
    expect(
      (await api(id, "/data/votes/c1", { method: "DELETE", cookie: ownerP.cookie })).status,
    ).toBe(204);
    expect(
      (await api(id, `/data/votes/${c.viewerId}`, { method: "DELETE", cookie: ownerP.cookie }))
        .status,
    ).toBe(204);
    expect((await api(id, "/data/votes/c1", { cookie: ownerP.cookie })).status).toBe(404);
  });

  it("demoting or removing a grant through PUT /sharing ends the cookie's role at once", async () => {
    const { owner, id } = await setup(POLL);
    const c = await person(id, "commenter");
    const e = await person(id, "editor");
    await api(id, "/data/votes/c1", { cookie: c.cookie, body: { data: { v: 1 } } });
    // The editor moderates the commenter's document with their current cookie.
    expect(
      (await api(id, "/data/votes/c1", { cookie: e.cookie, body: { data: { v: 2 } } })).status,
    ).toBe(200);
    const putSharing = (grants: { email: string; role: Role }[]) =>
      call(`/api/v1/artifacts/${id}/sharing`, {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ grants }),
      });
    // Only a role changes: the editor becomes a viewer.
    const demoted = await putSharing([
      { email: c.email, role: "commenter" },
      { email: e.email, role: "viewer" },
    ]);
    expect(demoted.status).toBe(200);
    for (const req of [
      { cookie: e.cookie, body: { data: { v: 3 } } },
      { cookie: e.cookie, method: "DELETE" },
      { cookie: e.cookie },
    ] as ApiOpts[]) {
      const res = await api(id, "/data/votes/c1", req);
      expect(res.status, req.method ?? "PUT/GET").toBe(401);
      expect(await errOf(res)).toMatchObject({
        code: "unauthorized",
        details: { reason: "expired" },
      });
    }
    // Back through the gate, the new cookie carries the new role and cannot moderate.
    const again = await cookieFor(id, (await browserSession(e.userId)).headers);
    expect((await json(await api(id, "/session", { cookie: again }))).viewer.role).toBe("viewer");
    const refused = await api(id, "/data/votes/c1", { cookie: again, body: { data: { v: 4 } } });
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe("forbidden");
    // Removing a grant ends the commenter's pass the same way.
    const cAgain = await cookieFor(id, (await browserSession(c.userId)).headers);
    expect(
      (await api(id, "/data/votes/~me", { cookie: cAgain, body: { data: { v: 5 } } })).status,
    ).toBe(201);
    expect((await putSharing([{ email: e.email, role: "viewer" }])).status).toBe(200);
    const removed = await api(id, "/data/votes/~me", { cookie: cAgain, body: { data: { v: 6 } } });
    expect(removed.status).toBe(401);
    const ownerNow = await cookieFor(id, (await browserSession(owner.user.id)).headers);
    expect((await json(await api(id, "/data/votes/c1", { cookie: ownerNow }))).data).toEqual({
      v: 2,
    });
  });

  it("~me is stable per person and differs between people", async () => {
    const { id } = await setup(POLL);
    const a = await person(id, "viewer");
    const b = await person(id, "viewer");
    const first = await json(
      await api(id, "/data/votes/~me", { cookie: a.cookie, body: { data: { choice: "x" } } }),
    );
    expect(first.id).toBe(a.viewerId);
    expect(first.personal).toBe(true);
    expect(first.mine).toBe(true);
    const second = await json(
      await api(id, "/data/votes/~me", { cookie: a.cookie, body: { data: { choice: "y" } } }),
    );
    expect(second.id).toBe(a.viewerId);
    expect(second.rev).toBe(2);
    const other = await json(
      await api(id, "/data/votes/~me", { cookie: b.cookie, body: { data: { choice: "x" } } }),
    );
    expect(other.id).toBe(b.viewerId);
    expect(other.id).not.toBe(a.viewerId);
    const mine = await json(await api(id, "/data/votes/~me", { cookie: a.cookie }));
    expect(mine.data).toEqual({ choice: "y" });
    const list = await json(await api(id, "/data/votes", { cookie: a.cookie }));
    expect(list.docs).toHaveLength(2);
    expect((await api(id, "/data/votes/~me", { method: "DELETE", cookie: b.cookie })).status).toBe(
      204,
    );
    expect((await api(id, "/data/votes/~me", { cookie: b.cookie })).status).toBe(404);
  });

  it("refuses creating someone else's u_ id, even for the owner", async () => {
    const { id, ownerP } = await setup(POLL);
    const v = await person(id, "viewer");
    for (const docId of [v.viewerId, "u_0123456789abcdef01234567", "u_x"]) {
      const res = await api(id, `/data/votes/${docId}`, {
        cookie: ownerP.cookie,
        body: { data: { v: 1 } },
      });
      expect(res.status, docId).toBe(403);
      expect((await errOf(res)).code).toBe("forbidden");
    }
    // The person themselves may use their id directly.
    expect(
      (await api(id, `/data/votes/${v.viewerId}`, { cookie: v.cookie, body: { data: { v: 1 } } }))
        .status,
    ).toBe(201);
  });

  it("if_rev: 0 creates only, n replaces only at n, otherwise 409 with current_rev", async () => {
    const { id, ownerP } = await setup(POLL);
    const c = { cookie: ownerP.cookie };
    expect(
      (await api(id, "/data/votes/r1", { ...c, body: { data: { v: 1 }, if_rev: 0 } })).status,
    ).toBe(201);
    const again = await api(id, "/data/votes/r1", { ...c, body: { data: { v: 2 }, if_rev: 0 } });
    expect(again.status).toBe(409);
    expectContentHeaders(again, "conflict");
    expect(await errOf(again)).toMatchObject({ code: "conflict", details: { current_rev: 1 } });
    const stale = await api(id, "/data/votes/r1", { ...c, body: { data: { v: 2 }, if_rev: 5 } });
    expect(stale.status).toBe(409);
    expect((await errOf(stale)).details).toEqual({ current_rev: 1 });
    const ok = await api(id, "/data/votes/r1", { ...c, body: { data: { v: 2 }, if_rev: 1 } });
    expect(ok.status).toBe(200);
    expect((await json(ok)).rev).toBe(2);
    const missing = await api(id, "/data/votes/r9", { ...c, body: { data: { v: 2 }, if_rev: 3 } });
    expect(missing.status).toBe(409);
    expect((await errOf(missing)).details).toEqual({ current_rev: 0 });
    const del = await api(id, "/data/votes/r1?if_rev=1", { ...c, method: "DELETE" });
    expect(del.status).toBe(409);
    expect((await errOf(del)).details).toEqual({ current_rev: 2 });
    const del2 = await api(id, "/data/votes/r1?if_rev=2", { ...c, method: "DELETE" });
    expect(del2.status).toBe(204);
    expectContentHeaders(del2, "delete");
    expect((await api(id, "/data/votes/r1", { ...c, method: "DELETE" })).status).toBe(404);
    for (const bad of ["-1", "x", "1.5"]) {
      expect(
        (await api(id, `/data/votes/r1?if_rev=${bad}`, { ...c, method: "DELETE" })).status,
        bad,
      ).toBe(400);
    }
  });

  it("stamps authors server-side", async () => {
    const { id } = await setup(POLL);
    const a = await person(id, "commenter");
    const e = await person(id, "editor");
    await api(id, "/data/tasks/t1", { cookie: a.cookie, body: { data: { n: 1 } } });
    const doc = await json(
      await api(id, "/data/tasks/t1", { cookie: e.cookie, body: { data: { n: 2 } } }),
    );
    expect(doc.created_by).toEqual({ email: a.email, role: "commenter", via: "page" });
    expect(doc.updated_by).toEqual({ email: e.email, role: "editor", via: "page" });
    expect(doc.mine).toBe(false);
  });
});

// ---------- limits ----------

describe("limits", () => {
  it("documents per artifact: quota_exceeded, and updates still pass at quota", async () => {
    const vars = { DATA_MAX_DOCS_PER_ARTIFACT: "2" };
    const { id, ownerP } = await setup();
    const c = { cookie: ownerP.cookie, vars };
    expect((await api(id, "/data/votes/a", { ...c, body: { data: { v: 1 } } })).status).toBe(201);
    expect(
      (await api(id, "/data/votes", { ...c, method: "POST", body: { data: { v: 1 } } })).status,
    ).toBe(201);
    for (const [method, path] of [
      ["PUT", "/data/votes/c"],
      ["POST", "/data/votes"],
    ] as const) {
      const res = await api(id, path, { ...c, method, body: { data: { v: 1 } } });
      expect(res.status).toBe(403);
      expect(await errOf(res)).toMatchObject({
        code: "quota_exceeded",
        details: { limit: "docs" },
      });
    }
    expect((await api(id, "/data/votes/a", { ...c, body: { data: { v: 2 } } })).status).toBe(200);
  });

  it("the document and byte caps hold under concurrent writers", async () => {
    const usageMatches = async (id: string) => {
      const usage = await env.DB.prepare(
        "SELECT docs, bytes FROM artifact_data_usage WHERE artifact_id = ?1",
      )
        .bind(id)
        .first<{ docs: number; bytes: number }>();
      const sum = await env.DB.prepare(
        "SELECT count(*) AS docs, coalesce(sum(size_bytes), 0) AS bytes FROM artifact_docs WHERE artifact_id = ?1",
      )
        .bind(id)
        .first<{ docs: number; bytes: number }>();
      expect(usage).toEqual(sum);
      return sum;
    };
    const many = {
      DATA_WRITES_PER_VIEWER_PER_HOUR: "1000",
      DATA_WRITES_PER_ARTIFACT_PER_HOUR: "1000",
    };
    {
      const vars = { ...many, DATA_MAX_DOCS_PER_ARTIFACT: "3" };
      const { id, ownerP } = await setup();
      const res = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          i % 2
            ? api(id, `/data/votes/d${i}`, { cookie: ownerP.cookie, body: { data: { i } }, vars })
            : api(id, "/data/votes", {
                cookie: ownerP.cookie,
                method: "POST",
                body: { data: { i } },
                vars,
              }),
        ),
      );
      const statuses = res.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 201, 403, 403, 403, 403, 403, 403, 403]);
      for (const r of res.filter((x) => x.status === 403)) {
        expect(await errOf(r)).toMatchObject({
          code: "quota_exceeded",
          details: { limit: "docs" },
        });
      }
      expect((await usageMatches(id))?.docs).toBe(3);
    }
    {
      const vars = { ...many, DATA_MAX_DOC_BYTES: "1024", DATA_MAX_BYTES_PER_ARTIFACT: "2048" };
      const { id, ownerP } = await setup();
      const res = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          api(id, `/data/votes/b${i}`, {
            cookie: ownerP.cookie,
            body: { data: { s: "x".repeat(900) } },
            vars,
          }),
        ),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(2);
      expect((await usageMatches(id))?.bytes).toBeLessThanOrEqual(2048);
    }
  });

  it("bytes per artifact: growing past the cap fails, shrinking passes", async () => {
    const vars = { DATA_MAX_DOC_BYTES: "1024", DATA_MAX_BYTES_PER_ARTIFACT: "2048" };
    const { id, ownerP } = await setup();
    const c = { cookie: ownerP.cookie, vars };
    const blob = (n: number) => ({ data: { s: "x".repeat(n) } });
    expect((await api(id, "/data/votes/a", { ...c, body: blob(900) })).status).toBe(201);
    expect((await api(id, "/data/votes/b", { ...c, body: blob(900) })).status).toBe(201);
    const third = await api(id, "/data/votes/c", { ...c, body: blob(900) });
    expect(third.status).toBe(403);
    expect(await errOf(third)).toMatchObject({
      code: "quota_exceeded",
      details: { limit: "bytes" },
    });
    // About 1830 of 2048 bytes used; a small doc still fits, growing it past the cap does not.
    expect((await api(id, "/data/votes/c", { ...c, body: blob(150) })).status).toBe(201);
    const grow = await api(id, "/data/votes/c", { ...c, body: blob(300) });
    expect(grow.status).toBe(403);
    expect((await errOf(grow)).details).toEqual({ limit: "bytes" });
    // At the cap, shrinking passes, and frees room.
    expect((await api(id, "/data/votes/c", { ...c, body: blob(140) })).status).toBe(200);
    expect((await api(id, "/data/votes/a", { ...c, body: blob(100) })).status).toBe(200);
    expect((await api(id, "/data/votes/c", { ...c, body: blob(700) })).status).toBe(200);
    // A doc over DATA_MAX_DOC_BYTES is too large, whatever the quota.
    const huge = await api(id, "/data/votes/d", { ...c, body: blob(1100) });
    expect(huge.status).toBe(413);
    expect((await errOf(huge)).code).toBe("payload_too_large");
  });

  it("bytes per owner across artifacts", async () => {
    const vars = {
      DATA_MAX_DOC_BYTES: "1024",
      DATA_MAX_BYTES_PER_ARTIFACT: "4096",
      DATA_MAX_BYTES_PER_USER: "4096",
    };
    const owner = await agent();
    const a = await setup(POLL, "allowlist", owner);
    const b = await setup(POLL, "allowlist", owner);
    const blob = { data: { s: "x".repeat(900) } };
    for (const k of ["1", "2", "3"])
      expect(
        (await api(a.id, `/data/votes/${k}`, { cookie: a.ownerP.cookie, body: blob, vars })).status,
      ).toBe(201);
    expect(
      (await api(b.id, "/data/votes/1", { cookie: b.ownerP.cookie, body: blob, vars })).status,
    ).toBe(201);
    const over = await api(b.id, "/data/votes/2", { cookie: b.ownerP.cookie, body: blob, vars });
    expect(over.status).toBe(403);
    expect(await errOf(over)).toMatchObject({
      code: "quota_exceeded",
      details: { limit: "user_bytes" },
    });
    // Shrinking still passes at the per-owner cap.
    expect(
      (
        await api(b.id, "/data/votes/1", {
          cookie: b.ownerP.cookie,
          body: { data: { s: "y" } },
          vars,
        })
      ).status,
    ).toBe(200);
  });

  it("collections per artifact", async () => {
    const { id, ownerP } = await setup();
    const c = { cookie: ownerP.cookie };
    for (let i = 0; i < 50; i++) {
      const res = await api(id, `/data/c${i}/d`, { ...c, body: { data: { i } } });
      expect(res.status, `c${i}`).toBe(201);
    }
    const over = await api(id, "/data/c50/d", { ...c, body: { data: { i: 50 } } });
    expect(over.status).toBe(403);
    expect(await errOf(over)).toMatchObject({
      code: "quota_exceeded",
      details: { limit: "collections" },
    });
    expect((await api(id, "/data/c0/e", { ...c, body: { data: { i: 0 } } })).status).toBe(201);
  });

  it("write rate limits answer 429 with Retry-After", async () => {
    const { id, ownerP } = await setup(POLL);
    const v = await person(id, "commenter");
    const vars = { DATA_WRITES_PER_VIEWER_PER_HOUR: "2", DATA_WRITES_PER_ARTIFACT_PER_HOUR: "3" };
    expect(
      (await api(id, "/data/tasks/a", { cookie: v.cookie, body: { data: { n: 1 } }, vars })).status,
    ).toBe(201);
    expect(
      (await api(id, "/data/tasks/a", { cookie: v.cookie, method: "DELETE", vars })).status,
    ).toBe(204);
    const limited = await api(id, "/data/tasks/b", {
      cookie: v.cookie,
      body: { data: { n: 1 } },
      vars,
    });
    expect(limited.status).toBe(429);
    expectContentHeaders(limited, "429");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await errOf(limited)).code).toBe("rate_limited");
    // Reads are not limited.
    expect((await api(id, "/data/tasks", { cookie: v.cookie, vars })).status).toBe(200);
    // The artifact-wide limit: the owner gets one more write, then 429 too.
    expect(
      (await api(id, "/data/tasks/o", { cookie: ownerP.cookie, body: { data: { n: 1 } }, vars }))
        .status,
    ).toBe(201);
    const all = await api(id, "/data/tasks/p", {
      cookie: ownerP.cookie,
      body: { data: { n: 1 } },
      vars,
    });
    expect(all.status).toBe(429);
  });
});

// ---------- reads ----------

describe("reads", () => {
  it("authors are hidden from anonymous readers and when `viewer` is not declared", async () => {
    const withViewer = await setup(POLL, "unlisted");
    const a = await person(withViewer.id, "commenter");
    await api(withViewer.id, "/data/votes/x", { cookie: a.cookie, body: { data: { v: 1 } } });
    const anon = await json(
      await api(withViewer.id, "/data/votes", { cookie: await anonCookie(withViewer.id) }),
    );
    expect(anon.docs[0]).not.toHaveProperty("created_by");
    expect(anon.docs[0]).not.toHaveProperty("updated_by");
    expect(JSON.stringify(anon)).not.toContain(a.email);
    expect(anon.docs[0].mine).toBe(false);
    const seen = await json(
      await api(withViewer.id, "/data/votes", { cookie: withViewer.ownerP.cookie }),
    );
    expect(seen.docs[0].created_by).toEqual({ email: a.email, role: "commenter", via: "page" });

    const dataOnly = await setup(DATA_ONLY);
    const b = await person(dataOnly.id, "commenter");
    await api(dataOnly.id, "/data/votes/x", { cookie: b.cookie, body: { data: { v: 1 } } });
    for (const cookie of [b.cookie, dataOnly.ownerP.cookie]) {
      const list = await json(await api(dataOnly.id, "/data/votes", { cookie }));
      expect(list.docs[0]).not.toHaveProperty("created_by");
      expect(JSON.stringify(list)).not.toContain(b.email);
      const one = await json(await api(dataOnly.id, "/data/votes/x", { cookie }));
      expect(one).not.toHaveProperty("updated_by");
    }
  });

  it("mine is true only for the doc's creator", async () => {
    const { id } = await setup(POLL, "unlisted");
    const a = await person(id, "commenter");
    const b = await person(id, "commenter");
    await api(id, "/data/votes/x", { cookie: a.cookie, body: { data: { v: 1 } } });
    const mineA = (await json(await api(id, "/data/votes/x", { cookie: a.cookie }))).mine;
    const mineB = (await json(await api(id, "/data/votes/x", { cookie: b.cookie }))).mine;
    const mineAnon = (await json(await api(id, "/data/votes/x", { cookie: await anonCookie(id) })))
      .mine;
    expect([mineA, mineB, mineAnon]).toEqual([true, false, false]);
  });

  it("lists in creation order with a cursor", async () => {
    const { id, ownerP } = await setup();
    const c = { cookie: ownerP.cookie };
    const made: { id: string; at: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const doc = await json(
        await api(id, "/data/votes", { ...c, method: "POST", body: { data: { i } } }),
      );
      made.push({ id: doc.id, at: doc.created_at });
    }
    // Creation order is (created_at, id): two documents made in the same millisecond sort by id.
    const ids = made
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
      .map((d) => d.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page: any = await json(await api(id, `/data/votes${q}`, c));
      seen.push(...page.docs.map((d: any) => d.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
    for (const bad of ["?limit=0", "?limit=201", "?cursor=!!", "?cursor=bm90IGpzb24"]) {
      expect((await api(id, `/data/votes${bad}`, c)).status, bad).toBe(400);
    }
    const empty = await json(await api(id, "/data/other", c));
    expect(empty).toEqual({ docs: [], next_cursor: null });
  });
});
