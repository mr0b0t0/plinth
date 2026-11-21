// The live-room gates on an artifact's own content origin (#36, docs/security.md#live-rooms): the
// WebSocket upgrade at /__plinth/room/v1/{page,doc} with its nine ordered checks, and
// GET /__plinth/api/v1/room behind the data API's caller checks. Cookies are minted through the
// real gate and enter flow; previews and captures are signed the way Plinth signs them.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";
import { contentCsp } from "../src/content/csp.ts";
import { contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import { artifacts } from "../src/db/schema.ts";
import { viewerIdFor } from "../src/lib/crypto.ts";
import { parseConnect, parseWatchConnect } from "../src/rooms/ArtifactRoom.ts";
import {
  APP,
  agent,
  browserSession,
  call,
  config,
  contentOrigin,
  db,
  enterContent,
  json,
  publish,
} from "./helpers.ts";
import {
  client,
  connect,
  info,
  PLAIN,
  person,
  roomPage,
  run,
  setup,
  upgrade,
} from "./room-helpers.ts";

const SECRET = "test-token-signing-key-0123456789abcdef012345";

function expectNoCors(res: Response, label = "") {
  for (const [k] of res.headers)
    expect(k.startsWith("access-control-"), `${label} ${k}`).toBe(false);
}

/** A refusal: the status, no socket, the content headers and no CORS. */
async function refused(res: Response, status: number, label = "", csp = contentCsp(config())) {
  expect(res.status, label).toBe(status);
  expect(res.webSocket, label).toBeFalsy();
  expect(res.headers.get("content-security-policy"), label).toBe(csp);
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("set-cookie"), label).toBeNull();
  expectNoCors(res, label);
  await res.body?.cancel();
}

async function epochOf(id: string): Promise<number> {
  const row = await db().select().from(artifacts).where(eq(artifacts.id, id)).get();
  return row?.accessEpoch ?? 0;
}

/** A content cookie of another kind, signed as Plinth signs one (plain name: http in tests). */
async function passCookie(id: string, kind: "preview" | "capture"): Promise<string> {
  const value = await signContentCookie(config(), id, await epochOf(id), undefined, kind, 1);
  return `${contentCookieName(config(), new URL(contentOrigin(id)))}=${value}`;
}

const DOC = { html: undefined, type: "doc", content: "# Plan\n\nText.\n" };

