// The formula engine: Excel's precedence and coercions, references and ranges, errors, the
// functions sheets support, cycles and the step budget.
import { describe, expect, it } from "vitest";
import {
  type Cell,
  dateSerial,
  evaluateSheet,
  LIMITS,
  parseFormula,
  SHEET_FUNCTION_NAMES,
  type Sheet,
  type SheetColumn,
  type Value,
} from "../src/index.ts";

const col = (name: string, type: SheetColumn["type"] = "text"): SheetColumn => ({ name, type });

function sheetOf(rows: Cell[][], columns?: SheetColumn[]): Sheet {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return {
    header: { columns: columns ?? Array.from({ length: width }, (_, i) => col(`C${i + 1}`)) },
    rows,
  };
}

/**
 * The value of =<formula> in a sheet whose rows 2 and on are `rows`: the formula sits in row 2 of
 * a column of its own, after the data's columns (the 26th, Z, unless the data is wider).
 */
function calc(
  formula: string,
  rows: Cell[][] = [],
  columns?: SheetColumn[],
  today?: number,
): Value {
  const width = Math.max(25, ...rows.map((r) => r.length), columns?.length ?? 0);
  const cols = Array.from({ length: width + 1 }, (_, i) => columns?.[i] ?? col(`C${i + 1}`));
  const all = rows.length ? rows.map((r) => [...r]) : [[]];
  const first = all[0] as Cell[];
  while (first.length < width) first.push(null);
  first[width] = `=${formula}`;
  const s = sheetOf(all, cols);
  const ev = evaluateSheet(s, { budget: 1_000_000, ...(today !== undefined ? { today } : {}) });
  return ev.value(2, width);
}

const E = (code: string) => ({ error: code });

describe("parsing", () => {
  it("follows Excel's precedence", () => {
    expect(calc("-2^2")).toBe(4);
    expect(calc("2^3^2")).toBe(64);
    expect(calc("1+2*3")).toBe(7);
    expect(calc("(1+2)*3")).toBe(9);
    expect(calc("50%")).toBe(0.5);
    expect(calc("2*50%+1")).toBe(2);
    expect(calc("1&2+3")).toBe("15");
    expect(calc("1+1=2")).toBe(true);
    expect(calc("-(-3)")).toBe(3);
  });

  it("refuses functions outside the allowlist, prototype keys included", () => {
    for (const f of [
      "constructor()",
      "__PROTO__()",
      "toString()",
      'HYPERLINK("x")',
      'WEBSERVICE("x")',
      'INDIRECT("A1")',
      "NOW()",
      "RAND()",
    ]) {
      const r = parseFormula(f);
      expect(r.ok, f).toBe(false);
    }
    const r = parseFormula("SUMX(1)");
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.message).toMatch(/^SUMX is not a function sheets support \(supported: ABS, /);
  });

  it("refuses other sheets, files, names, arrays and @", () => {
    for (const f of ["Sheet1!A1", "[book.xlsx]Sheet1!A1", "{1,2}", "@A1", "myName", "A1;B1"]) {
      expect(parseFormula(f).ok, f).toBe(false);
    }
  });

  it("caps nesting at 32", () => {
    const deep = (n: number) => `${"(".repeat(n)}1${")".repeat(n)}`;
    expect(parseFormula(deep(LIMITS.maxSheetFormulaDepth)).ok).toBe(true);
    expect(parseFormula(deep(LIMITS.maxSheetFormulaDepth + 1)).ok).toBe(false);
    expect(parseFormula(`${"ABS(".repeat(33)}1${")".repeat(33)}`).ok).toBe(false);
  });

  it("checks argument counts", () => {
    expect(parseFormula("ROUND(1)").ok).toBe(false);
    expect(parseFormula("TODAY(1)").ok).toBe(false);
    expect(parseFormula("IF(1,2,3,4)").ok).toBe(false);
  });

  it("lists every function once, alphabetically", () => {
    expect(SHEET_FUNCTION_NAMES).toEqual([...new Set(SHEET_FUNCTION_NAMES)].sort());
    expect(SHEET_FUNCTION_NAMES).toContain("XLOOKUP");
    expect(SHEET_FUNCTION_NAMES).not.toContain("HYPERLINK");
  });
});

