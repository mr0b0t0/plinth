// On-page editing of a sheet in the room (#36, docs/spec.md "Editing"): the same draft channel as
// docs, with the sheet's rules. A row lease and its edit; a row line the sheet cannot hold (or not
// in its canonical spelling) refused with `invalid` and not applied; a header that keeps its
// columns; struct frames applied once and the same on every socket, refused while someone else
// holds a lease; a version published meanwhile (edit_sheet, PUT, a restore) never merged: the
// draft freezes, and the review's two choices publish it as it is or discard it, each under the
// room's checkpoint lock, so the two never interleave.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applySheetStruct, splitLines } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { APP, json, versionRow } from "./helpers.ts";
import {
  type Client,
  connectDoc,
  type Frame,
  grant,
  person,
  readText,
  run,
  sealedCookie,
  sheetSetup,
} from "./room-helpers.ts";

const rooms = () => {
  const ns = env.ROOMS;
  if (!ns) throw new Error("no ROOMS binding");
  return ns;
};
const stubFor = (id: string) => rooms().get(rooms().idFromName(id));

const HEADER =
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"},{"name":"Paid","type":"checkbox"}]}';
const SHEET = [
  HEADER,
  '["Apples",3,true]',
  '["Pears",5]',
  '["Plums"]',
  '["Total","=SUM(B2:B4)"]',
].join("\n");

type Socket = Client & { welcome: Frame; text: string };

async function lease(c: Socket, start: number, end: number, rev = 0) {
  c.send({ t: "lease", rev, start, end });
  for (;;) {
    const f = await c.next();
    if (f.t === "lease_denied") return f;
    if (f.t === "leased" && f.holder === c.welcome.you.id) return f;
  }
}

/** Send an edit: its ack (the op with this socket's id), or the error the room answered. */
async function edit(c: Socket, leaseId: string, text: string, seq = 1) {
  c.send({ t: "edit", lease: leaseId, seq, text });
  for (;;) {
    const f = await c.next();
    if (f.t === "error") return f;
    if (f.t === "op" && f.by === c.welcome.you.id) return f;
  }
}

/** Send a struct: the room's broadcast of it (this socket's own), or its refusal. */
async function struct(c: Socket, op: Record<string, unknown>, rev: number) {
  c.send({ t: "struct", rev, op });
  for (;;) {
    const f = await c.next();
    if (f.t === "error" || f.t === "struct_denied") return f;
    if (f.t === "struct" && f.by === c.welcome.you.id) return f;
  }
}

async function editRow(c: Socket, line: number, text: string, rev: number) {
  const l = await lease(c, line, line + 1, rev);
  if (l.t !== "leased") throw new Error(`lease ${l.t}`);
  const ack = await edit(c, l.lease, text);
  if (ack.t !== "op") throw new Error(`edit ${ack.code}`);
  c.send({ t: "release", lease: l.lease });
  await c.nextOf("flushed");
  return ack.rev as number;
}

const peek = async (id: string) => (await stubFor(id).docPeek(id))?.text;

/** The draft's D1 row (null when there is none). */
const liveRow = (id: string) =>
  env.DB.prepare("SELECT base_version, content, rev FROM live_drafts WHERE artifact_id = ?1")
    .bind(id)
    .first<{ base_version: number; content: string; rev: number }>();

/** The room's checkpoint lock and the snapshots it still holds as being saved. */
const pending = (id: string) =>
  runInDurableObject(stubFor(id), async (room) => {
    const doc = (room as unknown as { doc: { lock: { id: string } | null; saving: unknown[] } })
      .doc;
    return { lock: doc.lock?.id ?? null, saving: doc.saving.length };
  });

