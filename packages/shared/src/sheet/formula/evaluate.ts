// The formula evaluator: a pure interpreter over the parser's AST. No eval, Function or with; a
// function is looked up by its upper-cased name in a Map; no property is read by a key the data
// supplies. Formula cells are computed in dependency order with an explicit stack (never JS
// recursion across cells), each once, and a cycle makes every cell on it #CYCLE!. Every AST node
// evaluated and every cell a range visits costs one step, text a function makes costs its length,
// and text a function or comparison reads costs a step per 32 characters (values.ts). When the
// budget runs out, every formula cell not yet computed is #LIMIT! and `exhausted` is set. The Worker (read_sheet, with the
// instance's SHEET_EVAL_BUDGET) and the renderer (LIMITS.sheetEvalBrowserBudget) run this same code.
import { A1_MAX_COL } from "../address.ts";
import { type Cell, isFormula, type Sheet } from "../format.ts";
import { type FunctionDef, SHEET_FUNCTIONS } from "./functions.ts";
import { type Node, parseFormula } from "./parser.ts";
import {
  compareValues,
  err,
  finite,
  isError,
  isoDateSerial,
  type SheetError,
  textCost,
  todaySerial,
  toNumber,
  toText,
  type Value,
} from "./values.ts";

/** A range argument as functions see it. Indexes are 0-based within the range. */
export interface RangeArg {
  readonly kind: "range";
  readonly r1: number;
  readonly c1: number;
  readonly height: number;
  readonly width: number;
  /** The cell at (i, j) of the range; empty outside the sheet. */
  at(i: number, j: number): Value;
  /** Every cell of the range inside the sheet, row by row; cells outside are empty. */
  each(fn: (v: Value, i: number, j: number) => void): void;
  /** How many of the range's cells lie outside the sheet (all empty). */
  readonly outside: number;
  /** Rows and columns of the range that lie inside the sheet. */
  readonly innerHeight: number;
  readonly innerWidth: number;
}

export type Arg = Value | RangeArg;

export function isRange(a: Arg): a is RangeArg {
  return typeof a === "object" && a !== null && (a as RangeArg).kind === "range";
}

/** What a function may call back into while it runs. */
export interface EvalContext {
  /** Evaluate an argument (a lazy function's own nodes). */
  arg(node: Node): Arg;
  /** Spend steps; throws when the budget is spent. */
  charge(steps: number): void;
  /** Text a function made: its length is charged, and past 32,767 characters it is #VALUE!. */
  text(s: string): string | SheetError;
  /** Today's date as a serial (UTC). */
  today(): number;
}

/** The result of evaluating a sheet. */
export interface SheetEvaluation {
  /** The value of any cell: a literal as formulas see it, or a formula's result. */
  value(row: number, col: number): Value;
  /** The budget ran out: some formulas are #LIMIT!. */
  readonly exhausted: boolean;
  readonly steps: number;
}

export interface EvaluateOptions {
  budget: number;
  /** Only these cells (A1 row, column) and what they depend on; default every formula cell. */
  cells?: readonly (readonly [number, number])[];
  /** Today as a serial, for tests; default the current UTC date. */
  today?: number;
}

/** The longest text a formula may make, as in Excel. */
export const MAX_TEXT_LENGTH = 32_767;

class LimitReached extends Error {}

const BUSY = 1;
const DONE = 2;
const KEY_COLS = A1_MAX_COL + 1;

interface Frame {
  key: number;
  row: number;
  col: number;
  deps: number[] | null;
  i: number;
}

class Evaluator implements EvalContext, SheetEvaluation {
  steps = 0;
  exhausted = false;
  private readonly lastRow: number;
  private readonly lastCol: number;
  private readonly state = new Map<number, number>();
  private readonly values = new Map<number, Value>();
  private readonly asts = new Map<number, Node | SheetError>();
  /** Rows that hold a formula, by column, ascending. */
  private readonly formulaRows: number[][];
  private readonly todayValue: number | undefined;

  private readonly sheet: Sheet;
  private readonly budget: number;

  constructor(sheet: Sheet, budget: number, today?: number) {
    this.sheet = sheet;
    this.budget = budget;
    this.lastRow = sheet.rows.length + 1;
    this.lastCol = sheet.header.columns.length - 1;
    this.todayValue = today;
    this.formulaRows = sheet.header.columns.map(() => []);
    sheet.rows.forEach((r, i) => {
      for (let c = 0; c < r.length && c <= this.lastCol; c++) {
        if (isFormula(r[c])) (this.formulaRows[c] as number[]).push(i + 2);
      }
    });
  }

  charge(n: number): void {
    this.steps += n;
    if (this.steps > this.budget) throw new LimitReached();
  }

  text(s: string): string | SheetError {
    if (s.length > MAX_TEXT_LENGTH) return err("#VALUE!");
    this.charge(s.length);
    return s;
  }

  today(): number {
    return this.todayValue ?? todaySerial();
  }

