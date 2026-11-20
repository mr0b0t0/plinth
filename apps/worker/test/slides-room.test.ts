// Following the presenter (docs/spec.md "Slides", docs/security.md#live-rooms): a deck's `slides`
// channel in ArtifactRoom, with real sockets through the upgrade gate. The gate and its order, the
// rights (owners and editors present, everyone else identified watches and sends nothing), the
// frames (start, goto, stop, at, stopped, audience), the caps, revocation and the alarm, and the
// shell's `follow` payload.
import { listDurableObjectIds, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig, slidesFollowActive } from "../src/config.ts";
import { contentCsp } from "../src/content/csp.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { IDENTITY_CLAIM_INFO, signContentCookie } from "../src/content/tokens.ts";
import { artifacts } from "../src/db/schema.ts";
import { sealJson, signToken } from "../src/lib/crypto.ts";
import { parseConnect, type RoomConnect } from "../src/rooms/ArtifactRoom.ts";
import {
  APP,
  call,
  config,
  contentOrigin,
  db,
  enterContent,
  publish,
  uniqueEmail,
} from "./helpers.ts";
import {
  type Client,
  client,
  connect,
  type Frame,
  grant,
  PLAIN,
  person,
  roomPage,
  run,
  sealedCookie,
  setup,
  upgrade,
  within,
} from "./room-helpers.ts";

const SECRET = "test-token-signing-key-0123456789abcdef012345";

const DECK = "# One\n\n---\n\n## Two\n\n---\n\n## Three\n\n---\n\n## Four\n";
const DECK_BODY = { html: undefined, type: "slides", content: DECK };
const DOC_BODY = { html: undefined, type: "doc", content: "# Plan\n\nText.\n" };

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

/** A deck and its signed-in owner with a content cookie. */
const deckSetup = (body: Record<string, unknown> = {}) =>
  setup(undefined, { ...DECK_BODY, ...body });

/** A slides socket and its welcome. */
const slides = (id: string, cookie: string, vars?: Record<string, unknown>) =>
  connect(id, cookie, { kind: "slides", ...(vars ? { vars } : {}) });

async function epochOf(id: string): Promise<number> {
  const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
  return row?.accessEpoch ?? 0;
}

/** A content cookie of another kind for version 1, signed as Plinth signs one. */
async function passCookie(id: string, kind: "preview" | "capture"): Promise<string> {
  const value = await signContentCookie(config(), id, await epochOf(id), undefined, kind, 1);
  return `${contentCookieName(config(), new URL(contentOrigin(id)))}=${value}`;
}

async function refused(res: Response, status: number, label = "", csp = contentCsp(config())) {
  expect(res.status, label).toBe(status);
  expect(res.webSocket, label).toBeFalsy();
  expect(res.headers.get("content-security-policy"), label).toBe(csp);
  for (const [k] of res.headers)
    expect(k.startsWith("access-control-"), `${label} ${k}`).toBe(false);
  await res.body?.cancel();
}

/** Frames until one with `t`, failing on none within the time. */
const next = (c: Client, t: string, ms?: number) => c.nextOf(t, ms);

/** No frame of kind `t` arrives within `ms` (frames stay queued for later reads). */
async function none(c: Client, t: string, ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
  expect(
    c.pending().filter((f) => f?.t === t),
    `no ${t}`,
  ).toEqual([]);
}