describe("values and coercion", () => {
  it("compares mixed types the Excel way", () => {
    expect(calc('1<"a"')).toBe(true);
    expect(calc('"a"<TRUE')).toBe(true);
    expect(calc('"abc"="ABC"')).toBe(true);
    expect(calc("0.1+0.2=0.3")).toBe(true);
    expect(calc('"3"+1')).toBe(4);
    expect(calc('"x"+1')).toEqual(E("#VALUE!"));
    expect(calc("TRUE+1")).toBe(2);
  });

  it("propagates errors and catches them", () => {
    expect(calc("1/0")).toEqual(E("#DIV/0!"));
    expect(calc("1/0+1")).toEqual(E("#DIV/0!"));
    expect(calc('IFERROR(1/0,"none")')).toBe("none");
    expect(calc("IFNA(#N/A,2)")).toBe(2);
    expect(calc("IFNA(#VALUE!,2)")).toEqual(E("#VALUE!"));
    expect(calc("ISERROR(1/0)")).toBe(true);
    expect(calc("SQRT(-1)")).toEqual(E("#NUM!"));
  });

  it("reads references and ranges, whole columns included", () => {
    const rows: Cell[][] = [
      [1, 10],
      [2, 20],
      [3, "text"],
    ];
    expect(calc("A2+B3", rows)).toBe(21);
    expect(calc("SUM(A2:A4)", rows)).toBe(6);
    expect(calc("SUM(B:B)", rows)).toBe(30);
    expect(calc("SUM(3:4)", rows)).toBe(25);
    expect(calc("COUNT(A:B)", rows)).toBe(5);
    expect(calc("$A$2*2", rows)).toBe(2);
    expect(calc("A1", rows)).toBe("C1");
    expect(calc("Z99", rows)).toBe(null);
    expect(calc("A2:A4", rows)).toEqual(E("#VALUE!"));
  });

  it("SUM skips text in ranges but converts text it is given", () => {
    const rows: Cell[][] = [["3"], [true], [4]];
    expect(calc("SUM(A2:A4)", rows)).toBe(4);
    expect(calc("SUM(A2)", rows)).toBe(0);
    expect(calc('SUM("3",TRUE)')).toBe(4);
  });
});

