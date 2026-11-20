// The sheet file: the canonical form, every refusal (with the line and cell it names), and the
// link rule for url cells.
import { describe, expect, it } from "vitest";
import {
  a1,
  colIndex,
  colLetter,
  isSheetLinkUrl,
  LIMITS,
  literalText,
  parseA1,
  parseRange,
  parseSheet,
  serializeSheet,
} from "../src/index.ts";

const HEADER =
  '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text","width":200},{"name":"Qty","type":"number"},{"name":"Unit price","type":"number","format":{"style":"currency","currency":"EUR","decimals":2}},{"name":"Total","type":"number","format":{"style":"currency","currency":"EUR","decimals":2}},{"name":"Paid","type":"checkbox"}],"freeze":{"cols":1}}';
const BUDGET = [
  HEADER,
  '["Apples",3,1.2,"=B2*C2",true]',
  '["Pears",5,0.8,"=B3*C3",false]',
  '["Total",null,null,"=SUM(D2:D3)"]',
].join("\n");

const header = (columns: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ plinth: "sheet", v: 1, columns, ...extra });

function issues(text: string) {
  const r = parseSheet(text);
  expect(r.ok, "should be refused").toBe(false);
  return r.ok ? [] : r.errors;
}

const messages = (text: string) => issues(text).map((i) => i.message);

describe("addresses", () => {
  it("converts letters and A1 references", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(99)).toBe("CV");
    expect(colIndex("CV")).toBe(99);
    expect(colIndex("a")).toBe(0);
    expect(colIndex("A1")).toBe(-1);
    expect(parseA1("$B$7")).toEqual({ row: 7, col: 1, rowAbs: true, colAbs: true });
    expect(parseA1("B0")).toBeNull();
    expect(a1(7, 1)).toBe("B7");
    expect(parseRange("D20:A1")).toEqual({ r1: 1, c1: 0, r2: 20, c2: 3 });
    expect(parseRange("B:D")).toMatchObject({ r1: 1, c1: 1, c2: 3 });
    expect(parseRange("2:50")).toMatchObject({ r1: 2, c1: 0, r2: 50 });
    expect(parseRange("B7")).toEqual({ r1: 7, c1: 1, r2: 7, c2: 1 });
    expect(parseRange("A1:B")).toBeNull();
  });
});

