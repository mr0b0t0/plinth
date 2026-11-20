// The sheet's side of the whole-draft review: which cells it marks as changed since the base.
import { parseSheet, type Sheet } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { changedCells } from "./boot.ts";

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