describe("slides socket: the gate", () => {
  it("is 101 for an identified owner (present) and viewer (watch), with the subprotocol", async () => {
    const { id, ownerP } = await deckSetup();
    const viewer = await person(id, "viewer");
    const res = await upgrade(id, ownerP.cookie, { kind: "slides" });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("plinth.room.v1");
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const o = client(ws);
    const welcome: Frame = await o.next();
    expect(welcome).toEqual({
      t: "welcome",
      v: 1,
      you: { id: expect.stringMatching(/^s_[A-Za-z0-9]{16}$/), present: true },
      at: null,
    });
    const v = await slides(id, viewer.cookie);
    expect(v.welcome).toEqual({
      t: "welcome",
      v: 1,
      you: { id: expect.any(String), present: false },
      at: null,
    });
    // No email, role or viewer id anywhere in a welcome.
    expect(JSON.stringify(v.welcome)).not.toContain("@");
    expect(JSON.stringify(v.welcome)).not.toContain("u_");
    for (const role of ["editor", "commenter"] as const) {
      const p = await person(id, role);
      const c = await slides(id, p.cookie);
      expect(c.welcome.you.present, role).toBe(role === "editor");
      c.ws.close(1000);
    }
    o.ws.close(1000);
    v.ws.close(1000);
  });

  it("people confirmed by code (no account) join too: an editor presents, a viewer watches", async () => {
    const { id } = await deckSetup();
    for (const [role, present] of [
      ["editor", true],
      ["viewer", false],
    ] as const) {
      const email = uniqueEmail(`coded-${role}`);
      await grant(id, email, role);
      const c = await slides(id, await sealedCookie(id, email, role, false));
      expect(c.welcome.you.present, role).toBe(present);
      c.ws.close(1000);
    }
  });

  it("is not there for an HTML page (even one that declares room) or a doc", async () => {
    const { id: page, ownerP: pageOwner } = await setup(roomPage());
    await refused(await upgrade(page, pageOwner.cookie, { kind: "slides" }), 404, "page");
    const { id: plain, ownerP: plainOwner } = await setup(PLAIN);
    await refused(await upgrade(plain, plainOwner.cookie, { kind: "slides" }), 404, "plain");
    const { id: doc, ownerP: docOwner } = await setup(undefined, DOC_BODY);
    await refused(await upgrade(doc, docOwner.cookie, { kind: "slides" }), 404, "doc");
    // And a deck has no page room and no doc channel.
    const { id: deck, ownerP } = await deckSetup();
    await refused(await upgrade(deck, ownerP.cookie), 404, "deck on page");
    await refused(await upgrade(deck, ownerP.cookie, { kind: "doc" }), 404, "deck on doc");
  });

  it("refuses an anonymous link pass, a preview and a capture; no pass is 401 before the kind", async () => {
    const { id } = await deckSetup({ visibility: "unlisted" });
    const { cookie: anon } = await enterContent(id);
    await refused(await upgrade(id, anon ?? "", { kind: "slides" }), 403, "no claim");
    await refused(
      await upgrade(id, await passCookie(id, "preview"), { kind: "slides" }),
      403,
      "preview",
    );
    await refused(
      await upgrade(id, await passCookie(id, "capture"), { kind: "slides" }),
      403,
      "capture",
    );
    // Without a pass, a deck and an HTML page answer the same: nothing about the type leaks.
    const { id: plain } = await setup(PLAIN);
    for (const target of [id, plain]) {
      const res = await upgrade(target, null, { kind: "slides" });
      expect(await res.clone().text()).toBe("expired\n");
      await refused(res, 401, target);
    }
  });

  it("checks Origin first: a forged one is 403 before any lookup", async () => {
    const { id, ownerP } = await deckSetup();
    for (const origin of [null, "null", contentOrigin("b".repeat(20)), APP])
      await refused(
        await upgrade(id, ownerP.cookie, { kind: "slides", headers: { origin } }),
        403,
        String(origin),
      );
    // Even for an artifact that does not exist.
    await refused(
      await upgrade("c".repeat(20), null, { kind: "slides", headers: { origin: APP } }),
      403,
      "unknown",
    );
  });

  it("is off with ALLOW_SLIDES_FOLLOW=false, with rooms off and under opaque isolation", async () => {
    const { id, ownerP } = await deckSetup();
    await refused(
      await upgrade(id, ownerP.cookie, { kind: "slides", vars: { ALLOW_SLIDES_FOLLOW: "false" } }),
      404,
      "switch",
    );
    await refused(
      await upgrade(id, ownerP.cookie, { kind: "slides", vars: { ALLOW_ROOMS: "false" } }),
      404,
      "rooms off",
    );
    await refused(
      await upgrade(id, ownerP.cookie, { kind: "slides", vars: { CONTENT_ISOLATION: "opaque" } }),
      404,
      "opaque",
      contentCsp(parseConfig({ ...env, CONTENT_ISOLATION: "opaque" } as Record<string, unknown>)),
    );
  });

  it("slidesFollowActive needs the switch and live rooms", () => {
    const binding = { ROOMS: env.ROOMS };
    const base = env as unknown as Record<string, unknown>;
    expect(slidesFollowActive(parseConfig(base), binding)).toBe(true);
    expect(parseConfig(base).allowSlidesFollow).toBe(true);
    expect(parseConfig({ ...base, ALLOW_SLIDES_FOLLOW: "" }).allowSlidesFollow).toBe(true);
    for (const off of ["false", "0", "no", "off"])
      expect(parseConfig({ ...base, ALLOW_SLIDES_FOLLOW: off }).allowSlidesFollow, off).toBe(false);
    expect(slidesFollowActive(parseConfig({ ...base, ALLOW_ROOMS: "false" }), binding)).toBe(false);
    expect(slidesFollowActive(parseConfig(base), {})).toBe(false);
    expect(typeof base.ALLOW_SLIDES_FOLLOW).toBe("string");
  });
});