describe("room upgrade: the checks, in order", () => {
  it("1. method: OPTIONS (a preflight) and POST get 405, a GET without Upgrade 426; never CORS", async () => {
    const { id, ownerP } = await setup();
    const preflight = await upgrade(id, ownerP.cookie, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "GET", upgrade: null },
    });
    await refused(preflight, 405, "options");
    expect(preflight.headers.get("allow")).toBe("GET");
    await refused(await upgrade(id, ownerP.cookie, { method: "POST" }), 405, "post");
    await refused(
      await upgrade(id, ownerP.cookie, { headers: { upgrade: null } }),
      426,
      "no upgrade",
    );
    // The method is checked first: a bad Origin does not change a 405.
    await refused(
      await upgrade(id, null, { method: "DELETE", headers: { origin: APP } }),
      405,
      "first",
    );
  });

  it("2. Origin: missing, null, a sibling artifact and the app are refused", async () => {
    const { id, ownerP } = await setup();
    const { id: sibling } = await setup();
    for (const [label, origin] of [
      ["missing", null],
      ["null", "null"],
      ["sibling", contentOrigin(sibling)],
      ["app", APP],
      ["other scheme", contentOrigin(id).replace("http:", "https:")],
    ] as const) {
      await refused(await upgrade(id, ownerP.cookie, { headers: { origin } }), 403, label);
    }
    // Before the subprotocol and before availability.
    await refused(
      await upgrade(id, ownerP.cookie, {
        headers: { origin: null, "sec-websocket-protocol": null },
        vars: { ALLOW_ROOMS: "false" },
      }),
      403,
      "order",
    );
  });

  it("3. fetch metadata, when sent: same-origin, websocket mode", async () => {
    const { id, ownerP } = await setup();
    for (const site of ["cross-site", "same-site", "none"]) {
      await refused(
        await upgrade(id, ownerP.cookie, { headers: { "sec-fetch-site": site } }),
        403,
        site,
      );
    }
    await refused(
      await upgrade(id, ownerP.cookie, { headers: { "sec-fetch-mode": "cors" } }),
      403,
      "mode",
    );
    // Clients that send no fetch metadata are judged by the other checks.
    const bare = await connect(id, ownerP.cookie, {
      headers: { "sec-fetch-site": null, "sec-fetch-mode": null },
    });
    bare.ws.close(1000);
  });

  it("4. the plinth.room.v1 subprotocol is required", async () => {
    const { id, ownerP } = await setup();
    await refused(
      await upgrade(id, ownerP.cookie, { headers: { "sec-websocket-protocol": null } }),
      400,
      "missing",
    );
    await refused(
      await upgrade(id, ownerP.cookie, {
        headers: { "sec-websocket-protocol": "chat, plinth.room" },
      }),
      400,
      "other",
    );
    const listed = await connect(id, ownerP.cookie, {
      headers: { "sec-websocket-protocol": "chat, plinth.room.v1" },
    });
    listed.ws.close(1000);
  });

  it("5. rooms off, no binding, opaque isolation and the path fallback are refused", async () => {
    const { id, ownerP } = await setup();
    await refused(await upgrade(id, ownerP.cookie, { vars: { ALLOW_ROOMS: "false" } }), 404, "off");
    await refused(await upgrade(id, ownerP.cookie, { vars: { ROOMS: undefined } }), 404, "binding");
    await refused(
      await upgrade(id, ownerP.cookie, { vars: { CONTENT_ISOLATION: "opaque" } }),
      404,
      "opaque",
      contentCsp(parseConfig({ ...env, CONTENT_ISOLATION: "opaque" } as Record<string, unknown>)),
    );
    // The path fallback serves content from the app origin: never a room there.
    const fallback = await run(
      `${APP}/__content/${id}/__plinth/room/v1/page`,
      {
        headers: {
          upgrade: "websocket",
          origin: APP,
          "sec-websocket-protocol": "plinth.room.v1",
          cookie: ownerP.cookie,
        },
      },
      { STAGING_CONTENT_FALLBACK: "true" },
    );
    expect(fallback.webSocket).toBeFalsy();
    // Its origin is the app's, never the artifact's: refused at the Origin check already.
    expect(fallback.status).toBe(403);
    // Unknown paths under the prefix are not rooms either.
    await refused(await upgrade(id, ownerP.cookie, { kind: "chat" }), 404, "unknown kind");
  });

  it("6 and 8. the artifact: deleted, taken down, or of another kind than the path", async () => {
    const { id, ownerP, owner } = await setup();
    // An HTML page on the doc path, and a page that declares nothing.
    await refused(await upgrade(id, ownerP.cookie, { kind: "doc" }), 404, "html on doc");
    const { id: plain, ownerP: plainOwner } = await setup(PLAIN);
    await refused(await upgrade(plain, plainOwner.cookie), 404, "undeclared");
    const { id: dataOnly, ownerP: dataOwner } = await setup(
      '<!doctype html><meta name="plinth-capabilities" content="data viewer"><p>x</p>',
    );
    await refused(await upgrade(dataOnly, dataOwner.cookie), 404, "data only");
    // A doc on the page path.
    const { id: doc, ownerP: docOwner } = await setup(undefined, DOC);
    await refused(await upgrade(doc, docOwner.cookie), 404, "doc on page");

    await db()
      .update(artifacts)
      .set({ takenDownAt: new Date().toISOString() })
      .where(eq(artifacts.id, plain))
      .run();
    await refused(await upgrade(plain, plainOwner.cookie), 404, "taken down");
    const del = await call(`/api/v1/artifacts/${id}`, { method: "DELETE", headers: owner.auth });
    expect(del.status).toBe(204);
    await refused(await upgrade(id, ownerP.cookie), 404, "deleted");
    await refused(await upgrade("a".repeat(20), ownerP.cookie), 404, "unknown");
  });

  it("7. the content pass: none, an old epoch, a preview, a capture and no claim are refused", async () => {
    const { id, ownerP } = await setup(roomPage(), { visibility: "unlisted" });
    await refused(await upgrade(id, null), 401, "none");
    await refused(await upgrade(id, "plinth_content=forged.value"), 401, "forged");
    await refused(await upgrade(id, await passCookie(id, "preview")), 403, "preview");
    await refused(await upgrade(id, await passCookie(id, "capture")), 403, "capture");
    // An unlisted link viewer has a pass without an identity: no anonymous room members in v1.
    const { cookie: anon } = await enterContent(id);
    await refused(await upgrade(id, anon ?? ""), 403, "no claim");
    // Any sharing change ends the old pass.
    await db()
      .update(artifacts)
      .set({ accessEpoch: sql`${artifacts.accessEpoch} + 1` })
      .where(eq(artifacts.id, id))
      .run();
    await refused(await upgrade(id, ownerP.cookie), 401, "old epoch");
  });

  it("7 before 8: without a pass, a doc, a declared page and an undeclared page all answer the same", async () => {
    // A client outside a browser can forge Origin; with no cookie it must learn nothing about
    // the artifact's type or declaration (only that it exists, as the content path says).
    const { id: page } = await setup();
    const { id: plain } = await setup(PLAIN);
    const { id: doc } = await setup(undefined, DOC);
    for (const [label, id, kind] of [
      ["declared page", page, "page"],
      ["declared page on the doc path", page, "doc"],
      ["undeclared page", plain, "page"],
      ["doc", doc, "doc"],
      ["doc on the page path", doc, "page"],
    ] as const) {
      const res = await upgrade(id, null, { kind });
      expect(await res.clone().text(), label).toBe("expired\n");
      await refused(res, 401, label);
    }
  });

  it("8. the kind needs a pass first; 9. policy: the doc channel is for owners and editors only", async () => {
    const { id: doc, ownerP } = await setup(undefined, DOC);
    const commenter = await person(doc, "commenter");
    const viewer = await person(doc, "viewer");
    await refused(await upgrade(doc, commenter.cookie, { kind: "doc" }), 403, "commenter");
    await refused(await upgrade(doc, viewer.cookie, { kind: "doc" }), 403, "viewer");
    // An owner passes every gate check and gets the doc channel.
    const owner = await upgrade(doc, ownerP.cookie, { kind: "doc" });
    expect(owner.status).toBe(101);
    owner.webSocket?.accept();
    owner.webSocket?.close(1000);
    // With on-page editing off, the doc channel is not there at all.
    const off = await upgrade(doc, ownerP.cookie, {
      kind: "doc",
      vars: { ALLOW_LIVE_EDITING: "false" },
    });
    await refused(off, 404, "not_declared");
  });

  it("success: 101 with the subprotocol and the content headers; client headers never reach the room", async () => {
    const { id } = await setup(roomPage({ viewer: true }));
    const commenter = await person(id, "commenter");
    const forged = JSON.stringify({ role: "owner", email: "boss@example.com", emit: "all" });
    const res = await upgrade(id, commenter.cookie, { headers: { "x-plinth-room": forged } });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("plinth.room.v1");
    expect(res.headers.get("content-security-policy")).toBe(contentCsp(config()));
    expectNoCors(res);
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const c = client(ws);
    const welcome = await c.next();
    expect(welcome).toEqual({
      t: "welcome",
      v: 1,
      you: {
        id: expect.stringMatching(/^s_/),
        viewer: await viewerIdFor(SECRET, id, commenter.email),
        role: "commenter",
        email: commenter.email,
        name: null,
      },
      limits: { max_message_bytes: 8192, messages_per_second: 20, presence_bytes: 400 },
    });
    // The forged header did not grant emit rights.
    c.send({ t: "join", room: "main" });
    await c.nextOf("peers");
    c.send({ t: "emit", room: "main", topic: "note.move", data: 1 });
    expect(await c.next()).toEqual({ t: "error", code: "forbidden_topic" });
    ws.close(1000);
  });
});