  private raw(row: number, col: number): Cell {
    if (row < 1 || col < 0 || row > this.lastRow || col > this.lastCol) return null;
    if (row === 1) return (this.sheet.header.columns[col] as { name: string }).name;
    return (this.sheet.rows[row - 2] as Cell[])[col] ?? null;
  }

  /** A literal cell as formulas see it: a date column's YYYY-MM-DD is its serial. */
  private literal(row: number, col: number, cell: Cell): Value {
    if (typeof cell !== "string") return cell;
    if (cell.startsWith("'")) return cell.slice(1);
    if (row > 1 && this.sheet.header.columns[col]?.type === "date") {
      return isoDateSerial(cell) ?? cell;
    }
    return cell;
  }

  value(row: number, col: number): Value {
    const cell = this.raw(row, col);
    if (!isFormula(cell) || row === 1) return this.literal(row, col, cell);
    const key = row * KEY_COLS + col;
    if (this.state.get(key) === DONE) return this.values.get(key) ?? null;
    if (this.exhausted) return err("#LIMIT!");
    this.compute(row, col);
    return this.state.get(key) === DONE ? (this.values.get(key) ?? null) : err("#LIMIT!");
  }

  private ast(row: number, col: number): Node | SheetError {
    const key = row * KEY_COLS + col;
    let a = this.asts.get(key);
    if (a === undefined) {
      const cell = this.raw(row, col) as string;
      const p = parseFormula(cell.slice(1));
      a = p.ok ? p.ast : err("#NAME?");
      this.asts.set(key, a);
    }
    return a;
  }

