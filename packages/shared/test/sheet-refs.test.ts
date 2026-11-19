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
  sheetOpSchema,
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

  it("moves rows: references into them follow, the others shift past the gap", () => {
    const mv = (from: number, count: number, to: number) => ({
      kind: "move_rows" as const,
      from,
      count,
      to,
    });
    // Rows 2 and 3 down to 5 and 6: rows 4 to 6 come up by two, row 7 stays.
    expect(shiftFormula("=A2+A3+A4+A5+A6+A7", mv(2, 2, 5))).toBe("=A5+A6+A2+A3+A4+A7");
    // Rows 6 and 7 up to 3 and 4: rows 3 to 5 go down by two, row 2 stays.
    expect(shiftFormula("=A2+A3+A5+A6+A7", mv(6, 2, 3))).toBe("=A2+A5+A7+A3+A4");
    // The header row, and rows past every row, never move; $ moves like a relative reference.
    expect(shiftFormula("=A1+A100+$B$6", mv(6, 2, 3))).toBe("=A1+A100+$B$3");
    // A move within a range only reorders it: the range stays.
    expect(shiftFormula("=SUM(B2:B8)", mv(3, 1, 6))).toBe("=SUM(B2:B8)");
    expect(shiftFormula("=SUM(B2:B4)", mv(4, 1, 2))).toBe("=SUM(B2:B4)");
    // Rows that leave a range shrink it; rows that land inside it grow it.
    expect(shiftFormula("=SUM(B3:B5)", mv(3, 1, 6))).toBe("=SUM(B3:B4)");
    expect(shiftFormula("=SUM(B2:B8)", mv(2, 1, 9))).toBe("=SUM(B2:B7)");
    expect(shiftFormula("=SUM(B5:B7)", mv(2, 1, 6))).toBe("=SUM(B4:B7)");
    expect(shiftFormula("=SUM(B5:B7)", mv(2, 1, 4))).toBe("=SUM(B5:B7)");
    // Each end keeps its $, and a range written bottom to top stays that way.
    expect(shiftFormula("=SUM($B$2:B8)", mv(2, 1, 9))).toBe("=SUM($B$2:B7)");
    expect(shiftFormula("=SUM(B8:B2)", mv(2, 1, 9))).toBe("=SUM(B7:B2)");
    // A range inside the moved rows follows them.
    expect(shiftFormula("=SUM(4:5)", mv(4, 2, 2))).toBe("=SUM(2:3)");
    // Whole columns are every row: a row move leaves them alone.
    expect(shiftFormula("=SUM(B:B)", mv(2, 1, 5))).toBe("=SUM(B:B)");
    // Nothing becomes #REF!, and text in strings stays.
    expect(shiftFormula('=IF(A3>0,"A3",A3)', mv(3, 1, 2))).toBe('=IF(A2>0,"A3",A2)');
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

  it("moves rows (the live sheet's op), refusing a move that does not fit", () => {
    const up = applySheetOps(BASE, [{ op: "move_rows", from: 3, to: 2 }]);
    expect(up.sheet.rows).toEqual([
      ["b", 2, "=B2*2"],
      ["a", 1, "=B3*2"],
      ["sum", null, "=SUM(C2:C3)"],
    ]);
    const two = applySheetOps(BASE, [{ op: "move_rows", from: 2, count: 2, to: 3 }]);
    expect(two.sheet.rows.map((r) => r[0])).toEqual(["sum", "a", "b"]);
    expect(two.sheet.rows[0]?.[2]).toBe("=SUM(C3:C4)");
    for (const op of [
      { op: "move_rows", from: 1, to: 3 },
      { op: "move_rows", from: 5, to: 2 },
      { op: "move_rows", from: 2, count: 3, to: 3 },
      { op: "move_rows", from: 2, count: 0, to: 3 },
      { op: "move_rows", from: 2, to: 2 },
      { op: "move_rows", from: 2, to: 5 },
      { op: "move_rows", from: 2.5, to: 3 },
    ] as SheetOp[]) {
      expect(() => applySheetOps(BASE, [op]), JSON.stringify(op)).toThrow(SheetOpError);
    }
    expect(BASE.rows[0]?.[0]).toBe("a");
    // edit_sheet's own ops are unchanged: an agent moves rows by inserting and deleting.
    expect(sheetOpSchema.safeParse({ op: "move_rows", from: 3, count: 1, to: 2 }).success).toBe(
      false,
    );
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

  it("limits the formula text one call's inserts and deletes rewrite", () => {
    // 49 rows of 10 formulas of 1,990 characters: under 1 MB, but each insert or delete re-reads
    // all of it (about 90 ms for =A2+A2+...), and 200 of them took 25 s. The charge is by length,
    // so a formula of one string, quick to read, keeps this test fast.
    const f = `="${"a".repeat(1_987)}"`;
    const big: Sheet = {
      header: { columns: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, type: "text" })) },
      rows: Array.from({ length: 49 }, () => Array(10).fill(f)),
    };
    const perOp = 49 * 10 * f.length;
    const fits = Math.floor(LIMITS.maxSheetOpShiftChars / perOp);
    const churn: SheetOp[] = [];
    for (let k = 0; k < 100; k++) {
      churn.push(
        { op: "insert_rows", before: 2, count: 1 },
        { op: "delete_rows", from: 2, count: 1 },
      );
    }
    let caught: unknown;
    try {
      applySheetOps(big, churn);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SheetOpError);
    expect((caught as SheetOpError).index).toBe(fits);
    expect((caught as SheetOpError).message).toMatch(/moves the references of at most/);
    // Columns are charged the same way, and the ops that fit still apply.
    expect(() =>
      applySheetOps(
        big,
        Array.from(
          { length: fits + 1 },
          (_, k): SheetOp =>
            k % 2 === 0
              ? { op: "insert_columns", before: "A", columns: [{ name: "x" }] }
              : { op: "delete_columns", from: "A" },
        ),
      ),
    ).toThrow(/moves the references of at most/);
    expect(applySheetOps(big, churn.slice(0, fits)).sheet.rows).toHaveLength(49);
    // A sheet of short formulas takes every op a call allows.
    const small: Sheet = { ...BASE, rows: Array.from({ length: 100 }, () => ["=A2+1", 2]) };
    expect(applySheetOps(small, churn).changed.rows_inserted).toBe(100);
  });

  it("limits the cells one call writes", () => {
    const row = Array.from({ length: 3 }, () => 1);
    const values = Array.from({ length: Math.ceil(LIMITS.maxSheetOpCells / 3) + 1 }, () => row);
    expect(() => applySheetOps(BASE, [{ op: "append_rows", values }])).toThrow(
      /at most 10000 cells/,
    );
  });
});