describe("GET /__plinth/api/v1/room", () => {
  it("inherits the data API's caller checks", async () => {
    const { id, ownerP } = await setup();
    const cases: [string, Parameters<typeof info>[2], number][] = [
      ["no custom header", { headers: { "x-plinth-data": null } }, 403],
      ["cross-site", { headers: { "sec-fetch-site": "cross-site" } }, 403],
      ["not a fetch", { headers: { "sec-fetch-dest": "document" } }, 403],
      ["navigation", { headers: { "sec-fetch-mode": "navigate" } }, 403],
      ["other origin", { headers: { origin: APP } }, 403],
      ["null origin", { headers: { origin: "null" } }, 403],
      ["POST", { method: "POST" }, 405],
      ["OPTIONS", { method: "OPTIONS" }, 405],
    ];
    for (const [label, opts, status] of cases) {
      const res = await info(id, ownerP.cookie, opts);
      expect(res.status, label).toBe(status);
      expectNoCors(res, label);
      expect(res.headers.get("content-security-policy"), label).toBe(contentCsp(config()));
    }
    // The same-origin Origin a browser may send is fine.
    expect((await info(id, ownerP.cookie, { headers: { origin: contentOrigin(id) } })).status).toBe(
      200,
    );
  });

  it("answers why a room is unavailable", async () => {
    const { id, ownerP } = await setup(roomPage(), { visibility: "unlisted" });
    const reason = async (res: Response) => {
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.available).toBe(false);
      return body.reason as string;
    };
    expect(await reason(await info(id, ownerP.cookie, { vars: { ALLOW_ROOMS: "false" } }))).toBe(
      "disabled",
    );
    expect(await reason(await info(id, ownerP.cookie, { vars: { ROOMS: undefined } }))).toBe(
      "not_configured",
    );
    expect(
      await reason(await info(id, ownerP.cookie, { vars: { CONTENT_ISOLATION: "opaque" } })),
    ).toBe("opaque_isolation");
    expect(await reason(await info(id, await passCookie(id, "preview")))).toBe("preview");
    expect(await reason(await info(id, await passCookie(id, "capture")))).toBe("not_identified");
    const { cookie: anon } = await enterContent(id);
    expect(await reason(await info(id, anon))).toBe("not_identified");
    const { id: plain, ownerP: plainOwner } = await setup(PLAIN);
    expect(await reason(await info(plain, plainOwner.cookie))).toBe("not_declared");
    const { id: doc, ownerP: docOwner } = await setup(undefined, DOC);
    expect(await reason(await info(doc, docOwner.cookie))).toBe("not_declared");

    const expired = await info(id, null);
    expect(expired.status).toBe(401);
    expect((await json(expired)).error.details).toEqual({ reason: "expired" });
    expect((await info("a".repeat(20), ownerP.cookie)).status).toBe(404);
  });

  it("tells an identified viewer who they are, what they may emit and the limits", async () => {
    const { id, ownerP } = await setup(roomPage({ viewer: true, open: "cursor note.move" }));
    const owner = await json(await info(id, ownerP.cookie));
    expect(owner).toEqual({
      available: true,
      reason: null,
      you: {
        viewer: await viewerIdFor(SECRET, id, ownerP.email),
        role: "owner",
        email: ownerP.email,
        name: null,
      },
      can_emit: "all",
      open_topics: ["cursor", "note.move"],
      limits: {
        max_message_bytes: 8192,
        messages_per_second: 20,
        presence_bytes: 400,
        rooms_per_connection: 3,
      },
    });
    const commenter = await person(id, "commenter");
    expect(await json(await info(id, commenter.cookie))).toMatchObject({
      available: true,
      you: { role: "commenter", email: commenter.email },
      can_emit: "open",
      open_topics: ["cursor", "note.move"],
    });
    const editor = await person(id, "editor");
    expect(await json(await info(id, editor.cookie))).toMatchObject({
      available: true,
      you: { role: "editor" },
      can_emit: "all",
    });
    // A viewer joins and receives, but never emits, even the page's open topics.
    const viewer = await person(id, "viewer");
    expect(await json(await info(id, viewer.cookie))).toMatchObject({
      available: true,
      you: { role: "viewer", email: viewer.email },
      can_emit: "none",
      open_topics: ["cursor", "note.move"],
    });
    // Without `viewer`, the page never learns an email.
    const { id: anonPage, ownerP: o2 } = await setup(roomPage({ viewer: false }));
    expect((await json(await info(anonPage, o2.cookie))).you.email).toBeNull();
  });

  it("is independent of shared data: rooms work with shared data off, and a room is no data", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth, { html: roomPage(), visibility: "allowlist" });
    const s = await browserSession(owner.user.id);
    const { cookie } = await enterContent(p.id, { headers: s.headers });
    const noData = { ALLOW_SHARED_DATA: "false" };
    expect(await json(await info(p.id, cookie, { vars: noData }))).toMatchObject({
      available: true,
    });
    // The page declares only `room`: the data API has nothing for it.
    const res = await run(`${contentOrigin(p.id)}/__plinth/api/v1/session`, {
      headers: {
        "x-plinth-data": "1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-dest": "empty",
        cookie: cookie ?? "",
      },
    });
    expect(await json(res)).toEqual({ available: false, reason: "not_declared" });
  });
});

