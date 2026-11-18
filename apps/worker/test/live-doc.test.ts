// On-page doc editing in the room (#36, docs/spec.md "Editing"): the doc socket of ArtifactRoom
// with real sockets through the upgrade gate. Welcome and chunked text, enforced leases, edits and
// their acks, lease shifting, takeover, watch versus write, the size caps, the guarded D1 flush
// and the gen resync after the room loses its memory.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS, LIVE_DOC } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { browserSession, createToken, createUser, publish, uniqueEmail } from "./helpers.ts";
import {
  type Client,
  connectDoc,
  cookieFor,
  docBody,
  docSetup,
  type Frame,
  grant,
  person,
  sealedCookie,
  within,
} from "./room-helpers.ts";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

async function draft(id: string) {
  return env.DB.prepare("SELECT * FROM live_drafts WHERE artifact_id = ?1").bind(id).first<{
    content: string;
    rev: number;
    base_version: number;
    updated_by_user: string | null;
  }>();
}

/** Take a lease and wait for this socket's own `leased`. */
async function lease(c: Client & { welcome: Frame }, start: number, end: number, rev = 0) {
  c.send({ t: "lease", rev, start, end });
  for (;;) {
    const f = await c.next();
    if (f.t === "lease_denied") return f;
    if (f.t === "leased" && f.holder === c.welcome.you.id) return f;
  }
}

/** Send an edit and wait for its ack (the op carrying this socket's id). */
async function edit(c: Client & { welcome: Frame }, leaseId: string, text: string, seq = 1) {
  c.send({ t: "edit", lease: leaseId, seq, text });
  for (;;) {
    const f = await c.next();
    if (f.t === "error") return f;
    if (f.t === "op" && f.by === c.welcome.you.id) return f;
  }
}

/** Release a lease and wait until the draft is written. */
async function releaseAndFlush(c: Client, leaseId: string) {
  c.send({ t: "release", lease: leaseId });
  return c.nextOf("flushed");
}

describe("doc socket: welcome", () => {
  it("sends the draft after welcome, in text frames of at most 256 KiB", async () => {
    const para = `${"word ".repeat(150)}\n\n`;
    const content = `# Long\n\n${para.repeat(800)}`;
    expect(content.length).toBeGreaterThan(LIVE_DOC.textChunkBytes * 2);
    const { id, ownerP } = await docSetup(content);
    const a = await connectDoc(id, ownerP.cookie);
    expect(a.welcome).toMatchObject({
      t: "welcome",
      v: 1,
      you: { email: ownerP.email, right: "write" },
      rev: 0,
      base_version: 1,
      flushed_rev: 0,
      conflict_version: null,
      last_by_you: false,
      leases: [],
      peers: [],
    });
    expect(a.text).toBe(content);
    a.ws.close(1000);
  });

  it("is for owners and editors; an editor confirmed by code watches and cannot lease", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const e = await connectDoc(id, ed.cookie);
    expect(e.welcome.you.right).toBe("write");
    const coded = uniqueEmail("coded");
    await grant(id, coded, "editor");
    const w = await connectDoc(id, await sealedCookie(id, coded, "editor", false));
    expect(w.welcome.you).toMatchObject({ email: coded, right: "watch" });
    expect(await lease(w, 0, 1)).toEqual({ t: "lease_denied", reason: "watch" });
    w.send({ t: "edit", lease: "l_x", seq: 1, text: "x" });
    expect(await w.nextOf("lease_denied")).toEqual({ t: "lease_denied", reason: "watch" });
    // The watcher sees the others' edits.
    const o = await connectDoc(id, ownerP.cookie);
    const l = await lease(o, 0, 1);
    await edit(o, l.lease, "# Renamed");
    const op = await w.nextOf("op");
    expect(op).toMatchObject({ rev: 1, start: 0, del: 1, ins: "# Renamed", by: o.welcome.you.id });
    for (const c of [e, w, o]) c.ws.close(1000);
  });
});

