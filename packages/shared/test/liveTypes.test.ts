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
  parseSheet,
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
