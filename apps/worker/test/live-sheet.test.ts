// On-page editing of a sheet in the room (#36, docs/spec.md "Editing"): the same draft channel as
// docs, with the sheet's rules. A row lease and its edit; a row line the sheet cannot hold (or not
// in its canonical spelling) refused with `invalid` and not applied; a header that keeps its
// columns; struct frames applied once and the same on every socket, refused while someone else
// holds a lease; a version published meanwhile (edit_sheet, PUT, a restore) never merged: the
// draft freezes, and the review's two choices publish it as it is or discard it.
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
});
