// Live views (docs/spec.md "Live views", docs/security.md#live-views): the watch socket on the app
// host (api/watch.ts) and the watch kind of the artifact's ArtifactRoom. Real sockets through the
// Worker's fetch handler: the handshake's checks in order, the frames each signal sends, the caps,
// and every way a watch socket is closed.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { COOKIES, LIVE_VIEW_LIMITS, spreadMs } from "@plinth/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { artifacts, sessions } from "../src/db/schema.ts";
import { hashToken, newToken, signToken } from "../src/lib/crypto.ts";
import { isoIn, nowIso } from "../src/lib/time.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  APP,
  agent,
  browserSession,
  contentOrigin,
  db,
  json,
  mcpClient,
  publish,
  tool,
  uniqueEmail,
} from "./helpers.ts";
import {
  type Client,
  client,
  connect,
  docBody,
  grant,
  PLAIN,
  person,
  roomPage,
  run,
  setup,
  type Vars,
  within,
} from "./room-helpers.ts";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

const POLL = `<!doctype html><title>Poll</title>
<meta name="plinth-capabilities" content="data viewer">
<meta name="plinth-data-shared" content="votes"><p>poll</p>`;

/** The handshake as the app page makes it in a browser; `headers` override (null drops). */
function handshake(
  id: string,
  cookie: string | null,
  opts: { headers?: Record<string, string | null>; method?: string; vars?: Vars } = {},
): Promise<Response> {
  const base: Record<string, string | null> = {
    upgrade: "websocket",
    origin: APP,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "websocket",
    "sec-websocket-protocol": "plinth.view.v1",
    cookie,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...(opts.headers ?? {}) })) {
    if (v !== null) headers.set(k, v);
  }
  return run(
    `${APP}/api/v1/view/${id}/watch`,
    { method: opts.method ?? "GET", headers },
    opts.vars,
  );
}

/** Open a watch socket and take its welcome. */
async function watch(
  id: string,
  cookie: string | null,
  opts: Parameters<typeof handshake>[2] = {},
): Promise<Client & { welcome: any }> {
  const res = await handshake(id, cookie, opts);
  if (res.status !== 101) throw new Error(`handshake ${res.status}: ${await res.text()}`);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const c = client(ws);
  const welcome = await c.next();
  if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
  return { ...c, welcome };
}

/** A socket the room closes at once (a cap), and its close. */
async function refused(id: string, cookie: string | null, vars?: Vars) {
  const res = await handshake(id, cookie, { vars });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  return client(ws).closed;
}

const sessionCookie = (p: { session: { cookie: string } }) => p.session.cookie;

/** A viewer session for an email confirmed by code (the app-host viewer cookie). */
async function viewerSession(email: string): Promise<string> {
  const value = newToken("plinth_vs_");
  await db()
    .insert(sessions)
    .values({
      id: await hashToken(value),
      kind: "viewer",
      userId: null,
      viewerEmail: email,
      expiresAt: isoIn(3600_000),
      createdAt: nowIso(),
    })
    .run();
  return `${COOKIES.viewer}=${value}`;
}

function update(owner: { auth: Record<string, string> }, id: string, html: string, base: number) {
  return run(`${APP}/api/v1/artifacts/${id}`, {
    method: "PUT",
    headers: { ...owner.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ html, base_version: base }),
  });
}

