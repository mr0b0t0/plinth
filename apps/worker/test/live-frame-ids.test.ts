// The room protocol's answer ids (docs/spec.md "Editing", the room protocol): a client frame that
// carries `id` gets it back as `re` on the room's direct answer to it, success or failure, and on
// no other frame. The other sockets' copies of a broadcast answer carry none, nor do frames that
// answer nothing (`draft_limit` after a flush, a `released` someone else's takeover caused). A
// frame with no `id` (a tab opened before the room knew it) is answered as before, with no `re`.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { browserSession, createToken, createUser, publish } from "./helpers.ts";
import {
  type Client,
  connectDoc,
  cookieFor,
  docBody,
  docSetup,
  type Frame,
  person,
  sheetSetup,
} from "./room-helpers.ts";

type Socket = Client & { welcome: Frame; text: string };

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

/** The next frame of kind `t` this socket gets for which `ok` holds. */
async function nextWhere(c: Socket, t: string, ok: (f: Frame) => boolean = () => true) {
  for (;;) {
    const f = await c.nextOf(t);
    if (ok(f)) return f;
  }
}
const mine = (c: Socket) => (f: Frame) => f.holder === c.welcome.you.id;

/** Ages every held lease past the idle time, as if a minute went by. */
const age = (id: string) =>
  runInDurableObject(stubFor(id), async (room, state) => {
    for (const ws of state.getWebSockets("k:doc")) {
      const s = ws.deserializeAttachment() as { lease?: { at: number } | null };
      if (s.lease) {
        s.lease.at -= (LIMITS.liveLeaseIdleS + 1) * 1000;
        ws.serializeAttachment(s);
      }
    }
    (room as unknown as { states: WeakMap<object, unknown> }).states = new WeakMap();
  });