describe("functions", () => {
  const people: Cell[][] = [
    ["ann", 5, "x"],
    ["bob", 7, "y"],
    ["cid", 3, "x"],
    ["dee", 10, "abc"],
  ];

  it("aggregates", () => {
    expect(calc("AVERAGE(B2:B5)", people)).toBe(6.25);
    expect(calc("MIN(B2:B5)", people)).toBe(3);
    expect(calc("MAX(B2:B5)", people)).toBe(10);
    expect(calc("MEDIAN(B2:B5)", people)).toBe(6);
    expect(calc("PRODUCT(B2:B3)", people)).toBe(35);
    expect(calc("COUNTA(A2:C5)", people)).toBe(12);
    expect(calc("COUNTBLANK(A2:A10)", people)).toBe(5);
    expect(calc("COUNTBLANK(D2:D3)", people)).toBe(2);
    expect(Number((calc("STDEV(B2:B5)", people) as number).toFixed(6))).toBe(2.986079);
    expect(calc("AVERAGE(D2:D5)", people)).toEqual(E("#DIV/0!"));
  });

  it("COUNTIF and friends take criteria", () => {
    expect(calc('COUNTIF(B2:B5,">5")', people)).toBe(2);
    expect(calc('COUNTIF(A2:A5,"a*")', people)).toBe(1);
    expect(calc('COUNTIF(A2:A5,"?o?")', people)).toBe(1);
    expect(calc('COUNTIF(C2:C5,"x")', people)).toBe(2);
    expect(calc('COUNTIF(C2:C5,"<>x")', people)).toBe(2);
    expect(calc("COUNTIF(B2:B5,7)", people)).toBe(1);
    expect(calc('SUMIF(C2:C5,"x",B2:B5)', people)).toBe(8);
    expect(calc('SUMIFS(B2:B5,C2:C5,"x",B2:B5,">4")', people)).toBe(5);
    expect(calc('COUNTIFS(C2:C5,"x",B2:B5,"<4")', people)).toBe(1);
    expect(calc('AVERAGEIF(C2:C5,"x",B2:B5)', people)).toBe(4);
    expect(calc('AVERAGEIFS(B2:B5,C2:C5,"y")', people)).toBe(7);
    expect(calc('SUMIFS(B2:B5,C2:C4,"x")', people)).toEqual(E("#VALUE!"));
  });

  it("looks values up", () => {
    expect(calc('VLOOKUP("bob",A2:C5,2,FALSE)', people)).toBe(7);
    expect(calc('VLOOKUP("BOB",A2:C5,3,FALSE)', people)).toBe("y");
    expect(calc('VLOOKUP("zed",A2:C5,2,FALSE)', people)).toEqual(E("#N/A"));
    expect(calc('VLOOKUP("bob",A2:C5,4,FALSE)', people)).toEqual(E("#REF!"));
    const sorted: Cell[][] = [
      [0, "F"],
      [50, "C"],
      [70, "B"],
      [90, "A"],
    ];
    expect(calc("VLOOKUP(75,A2:B5,2)", sorted)).toBe("B");
    expect(calc("VLOOKUP(95,A2:B5,2,TRUE)", sorted)).toBe("A");
    expect(calc("VLOOKUP(-1,A2:B5,2)", sorted)).toEqual(E("#N/A"));
    expect(calc('XLOOKUP("cid",A2:A5,B2:B5)', people)).toBe(3);
    expect(calc('XLOOKUP("zed",A2:A5,B2:B5)', people)).toEqual(E("#N/A"));
    expect(calc('XLOOKUP("zed",A2:A5,B2:B5,"none")', people)).toBe("none");
    expect(calc("XLOOKUP(60,A2:A5,B2:B5,,-1)", sorted)).toBe("C");
    expect(calc("XLOOKUP(60,A2:A5,B2:B5,,1)", sorted)).toBe("B");
    expect(calc("INDEX(A2:C5,2,3)", people)).toBe("y");
    expect(calc("INDEX(B2:B5,4)", people)).toBe(10);
    expect(calc("INDEX(B2:B5,9)", people)).toEqual(E("#REF!"));
    expect(calc('MATCH("dee",A2:A5,0)', people)).toBe(4);
    expect(calc("MATCH(60,A2:A5)", sorted)).toBe(2);
    expect(calc('HLOOKUP("C2",A1:C5,3,FALSE)', people)).toBe(7);
  });

  it("works with text", () => {
    expect(calc('CONCAT("a",1,TRUE)')).toBe("a1TRUE");
    expect(calc("CONCAT(A2:A3)", people)).toBe("annbob");
    expect(calc('CONCATENATE("a","b")')).toBe("ab");
    expect(calc('TEXTJOIN("-",TRUE,A2:A3,"",B2)', people)).toBe("ann-bob-5");
    expect(calc('LEN("héllo")')).toBe(5);
    expect(calc('LEFT("hello",2)')).toBe("he");
    expect(calc('RIGHT("hello")')).toBe("o");
    expect(calc('MID("hello",2,3)')).toBe("ell");
    expect(calc('UPPER("ab")')).toBe("AB");
    expect(calc('PROPER("hello wORLD")')).toBe("Hello World");
    expect(calc('TRIM("  a   b ")')).toBe("a b");
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
    expect(calc('REPT("ab",3)')).toBe("ababab");
    expect(calc('REPT("ab",20000)')).toEqual(E("#VALUE!"));
    expect(calc('FIND("l","hello")')).toBe(3);
    expect(calc('FIND("L","hello")')).toEqual(E("#VALUE!"));
    expect(calc('SEARCH("L","hello")')).toBe(3);
    expect(calc('SEARCH("l?o","hello")')).toBe(3);
    expect(calc('SEARCH("e*o","hello")')).toBe(2);
    expect(calc('VALUE("12.5")')).toBe(12.5);
    expect(calc('VALUE("x")')).toEqual(E("#VALUE!"));
    expect(calc('EXACT("a","A")')).toBe(false);
  });

  it("does logic", () => {
    expect(calc('IF(1>2,"y","n")')).toBe("n");
    expect(calc("IF(FALSE,1)")).toBe(false);
    expect(calc('IFS(1>2,"a",2>1,"b")')).toBe("b");
    expect(calc('IFS(1>2,"a")')).toEqual(E("#N/A"));
    expect(calc('SWITCH(2,1,"one",2,"two","many")')).toBe("two");
    expect(calc('SWITCH(9,1,"one","many")')).toBe("many");
    expect(calc("AND(TRUE,1)")).toBe(true);
    expect(calc("OR(FALSE,0)")).toBe(false);
    expect(calc("XOR(TRUE,TRUE,TRUE)")).toBe(true);
    expect(calc("NOT(0)")).toBe(true);
    expect(calc("ISBLANK(A2)", [[null]])).toBe(true);
    expect(calc('ISBLANK("")')).toBe(false);
    expect(calc("ISNUMBER(1)")).toBe(true);
    expect(calc('ISTEXT("a")')).toBe(true);
    expect(calc("ISNA(#N/A)")).toBe(true);
  });

  it("rounds and does arithmetic", () => {
    expect(calc("ROUND(2.5,0)")).toBe(3);
    expect(calc("ROUND(-2.5,0)")).toBe(-3);
    expect(calc("ROUND(1.005,2)")).toBe(1.01);
    expect(calc("ROUND(1234,-2)")).toBe(1200);
    expect(calc("ROUNDUP(1.21,1)")).toBe(1.3);
    expect(calc("ROUNDDOWN(-1.29,1)")).toBe(-1.2);
    expect(calc("INT(-1.5)")).toBe(-2);
    expect(calc("MOD(-3,2)")).toBe(1);
    expect(calc("MOD(3,0)")).toEqual(E("#DIV/0!"));
    expect(calc("POWER(2,10)")).toBe(1024);
    expect(calc("CEILING(2.1,0.5)")).toBe(2.5);
    expect(calc("FLOOR(2.9,1)")).toBe(2);
    expect(calc("CEILING(2,-1)")).toEqual(E("#NUM!"));
    expect(calc("ABS(-4)")).toBe(4);
  });

  it("handles dates in the 1900 system", () => {
    expect(calc("DATE(1900,3,1)")).toBe(61);
    expect(calc("DATE(2026,1,31)")).toBe(dateSerial(2026, 1, 31));
    expect(calc("DATE(2026,13,1)")).toBe(dateSerial(2027, 1, 1));
    expect(calc("YEAR(DATE(2026,2,3))")).toBe(2026);
    expect(calc("MONTH(DATE(2026,2,3))")).toBe(2);
    expect(calc("DAY(DATE(2026,2,3))")).toBe(3);
    expect(calc("EDATE(DATE(2026,1,31),1)")).toBe(dateSerial(2026, 2, 28));
    expect(calc("EOMONTH(DATE(2024,1,15),1)")).toBe(dateSerial(2024, 2, 29));
    expect(calc("DAYS(DATE(2026,3,1),DATE(2026,2,1))")).toBe(28);
    // 2026-11-19 is a Thursday.
    expect(calc("WEEKDAY(DATE(2026,11,19))")).toBe(5);
    expect(calc("WEEKDAY(DATE(2026,11,19),2)")).toBe(4);
    expect(calc("WEEKDAY(DATE(2026,11,19),3)")).toBe(3);
    expect(calc("TODAY()", [], undefined, 46000)).toBe(46000);
    // A date column's literal is its serial.
    expect(calc("A2+1", [["2026-01-01"]], [col("When", "date")])).toBe(dateSerial(2026, 1, 2));
    expect(calc('"2026-01-01"+0')).toBe(dateSerial(2026, 1, 1));
  });
});

