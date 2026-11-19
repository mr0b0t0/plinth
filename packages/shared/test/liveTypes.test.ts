// The live-editing rules per type (#36): every type with `edit: "live"` has rules; a doc's draft
// takes any lines that do not make it start like an HTML document; a sheet's draft takes only
// valid, canonical rows and a header with the same number of columns, re-checks every row when the
// header changes, changes its line count by a text edit only by appending, and moves rows and
// columns only through applySheetStruct, which both sides run to the same lines; only a doc's
// draft is ever merged.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TYPES,
  applySheetStruct,
  escapeHtmlDocumentStarts,
  HTML_DOCUMENT_RE,
  isLiveType,
  LIMITS,
  LIVE_TYPE_RULES,
  liveDocClientFrameSchema,
  liveDocTooLarge,
  liveReplacesNote,
  liveRules,
  liveSheetTooLarge,
  parseSheet,
  serializeSheet,
  sheetHeaderLine,
  sheetRowLine,
  TYPE_REGISTRY,
  versionRange,
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
  it("cover exactly the types with edit: live", () => {
    const live = ARTIFACT_TYPES.filter((t) => isLiveType(TYPE_REGISTRY[t]));
    expect(live).toEqual(["doc", "sheet"]);
    expect(ARTIFACT_TYPES.map((t) => TYPE_REGISTRY[t].edit)).toEqual([
      "ask",
      "live",
      "ask",
      "ask",
      "ask",
      "live",
      "board",
    ]);
    expect(Object.keys(LIVE_TYPE_RULES).sort()).toEqual([...live].sort());
    expect(liveRules("html")).toBeNull();
    expect(liveRules("constructor")).toBeNull();
    expect(liveRules("__proto__")).toBeNull();
  });

  it("a doc takes any lines, within its size", () => {
    const doc = liveRules("doc");
    expect(doc?.checkEdit(["# A", ""], 0, 1, ["<script>", ""])).toBeNull();
    expect(doc?.valid("anything")).toBe(true);
    expect(doc?.struct).toBeNull();
    expect(doc?.tooLarge("a".repeat(LIMITS.maxDocBytes + 1))).toBe(true);
    expect(liveDocTooLarge("\n".repeat(LIMITS.maxLiveDocLines))).toBe(true);
  });

  it("a doc never starts like an HTML document, as the stager checks", () => {
    const doc = liveRules("doc");
    if (!doc) throw new Error("no doc rules");
    for (const head of ["<html>", "<!DOCTYPE html>", "  <html lang=en>", "<HTML>", "<html"]) {
      // Typed as the first block, or left first by deleting the block above it.
      const lines = ["# Intro", "", "Text"];
      const ins = head === "<html" ? ["<html", "x"] : [head];
      expect(doc.checkEdit(lines, 0, 1, ins), head).toBe("invalid");
      expect(doc.checkEdit(["# Intro", "", head, "x"], 0, 2, []), head).toBe("invalid");
      expect(doc.valid(`${head}\nmore`), head).toBe(false);
    }
    // Blank lines first, then the start of a document.
    expect(doc.checkEdit(["", "", "# A"], 2, 1, ["<html>"])).toBe("invalid");
    // `<html` alone at the very end is not a document start (the regex wants a character after).
    expect(doc.checkEdit([""], 0, 1, ["<html"])).toBeNull();
    // An edit after the first block is never refused by this rule.
    expect(doc.checkEdit(["# A", "", "b"], 2, 1, ["<html>"])).toBeNull();
    // Escaped, it renders the same and passes.
    expect(doc.checkEdit(["# A"], 0, 1, ["\\<html> basics"])).toBeNull();
    expect(doc.valid("\\<html> basics")).toBe(true);
    expect(doc.valid("text <html> later")).toBe(true);
  });

  it("checkEdit and valid agree with the stager's regex on random texts", () => {
    const doc = liveRules("doc");
    if (!doc) throw new Error("no doc rules");
    const parts = [
      "",
      " ",
      "\n",
      "<html>",
      "<!doctype html>",
      "<html",
      "# A",
      "x",
      "\\<html>",
      "<p>",
    ];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const text = Array.from({ length: 1 + rand(5) }, () => parts[rand(parts.length)]).join("");
      expect(doc.valid(text), JSON.stringify(text)).toBe(!HTML_DOCUMENT_RE.test(text));
      // The edit that writes the whole text, from nothing.
      const refused = doc.checkEdit([""], 0, 1, text.split("\n")) !== null;
      expect(refused, JSON.stringify(text)).toBe(HTML_DOCUMENT_RE.test(text));
    }
  });

  it("toLive and fromLive are the identity for docs and sheets; nothing is unpublishable", () => {
    for (const t of ["doc", "sheet"]) {
      const r = liveRules(t);
      for (const s of ["", "# A\n", LINES.join("\n")]) {
        expect(r?.fromLive(r.toLive(s))).toBe(s);
        expect(r?.unpublishable(s)).toBeNull();
      }
    }
  });
});

