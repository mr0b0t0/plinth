// Display names in live rooms (docs/spec.md "Who is viewing: names and the people list"): a peer's
// and your own name travel beside the email, only when the page declares `viewer`; the room
// refuses a connect header with a bad name; and a socket with every field at its maximum never
// crashes the room when its attachment would pass the limit.
import { ROOM_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  encodeConnect,
  parseConnect,
  ROOM_NAME_BYTES,
  type RoomConnect,
} from "../src/rooms/ArtifactRoom.ts";
import { createUser, json } from "./helpers.ts";
import { setName, storeRawName } from "./people-helpers.ts";
import {
  type Client,
  connect,
  grant,
  info,
  person,
  roomPage,
  sealedCookie,
  setup,
} from "./room-helpers.ts";

async function joined(c: Client, room = "main") {
  c.send({ t: "join", room });
  return c.nextOf("peers");
}

const CONNECT: RoomConnect = {
  artifactId: "a".repeat(20),
  type: "html",
  kind: "page",
  epoch: 1,
  passExp: Date.now() + 3600_000,
  viewer: "u_0123456789abcdef01234567",
  role: "owner",
  email: "ana@example.com",
  name: "Ana",
  seeIdentity: true,
  emit: "all",
  openTopics: [],
  doc: "none",
  limits: { maxConnections: 50, maxMessageBytes: 8192, messagesPerSecond: 20 },
};

describe("room names", () => {
  it("peers, events and welcome carry the name beside the email, only with `viewer`", async () => {
    const { id, ownerP } = await setup(roomPage({ viewer: true }));
    await setName(ownerP.userId, "Ana Owner");
    const ed = await person(id, "editor");
    const a = await connect(id, ownerP.cookie);
    expect(a.welcome.you).toMatchObject({ email: ownerP.email, name: "Ana Owner" });
    const b = await connect(id, ed.cookie);
    expect(b.welcome.you).toMatchObject({ email: ed.email, name: null });
    await joined(a);
    const bp = await joined(b);
    const owner = bp.peers.find((p: { viewer: string }) => p.viewer === a.welcome.you.viewer);
    expect(owner).toMatchObject({ role: "owner", email: ownerP.email, name: "Ana Owner" });
    await a.nextOf("peer");
    a.send({ t: "emit", room: "main", topic: "cursor", data: 1 });
    expect((await b.nextOf("event")).from).toMatchObject({ name: "Ana Owner" });
    // The availability check names you too.
    expect((await json(await info(id, ownerP.cookie))).you).toMatchObject({
      email: ownerP.email,
      name: "Ana Owner",
    });
    a.ws.close(1000);
    b.ws.close(1000);

    // Without `viewer`: no email, so no name either, anywhere.
    const { id: plain, ownerP: o2 } = await setup(roomPage({ viewer: false }));
    await setName(o2.userId, "Hidden Name");
    const c = await connect(plain, o2.cookie);
    expect(c.welcome.you.email).toBeUndefined();
    expect(c.welcome.you.name).toBeUndefined();
    const cp = await joined(c);
    expect(JSON.stringify(cp)).not.toContain("Hidden Name");
    expect((await json(await info(plain, o2.cookie))).you).toMatchObject({
      email: null,
      name: null,
    });
    c.ws.close(1000);
  });

  it("a rename reaches the room on the next connect", async () => {
    const { id, ownerP } = await setup(roomPage({ viewer: true }));
    await setName(ownerP.userId, "Before");
    const a = await connect(id, ownerP.cookie);
    expect(a.welcome.you.name).toBe("Before");
    await setName(ownerP.userId, "After");
    a.ws.close(1000);
    const b = await connect(id, ownerP.cookie);
    expect(b.welcome.you.name).toBe("After");
    b.ws.close(1000);
  });

  it("parseConnect takes a null name or one of at most 256 bytes without @", () => {
    expect(parseConnect(JSON.stringify(CONNECT))).toEqual(CONNECT);
    expect(parseConnect(JSON.stringify({ ...CONNECT, name: null }))).not.toBeNull();
    // A Worker still on the release before names sends no `name`: it reads as null, for now.
    const { name: _omitted, ...before } = CONNECT;
    expect(parseConnect(JSON.stringify(before))).toEqual({ ...CONNECT, name: null });
    const max = "\u{1F600}".repeat(ROOM_NAME_BYTES / 4);
    expect(parseConnect(JSON.stringify({ ...CONNECT, name: max }))).not.toBeNull();
    // The gate sends it ASCII-only (a header value), and the room reads the same name back.
    const encoded = encodeConnect({ ...CONNECT, name: `Zoë ${max.slice(0, 8)}` });
    expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
    expect(parseConnect(encoded)?.name).toBe(`Zoë ${max.slice(0, 8)}`);
    for (const name of [`${max}a`, "ana@example.com", 7, {}, []]) {
      const raw = JSON.stringify({ ...CONNECT, name });
      expect(parseConnect(raw), JSON.stringify(name)).toBeNull();
    }
  });

  it("a socket with every field at its maximum stays within the attachment limit or gets too_large", async () => {
    const topics = Array.from(
      { length: ROOM_LIMITS.maxOpenTopics },
      (_, i) => `t${String(i).padStart(2, "0")}${"x".repeat(37)}`,
    );
    const { id } = await setup(roomPage({ viewer: true, open: topics.join(" ") }));
    // A 254-byte address with an account whose name is 64 four-byte code points.
    const email = `${"m".repeat(64)}@${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(57)}.com`;
    expect(email.length).toBe(254);
    const user = await createUser(email);
    await storeRawName(user.id, "\u{1F600}".repeat(64));
    await grant(id, email, "commenter");
    const c = await connect(id, await sealedCookie(id, email, "commenter", true));
    expect(c.welcome.you.name).toBe("\u{1F600}".repeat(64));
    const rooms = ["main", `r${"1".repeat(39)}`, `r${"2".repeat(39)}`];
    const big = { p: "z".repeat(ROOM_LIMITS.presenceBytes - 10) };
    let refusals = 0;
    for (const room of rooms) {
      c.send({ t: "join", room });
      const f = await c.next();
      if (f.t === "error") {
        expect(f.code).toBe("too_large");
        refusals++;
        continue;
      }
      expect(f.t).toBe("peers");
      c.send({ t: "presence", room, state: big });
      // Either the update fits and nothing comes back to the sender, or it is refused.
      c.send("ping");
      const g = await c.next();
      if (g !== "pong") {
        expect(g).toEqual({ t: "error", code: "too_large" });
        refusals++;
        expect(await c.next()).toBe("pong");
      }
    }
    // At this size the attachment cannot hold all three presences: some were refused, and the
    // socket is still open and answering.
    expect(refusals).toBeGreaterThan(0);
    c.send({ t: "presence", room: "main", state: { x: 1 } });
    c.send("ping");
    const last = await c.next();
    expect(last === "pong" || last.code === "too_large").toBe(true);
    c.ws.close(1000);
  });
});