describe("dependencies, cycles and the budget", () => {
  it("computes chains in order, without recursion", () => {
    const rows: Cell[][] = [[1]];
    for (let i = 3; i <= 5001; i++) rows.push([`=A${i - 1}+1`]);
    const s = sheetOf(rows);
    const ev = evaluateSheet(s, { budget: 10_000_000 });
    expect(ev.value(5001, 0)).toBe(5000);
    expect(ev.exhausted).toBe(false);
  });

  it("marks every cell on a cycle #CYCLE! and leaves the others alone", () => {
    const rows: Cell[][] = [["=A3+1"], ["=A4+1"], ["=A2+1"], [5], ["=A5*2"], ["=SUM(A6:A7)"]];
    const ev = evaluateSheet(sheetOf(rows), { budget: 100_000 });
    expect(ev.value(2, 0)).toEqual(E("#CYCLE!"));
    expect(ev.value(3, 0)).toEqual(E("#CYCLE!"));
    expect(ev.value(4, 0)).toEqual(E("#CYCLE!"));
    expect(ev.value(6, 0)).toBe(10);
    expect(ev.value(7, 0)).toEqual(E("#CYCLE!"));
  });

  it("stops at the budget with #LIMIT!", () => {
    const rows: Cell[][] = [];
    for (let i = 0; i < 500; i++) rows.push([i, `=SUM($A$2:A${i + 2})`]);
    const ev = evaluateSheet(sheetOf(rows), { budget: 100 });
    expect(ev.exhausted).toBe(true);
    expect(ev.value(501, 1)).toEqual(E("#LIMIT!"));
    expect(ev.value(2, 0)).toBe(0);
  });

  it("evaluates only the asked cells and what they need", () => {
    const rows: Cell[][] = [[1, "=A2*2", '=REPT("x",100)']];
    const ev = evaluateSheet(sheetOf(rows), { budget: 10_000, cells: [[2, 1]] });
    expect(ev.value(2, 1)).toBe(2);
    expect(ev.steps).toBeLessThan(20);
  });

  it("takes MIN and MAX of a range of any size the sheet holds", () => {
    const rows: Cell[][] = [];
    for (let i = 0; i < 10_000; i++) rows.push(Array.from({ length: 20 }, (_, c) => i * 20 + c));
    (rows[0] as Cell[]).push("=MAX(A2:T10001)", "=MIN(A2:T10001)");
    const ev = evaluateSheet(sheetOf(rows), { budget: 10_000_000 });
    expect(ev.value(2, 20)).toBe(199_999);
    expect(ev.value(2, 21)).toBe(0);
  });

  it("evaluates 50,000 formulas under the browser budget quickly", () => {
    const rows: Cell[][] = [];
    for (let i = 0; i < 10_000; i++) {
      const r = i + 2;
      rows.push([
        i,
        `=A${r}*2`,
        `=B${r}+1`,
        `=IF(C${r}>10,"big","small")`,
        `=A${r}&"x"`,
        `=ROUND(A${r}/3,2)`,
      ]);
    }
    const t0 = Date.now();
    const ev = evaluateSheet(sheetOf(rows), { budget: LIMITS.sheetEvalBrowserBudget });
    expect(ev.exhausted).toBe(false);
    expect(ev.value(10_001, 2)).toBe(19_999);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