describe("sheet edits", () => {
  it("takes a valid row in its canonical spelling", () => {
    expect(sheet.checkEdit(LINES, 1, 1, ['["Apples",4,"=B2*2"]'])).toBeNull();
    // Insert a new row at the end.
    expect(sheet.checkEdit(LINES, 4, 0, ['["Plums",1]'])).toBeNull();
  });

  it("changes the line count only by appending rows at the end", () => {
    // A row in the middle moves only through a struct op, which rewrites the references it shifts.
    expect(sheet.checkEdit(LINES, 2, 1, [])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 2, 0, ['["Plums",1]'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 1, 1, ['["a",1]', '["b",2]'])).toBe("invalid");
    expect(sheet.checkEdit(LINES, 3, 1, [])).toBe("invalid");
    // The same count anywhere, or more lines ending at the last one (a paste past the end).
    expect(sheet.checkEdit(LINES, 2, 1, ['["Plums",1]'])).toBeNull();
    expect(sheet.checkEdit(LINES, 3, 1, ['["Sum",null,"=SUM(C2:C3)"]', '["x",1]'])).toBeNull();
    expect(sheet.checkEdit(LINES, 4, 0, ['["x",1]', '["y",2]'])).toBeNull();
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
    // The header's lease is line 0: a row put in with it would shift every row below.
    expect(sheet.checkEdit(LINES, 0, 1, [renamed, '["x"]'])).toBe("invalid");
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

describe("struct op tables", () => {
  it("a sheet takes its four ops, touches every lease, and applies them as the frames do", () => {
    const s = sheet.struct;
    if (!s) throw new Error("no struct rules");
    expect([...s.kinds]).toEqual([
      "insert_rows",
      "delete_rows",
      "insert_columns",
      "delete_columns",
    ]);
    const op = { op: "insert_rows", before: 3, count: 1 } as const;
    expect(s.touches(LINES, op)).toBe("all");
    expect(s.apply(LINES, op)).toEqual({ lines: applySheetStruct(LINES, op) });
    expect(s.apply(LINES, { op: "delete_rows", from: 9, count: 1 })).toEqual({ error: "invalid" });
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

describe("merging", () => {
  it("a doc's draft is merged with a version published meanwhile; a sheet's never is", () => {
    expect(liveRules("doc")?.merge).toBe("lines");
    expect(sheet.merge).toBe("review");
    // Only docs merge.
    for (const [t, r] of Object.entries(LIVE_TYPE_RULES)) {
      expect(r?.merge === "lines", t).toBe(t === "doc");
    }
  });

  it("names a range of versions", () => {
    expect(versionRange(6, 6)).toBe("v6");
    expect(versionRange(6, 7)).toBe("v6 to v7");
    expect(liveReplacesNote("Edited on the page", 6, 7)).toBe(
      "Edited on the page. Replaces the changes in v6 to v7.",
    );
    const long = liveReplacesNote("x".repeat(LIMITS.maxNoteLength), 6, 17);
    expect(long.length).toBeLessThanOrEqual(LIMITS.maxNoteLength);
    expect(long.endsWith(". Replaces the changes in v6 to v17.")).toBe(true);
  });

  it("names the version a sheet's page edits replace, after the editor's own note, within the limit", () => {
    expect(liveReplacesNote("Edited on the page", 6)).toBe(
      "Edited on the page. Replaces the changes in v6.",
    );
    expect(liveReplacesNote("Counted again. ", 12)).toBe(
      "Counted again. Replaces the changes in v12.",
    );
    expect(liveReplacesNote("  ", 2)).toBe("Replaces the changes in v2.");
    const long = liveReplacesNote("x".repeat(LIMITS.maxNoteLength), 7);
    expect(long.length).toBeLessThanOrEqual(LIMITS.maxNoteLength);
    expect(long.endsWith(". Replaces the changes in v7.")).toBe(true);
    // A cut never leaves half of a surrogate pair.
    const emoji = liveReplacesNote("😀".repeat(LIMITS.maxNoteLength), 7);
    expect(emoji.length).toBeLessThanOrEqual(LIMITS.maxNoteLength);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("the leading < escape", () => {
  it("escapes <html and <!doctype html at the start of every top-level block", () => {
    expect(escapeHtmlDocumentStarts("<html> basics")).toEqual({ text: "\\<html> basics", at: [0] });
    expect(escapeHtmlDocumentStarts("Intro\n\n<html> basics\n\n  <!DOCTYPE html> too").text).toBe(
      "Intro\n\n\\<html> basics\n\n  \\<!DOCTYPE html> too",
    );
    expect(escapeHtmlDocumentStarts("<html").text).toBe("\\<html");
    // Not a block start (a paragraph's second line), inside fenced code, or indented code.
    for (const t of ["Intro\n<html>", "```\n<html>\n```", "~~~\n\n<html>\n~~~", "\n\n    <html>"]) {
      expect(escapeHtmlDocumentStarts(t).text, t).toBe(t);
    }
    // After a fence closes, a new block starts.
    expect(escapeHtmlDocumentStarts("```\nx\n```\n<html>").text).toBe("```\nx\n```\n\\<html>");
    // Other tags are left alone.
    expect(escapeHtmlDocumentStarts("<div>\n\n<htmlx>").text).toBe("<div>\n\n<htmlx>");
  });

  it("every escaped block can become the doc's first block and still pass the doc rules", () => {
    const doc = liveRules("doc");
    if (!doc) throw new Error("no doc rules");
    const text = escapeHtmlDocumentStarts("Intro\n\n<html> basics\n\n<!doctype html> two").text;
    const lines = text.split("\n");
    // Delete "Intro" and its blank line: the escaped block is first now.
    expect(doc.checkEdit(lines, 0, 2, [])).toBeNull();
    expect(doc.valid(lines.slice(2).join("\n"))).toBe(true);
    expect(doc.valid(lines.slice(4).join("\n"))).toBe(true);
    // Unescaped, the same deletion is refused.
    expect(doc.checkEdit(["Intro", "", "<html> basics"], 0, 2, [])).toBe("invalid");
  });

  it("says where each backslash went in, for the caret", () => {
    const { text, at } = escapeHtmlDocumentStarts("a\n\n<html>\n\n<html>");
    expect(at).toEqual([3, 11]);
    for (const [k, i] of at.entries()) expect(text[i + k]).toBe("\\");
  });
});
