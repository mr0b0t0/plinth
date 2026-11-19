// CSV export (quoting, BOM, CRLF, the formula-injection guard) and CSV and .xlsx import.
import { deflateSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  evaluateSheet,
  importSheet,
  numberFormatOf,
  parseCsv,
  parseSheet,
  readCsv,
  type Sheet,
  SheetImportError,
  serializeSheet,
  sheetFromCsv,
  sheetFromXlsx,
  toCsv,
} from "../src/index.ts";
import { inflateInSlices, readXlsx, scanXml, xmlDecode } from "../src/sheet/xlsxRead.ts";

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

  it("refuses too many rows with the row limit, however short the rows are", () => {
    const tall = `a\n${"1\n".repeat(150_000)}`;
    expect(() => sheetFromCsv(tall)).toThrow(SheetImportError);
    expect(() => sheetFromCsv(tall)).toThrow(/at most 10000 rows; this file has 150000/);
  });

  it("keeps only the rows a sheet can hold and counts the rest", () => {
    const { rows, rowCount } = readCsv('h\n1\n\n2\n"3"\n4\n5', 3);
    // The header, then the first three non-blank records (and the blank line between them).
    expect(rows).toEqual([["h"], ["1"], [""], ["2"], ["3"]]);
    expect(rowCount).toBe(5);
    expect(readCsv("a,b\n1,2\n", Number.POSITIVE_INFINITY)).toEqual({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      rowCount: 1,
    });
    // A 2 MB file of one-character rows is the row refusal with its count.
    const long = `a\n${"1\n".repeat(1_048_000)}`;
    expect(() => sheetFromCsv(long)).toThrow(/at most 10000 rows; this file has 1048000/);
  });

  it("refuses cells a 1 MB sheet cannot hold before it makes values of them", () => {
    const wide = Array.from({ length: 10_001 }, () => Array(100).fill("1").join(",")).join("\n");
    expect(() => sheetFromCsv(wide)).toThrow(SheetImportError);
    expect(() => sheetFromCsv(wide)).toThrow(/at most 1 MB; this file holds more cells/);
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

  it("keeps the header's names when the worksheet skips a blank row", () => {
    const s = sheetFromXlsx(
      xlsx({
        ...WORKBOOK,
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1</v></c></row>' +
          '<row r="4"><c r="A4" t="inlineStr"><is><t>Pears</t></is></c><c r="B4"><v>3</v></c></row>' +
          "</sheetData></worksheet>",
      }),
    );
    expect(s.header.columns.map((c) => c.name)).toEqual(["Item", "Qty"]);
    expect(s.rows).toEqual([["Apples", 1], [], ["Pears", 3]]);
  });

  it("refuses a cell reference below the row limit, before it builds anything", () => {
    for (const ref of ["A2000000", "A50000000", "A10002"]) {
      const bytes = xlsx({
        ...WORKBOOK,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row><row r="2"><c r="${ref}"><v>1</v></c></row></sheetData></worksheet>`,
      });
      expect(() => sheetFromXlsx(bytes)).toThrow(SheetImportError);
      expect(() => sheetFromXlsx(bytes)).toThrow(/at most 10000 rows under its header/);
    }
    const zero = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A0"><v>1</v></c></row></sheetData></worksheet>',
    });
    expect(() => sheetFromXlsx(zero)).toThrow(/bad row number/);
    // The last row a sheet holds is still read.
    const last = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row><row r="10001"><c r="A10001"><v>1</v></c></row></sheetData></worksheet>',
    });
    const s = sheetFromXlsx(last);
    expect(s.rows).toHaveLength(10_000);
    expect(s.rows[9_999]).toEqual([1]);
  });

  it("reads column widths only for the columns a sheet holds, whatever min and max say", () => {
    const sheet = (cols: string) =>
      xlsx({
        ...WORKBOOK,
        "xl/worksheets/sheet1.xml": `<worksheet><cols>${cols}</cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c><c r="B1" t="inlineStr"><is><t>I</t></is></c></row></sheetData></worksheet>`,
      });
    // Past 2^53 (where c++ stops changing c) and far below zero: both used to loop forever.
    for (const col of [
      '<col min="9007199254740992" max="9007199254741200" width="10"/>',
      '<col min="-1e300" max="5" width="10"/>',
      '<col min="0" max="1" width="10"/>',
      '<col min="1.5" max="2" width="10"/>',
    ]) {
      expect(readXlsx(sheet(col)).widths.size).toBe(0);
    }
    const s = sheetFromXlsx(sheet('<col min="2" max="9000000000" width="10"/>'));
    expect(s.header.columns.map((c) => c.width)).toEqual([undefined, 75]);
    expect(readXlsx(sheet('<col min="2" max="9000000000" width="10"/>')).widths.size).toBe(99);
    // Many ranges, each past the last column, add nothing; at most 100 ranges are read at all.
    const far = Array.from(
      { length: 5_000 },
      (_, k) => `<col min="${k * 101 + 101}" max="${k * 101 + 201}" width="1"/>`,
    ).join("");
    expect(readXlsx(sheet(far)).widths.size).toBe(0);
    const many = '<col min="1" max="100" width="1"/>'.repeat(5_000);
    expect(readXlsx(sheet(many)).widths.size).toBe(100);
  });

  it("scans XML in time linear in its length, refusing markup that never ends", () => {
    const parts = (xml: string) => xlsx({ ...WORKBOOK, "xl/worksheets/sheet1.xml": xml });
    const start = Date.now();
    // Each "<?" used to search to the end of the part for a "?>": quadratic, seconds at this size.
    expect(() => sheetFromXlsx(parts(`<worksheet><sheetData>${"<?".repeat(200_000)}`))).toThrow(
      /XML is damaged/,
    );
    for (const open of ["<!--", "<![CDATA[", '<c r="', "<c "]) {
      expect(() => sheetFromXlsx(parts(`<worksheet><sheetData>${open.repeat(50_000)}`))).toThrow(
        /XML is damaged/,
      );
    }
    expect(Date.now() - start).toBeLessThan(3_000);
    const events: string[] = [];
    scanXml(
      '<?xml version="1.0"?><!-- c --><a x="1 > 0" y=\'"\'>t &amp; <![CDATA[<raw>]]> 1 < 2<b/></a>',
      {
        open: (name, attrs, selfClosing) =>
          events.push(`open ${name} ${JSON.stringify(attrs)}${selfClosing ? " /" : ""}`),
        close: (name) => events.push(`close ${name}`),
        text: (s) => events.push(`text ${s}`),
      },
    );
    expect(events).toEqual([
      'open a {"x":"1 > 0","y":"\\""}',
      "text t & ",
      "text <raw>",
      "text  1 < 2",
      "open b {} /",
      "close b",
      "close a",
    ]);
  });

  it("expands entities with a loop, and only the five names and character references", () => {
    expect(xmlDecode("a&amp;b &lt;&gt;&quot;&apos; &#65;&#x42; &&amp; &amp")).toBe(
      "a&b <>\"' AB && &amp",
    );
    // Anything else stays as written: other names (constructor too), bad or too-long references.
    expect(xmlDecode("&constructor;&nbsp;&#x110000;&#0;&#X41;&#12345678;&;")).toBe(
      "&constructor;&nbsp;&#x110000;&#0;&#X41;&#12345678;&;",
    );
    expect(xmlDecode("a&amp;".repeat(1_000_000))).toBe("a&".repeat(1_000_000));
  });

  it("decodes UTF-8 that a part's inflated chunks split mid-character", () => {
    const text = "€é𝄞".repeat(500);
    // 30 rows of 5 cells of 4.5 KB of UTF-8 each: chunks of the inflated part end inside some.
    const row = `<row>${`<c t="inlineStr"><is><t>${text}</t></is></c>`.repeat(5)}</row>`;
    const s = sheetFromXlsx(
      xlsx({
        ...WORKBOOK,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${row.repeat(31)}</sheetData></worksheet>`,
      }),
    );
    expect(s.rows).toEqual(Array(30).fill(Array(5).fill(text)));
  });

  it("inflates a part a slice at a time, so a ZIP bomb stops at the cap", () => {
    // All zeros: about 40 MB from some 40 KB. Inflated in one push it would all exist at once.
    const bomb = deflateSync(new Uint8Array(40 * 1024 * 1024), { level: 9 });
    let total = 0;
    let largest = 0;
    const cap = 24 * 1024 * 1024;
    expect(() =>
      inflateInSlices(bomb, (chunk) => {
        total += chunk.length;
        largest = Math.max(largest, chunk.length);
        if (total > cap) throw new SheetImportError("cap");
      }),
    ).toThrow("cap");
    expect(largest).toBeLessThanOrEqual(2_200_000);
    expect(total).toBeLessThan(cap + 2_200_000);
    // Data that does not compress well spans many slices and comes back whole.
    let seed = 7;
    const cells = Array.from({ length: 30_000 }, () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed;
    });
    const row = (n: number[]) => `<row>${n.map((v) => `<c><v>${v}</v></c>`).join("")}</row>`;
    const rows = Array.from({ length: 300 }, (_, r) => cells.slice(r * 100, r * 100 + 100));
    const bytes = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows.map(row).join("")}</sheetData></worksheet>`,
    });
    expect(bytes.byteLength).toBeGreaterThan(100_000);
    const s = sheetFromXlsx(bytes);
    expect(s.rows).toEqual(rows.slice(1));
  });

  it("refuses cells a 1 MB sheet cannot hold before it builds the table", () => {
    // 6,000 rows of 100 one-digit cells: inside the row and column bounds and a small file, but
    // more cells than 1 MB of JSON lines holds (each costs at least two bytes).
    const row = "<c><v>1</v></c>".repeat(100);
    const bytes = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${`<row>${row}</row>`.repeat(6_000)}</sheetData></worksheet>`,
    });
    expect(bytes.byteLength).toBeLessThan(200_000);
    expect(() => sheetFromXlsx(bytes)).toThrow(/at most 1 MB; this file holds more cells/);
    // Text counts by its length: 300 cells of 3,600 characters are past 1 MB too.
    const text = `<c t="inlineStr"><is><t>${"x".repeat(3_600)}</t></is></c>`;
    const long = xlsx({
      ...WORKBOOK,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row>${text}</row>${`<row>${text}</row>`.repeat(300)}</sheetData></worksheet>`,
    });
    expect(() => sheetFromXlsx(long)).toThrow(/at most 1 MB; this file holds more cells/);
  });

  it("reads a long number format code in linear time, and one past 255 characters as General", () => {
    const start = Date.now();
    // Brackets that never close: each [ used to search to the end of the code.
    expect(numberFormatOf(`${"[".repeat(40_000)}0.00`)).toEqual({
      style: "plain",
      decimals: 2,
      grouping: false,
    });
    expect(numberFormatOf(`${"[$".repeat(20_000)}0.00`)).toEqual({
      style: "currency",
      currency: "USD",
      decimals: 2,
      grouping: false,
    });
    expect(Date.now() - start).toBeLessThan(1_000);
    const styled = (code: string) =>
      sheetFromXlsx(
        xlsx({
          ...WORKBOOK,
          "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="${code}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
          "xl/worksheets/sheet1.xml":
            '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>2</v></c></row></sheetData></worksheet>',
        }),
      ).header.columns[0];
    expect(styled("0.00%")).toEqual({
      name: "Price",
      type: "number",
      format: { style: "percent", decimals: 2 },
    });
    expect(styled(`0.00%${" ".repeat(300)}`)).toEqual({ name: "Price", type: "number" });
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
