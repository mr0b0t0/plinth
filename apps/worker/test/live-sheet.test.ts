// On-page editing of a sheet in the room (#36, docs/spec.md "Editing"): the same draft channel as
// docs, with the sheet's rules. A row lease and its edit; a row line the sheet cannot hold (or not
// in its canonical spelling) refused with `invalid` and not applied; a header that keeps its
// columns; struct frames applied once and the same on every socket, refused while someone else
// holds a lease; a text edit that changes the line count only at the end; a version published
// meanwhile (edit_sheet, PUT, a restore) never merged: the draft freezes, unless the version
// changed nothing the draft holds or is the draft, and the review's two choices publish the
// room's own draft (Publish mine, conflict_version) or discard it (Discard mine), each under the
// room's checkpoint lock, against exactly the version reviewed, so the two never interleave.
import { runInDurableObject } from "cloudflare:test";
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
    // A row in the middle never moves through a text edit: two rows for one, or none, are
    // refused (struct ops move rows, and rewrite the formulas they shift).
    expect(await edit(a, l.lease, '["Apples",3,true]\n["Figs",1]', 2)).toEqual({
      t: "error",
      code: "invalid",
    });
    expect(await edit(a, l.lease, "", 3)).toEqual({ t: "error", code: "invalid" });
    expect(await peek(id)).toBe(SHEET);
    // At the end, rows are appended through edits (a paste past the last row).
    a.send({ t: "release", lease: l.lease });
    const end = await lease(a, 5, 5, 0);
    const two = await edit(a, end.lease, '["Figs",1]\n["Kiwis",2]', 4);
    expect(two).toMatchObject({ t: "op", rev: 1, del: 0 });
    expect(splitLines((await peek(id)) as string)).toHaveLength(7);
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
  const discardAt = (id: string, h: Record<string, string>, rev: number, n?: number) =>
    call(id, h, `/live/draft?rev=${rev}${n !== undefined ? `&conflict_version=${n}` : ""}`, {
      method: "DELETE",
    });
  /** "Publish mine" in the review: the room's own frozen draft, over version n. */
  const publishMine = (
    id: string,
    h: Record<string, string>,
    n: number,
    extra: Record<string, unknown> = {},
  ) =>
    checkpoint(id, h, { base_version: 1, rev: 1, reason: "save", conflict_version: n, ...extra });

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
        message: expect.stringContaining(
          "Their unsaved edits are not merged with it: they see your version beside theirs and keep one.",
        ),
      }),
    );
    // A sheet has no files: the review's files part says so.
    expect(await a.nextOf("conflict")).toEqual({
      t: "conflict",
      version: 2,
      files: { added: [], removed: [], replaced: [], more: 0, same: 0 },
    });
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
    // The review reads the draft on the socket, never from the app's API.
    expect((await call(id, h, "/live/draft")).status).toBe(404);
    // A page joining now learns the frozen version and its files in the welcome.
    const b = await connectDoc(id, ownerP.cookie);
    expect(b.welcome).toMatchObject({
      base_version: 1,
      conflict_version: 2,
      files: { added: [], removed: [], replaced: [], more: 0, same: 0 },
    });
    a.ws.close(1000);
    b.ws.close(1000);
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
    expect(await a.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
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
    expect(await b.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
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
    expect(await c.nextOf("conflict")).toMatchObject({ t: "conflict", version: 2 });
    expect(await peek(three.id)).toBe(applySheetStruct(splitLines(SHEET), insert)?.join("\n"));
    c.ws.close(1000);
  });

  it("Publish mine: the room's draft becomes v3 on top of v2, v2 stays in the history, and editing resumes", async () => {
    const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
    const saved = await publishMine(id, ownerP.session.headers, 2);
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ saved: true, version: { version: 3 } });
    const v3 = await versionRow(id, 3);
    expect(v3?.note).toBe("Edited on the page. Replaces the changes in v2.");
    expect(await content(id, owner.auth, 3)).toBe(draft);
    expect(await content(id, owner.auth, 2)).toBe(V2);
    const reset = await a.nextOf("reset");
    expect(reset).toMatchObject({ version: 3, why: "published" });
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 3,
      conflict_version: null,
    });
    // Editing resumes on v3.
    expect(await lease(a, 2, 3, reset.rev)).toMatchObject({ t: "leased" });
    a.ws.close(1000);

    // The editor's own note comes first.
    const b = await frozen('["Apples",5,true]');
    const noted = await publishMine(b.id, b.ownerP.session.headers, 2, { note: "Counted again." });
    expect(noted.status).toBe(200);
    expect((await versionRow(b.id, 3))?.note).toBe("Counted again. Replaces the changes in v2.");
    b.a.ws.close(1000);
  });

  it("Publish mine is checked in order: busy, resolved, a newer version, an old rev, before clean", async () => {
    const { id, ownerP, owner, a } = await frozen('["Apples",4,true]');
    const h = ownerP.session.headers;
    const stub = stubFor(id);
    // Another holder has the lock: busy, and nothing changes.
    const snap = await stub.docSnapshot(id);
    expect(await json(await publishMine(id, h, 2))).toEqual({ saved: false, reason: "busy" });
    await stub.docAbort(snap.lock);
    // An old rev of the draft is sent back to review it again.
    const moved = await publishMine(id, h, 2, { rev: 0 });
    expect(moved.status).toBe(409);
    expect((await json(moved)).error.details.reason).toBe("live_moved");
    // A newer version froze the draft: a choice against v2 is refused, naming v3.
    const v3 = await editSheet(id, owner.auth, {
      base_version: 2,
      ops: [{ op: "set", at: "B4", values: [[2]] }],
    });
    expect(v3.status).toBe(201);
    expect(await a.nextOf("conflict")).toMatchObject({ version: 3 });
    const old = await publishMine(id, h, 2);
    expect(old.status).toBe(409);
    expect((await json(old)).error.details).toMatchObject({
      reason: "live_conflict",
      current_version: 3,
    });
    // Against v3 it publishes v4, naming the whole range.
    expect(await json(await publishMine(id, h, 3))).toMatchObject({ version: { version: 4 } });
    expect((await versionRow(id, 4))?.note).toBe(
      "Edited on the page. Replaces the changes in v2 to v3.",
    );
    // The draft is resolved now: a second choice is 409 live_resolved, never 200 clean.
    const again = await publishMine(id, h, 3);
    expect(again.status).toBe(409);
    expect((await json(again)).error.details).toMatchObject({
      reason: "live_resolved",
      current_version: 4,
    });
    expect(await versionRow(id, 5)).toBeNull();
    a.ws.close(1000);
  });

  it("Discard mine: the page goes back to v2 for everyone, and no version is written", async () => {
    const { id, ownerP, a } = await frozen('["Apples",4,true]');
    const h = ownerP.session.headers;
    const res = await discardAt(id, h, 1, 2);
    expect(res.status).toBe(204);
    const reset = await a.nextOf("reset");
    expect(reset).toMatchObject({ version: 2, why: "discarded" });
    expect(await readText(a, reset.gen)).toBe(V2);
    expect(await versionRow(id, 3)).toBeNull();
    // Once resolved, the same choice (or the other one) is refused as resolved.
    const again = await discardAt(id, h, 1, 2);
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.reason).toBe("live_resolved");
    const mine = await publishMine(id, h, 2);
    expect(mine.status).toBe(409);
    expect((await json(mine)).error.details.reason).toBe("live_resolved");
    a.ws.close(1000);
  });

  it("Discard mine against a newer version is refused, and the draft stays frozen against it", async () => {
    const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
    const h = ownerP.session.headers;
    const v3 = await editSheet(id, owner.auth, {
      base_version: 2,
      ops: [{ op: "set", at: "B4", values: [[2]] }],
    });
    expect(v3.status).toBe(201);
    expect(await a.nextOf("conflict")).toMatchObject({ version: 3 });
    const res = await discardAt(id, h, 1, 2);
    expect(res.status).toBe(409);
    expect((await json(res)).error.details).toMatchObject({
      reason: "live_conflict",
      current_version: 3,
    });
    expect(await stubFor(id).docPeek(id)).toMatchObject({
      base_version: 1,
      conflict_version: 3,
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
    const ended = await a.nextOf("reset");
    expect(ended.version).toBe(2);
    expect(ended.why).toBeUndefined();
    expect(await stubFor(s.id).docPeek(s.id)).toMatchObject({
      base_version: 2,
      conflict_version: null,
      text: draft,
    });
    a.ws.close(1000);

    // A title change only: the draft stays as it is, on v2.
    const t = await sheetSetup(SHEET);
    const ta = await connectDoc(t.id, t.ownerP.cookie);
    const tdraft = SHEET.replace('["Apples",3,true]', '["Apples",8,true]');
    await editRow(ta, 1, '["Apples",8,true]', 0);
    const titled = await call(t.id, t.owner.auth, "", {
      method: "PUT",
      body: { content: SHEET, base_version: 1, note: "Renamed" },
    });
    expect(titled.status).toBe(200);
    const kept = await ta.nextOf("rebased");
    expect(kept.version).toBe(2);
    expect(await readText(ta, kept.gen)).toBe(tdraft);
    ta.ws.close(1000);

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

  it("never merged: whatever is published, the room's lines are the draft's or the version's", async () => {
    // Random agent changes against a fixed page edit: each ends with the draft's lines, or v2's.
    const changes: Record<string, unknown>[] = [
      { op: "set", at: "B2", values: [[9]] },
      { op: "set", at: "A3", values: [["Quince"]] },
      { op: "insert_rows", before: 4, count: 1 },
      { op: "delete_rows", from: 3, count: 1 },
      { op: "set", at: "A2", values: [["Apples"]] },
    ];
    for (const op of changes) {
      const s = await sheetSetup(SHEET);
      const a = await connectDoc(s.id, s.ownerP.cookie);
      await editRow(a, 1, '["Apples",4,true]', 0);
      const draft = SHEET.replace('["Apples",3,true]', '["Apples",4,true]');
      const res = await editSheet(s.id, s.owner.auth, { base_version: 1, ops: [op] });
      expect(res.status, JSON.stringify(op)).toBe(201);
      const v2 = await content(s.id, s.owner.auth, 2);
      const peeked = await stubFor(s.id).docPeek(s.id);
      expect([draft, v2], JSON.stringify(op)).toContain(peeked?.text);
      a.ws.close(1000);
    }
  });

  // Both choices, and the strip's "Discard unpublished changes" (DELETE live/draft), take the
  // room's checkpoint lock: one choice resolves a frozen draft, and never on top of the other.
  describe("the two choices against each other", () => {
    it("Publish against Discard: a discard while Publish mine is saving is busy, and v3 stays clean", async () => {
      const { id, ownerP, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      // Publish mine has taken the lock; the stager is writing v3.
      const snap = await stub.docSnapshot(id);
      expect(snap).toMatchObject({ state: "conflict", rev: 1, conflict_version: 2, text: draft });
      for (const n of [undefined, 2]) {
        const res = await discardAt(id, ownerP.session.headers, 1, n);
        expect(res.status).toBe(409);
        expect((await json(res)).error).toMatchObject({
          code: "conflict",
          details: { reason: "live_busy", rev: 1 },
        });
      }
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 1,
        conflict_version: 2,
        text: draft,
      });
      // v3 lands and its finish arrives before the version notify: the draft is v3, clean, so
      // no autosave can publish v2's text over it.
      expect(await stub.docFinish(id, 3, draft, snap.lock, snap.epoch, true)).toMatchObject({
        dirty: false,
      });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 3,
        conflict_version: null,
        text: draft,
      });
      expect(await a.nextOf("reset")).toMatchObject({ version: 3, why: "published" });
      a.ws.close(1000);
    });

    it("Discard against Publish: a discard takes the lock before it reads, so a save arriving meanwhile is busy", async () => {
      const { id, ownerP, a } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      const [d, snap] = await Promise.all([
        stub.docDiscard(id, 1, { conflictVersion: 2 }),
        stub.docSnapshot(id),
      ]);
      expect(snap.state).toBe("busy");
      expect(d).toMatchObject({ ok: true });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: V2,
      });
      // The discard released its lock when it was done; Publish mine now finds it resolved.
      const retry = await publishMine(id, ownerP.session.headers, 2);
      expect(retry.status).toBe(409);
      expect((await json(retry)).error.details.reason).toBe("live_resolved");
      expect(await versionRow(id, 3)).toBeNull();
      a.ws.close(1000);
    });

    it("Publish against Publish, and Discard against Discard: the second is busy, then resolved", async () => {
      const p = await frozen('["Apples",4,true]');
      const h = p.ownerP.session.headers;
      const [one, two] = await Promise.all([publishMine(p.id, h, 2), publishMine(p.id, h, 2)]);
      const answers = [await json(one), await json(two)];
      expect(answers.filter((r) => r.saved === true)).toHaveLength(1);
      for (const r of answers) {
        if (r.saved !== true)
          expect(r.reason ?? r.error?.details?.reason).toMatch(/busy|live_resolved/);
      }
      expect(await versionRow(p.id, 4)).toBeNull();
      p.a.ws.close(1000);

      const d = await frozen('["Apples",4,true]');
      const dh = d.ownerP.session.headers;
      const both = await Promise.all([discardAt(d.id, dh, 1, 2), discardAt(d.id, dh, 1, 2)]);
      expect(both.map((r) => r.status).sort()).toEqual([204, 409]);
      const refused = both.find((r) => r.status === 409);
      expect((await json(refused as Response)).error.details.reason).toMatch(
        /live_busy|live_resolved/,
      );
      d.a.ws.close(1000);
    });

    it("both choices and the strip's discard sent at once: exactly one side wins, never a mix", async () => {
      for (let i = 0; i < 3; i++) {
        const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
        const h = ownerP.session.headers;
        const answers = await Promise.all([
          publishMine(id, h, 2),
          discardAt(id, h, 1, 2),
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

    it("a save that outlived its lock while a discard replaced the lines is not finished onto them", async () => {
      const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      const snap = await stub.docSnapshot(id);
      // The save stalls past the lock's 30 s, and a discard goes through meanwhile.
      await runInDurableObject(stub, async (room) => {
        (room as unknown as { doc: { lock: { until: number } } }).doc.lock.until = 0;
      });
      expect((await discardAt(id, ownerP.session.headers, 1, 2)).status).toBe(204);
      expect((await a.nextOf("reset")).version).toBe(2);
      // The late finish (v3 not readable yet) leaves the discarded draft as it is, on base v2
      // and clean, instead of v2's lines on base v3, which the next autosave would publish.
      expect(await stub.docFinish(id, 3, draft, snap.lock, snap.epoch, true)).toEqual({
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

    it("an edit made after such a discard freezes the draft against the late version instead", async () => {
      const { id, ownerP, owner, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      const snap = await stub.docSnapshot(id);
      await runInDurableObject(stub, async (room) => {
        (room as unknown as { doc: { lock: { until: number } } }).doc.lock.until = 0;
      });
      expect((await discardAt(id, ownerP.session.headers, 1, 2)).status).toBe(204);
      const reset = await a.nextOf("reset");
      await editRow(a, 2, '["Pears",8]', reset.rev);
      // The stalled Publish mine commits v3 now.
      const put = await call(id, owner.auth, "", {
        method: "PUT",
        body: { content: draft, base_version: 2 },
      });
      expect(put.status).toBe(200);
      await stub.docFinish(id, 3, draft, snap.lock, snap.epoch, true);
      const peeked = await stub.docPeek(id);
      expect(peeked).toMatchObject({ base_version: 2, conflict_version: 3 });
      // Never a dirty draft on v3 that equals v2.
      expect(peeked?.text).toBe(V2.replace('["Pears",7]', '["Pears",8]'));
      a.ws.close(1000);
    });

    it("an ordinary save past its lock, with no discard, keeps the edits made since on top", async () => {
      const s = await sheetSetup(SHEET);
      const a = await connectDoc(s.id, s.ownerP.cookie);
      await editRow(a, 1, '["Apples",4,true]', 0);
      const stub = stubFor(s.id);
      const snap = await stub.docSnapshot(s.id);
      await runInDurableObject(stub, async (room) => {
        (room as unknown as { doc: { lock: { until: number } } }).doc.lock.until = 0;
      });
      await editRow(a, 2, '["Pears",6]', 1);
      const put = await call(s.id, s.owner.auth, "", {
        method: "PUT",
        body: { content: snap.text, base_version: 1 },
      });
      expect(put.status).toBe(200);
      await stub.docFinish(s.id, 2, snap.text, snap.lock, snap.epoch);
      expect(await stub.docPeek(s.id)).toMatchObject({
        base_version: 2,
        conflict_version: null,
        text: snap.text.replace('["Pears",5]', '["Pears",6]'),
      });
      a.ws.close(1000);
    });

    it("a version notify during Discard mine's reads stops it: the draft stays frozen against the newer one", async () => {
      const { id, owner, a, draft } = await frozen('["Apples",4,true]');
      const stub = stubFor(id);
      // v3 is published while the room does not hear of it yet.
      await runInDurableObject(stub, async (room) => {
        const doc = (room as unknown as { doc: { version: unknown } }).doc;
        (doc as { version: () => Promise<void> }).version = async () => undefined;
      });
      const v3 = await editSheet(id, owner.auth, {
        base_version: 2,
        ops: [{ op: "set", at: "B4", values: [[2]] }],
      });
      expect(v3.status).toBe(201);
      // Its notify arrives while the discard reads the current version.
      const out = await runInDurableObject(stub, async (room) => {
        const doc = (
          room as unknown as {
            doc: {
              loaded: unknown;
              versionText: (d: unknown, n: number) => Promise<string | null>;
              outside: (d: unknown, n: number, h: string | null) => Promise<void>;
              discard: (
                id: string,
                rev: number,
                o: { conflictVersion?: number },
              ) => Promise<unknown>;
            };
          }
        ).doc;
        const read = doc.versionText.bind(doc);
        let once = true;
        doc.versionText = async (d, n) => {
          const t = await read(d, n);
          if (once) {
            once = false;
            await doc.outside(doc.loaded, 3, null);
          }
          return t;
        };
        return doc.discard(id, 1, { conflictVersion: 2 });
      });
      expect(out).toMatchObject({ ok: false, reason: "conflict", version: 3 });
      expect(await stub.docPeek(id)).toMatchObject({
        base_version: 1,
        conflict_version: 3,
        text: draft,
      });
      a.ws.close(1000);
    });
  });
});
