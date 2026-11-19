// The live-editing rules per type (#36): every type with liveEdit has rules; a doc's draft takes
// any lines; a sheet's draft takes only valid, canonical rows and a header with the same number of
// columns, re-checks every row when the header changes, and moves rows and columns only through
// applySheetStruct, which both sides run to the same lines.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPES,
  applySheetStruct,
  LIMITS,
  LIVE_TYPE_RULES,
  liveDocClientFrameSchema,
  liveDocTooLarge,
  liveRules,
  liveSheetTooLarge,
  merge3,
  parseSheet,
  type SheetStructOp,
  serializeSheet,
  sheetHeaderLine,
  sheetRowLine,
  TYPE_REGISTRY,
} from "../src/index.ts";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text" },
    { name: "Qty", type: "number" },
    { name: "Total", type: "number" },
  ],
});
const LINES = [HEADER, '["Apples",3,"=B2*2"]', '["Pears",5,"=B3*2"]', '["Sum",null,"=SUM(C2:C3)"]'];
const sheet = liveRules("sheet");
if (!sheet) throw new Error("no sheet rules");

describe("live type rules", () => {
  it("cover exactly the types with liveEdit", () => {
    const live = ARTIFACT_TYPES.filter((t) => TYPE_REGISTRY[t].liveEdit);
    expect(live).toEqual(["doc", "sheet"]);
    expect(Object.keys(LIVE_TYPE_RULES).sort()).toEqual([...live].sort());
    expect(liveRules("html")).toBeNull();
    expect(liveRules("constructor")).toBeNull();
    expect(liveRules("__proto__")).toBeNull();
  });

  it("a doc takes any lines, within its size", () => {
    const doc = liveRules("doc");
    expect(doc?.checkEdit(["# A", ""], 0, 1, ["<script>", ""])).toBeNull();
    expect(doc?.valid("anything")).toBe(true);
    expect(doc?.struct).toBe(false);
    expect(doc?.tooLarge("a".repeat(LIMITS.maxDocBytes + 1))).toBe(true);
    expect(liveDocTooLarge("\n".repeat(LIMITS.maxLiveDocLines))).toBe(true);
  });
});