describe("live views: the room's watch header (docs/security.md#live-views)", () => {
  const good = {
    artifactId: "a0b1c2d3e4f5g6h7i8j9",
    kind: "watch",
    epoch: 3,
    passExp: 1_900_000_000_000,
    version: 2,
    data: true,
    client: "0123456789abcdef",
    pool: "open",
    limits: { maxSockets: 1000 },
  };

  it("parses a well-formed header into exactly its fields", () => {
    expect(parseWatchConnect(JSON.stringify({ ...good, extra: "dropped" }))).toEqual(good);
  });

  it("refuses every other shape", () => {
    const bad: unknown[] = [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify([good]),
      JSON.stringify({ ...good, kind: "page" }),
      JSON.stringify({ ...good, artifactId: "SHORT" }),
      JSON.stringify({ ...good, epoch: -1 }),
      JSON.stringify({ ...good, epoch: 1.5 }),
      JSON.stringify({ ...good, passExp: "soon" }),
      JSON.stringify({ ...good, version: null }),
      JSON.stringify({ ...good, data: 1 }),
      JSON.stringify({ ...good, client: "0123456789abcde" }),
      JSON.stringify({ ...good, client: "0123456789abcdeg" }),
      JSON.stringify({ ...good, pool: "page" }),
      JSON.stringify({ ...good, pool: undefined }),
      JSON.stringify({ ...good, limits: { maxSockets: 0 } }),
      JSON.stringify({ ...good, limits: [] }),
      JSON.stringify({ ...good, limits: undefined }),
      JSON.stringify({ ...good, client: "x".repeat(2000) }),
    ];
    for (const raw of bad) expect(parseWatchConnect(raw as string | null), String(raw)).toBeNull();
  });

  it("a room header can never name the watch kind", () => {
    const room = {
      artifactId: good.artifactId,
      type: "html",
      kind: "watch",
      epoch: 1,
      passExp: good.passExp,
      viewer: "u_0123456789abcdef01234567",
      role: "viewer",
      email: "a@example.com",
      name: null,
      seeIdentity: false,
      emit: "none",
      openTopics: [],
      doc: "none",
      limits: { maxConnections: 50, maxMessageBytes: 8192, messagesPerSecond: 20 },
    };
    expect(parseConnect(JSON.stringify(room))).toBeNull();
    expect(parseConnect(JSON.stringify({ ...room, kind: "page" }))).not.toBeNull();
  });

  it("a room header names a registered type: a sheet's draft socket, never an unknown type", () => {
    const sheet = {
      artifactId: good.artifactId,
      type: "sheet",
      kind: "doc",
      epoch: 1,
      passExp: good.passExp,
      viewer: "u_0123456789abcdef01234567",
      role: "editor",
      email: "a@example.com",
      name: null,
      seeIdentity: false,
      emit: "none",
      openTopics: [],
      doc: "write",
      limits: { maxConnections: 50, maxMessageBytes: 8192, messagesPerSecond: 20 },
    };
    expect(parseConnect(JSON.stringify(sheet))?.type).toBe("sheet");
    expect(parseConnect(JSON.stringify({ ...sheet, type: "doc" }))?.type).toBe("doc");
    for (const type of ["spreadsheet", "", 1, null, "__proto__", "toString"]) {
      expect(parseConnect(JSON.stringify({ ...sheet, type })), String(type)).toBeNull();
    }
  });
});
