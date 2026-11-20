// The sheet's side of the whole-draft review: which cells it marks as changed since the base, and
// how its change list names a cell.
import { parseSheet, type Sheet } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { changedCells, sheetItemWords } from "./boot.ts";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text" },
    { name: "Qty", type: "number" },
  ],
});

const sheet = (...rows: string[]): Sheet => {
  const p = parseSheet([HEADER, ...rows].join("\n"));
  if (!p.ok) throw new Error("not a sheet");
  return p.sheet;
};

describe("changedCells", () => {
  const base = sheet('["Laptops",12]', '["Monitors",18]', '["Chairs",20]');

  it("lists the cells whose value changed, by A1 row and column", () => {
    expect(changedCells(base, sheet('["Laptops",12]', '["Monitors",24]', '["Chairs",20]'))).toEqual(
      [[3, 1]],
    );
  });

  it("lists every cell of an inserted row, and nothing for rows only moved down", () => {
    expect(
      changedCells(
        base,
        sheet('["Laptops",12]', '["Headsets",6]', '["Monitors",18]', '["Chairs",20]'),
      ),
    ).toEqual([
      [3, 0],
      [3, 1],
    ]);
  });

  it("lists a header cell whose column changed", () => {
    const renamed = parseSheet(
      [
        HEADER.replace('"Qty"', '"Count"'),
        '["Laptops",12]',
        '["Monitors",18]',
        '["Chairs",20]',
      ].join("\n"),
    );
    if (!renamed.ok) throw new Error("not a sheet");
    expect(changedCells(base, renamed.sheet)).toEqual([[1, 1]]);
  });

  it("lists nothing for the same sheet", () => {
    expect(changedCells(base, base)).toEqual([]);
  });
});

describe("sheetItemWords", () => {
  const priced = parseSheet(
    [
      JSON.stringify({
        plinth: "sheet",
        v: 1,
        columns: [
          { name: "Item", type: "text" },
          { name: "Qty", type: "number" },
          {
            name: "Unit price",
            type: "number",
            format: { style: "currency", currency: "EUR", decimals: 2 },
          },
        ],
      }),
      '["Headsets",6,89]',
    ].join("\n"),
  );
  if (!priced.ok) throw new Error("not a sheet");
  const at = (what: string, before?: string, after?: string) =>
    sheetItemWords({ kind: "changed", where: "Row 2, “x”", what, before, after }, priced.sheet);

  it("names a cell once, by its column and row, with its values as the grid shows them", () => {
    const euros = (n: number) =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    expect(at("C2 changed", "89", "95")).toEqual({
      label: "Unit price, row 2",
      before: euros(89),
      after: euros(95),
    });
    expect(at("B2 changed", "18", "24")).toEqual({
      label: "Qty, row 2",
      before: "18",
      after: "24",
    });
    expect(at("B2 filled in", undefined, "6")).toEqual({
      label: "Qty, row 2 filled in",
      after: "6",
    });
    expect(at("B2: calculation changed", "62", "56")?.label).toBe("Qty, row 2");
    expect(at("A2 changed", "Headsets", "Headphones")?.after).toBe("Headphones");
  });

  it("leaves every other item to the shared words", () => {
    expect(at("Row 7 added")).toBeNull();
    expect(at("“Qty”: type changed")).toBeNull();
  });
});
