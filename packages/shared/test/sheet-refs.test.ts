// Moving references for inserted and deleted rows and columns, and the edit ops built on it.
import { describe, expect, it } from "vitest";
import {
  applySheetOps,
  LIMITS,
  parseSheet,
  type Sheet,
  type SheetOp,
  SheetOpError,
  serializeSheet,
  shiftFormula,
} from "../src/index.ts";

describe("shiftFormula", () => {
  const ins = (before: number, count = 1) => ({ kind: "insert_rows" as const, before, count });
  const del = (from: number, count = 1) => ({ kind: "delete_rows" as const, from, count });
  const insC = (before: number, count = 1) => ({ kind: "insert_columns" as const, before, count });
  const delC = (from: number, count = 1) => ({ kind: "delete_columns" as const, from, count });

  it("moves rows before, inside and after a range", () => {
    expect(shiftFormula("=A5+A2", ins(3))).toBe("=A6+A2");
    expect(shiftFormula("=SUM(A2:A10)", ins(5, 2))).toBe("=SUM(A2:A12)");
    expect(shiftFormula("=SUM(A2:A10)", ins(2))).toBe("=SUM(A3:A11)");
    expect(shiftFormula("=SUM(A2:A10)", ins(11))).toBe("=SUM(A2:A10)");
    expect(shiftFormula("=$A$5", ins(3))).toBe("=$A$6");
    expect(shiftFormula("=SUM(3:5)", ins(4))).toBe("=SUM(3:6)");
    expect(shiftFormula("=SUM(B:B)", ins(4))).toBe("=SUM(B:B)");
  });

  it("deletes rows: references into them are #REF!, ranges shrink", () => {
    expect(shiftFormula("=A5", del(5))).toBe("=#REF!");
    expect(shiftFormula("=A6*2", del(5))).toBe("=A5*2");
    expect(shiftFormula("=SUM(A2:A10)", del(4, 3))).toBe("=SUM(A2:A7)");
    expect(shiftFormula("=SUM(A4:A6)", del(4, 3))).toBe("=SUM(#REF!)");
    expect(shiftFormula("=SUM(A2:A5)", del(4, 3))).toBe("=SUM(A2:A3)");
    expect(shiftFormula("=SUM(A5:A9)", del(4, 3))).toBe("=SUM(A4:A6)");
  });

  it("moves columns and whole columns", () => {
    expect(shiftFormula("=B2+A2", insC(1))).toBe("=C2+A2");
    expect(shiftFormula("=SUM(A:C)", insC(1, 2))).toBe("=SUM(A:E)");
    expect(shiftFormula("=SUM(B:B)", delC(1))).toBe("=SUM(#REF!)");
    expect(shiftFormula("=C2", delC(1))).toBe("=B2");
    expect(shiftFormula("=SUM(2:2)", insC(0))).toBe("=SUM(2:2)");
  });

  it("keeps everything else byte for byte", () => {
    expect(shiftFormula('=IF(a5 > 1, "A5", a5)', ins(3))).toBe('=IF(A6 > 1, "A5", A6)');
    expect(shiftFormula("plain", ins(1))).toBe("plain");
    expect(shiftFormula('="unclosed', ins(1))).toBe('="unclosed');
  });
});

