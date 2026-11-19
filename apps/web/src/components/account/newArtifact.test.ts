// The helpers behind New, Import and Replace with a file: which blank artifacts this instance
// offers, where a new one opens, how a picked file is sent (as it is, for the Worker to convert),
// and how a refusal reads.
import { LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../lib/api.ts";
import { CONFIG } from "../viewer/test-utils.ts";
import {
  base64Of,
  blankBody,
  blankItems,
  CREATED_NOTE,
  formatOf,
  importProblem,
  openHref,
  readSpreadsheet,
  SpreadsheetFileError,
  sheetsAvailable,
  titleFromFileName,
} from "./newArtifact.ts";

describe("blank items", () => {
  it("offers a document and a sheet only where editing on the page works", () => {
    expect(blankItems({ ...CONFIG, inline_editing: "room" }).map((i) => i.type)).toEqual([
      "doc",
      "sheet",
    ]);
    expect(blankItems({ ...CONFIG, inline_editing: "solo" })).toHaveLength(2);
    expect(blankItems({ ...CONFIG, inline_editing: null })).toEqual([]);
    // Absent reads as null (an older Worker).
    expect(blankItems(CONFIG)).toEqual([]);
    expect(blankItems(null)).toEqual([]);
  });

  it("leaves out a type this instance does not publish now", () => {
    const config = {
      ...CONFIG,
      inline_editing: "room" as const,
      artifact_types: [
        { id: "doc" as const, available: true },
        { id: "sheet" as const, available: false },
      ],
    };
    expect(blankItems(config).map((i) => i.type)).toEqual(["doc"]);
    expect(sheetsAvailable(config)).toBe(false);
    expect(sheetsAvailable(CONFIG)).toBe(true);
  });

  it("publishes the create row with the note, and opens it in edit mode when that works", () => {
    const [doc] = blankItems({ ...CONFIG, inline_editing: "room" });
    if (!doc) throw new Error("doc offered");
    expect(blankBody(doc)).toEqual({
      title: "Untitled document",
      type: "doc",
      content: "# Untitled document\n",
      note: CREATED_NOTE,
    });
    expect(CREATED_NOTE).toBe("Created in the app");
    expect(openHref("untitled-document", { ...CONFIG, inline_editing: "room" })).toBe(
      "/a/untitled-document?edit",
    );
    expect(openHref("sales", { ...CONFIG, inline_editing: null })).toBe("/a/sales");
  });
});

describe("spreadsheet files", () => {
  it("knows .xlsx, .csv and .tsv by name", () => {
    expect(formatOf("Sales Q4.XLSX")).toBe("xlsx");
    expect(formatOf("fruit.csv")).toBe("csv");
    expect(formatOf("fruit.tsv")).toBe("csv");
    expect(formatOf("notes.pdf")).toBeNull();
    expect(formatOf("xlsx")).toBeNull();
  });

  it("titles a new sheet from its file name", () => {
    expect(titleFromFileName("sales_q4_2026.xlsx")).toBe("sales q4 2026");
    expect(titleFromFileName("  Budget   plan .csv")).toBe("Budget plan");
    expect(titleFromFileName("a.b.c.tsv")).toBe("a.b.c");
    expect(titleFromFileName(".csv")).toBe("Imported sheet");
    expect(titleFromFileName("we\u0000ird​.csv")).toBe("weird");
    expect([...titleFromFileName(`${"x".repeat(300)}.csv`)]).toHaveLength(LIMITS.maxTitleLength);
  });

  it("sends CSV and TSV as text and an .xlsx as base64", async () => {
    expect(await readSpreadsheet(new File(["Item,Qty\nApples,3\n"], "fruit.csv"))).toEqual({
      content_format: "csv",
      content: "Item,Qty\nApples,3\n",
    });
    expect(await readSpreadsheet(new File(["Item\tQty\n"], "fruit.tsv"))).toEqual({
      content_format: "csv",
      content: "Item\tQty\n",
    });
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255]);
    expect(await readSpreadsheet(new File([bytes], "book.xlsx"))).toEqual({
      content_format: "xlsx",
      content: btoa(String.fromCharCode(...bytes)),
    });
  });

  it("refuses other files, empty ones and ones past the import limit, before sending", async () => {
    await expect(readSpreadsheet(new File(["x"], "notes.pdf"))).rejects.toThrow(
      SpreadsheetFileError,
    );
    await expect(readSpreadsheet(new File([], "empty.csv"))).rejects.toThrow(/is empty/);
    const big = new File([new Uint8Array(LIMITS.maxSheetImportBytes + 1)], "big.xlsx");
    await expect(readSpreadsheet(big)).rejects.toThrow(/larger than 2 MB/);
  });

  it("base64-encodes a large file in chunks", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(atob(base64Of(bytes)).length).toBe(200_000);
    expect(atob(base64Of(bytes)).charCodeAt(1234)).toBe(1234 % 256);
  });
});

describe("importProblem", () => {
  it("reads the Worker's sentence and the cells it names", () => {
    const e = new ApiRequestError(400, "invalid_input", "This sheet has 23 problems", {
      issues: [
        { line: 7, cell: "B7", code: "cell", message: 'B7: "lots" is not a number' },
        { line: 9, code: "row", message: "line 9 is blank" },
        "not an issue",
      ],
      count: 23,
    });
    expect(importProblem(e)).toEqual({
      message: "This sheet has 23 problems",
      issues: ['B7: "lots" is not a number', "line 9 is blank"],
      count: 23,
    });
  });

  it("says plainly what happened without a server answer", () => {
    expect(importProblem(new SpreadsheetFileError("Pick a .xlsx, .csv or .tsv file."))).toEqual({
      message: "Pick a .xlsx, .csv or .tsv file.",
      issues: [],
      count: 0,
    });
    expect(importProblem(new TypeError("Failed to fetch")).message).toMatch(/Could not reach/);
  });
});
