// The helpers behind New, Import and Replace with a file: which blank artifacts this instance
// offers, where a new one opens, how a picked file is sent (as it is, for the Worker to convert),
// how a CSV's bytes are read, what the import would leave out in plain words, and how a refusal
// reads.
import { LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../lib/api.ts";
import { CONFIG } from "../viewer/test-utils.ts";
import {
  base64Of,
  blankBody,
  blankItems,
  CREATED_NOTE,
  cleanFileName,
  decodeCsv,
  formatOf,
  importedNote,
  importProblem,
  openHref,
  plainCause,
  readSpreadsheet,
  SpreadsheetFileError,
  sheetsAvailable,
  titleFromFileName,
  warningText,
} from "./newArtifact.ts";

describe("blank items", () => {
  it("offers a document, a deck and a sheet only where editing on the page works", () => {
    expect(blankItems({ ...CONFIG, inline_editing: "room" }).map((i) => i.type)).toEqual([
      "doc",
      "slides",
      "sheet",
    ]);
    expect(blankItems({ ...CONFIG, inline_editing: "solo" })).toHaveLength(3);
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
        { id: "slides" as const, available: false },
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
      sent: { content_format: "csv", content: "Item,Qty\nApples,3\n" },
      warnings: [],
    });
    expect(await readSpreadsheet(new File(["Item\tQty\n"], "fruit.tsv"))).toEqual({
      sent: { content_format: "csv", content: "Item\tQty\n" },
      warnings: [],
    });
    // A file the check cannot read goes as it is, with no warnings: the Worker explains a refusal.
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255]);
    expect(await readSpreadsheet(new File([bytes], "book.xlsx"))).toEqual({
      sent: { content_format: "xlsx", content: btoa(String.fromCharCode(...bytes)) },
      warnings: [],
    });
  });

  it("gives the import's warnings with the file, the encoding's first", async () => {
    const long = "h".repeat(120);
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(`${long},Qty\nCaf`),
      0xe9,
      ...new TextEncoder().encode(",3\n"),
    ]);
    const read = await readSpreadsheet(new File([bytes], "menu.csv"));
    expect(read.sent.content).toBe(`${long},Qty\nCafé,3\n`);
    expect(read.warnings).toEqual([
      { code: "not_utf8", encoding: "windows-1252" },
      { code: "headers_truncated", count: 1, max: 100 },
    ]);
  });

  it("reads a CSV as UTF-8, UTF-16 by its BOM, or else Windows-1252 with a warning", () => {
    const utf8 = new TextEncoder().encode("\uFEFFItem\nCafé — 5 €\n");
    expect(decodeCsv(utf8)).toEqual({ text: "Item\nCafé — 5 €\n", warnings: [] });
    const le = new Uint8Array([0xff, 0xfe, ...[..."Item\né"].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeCsv(le)).toEqual({ text: "Item\né", warnings: [] });
    const be = new Uint8Array([0xfe, 0xff, ...[..."Item"].flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(decodeCsv(be)).toEqual({ text: "Item", warnings: [] });
    // cp1252: é is 0xE9, € is 0x80, — is 0x97, ’ is 0x92, Ÿ is 0x9F; never U+FFFD.
    const cp1252 = new Uint8Array([
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x97, 0x20, 0x35, 0x80, 0x92, 0x9f, 0x81,
    ]);
    expect(decodeCsv(cp1252)).toEqual({
      text: "Café — 5€’Ÿ\u0081",
      warnings: [{ code: "not_utf8", encoding: "windows-1252" }],
    });
  });

  it("drops control and bidi characters from a file name it shows or notes", () => {
    expect(cleanFileName("sales.csv")).toBe("sales.csv");
    // C0, C1, LRM/RLM, the embeddings and overrides, the isolates, and the Arabic letter mark.
    const bad =
      "\u0001\u001F\u007F\u0080\u009F\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C";
    expect(cleanFileName(`in${bad}voice.csv`)).toBe("invoice.csv");
    // "invoice" + U+202E + "vsc.xlsx" reads as "invoicexslx.csv" without the cleaning.
    expect(cleanFileName("invoice\u202Evsc.xlsx")).toBe("invoicevsc.xlsx");
    expect(importedNote("\u202Bq4\u0007.xlsx")).toBe("Imported from q4.xlsx");
    // Letters, accents and other scripts stay.
    expect(cleanFileName("Résumé — 東京.csv")).toBe("Résumé — 東京.csv");
    expect(cleanFileName("\u202E")).toBe("the file");
  });
});

describe("warningText", () => {
  it("says each warning in plain words, singular and plural", () => {
    expect(warningText({ code: "not_utf8", encoding: "windows-1252" })).toBe(
      "The file is not UTF-8, so it is read as Windows-1252. Check accented letters.",
    );
    expect(warningText({ code: "other_sheets", count: 1, names: ["Q3"] })).toBe(
      "Only the first sheet is used; “Q3” is left out.",
    );
    expect(warningText({ code: "other_sheets", count: 2, names: ["Q3", "Notes"] })).toBe(
      "Only the first sheet is used; “Q3” and “Notes” are left out.",
    );
    expect(warningText({ code: "other_sheets", count: 3, names: ["A", "B", "C"] })).toBe(
      "Only the first sheet is used; “A”, “B” and “C” are left out.",
    );
    expect(warningText({ code: "other_sheets", count: 30, names: ["A", "B", "C", "D", "E"] })).toBe(
      "Only the first sheet is used; “A”, “B”, “C” and 27 more are left out.",
    );
    // Names the file left blank are counted, never shown as “”.
    expect(warningText({ code: "other_sheets", count: 2, names: ["", ""] })).toBe(
      "Only the first sheet is used; 2 other sheets are left out.",
    );
    expect(warningText({ code: "other_sheets", count: 1, names: [""] })).toBe(
      "Only the first sheet is used; 1 other sheet is left out.",
    );
    expect(warningText({ code: "formulas_as_values", count: 1 })).toBe(
      "1 formula becomes a plain value.",
    );
    expect(warningText({ code: "formulas_as_values", count: 12 })).toBe(
      "12 formulas become plain values.",
    );
    expect(warningText({ code: "headers_truncated", count: 1, max: 100 })).toBe(
      "1 column name is cut to 100 characters.",
    );
    expect(warningText({ code: "headers_truncated", count: 3, max: 100 })).toBe(
      "3 column names are cut to 100 characters.",
    );
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

  it("shows a conversion refusal as its plain cause, without the lead or parser internals", () => {
    const e = new ApiRequestError(
      400,
      "invalid_input",
      "The xlsx file could not be imported: This is not an .xlsx file (no ZIP directory)",
    );
    expect(importProblem(e).message).toBe("This is not an .xlsx file.");
    expect(plainCause("The csv file could not be imported: the file is empty")).toBe(
      "The file is empty.",
    );
    expect(plainCause("Encrypted .xlsx files are not supported")).toBe(
      "Encrypted .xlsx files are not supported",
    );
    expect(plainCause("The xlsx file could not be imported: ")).toBe(
      "The xlsx file could not be imported: ",
    );
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