describe("doc socket: answers carry the frame's id as re", () => {
  it("lease: leased with re to the requester only; a denial with re", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 11 });
    expect(await nextWhere(a, "leased", mine(a))).toMatchObject({ re: 11 });
    const seen = await nextWhere(b, "leased");
    expect(seen).not.toHaveProperty("re");
    b.send({ t: "lease", rev: 0, start: 0, end: 1, id: 12 });
    expect(await b.nextOf("lease_denied")).toEqual({
      t: "lease_denied",
      reason: "held",
      by: ownerP.email,
      re: 12,
    });
    b.send({ t: "lease", rev: 9, start: 2, end: 3, id: 13 });
    expect(await b.nextOf("lease_denied")).toEqual({ t: "lease_denied", reason: "stale", re: 13 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("edit: its op with re to the sender only; not_held and a watcher's denial with re", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    a.send({ t: "edit", lease: l.lease, seq: 1, text: "# Renamed", id: 2 });
    expect(await a.nextOf("op")).toMatchObject({ seq: 1, re: 2 });
    expect(await b.nextOf("op")).not.toHaveProperty("re");
    b.send({ t: "edit", lease: l.lease, seq: 1, text: "x", id: 3 });
    expect(await b.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 3 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("release: released with re to its sender only; not_held with re", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    a.send({ t: "release", lease: l.lease, id: 2 });
    expect(await a.nextOf("released")).toEqual({ t: "released", lease: l.lease, re: 2 });
    expect(await nextWhere(b, "released", (f) => f.lease === l.lease)).toEqual({
      t: "released",
      lease: l.lease,
    });
    a.send({ t: "release", lease: l.lease, id: 3 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 3 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("keep: kept with re; not_held with re", async () => {
    const { id, ownerP } = await docSetup();
    const a = await connectDoc(id, ownerP.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    a.send({ t: "keep", lease: l.lease, id: 2 });
    expect(await a.nextOf("kept")).toEqual({ t: "kept", lease: l.lease, re: 2 });
    a.send({ t: "keep", lease: "l_nothere", id: 3 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 3 });
    a.ws.close(1000);
  });

  it("takeover: held and not_held with re; the new lease with re, and the old holder's frames with none", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    b.send({ t: "takeover", lease: l.lease, id: 5 });
    expect(await b.nextOf("lease_denied")).toEqual({
      t: "lease_denied",
      reason: "held",
      by: ownerP.email,
      re: 5,
    });
    b.send({ t: "takeover", lease: "l_gone", id: 6 });
    expect(await b.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 6 });
    await age(id);
    b.send({ t: "takeover", lease: l.lease, id: 7 });
    expect(await nextWhere(b, "leased", mine(b))).toMatchObject({ re: 7 });
    expect(await a.nextOf("lease_lost")).not.toHaveProperty("re");
    // The holder's own pending release of that lease is answered not_held, by its re; the
    // released the takeover caused carries none.
    a.send({ t: "release", lease: l.lease, id: 8 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_held", re: 8 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("sync: the welcome that answers it carries re", async () => {
    const { id, ownerP } = await docSetup();
    const a = await connectDoc(id, ownerP.cookie);
    a.send({ t: "sync", id: 21 });
    expect(await a.nextOf("welcome")).toMatchObject({ t: "welcome", re: 21 });
    a.ws.close(1000);
  });

  it("a frame that does not parse is refused with re when its id can be read", async () => {
    const { id, ownerP } = await docSetup();
    const a = await connectDoc(id, ownerP.cookie);
    a.send({ t: "lease", rev: "nope", start: 0, end: 1, id: 31 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "invalid", re: 31 });
    a.send("{");
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "invalid" });
    a.ws.close(1000);
  });

  it("a frame with no id is answered as before, with no re", async () => {
    const { id, ownerP } = await docSetup();
    const a = await connectDoc(id, ownerP.cookie);
    a.send({ t: "lease", rev: 0, start: 0, end: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    expect(l).not.toHaveProperty("re");
    a.send({ t: "edit", lease: l.lease, seq: 1, text: "# A" });
    expect(await a.nextOf("op")).not.toHaveProperty("re");
    a.send({ t: "keep", lease: "l_nothere" });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "not_held" });
    a.ws.close(1000);
  });

  it("draft_limit after a flush answers no frame: no re, though the release that led to it had one", async () => {
    const owner = await createUser();
    const t = await createToken(owner.id);
    const auth = { Authorization: `Bearer ${t.token}` };
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.maxLiveDraftsPerOwner + 1; i++) {
      const { body } = await publish(auth, { ...docBody(`# Doc ${i}\n`), visibility: "allowlist" });
      ids.push(body.id as string);
    }
    const now = new Date().toISOString();
    for (const other of ids.slice(1)) {
      await env.DB.prepare(
        `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, created_at, updated_at)
         VALUES (?1, 1, 'x', 1, 1, ?2, ?2)`,
      )
        .bind(other, now)
        .run();
    }
    const id = ids[0] as string;
    const session = await browserSession(owner.id);
    const a = await connectDoc(id, await cookieFor(id, session.headers));
    a.send({ t: "lease", rev: 0, start: 0, end: 1, id: 1 });
    const l = await nextWhere(a, "leased", mine(a));
    a.send({ t: "edit", lease: l.lease, seq: 1, text: "# Edited", id: 2 });
    await a.nextOf("op");
    a.send({ t: "release", lease: l.lease, id: 3 });
    expect(await a.nextOf("released")).toMatchObject({ re: 3 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "draft_limit" });
    a.ws.close(1000);
  });
});

describe("sheet socket: struct answers carry re", () => {
  const HEADER =
    '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"}]}';
  const SHEET = [HEADER, '["Apples",3]', '["Pears",5]'].join("\n");

  it("struct: its broadcast with re to the sender only; struct_denied and an invalid op with re", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    a.send({ t: "struct", rev: 0, op: { op: "delete_rows", from: 2, count: 1 }, id: 41 });
    const own = await nextWhere(a, "struct", (f) => f.by === a.welcome.you.id);
    expect(own).toMatchObject({ rev: 1, re: 41 });
    expect(await b.nextOf("struct")).not.toHaveProperty("re");
    a.send({ t: "struct", rev: 0, op: { op: "delete_rows", from: 2, count: 1 }, id: 42 });
    expect(await a.nextOf("struct_denied")).toEqual({
      t: "struct_denied",
      reason: "stale",
      re: 42,
    });
    // A design system's op on a sheet: not a kind the type takes.
    a.send({ t: "struct", rev: 1, op: { op: "clear_dark", token: "color.bg" }, id: 43 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "invalid", re: 43 });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("an edit the sheet's rules refuse answers invalid with re", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const a = await connectDoc(id, ownerP.cookie);
    a.send({ t: "lease", rev: 0, start: 1, end: 2, id: 51 });
    const l = await nextWhere(a, "leased", mine(a));
    expect(l).toMatchObject({ re: 51 });
    a.send({ t: "edit", lease: l.lease, seq: 1, text: "not a row", id: 52 });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "invalid", re: 52 });
    a.ws.close(1000);
  });
});