describe("sheet edits", () => {
  it("takes a valid row in its canonical spelling", () => {
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples",4,"=B2*2"]'])).toBeNull();
    // Insert a new row at the end, and delete one (an empty replacement).
    expect(sheet.checkEdit(LINES, 4, 0, ['["Plums",1]'])).toBeNull();
    expect(sheet.checkEdit(LINES, 2, 1, [])).toBeNull();
  });

  it("refuses a row that does not fit its columns, or is not canonical", () => {
    // Text in a number column.
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples","three"]'])).toBe("invalid");
    // More cells than columns.
    expect(sheet.checkEdit(LINES, 1, 1, ['["a",1,2,3]'])).toBe("invalid");
    // A formula that does not parse, or calls a function sheets do not have.
    expect(sheet.checkEdit(LINES, 1, 1, ['["a",1,"=SUM("]'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, ['["a",1,"=HYPERLINK(\\"x\\")"]'])).toBe("invalid");
    // The same row spelled another way: spaces, a trailing null, a float written long.
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples", 4]'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples",4,null]'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples",4.0]'])).toBe("invalid");
    // Not a row at all, or a blank line.
    expect(sheet.checkEdit(LINES, 1, 1, ['{"a":1}'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, [""])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, ["not json"])).toBe("invalid");
  });

  it("keeps the header one line with the same columns, and re-checks every row against it", () => {
    const renamed = HEADER.replace('"Item"', '"Fruit"');
    expect(sheet.checkEdit(LINES, 0, 1, [renamed])).toBeNull();
    // A header with another number of columns, or two lines in its place.
    const fewer = JSON.stringify({ plinth: "sheet", v: 1, columns: [{ name: "A", type: "text" }] });
    expect(sheet.checkEdit(LINES, 0, 1, [fewer])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 0, 1, [renamed, '["x"]'])).toBeNull();
    expect(sheet.checkEdit(LINES, 0, 1, [])).toBe("invalid");
    // Nothing goes above the header.
    expect(sheet.checkEdit(LINES, 0, 0, ['["x"]'])).toBe("invalid");
    // Item becomes a number column: "Apples" no longer fits, so the change is refused.
    const typed = HEADER.replace(
      '{"name":"Item","type":"text"}',
      '{"name":"Item","type":"number"}',
    );
    expect(sheet.checkEdit(LINES, 0, 1, [typed])).toBe("invalid");
    // A header that is not canonical (keys in another order).
    const reordered = `{"v":1,"plinth":"sheet","columns":${JSON.stringify(
      JSON.parse(HEADER).columns,
    )}}`;
    expect(sheet.checkEdit(LINES, 0, 1, [reordered])).toBe("invalid");
  });

  it("refuses past the row and size limits", () => {
    const tall = [HEADER, ...Array.from({ length: LIMITS.maxSheetRows }, () => "[]")];
    expect(sheet.checkEdit(tall, tall.length, 0, ["[]"])).toBe("too_large");
    expect(liveSheetTooLarge(tall.join("\n"))).toBe(false);
    expect(liveSheetTooLarge([...tall, "[]"].join("\n"))).toBe(true);
    expect(liveSheetTooLarge("a".repeat(LIMITS.maxSheetBytes + 1))).toBe(true);
    const long = JSON.stringify(["x".repeat(LIMITS.maxSheetCellChars + 1)]);
    expect(sheet.checkEdit(LINES, 1, 1, [long])).toBe("invalid");
  });

  it("valid() is a parsed, canonical sheet", () => {
    expect(sheet.valid(LINES.join("\n"))).toBe(true);
    expect(sheet.valid(`${LINES.join("\n")}\n`)).toBe(false);
    expect(sheet.valid([HEADER, '["Apples", 3]'].join("\n"))).toBe(false);
    expect(sheet.valid([HEADER, '["Apples","x"]'].join("\n"))).toBe(false);
  });

  it("reads header and row lines", () => {
    expect(sheetHeaderLine(HEADER)?.columns).toHaveLength(3);
    expect(sheetHeaderLine('["Apples"]')).toBeNull();
    expect(sheetHeaderLine(undefined)).toBeNull();
    const h = sheetHeaderLine(HEADER);
    if (!h) throw new Error("no header");
    expect(sheetRowLine(h, '["a",1]', 2)).toBe(true);
    expect(sheetRowLine(h, '["a",1,null]', 2)).toBe(false);
  });
});

describe("sheet structural changes", () => {
  it("insert and delete rows, moving every formula's references", () => {
    const ins = applySheetStruct(LINES, { op: "insert_rows", before: 3, count: 2 });
    expect(ins).toEqual([
      HEADER,
      '["Apples",3,"=B2*2"]',
      "[]",
      "[]",
      '["Pears",5,"=B5*2"]',
      '["Sum",null,"=SUM(C2:C5)"]',
    ]);
    const del = applySheetStruct(LINES, { op: "delete_rows", from: 2, count: 1 });
    expect(del).toEqual([HEADER, '["Pears",5,"=B2*2"]', '["Sum",null,"=SUM(C2:C2)"]']);
  });

  it("insert and delete columns", () => {
    const ins = applySheetStruct(LINES, {
      op: "insert_columns",
      before: "B",
      columns: [{ name: "Note", type: "text" }],
    });
    expect(ins?.[0]).toContain('{"name":"Note","type":"text"}');
    expect(ins?.[1]).toBe('["Apples",null,3,"=C2*2"]');
    const del = applySheetStruct(LINES, { op: "delete_columns", from: "B", count: 1 });
    expect(del?.[1]).toBe('["Apples","=#REF!*2"]');
    // Every result is a valid canonical sheet the rules accept.
    for (const r of [ins, del]) expect(sheet.valid((r as string[]).join("\n"))).toBe(true);
  });

  it("is pure and deterministic, and refuses what does not apply", () => {
    const copy = [...LINES];
    const op = { op: "insert_rows", before: 2, count: 1 } as const;
    expect(applySheetStruct(LINES, op)).toEqual(applySheetStruct(copy, op));
    expect(LINES).toEqual(copy);
    expect(applySheetStruct(LINES, { op: "delete_rows", from: 9, count: 1 })).toBeNull();
    expect(applySheetStruct(LINES, { op: "delete_columns", from: "A", count: 3 })).toBeNull();
    expect(applySheetStruct(["not a header"], op)).toBeNull();
    // A canonical result stays canonical through parse and serialize.
    const out = applySheetStruct(LINES, op) as string[];
    const p = parseSheet(out.join("\n"));
    expect(p.ok && serializeSheet(p.sheet)).toBe(out.join("\n"));
  });
});

