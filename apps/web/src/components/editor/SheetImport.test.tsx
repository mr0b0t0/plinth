// A sheet's editor: the parser's problems are listed by cell before Save, and a picked CSV or
// .xlsx file becomes the draft's JSON lines in the browser.
import { describe, expect, it } from "vitest";
import { importFile } from "./SheetImport.tsx";
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

describe("importFile", () => {
  it("turns a CSV into canonical JSON lines", async () => {
    const text = await importFile(new File(["Item,Qty\nApples,3\n"], "fruit.csv"));
    expect(text).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"},{"name":"Qty","type":"number"}]}\n["Apples",3]',
    );
  });

  it("refuses other files and broken spreadsheets", async () => {
    await expect(importFile(new File(["x"], "notes.pdf"))).rejects.toThrow(/\.csv or \.xlsx/);
    await expect(importFile(new File(["not a zip"], "book.xlsx"))).rejects.toThrow(/not an \.xlsx/);
  });
});
