// The sheet review's pure parts (#36): what each side shows as a grid (changed cells marked), and
// the plain-language lists of what changed since the draft's base.
import { applySheetStruct } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  CHANGE_LIST_MAX,
  changeCount,
  changedColumns,
  describeSheetChanges,
  offGridChanges,
  onlyColumns,
  REVIEW_MAX_ROWS,
  reviewGrid,
  summarize,
} from "./sheetReview.ts";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text" },
    { name: "Qty", type: "number" },
    { name: "Paid", type: "checkbox" },
  ],
});
const LINES = [HEADER, '["Apples",3,true]', '["Pears",5]', '["Plums"]', '["Total","=SUM(B2:B4)"]'];
const SHEET = LINES.join("\n");
const withLine = (i: number, line: string) => LINES.map((l, k) => (k === i ? line : l)).join("\n");

describe("describeSheetChanges", () => {
  it("lists cells changed in place, by address, with what they held and hold", () => {
    expect(describeSheetChanges(SHEET, SHEET)).toEqual({ items: [], more: 0 });
    expect(describeSheetChanges(SHEET, withLine(2, '["Pears",7,true]')).items).toEqual([
      "B3: 5 → 7",
      "C3: empty → checked",
    ]);
    expect(describeSheetChanges(SHEET, withLine(4, '["Total","=SUM(B2:B3)"]')).items).toEqual([
      "B5: =SUM(B2:B4) → =SUM(B2:B3)",
    ]);
    expect(describeSheetChanges(SHEET, withLine(3, '["Plums",2]')).items).toEqual([
      "B4: empty → 2",
    ]);
  });

  it("lists rows added and removed, named by their first cell", () => {
    const appended = `${SHEET}\n["Figs",1]`;
    expect(describeSheetChanges(SHEET, appended).items).toEqual(["Row 6 added (Figs)"]);
    const lines = applySheetStruct(LINES, { op: "delete_rows", from: 4, count: 1 }) as string[];
    // A line diff: the total's formula moved with it, so its old line is removed too.
    expect(describeSheetChanges(SHEET, lines.join("\n")).items).toEqual([
      "Row 4 removed (Plums)",
      "Row 5 removed (Total)",
      "Row 4 added (Total)",
    ]);
    const inserted = applySheetStruct(LINES, { op: "insert_rows", before: 2, count: 1 });
    expect(describeSheetChanges(SHEET, (inserted as string[]).join("\n")).items).toContain(
      "Row 2 added (empty)",
    );
  });

  it("lists column changes before rows", () => {
    const renamed = SHEET.replace('"name":"Qty"', '"name":"Count"');
    expect(describeSheetChanges(SHEET, renamed).items).toEqual(["Column B renamed: Qty → Count"]);
    const typed = SHEET.replace(
      '{"name":"Paid","type":"checkbox"}',
      '{"name":"Paid","type":"text"}',
    );
    expect(describeSheetChanges(SHEET, typed).items[0]).toBe(
      "Column C (Paid): type changed to text",
    );
    const wide = SHEET.replace(
      '{"name":"Item","type":"text"}',
      '{"name":"Item","type":"text","width":200}',
    );
    expect(describeSheetChanges(SHEET, wide).items).toEqual(["Column A (Item): settings changed"]);
    const added = applySheetStruct(LINES, {
      op: "insert_columns",
      before: "C",
      columns: [{ name: "Note", type: "text" }],
    }) as string[];
    const list = describeSheetChanges(SHEET, added.join("\n")).items;
    expect(list[0]).toBe("Column added: Note");
    expect(list).not.toContain("Column removed: Paid");
  });

  it("caps the list and counts the rest; the summary names the first few", () => {
    const many = [HEADER, ...Array.from({ length: 300 }, (_, i) => `["r${i}",${i}]`)].join("\n");
    const list = describeSheetChanges(HEADER, many);
    expect(list.items).toHaveLength(CHANGE_LIST_MAX);
    expect(list.more).toBe(100);
    expect(changeCount(list)).toBe(300);
    expect(summarize(list)).toBe(
      "Row 2 added (r0), Row 3 added (r1), Row 4 added (r2), and 297 more",
    );
    expect(summarize({ items: ["B3: 5 → 7"], more: 0 })).toBe("B3: 5 → 7");
  });

  it("quotes long cells briefly, and says so when a side is not a sheet", () => {
    const long = withLine(1, `["${"a".repeat(80)}",3,true]`);
    expect(describeSheetChanges(SHEET, long).items[0]).toBe(`A2: Apples → ${"a".repeat(39)}…`);
    expect(describeSheetChanges(SHEET, "not a sheet").items).toEqual(["The sheet changed"]);
  });
});