describe("sheet socket: rows", () => {
  it("sends the sheet's canonical lines; a row lease and a valid row edit are applied and broadcast", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    expect(a.text).toBe(SHEET);
    expect(a.welcome.you.right).toBe("write");
    const l = await lease(a, 2, 3);
    expect(l).toMatchObject({ t: "leased", start: 2, end: 3 });
    expect(await lease(b, 2, 3)).toEqual({ t: "lease_denied", reason: "held", by: ownerP.email });
    const ack = await edit(a, l.lease, '["Pears",6,false]');
    expect(ack).toMatchObject({ t: "op", rev: 1, start: 2, del: 1, ins: '["Pears",6,false]' });
    expect(await b.nextOf("op")).toMatchObject({ rev: 1, ins: '["Pears",6,false]' });
    expect(await peek(id)).toBe(SHEET.replace('["Pears",5]', '["Pears",6,false]'));
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("refuses a row line the sheet cannot hold, or in another spelling, and applies nothing", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 1, 2);
    for (const bad of [
      '["Apples","three",true]',
      '["Apples",3,true,"extra"]',
      '["Apples",3,"yes"]',
      '["Apples",3,true,null]',
      '[ "Apples",3,true]',
      '["=HYPERLINK(\\"https://x.example\\")"]',
      '["Apples"]\n',
      "not json",
      '{"a":1}',
    ]) {
      expect(await edit(a, l.lease, bad), bad).toEqual({ t: "error", code: "invalid" });
    }
    expect(await peek(id)).toBe(SHEET);
    // Rows go in and out through edits too: two rows for one, and none.
    const two = await edit(a, l.lease, '["Apples",3,true]\n["Figs",1]', 2);
    expect(two).toMatchObject({ t: "op", rev: 1, del: 1 });
    expect(splitLines((await peek(id)) as string)).toHaveLength(6);
    a.ws.close(1000);
  });

  it("the header keeps its columns: a rename is applied, another column count is refused", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const a = await connectDoc(id, ownerP.cookie);
    const l = await lease(a, 0, 1);
    const fewer =
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"}]}';
    expect(await edit(a, l.lease, fewer)).toEqual({ t: "error", code: "invalid" });
    // Qty as a checkbox: its numbers no longer fit, so every row is checked and it is refused.
    const typed = HEADER.replace(
      '{"name":"Qty","type":"number"}',
      '{"name":"Qty","type":"checkbox"}',
    );
    expect(await edit(a, l.lease, typed)).toEqual({ t: "error", code: "invalid" });
    const renamed = HEADER.replace('"Item"', '"Fruit"');
    expect(await edit(a, l.lease, renamed)).toMatchObject({ t: "op", rev: 1 });
    expect((await peek(id))?.split("\n")[0]).toBe(renamed);
    // Nothing goes above the header.
    a.send({ t: "release", lease: l.lease });
    const top = await lease(a, 0, 0, 1);
    expect(await edit(a, top.lease, '["x"]')).toEqual({ t: "error", code: "invalid" });
    a.ws.close(1000);
  });
});

describe("sheet socket: rows and columns (struct)", () => {
  it("is applied once, broadcast as sent, and gives every socket the same lines", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    // The sender's own lease ends first.
    const mine = await lease(a, 1, 2);
    expect((await b.nextOf("leased")).lease).toBe(mine.lease);
    const op = { op: "insert_rows", before: 3, count: 2 };
    const done = await struct(a, op, 0);
    expect(done).toEqual({ t: "struct", gen: a.welcome.gen, rev: 1, op, by: a.welcome.you.id });
    expect(await b.nextOf("released")).toEqual({ t: "released", lease: mine.lease });
    const seen = await b.nextOf("struct");
    expect(seen.op).toEqual(op);
    const expected = applySheetStruct(splitLines(SHEET), op as never)?.join("\n");
    expect(await peek(id)).toBe(expected);
    expect(expected).toContain('["Total","=SUM(B2:B6)"]');
    // Columns too.
    const col = { op: "insert_columns", before: "B", columns: [{ name: "Note", type: "text" }] };
    expect(await struct(b, col, 1)).toMatchObject({ t: "struct", rev: 2 });
    expect((await peek(id))?.split("\n")[1]).toBe('["Apples",null,3,true]');
    const del = { op: "delete_columns", from: "B", count: 1 };
    expect(await struct(a, del, 2)).toMatchObject({ t: "struct", rev: 3 });
    expect(await peek(id)).toBe(expected);
    a.ws.close(1000);
    b.ws.close(1000);
  });

  it("is refused while someone else holds a lease, at a stale rev, for a watcher, and when it does not apply", async () => {
    const { id, ownerP } = await sheetSetup(SHEET);
    const ed = await person(id, "editor");
    const a = await connectDoc(id, ownerP.cookie);
    const b = await connectDoc(id, ed.cookie);
    const held = await lease(b, 3, 4);
    expect(held.t).toBe("leased");
    const op = { op: "delete_rows", from: 2, count: 1 };
    expect(await struct(a, op, 0)).toEqual({ t: "struct_denied", reason: "held", by: ed.email });
    b.send({ t: "release", lease: held.lease });
    await a.nextOf("released");
    expect(await struct(a, op, 7)).toEqual({ t: "struct_denied", reason: "stale" });
    expect(await struct(a, { op: "delete_rows", from: 9, count: 1 }, 0)).toEqual({
      t: "error",
      code: "invalid",
    });
    expect(await struct(a, { op: "delete_columns", from: "A", count: 3 }, 0)).toEqual({
      t: "error",
      code: "invalid",
    });
    const coded = `coded-${crypto.randomUUID()}@example.org`;
    await grant(id, coded, "editor");
    const w = await connectDoc(id, await sealedCookie(id, coded, "editor", false));
    expect(await struct(w, op, 0)).toEqual({ t: "struct_denied", reason: "watch" });
    expect(await peek(id)).toBe(SHEET);
    for (const c of [a, b, w]) c.ws.close(1000);
  });
});

