// On-page editing of a sheet in the room (#36, docs/spec.md "Editing"): the same draft channel as
// docs, with the sheet's rules. A row lease and its edit; a row line the sheet cannot hold (or not
// in its canonical spelling) refused with `invalid` and not applied; a header that keeps its
// columns; struct frames applied once and the same on every socket, refused while someone else
// holds a lease; an agent's edit_sheet version merged row by row under the draft, or frozen for
// review when the merged sheet is not valid; and a checkpoint that saves the draft as it is.
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
  const editSheet = (id: string, auth: Record<string, string>, body: Record<string, unknown>) =>
    run(`${APP}/api/v1/artifacts/${id}/sheet/edits`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("an agent's edit_sheet version is merged row by row under the draft, and a checkpoint saves it", async () => {
    const { owner, id, ownerP } = await sheetSetup(SHEET);
    const a = await connectDoc(id, ownerP.cookie);
    await editRow(a, 1, '["Apples",4,true]', 0);
    const res = await editSheet(id, owner.auth, {
      base_version: 1,
      ops: [{ op: "set", at: "B3", values: [[7]] }],
    });
    expect(res.status).toBe(201);
    expect((await json(res)).warnings).toContainEqual(
      expect.objectContaining({ code: "live_draft", file: "sheet.jsonl" }),
    );
    const rebased = await a.nextOf("rebased");
    expect(rebased).toMatchObject({ version: 2, rev: 2 });
    const merged = SHEET.replace('["Apples",3,true]', '["Apples",4,true]').replace(
      '["Pears",5]',
      '["Pears",7]',
    );
    expect(await readText(a, rebased.gen)).toBe(merged);
    const h = ownerP.session.headers;
    const saved = await run(`${APP}/api/v1/artifacts/${id}/live/checkpoint`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ base_version: 2, rev: 2, reason: "save" }),
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ saved: true, version: { version: 3 } });
    expect((await versionRow(id, 3))?.note).toBe("Edited on the page");
    const detail = await json(await run(`${APP}/api/v1/artifacts/${id}`, { headers: owner.auth }));
    // Stored byte for byte: the draft is already the canonical form.
    expect(detail.content).toBe(merged);
    a.ws.close(1000);
  });

  it("rows or columns an agent moves under the page's formulas or cells are frozen for review", async () => {
    // The page puts a formula on Plums' row; the agent inserts a row above Pears, which would
    // leave the formula pointing at the wrong row although the lines merge cleanly.
    const rows = await sheetSetup(SHEET);
    const a = await connectDoc(rows.id, rows.ownerP.cookie);
    await editRow(a, 3, '["Plums","=B3*2"]', 0);
    const res = await editSheet(rows.id, rows.owner.auth, {
      base_version: 1,
      ops: [{ op: "insert_rows", before: 3, count: 1 }],
    });
    expect(res.status).toBe(201);
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    expect(await stubFor(rows.id).docPeek(rows.id)).toMatchObject({ conflict_version: 2 });
    a.ws.close(1000);

    // The page sets Plums' Paid; the agent inserts a column before C, which leaves Plums' short
    // line as it was, so the merged true would sit in the new column.
    const cols = await sheetSetup(SHEET);
    const b = await connectDoc(cols.id, cols.ownerP.cookie);
    await editRow(b, 3, '["Plums",null,true]', 0);
    const res2 = await editSheet(cols.id, cols.owner.auth, {
      base_version: 1,
      ops: [{ op: "insert_columns", before: "C", columns: [{ name: "Ok", type: "checkbox" }] }],
    });
    expect(res2.status).toBe(201);
    expect(await b.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    b.ws.close(1000);

    // Two blank rows above a total: the page fills row 4 while the agent inserts a row before
    // row 3. The line diff puts the new blank row after the blank run, so the filled row would
    // stay row 4 while the total, rewritten to B5, read the blank row below it.
    const blank = [HEADER, '["Apples",3,true]', "[]", "[]", '["Total","=B4"]'];
    const blanks = await sheetSetup(blank.join("\n"));
    const c = await connectDoc(blanks.id, blanks.ownerP.cookie);
    await editRow(c, 3, '["Pears",5]', 0);
    const res3 = await editSheet(blanks.id, blanks.owner.auth, {
      base_version: 1,
      ops: [{ op: "insert_rows", before: 3, count: 1 }],
    });
    expect(res3.status).toBe(201);
    expect(await c.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    c.ws.close(1000);
  });

  it("a merge the sheet cannot hold is frozen for review, like an overlap", async () => {
    const { owner, id, ownerP } = await sheetSetup(SHEET);
    const a = await connectDoc(id, ownerP.cookie);
    // The page puts a number in the empty Qty of Plums; the agent makes Qty a checkbox column and
    // fixes the rows it sees. Different lines, so the lines merge, but Plums' 2 is no checkbox
    // (and a column's type changed, which is reviewed on its own).
    await editRow(a, 3, '["Plums",2]', 0);
    const res = await editSheet(id, owner.auth, {
      base_version: 1,
      ops: [
        { op: "set_column", column: "B", type: "checkbox" },
        { op: "set", at: "B2", values: [[true], [false]] },
        { op: "set", at: "B5", values: [[null]] },
      ],
    });
    expect(res.status).toBe(201);
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    const peeked = await stubFor(id).docPeek(id);
    expect(peeked).toMatchObject({ base_version: 1, conflict_version: 2 });
    expect(peeked?.text).toBe(SHEET.replace('["Plums"]', '["Plums",2]'));
    a.ws.close(1000);

    // The same columns with other options: the lines merge and no column changed its name or
    // type, but the page's "done" is no longer an option, so the merged sheet is not valid.
    const header =
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"State","type":"select","options":["open","done"]}]}';
    const select = [header, '["Apples","done"]', '["Pears","open"]', '["Plums"]'].join("\n");
    const s = await sheetSetup(select);
    const b = await connectDoc(s.id, s.ownerP.cookie);
    await editRow(b, 3, '["Plums","done"]', 0);
    const res2 = await editSheet(s.id, s.owner.auth, {
      base_version: 1,
      ops: [
        { op: "set_column", column: "B", options: ["open", "closed"] },
        { op: "set", at: "B2", values: [["closed"]] },
      ],
    });
    expect(res2.status).toBe(201);
    expect(await b.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    expect((await stubFor(s.id).docPeek(s.id))?.text).toBe(
      select.replace('["Plums"]', '["Plums","done"]'),
    );
    b.ws.close(1000);
  });

  it("a column deleted and another inserted, or the last row deleted, is frozen for review", async () => {
    // The page sets Plums' Paid on its short line; the agent deletes Qty and adds a column after
    // Paid. Still three columns and Plums' line is unchanged, so the merged true would sit in Note.
    const cols = await sheetSetup(SHEET);
    const a = await connectDoc(cols.id, cols.ownerP.cookie);
    await editRow(a, 3, '["Plums",null,true]', 0);
    const res = await editSheet(cols.id, cols.owner.auth, {
      base_version: 1,
      ops: [
        { op: "delete_columns", from: "B" },
        { op: "insert_columns", before: "C", columns: [{ name: "Note", type: "text" }] },
      ],
    });
    expect(res.status).toBe(201);
    expect(await a.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    a.ws.close(1000);

    // The page deletes the Total row, the last one; the agent appends a check of the total. Merged,
    // the check would sit on row 5 and point at itself.
    const rows = await sheetSetup(SHEET);
    const b = await connectDoc(rows.id, rows.ownerP.cookie);
    expect(await struct(b, { op: "delete_rows", from: 5, count: 1 }, 0)).toMatchObject({
      t: "struct",
      rev: 1,
    });
    // A lease released flushes the draft now rather than after the pause.
    const held = await lease(b, 1, 2, 1);
    if (held.t !== "leased") throw new Error(`lease ${held.t}`);
    b.send({ t: "release", lease: held.lease });
    await b.nextOf("flushed");
    const res2 = await editSheet(rows.id, rows.owner.auth, {
      base_version: 1,
      ops: [{ op: "append_rows", values: [["Check", "=B5*2"]] }],
    });
    expect(res2.status).toBe(201);
    expect(await b.nextOf("conflict")).toEqual({ t: "conflict", version: 2 });
    b.ws.close(1000);
  });
});
