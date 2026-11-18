// The live room itself (#36, docs/spec.md "Live rooms"): the ArtifactRoom Durable Object behind the
// upgrade gate. Real sockets through the Worker's fetch handler: welcome and peers, presence,
// sub-rooms, topics, identity, frame and rate limits, the connection caps, and every way a socket
// is closed when access or the declaration changes (RPC from the Worker, and the alarm backstop).
import { listDurableObjectIds, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { IDENTITY_CLAIM_INFO } from "../src/content/tokens.ts";
import { artifacts } from "../src/db/schema.ts";
import { sealJson, signToken } from "../src/lib/crypto.ts";
import { getOrCreateUser } from "../src/services/users.ts";
import {
  APP,
  browserSession,
  call,
  config,
  contentOrigin,
  db,
  json,
  publish,
  uniqueEmail,
} from "./helpers.ts";
import {
  type Client,
  client,
  connect,
  grant,
  PLAIN,
  person,
  roomPage,
  run,
  setup,
  upgrade,
  within,
} from "./room-helpers.ts";

const SECRET = "test-token-signing-key-0123456789abcdef012345";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

async function joined(c: Client, room = "main") {
  c.send({ t: "join", room });
  return c.nextOf("peers");
}

/** Open a socket that the room closes straight away, and return the close. */
async function refusedSocket(id: string, cookie: string, vars?: Record<string, unknown>) {
  const res = await upgrade(id, cookie, { vars });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  return client(ws).closed;
}

describe("room: joining and peers", () => {
  it("welcome, then peers with yourself on join and deltas for the others", async () => {
    const { id, ownerP } = await setup(roomPage({ viewer: true }));
    const ed = await person(id, "editor");
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ed.cookie);
    const ap = await joined(a);
    expect(ap.peers).toEqual([
      {
        id: a.welcome.you.id,
        viewer: a.welcome.you.viewer,
        role: "owner",
        email: ownerP.email,
        presence: {},
      },
    ]);
    const bp = await joined(b);
    expect(bp.peers.map((p: { id: string }) => p.id).sort()).toEqual(
      [a.welcome.you.id, b.welcome.you.id].sort(),
    );
    expect(await a.next()).toEqual({
      t: "peer",
      room: "main",
      peer: {
        id: b.welcome.you.id,
        viewer: b.welcome.you.viewer,
        role: "editor",
        email: ed.email,
        presence: {},
      },
    });
    // Joining again only repeats the list.
    a.send({ t: "join", room: "main" });
    expect((await a.next()).t).toBe("peers");
    b.ws.close(1000);
    expect(await a.next()).toEqual({ t: "gone", room: "main", id: b.welcome.you.id });
    a.ws.close(1000);
  });

  it("one person with two tabs is two peers with the same viewer id", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ownerP.cookie);
    expect(a.welcome.you.id).not.toBe(b.welcome.you.id);
    expect(a.welcome.you.viewer).toBe(b.welcome.you.viewer);
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("presence merges shallowly, null deletes a key, presence(null) clears, leave says gone", async () => {
    const { id, ownerP } = await setup();
    const ed = await person(id, "editor");
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ed.cookie);
    await joined(a);
    await joined(b);
    await a.nextOf("peer");
    const presenceOf = async () => (await b.nextOf("peer")).peer.presence;
    a.send({ t: "presence", room: "main", state: { x: 1, y: 2 } });
    expect(await presenceOf()).toEqual({ x: 1, y: 2 });
    a.send({ t: "presence", room: "main", state: { y: null, z: { deep: true } } });
    expect(await presenceOf()).toEqual({ x: 1, z: { deep: true } });
    // A late joiner sees the current presence in its list.
    const c = await connect(id, (await person(id, "viewer")).cookie);
    const cp = await joined(c);
    expect(cp.peers.find((p: { id: string }) => p.id === a.welcome.you.id).presence).toEqual({
      x: 1,
      z: { deep: true },
    });
    a.send({ t: "presence", room: "main", state: null });
    expect(await presenceOf()).toEqual({});
    a.send({ t: "leave", room: "main" });
    expect(await b.nextOf("gone")).toEqual({ t: "gone", room: "main", id: a.welcome.you.id });
    // Not in the room any more.
    a.send({ t: "presence", room: "main", state: { x: 2 } });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_joined" });
    a.send({ t: "leave", room: "main" });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_joined" });
    for (const s of [a, b, c]) s.ws.close(1000);
  });

  it("presence is capped at 400 bytes; an over-size update changes nothing", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ownerP.cookie);
    await joined(a);
    await joined(b);
    await a.nextOf("peer");
    a.send({ t: "presence", room: "main", state: { name: "x".repeat(500) } });
    expect(await a.next()).toEqual({ t: "error", code: "too_large" });
    a.send({ t: "presence", room: "main", state: { ok: 1 } });
    expect((await b.nextOf("peer")).peer.presence).toEqual({ ok: 1 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("sub-rooms on one socket: at most three, and traffic stays in its room", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    const b = await connect(id, ownerP.cookie);
    await joined(a);
    await joined(a, "board-2");
    await joined(a, "board-3");
    a.send({ t: "join", room: "board-4" });
    expect(await a.next()).toEqual({ t: "error", code: "too_large" });
    a.send({ t: "join", room: "Bad Name" });
    expect(await a.next()).toEqual({ t: "error", code: "invalid" });
    await joined(b, "board-2");
    expect((await a.next()).room).toBe("board-2");
    a.send({ t: "emit", room: "main", topic: "ping.me", data: 1 });
    a.send({ t: "emit", room: "board-2", topic: "note.move", data: { x: 1 } });
    const ev = await b.next();
    expect(ev).toMatchObject({ t: "event", room: "board-2", topic: "note.move", data: { x: 1 } });
    expect(b.pending()).toEqual([]);
    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe("room: emitting", () => {
  it("owners and editors emit any topic; others only open topics; never echoed", async () => {
    const { id, ownerP } = await setup(roomPage({ open: "cursor" }));
    const commenter = await person(id, "commenter");
    const o = await connect(id, ownerP.cookie);
    const c = await connect(id, commenter.cookie);
    await joined(o);
    await joined(c);
    await o.nextOf("peer");
    o.send({ t: "emit", room: "main", topic: "note.move", data: { id: "n1" } });
    expect(await c.next()).toEqual({
      t: "event",
      room: "main",
      topic: "note.move",
      data: { id: "n1" },
      from: {
        id: o.welcome.you.id,
        viewer: o.welcome.you.viewer,
        role: "owner",
        email: ownerP.email,
      },
    });
    c.send({ t: "emit", room: "main", topic: "note.move", data: 1 });
    expect(await c.next()).toEqual({ t: "error", code: "forbidden_topic" });
    c.send({ t: "emit", room: "main", topic: "cursor", data: { x: 3 } });
    expect(await o.next()).toMatchObject({ t: "event", topic: "cursor", data: { x: 3 } });
    // Nothing came back to the sender.
    expect(o.pending()).toEqual([]);
    expect(c.pending()).toEqual([]);
    c.send({ t: "emit", room: "elsewhere", topic: "cursor", data: 1 });
    expect(await c.next()).toEqual({ t: "error", code: "not_joined" });
    o.ws.close(1000);
    c.ws.close(1000);
  });

  it("`*` opens every topic", async () => {
    const { id } = await setup(roomPage({ open: "*" }));
    const v = await person(id, "viewer");
    const w = await person(id, "viewer");
    const a = await connect(id, v.cookie);
    const b = await connect(id, w.cookie);
    await joined(a);
    await joined(b);
    await a.nextOf("peer");
    a.send({ t: "emit", room: "main", topic: "anything.at:all", data: null });
    expect(await b.next()).toMatchObject({ t: "event", topic: "anything.at:all" });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("email and role reach peers only when the page declares `viewer`", async () => {
    const { id, ownerP } = await setup(roomPage({ viewer: false, open: "*" }));
    const ed = await person(id, "editor");
    const a = await connect(id, ownerP.cookie);
    expect(a.welcome.you).toEqual({
      id: expect.any(String),
      viewer: expect.any(String),
      role: "owner",
    });
    const b = await connect(id, ed.cookie);
    const ap = await joined(a);
    expect(ap.peers[0]).toEqual({
      id: a.welcome.you.id,
      viewer: a.welcome.you.viewer,
      presence: {},
    });
    await joined(b);
    expect((await a.next()).peer).toEqual({
      id: b.welcome.you.id,
      viewer: b.welcome.you.viewer,
      presence: {},
    });
    b.send({ t: "emit", room: "main", topic: "hi", data: 1 });
    expect((await a.next()).from).toEqual({ id: b.welcome.you.id, viewer: b.welcome.you.viewer });
    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe("room: frames and rates", () => {
  it("an over-size frame closes with 1009, a binary frame with 1003, junk is an error", async () => {
    const vars = { ROOM_MAX_MESSAGE_BYTES: "512" };
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie, { vars });
    expect(a.welcome.limits.max_message_bytes).toBe(512);
    a.send("not json");
    expect(await a.next()).toEqual({ t: "error", code: "invalid" });
    a.send({ t: "wave" });
    expect(await a.next()).toEqual({ t: "error", code: "invalid" });
    a.send({ t: "emit", room: "main", topic: "x", data: "é".repeat(300) });
    expect((await a.closed).code).toBe(1009);
    const b = await connect(id, ownerP.cookie);
    b.ws.send(new Uint8Array([1, 2, 3]));
    expect((await b.closed).code).toBe(1003);
  });

  it("past the rate a socket gets rate_limited errors, then 4429", async () => {
    const vars = { ROOM_MESSAGES_PER_SECOND: "1" };
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie, { vars });
    for (let i = 0; i < 60; i++) a.send({ t: "join", room: "main" });
    const codes: string[] = [];
    for (;;) {
      const f = await within(a.next(), 2000);
      if (f === "timeout" || f === undefined) break;
      if (f.t === "error") codes.push(f.code);
    }
    expect(codes.length).toBeGreaterThanOrEqual(49);
    expect(new Set(codes)).toEqual(new Set(["rate_limited"]));
    expect((await a.closed).code).toBe(4429);
  });

  it("the keep-alive ping is answered with pong", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    a.send("ping");
    expect(await a.next()).toBe("pong");
    a.ws.close(1000);
  });
});

describe("room: connection caps", () => {
  it("ROOM_MAX_CONNECTIONS_PER_ARTIFACT: the next socket closes with 4409", async () => {
    const vars = { ROOM_MAX_CONNECTIONS_PER_ARTIFACT: "2" };
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie, { vars });
    const b = await connect(id, (await person(id, "viewer")).cookie, { vars });
    expect(await refusedSocket(id, ownerP.cookie, vars)).toMatchObject({ code: 4409 });
    // The refused socket never counted: one closes, one more fits.
    b.ws.close(1000);
    await b.closed;
    await new Promise((r) => setTimeout(r, 50));
    const c = await connect(id, ownerP.cookie, { vars });
    a.ws.close(1000);
    c.ws.close(1000);
  });

  it("eight sockets per viewer", async () => {
    const { id, ownerP } = await setup();
    const open: Client[] = [];
    for (let i = 0; i < 8; i++) open.push(await connect(id, ownerP.cookie));
    expect(await refusedSocket(id, ownerP.cookie)).toMatchObject({ code: 4409 });
    // Another person still gets in.
    const other = await connect(id, (await person(id, "viewer")).cookie);
    for (const s of [...open, other]) s.ws.close(1000);
  });

  it("twenty connects per viewer per minute", async () => {
    const { id, ownerP } = await setup();
    for (let i = 0; i < 20; i++) {
      const s = await connect(id, ownerP.cookie);
      s.ws.close(1000);
      await s.closed;
    }
    expect(await refusedSocket(id, ownerP.cookie)).toMatchObject({ code: 4409 });
  });
});

describe("room: revocation", () => {
  it("a visibility change closes sockets with 4401", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    const res = await call(`/api/v1/artifacts/${id}/visibility`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "unlisted" }),
    });
    expect(res.status).toBe(200);
    expect(await within(a.closed)).toMatchObject({ code: 4401 });
  });

  it("a grant change closes sockets with 4401, and the old pass no longer connects", async () => {
    const { id, ownerP } = await setup();
    const ed = await person(id, "editor");
    const a = await connect(id, ed.cookie);
    const res = await call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [] }),
    });
    expect(res.status).toBe(200);
    expect(await within(a.closed)).toMatchObject({ code: 4401 });
    expect((await upgrade(id, ed.cookie)).status).toBe(401);
  });

  it("a takedown closes sockets with 4404", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
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
    expect(await within(a.closed)).toMatchObject({ code: 4404 });
  });

  it("deleting the artifact closes sockets with 4404", async () => {
    const { id, ownerP, owner } = await setup();
    const a = await connect(id, ownerP.cookie);
    const res = await call(`/api/v1/artifacts/${id}`, { method: "DELETE", headers: owner.auth });
    expect(res.status).toBe(204);
    expect(await within(a.closed)).toMatchObject({ code: 4404 });
  });

  it("a version that changes the room declaration closes page sockets with 4410; one that keeps it does not", async () => {
    const { id, ownerP, owner } = await setup(roomPage({ open: "cursor" }));
    const a = await connect(id, ownerP.cookie);
    const update = (html: string, base: number) =>
      call(`/api/v1/artifacts/${id}`, {
        method: "PUT",
        headers: { ...owner.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ html, base_version: base }),
      });
    // The same declaration in a different page: no reconnect.
    const same = await update(`${roomPage({ open: "cursor" })}<p>v2</p>`, 1);
    expect(same.status).toBe(200);
    expect(await within(a.closed, 500)).toBe("timeout");
    a.send("ping");
    expect(await a.next()).toBe("pong");
    // Opening another topic changes what sockets may do.
    expect((await update(roomPage({ open: "cursor note.move" }), 2)).status).toBe(200);
    expect(await within(a.closed)).toMatchObject({ code: 4410 });
    // Dropping `room` entirely: the gate then refuses the reconnect.
    const b = await connect(id, ownerP.cookie);
    expect((await update(PLAIN, 3)).status).toBe(200);
    expect(await within(b.closed)).toMatchObject({ code: 4410 });
    expect((await upgrade(id, ownerP.cookie)).status).toBe(404);
  });

  it("the alarm closes sockets after an epoch bump made with SQL, and after a takedown in SQL", async () => {
    const { id, ownerP } = await setup();
    const a = await connect(id, ownerP.cookie);
    await db()
      .update(artifacts)
      .set({ accessEpoch: sql`${artifacts.accessEpoch} + 1` })
      .where(eq(artifacts.id, id))
      .run();
    expect(await within(a.closed, 300)).toBe("timeout");
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect(await within(a.closed)).toMatchObject({ code: 4401 });

    const { id: id2, ownerP: o2 } = await setup();
    const b = await connect(id2, o2.cookie);
    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, id2))
      .run();
    await runDurableObjectAlarm(stubFor(id2));
    expect(await within(b.closed)).toMatchObject({ code: 4404 });
  });

  it("the alarm closes a socket whose content pass expired, and keeps the others", async () => {
    const { id, ownerP } = await setup();
    const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
    const x = await sealJson(SECRET, IDENTITY_CLAIM_INFO, id, { m: ownerP.email, r: "owner" });
    const short = await signToken(SECRET, {
      k: "content",
      a: id,
      e: row?.accessEpoch ?? 1,
      exp: Date.now() + 1500,
      x,
    });
    const name = contentCookieName(config(), new URL(contentOrigin(id)));
    const a = await connect(id, `${name}=${short}`);
    const b = await connect(id, ownerP.cookie);
    await new Promise((r) => setTimeout(r, 1600));
    await runDurableObjectAlarm(stubFor(id));
    expect(await within(a.closed)).toMatchObject({ code: 4401 });
    expect(await within(b.closed, 300)).toBe("timeout");
    b.ws.close(1000);
  });

  it("the alarm is set while sockets are open; artifacts without a room never get an object", async () => {
    const { id, ownerP, owner } = await setup();
    const a = await connect(id, ownerP.cookie);
    a.ws.close(1000);
    await a.closed;
    // A page without a room, through every notifying path.
    const { body: plain } = await publish(owner.auth, { html: PLAIN, visibility: "allowlist" });
    await grant(plain.id, uniqueEmail(), "viewer");
    const vis = await call(`/api/v1/artifacts/${plain.id}/visibility`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "unlisted" }),
    });
    expect(vis.status).toBe(200);
    const upd = await call(`/api/v1/artifacts/${plain.id}`, {
      method: "PUT",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ html: `${PLAIN}<p>2</p>`, base_version: 1 }),
    });
    expect(upd.status).toBe(200);
    await call(`/api/v1/artifacts/${plain.id}`, { method: "DELETE", headers: owner.auth });
    await new Promise((r) => setTimeout(r, 100));
    const ids = (await listDurableObjectIds(rooms())).map((i) => i.toString());
    expect(ids).toContain(rooms().idFromName(id).toString());
    expect(ids).not.toContain(rooms().idFromName(plain.id).toString());
  });
});
