// Looks in a sheet: option colours, highlight rules and cell styles in the file format, the ops that
// change them (and keep them with their cells), copying a formula by an offset, the live room's
// row rule, Compare in words, and cell styles read from an .xlsx.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  applySheetOps,
  describeChanges,
  highlightColor,
  highlightMatches,
  liveRules,
  mergeCellStyle,
  nearestSheetColor,
  offsetFormula,
  optionColor,
  parseSheet,
  readRowLine,
  type Sheet,
  type SheetColumn,
  serializeRow,
  serializeSheet,
  sheetFromXlsx,
  sheetRowLine,
} from "../src/index.ts";

const HEAD = (columns: unknown[]) => JSON.stringify({ plinth: "sheet", v: 1, columns });

function sheetOf(text: string): Sheet {
  const r = parseSheet(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.sheet;
}

function problems(text: string): string[] {
  const r = parseSheet(text);
  return r.ok ? [] : r.errors.map((e) => e.message);
}

const STATUS = {
  name: "Status",
  type: "select",
  options: ["To do", "Doing", "Done"],
  colors: { Done: "green", Doing: "yellow" },
};

describe("option colours and highlight rules in the header", () => {
  it("parse and serialize in one canonical spelling", () => {
    const text = [
      HEAD([
        STATUS,
        {
          name: "Margin",
          type: "number",
          highlight: [
            { color: "red", value: 0, when: "<" },
            { when: "between", to: 10, value: 0, color: "yellow" },
          ],
        },
        {
          name: "Due",
          type: "date",
          highlight: [{ when: ">=", value: "2026-12-01", color: "blue" }],
        },
      ]),
      '["Done",-2,"2026-12-24"]',
    ].join("\n");
    const s = sheetOf(text);
    const out = serializeSheet(s);
    // Colours follow the order of the options; a rule's keys are when, value, to, color.
    expect(out.split("\n")[0]).toBe(
      '{"plinth":"sheet","v":1,"columns":[{"name":"Status","type":"select","options":["To do","Doing","Done"],"colors":{"Doing":"yellow","Done":"green"}},{"name":"Margin","type":"number","highlight":[{"when":"<","value":0,"color":"red"},{"when":"between","value":0,"to":10,"color":"yellow"}]},{"name":"Due","type":"date","highlight":[{"when":">=","value":"2026-12-01","color":"blue"}]}]}',
    );
    expect(serializeSheet(sheetOf(out))).toBe(out);
    expect(optionColor(s.header.columns[0] as SheetColumn, "Done")).toBe("green");
    expect(optionColor(s.header.columns[0] as SheetColumn, "To do")).toBeNull();
  });

  it("refuses colours and rules that do not fit", () => {
    const one = (col: unknown) => problems(`${HEAD([col])}\n[]`).join("; ");
    expect(one({ ...STATUS, colors: { Done: "#00ff00" } })).toMatch(
      /colour of "Done" must be one of gray/,
    );
    expect(one({ ...STATUS, colors: { Later: "red" } })).toMatch(/not one of the options/);
    expect(one({ name: "A", colors: { x: "red" } })).toMatch(/colors are only for select columns/);
    expect(
      one({ name: "N", type: "number", highlight: [{ when: "<", value: "0", color: "red" }] }),
    ).toMatch(/value must be a number in a number column/);
    expect(
      one({ name: "D", type: "date", highlight: [{ when: "<", value: "soon", color: "red" }] }),
    ).toMatch(/date YYYY-MM-DD/);
    expect(
      one({
        name: "N",
        type: "number",
        highlight: [{ when: "between", value: 5, to: 1, color: "red" }],
      }),
    ).toMatch(/lower end/);
    expect(one({ name: "N", highlight: [{ when: "empty", value: 1, color: "red" }] })).toMatch(
      /takes no value/,
    );
    expect(
      one({ name: "N", highlight: [{ when: "<", value: 1, color: "red", style: "x" }] }),
    ).toMatch(/unknown key "style"/);
    expect(
      one({ name: "C", type: "checkbox", highlight: [{ when: "<", value: true, color: "red" }] }),
    ).toMatch(/= or <> only/);
    expect(one({ name: "N", highlight: [] })).toMatch(/1 to 10 rules/);
    expect(one({ name: "N", highlight: [{ when: "contains", value: "", color: "red" }] })).toMatch(
      /1 to 100 characters/,
    );
  });

  it("keeps an option named like an object key as a plain key", () => {
    const col = {
      name: "S",
      type: "select",
      options: ["__proto__", "constructor"],
      colors: { __proto__: "red" },
    };
    // JSON.parse makes "__proto__" an own key; the parser keeps it as one.
    const text = `${JSON.stringify({ plinth: "sheet", v: 1, columns: [col] }).replace('"colors":{}', '"colors":{"__proto__":"red"}')}\n["__proto__"]`;
    const s = sheetOf(text);
    const c = s.header.columns[0] as SheetColumn;
    expect(optionColor(c, "__proto__")).toBe("red");
    expect(optionColor(c, "constructor")).toBeNull();
    expect(serializeSheet(s)).toContain('"colors":{"__proto__":"red"}');
  });
});

describe("highlight rules match computed values", () => {
  const num: SheetColumn = {
    name: "N",
    type: "number",
    highlight: [
      { when: "<", value: 0, color: "red" },
      { when: "between", value: 0, to: 10, color: "yellow" },
      { when: "not_empty", color: "green" },
    ],
  };
  it("takes the first rule that matches", () => {
    expect(highlightColor(num, -1)).toBe("red");
    expect(highlightColor(num, 0)).toBe("yellow");
    expect(highlightColor(num, 10)).toBe("yellow");
    expect(highlightColor(num, 11)).toBe("green");
    expect(highlightColor(num, null)).toBeNull();
    // An error is not empty, and matches nothing else.
    expect(highlightColor(num, { error: "#DIV/0!" })).toBe("green");
  });
  it("compares like with like, text without case, dates as serials", () => {
    expect(highlightMatches({ when: ">", value: 5, color: "red" }, "abc", "text")).toBe(false);
    expect(highlightMatches({ when: "=", value: "done", color: "red" }, "Done", "select")).toBe(
      true,
    );
    expect(highlightMatches({ when: "<>", value: "done", color: "red" }, "Doing", "select")).toBe(
      true,
    );
    expect(
      highlightMatches({ when: "contains", value: "urg", color: "red" }, "Not URGENT", "text"),
    ).toBe(true);
    expect(highlightMatches({ when: "contains", value: "1.5", color: "red" }, 11.5, "number")).toBe(
      true,
    );
    expect(highlightMatches({ when: "empty", color: "red" }, "", "text")).toBe(true);
    expect(highlightMatches({ when: "<", value: 3, color: "red" }, null, "number")).toBe(false);
    // 2026-12-01 is serial 46357.
    expect(highlightMatches({ when: ">=", value: "2026-12-01", color: "red" }, 46357, "date")).toBe(
      true,
    );
    expect(highlightMatches({ when: ">=", value: "2026-12-01", color: "red" }, 46356, "date")).toBe(
      false,
    );
    expect(highlightMatches({ when: "=", value: true, color: "red" }, true, "checkbox")).toBe(true);
    expect(highlightMatches({ when: "=", value: true, color: "red" }, false, "checkbox")).toBe(
      false,
    );
  });
});

describe("cell styles in a row line", () => {
  const head = HEAD([{ name: "Item" }, { name: "Qty", type: "number" }, { name: "Note" }]);
  it("parse from the row's last object and serialize canonically", () => {
    const text = `${head}\n["Total",3,{"style":{"B":{"fill":"yellow","bold":true},"A":{"border":["bottom","top"]}}}]\n[null,null,null]\n[{"style":{"C":{"wrap":true}}}]`;
    const s = sheetOf(text);
    expect(s.rows).toEqual([["Total", 3], [null, null, null], []]);
    expect(s.styles?.[0]).toEqual([{ border: ["top", "bottom"] }, { bold: true, fill: "yellow" }]);
    expect(s.styles?.[1]).toBeUndefined();
    expect(serializeSheet(s).split("\n").slice(1)).toEqual([
      '["Total",3,{"style":{"A":{"border":["top","bottom"]},"B":{"bold":true,"fill":"yellow"}}}]',
      "[]",
      '[{"style":{"C":{"wrap":true}}}]',
    ]);
    expect(readRowLine('["a",{"style":{"B":{"italic":true}}}]')).toEqual({
      cells: ["a"],
      style: [undefined, { italic: true }],
    });
  });

  it("refuses styles that are not from the fixed lists", () => {
    const row = (meta: unknown) => problems(`${head}\n${JSON.stringify(["x", meta])}`).join("; ");
    expect(row({ style: { A: { color: "red" } } })).toMatch(/unknown key "color" in a style/);
    expect(row({ style: { A: { fill: "red; background:url(x)" } } })).toMatch(
      /fill must be one of/,
    );
    expect(row({ style: { D: { bold: true } } })).toMatch(/"D", which is not a column/);
    expect(row({ style: { a: { bold: true } } })).toMatch(/"a", which is not a column/);
    expect(row({ style: { A: { bold: false } } })).toMatch(/bold is true or left out/);
    expect(row({ style: { A: { align: "justify" } } })).toMatch(/align must be one of/);
    expect(row({ style: { A: { border: ["top", "top"] } } })).toMatch(/each once/);
    expect(row({ css: "x" })).toMatch(/holds only "style"/);
    // An object anywhere but last is a cell, and a cell is never an object.
    expect(problems(`${head}\n[{"style":{}},"x"]`).join("; ")).toMatch(/a cell is null, a number/);
  });

  it("is a row the live room accepts only in its canonical spelling", () => {
    const h = sheetOf(`${head}\n[]`).header;
    const line = serializeRow(["a", 1], [null, { bold: true }]);
    expect(line).toBe('["a",1,{"style":{"B":{"bold":true}}}]');
    expect(sheetRowLine(h, line, 2)).toBe(true);
    expect(sheetRowLine(h, '["a",1,{"style":{"B":{"bold":true},"A":{}}}]', 2)).toBe(false);
    expect(sheetRowLine(h, '["a",1,null,{"style":{"B":{"bold":true}}}]', 2)).toBe(false);
    expect(sheetRowLine(h, '["a",1,{"style":{}}]', 2)).toBe(false);
    const rules = liveRules("sheet");
    const canon = serializeSheet({ header: h, rows: [] });
    expect(rules?.checkEdit([canon, '["a"]'], 1, 1, [line])).toBeNull();
    expect(
      rules?.checkEdit([canon, '["a"]'], 1, 1, ['["a",{"style":{"B":{"fill":"lime"}}}]']),
    ).toBe("invalid");
  });

  it("merges a change into a style", () => {
    expect(mergeCellStyle({ bold: true, fill: "red" }, { fill: "blue", italic: true })).toEqual({
      bold: true,
      italic: true,
      fill: "blue",
    });
    expect(mergeCellStyle({ bold: true, fill: "red" }, { bold: false, fill: null })).toBeNull();
    expect(mergeCellStyle({ bold: true }, null)).toBeNull();
    expect(mergeCellStyle(null, { border: ["left", "top"] })).toEqual({ border: ["top", "left"] });
  });
});

describe("edit_sheet ops and looks", () => {
  const base = () =>
    sheetOf(
      [
        HEAD([{ name: "Item" }, { name: "Qty", type: "number" }, STATUS]),
        '["Apples",3,"Done",{"style":{"A":{"bold":true}}}]',
        '["Pears",5,"Doing"]',
        '["Plums",1,"To do",{"style":{"C":{"fill":"red"}}}]',
      ].join("\n"),
    );
  const rowsOf = (s: Sheet) => serializeSheet(s).split("\n").slice(1);

  it("format styles a range, whole columns or whole rows, and clears", () => {
    const { sheet, changed } = applySheetOps(base(), [
      { op: "format", range: "B2:B3", style: { bold: true, align: "center" } },
      { op: "format", range: "4:4", style: { fill: "gray" } },
      { op: "format", range: "A:A", style: { bold: false } },
    ]);
    expect(changed.cells_styled).toBe(2 + 3 + 3);
    expect(rowsOf(sheet)).toEqual([
      '["Apples",3,"Done",{"style":{"B":{"bold":true,"align":"center"}}}]',
      '["Pears",5,"Doing",{"style":{"B":{"bold":true,"align":"center"}}}]',
      '["Plums",1,"To do",{"style":{"A":{"fill":"gray"},"B":{"fill":"gray"},"C":{"fill":"gray"}}}]',
    ]);
    const cleared = applySheetOps(sheet, [{ op: "format", range: "A2:C4", style: null }]).sheet;
    expect(rowsOf(cleared)).toEqual([
      '["Apples",3,"Done"]',
      '["Pears",5,"Doing"]',
      '["Plums",1,"To do"]',
    ]);
  });

  it("refuses a format outside the sheet", () => {
    expect(() =>
      applySheetOps(base(), [{ op: "format", range: "A1:B2", style: { bold: true } }]),
    ).toThrow(/row 2 or below/);
    expect(() =>
      applySheetOps(base(), [{ op: "format", range: "A2:A9", style: { bold: true } }]),
    ).toThrow(/past the sheet's last row \(4\)/);
    expect(() =>
      applySheetOps(base(), [{ op: "format", range: "A2:D2", style: { bold: true } }]),
    ).toThrow(/past column C/);
    expect(() =>
      applySheetOps(base(), [{ op: "format", range: "nope", style: { bold: true } }]),
    ).toThrow(/not an A1 range/);
  });

  it("keeps styles with their cells through row and column changes", () => {
    const { sheet } = applySheetOps(base(), [
      { op: "insert_rows", before: 2, count: 1 },
      { op: "move_rows", from: 5, count: 1, to: 3 },
      { op: "insert_columns", before: "A", columns: [{ name: "No" }] },
      { op: "delete_rows", from: 4, count: 1 },
    ]);
    expect(rowsOf(sheet)).toEqual([
      "[]",
      '[null,"Plums",1,"To do",{"style":{"D":{"fill":"red"}}}]',
      '[null,"Pears",5,"Doing"]',
    ]);
    const dropped = applySheetOps(base(), [{ op: "delete_columns", from: "A" }]).sheet;
    expect(rowsOf(dropped)[0]).toBe('[3,"Done"]');
    expect(rowsOf(dropped)[2]).toBe('[1,"To do",{"style":{"B":{"fill":"red"}}}]');
  });

  it("set_column keeps the colours of the options it keeps", () => {
    const s = applySheetOps(base(), [
      { op: "set_column", column: "C", options: ["To do", "Done", "Later"] },
      { op: "set", at: "C3", values: [["Later"]] },
    ]).sheet;
    expect(s.header.columns[2]?.colors).toEqual({ Done: "green" });
    const recoloured = applySheetOps(base(), [
      { op: "set_column", column: "C", colors: { "To do": "gray" } },
      { op: "set_column", column: "B", highlight: [{ when: ">", value: 4, color: "green" }] },
    ]).sheet;
    expect(recoloured.header.columns[2]?.colors).toEqual({ "To do": "gray" });
    expect(highlightColor(recoloured.header.columns[1] as SheetColumn, 5)).toBe("green");
    const plain = applySheetOps(base(), [{ op: "set_column", column: "C", colors: null }]).sheet;
    expect(plain.header.columns[2]?.colors).toBeUndefined();
  });
});

describe("offsetFormula copies a formula as fill and paste do", () => {
  it("moves relative references and keeps the $ ones", () => {
    expect(offsetFormula("=B2*C2", 1, 0)).toBe("=B3*C3");
    expect(offsetFormula("=$B2*C$2+$D$1", 2, 1)).toBe("=$B4*D$2+$D$1");
    expect(offsetFormula("=SUM(B2:B9)", 3, 0)).toBe("=SUM(B5:B12)");
    expect(offsetFormula("=SUM(B:B)", 5, 1)).toBe("=SUM(C:C)");
    expect(offsetFormula("=SUM(2:3)", 1, 4)).toBe("=SUM(3:4)");
    expect(offsetFormula('=B2&"B2"', 1, 0)).toBe('=B3&"B2"');
    expect(offsetFormula("=A2", -1, 0)).toBe("=A1");
    expect(offsetFormula("=A2", -2, 0)).toBe("=#REF!");
    expect(offsetFormula("=A2", 0, -1)).toBe("=#REF!");
    expect(offsetFormula("plain", 1, 1)).toBe("plain");
  });
});

describe("Compare in words", () => {
  const words = (a: string, b: string) => describeChanges("sheet", a, b).items.map((i) => i.what);
  it("names colours, rules and formatting", () => {
    const a = [HEAD([{ name: "Item" }, STATUS]), '["Apples","Done"]', '["Pears","Doing"]'].join(
      "\n",
    );
    const b = [
      HEAD([
        { name: "Item", highlight: [{ when: "contains", value: "app", color: "green" }] },
        { ...STATUS, colors: { Done: "blue" } },
      ]),
      '["Apples","Done",{"style":{"A":{"bold":true}}}]',
      '["Pears","Doing",{"style":{"A":{"bold":true},"B":{"italic":true}}}]',
    ].join("\n");
    expect(words(a, b)).toEqual([
      "“Item”: highlight rules changed",
      "“Status”: option colours changed",
      "Formatting changed in 3 cells",
    ]);
    const c = [
      HEAD([{ name: "Item" }, STATUS]),
      '["Apples","Done",{"style":{"B":{"fill":"red"}}}]',
      '["Pears","Doing"]',
    ].join("\n");
    expect(words(a, c)).toEqual(["B2 formatting changed"]);
  });
});

describe(".xlsx import of cell styles", () => {
  const files = (styles: string, sheet: string) =>
    zipSync(
      Object.fromEntries(
        Object.entries({
          "xl/workbook.xml":
            '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
          "xl/_rels/workbook.xml.rels":
            '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
          "xl/styles.xml": styles,
          "xl/worksheets/sheet1.xml": sheet,
        }).map(([k, v]) => [k, strToU8(v)]),
      ),
    );

  it("maps fonts, solid fills, alignment, wrapping and borders to sheet styles", () => {
    const styles =
      "<styleSheet>" +
      '<fonts count="3"><font><sz val="11"/></font><font><b/></font><font><b val="0"/><i/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/></border><border><left style="thin"/><right/><top style="none"/><bottom style="medium"/></border></borders>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="2"/><xf fontId="2" borderId="1"><alignment horizontal="center" wrapText="1"/></xf><xf fontId="0"><alignment horizontal="general"/></xf></cellXfs>' +
      '<dxfs count="1"><dxf><font><b/></font><fill><patternFill><bgColor rgb="FFFF0000"/></patternFill></fill></dxf></dxfs>' +
      "</styleSheet>";
    const sheet =
      "<worksheet><sheetData>" +
      '<row r="1"><c r="A1" t="inlineStr" s="1"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Note</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr" s="1"><is><t>Total</t></is></c><c r="B2" t="inlineStr" s="2"><is><t>long</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr" s="3"><is><t>x</t></is></c><c r="B3" s="1"/></row>' +
      "</sheetData></worksheet>";
    const s = sheetFromXlsx(files(styles, sheet));
    expect(serializeSheet(s).split("\n").slice(1)).toEqual([
      '["Total","long",{"style":{"A":{"bold":true,"fill":"yellow"},"B":{"italic":true,"align":"center","wrap":true,"border":["bottom","left"]}}}]',
      '["x"]',
    ]);
  });

  it("matches colours by hue", () => {
    expect(nearestSheetColor("FFFFFFFF")).toBeNull();
    expect(nearestSheetColor("D9D9D9")).toBe("gray");
    expect(nearestSheetColor("FF0000")).toBe("red");
    expect(nearestSheetColor("FFC7CE")).toBe("red");
    expect(nearestSheetColor("C6EFCE")).toBe("green");
    expect(nearestSheetColor("FFEB9C")).toBe("yellow");
    expect(nearestSheetColor("4472C4")).toBe("blue");
    expect(nearestSheetColor("ED7D31")).toBe("orange");
    expect(nearestSheetColor("7030A0")).toBe("purple");
    expect(nearestSheetColor("nothex")).toBeNull();
  });
});