describe("sheet socket: versions published from outside", () => {
  // A sheet's draft is never merged with a version published meanwhile (an agent, the CLI, REST
  // or a restore): it freezes, and the editors publish it as it is or discard it.
  const call = (
    id: string,
    headers: Record<string, string>,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    run(`${APP}/api/v1/artifacts/${id}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...headers,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const editSheet = (id: string, auth: Record<string, string>, body: Record<string, unknown>) =>
    call(id, auth, "/sheet/edits", { body });
  const checkpoint = (id: string, headers: Record<string, string>, body: Record<string, unknown>) =>
    call(id, headers, "/live/checkpoint", { body });
  const content = async (id: string, auth: Record<string, string>, n: number) =>
    (await json(await call(id, auth, `/versions/${n}`))).content as string;
  const V2 = SHEET.replace('["Pears",5]', '["Pears",7]');

  /** The page edits row 1 (Apples) to `rowEdit`; an agent sets B3 with edit_sheet: frozen at v2. */
  async function frozen(rowEdit: string) {
    const s = await sheetSetup(SHEET);
    const a = await connectDoc(s.id, s.ownerP.cookie);
    await editRow(a, 1, rowEdit, 0);
    const res = await editSheet(s.id, s.owner.auth, {
      base_version: 1,
      ops: [{ op: "set", at: "B3", values: [[7]] }],
    });
    expect(res.status).toBe(201);
    expect((await json(res)).warnings).toContainEqual(
      expect.objectContaining({
        code: "live_draft",
        file: "sheet.jsonl",
        message: expect.stringContaining("choose to publish them in its place or discard them"),
      }),
    );
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    return { ...s, a, draft: SHEET.replace('["Apples",3,true]', rowEdit) };
  }

  it("an agent's edit_sheet on other rows during a live edit freezes the draft; nothing is merged", async () => {
    const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 1,
      conflict_version: 2,
      text: draft,
    });
    expect(await content(id, owner.auth, 2)).toBe(V2);
    // Editing stops until a choice: no lease, no struct, and no ordinary save.
    expect(await lease(a, 2, 3, 1)).toEqual({ t: "lease_denied", reason: "frozen" });
    expect(await struct(a, { op: "insert_rows", before: 2, count: 1 }, 1)).toEqual({
      t: "struct_denied",
      reason: "frozen",
    });
    const h = ownerP.session.headers;
    const refused = await checkpoint(id, h, { base_version: 1, rev: 1, reason: "save" });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({
      message: "v2 was published while you edited. Review it.",
      details: { reason: "live_conflict", current_version: 2 },
    });
    // The review reads the whole draft.
    expect(await json(await call(id, h, "/live/draft"))).toEqual({
      text: draft,
      base_version: 1,
      rev: 1,
      conflict_version: 2,
    });
    a.ws.close(1000);
  });

  it("the reviewers' cases are frozen too: rows moved in a run of blank rows, or a row inserted while the other side edits", async () => {
    // Blank rows above a total. The page deletes a blank row and inserts one before the total
    // (the row count stays the same); the agent fills a blank row meanwhile.
    const blank = [HEADER, '["Apples",3,true]', "[]", "[]", "[]", '["Total","=B5"]'].join("\n");
    const one = await sheetSetup(blank);
    const a = await connectDoc(one.id, one.ownerP.cookie);
    expect(await struct(a, { op: "delete_rows", from: 3, count: 1 }, 0)).toMatchObject({ rev: 1 });
    expect(await struct(a, { op: "insert_rows", before: 5, count: 1 }, 1)).toMatchObject({
      rev: 2,
    });
    const res = await editSheet(one.id, one.owner.auth, {
      base_version: 1,
      ops: [{ op: "set", at: "A4", values: [["Pears", 5]] }],
    });
    expect(res.status).toBe(201);
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    a.ws.close(1000);

    // The page edits Plums while the agent inserts a row above Pears.
    const two = await sheetSetup(SHEET);
    const b = await connectDoc(two.id, two.ownerP.cookie);
    await editRow(b, 3, '["Plums",9]', 0);
    const res2 = await editSheet(two.id, two.owner.auth, {
      base_version: 1,
      ops: [{ op: "insert_rows", before: 3, count: 1 }],
    });
    expect(res2.status).toBe(201);
    expect(await b.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    b.ws.close(1000);

    // The mirror: the page inserts a row while the agent edits a cell far from it.
    const three = await sheetSetup(SHEET);
    const c = await connectDoc(three.id, three.ownerP.cookie);
    const insert = { op: "insert_rows", before: 2, count: 1 } as const;
    expect(await struct(c, insert, 0)).toMatchObject({ rev: 1 });
    const res3 = await editSheet(three.id, three.owner.auth, {
      base_version: 1,
      ops: [{ op: "set", at: "B4", values: [[1]] }],
    });
    expect(res3.status).toBe(201);
    expect(await c.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    expect(await peek(three.id)).toBe(applySheetStruct(splitLines(SHEET), insert)?.join("\n"));
    c.ws.close(1000);
  });

  it("Publish mine: the draft becomes v3 on top of v2, v2 stays in the history, and editing resumes", async () => {
    const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
    const saved = await checkpoint(id, ownerP.session.headers, {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: draft,
      conflict_version: 2,
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ saved: true, version: { version: 3 } });
    const v3 = await versionRow(id, 3);
    expect(v3?.note).toBe("Edited on the page. Replaces the changes in v2.");
    expect(await content(id, owner.auth, 3)).toBe(draft);
    expect(await content(id, owner.auth, 2)).toBe(V2);
    const reset = await a.nextOf("reset");
    expect(reset.version).toBe(3);
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 3,
      conflict_version: null,
    });
    // Editing resumes on v3.
    expect(await lease(a, 2, 3, reset.rev)).toMatchObject({ t: "leased" });
    a.ws.close(1000);

    // The editor's own note comes first.
    const b = await frozen('["Apples",5,true]');
    const noted = await checkpoint(b.id, b.ownerP.session.headers, {
      base_version: 1,
      rev: 1,
      reason: "save",
      note: "Counted again.",
      resolved_text: b.draft,
      conflict_version: 2,
    });
    expect(noted.status).toBe(200);
    expect((await versionRow(b.id, 3))?.note).toBe("Counted again. Replaces the changes in v2.");
    b.a.ws.close(1000);
  });

  it("Discard mine: the page goes back to v2 for everyone, and no version is written", async () => {
    const { id, ownerP, a } = await frozen('["Apples",4,true]');
    const res = await call(id, ownerP.session.headers, "/live/draft?rev=1", { method: "DELETE" });
    expect(res.status).toBe(204);
    const reset = await a.nextOf("reset");
    expect(reset.version).toBe(2);
    expect(await readText(a, reset.gen)).toBe(V2);
    expect(await versionRow(id, 3)).toBeNull();
    a.ws.close(1000);

    // Choosing v2's text in the review does the same.
    const b = await frozen('["Apples",4,true]');
    const took = await checkpoint(b.id, b.ownerP.session.headers, {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: V2,
      conflict_version: 2,
    });
    expect(await json(took)).toEqual({ saved: false, reason: "unchanged" });
    expect(await versionRow(b.id, 3)).toBeNull();
    expect(await stubFor(b.id).docPeek(b.id)).toMatchObject({ base_version: 2, text: V2 });
    b.a.ws.close(1000);
  });

  it("nothing in between is saved, nor a draft other than the one reviewed: the draft stays frozen", async () => {
    const { id, ownerP, a, draft } = await frozen('["Apples",4,true]');
    const h = ownerP.session.headers;
    // The two combined, as a line merge would have saved them.
    const mixed = await checkpoint(id, h, {
      base_version: 1,
      rev: 1,
      reason: "save",
      resolved_text: draft.replace('["Pears",5]', '["Pears",7]'),
      conflict_version: 2,
    });
    expect(mixed.status).toBe(400);
    expect((await json(mixed)).error.details.reason).toBe("not_a_choice");
    // A review of another revision of the draft is sent back to review.
    const stale = await checkpoint(id, h, {
      base_version: 1,
      rev: 0,
      reason: "save",
      resolved_text: draft,
      conflict_version: 2,
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.details.reason).toBe("live_conflict");
    expect(await versionRow(id, 3)).toBeNull();
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 1,
      conflict_version: 2,
      text: draft,
    });
    a.ws.close(1000);
  });

  it("a version equal to the draft ends it, and one equal to its base needs no review", async () => {
    // The agent publishes exactly the page edits: nothing is unpublished any more.
    const s = await sheetSetup(SHEET);
    const a = await connectDoc(s.id, s.ownerP.cookie);
    const draft = SHEET.replace('["Apples",3,true]', '["Apples",4,true]');
    await editRow(a, 1, '["Apples",4,true]', 0);
    const res = await call(s.id, s.owner.auth, "", {
      method: "PUT",
      body: { content: draft, base_version: 1 },
    });
    expect(res.status).toBe(200);
    expect((await a.nextOf("rebased")).version).toBe(2);
    expect(await stubFor(s.id).docPeek(s.id)).toMatchObject({
      base_version: 2,
      conflict_version: null,
      text: draft,
    });
    a.ws.close(1000);

    // Frozen against v2, then v1 is restored as v3: v3 is the draft's base, so the draft is whole
    // on top of it and editing resumes, its lines as they were.
    const f = await frozen('["Apples",4,true]');
    const restored = await call(f.id, f.owner.auth, "/versions/1/restore", { body: {} });
    expect(restored.status).toBe(201);
    const back = await f.a.nextOf("rebased");
    expect(back.version).toBe(3);
    expect(await readText(f.a, back.gen)).toBe(f.draft);
    expect(await stubFor(f.id).docPeek(f.id)).toMatchObject({
      base_version: 3,
      conflict_version: null,
      text: f.draft,
    });
    f.a.ws.close(1000);
  });

  // Both choices, and the strip's "Discard unsaved changes" (DELETE live/draft), take the room's
  // checkpoint lock: one choice resolves a frozen draft, and never on top of the other.
  describe("the two choices against each other", () => {
    const discardAt = (id: string, h: Record<string, string>, rev: number) =>
      call(id, h, `/live/draft?rev=${rev}`, { method: "DELETE" });

    it("a discard while Publish mine is saving is busy, and the published draft stays clean", async () => {
      const { id, ownerP, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      // Publish mine has taken the lock and resolved to the draft; the stager is writing v3.
      const snap = await stub.docSnapshot(id);
      expect(snap).toMatchObject({ state: "conflict", rev: 1, conflict_version: 2 });
      expect(await stub.docResolve(snap.lock, draft)).toBe(true);
      const res = await discardAt(id, ownerP.session.headers, 1);
      expect(res.status).toBe(409);
      expect((await json(res)).error).toMatchObject({
        code: "conflict",
        details: { reason: "live_busy", rev: 1 },
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 1,
        conflict_version: 2,
        text: draft,
      });
      // v3 lands and its finish arrives before the version notify: the draft is v3, clean, so
      // no autosave can publish v2's text over it.
      expect(await stub.docFinish(id, 3, draft, snap.lock, snap.epoch)).toMatchObject({
        dirty: false,
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 3,
        conflict_version: null,
        text: draft,
      });
      expect((await a.nextOf("reset")).version).toBe(3);
      a.ws.close(1000);
    });

    it("a discard takes the lock before it reads: a save arriving meanwhile is busy", async () => {
      const { id, a } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      const [d, snap] = await Promise.all([stub.docDiscard(id, 1), stub.docSnapshot(id)]);
      expect(snap.state).toBe("busy");
      expect(d).toMatchObject({ ok: true });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: V2,
      });
      // The discard released its lock when it was done.
      expect((await stub.docSnapshot(id)).state).toBe("clean");
      a.ws.close(1000);
    });

    it("Publish mine while Discard mine holds the lock is busy; the discard resolves it once", async () => {
      const { id, ownerP, a, draft } = await frozen('["Apples",4,true]');
      const h = ownerP.session.headers;
      const stub = stubFor(id);
      const choose = (resolved_text: string) =>
        checkpoint(id, h, {
          base_version: 1,
          rev: 1,
          reason: "save",
          resolved_text,
          conflict_version: 2,
        });
      // Discard mine is a checkpoint too: its snapshot holds the lock.
      const snap = await stub.docSnapshot(id);
      expect(await json(await choose(draft))).toEqual({ saved: false, reason: "busy" });
      // Its discard runs under its own lock, and only for the version reviewed.
      expect(await stub.docDiscard(id, 1, { lock: snap.lock, conflictVersion: 1 })).toEqual({
        ok: false,
        rev: 1,
      });
      expect(await stub.docDiscard(id, 1, { lock: snap.lock, conflictVersion: 2 })).toMatchObject({
        ok: true,
      });
      expect((await a.nextOf("reset")).version).toBe(2);
      expect(await stub.docPeek(id)).toMatchObject({ base_version: 2, conflict_version: null });
      // The late Publish mine finds the draft clean, and no v3 is written.
      expect(await json(await choose(draft))).toEqual({ saved: false, reason: "clean" });
      expect(await versionRow(id, 3)).toBeNull();
      a.ws.close(1000);
    });

    it("both choices and the strip's discard sent at once: exactly one side wins, never a mix", async () => {
      for (let i = 0; i < 3; i++) {
        const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
        const h = ownerP.session.headers;
        const body = (resolved_text: string) => ({
          base_version: 1,
          rev: 1,
          reason: "save",
          resolved_text,
          conflict_version: 2,
        });
        const answers = await Promise.all([
          checkpoint(id, h, body(draft)),
          checkpoint(id, h, body(V2)),
          discardAt(id, h, 1),
        ]);
        for (const r of answers) expect(r.status).toBeLessThan(500);
        const peeked = await stubFor(id).docPeek(id);
        expect(peeked?.conflict_version).toBeNull();
        if (await versionRow(id, 3)) {
          // Published: the draft is v3, and clean.
          expect(await content(id, owner.auth, 3)).toBe(draft);
          expect(peeked).toMatchObject({ base_version: 3, text: draft });
        } else {
          // Discarded: the draft is v2, and clean.
          expect(peeked).toMatchObject({ base_version: 2, text: V2 });
        }
        expect(await versionRow(id, 4)).toBeNull();
        a.ws.close(1000);
      }
    });

    it("a save finishing after its lock ran out and a discard replaced the lines is not finished onto them", async () => {
      const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      const snap = await stub.docSnapshot(id);
      expect(await stub.docResolve(snap.lock, draft)).toBe(true);
      // The save stalls past the lock's 30 s, and a discard goes through meanwhile.
      await runInDurableObject(stub, async (room) => {
        (room as unknown as { doc: { lock: { until: number } } }).doc.lock.until = 0;
      });
      expect((await discardAt(id, ownerP.session.headers, 1)).status).toBe(204);
      expect((await a.nextOf("reset")).version).toBe(2);
      // The late finish (v3 not readable yet) leaves the discarded draft as it is, on base v2
      // and clean, instead of v2's lines on base v3, which the next autosave would publish.
      expect(await stub.docFinish(id, 3, draft, snap.lock, snap.epoch)).toEqual({
        rev: 2,
        dirty: false,
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: V2,
      });
      // v3 is then a version published meanwhile like any other: the clean draft moves onto it.
      const put = await call(id, owner.auth, "", {
        method: "PUT",
        body: { content: draft, base_version: 2 },
      });
      expect(put.status).toBe(200);
      expect((await a.nextOf("reset")).version).toBe(3);
      expect(await stubFor(id).docPeek(id)).toMatchObject({
        base_version: 3,
        conflict_version: null,
        text: draft,
      });
      a.ws.close(1000);
    });
  });

  // A save that outlives the room's 30 s checkpoint lock: its version and its finish come after
  // the lock ran out, and the rows edited meanwhile are never replaced by the saved snapshot.
  describe("a save that outlives its checkpoint lock", () => {
    // The lock runs out, in memory and in the room's stored record.
    const expire = (id: string) =>
      runInDurableObject(stubFor(id), async (room) => {
        const doc = (room as unknown as { doc: { lock: { until: number }; persist(): void } }).doc;
        doc.lock.until = 0;
        doc.persist();
      });
    /** The room's answer to a version notify: its own checkpoint saved, or a freeze. */
    const notified = async (c: Socket) => {
      for (;;) {
        const f = await c.next();
        if (f.t === "saved" || f.t === "conflict") return f;
      }
    };

    /** Apples edited and snapshotted; the lock runs out; Pears edited while the save runs. */
    async function slowSave() {
      const s = await sheetSetup(SHEET);
      const a = await connectDoc(s.id, s.ownerP.cookie);
      const rev = await editRow(a, 1, '["Apples",4,true]', 0);
      const stub = stubFor(s.id);
      const snap = await stub.docSnapshot(s.id);
      expect(snap).toMatchObject({ state: "ready", rev });
      await expire(s.id);
      const after = await editRow(a, 2, '["Pears",9]', rev);
      const later = snap.text.replace('["Pears",5]', '["Pears",9]');
      const put = () =>
        call(s.id, s.owner.auth, "", {
          method: "PUT",
          body: { content: snap.text, base_version: 1 },
        });
      return { ...s, a, stub, snap, after, later, put };
    }

    it("its own version, notified first, is still recognized, and the late finish keeps Pears", async () => {
      const { id, a, stub, snap, after, later, put } = await slowSave();
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: after });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      expect(await stub.docPeek(id)).toMatchObject({ base_version: 2, text: later });
      // Editing goes on, and the next save publishes the Pears edit on top of v2.
      expect(await lease(a, 2, 3, after)).toMatchObject({ t: "leased" });
      a.ws.close(1000);
    });

    it("its finish, arriving before the notify, keeps Pears too", async () => {
      const { id, a, stub, snap, after, later } = await slowSave();
      // The stager wrote v2 (no notify yet): the finish comes first, then the notify is a no-op.
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      expect((await a.nextOf("saved")).version).toBe(2);
      await stub.docVersion(id, 2, snap.hash);
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      a.ws.close(1000);
    });

    // An idle room is evicted while the stager writes (its sockets hibernate): the wake on the
    // version notify reloads the draft from D1 and the save's record from the room's storage.
    it("evicted while it saves, its own version is still recognized on the wake, and the finish keeps Pears", async () => {
      const { id, a, stub, snap, after, later, put } = await slowSave();
      // A second save took the lock and gave up: its record does not come back with the wake.
      const next = await stub.docSnapshot(id);
      await stub.docAbort(next.lock);
      await evictDurableObject(stub);
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: after });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      await evictDurableObject(stub);
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      // No lock came back with the wakes: the next save takes one.
      expect(await stub.docSnapshot(id)).toMatchObject({ state: "ready", text: later });
      a.ws.close(1000);
    });

    it("evicted while it saves, its finish arriving first on the wake keeps Pears, and the notify is a no-op", async () => {
      const { id, a, stub, snap, after, later } = await slowSave();
      await evictDurableObject(stub);
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      expect((await a.nextOf("saved")).version).toBe(2);
      await stub.docVersion(id, 2, snap.hash);
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      a.ws.close(1000);
    });

    it("with no record of it (a room that stored none), the freeze against its own version ends at the finish, Pears kept", async () => {
      const { id, a, stub, snap, after, later, put } = await slowSave();
      // As a room that ran code which stored nothing: the wake knows neither the save nor the epoch.
      await runInDurableObject(stub, async (_room, state) => {
        await state.storage.delete("live-doc");
      });
      await evictDurableObject(stub);
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "conflict", version: 2 });
      // v2 holds exactly the text the finish saved, and the draft is past its rev: editing goes
      // on from v2 with the Pears edit, so "Discard mine" is never offered against its own save.
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after + 1,
        dirty: true,
      });
      const rebased = await a.nextOf("rebased");
      expect(rebased).toMatchObject({ version: 2, rev: after + 1 });
      expect(await readText(a, rebased.gen)).toBe(later);
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      a.ws.close(1000);
    });

    it("a discard and an edit while it saves, then an eviction: the late finish is not finished onto those lines", async () => {
      const { id, owner, ownerP, a, stub, snap, after } = await slowSave();
      const res = await call(id, ownerP.session.headers, `/live/draft?rev=${after}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      const reset = await a.nextOf("reset");
      expect(reset.version).toBe(1);
      // Plums edited on v1's rows, then the room is evicted and woken, at base v1, before v2 lands.
      const plums = await editRow(a, 3, '["Plums",2]', reset.rev);
      const mine = SHEET.replace('["Plums"]', '["Plums",2]');
      await evictDurableObject(stub);
      expect(await stub.docPeek(id)).toMatchObject({ base_version: 1, rev: plums, text: mine });
      // v2 lands with no notify (rooms off for that request), then its finish.
      const put = await run(
        `${APP}/api/v1/artifacts/${id}`,
        {
          method: "PUT",
          headers: { ...owner.auth, "Content-Type": "application/json" },
          body: JSON.stringify({ content: snap.text, base_version: 1 }),
        },
        { ALLOW_ROOMS: "false" },
      );
      expect(put.status).toBe(200);
      // The discard's epoch came back with the wake, so v2 is a version published meanwhile and
      // the sheet is frozen for review, rather than v2 becoming the base under v1's rows.
      await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev);
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 1,
        conflict_version: 2,
        text: mine,
      });
      a.ws.close(1000);
    });

    it("a wake after the draft went back to its base never reuses a snapshot's rev: the finish keeps the edit made since", async () => {
      const { id, owner, a, stub, snap } = await (async () => {
        const s = await sheetSetup(SHEET);
        const a = await connectDoc(s.id, s.ownerP.cookie);
        const rev = await editRow(a, 1, '["Apples",4,true]', 0);
        const stub = stubFor(s.id);
        const snap = await stub.docSnapshot(s.id);
        await expire(s.id);
        // Apples put back: the draft is its base again, and its D1 row is deleted.
        await editRow(a, 1, '["Apples",3,true]', rev);
        return { ...s, a, stub, snap };
      })();
      await evictDurableObject(stub);
      const woke = await stub.docPeek(id);
      expect(woke).toMatchObject({ base_version: 1, text: SHEET });
      expect(woke?.rev).toBeGreaterThan(snap.rev);
      await editRow(a, 2, '["Pears",9]', woke?.rev ?? 0);
      const pears = SHEET.replace('["Pears",5]', '["Pears",9]');
      // The snapshot lands as v2 unnotified, and v3 on top of it is notified first: frozen.
      const write = (content: string, base: number, vars: Record<string, unknown> = {}) =>
        run(
          `${APP}/api/v1/artifacts/${id}`,
          {
            method: "PUT",
            headers: { ...owner.auth, "Content-Type": "application/json" },
            body: JSON.stringify({ content, base_version: base }),
          },
          vars,
        );
      expect((await write(snap.text, 1, { ALLOW_ROOMS: "false" })).status).toBe(200);
      const v3 = snap.text.replace('["Plums"]', '["Plums",1]');
      expect((await write(v3, 2)).status).toBe(200);
      expect((await a.nextOf("conflict")).version).toBe(3);
      // The finish moves the base to v2 under the Pears edit, never back to the snapshot's rows.
      await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev);
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: 3,
        text: pears,
      });
      a.ws.close(1000);
    });

    /**
     * Apples edited and snapshotted; the lock runs out; Apples put back, so the draft is v1 again
     * while v2 (Apples 4) is being written; then the room is evicted.
     */
    async function undoWhileSaving() {
      const s = await sheetSetup(SHEET);
      const a = await connectDoc(s.id, s.ownerP.cookie);
      const rev = await editRow(a, 1, '["Apples",4,true]', 0);
      const stub = stubFor(s.id);
      const snap = await stub.docSnapshot(s.id);
      expect(snap).toMatchObject({ state: "ready", rev });
      await expire(s.id);
      const back = await editRow(a, 1, '["Apples",3,true]', rev);
      return { ...s, a, stub, snap, back };
    }

    it("an undo made while it saves survives an eviction: the wake on its notify keeps Apples put back over v2", async () => {
      const { id, a, stub, snap, back, put } = await (async () => {
        const u = await undoWhileSaving();
        await evictDurableObject(u.stub);
        const put = () =>
          call(u.id, u.owner.auth, "", {
            method: "PUT",
            body: { content: u.snap.text, base_version: 1 },
          });
        return { ...u, put };
      })();
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: back });
      // v2 holds Apples 4; the draft is what the page shows, Apples 3, unsaved on top of v2.
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: SHEET,
      });
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: back,
        dirty: true,
      });
      expect(await liveRow(id)).toMatchObject({ base_version: 2, content: SHEET });
      // The next save publishes the undo as v3.
      expect(await stub.docSnapshot(id)).toMatchObject({
        state: "ready",
        base_version: 2,
        text: SHEET,
      });
      a.ws.close(1000);
    });

    it("an undo made while it saves survives an eviction: its finish arriving first on the wake keeps Apples put back", async () => {
      const { id, owner, a, stub, snap, back } = await undoWhileSaving();
      await evictDurableObject(stub);
      // v2 lands with no notify (rooms off for that request); the finish wakes the room.
      const put = await run(
        `${APP}/api/v1/artifacts/${id}`,
        {
          method: "PUT",
          headers: { ...owner.auth, "Content-Type": "application/json" },
          body: JSON.stringify({ content: snap.text, base_version: 1 }),
        },
        { ALLOW_ROOMS: "false" },
      );
      expect(put.status).toBe(200);
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: back,
        dirty: true,
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: SHEET,
      });
      a.ws.close(1000);
    });

    it("a draft put back to its base keeps its row while the save runs, and loses it when the save gives up", async () => {
      const { id, a, stub, snap, back } = await undoWhileSaving();
      expect(await liveRow(id)).toEqual({ base_version: 1, content: SHEET, rev: back });
      // Not even an eviction and a wake take it while the snapshot is pending.
      await evictDurableObject(stub);
      expect(await stub.docPeek(id)).toMatchObject({ base_version: 1, text: SHEET, rev: back });
      expect(await liveRow(id)).toEqual({ base_version: 1, content: SHEET, rev: back });
      // The save gives up (a stager refusal): the last pending snapshot is gone, and so is the row.
      await stub.docAbort(snap.lock);
      expect(await pending(id)).toEqual({ lock: null, saving: 0 });
      expect(await liveRow(id)).toBeNull();
      expect(await stub.docPeek(id)).toMatchObject({ base_version: 1, text: SHEET });
      a.ws.close(1000);
    });

    it("after the next save took the lock, its own version is still recognized, and the finish keeps Pears", async () => {
      const { id, a, stub, snap, after, later, put } = await slowSave();
      // The next save's snapshot does not replace the slow one's: v2's notify is recognized, and
      // the sheet is not frozen against its own version.
      const next = await stub.docSnapshot(id);
      expect(next).toMatchObject({ state: "ready", rev: after, text: later });
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: after });
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      // The next save's lock is its own, and still held.
      expect((await stub.docSnapshot(id)).state).toBe("busy");
      await stub.docAbort(next.lock);
      expect(await lease(a, 2, 3, after)).toMatchObject({ t: "leased" });
      a.ws.close(1000);
    });

    it("the next save giving up leaves the slow one's snapshot: its version is not frozen against", async () => {
      const { id, a, stub, snap, after, later, put } = await slowSave();
      // The next save aborts (a stale base, too soon, a stager refusal) before v2's notify.
      const next = await stub.docSnapshot(id);
      await stub.docAbort(next.lock);
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: after });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: later,
      });
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: after,
        dirty: true,
      });
      a.ws.close(1000);
    });

    it("a clean or busy snapshot meanwhile leaves it too: rows put back stay put back", async () => {
      const { id, a, stub, snap, after, put } = await slowSave();
      // Busy: another save holds the lock. It gives up.
      const next = await stub.docSnapshot(id);
      expect((await stub.docSnapshot(id)).state).toBe("busy");
      await stub.docAbort(next.lock);
      // Clean: both rows put back as v1 has them.
      const back = await editRow(a, 1, '["Apples",3,true]', after);
      const clean = await editRow(a, 2, '["Pears",5]', back);
      expect(await stub.docSnapshot(id)).toMatchObject({ state: "clean", rev: clean });
      // v2 is still the slow save's own: the draft moves onto it with the rows put back, instead
      // of being reset to v2's rows.
      expect((await put()).status).toBe(200);
      expect(await notified(a)).toEqual({ t: "saved", version: 2, rev: clean });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: SHEET,
      });
      expect(await stub.docFinish(id, 2, snap.text, snap.lock, snap.epoch, snap.rev)).toEqual({
        rev: clean,
        dirty: true,
      });
      a.ws.close(1000);
    });
  });
});
