// A sheet's editor: the parser's problems are listed by cell before Save.
import { describe, expect, it } from "vitest";
import { sourceProblems } from "./sourceChecks.ts";

describe("sheet source checks", () => {
  it("name the cell and the problem", () => {
    const text = [
      '{"plinth":"sheet","v":1,"columns":[{"name":"Qty","type":"number"}]}',
      '["three"]',
      "",
      "[1]",
    ].join("\n");
    expect(sourceProblems("sheet", text)).toEqual([
      { path: "A2", message: 'A2: "three" is not a number (column Qty is number)' },
      { path: "line 3", message: "line 3 is blank: an empty row is []" },
    ]);
    expect(
      sourceProblems("sheet", '{"plinth":"sheet","v":1,"columns":[{"name":"A"}]}\n["x"]'),
    ).toEqual([]);
  });
});