describe("the sheet file", () => {
  it("round-trips to one canonical spelling", () => {
    const r = parseSheet(BUDGET);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(serializeSheet(r.sheet)).toBe(BUDGET);
    const padded = parseSheet(`${BUDGET.slice(0, -1)},null]\n`);
    expect(padded.ok && serializeSheet(padded.sheet)).toBe(BUDGET);
    const messy = [
      JSON.stringify({
        freeze: { cols: 1 },
        columns: [
          { type: "number", name: "N", format: { decimals: 1, style: "plain" } },
          { name: "T" },
        ],
        v: 1,
        plinth: "sheet",
      }),
      "[1, null]",
      "[]",
      '[null,"x"]',
      "",
    ].join("\n");
    const m = parseSheet(messy);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const canonical = serializeSheet(m.sheet);
    expect(canonical).toBe(
      [
        '{"plinth":"sheet","v":1,"columns":[{"name":"N","type":"number","format":{"style":"plain","decimals":1}},{"name":"T","type":"text"}],"freeze":{"cols":1}}',
        "[1]",
        "[]",
        '[null,"x"]',
      ].join("\n"),
    );
    const again = parseSheet(canonical);
    expect(again.ok && serializeSheet(again.sheet)).toBe(canonical);
  });

  it("refuses header problems, naming them", () => {
    expect(messages('{"plinth":"sheet","v":1,"columns":[{"name":"A","colour":"red"}]}')).toEqual([
      'line 1, column 1: unknown key "colour"',
    ]);
    expect(messages('{"plinth":"sheet","v":2,"columns":[{"name":"A"}]}')).toEqual([
      'line 1: "v" must be 1',
    ]);
    expect(messages(header([]))[0]).toMatch(/1 to 100 columns/);
    expect(messages(header(Array.from({ length: 101 }, (_, i) => ({ name: `c${i}` }))))[0]).toMatch(
      /1 to 100 columns/,
    );
    expect(messages(header([{ name: "S", type: "select", options: ["a", "a"] }]))[0]).toMatch(
      /listed twice/,
    );
    expect(messages(header([{ name: "S", type: "select" }]))[0]).toMatch(/lists 1 to 100 options/);
    expect(messages(header([{ name: "N", type: "text", format: { style: "plain" } }]))[0]).toMatch(
      /only for number columns/,
    );
    expect(
      messages(header([{ name: "N", type: "number", format: { style: "currency" } }]))[0],
    ).toMatch(/three-letter currency code/);
    expect(messages(header([{ name: "a‮b" }]))[0]).toMatch(/control or invisible/);
    expect(messages(header([{ name: "x", width: 10 }]))[0]).toMatch(/40 to 800/);
    expect(messages(header([{ name: "x" }], { freeze: { cols: 6 } }))[0]).toMatch(/freeze/);
    expect(messages("Item,Qty\nApples,3")[0]).toMatch(/line 1 is not JSON/);
  });

  it("refuses cells that do not fit their column, naming the cell", () => {
    const h = header([
      { name: "Qty", type: "number" },
      { name: "When", type: "date" },
      { name: "Done", type: "checkbox" },
      { name: "Pick", type: "select", options: ["a", "b"] },
      { name: "Link", type: "url" },
    ]);
    const row = (cells: unknown[]) => `${h}\n${JSON.stringify(cells)}`;
    expect(messages(row(["abc"]))).toEqual(['A2: "abc" is not a number (column Qty is number)']);
    expect(messages(row([null, "2026-02-30"]))[0]).toMatch(/^B2: "2026-02-30" is not a date/);
    expect(messages(row([null, "1900-02-28"]))[0]).toMatch(/^B2: .* is not a date/);
    expect(parseSheet(row([null, "1900-03-01"])).ok).toBe(true);
    expect(messages(row([null, null, "yes"]))[0]).toMatch(/^C2: "yes" is not true or false/);
    expect(messages(row([null, null, null, "c"]))[0]).toMatch(/^D2: "c" is not one of the options/);
    for (const bad of [
      "javascript:alert(1)",
      "//host/x",
      "https://a b",
      "data:text/html,x",
      "https:x",
      "java\tscript:x",
    ]) {
      expect(messages(row([null, null, null, null, bad]))[0], bad).toMatch(
        /^E2: .* is not an http:, https: or mailto: link/,
      );
    }
    expect(parseSheet(row([null, null, null, null, "mailto:a@b.example"])).ok).toBe(true);
    expect(messages(`${h}\n[1e999]`)).toEqual(["A2: numbers must be finite"]);
    expect(messages(`${h}\n[1,null,null,null,null,6]`)[0]).toMatch(
      /6 cells, but the sheet has 5 columns/,
    );
    expect(messages(`${h}\n{"a":1}`)[0]).toMatch(/a row is a JSON array/);
    expect(messages(`${h}\n["=SUMX(1)"]`)[0]).toMatch(/^A2: SUMX is not a function sheets support/);
    expect(messages(`${h}\n[1]\n\n[2]`)).toEqual(["line 3 is blank: an empty row is []"]);
  });

  it("keeps text literal after a leading quote", () => {
    const h = header([{ name: "T" }]);
    expect(parseSheet(`${h}\n["'=HYPERLINK(\\"x\\")"]`).ok).toBe(true);
    expect(literalText("'=x")).toBe("=x");
    expect(literalText("plain")).toBe("plain");
  });

  it("enforces the size limits", () => {
    const h = header([{ name: "T" }]);
    const big = "x".repeat(LIMITS.maxSheetCellChars + 1);
    expect(messages(`${h}\n${JSON.stringify([big])}`)[0]).toMatch(/at most 4000 characters/);
    const wide = header(Array.from({ length: 10 }, (_, i) => ({ name: `c${i}` })));
    const longRow = JSON.stringify(Array.from({ length: 10 }, () => "y".repeat(3999)));
    expect(messages(`${wide}\n${longRow}`)[0]).toMatch(/is over 32 KiB/);
    const many = [h, ...Array.from({ length: LIMITS.maxSheetRows + 1 }, () => "[]")].join("\n");
    expect(messages(many)[0]).toMatch(/at most 10000 rows/);
    const ok = [h, ...Array.from({ length: LIMITS.maxSheetRows }, () => "[]")].join("\n");
    expect(parseSheet(ok).ok).toBe(true);
  });

  it("lists at most 20 issues and counts them all", () => {
    const h = header([{ name: "N", type: "number" }]);
    const text = [h, ...Array.from({ length: 30 }, () => '["x"]')].join("\n");
    const r = parseSheet(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(20);
    expect(r.count).toBe(30);
    expect(r.errors[0]).toMatchObject({ line: 2, cell: "A2", code: "cell" });
  });

  it("allows only absolute http, https and mailto links", () => {
    expect(isSheetLinkUrl("https://example.com/a?b#c")).toBe(true);
    expect(isSheetLinkUrl("HTTP://EXAMPLE.COM")).toBe(true);
    expect(isSheetLinkUrl("javascript&#58;alert(1)")).toBe(false);
    expect(isSheetLinkUrl("https://")).toBe(false);
    expect(isSheetLinkUrl(`https://a.example/${"x".repeat(2000)}`)).toBe(false);
    expect(isSheetLinkUrl("https://a.example/​")).toBe(false);
  });
});