describe("offGridChanges", () => {
  it("names only what a grid cannot show: rows removed, a column's type or settings", () => {
    expect(offGridChanges(SHEET, withLine(2, '["Pears",7,true]')).items).toEqual([]);
    const removed = LINES.filter((_, i) => i !== 3).join("\n");
    expect(offGridChanges(SHEET, removed).items).toEqual(["Row 4 removed (Plums)"]);
    const typed = SHEET.replace(
      '{"name":"Paid","type":"checkbox"}',
      '{"name":"Paid","type":"text"}',
    );
    expect(offGridChanges(SHEET, typed).items).toEqual(["Column C (Paid): type changed to text"]);
    expect(offGridChanges(SHEET, SHEET.replace('"name":"Qty"', '"name":"Count"')).items).toEqual(
      [],
    );
  });
});

describe("reviewGrid", () => {
  it("shows each cell as the sheet does, formulas computed, and marks rows changed since the base", () => {
    const g = reviewGrid(withLine(2, '["Pears",7]'), SHEET);
    expect(g?.columns).toEqual(["A · Item", "B · Qty", "C · Paid"]);
    expect(g?.rows.map((r) => r.n)).toEqual([2, 3, 4, 5]);
    expect(g?.rows.map((r) => r.changed)).toEqual([false, true, false, false]);
    // Only the cell that changed is marked, not its whole row.
    expect(g?.rows[1]?.cells.map((c) => c.changed)).toEqual([false, true, false]);
    expect(g?.columnsChanged).toEqual([false, false, false]);
    expect(g?.rows[0]?.cells.map((c) => c.text)).toEqual(["Apples", "3", "☑ Yes"]);
    const total = g?.rows[3]?.cells[1];
    expect(total).toEqual({ text: "10", number: true, changed: false, title: "=SUM(B2:B4)" });
    expect(g?.more).toBe(0);
    expect(reviewGrid("nope", SHEET)).toBeNull();
  });

  it("marks every cell of a row added, and a column renamed", () => {
    const appended = `${SHEET}\n["Figs",1]`;
    const g = reviewGrid(appended, SHEET);
    expect(g?.rows[4]?.cells.every((c) => c.changed)).toBe(true);
    const renamed = reviewGrid(SHEET.replace('"name":"Qty"', '"name":"Count"'), SHEET);
    expect(renamed?.columnsChanged).toEqual([false, true, false]);
  });

  it("shows at most REVIEW_MAX_ROWS rows and counts the rest", () => {
    const rows = Array.from({ length: REVIEW_MAX_ROWS + 20 }, (_, i) => `["r${i}"]`);
    const g = reviewGrid([HEADER, ...rows].join("\n"), null);
    expect(g?.rows).toHaveLength(REVIEW_MAX_ROWS);
    expect(g?.more).toBe(20);
    expect(g?.rows.every((r) => !r.changed)).toBe(true);
  });
});

describe("changedColumns", () => {
  it("keeps the first column and those either side changed, the same on both sides", () => {
    const mine = reviewGrid(withLine(2, '["Pears",7]'), SHEET);
    const theirs = reviewGrid(withLine(1, '["Apples",3,false]'), SHEET);
    // B on one side and C on the other: with A that is every column, so all are shown.
    expect(changedColumns(mine, theirs)).toBeNull();
    // A change in one column only: that column and the first.
    expect(changedColumns(mine, reviewGrid(SHEET, SHEET))).toEqual([0, 1]);
    const narrow = onlyColumns(mine, [0, 1]);
    expect(narrow?.columns).toEqual(["A · Item", "B · Qty"]);
    expect(narrow?.rows[1]?.cells.map((c) => c.text)).toEqual(["Pears", "7"]);
    expect(onlyColumns(mine, null)).toBe(mine);
  });

  it("keeps every column when nothing changed in a cell or the sides differ in columns", () => {
    expect(changedColumns(reviewGrid(SHEET, SHEET), reviewGrid(SHEET, SHEET))).toBeNull();
    const added = applySheetStruct(LINES, {
      op: "insert_columns",
      before: "C",
      columns: [{ name: "Note", type: "text" }],
    }) as string[];
    expect(
      changedColumns(reviewGrid(added.join("\n"), SHEET), reviewGrid(SHEET, SHEET)),
    ).toBeNull();
  });
});