/** A write from the artifact's own page, the way the runtime makes it. */
function pageWrite(id: string, cookie: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({
    "x-plinth-data": "1",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    origin: contentOrigin(id),
    cookie,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return run(`${contentOrigin(id)}/__plinth/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("live views: the handshake", () => {
  it("answers 101 with the subprotocol and the app's headers, and a welcome", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const res = await handshake(id, sessionCookie(ownerP));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    expect(res.headers.get("sec-websocket-protocol")).toBe("plinth.view.v1");
    expect(res.headers.get("content-security-policy")).toContain(
      "connect-src 'self' ws://app.localhost:8787",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const c = client(ws);
    expect(await c.next()).toEqual({ t: "welcome", v: 1, version: 1, data: false });
    c.send("ping");
    expect(await c.next()).toBe("pong");
    ws.close(1000);
  });

  it("refuses in order: method, upgrade, Origin, fetch metadata, subprotocol, bearer", async () => {
    const { id, ownerP, owner } = await setup(PLAIN);
    const s = sessionCookie(ownerP);
    const status = async (opts: Parameters<typeof handshake>[2]) => {
      const res = await handshake(id, s, opts);
      return [res.status, (await res.text()).trim()];
    };
    // Other methods never reach the upgrade: the /api/v1 router refuses them (CSRF first).
    const post = await handshake(id, s, { method: "POST" });
    expect(post.status).toBe(403);
    expect(post.webSocket).toBeNull();
    expect(await status({ method: "HEAD" })).toEqual([405, ""]);
    expect(await status({ headers: { upgrade: null } })).toEqual([426, "upgrade_required"]);
    for (const origin of [null, "null", contentOrigin(id), "https://evil.example"]) {
      expect(await status({ headers: { origin } })).toEqual([403, "origin"]);
    }
    expect(await status({ headers: { "sec-fetch-site": "cross-site" } })).toEqual([
      403,
      "cross_site",
    ]);
    expect(await status({ headers: { "sec-fetch-site": "same-site" } })).toEqual([
      403,
      "cross_site",
    ]);
    expect(await status({ headers: { "sec-fetch-mode": "navigate" } })).toEqual([
      403,
      "fetch_mode",
    ]);
    expect(await status({ headers: { "sec-websocket-protocol": null } })).toEqual([
      400,
      "protocol",
    ]);
    expect(await status({ headers: { "sec-websocket-protocol": "plinth.room.v1" } })).toEqual([
      400,
      "protocol",
    ]);
    // A bearer token is refused before it is resolved: agents never watch, valid token or not.
    expect(await status({ headers: owner.auth })).toEqual([403, "bearer"]);
    expect(await status({ headers: { authorization: "Bearer nonsense" } })).toEqual([
      403,
      "bearer",
    ]);
    // Without fetch metadata (older browsers) the rest still decides.
    const res = await handshake(id, s, {
      headers: { "sec-fetch-site": null, "sec-fetch-mode": null },
    });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close(1000);
  });

  it("is off with ALLOW_LIVE_VIEWS=false or without the ROOMS binding, and the gate says so", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const s = sessionCookie(ownerP);
    for (const vars of [{ ALLOW_LIVE_VIEWS: "false" }, { ROOMS: undefined }]) {
      const res = await handshake(id, s, { vars });
      expect([res.status, (await res.text()).trim()]).toEqual([404, "unavailable"]);
      const gate = await json(
        await run(`${APP}/api/v1/view/${id}`, { headers: ownerP.session.headers }, vars),
      );
      expect(gate.status).toBe("ok");
      expect(gate.watch).toBeUndefined();
    }
    const gate = await json(
      await run(`${APP}/api/v1/view/${id}`, { headers: ownerP.session.headers }),
    );
    expect(gate.watch).toBe(true);
  });

  it("tells nobody more than the gate: one 404 for unknown, deleted, taken down and refused", async () => {
    const { id: priv, owner } = await setup(PLAIN);
    const body = async (res: Response) => [res.status, await res.text()];
    const unknown = await body(await handshake("a".repeat(16), null));
    expect(unknown[0]).toBe(404);
    // A private artifact, anonymously, looks exactly like one that does not exist.
    expect(await body(await handshake(priv, null))).toEqual(unknown);
    // A slug is not accepted (the app passes the id).
    const { body: p } = await publish(owner.auth, { html: PLAIN });
    expect(await body(await handshake(p.slug, null))).toEqual(unknown);
    // Deleted and taken down.
    const { body: del } = await publish(owner.auth, { html: PLAIN });
    await run(`${APP}/api/v1/artifacts/${del.id}`, { method: "DELETE", headers: owner.auth });
    expect(await body(await handshake(del.id, null))).toEqual(unknown);
    const { body: down } = await publish(owner.auth, { html: PLAIN });
    await db()
      .update(artifacts)
      .set({ takenDownAt: nowIso() })
      .where(eq(artifacts.id, down.id))
      .run();
    expect(await body(await handshake(down.id, null))).toEqual(unknown);
  });

  it("follows the gate's view decision: link, password, allowlist with a viewer session", async () => {
    const a = await agent();
    // Unlisted: anyone with the link, anonymously.
    const { body: open } = await publish(a.auth, { html: PLAIN, visibility: "unlisted" });
    const anon = await watch(open.id, null);
    expect(anon.welcome).toEqual({ t: "welcome", v: 1, version: 1, data: false });
    anon.ws.close(1000);
    // Password: refused without the pass, opened with it.
    const { body: pw } = await publish(a.auth, {
      html: PLAIN,
      visibility: "password",
      password: "open sesame",
    });
    expect((await handshake(pw.id, null)).status).toBe(404);
    const csrf = {
      Cookie: "__Host-plinth_csrf=abc",
      "x-plinth-csrf": "abc",
      "Content-Type": "application/json",
    };
    const right = await run(`${APP}/api/v1/view/${pw.id}/password`, {
      method: "POST",
      headers: csrf,
      body: JSON.stringify({ password: "open sesame" }),
    });
    expect(right.status).toBe(200);
    const pass = (right.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const withPass = await watch(pw.id, pass);
    withPass.ws.close(1000);
    // Allowlist: a viewer confirmed by code, with no account.
    const { body: list } = await publish(a.auth, { html: PLAIN, visibility: "allowlist" });
    const email = uniqueEmail("listed");
    await grant(list.id, email, "viewer");
    expect((await handshake(list.id, null)).status).toBe(404);
    const viewer = await watch(list.id, await viewerSession(email));
    viewer.ws.close(1000);
    // A viewer session for an email that is not listed is refused.
    expect((await handshake(list.id, await viewerSession(uniqueEmail("other")))).status).toBe(404);
  });

  it("gives the data right only to an HTML page that declares `data`", async () => {
    const { id, ownerP } = await setup(POLL);
    const w = await watch(id, sessionCookie(ownerP));
    expect(w.welcome).toEqual({ t: "welcome", v: 1, version: 1, data: true });
    w.ws.close(1000);
    const room = await setup(roomPage());
    const r = await watch(room.id, sessionCookie(room.ownerP));
    expect(r.welcome.data).toBe(false);
    r.ws.close(1000);
    const doc = await setup(undefined, docBody("# Notes\n"));
    const d = await watch(doc.id, sessionCookie(doc.ownerP));
    expect(d.welcome.data).toBe(false);
    d.ws.close(1000);
    // Shared data off on the instance: no data right.
    const off = await watch(id, sessionCookie(ownerP), { vars: { ALLOW_SHARED_DATA: "false" } });
    expect(off.welcome.data).toBe(false);
    off.ws.close(1000);
  });

  it("the room refuses a watch header of the wrong shape, and a room header of kind watch", async () => {
    const stub = stubFor("live-view-guard-test");
    const good = {
      artifactId: "a".repeat(20),
      kind: "watch",
      epoch: 1,
      passExp: Date.now() + 60_000,
      version: 1,
      data: false,
      client: "0123456789abcdef",
      limits: { maxSockets: 10 },
    };
    const send = (headers: Record<string, string>) =>
      stub.fetch(new Request("https://room.invalid/connect", { headers }));
    for (const bad of [
      { ...good, kind: "page" },
      { ...good, client: "not-hex-not-16!!" },
      { ...good, client: "0123456789ABCDEF" },
      { ...good, version: -1 },
      { ...good, data: "yes" },
      { ...good, limits: { maxSockets: 0 } },
      { ...good, artifactId: "../x" },
    ]) {
      const res = await send({ upgrade: "websocket", "x-plinth-watch": JSON.stringify(bad) });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const asRoom = await send({ upgrade: "websocket", "x-plinth-room": JSON.stringify(good) });
    expect(asRoom.status).toBe(400);
    const ok = await send({ upgrade: "websocket", "x-plinth-watch": JSON.stringify(good) });
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close(1000);
  });
});

describe("live views: signals", () => {
  it("a version published over REST, over MCP and by a restore reaches watchers", async () => {
    const { id, ownerP, owner } = await setup(PLAIN, { visibility: "unlisted" });
    const a = await watch(id, sessionCookie(ownerP));
    const b = await watch(id, null);
    expect((await update(owner, id, `${PLAIN}<p>2</p>`, 1)).status).toBe(200);
    // A small audience gets 0, never a number that counts the open views.
    expect(await a.next()).toEqual({ t: "version", version: 2, spread_ms: 0 });
    expect(await b.next()).toEqual({ t: "version", version: 2, spread_ms: 0 });

    const mcp = await mcpClient(owner.token);
    try {
      const r = await tool(mcp, "update_artifact", {
        id,
        html: `${PLAIN}<p>3</p>`,
        base_version: 2,
      });
      expect(r.isError).toBe(false);
    } finally {
      await mcp.close();
    }
    expect(await a.next()).toMatchObject({ t: "version", version: 3 });
    const restore = await run(`${APP}/api/v1/artifacts/${id}/versions/1/restore`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 3 }),
    });
    expect(restore.status).toBe(201);
    expect(await a.next()).toMatchObject({ t: "version", version: 4 });
    expect(await b.nextOf("version")).toMatchObject({ version: 3 });
    expect(await b.next()).toMatchObject({ t: "version", version: 4 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("page writes (POST, PUT, DELETE) and agent and app writes send `data`", async () => {
    const { id, ownerP, owner } = await setup(POLL);
    const ed = await person(id, "editor");
    const w = await watch(id, sessionCookie(ownerP));
    const created = await pageWrite(id, ed.cookie, "POST", "/data/votes", { data: { n: 1 } });
    expect(created.status).toBe(201);
    expect(await w.next()).toEqual({ t: "data", spread_ms: 0 });
    const doc = await json(created);
    const put = await pageWrite(id, ed.cookie, "PUT", `/data/votes/${doc.id}`, { data: { n: 2 } });
    expect(put.status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "data" });
    const del = await pageWrite(id, ed.cookie, "DELETE", `/data/votes/${doc.id}`);
    expect(del.status).toBe(204);
    expect(await w.next()).toMatchObject({ t: "data" });
    // A refused write sends nothing.
    const bad = await pageWrite(id, ed.cookie, "DELETE", "/data/votes/missing");
    expect(bad.status).toBe(404);
    // An agent's write_artifact_data over REST.
    const rest = await run(`${APP}/api/v1/artifacts/${id}/data`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "set", collection: "votes", doc_id: "a1", data: { n: 1 }, if_rev: 0 }],
      }),
    });
    expect(rest.status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "data" });
    // The owner's "Delete all shared data" in the app.
    const clear = await run(`${APP}/api/v1/artifacts/${id}/data`, {
      method: "DELETE",
      headers: ownerP.session.headers,
    });
    expect(clear.status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "data" });
    await new Promise((r) => setTimeout(r, 300));
    expect(w.pending()).toEqual([]);
    w.ws.close(1000);
  });

  it("a version that drops `data` takes the data right away; later writes send nothing", async () => {
    const { id, ownerP, owner } = await setup(POLL);
    const w = await watch(id, sessionCookie(ownerP));
    expect(w.welcome.data).toBe(true);
    expect((await update(owner, id, PLAIN, 1)).status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "version", version: 2 });
    const rest = await run(`${APP}/api/v1/artifacts/${id}/data`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "set", collection: "votes", doc_id: "a1", data: { n: 1 }, if_rev: 0 }],
      }),
    });
    expect(rest.status).toBe(200);
    expect(await stubFor(id).dataChanged()).toBe(0);
    // Declaring `data` again does not give it back: the app reconnects for that.
    expect((await update(owner, id, POLL, 2)).status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "version", version: 3 });
    expect(await stubFor(id).dataChanged()).toBe(0);
    expect(w.pending()).toEqual([]);
    const again = await watch(id, sessionCookie(ownerP));
    expect(again.welcome.data).toBe(true);
    w.ws.close(1000);
    again.ws.close(1000);
  });

  it("watch sockets get nothing from a page room on the same artifact, and may send only ping", async () => {
    const { id, ownerP } = await setup(roomPage({ open: "*" }));
    const ed = await person(id, "editor");
    const w = await watch(id, sessionCookie(ownerP));
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ed.cookie);
    a.send({ t: "join", room: "main" });
    await a.nextOf("peers");
    b.send({ t: "join", room: "main" });
    await b.nextOf("peers");
    await a.nextOf("peer");
    b.send({ t: "presence", room: "main", state: { x: 1 } });
    b.send({ t: "emit", room: "main", topic: "hello", data: 1 });
    await a.nextOf("event");
    b.ws.close(1000);
    await a.nextOf("gone");
    await new Promise((r) => setTimeout(r, 300));
    expect(w.pending()).toEqual([]);
    // Anything but ping closes it (4400).
    w.send({ t: "join", room: "main" });
    expect(await within(w.closed)).toMatchObject({ code: 4400 });
    a.ws.close(1000);
  });

  it("the room's spread is a coarse band of the audience, not a count, and stops at the cap", () => {
    expect(spreadMs(0)).toBe(0);
    expect(spreadMs(1)).toBe(0);
    expect(spreadMs(LIVE_VIEW_LIMITS.spreadFromRecipients - 1)).toBe(0);
    expect(spreadMs(LIVE_VIEW_LIMITS.spreadFromRecipients)).toBe(LIVE_VIEW_LIMITS.spreadStepMs);
    expect(spreadMs(250)).toBe(4000);
    expect(spreadMs(1000)).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
    expect(spreadMs(5000)).toBe(LIVE_VIEW_LIMITS.spreadMaxMs);
  });

  it("a data write tells a watcher nothing about how many views are open", async () => {
    const { id, ownerP } = await setup(POLL);
    const ed = await person(id, "editor");
    const owner = await watch(id, sessionCookie(ownerP));
    const tabs = [];
    for (let i = 0; i < 2; i++) tabs.push(await watch(id, sessionCookie(ed)));
    const write = () => pageWrite(id, ed.cookie, "POST", "/data/votes", { data: { n: 1 } });
    expect((await write()).status).toBe(201);
    const withOwner = await Promise.all(tabs.map((w) => w.next()));
    expect(await owner.next()).toMatchObject({ t: "data" });
    // The owner closes the page: the editor's next write reads exactly the same frames.
    owner.ws.close(1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await stubFor(id).watchers()).toBe(2);
    expect((await write()).status).toBe(201);
    const withoutOwner = await Promise.all(tabs.map((w) => w.next()));
    expect(withoutOwner).toEqual(withOwner);
    expect(withOwner).toEqual([
      { t: "data", spread_ms: 0 },
      { t: "data", spread_ms: 0 },
    ]);
    for (const w of tabs) w.ws.close(1000);
  });
});

describe("live views: closing", () => {
  it("a sharing change closes watch sockets with 4401 (access_changed)", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const ed = await person(id, "editor");
    const w = await watch(id, sessionCookie(ed));
    const res = await run(`${APP}/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [] }),
    });
    expect(res.status).toBe(200);
    expect(await within(w.closed)).toEqual({ code: 4401, reason: "access_changed" });
    expect((await handshake(id, sessionCookie(ed))).status).toBe(404);
  });

  it("before a sharing change closes them, watch sockets get `access` with a spread for all of them", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const ws = [];
    for (let i = 0; i < 3; i++) ws.push(await watch(id, sessionCookie(ownerP)));
    const res = await run(`${APP}/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [] }),
    });
    expect(res.status).toBe(200);
    for (const w of ws) {
      expect(await w.next()).toEqual({ t: "access", spread_ms: 0 });
      expect(await within(w.closed)).toEqual({ code: 4401, reason: "access_changed" });
    }
  });

  it("the alarm closes watch sockets a lost revoke left open the same way", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const a = await watch(id, sessionCookie(ownerP));
    const b = await watch(id, sessionCookie(ownerP));
    // An epoch bump made with SQL: no revoke reaches the room.
    const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
    await db()
      .update(artifacts)
      .set({ accessEpoch: (row?.accessEpoch ?? 0) + 1 })
      .where(eq(artifacts.id, id))
      .run();
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    for (const w of [a, b]) {
      expect(await w.next()).toEqual({ t: "access", spread_ms: 0 });
      expect(await within(w.closed)).toEqual({ code: 4401, reason: "access_changed" });
    }
  });

  it("a socket never outlives the session or password pass it was opened with", async () => {
    const lifetime = () => Date.now() + LIVE_VIEW_LIMITS.socketTtlS * 1000;
    const passExps = async (id: string) =>
      runInDurableObject(stubFor(id), async (_room, state) =>
        state
          .getWebSockets("k:watch")
          .map((s) => (s.deserializeAttachment() as { passExp: number }).passExp),
      );
    const a = await agent();
    // An allowlist viewer whose confirmed-email session ends in an hour.
    const { body: list } = await publish(a.auth, { html: PLAIN, visibility: "allowlist" });
    const email = uniqueEmail("hour");
    await grant(list.id, email, "viewer");
    const before = Date.now();
    const viewer = await watch(list.id, await viewerSession(email));
    const [vExp] = await passExps(list.id);
    expect(vExp).toBeGreaterThan(before);
    expect(vExp).toBeLessThanOrEqual(Date.now() + 3600_000);
    viewer.ws.close(1000);
    // A password pass that ends in a minute (signed with the instance key, as the gate signs it).
    const { body: pw } = await publish(a.auth, {
      html: PLAIN,
      visibility: "password",
      password: "open sesame",
    });
    const row = await db().select().from(artifacts).where(eq(artifacts.id, pw.id)).get();
    const config = parseConfig(env as unknown as Record<string, unknown>);
    const exp = Date.now() + 60_000;
    const token = await signToken(config.tokenSigningKey, {
      k: "pw",
      a: pw.id,
      e: row?.accessEpoch ?? 0,
      exp,
    });
    const withPass = await watch(pw.id, `${COOKIES.passwordPassPrefix}${pw.id}=${token}`);
    expect(await passExps(pw.id)).toEqual([exp]);
    withPass.ws.close(1000);
    // Anonymous on a link: a content pass's lifetime.
    const { body: open } = await publish(a.auth, { html: PLAIN, visibility: "unlisted" });
    const anon = await watch(open.id, null);
    const [aExp] = await passExps(open.id);
    expect(aExp).toBeGreaterThan(lifetime() - 60_000);
    anon.ws.close(1000);
  });

  it("revocation reaches watch sockets under opaque isolation too, where rooms are off", async () => {
    const vars = { CONTENT_ISOLATION: "opaque" };
    const { id, ownerP } = await setup(PLAIN);
    const ed = await person(id, "editor");
    const w = await watch(id, sessionCookie(ed), { vars });
    const res = await run(
      `${APP}/api/v1/artifacts/${id}/sharing`,
      {
        method: "PUT",
        headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ grants: [] }),
      },
      vars,
    );
    expect(res.status).toBe(200);
    expect(await within(w.closed)).toMatchObject({ code: 4401 });
  });

  it("deleting the artifact closes watch sockets with 4404; so does the alarm after a takedown", async () => {
    const { id, ownerP, owner } = await setup(PLAIN);
    const w = await watch(id, sessionCookie(ownerP));
    const del = await run(`${APP}/api/v1/artifacts/${id}`, {
      method: "DELETE",
      headers: owner.auth,
    });
    expect(del.status).toBe(204);
    expect(await within(w.closed)).toMatchObject({ code: 4404 });

    const two = await setup(PLAIN);
    const v = await watch(two.id, sessionCookie(two.ownerP));
    await db()
      .update(artifacts)
      .set({ takenDownAt: nowIso() })
      .where(eq(artifacts.id, two.id))
      .run();
    expect(await runDurableObjectAlarm(stubFor(two.id))).toBe(true);
    expect(await within(v.closed)).toMatchObject({ code: 4404 });
  });

  it("a takedown through the admin closes watch sockets with 4404", async () => {
    const { id, ownerP } = await setup(PLAIN);
    const w = await watch(id, sessionCookie(ownerP));
    const email = uniqueEmail("admin");
    const vars = { ADMIN_EMAIL: email };
    const adminUser = await getOrCreateUser(
      db(),
      parseConfig({ ...env, ...vars } as unknown as Record<string, unknown>),
      email,
      { verified: true },
    );
    const s = await browserSession(adminUser.id);
    const report = await run(
      `${APP}/api/v1/artifacts/${id}/report`,
      {
        method: "POST",
        headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "testing a takedown" }),
      },
      vars,
    );
    expect(report.status).toBe(201);
    const { id: reportId } = await json(report);
    const res = await run(
      `${APP}/api/v1/admin/reports/${reportId}`,
      {
        method: "POST",
        headers: { ...s.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "actioned" }),
      },
      vars,
    );
    expect(res.status).toBe(200);
    expect(await within(w.closed)).toMatchObject({ code: 4404 });
  });

  it("the alarm sends a version whose notify was lost, and closes an expired socket (expired)", async () => {
    const { id, ownerP, owner } = await setup(PLAIN);
    const w = await watch(id, sessionCookie(ownerP));
    const x = await watch(id, sessionCookie(ownerP));
    // Committed with live views off on this request: no notify, as if it were lost.
    const upd = await run(
      `${APP}/api/v1/artifacts/${id}`,
      {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html: `${PLAIN}<p>2</p>`, base_version: 1 }),
      },
      { ALLOW_LIVE_VIEWS: "false" },
    );
    expect(upd.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(w.pending()).toEqual([]);
    // One socket reaches its lifetime.
    await runInDurableObject(stubFor(id), async (room, state) => {
      const [first] = state.getWebSockets("k:watch");
      const att = first?.deserializeAttachment() as { passExp: number };
      first?.serializeAttachment({ ...att, passExp: Date.now() - 1 });
      (room as unknown as { states: WeakMap<object, unknown> }).states = new WeakMap();
    });
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    const closes = await Promise.all([within(w.closed, 500), within(x.closed, 500)]);
    const expired = closes.filter((c) => c !== "timeout");
    expect(expired).toEqual([{ code: 4401, reason: "expired" }]);
    const open = closes[0] === "timeout" ? w : x;
    expect(await open.next()).toEqual({ t: "version", version: 2, spread_ms: spreadMs(1) });
    open.ws.close(1000);
  });

  it("the alarm takes the data right away once the current version stops declaring `data`", async () => {
    const { id, ownerP, owner } = await setup(POLL);
    const w = await watch(id, sessionCookie(ownerP));
    const upd = await run(
      `${APP}/api/v1/artifacts/${id}`,
      {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html: PLAIN, base_version: 1 }),
      },
      { ALLOW_LIVE_VIEWS: "false" },
    );
    expect(upd.status).toBe(200);
    expect(await stubFor(id).dataChanged()).toBe(1);
    await w.next();
    await runDurableObjectAlarm(stubFor(id));
    expect(await w.next()).toMatchObject({ t: "version", version: 2 });
    expect(await stubFor(id).dataChanged()).toBe(0);
    w.ws.close(1000);
  });
});

describe("live views: the gate's `watch`", () => {
  it("is set for people and link viewers, on pinned links too, and never for agents", async () => {
    const { id, ownerP, owner } = await setup(PLAIN, { visibility: "unlisted" });
    const gate = async (path: string, headers: Record<string, string> = {}, vars?: Vars) =>
      json(await run(`${APP}/api/v1/view/${path}`, { headers }, vars));
    expect((await gate(id, ownerP.session.headers)).watch).toBe(true);
    expect((await gate(id)).watch).toBe(true);
    expect((await gate(`${id}?version=1`)).watch).toBe(true);
    const agentGate = await gate(id, owner.auth);
    expect(agentGate.status).toBe("ok");
    expect(agentGate.watch).toBeUndefined();
    // Live views work under opaque isolation too: the socket is on the app host.
    expect((await gate(id, {}, { CONTENT_ISOLATION: "opaque" })).watch).toBe(true);
    // A gate that refuses says nothing about watching.
    const { id: priv } = await setup(PLAIN);
    const refused = await gate(priv);
    expect(refused.status).toBe("email_required");
    expect(refused.watch).toBeUndefined();
  });

  it("a watch socket works under opaque isolation, without the data right", async () => {
    const vars = { CONTENT_ISOLATION: "opaque" };
    const { id, ownerP, owner } = await setup(POLL);
    const w = await watch(id, sessionCookie(ownerP), { vars });
    expect(w.welcome).toEqual({ t: "welcome", v: 1, version: 1, data: false });
    const upd = await run(
      `${APP}/api/v1/artifacts/${id}`,
      {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html: `${POLL}<p>2</p>`, base_version: 1 }),
      },
      vars,
    );
    expect(upd.status).toBe(200);
    expect(await w.next()).toMatchObject({ t: "version", version: 2 });
    w.ws.close(1000);
  });
});

describe("live views: caps", () => {
  it("watchers never fill a room: room sockets are counted apart", async () => {
    const vars = { ROOM_MAX_CONNECTIONS_PER_ARTIFACT: "2" };
    const { id, ownerP } = await setup(roomPage());
    const ed = await person(id, "editor");
    const watchers = [];
    for (let i = 0; i < 5; i++) watchers.push(await watch(id, sessionCookie(ownerP)));
    expect(await stubFor(id).watchers()).toBe(5);
    const a = await connect(id, ownerP.cookie, { vars });
    const b = await connect(id, ed.cookie, { vars });
    expect(await stubFor(id).size()).toBe(2);
    for (const w of [a, b, ...watchers]) w.ws.close(1000);
  });

  it("LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT caps watchers (4409), and room sockets do not count", async () => {
    const vars = { LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: "10" };
    const { id, ownerP } = await setup(roomPage());
    const room = await connect(id, ownerP.cookie);
    const open = [];
    for (let i = 0; i < 10; i++) open.push(await watch(id, sessionCookie(ownerP), { vars }));
    expect(await within(refused(id, sessionCookie(ownerP), vars))).toMatchObject({ code: 4409 });
    for (const w of [room, ...open]) w.ws.close(1000);
  });

  it("caps watch sockets per client, and connects per client per minute (4409)", async () => {
    const { id, ownerP } = await setup(PLAIN, { visibility: "unlisted" });
    const mine = sessionCookie(ownerP);
    const open = [];
    for (let i = 0; i < LIVE_VIEW_LIMITS.socketsPerClient; i++) open.push(await watch(id, mine));
    expect(await within(refused(id, mine))).toMatchObject({ code: 4409 });
    // Another client (an anonymous link viewer) is not affected.
    const other = await watch(id, null);
    other.ws.close(1000);
    for (const w of open) {
      w.ws.close(1000);
      await w.closed;
    }
    // Every accepted connect in the last minute counts, closed or not (a refused one does not).
    const left = LIVE_VIEW_LIMITS.connectsPerClientPerMinute - LIVE_VIEW_LIMITS.socketsPerClient;
    for (let i = 0; i < left; i++) {
      const w = await watch(id, mine);
      w.ws.close(1000);
      await w.closed;
    }
    expect(await within(refused(id, mine))).toMatchObject({ code: 4409 });
  });
});