describe("slides socket: the room's header", () => {
  const good: RoomConnect = {
    artifactId: "a".repeat(20),
    type: "slides",
    kind: "slides",
    epoch: 1,
    passExp: Date.now() + 60_000,
    viewer: "u_0123456789abcdef01234567",
    role: "viewer",
    email: "a@example.com",
    name: null,
    seeIdentity: false,
    emit: "none",
    openTopics: [],
    doc: "none",
    slides: "watch",
    limits: { maxConnections: 50, maxMessageBytes: 8192, messagesPerSecond: 20 },
  };

  it("parseConnect takes a slides socket with a present or watch right", () => {
    expect(parseConnect(JSON.stringify(good))).toEqual(good);
    expect(parseConnect(JSON.stringify({ ...good, slides: "present" }))).not.toBeNull();
    // Every registry type is a type, not only html and doc.
    for (const type of ["html", "doc", "design", "design_system"])
      expect(parseConnect(JSON.stringify({ ...good, type })), type).not.toBeNull();
  });

  it("refuses an unknown type or kind, and a right on the wrong kind", () => {
    const bad = [
      { ...good, type: "spreadsheet" },
      { ...good, type: "__proto__" },
      { ...good, kind: "deck" },
      { ...good, kind: "watch" },
      { ...good, slides: "none" },
      { ...good, slides: "lead" },
      { ...good, slides: undefined },
      { ...good, kind: "page", slides: "watch" },
      { ...good, kind: "doc", slides: "present" },
    ];
    for (const c of bad) expect(parseConnect(JSON.stringify(c)), JSON.stringify(c)).toBeNull();
    // Other kinds carry no right, or `none`.
    const page = { ...good, kind: "page", type: "html", slides: undefined };
    expect(parseConnect(JSON.stringify(page))).not.toBeNull();
    expect(parseConnect(JSON.stringify({ ...page, slides: "none" }))).not.toBeNull();
  });
});

