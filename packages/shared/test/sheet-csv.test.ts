// CSV export (quoting, BOM, CRLF, the formula-injection guard) and CSV and .xlsx import.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  evaluateSheet,
  importSheet,
  numberFormatOf,
  parseCsv,
  parseSheet,
  type Sheet,
  SheetImportError,
  serializeSheet,
  sheetFromCsv,
  sheetFromXlsx,
  toCsv,
} from "../src/index.ts";

function sheetFrom(text: string): Sheet {
  const r = parseSheet(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.sheet;
}

describe("toCsv", () => {
  const s = sheetFrom(
    [
      '{"plinth":"sheet","v":1,"columns":[{"name":"=Name","type":"text"},{"name":"N","type":"number"},{"name":"When","type":"date"},{"name":"Ok","type":"checkbox"}]}',
      '["a,b",-3,"2026-01-02",true]',
      '["say \\"hi\\"","=B2*2",null,false]',
      '["line\\nbreak","=1/0"]',
      '["\'=1+1"]',
      '["+x"]',
      '["-x"]',
      '["@x"]',
      '["\\tx"]',
      '["=\\"=cmd\\""]',
    ].join("\n"),
  );
  const csv = toCsv(s, evaluateSheet(s, { budget: 10_000 }));

  it("starts with a BOM, ends lines with CRLF, header first", () => {
    expect(csv.startsWith("﻿'=Name,N,When,Ok\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("quotes commas, quotes and line breaks, and guards text that a spreadsheet would run", () => {
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toBe('"a,b",-3,2026-01-02,TRUE');
    expect(lines[2]).toBe('"say ""hi""",-6,,FALSE');
    expect(lines[3]).toBe('"line\nbreak",#DIV/0!,,');
    expect(lines[4]).toBe("'=1+1,,,");
    expect(lines[5]).toBe("'+x,,,");
    expect(lines[6]).toBe("'-x,,,");
    expect(lines[7]).toBe("'@x,,,");
    expect(lines[8]).toBe("'\tx,,,");
    // A formula whose result is text that starts with = is guarded too.
    expect(lines[9]).toBe("'=cmd,,,");
  });
});

describe("CSV import", () => {
  it("parses quotes, line breaks, CRLF and the delimiter", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n1,"x\ny",\n')).toEqual([
      ["a", "b,c", 'd"e'],
      ["1", "x\ny", ""],
    ]);
    expect(parseCsv("﻿a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("infers column types and never makes a formula", () => {
    const s = sheetFromCsv(
      "Item,Qty,When,Paid,Site,Note\nApples,3,2026-01-02,TRUE,https://a.example,=SUM(1)\nPears,4.5,2026-01-03,false,https://b.example,'=x\n",
    );
    expect(s.header.columns.map((c) => c.type)).toEqual([
      "text",
      "number",
      "date",
      "checkbox",
      "url",
      "text",
    ]);
    expect(s.rows[0]).toEqual(["Apples", 3, "2026-01-02", true, "https://a.example", "'=SUM(1)"]);
    // The ' a CSV export puts before = is dropped, and the text stays literal.
    expect(s.rows[1]?.[5]).toBe("'=x");
  });

  it("round-trips its own export", () => {
    const s = sheetFrom(
      [
        '{"plinth":"sheet","v":1,"columns":[{"name":"T","type":"text"},{"name":"N","type":"number"}]}',
        '["\'=x",1]',
        '["plain",2]',
      ].join("\n"),
    );
    const back = sheetFromCsv(toCsv(s, evaluateSheet(s, { budget: 1000 })));
    expect(back.rows).toEqual([
      ["'=x", 1],
      ["plain", 2],
    ]);
  });

  it("refuses files a sheet cannot hold", () => {
    expect(() => sheetFromCsv("")).toThrow(SheetImportError);
    const wide = `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(",")}\n`;
    expect(() => sheetFromCsv(wide)).toThrow(/at most 100 columns/);
  });
});

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (globalThis as unknown as { btoa(s: string): string }).btoa(bin);
}

function xlsx(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

const WORKBOOK = {
  "xl/workbook.xml":
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    "<sst><si><t>Item</t></si><si><t>Price</t></si><si><r><t>Ap</t></r><r><t>ples</t></r><rPh><t>x</t></rPh></si><si><t>When</t></si></sst>",
  "xl/styles.xml":
    '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="&quot;€&quot;#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>',
};

describe(".xlsx import", () => {
  it("reads the first sheet: strings, numbers, formats, dates, formulas, widths and panes", () => {
    const bytes = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetViews><sheetView><pane xSplit="1" ySplit="1" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="20"/></cols><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c><c r="D1" t="inlineStr"><is><t>Total</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>1.5</v></c><c r="C2" s="2"><v>46023</v></c><c r="D2" t="str"><f>_xlfn.CONCAT(A2,"!")</f><v>Apples!</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>=evil</t></is></c><c r="B3" s="1"><v>2</v></c><c r="D3" t="str"><f>WEBSERVICE("https://x")</f><v>7</v></c></row>' +
        "</sheetData></worksheet>",
    });
    const s = sheetFromXlsx(bytes);
    expect(s.header.columns).toEqual([
      { name: "Item", type: "text", width: 145 },
      {
        name: "Price",
        type: "number",
        format: { style: "currency", currency: "EUR", decimals: 2 },
      },
      { name: "When", type: "date" },
      { name: "Total", type: "text" },
    ]);
    expect(s.header.freeze).toEqual({ cols: 1 });
    expect(s.rows[0]).toEqual(["Apples", 1.5, "2026-01-01", '=CONCAT(A2,"!")']);
    // Text stays text; a formula outside the allowlist keeps only its cached value.
    expect(s.rows[1]).toEqual(["'=evil", 2, null, "7"]);
    expect(parseSheet(serializeSheet(s)).ok).toBe(true);
  });

  it("refuses what it cannot read safely", () => {
    expect(() => sheetFromXlsx(new Uint8Array([1, 2, 3]))).toThrow(/not an .xlsx/);
    const doctype = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml":
        '<!DOCTYPE x [<!ENTITY a "b">]><worksheet><sheetData/></worksheet>',
    });
    expect(() => sheetFromXlsx(doctype)).toThrow(/DOCTYPE/);
    const bomb = zipSync(
      {
        ...Object.fromEntries(Object.entries(WORKBOOK).map(([k, v]) => [k, strToU8(v)])),
        "xl/worksheets/sheet1.xml": new Uint8Array(30 * 1024 * 1024),
      },
      { level: 9 },
    );
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(() => sheetFromXlsx(bomb)).toThrow(/expands to more than 24 MB/);
  });

  it("maps number formats", () => {
    expect(numberFormatOf("#14")).toBe("date");
    expect(numberFormatOf("#10")).toEqual({ style: "percent", decimals: 2 });
    expect(numberFormatOf("yyyy-mm-dd")).toBe("date");
    expect(numberFormatOf("[$USD] #,##0.00")).toEqual({
      style: "currency",
      currency: "USD",
      decimals: 2,
    });
    expect(numberFormatOf("[$-409]#,##0")).toEqual({ style: "plain" });
    expect(numberFormatOf("0.0%")).toEqual({ style: "percent", decimals: 1 });
  });

  it("importSheet returns canonical text for CSV and base64 .xlsx", () => {
    expect(importSheet("A,B\n1,2\n", "csv")).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"A","type":"number"},{"name":"B","type":"number"}]}\n[1,2]',
    );
    const b64 = base64(
      xlsx({
        ...WORKBOOK,
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>4</v></c></row></sheetData></worksheet>',
      }),
    );
    expect(importSheet(b64, "xlsx")).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"number"}]}\n[4]',
    );
    expect(() => importSheet("not base64!", "xlsx")).toThrow(/base64/);
  });
});