describe("doc socket: leases and edits", () => {
  it("leases are exclusive; a stale rev is refused and a retry at the current rev works", async () => {
    const { id, ownerP } = await docSetup("# Plan\n\nFirst.\n\nSecond.\n");
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    const la = await lease(a, 2, 3);
    expect(la).toMatchObject({ t: "leased", start: 2, end: 3, by: ownerP.email });
    // B sees A's lease.
    expect(await b.nextOf("leased")).toMatchObject({ lease: la.lease, holder: a.welcome.you.id });
    expect(await lease(b, 2, 3)).toEqual({ t: "lease_denied", reason: "held", by: ownerP.email });
    // An insert point strictly inside a held range collides; one at its edge does not.
    expect((await lease(b, 3, 3)).t).toBe("leased");
    await edit(a, la.lease, "First, edited.");
    expect(await lease(b, 0, 1, 0)).toEqual({ t: "lease_denied", reason: "stale" });
    expect((await lease(b, 0, 1, 1)).t).toBe("leased");
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("an edit replaces the leased range, is acked to its sender, broadcast, and shifts the other leases", async () => {
    const { id, ownerP } = await docSetup("# Plan\n\nFirst.\n\nSecond.\n");
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    const la = await lease(a, 2, 3);
    const lb = await lease(b, 4, 5);
    expect(lb.t).toBe("leased");
    // Two lines in place of one: B's block moves down a line.
    const ack = await edit(a, la.lease, "First.\nMore.", 7);
    expect(ack).toMatchObject({ t: "op", rev: 1, start: 2, del: 1, ins: "First.\nMore.", seq: 7 });
    const seen = await b.nextOf("op");
    expect(seen).toMatchObject({ rev: 1, by: a.welcome.you.id, gen: a.welcome.gen });
    // B's lease now covers line 5 ("Second."), so its edit replaces exactly that.
    await edit(b, lb.lease, "Second, edited.");
    await a.nextOf("op");
    const peek = await stubFor(id).docPeek(id);
    expect(peek?.text).toBe("# Plan\n\nFirst.\nMore.\n\nSecond, edited.\n");
    expect(peek?.rev).toBe(2);
    // Clearing a block leaves an insert point; the text loses its lines.
    await edit(a, la.lease, "");
    expect((await stubFor(id).docPeek(id))?.text).toBe("# Plan\n\n\nSecond, edited.\n");
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("only the holder edits a lease; release ends it for everyone", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    const la = await lease(a, 0, 1);
    b.send({ t: "edit", lease: la.lease, seq: 1, text: "# Hijack" });
    expect(await b.nextOf("error")).toEqual({ t: "error", code: "not_held" });
    a.send({ t: "release", lease: la.lease });
    expect(await b.nextOf("released")).toEqual({ t: "released", lease: la.lease });
    expect((await lease(b, 0, 1)).t).toBe("leased");
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("take over only after the holder has been idle for 60 s", async () => {
    const { id, ownerP } = await docSetup();
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    const la = await lease(a, 0, 1);
    b.send({ t: "takeover", lease: la.lease });
    expect(await b.nextOf("lease_denied")).toEqual({
      t: "lease_denied",
      reason: "held",
      by: ownerP.email,
    });
    // Age the holder's lease past the idle time, as if a minute went by.
    await runInDurableObject(stubFor(id), async (_room, state) => {
      for (const ws of state.getWebSockets("k:doc")) {
        const s = ws.deserializeAttachment() as { lease?: { at: number } | null };
        if (s.lease) {
          s.lease.at -= (LIMITS.liveLeaseIdleS + 1) * 1000;
          ws.serializeAttachment(s);
        }
      }
      (_room as any).states = new WeakMap();
    });
    b.send({ t: "takeover", lease: la.lease });
    expect(await a.nextOf("lease_lost")).toEqual({
      t: "lease_lost",
      lease: la.lease,
      reason: "takeover",
    });
    const taken = await b.nextOf("leased");
    expect(taken).toMatchObject({ start: 0, end: 1, holder: b.welcome.you.id, by: ed.email });
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("refuses an edit past 1 MB or 50,000 lines and keeps the draft as it was", async () => {
    // Lines: one frame cannot carry 50,000 newlines (JSON doubles them), so the doc has most.
    const tall = `# Tall\n${"a\n".repeat(LIMITS.maxLiveDocLines - 20_000)}`;
    const { id, ownerP } = await docSetup(tall);
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    expect(await edit(a, l.lease, "\n".repeat(20_001))).toEqual({
      t: "error",
      code: "too_large",
    });
    expect((await stubFor(id).docPeek(id))?.text).toBe(tall);
    a.ws.close(1000);

    const big = `# Big\n\n${"x".repeat(LIMITS.maxDocBytes - 40_000)}\n`;
    const { id: id2, ownerP: o2 } = await docSetup(big);
    const b = await connectDoc(id2, o2.cookie);
    const l2 = await lease(b, 0, 1);
    expect(await edit(b, l2.lease, `# Big ${"y".repeat(60_000)}`)).toEqual({
      t: "error",
      code: "too_large",
    });
    // A frame over the doc frame limit closes the socket.
    b.send({ t: "edit", lease: l2.lease, seq: 2, text: "z".repeat(LIMITS.liveDocFrameBytes) });
    expect(await within(b.closed)).toMatchObject({ code: 1009 });
  });
});

describe("doc socket: the D1 flush", () => {
  it("writes the draft on release, with its base and author, and deletes it when it is back to its base", async () => {
    const { id, ownerP } = await docSetup("# Plan\n");
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    await edit(a, l.lease, "# Plan, edited");
    expect(await releaseAndFlush(a, l.lease)).toEqual({ t: "flushed", rev: 1 });
    expect(await draft(id)).toMatchObject({
      content: "# Plan, edited\n",
      rev: 1,
      base_version: 1,
      updated_by_user: ownerP.userId,
    });
    const l2 = await lease(a, 0, 1, 1);
    await edit(a, l2.lease, "# Plan");
    await releaseAndFlush(a, l2.lease);
    expect(await draft(id)).toBeNull();
    a.ws.close(1000);
  });

  it("never moves rev backwards, and never writes for a deleted or taken-down artifact", async () => {
    const { id, ownerP } = await docSetup("# Plan\n");
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    await edit(a, l.lease, "# One");
    await releaseAndFlush(a, l.lease);
    await env.DB.prepare("UPDATE live_drafts SET rev = 100 WHERE artifact_id = ?1").bind(id).run();
    const l2 = await lease(a, 0, 1, 1);
    await edit(a, l2.lease, "# Two");
    a.send({ t: "release", lease: l2.lease });
    await a.nextOf("released");
    await stubFor(id).docSnapshot(id);
    expect(await draft(id)).toMatchObject({ content: "# One\n", rev: 100 });
    a.ws.close(1000);

    // Taken down in SQL (no notify): the flush is refused and the room closes its sockets.
    const { id: id2, ownerP: o2 } = await docSetup("# Plan\n");
    const b = await connectDoc(id2, o2.cookie);
    const lb = await lease(b, 0, 1);
    await edit(b, lb.lease, "# Edited");
    await env.DB.prepare("UPDATE artifacts SET taken_down_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), id2)
      .run();
    b.send({ t: "release", lease: lb.lease });
    expect(await within(b.closed)).toMatchObject({ code: 4404 });
    expect(await draft(id2)).toBeNull();

    // Deleted in SQL: the same.
    const { id: id3, ownerP: o3 } = await docSetup("# Plan\n");
    const c = await connectDoc(id3, o3.cookie);
    const lc = await lease(c, 0, 1);
    await edit(c, lc.lease, "# Edited");
    await env.DB.prepare("UPDATE artifacts SET deleted_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), id3)
      .run();
    c.send({ t: "release", lease: lc.lease });
    expect(await within(c.closed)).toMatchObject({ code: 4404 });
    expect(await draft(id3)).toBeNull();
  });

  it("keeps at most 20 drafts per owner and says draft_limit", async () => {
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
    const l = await lease(a, 0, 1);
    await edit(a, l.lease, "# Edited");
    a.send({ t: "release", lease: l.lease });
    expect(await a.nextOf("error")).toEqual({ t: "error", code: "draft_limit" });
    expect(await draft(id)).toBeNull();
    // An existing draft keeps being written at the limit.
    await env.DB.prepare("DELETE FROM live_drafts WHERE artifact_id = ?1")
      .bind(ids[1] as string)
      .run();
    const l2 = await lease(a, 0, 1, 1);
    await edit(a, l2.lease, "# Edited twice");
    await releaseAndFlush(a, l2.lease);
    await env.DB.prepare(
      `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev, created_at, updated_at)
       VALUES (?1, 1, 'x', 1, 1, ?2, ?2)`,
    )
      .bind(ids[1] as string, now)
      .run();
    const l3 = await lease(a, 0, 1, 2);
    await edit(a, l3.lease, "# Edited thrice");
    await releaseAndFlush(a, l3.lease);
    expect((await draft(id))?.content).toBe("# Edited thrice\n");
    a.ws.close(1000);
  });

  it("after the room loses its memory, a new gen: clients resync and get the flushed draft", async () => {
    const { id, ownerP } = await docSetup("# Plan\n");
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    await edit(a, l.lease, "# Flushed");
    await releaseAndFlush(a, l.lease);
    // As after an eviction or a hibernation wake: the in-memory draft is gone.
    await runInDurableObject(stubFor(id), async (room) => {
      (room as any).doc.loaded = null;
    });
    const ed = await person(id, "editor");
    const b = await connectDoc(id, ed.cookie);
    expect(b.welcome.gen).not.toBe(a.welcome.gen);
    expect(b.welcome.rev).toBe(1);
    expect(b.text).toBe("# Flushed\n");
    // A sees an op of another gen, so it asks for the draft again.
    const lb = await lease(b, 0, 1, 1);
    await edit(b, lb.lease, "# Again");
    const op = await a.nextOf("op");
    expect(op.gen).not.toBe(a.welcome.gen);
    a.send({ t: "sync" });
    const again = await a.nextOf("welcome");
    expect(again.gen).toBe(b.welcome.gen);
    expect(again.rev).toBe(2);
    a.ws.close(1000);
    b.ws.close(1000);
  });
});