describe("slides socket: presenting and following", () => {
  it("a watcher may send nothing; a presenter's start reaches everyone and a late welcome", async () => {
    const { id, ownerP } = await deckSetup();
    const viewer = await person(id, "viewer");
    const o = await slides(id, ownerP.cookie);
    const v = await slides(id, viewer.cookie);
    // The owner learns the audience as people join.
    v.send({ t: "goto", slide: 2 });
    expect(await next(v, "error")).toEqual({ t: "error", code: "forbidden" });
    v.send({ t: "start", slide: 2 });
    expect(await next(v, "error")).toEqual({ t: "error", code: "forbidden" });
    v.send({ t: "stop" });
    expect(await next(v, "error")).toEqual({ t: "error", code: "forbidden" });
    v.send("ping");
    expect(await v.next()).toBe("pong");

    o.send({ t: "start", slide: 3 });
    const at = await next(v, "at");
    expect(at).toEqual({ t: "at", slide: 3, by: o.welcome.you.id });
    // The leader gets its own `at` (it leads) and the audience: one other person.
    expect(await next(o, "at")).toEqual({ t: "at", slide: 3, by: o.welcome.you.id });
    expect(await next(o, "audience")).toEqual({ t: "audience", n: 1 });
    o.send({ t: "goto", slide: 4 });
    expect(await next(v, "at")).toEqual({ t: "at", slide: 4, by: o.welcome.you.id });
    // A late joiner's welcome carries the position; the leader hears the new audience.
    const commenter = await person(id, "commenter");
    const late = await slides(id, commenter.cookie);
    expect(late.welcome.at).toEqual({ slide: 4, by: o.welcome.you.id });
    expect(await next(o, "audience")).toEqual({ t: "audience", n: 2 });
    // The same person in a second tab is not a second follower.
    const v2 = await slides(id, viewer.cookie);
    expect(v2.welcome.at).toEqual({ slide: 4, by: o.welcome.you.id });
    expect(await next(o, "audience")).toEqual({ t: "audience", n: 2 });
    // Nothing a watcher gets names anyone.
    for (const f of [at, late.welcome]) expect(JSON.stringify(f)).not.toMatch(/@|u_|owner/);
    // Leaving: the leader hears it.
    late.ws.close(1000);
    expect(await next(o, "audience")).toEqual({ t: "audience", n: 1 });
    // Stop: everyone else gets `stopped`.
    o.send({ t: "stop" });
    expect(await next(v, "stopped")).toEqual({ t: "stopped" });
    expect(await next(v2, "stopped")).toEqual({ t: "stopped" });
    for (const c of [o, v, v2]) c.ws.close(1000);
  });

  it("the last presenter to start leads; the earlier one's goto is not_leading", async () => {
    const { id, ownerP } = await deckSetup();
    const ed = await person(id, "editor");
    const viewer = await person(id, "viewer");
    const a = await slides(id, ownerP.cookie);
    const b = await slides(id, ed.cookie);
    const v = await slides(id, viewer.cookie);
    a.send({ t: "start", slide: 1 });
    expect(await next(v, "at")).toMatchObject({ slide: 1, by: a.welcome.you.id });
    b.send({ t: "start", slide: 2 });
    expect(await next(v, "at")).toEqual({ t: "at", slide: 2, by: b.welcome.you.id });
    // A learns it no longer leads from B's `at`.
    expect(await next(a, "at")).toMatchObject({ slide: 1, by: a.welcome.you.id });
    expect(await next(a, "at")).toEqual({ t: "at", slide: 2, by: b.welcome.you.id });
    a.send({ t: "goto", slide: 3 });
    expect(await next(a, "error")).toEqual({ t: "error", code: "not_leading" });
    await none(v, "at");
    // B leaves while A still presents: A leads again, at its own slide.
    b.ws.close(1000);
    expect(await next(v, "at")).toEqual({ t: "at", slide: 1, by: a.welcome.you.id });
    expect(await next(a, "audience")).toMatchObject({ t: "audience" });
    // A leaves too: nobody leads.
    a.ws.close(1000);
    expect(await next(v, "stopped")).toEqual({ t: "stopped" });
    v.ws.close(1000);
  });

  it("a presenter that stopped is never handed the lead", async () => {
    const { id, ownerP } = await deckSetup();
    const ed = await person(id, "editor");
    const viewer = await person(id, "viewer");
    const a = await slides(id, ownerP.cookie);
    const b = await slides(id, ed.cookie);
    const v = await slides(id, viewer.cookie);
    a.send({ t: "start", slide: 2 });
    await next(v, "at");
    b.send({ t: "start", slide: 3 });
    await next(v, "at");
    a.send({ t: "stop" });
    // A was not leading: nothing changes for the others.
    await none(v, "stopped");
    b.send({ t: "stop" });
    expect(await next(v, "stopped")).toEqual({ t: "stopped" });
    for (const c of [a, b, v]) c.ws.close(1000);
  });

  it("frames: over 128 bytes closes with 1009, binary with 1003, out of range is invalid", async () => {
    const { id, ownerP } = await deckSetup();
    const o = await slides(id, ownerP.cookie);
    for (const raw of [
      '{"t":"start","slide":0}',
      '{"t":"goto","slide":501}',
      '{"t":"start","slide":2.5}',
      '{"t":"join","room":"main"}',
      "not json",
    ]) {
      o.send(raw);
      expect(await next(o, "error"), raw).toEqual({ t: "error", code: "invalid" });
    }
    o.send(JSON.stringify({ t: "stop", pad: "x".repeat(130) }));
    expect(await within(o.closed)).toMatchObject({ code: 1009 });
    const b = await slides(id, ownerP.cookie);
    b.ws.send(new Uint8Array([1, 2, 3]));
    expect(await within(b.closed)).toMatchObject({ code: 1003 });
  });

  it("a watcher that keeps sending is closed with 4429", async () => {
    const { id } = await deckSetup();
    const viewer = await person(id, "viewer");
    const v = await slides(id, viewer.cookie);
    for (let i = 0; i < 60; i++) v.send({ t: "goto", slide: 1 });
    expect(await within(v.closed, 5000)).toMatchObject({ code: 4429 });
  });

  it("slides sockets count toward ROOM_MAX_CONNECTIONS_PER_ARTIFACT", async () => {
    const { id, ownerP } = await deckSetup();
    const vars = { ROOM_MAX_CONNECTIONS_PER_ARTIFACT: "2" };
    const a = await slides(id, ownerP.cookie, vars);
    const b = await slides(id, ownerP.cookie, vars);
    const res = await upgrade(id, ownerP.cookie, { kind: "slides", vars });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    expect(await within(client(ws).closed)).toMatchObject({ code: 4409 });
    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe("slides socket: revocation", () => {
  it("a sharing change closes with 4401; deleting the deck closes with 4404", async () => {
    const { id, ownerP, owner } = await deckSetup();
    const viewer = await person(id, "viewer");
    const v = await slides(id, viewer.cookie);
    const res = await call(`/api/v1/artifacts/${id}/sharing`, {
      method: "PUT",
      headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ grants: [] }),
    });
    expect(res.status).toBe(200);
    expect(await within(v.closed)).toMatchObject({ code: 4401 });
    expect((await upgrade(id, viewer.cookie, { kind: "slides" })).status).toBe(401);
    const o = await slides(id, await (async () => (await person(id, "editor")).cookie)());
    const del = await call(`/api/v1/artifacts/${id}`, { method: "DELETE", headers: owner.auth });
    expect(del.status).toBe(204);
    expect(await within(o.closed)).toMatchObject({ code: 4404 });
  });

  it("with live views off, a deck's room is still told about a sharing change", async () => {
    const { id, ownerP } = await deckSetup();
    const viewer = await person(id, "viewer");
    const v = await slides(id, viewer.cookie);
    const res = await run(
      `${APP}/api/v1/artifacts/${id}/visibility`,
      {
        method: "PUT",
        headers: { ...ownerP.session.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "unlisted" }),
      },
      { ALLOW_LIVE_VIEWS: "false" },
    );
    expect(res.status).toBe(200);
    expect(await within(v.closed)).toMatchObject({ code: 4401 });
    const ids = (await listDurableObjectIds(rooms())).map((i) => i.toString());
    expect(ids).toContain(rooms().idFromName(id).toString());
  });

  it("the alarm closes an expired pass and an epoch bump made with SQL; the leader hands over", async () => {
    const { id, ownerP } = await deckSetup();
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
    const lead = await slides(id, `${name}=${short}`);
    const viewer = await person(id, "viewer");
    const v = await slides(id, viewer.cookie);
    lead.send({ t: "start", slide: 2 });
    expect(await next(v, "at")).toMatchObject({ slide: 2 });
    await new Promise((r) => setTimeout(r, 1600));
    await runDurableObjectAlarm(stubFor(id));
    expect(await within(lead.closed)).toMatchObject({ code: 4401 });
    // The leader is gone: the follower hears that nobody leads, and stays connected.
    expect(await next(v, "stopped")).toEqual({ t: "stopped" });
    expect(await within(v.closed, 300)).toBe("timeout");
    await db()
      .update(artifacts)
      .set({ accessEpoch: sql`${artifacts.accessEpoch} + 1` })
      .where(eq(artifacts.id, id))
      .run();
    await runDurableObjectAlarm(stubFor(id));
    expect(await within(v.closed)).toMatchObject({ code: 4401 });
  });
});

describe("slides on the content host: the follow payload", () => {
  function payloadOf(html: string) {
    const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(html);
    expect(m, "payload block").not.toBeNull();
    return JSON.parse(m?.[1] ?? "null");
  }
  const shell = async (id: string, cookie: string, path = "/", vars?: Record<string, unknown>) => {
    const res = await run(`${contentOrigin(id)}${path}`, { headers: { cookie } }, vars);
    expect(res.status, path).toBe(200);
    return payloadOf(await res.text());
  };

  it("owners and editors present, everyone else identified watches", async () => {
    const { id, ownerP } = await deckSetup();
    expect((await shell(id, ownerP.cookie)).follow).toBe("present");
    for (const [role, want] of [
      ["editor", "present"],
      ["commenter", "watch"],
      ["viewer", "watch"],
    ] as const) {
      const p = await person(id, role);
      expect((await shell(id, p.cookie)).follow, role).toBe(want);
    }
  });

  it("never for a link viewer, a capture, review mode, a pinned version or with following off", async () => {
    const { id, ownerP, owner } = await deckSetup({ visibility: "unlisted" });
    const { cookie: anon } = await enterContent(id);
    expect(await shell(id, anon ?? "")).not.toHaveProperty("follow");
    expect(await shell(id, await passCookie(id, "capture"))).not.toHaveProperty("follow");
    expect(await shell(id, ownerP.cookie, "/?plinth-review=1")).not.toHaveProperty("follow");
    expect(await shell(id, ownerP.cookie, "/__plinth/v/1/")).not.toHaveProperty("follow");
    expect(
      await shell(id, ownerP.cookie, "/", { ALLOW_SLIDES_FOLLOW: "false" }),
    ).not.toHaveProperty("follow");
    expect(await shell(id, ownerP.cookie, "/", { ALLOW_ROOMS: "false" })).not.toHaveProperty(
      "follow",
    );
    // A doc never gets it.
    const { body: d } = await publish(owner.auth, { ...DOC_BODY, visibility: "allowlist" });
    await grant(d.id, ownerP.email, "viewer");
    const { cookie: docCookie } = await enterContent(d.id, { headers: ownerP.session.headers });
    expect(await shell(d.id, docCookie ?? "")).not.toHaveProperty("follow");
  });
});