  /** Every formula cell a formula reads, statically (both branches of an IF, as Excel does). */
  private depsOf(row: number, col: number): number[] {
    const a = this.ast(row, col);
    const out: number[] = [];
    if (isError(a)) return out;
    const stack: Node[] = [a];
    while (stack.length) {
      const n = stack.pop() as Node;
      this.charge(1);
      switch (n.t) {
        case "ref":
          if (n.row > 1 && isFormula(this.raw(n.row, n.col))) out.push(n.row * KEY_COLS + n.col);
          break;
        case "range": {
          const c2 = Math.min(n.c2, this.lastCol);
          for (let c = n.c1; c <= c2; c++) {
            const rows = this.formulaRows[c] as number[];
            this.charge(1);
            let lo = lowerBound(rows, n.r1);
            while (lo < rows.length && (rows[lo] as number) <= n.r2) {
              out.push((rows[lo] as number) * KEY_COLS + c);
              this.charge(1);
              lo++;
            }
          }
          break;
        }
        case "neg":
        case "pos":
        case "pct":
          stack.push(n.e);
          break;
        case "bin":
          stack.push(n.a, n.b);
          break;
        case "call":
          for (const x of n.args) stack.push(x);
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** Compute one formula cell and everything it depends on, in order, without JS recursion. */
  compute(row: number, col: number): void {
    const key = row * KEY_COLS + col;
    if (this.state.get(key) === DONE || this.exhausted) return;
    const stack: Frame[] = [{ key, row, col, deps: null, i: 0 }];
    const onStack = new Map<number, number>([[key, 0]]);
    this.state.set(key, BUSY);
    try {
      while (stack.length) {
        const f = stack[stack.length - 1] as Frame;
        if (this.state.get(f.key) === DONE) {
          stack.pop();
          onStack.delete(f.key);
          continue;
        }
        f.deps ??= this.depsOf(f.row, f.col);
        let waiting = false;
        while (f.i < f.deps.length) {
          const d = f.deps[f.i] as number;
          const st = this.state.get(d);
          if (st === DONE) {
            f.i++;
            continue;
          }
          if (st === BUSY) {
            // A cycle: every cell from d's frame to the top is on it.
            const from = onStack.get(d) ?? stack.length - 1;
            for (let j = from; j < stack.length; j++)
              this.finish((stack[j] as Frame).key, err("#CYCLE!"));
            waiting = true;
            break;
          }
          this.state.set(d, BUSY);
          onStack.set(d, stack.length);
          stack.push({
            key: d,
            row: Math.floor(d / KEY_COLS),
            col: d % KEY_COLS,
            deps: null,
            i: 0,
          });
          waiting = true;
          break;
        }
        if (waiting) continue;
        const a = this.ast(f.row, f.col);
        const v = isError(a) ? a : this.scalarOf(this.eval(a));
        this.finish(f.key, v);
        stack.pop();
        onStack.delete(f.key);
      }
    } catch (e) {
      if (!(e instanceof LimitReached)) throw e;
      this.exhausted = true;
      for (const f of stack) if (this.state.get(f.key) === BUSY) this.state.delete(f.key);
    }
  }

  private finish(key: number, v: Value): void {
    this.state.set(key, DONE);
    this.values.set(key, v);
  }

  /** Every formula cell, row by row, or the given ones. */
  run(cells?: readonly (readonly [number, number])[]): void {
    if (cells) {
      for (const [r, c] of cells) {
        if (this.exhausted) return;
        if (isFormula(this.raw(r, c)) && r > 1) this.compute(r, c);
      }
      return;
    }
    for (let i = 0; i < this.sheet.rows.length && !this.exhausted; i++) {
      const r = this.sheet.rows[i] as Cell[];
      for (let c = 0; c < r.length && c <= this.lastCol; c++) {
        if (isFormula(r[c])) this.compute(i + 2, c);
        if (this.exhausted) return;
      }
    }
  }

  // ---------- expressions ----------

  /** A range as a value: one cell is that cell; more is #VALUE! (no arrays). */
  private scalarOf(a: Arg): Value {
    if (!isRange(a)) return a;
    if (a.height === 1 && a.width === 1) return a.at(0, 0);
    return err("#VALUE!");
  }

  arg(node: Node): Arg {
    return this.eval(node);
  }

  private range(r1: number, c1: number, r2: number, c2: number): RangeArg {
    const ev = this;
    const innerHeight = Math.max(0, Math.min(r2, this.lastRow) - r1 + 1);
    const innerWidth = Math.max(0, Math.min(c2, this.lastCol) - c1 + 1);
    const height = r2 - r1 + 1;
    const width = c2 - c1 + 1;
    return {
      kind: "range",
      r1,
      c1,
      height,
      width,
      innerHeight,
      innerWidth,
      outside: height * width - innerHeight * innerWidth,
      at(i, j) {
        ev.charge(1);
        return ev.value(r1 + i, c1 + j);
      },
      each(fn) {
        for (let i = 0; i < innerHeight; i++) {
          for (let j = 0; j < innerWidth; j++) {
            ev.charge(1);
            fn(ev.value(r1 + i, c1 + j), i, j);
          }
        }
      },
    };
  }

  private cellRange(row: number, col: number): RangeArg {
    this.charge(1);
    return this.range(row, col, row, col);
  }

  private eval(n: Node): Arg {
    this.charge(1);
    switch (n.t) {
      case "num":
        return n.v;
      case "str":
        return n.v;
      case "bool":
        return n.v;
      case "err":
        return err(n.v);
      case "missing":
        return null;
      case "ref":
        return this.value(n.row, n.col);
      case "range":
        return this.range(n.r1, n.c1, n.r2, n.c2);
      case "neg": {
        const x = toNumber(this.scalarOf(this.eval(n.e)));
        return isError(x) ? x : finite(-x);
      }
      case "pos":
        return this.scalarOf(this.eval(n.e));
      case "pct": {
        const x = toNumber(this.scalarOf(this.eval(n.e)));
        return isError(x) ? x : finite(x / 100);
      }
      case "bin":
        return this.binary(n.op, this.scalarOf(this.eval(n.a)), this.scalarOf(this.eval(n.b)));
      case "call": {
        const def = SHEET_FUNCTIONS.get(n.name) as FunctionDef | undefined;
        if (!def) return err("#NAME?");
        if (def.lazy) return def.fn(n.args, this);
        // A reference argument is a one-cell range, as in Excel: SUM(A1) skips text in A1, while
        // SUM("3") converts the text it is given.
        const args = n.args.map((a) =>
          a.t === "ref" ? this.cellRange(a.row, a.col) : this.eval(a),
        );
        return def.fn(args, this);
      }
    }
  }

  private binary(op: string, a: Value, b: Value): Value {
    if (op === "&") {
      const x = toText(a);
      if (isError(x)) return x;
      const y = toText(b);
      if (isError(y)) return y;
      return this.text(x + y);
    }
    if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      if (isError(a)) return a;
      if (isError(b)) return b;
      // Text compares without case: both sides are lowercased, and that costs their length.
      this.charge(textCost(a) + textCost(b));
      const c = compareValues(a, b);
      switch (op) {
        case "=":
          return c === 0;
        case "<>":
          return c !== 0;
        case "<":
          return c < 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        default:
          return c >= 0;
      }
    }
    const x = toNumber(a);
    if (isError(x)) return x;
    const y = toNumber(b);
    if (isError(y)) return y;
    switch (op) {
      case "+":
        return finite(x + y);
      case "-":
        return finite(x - y);
      case "*":
        return finite(x * y);
      case "/":
        return y === 0 ? err("#DIV/0!") : finite(x / y);
      case "^":
        if (x === 0 && y === 0) return err("#NUM!");
        if (x === 0 && y < 0) return err("#DIV/0!");
        return finite(x ** y);
      default:
        return err("#VALUE!");
    }
  }
}

function lowerBound(a: readonly number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Evaluate a sheet within a step budget. Formula cells are computed now (all of them, or `cells`
 * and their dependencies); value() reads any cell afterwards.
 */
export function evaluateSheet(sheet: Sheet, opts: EvaluateOptions): SheetEvaluation {
  const ev = new Evaluator(sheet, opts.budget, opts.today);
  ev.run(opts.cells);
  return ev;
}
