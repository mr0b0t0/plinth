// The formula engine: Excel's precedence and coercions, references and ranges, errors, the
// functions sheets support, cycles and the step budget.
import { describe, expect, it } from "vitest";
import {
  type Cell,
  dateSerial,
  evaluateSheet,
  LIMITS,
  NUMERIC_TEXT,
  numberFromText,
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

  it("shows an empty cell a formula returns as blank, as Google Sheets does, and as 0 in math", () => {
    const rows: Cell[][] = [[null, 5]];
    // Excel shows 0 for these; Plinth keeps the cell blank (DECISIONS.md).
    expect(calc("A2", rows)).toBe(null);
    expect(calc('IF(TRUE,A2,"x")', rows)).toBe(null);
    expect(calc("INDEX(A2:B2,1,1)", rows)).toBe(null);
    // In arithmetic and text an empty cell is 0 and "", as in both.
    expect(calc("A2+1", rows)).toBe(1);
    expect(calc("A2*B2", rows)).toBe(0);
    expect(calc('A2&"x"', rows)).toBe("x");
    expect(calc("A2=0", rows)).toBe(true);
  });

  it("reads numeric text in time linear in its length", () => {
    expect(numberFromText("1.")).toBe(1);
    expect(numberFromText(" .5 ")).toBe(0.5);
    expect(numberFromText("+3.25E-2")).toBe(0.0325);
    expect(numberFromText("-12e3")).toBe(-12_000);
    expect(numberFromText("50%")).toBe(0.5);
    expect(numberFromText("1.2.3")).toBe(null);
    expect(numberFromText("1e")).toBe(null);
    expect(numberFromText(".")).toBe(null);
    // A digit run with a bad tail: `\d+\.?\d*` tried every split of the run, about 1 ms for
    // 1,024 characters and twice that with a %, charged only the steps around the conversion.
    const start = Date.now();
    for (let i = 0; i < 1_000; i++) numberFromText(`${"1".repeat(1_022)}x%`);
    expect(NUMERIC_TEXT.test(`${"1".repeat(100_000)}x`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(250);
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

  it("charges the text a function or comparison reads, a step per 32 characters", () => {
    // A2 is the longest text a formula makes; its REPT costs 32,767 steps (text made).
    const long = '=REPT("x",32767)';
    const steps = (formula: string) => {
      const ev = evaluateSheet(sheetOf([[long, formula]]), { budget: 10_000_000 });
      return ev.steps - evaluateSheet(sheetOf([[long, "=1"]]), { budget: 10_000_000 }).steps;
    };
    const read = Math.floor(32_767 / 32);
    for (const f of [
      "=LEN(A2)",
      "=MID(A2,32767,1)",
      '=FIND("y",A2)',
      '=SEARCH("y",A2)',
      '=SUBSTITUTE(A2,"x","")',
      "=EXACT(A2,A2)",
      '=A2="x"',
      "=COUNTIF(A2:A2,A2)",
      "=MATCH(A2,A2:A3,0)",
      '=SWITCH(A2,"x",1,2)',
    ]) {
      expect(steps(f), f).toBeGreaterThanOrEqual(read);
    }
    // Only the text walked: the first or last character of it costs a few steps.
    expect(steps("=LEFT(A2)")).toBeLessThan(20);
    expect(steps("=RIGHT(A2)")).toBeLessThan(20);
    // Characters are code points, walked without an array: a surrogate pair is one.
    const pairs = [["𝄞a𝄞", "=LEN(A2)", "=LEFT(A2,2)", "=RIGHT(A2,2)", "=MID(A2,2,2)"]];
    const ev = evaluateSheet(sheetOf(pairs), { budget: 1_000 });
    expect([1, 2, 3, 4].map((c) => ev.value(2, c))).toEqual([3, "𝄞a", "a𝄞", "a𝄞"]);
  });

  it("bounds the CPU of one long text read many times", () => {
    // 451 formulas of 249 LEN(A2) each: when a read was free, 200,000 steps took 1.4 s here.
    const f = `=${Array(249).fill("LEN(A2)").join("+")}`;
    const rows: Cell[][] = [['=REPT("x",32767)']];
    for (let i = 0; i < 91; i++) rows.push(Array(5).fill(f));
    const t0 = Date.now();
    const ev = evaluateSheet(sheetOf(rows), { budget: 200_000 });
    expect(ev.exhausted).toBe(true);
    expect(ev.value(3, 0)).toEqual(E("#LIMIT!"));
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("charges what a text function reads, not only what it returns", () => {
    const steps = (a2: string, formula: string) => {
      const ev = evaluateSheet(sheetOf([[a2, formula]]), { budget: 10_000_000 });
      return ev.steps - evaluateSheet(sheetOf([[a2, "=1"]]), { budget: 10_000_000 }).steps;
    };
    const spaces = '=REPT(" ",32767)';
    const read = Math.floor(32_767 / 32);
    // TRIM returns "" here, but reads all 32,767 characters.
    expect(steps(spaces, "=TRIM(A2)")).toBeGreaterThanOrEqual(read);
    // SUBSTITUTE pays a step per match: 32,767 one-character matches split into 32,768 pieces.
    const xs = '=REPT("x",32767)';
    expect(steps(xs, '=SUBSTITUTE(A2,"x","")')).toBeGreaterThanOrEqual(32_767);
    expect(steps(xs, '=SUBSTITUTE(A2,"x","",30000)')).toBeGreaterThanOrEqual(30_000);
    // With no match it costs its read and the text it returns, as before.
    expect(steps(xs, '=SUBSTITUTE(A2,"y","")')).toBeLessThan(read + 32_767 + 20);
    expect(calc('TRIM("  a   b  ")')).toBe("a b");
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
  });

  it("bounds the CPU of a long text trimmed many times", () => {
    // 100 TRIMs of 32,767 spaces per formula: when TRIM was charged only for the "" it returns,
    // 200,000 steps took about 190 ms here; now at most 200,000 / 1,023 of them run.
    const f = `=${Array(100).fill("TRIM($A$2)").join("&")}`;
    const rows: Cell[][] = [['=REPT(" ",32767)']];
    for (let i = 0; i < 200; i++) rows.push(Array(5).fill(f));
    const t0 = Date.now();
    const ev = evaluateSheet(sheetOf(rows), { budget: 200_000 });
    expect(ev.exhausted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("never reads text longer than 1,024 characters as a number or a boolean", () => {
    expect(calc('VALUE(REPT("0",1023)&"7")')).toBe(7);
    expect(calc('VALUE(REPT("0",1024)&"7")')).toEqual(E("#VALUE!"));
    expect(calc('REPT("0",1025)+1')).toEqual(E("#VALUE!"));
    expect(calc('IF(REPT(" ",1020)&"TRUE",1,2)')).toBe(1);
    expect(calc('IF(REPT(" ",1021)&"TRUE",1,2)')).toEqual(E("#VALUE!"));
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
