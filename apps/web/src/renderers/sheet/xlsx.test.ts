// The .xlsx download: well-formed SpreadsheetML parts, cell types, formulas with cached values,
// the frozen pane, number formats, inline strings for text that starts with =, forbidden XML
// characters dropped, and nothing that could reach outside the workbook.
import { evaluateSheet, parseSheet, type Sheet } from "@plinth/shared";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { exportBytes, fileName } from "./export.ts";
import { buildXlsx, excelFormula, sheetName, xmlText } from "./xlsx.ts";

function sheetOf(lines: string[]): Sheet {
  const r = parseSheet(lines.join("\n"));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.sheet;
}

const SHEET = sheetOf([
  JSON.stringify({
    plinth: "sheet",
    v: 1,
    columns: [
      { name: "Item", width: 210 },
      { name: "Qty", type: "number" },
      {
        name: "Price",
        type: "number",
        format: { style: "currency", currency: "EUR", decimals: 2 },
      },
      { name: "When", type: "date" },
      { name: "Paid", type: "checkbox" },
      { name: "Note" },
    ],
    freeze: { cols: 1 },
  }),
  JSON.stringify(["Apples", 3, 1.25, "2026-01-02", true, "'=1+1"]),
  JSON.stringify(["Pears", "=B2*2", "=1/0", "=D2+1", "=E2", '=CONCAT(A2,"!")']),
  JSON.stringify(["Loop", "=B4", null, null, null, "bad\u0001char \ud800 end"]),
]);

function parts(bytes: Uint8Array): Record<string, Document> {
  const files = unzipSync(bytes);
  const out: Record<string, Document> = {};
  for (const [name, data] of Object.entries(files)) {
    const doc = new DOMParser().parseFromString(strFromU8(data), "application/xml");
    expect(doc.getElementsByTagName("parsererror").length, name).toBe(0);
    out[name] = doc;
  }
  return out;
}

const cellXml = (doc: Document, ref: string) =>
  [...doc.getElementsByTagName("c")].find((c) => c.getAttribute("r") === ref) as Element;

describe("buildXlsx", () => {
  const ev = evaluateSheet(SHEET, { budget: 10_000 });
  const xml = parts(buildXlsx(SHEET, ev, 'Q4: "budget"/<draft>'));

  it("writes exactly the parts of one workbook, and nothing that reaches outside it", () => {
    expect(Object.keys(xml).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const all = Object.values(xml)
      .map((d) => new XMLSerializer().serializeToString(d))
      .join("");
    expect(all).not.toMatch(/externalLink|vbaProject|TargetMode="External"|macro/i);
    expect(xml["docProps/core.xml"]?.documentElement.textContent).toBe('Q4: "budget"/<draft>');
    const name = xml["xl/workbook.xml"]?.getElementsByTagName("sheet")[0]?.getAttribute("name");
    expect(name).toBe('Q4 "budget" <draft>');
    expect(
      xml["xl/workbook.xml"]?.getElementsByTagName("calcPr")[0]?.getAttribute("fullCalcOnLoad"),
    ).toBe("1");
  });

  it("types every cell and caches formula values", () => {
    const s = xml["xl/worksheets/sheet1.xml"] as Document;
    expect(cellXml(s, "A1").getAttribute("t")).toBe("inlineStr");
    expect(cellXml(s, "A1").getAttribute("s")).toBe("1");
    expect(cellXml(s, "B2").textContent).toBe("3");
    expect(cellXml(s, "E2").getAttribute("t")).toBe("b");
    expect(cellXml(s, "D2").textContent).toBe("46024");
    // Text starting with = is an inline string, never a formula.
    expect(cellXml(s, "F2").getAttribute("t")).toBe("inlineStr");
    expect(cellXml(s, "F2").textContent).toBe("=1+1");
    expect(cellXml(s, "F2").getElementsByTagName("f").length).toBe(0);
    const b3 = cellXml(s, "B3");
    expect(b3.getElementsByTagName("f")[0]?.textContent).toBe("B2*2");
    expect(b3.getElementsByTagName("v")[0]?.textContent).toBe("6");
    const c3 = cellXml(s, "C3");
    expect(c3.getAttribute("t")).toBe("e");
    expect(c3.getElementsByTagName("v")[0]?.textContent).toBe("#DIV/0!");
    expect(cellXml(s, "E3").getAttribute("t")).toBe("b");
    const f3 = cellXml(s, "F3");
    expect(f3.getAttribute("t")).toBe("str");
    expect(f3.getElementsByTagName("f")[0]?.textContent).toBe('_xlfn.CONCAT(A2,"!")');
    expect(f3.getElementsByTagName("v")[0]?.textContent).toBe("Apples!");
    // A cycle has no cached value.
    expect(cellXml(s, "B4").getElementsByTagName("v").length).toBe(0);
    // Characters XML forbids are dropped.
    expect(cellXml(s, "F4").textContent).toBe("badchar  end");
  });

  it("freezes the header and the frozen columns, sizes columns and formats numbers", () => {
    const s = xml["xl/worksheets/sheet1.xml"] as Document;
    const pane = s.getElementsByTagName("pane")[0] as Element;
    expect([
      pane.getAttribute("xSplit"),
      pane.getAttribute("ySplit"),
      pane.getAttribute("state"),
    ]).toEqual(["1", "1", "frozen"]);
    expect(s.getElementsByTagName("col")[0]?.getAttribute("width")).toBe("30");
    const codes = [...(xml["xl/styles.xml"] as Document).getElementsByTagName("numFmt")].map((n) =>
      n.getAttribute("formatCode"),
    );
    expect(codes).toEqual(['"€"#,##0.00', "yyyy-mm-dd"]);
  });
});

describe("helpers", () => {
  it("escapes XML and drops forbidden characters, keeping surrogate pairs", () => {
    expect(xmlText(`a&<>"'`)).toBe("a&amp;&lt;&gt;&quot;&apos;");
    expect(xmlText("x\u0001\u0008\t\ny\ud800z\udc00￾😀")).toBe("x\t\nyz😀");
  });

  it("prefixes newer functions for Excel and keeps the rest", () => {
    expect(excelFormula('=IFS(A1>1,"a",TRUE,XLOOKUP(1,B:B,C:C))')).toBe(
      '_xlfn.IFS(A1>1,"a",TRUE,_xlfn.XLOOKUP(1,B:B,C:C))',
    );
    expect(excelFormula('=SUM(A1:A3)&"CONCAT("')).toBe('SUM(A1:A3)&"CONCAT("');
  });

  it("names sheets and files safely", () => {
    expect(sheetName("a/b\\c?d*e[f]g:h")).toBe("a b c d e f g h");
    expect(sheetName("'quoted'")).toBe("quoted");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("")).toBe("Sheet1");
    expect(fileName('Q4: "budget"/<v2>|\u0007', "xlsx")).toBe("Q4 budgetv2.xlsx");
    expect(fileName("...", "csv")).toBe("sheet.csv");
    expect(fileName("x".repeat(150), "csv")).toBe(`${"x".repeat(100)}.csv`);
  });

  it("CSV export guards formulas and starts with a BOM", () => {
    const csv = exportBytes(SHEET, evaluateSheet(SHEET, { budget: 10_000 }), "t", "csv") as string;
    expect(csv.startsWith("﻿Item,Qty,Price,When,Paid,Note\r\n")).toBe(true);
    expect(csv).toContain("Apples,3,1.25,2026-01-02,TRUE,'=1+1\r\n");
  });
});