function sheetFrom(text: string): Sheet {
  const r = parseSheet(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.sheet;
}

const BASE = sheetFrom(
  [
    '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"},{"name":"Total","type":"number"}]}',
    '["a",1,"=B2*2"]',
    '["b",2,"=B3*2"]',
    '["sum",null,"=SUM(C2:C3)"]',
  ].join("\n"),
);

describe("applySheetOps", () => {
  it("sets a block, growing the sheet past its end", () => {
    const { sheet, changed } = applySheetOps(BASE, [{ op: "set", at: "B6", values: [[9, 10]] }]);
    expect(sheet.rows[4]).toEqual([null, 9, 10]);
    expect(sheet.rows[3]).toEqual([]);
    expect(changed.cells).toBe(2);
    expect(BASE.rows).toHaveLength(3);
  });

  it("appends, inserts and deletes rows, moving formulas", () => {
    const ins = applySheetOps(BASE, [
      { op: "insert_rows", before: 3, values: [["new", 5, "=B3*2"]] },
    ]);
    expect(ins.sheet.rows.map((r) => r[2])).toEqual(["=B2*2", "=B3*2", "=B4*2", "=SUM(C2:C4)"]);
    expect(ins.changed.rows_inserted).toBe(1);
    const del = applySheetOps(BASE, [{ op: "delete_rows", from: 2 }]);
    expect(del.sheet.rows.map((r) => r[2])).toEqual(["=B2*2", "=SUM(C2:C2)"]);
    const app = applySheetOps(BASE, [{ op: "append_rows", values: [["c", 3]] }]);
    expect(app.sheet.rows).toHaveLength(4);
  });

  it("changes, inserts and deletes columns", () => {
    const r = applySheetOps(BASE, [
      { op: "insert_columns", before: "B", columns: [{ name: "Note" }] },
      { op: "set_column", column: "C", name: "Count", width: 120 },
    ]);
    expect(r.sheet.header.columns.map((c) => c.name)).toEqual(["Item", "Note", "Count", "Total"]);
    expect(r.sheet.rows[0]).toEqual(["a", null, 1, "=C2*2"]);
    expect(r.sheet.rows[2]).toEqual(["sum", null, null, "=SUM(D2:D3)"]);
    const d = applySheetOps(BASE, [{ op: "delete_columns", from: "B" }]);
    expect(d.sheet.rows[0]).toEqual(["a", "=#REF!*2"]);
    expect(d.changed.columns_deleted).toBe(1);
  });

  it("changes a column's type and its cells in one call", () => {
    const r = applySheetOps(BASE, [
      { op: "set_column", column: "A", type: "checkbox" },
      { op: "set", at: "A2", values: [[true], [false], [null]] },
    ]);
    expect(parseSheet(serializeSheet(r.sheet)).ok).toBe(true);
  });

  it("is atomic and names the failing op", () => {
    const ops: SheetOp[] = [
      { op: "set", at: "A2", values: [["changed"]] },
      { op: "delete_rows", from: 9 },
    ];
    try {
      applySheetOps(BASE, ops);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SheetOpError);
      expect((e as SheetOpError).index).toBe(1);
    }
    expect(BASE.rows[0]?.[0]).toBe("a");
    expect(() => applySheetOps(BASE, [{ op: "set", at: "A1", values: [["x"]] }])).toThrow(/row 2/);
    expect(() => applySheetOps(BASE, [{ op: "set", at: "C2", values: [[1, 2]] }])).toThrow(
      /insert_columns first/,
    );
    expect(() => applySheetOps(BASE, [{ op: "delete_columns", from: "A", count: 3 }])).toThrow(
      /at least one column/,
    );
  });

  it("refuses rows past the limit before it grows the sheet", () => {
    for (const ops of [
      [{ op: "set", at: "A1048576", values: [[1]] }],
      [{ op: "set", at: "A10000", values: [[1], [2], [3]] }],
    ] as SheetOp[][]) {
      expect(() => applySheetOps(BASE, ops)).toThrow(SheetOpError);
      expect(() => applySheetOps(BASE, ops)).toThrow(/at most 10000 rows \(2 to 10001\)/);
    }
    // Row 10001 is the last row a sheet holds.
    const ok = applySheetOps(BASE, [{ op: "set", at: "A10001", values: [["x"]] }]);
    expect(ok.sheet.rows).toHaveLength(LIMITS.maxSheetRows);
    expect(() => applySheetOps(BASE, [{ op: "insert_rows", before: 2, count: 200_000 }])).toThrow(
      /at most 10000 rows/,
    );
    expect(() =>
      applySheetOps(BASE, [
        { op: "append_rows", values: Array.from({ length: 200_000 }, () => []) },
      ]),
    ).toThrow(/at most 10000 rows/);
    expect(() =>
      applySheetOps(BASE, [
        { op: "set", at: "A2", values: Array.from({ length: 200_000 }, () => []) },
      ]),
    ).toThrow(/at most 10000 rows/);
  });

  it("limits the cells one call writes", () => {
    const row = Array.from({ length: 3 }, () => 1);
    const values = Array.from({ length: Math.ceil(LIMITS.maxSheetOpCells / 3) + 1 }, () => row);
    expect(() => applySheetOps(BASE, [{ op: "append_rows", values }])).toThrow(
      /at most 10000 cells/,
    );
  });
});