describe("struct frames", () => {
  it("the client schema takes the four ops and nothing else", () => {
    const ok = [
      { op: "insert_rows", before: 2, count: 1 },
      { op: "delete_rows", from: 3, count: 2 },
      { op: "insert_columns", before: "C", columns: [{ name: "New", type: "number" }] },
      { op: "delete_columns", from: "A", count: 1 },
    ];
    for (const op of ok)
      expect(liveDocClientFrameSchema.safeParse({ t: "struct", rev: 4, op }).success, op.op).toBe(
        true,
      );
    const bad = [
      { op: "insert_rows", before: 1, count: 1 },
      { op: "insert_rows", before: 2, count: 0 },
      { op: "insert_rows", before: 2, count: 1, values: [["x"]] },
      { op: "insert_columns", before: "c", columns: [{ name: "New" }] },
      { op: "insert_columns", before: "C", columns: [{ name: "New", colour: "red" }] },
      { op: "insert_columns", before: "C", columns: [] },
      { op: "delete_columns", from: "A" },
      { op: "set", at: "B2", values: [[1]] },
    ];
    for (const op of bad)
      expect(liveDocClientFrameSchema.safeParse({ t: "struct", rev: 4, op }).success, op.op).toBe(
        false,
      );
  });
});

describe("sheet merges", () => {
  // The room's merge of a live draft (ours) with a version published meanwhile (theirs).
  const merge = (base: string[], ours: string[], theirs: string[]) =>
    merge3(base.join("\n"), ours.join("\n"), theirs.join("\n"), {
      rows: sheet.rows,
      refuse: sheet.refuseMerge,
    });
  const struct = (lines: string[], op: SheetStructOp) => applySheetStruct(lines, op) as string[];
  const QTY = JSON.stringify({ plinth: "sheet", v: 1, columns: [{ name: "Qty", type: "number" }] });
  const BASE = [QTY, "[1]", "[2]", "[3]"];

  it("still merges rows changed on each side when nothing moved under them", () => {
    const ours = [...LINES];
    ours[1] = '["Apples",4,"=B2*2"]';
    const theirs = [...LINES];
    theirs[2] = '["Pears",6,"=B3*2"]';
    expect(merge(LINES, ours, theirs)).toMatchObject({ clean: true });
    // Rows inserted on one side, plain values changed on the other: the values follow their rows.
    const inserted = struct(BASE, { op: "insert_rows", before: 3, count: 1 });
    expect(merge(BASE, [QTY, "[10]", "[2]", "[3]"], inserted)).toMatchObject({
      clean: true,
      text: [QTY, "[10]", "[]", "[2]", "[3]"].join("\n"),
    });
    // A formula next to rows the other side only appended: nothing it points at moved.
    expect(merge(BASE, [QTY, '["=SUM(A3:A4)"]', "[2]", "[3]"], [...BASE, "[4]"])).toMatchObject({
      clean: true,
    });
  });

  it("reviews a formula that the other side's row insert or delete would point elsewhere", () => {
    // A total added on the page; an agent inserts a row before row 2.
    const ours = [...BASE, '["=SUM(A2:A4)"]'];
    const theirs = struct(BASE, { op: "insert_rows", before: 2, count: 1 });
    expect(merge(BASE, ours, theirs)).toMatchObject({ clean: false, reason: "refused" });
    // The mirror: the page deletes a row, an agent's version adds a formula.
    const deleted = struct(BASE, { op: "delete_rows", from: 3, count: 1 });
    expect(merge(BASE, deleted, [...BASE, '["=A4*2"]'])).toMatchObject({
      clean: false,
      reason: "refused",
    });
    // A formula typed into a row near or far from the rows the other side inserted.
    const five = [HEADER, '["a",1]', '["b",2]', '["c",3]', '["d",4]', '["e",5]'];
    const typed = [...five];
    typed[1] = '["a",1,"=B5"]';
    for (const before of [3, 5]) {
      expect(
        merge(five, typed, struct(five, { op: "insert_rows", before, count: 1 })),
        `before ${before}`,
      ).toMatchObject({ clean: false, reason: "refused" });
    }
  });

  it("reviews any column added or removed on one side while the other changed rows", () => {
    const header = (names: string[]) =>
      JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: names.map((name) => ({ name, type: "text" })),
      });
    const base = [header(["Name", "Email", "Notes"]), '["Ann","a@x"]', '["Bob","b@x","vip"]'];
    const phone = { op: "insert_columns", before: "C", columns: [{ name: "Phone", type: "text" }] };
    // Ann's row is short, so the inserted column leaves its line as it was; the agent's note in
    // C2 would land in Phone.
    const ours = struct(base, phone as SheetStructOp);
    expect(ours[1]).toBe(base[1]);
    const theirs = [...base];
    theirs[1] = '["Ann","a@x","call back"]';
    expect(merge(base, ours, theirs)).toMatchObject({ clean: false, reason: "refused" });
    // A row further down, and the mirror (the agent adds the column, the page sets the cell).
    const tall = [...base, '["Cy","c@x"]', '["Di","d@x"]'];
    const note = [...tall];
    note[4] = '["Di","d@x","call back"]';
    expect(merge(tall, struct(tall, phone as SheetStructOp), note)).toMatchObject({
      clean: false,
      reason: "refused",
    });
    expect(merge(tall, note, struct(tall, phone as SheetStructOp))).toMatchObject({
      clean: false,
      reason: "refused",
    });
    // A column removed past the rows' last cells: their lines stay, and the page's D3 has no
    // column left to be in.
    const wide = [header(["Name", "Email", "Notes", "Extra"]), '["Ann","a@x"]', '["Bob"]'];
    const set = [...wide];
    set[2] = '["Bob",null,null,"x"]';
    expect(
      merge(wide, set, struct(wide, { op: "delete_columns", from: "C", count: 1 })),
    ).toMatchObject({ clean: false, reason: "refused" });
    // Widths and number formats move nothing, so they still merge with row changes.
    const widened = [header(["Name", "Email", "Notes"]).replace('"text"}', '"text","width":200}')];
    expect(sheetHeaderLine(widened[0])).not.toBeNull();
    expect(merge(tall, [...widened, ...tall.slice(1)], note)).toMatchObject({ clean: true });
  });

  it("reviews a column deleted and another inserted, which keeps the count but moves cells", () => {
    const header = (names: string[]) =>
      JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: names.map((name) => ({ name, type: "text" })),
      });
    const col = (name: string) => ({ name, type: "text" as const });
    const moved = (lines: string[], before: string, name: string) =>
      struct(struct(lines, { op: "delete_columns", from: "B", count: 1 }), {
        op: "insert_columns",
        before,
        columns: [col(name)],
      });
    // Email removed and Phone added after the last column: still four columns, and Ann's short
    // row keeps its line, so an email set in B2 would land in Notes.
    const base = [header(["Name", "Email", "Notes", "Extra"]), '["Ann"]', '["Bob","b@x","n","e"]'];
    const ours = moved(base, "D", "Phone");
    expect(ours[0]).toBe(header(["Name", "Notes", "Extra", "Phone"]));
    expect(ours[1]).toBe(base[1]);
    const theirs = [...base];
    theirs[1] = '["Ann","ann@x"]';
    expect(merge(base, ours, theirs)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(base, theirs, ours)).toMatchObject({ clean: false, reason: "refused" });
    // Five columns, B deleted and a column inserted before D: C3 would sit under the old D.
    const five = [header(["A", "B", "C", "D", "E"]), '["a1","b1","c1","d1","e1"]', '["a2"]'];
    const shifted = moved(five, "C", "New");
    expect(shifted[0]).toBe(header(["A", "C", "New", "D", "E"]));
    const c3 = [...five];
    c3[2] = '["a2",null,"note for C"]';
    expect(merge(five, shifted, c3)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(five, c3, shifted)).toMatchObject({ clean: false, reason: "refused" });
    // A rename looks the same as a column replaced in place, so it is reviewed too.
    const renamed = [header(["Name", "Mail", "Notes", "Extra"]), ...base.slice(1)];
    expect(merge(base, renamed, theirs)).toMatchObject({ clean: false, reason: "refused" });
    // Two columns with the same name and type: any change to the header is reviewed.
    const twins = [header(["X", "X", "X", "Y"]), '["a"]', '["b","c","d","e"]'];
    const twinsMoved = struct(struct(twins, { op: "delete_columns", from: "B", count: 1 }), {
      op: "insert_columns",
      before: "C",
      columns: [{ ...col("X"), width: 120 }],
    });
    expect(twinsMoved.slice(1)).toEqual(['["a"]', '["b","d",null,"e"]']);
    const twinsSet = [...twins];
    twinsSet[1] = '["a",null,"z"]';
    expect(merge(twins, twinsMoved, twinsSet)).toMatchObject({ clean: false, reason: "refused" });
  });

  it("reviews a row deleted at the end when the other side's added rows hold a formula", () => {
    // The page deletes row 5; an agent appends a total. Merged, the total would sit on row 5 and
    // count itself.
    const base = [QTY, "[1]", "[2]", "[3]", "[4]"];
    const deleted = struct(base, { op: "delete_rows", from: 5, count: 1 });
    expect(deleted).toEqual(base.slice(0, 4));
    const total = [...base, '["=SUM(A2:A5)"]'];
    expect(merge(base, deleted, total)).toMatchObject({ clean: false, reason: "refused" });
    // The mirror: the page appends a formula while the agent deletes the last row.
    expect(merge(base, [...base, '["=A2+A5"]'], deleted)).toMatchObject({
      clean: false,
      reason: "refused",
    });
    // A row inserted before a last row whose formula moves with it: one change at the end, but
    // the last row moved, so a formula pointing at it from the other side is reviewed.
    const sum = [QTY, "[1]", "[2]", '["=SUM(A2:A4)"]'];
    const inserted = struct(sum, { op: "insert_rows", before: 4, count: 1 });
    expect(inserted).toEqual([QTY, "[1]", "[2]", "[]", '["=SUM(A2:A5)"]']);
    const pointer = [...sum];
    pointer[1] = '["=A4"]';
    expect(merge(sum, inserted, pointer)).toMatchObject({ clean: false, reason: "refused" });
    // Rows only appended on one side still merge with a formula on the other.
    const doubled = [...base];
    doubled[1] = '["=A3*2"]';
    expect(merge(base, [...base, "[5]"], doubled)).toMatchObject({ clean: true });
    expect(merge(base, doubled, [...base, "[5]"])).toMatchObject({ clean: true });
  });

  it("reviews a row deleted and another added, which keeps the count but moves rows", () => {
    // A running total: every row's formula points at the row above, so a delete rewrites every
    // row below it and the line diff shows one change of the same size, with no row moved.
    const RUN = JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [
        { name: "Item", type: "text" },
        { name: "Amt", type: "number" },
        { name: "Run", type: "number" },
      ],
    });
    const base = [RUN, '["a",1,"=B2"]', '["b",2,"=C2+B3"]', '["c",3,"=C3+B4"]', '["d",4,"=C4+B5"]'];
    const deleted = struct(base, { op: "delete_rows", from: 3, count: 1 });
    expect(deleted.slice(2)).toEqual(['["c",3,"=#REF!+B3"]', '["d",4,"=C3+B4"]']);
    // The page deletes row 3 and appends a row; an agent appends a row that points at c's B4.
    const appended = [...deleted, '["e",5,"=C4+B5"]'];
    const pointer = [...base, '["ref c",null,"=B4"]'];
    expect(merge(base, appended, pointer)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(base, pointer, appended)).toMatchObject({ clean: false, reason: "refused" });
    // The page deletes row 3, then inserts a row before row 5; an agent's formula on row 2 points
    // at c's B4.
    const reinserted = struct(deleted, { op: "insert_rows", before: 5, count: 1 });
    expect(reinserted.length).toBe(base.length);
    const row2 = [...base];
    row2[1] = '["a =B4",1,"=B2+B4"]';
    expect(merge(base, reinserted, row2)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(base, row2, reinserted)).toMatchObject({ clean: false, reason: "refused" });
    // One row changed in place on one side still merges with a formula on the other.
    const one = [...base];
    one[2] = '["b",20,"=C2+B3"]';
    expect(merge(base, one, pointer)).toMatchObject({ clean: true });
    expect(merge(base, pointer, one)).toMatchObject({ clean: true });
  });

  it("reviews rows inserted or deleted in a run of equal rows when the other side changed one", () => {
    const ITEMS = JSON.stringify({
      plinth: "sheet",
      v: 1,
      columns: [
        { name: "Item", type: "text" },
        { name: "Qty", type: "number" },
      ],
    });
    // Two blank rows above a total. An agent inserts a row before row 3; the line diff puts the
    // new blank row after the run, so the page's row 4, filled meanwhile, would stay row 4 and the
    // total, rewritten to B5, would read the blank row instead.
    const base = [ITEMS, '["a",1]', "[]", "[]", '["total","=B4"]'];
    const inserted = struct(base, { op: "insert_rows", before: 3, count: 1 });
    expect(inserted).toEqual([ITEMS, '["a",1]', "[]", "[]", "[]", '["total","=B5"]']);
    const filled = [...base];
    filled[3] = '["b",5]';
    expect(merge(base, filled, inserted)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(base, inserted, filled)).toMatchObject({ clean: false, reason: "refused" });
    // A row deleted from the run, the same way.
    const tall = [ITEMS, '["a",1]', "[]", "[]", "[]", '["total","=B5"]'];
    const shorter = struct(tall, { op: "delete_rows", from: 3, count: 1 });
    expect(shorter).toEqual([ITEMS, '["a",1]', "[]", "[]", '["total","=B4"]']);
    const tallFilled = [...tall];
    tallFilled[3] = '["b",5]';
    expect(merge(tall, tallFilled, shorter)).toMatchObject({ clean: false, reason: "refused" });
    expect(merge(tall, shorter, tallFilled)).toMatchObject({ clean: false, reason: "refused" });
    // The run untouched by the other side, or a row inserted away from it: rows follow their lines.
    const named = [...base];
    named[1] = '["apples",1]';
    expect(merge(base, named, inserted)).toMatchObject({
      clean: true,
      text: [ITEMS, '["apples",1]', "[]", "[]", "[]", '["total","=B5"]'].join("\n"),
    });
    const top = struct(base, { op: "insert_rows", before: 2, count: 1 });
    expect(merge(base, filled, top)).toMatchObject({ clean: true });
  });
});
