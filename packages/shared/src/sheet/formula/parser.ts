// The formula parser: tokens to an AST, by precedence climbing with Excel's operator order
// (highest first): ranges (in the lexer), unary - and +, %, ^, * and /, + and -, &, comparisons.
// As in Excel, -2^2 is 4 and 2^3^2 is 64 (^ is left-associative). A function must be one of the
// allowlist (functions.ts), with an argument count it takes; anything else is a parse error, so a
// stored formula only ever calls Plinth's own functions.
import { LIMITS } from "../../constants.ts";
import { A1_MAX_COL, A1_MAX_ROW } from "../address.ts";
import { FUNCTION_ARITY, SHEET_FUNCTION_NAMES } from "./arity.ts";
import {
  type ERROR_LITERALS,
  FormulaSyntaxError,
  lexFormula,
  type RangeEnd,
  type Token,
} from "./lexer.ts";

export type ErrorLiteral = (typeof ERROR_LITERALS)[number];

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorLiteral }
  | { t: "missing" }
  | { t: "ref"; row: number; col: number }
  | { t: "range"; r1: number; c1: number; r2: number; c2: number }
  | { t: "neg"; e: Node }
  | { t: "pos"; e: Node }
  | { t: "pct"; e: Node }
  | { t: "bin"; op: BinaryOp; a: Node; b: Node }
  | { t: "call"; name: string; args: Node[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type ParseResult =
  | { ok: true; ast: Node }
  | { ok: false; error: { pos: number; message: string } };

const BINARY_POWER: Record<string, number> = {
  "=": 10,
  "<>": 10,
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
  "&": 20,
  "+": 30,
  "-": 30,
  "*": 40,
  "/": 40,
  "^": 50,
};
const PERCENT_POWER = 60;
const PREFIX_POWER = 70;

/** The A1 corners of a range token. Whole columns span every row; whole rows every column. */
export function rangeCorners(
  a: RangeEnd,
  b: RangeEnd,
): { r1: number; c1: number; r2: number; c2: number } {
  if (a.kind === "col" && b.kind === "col") {
    return { r1: 1, c1: Math.min(a.col, b.col), r2: A1_MAX_ROW, c2: Math.max(a.col, b.col) };
  }
  if (a.kind === "row" && b.kind === "row") {
    return { r1: Math.min(a.row, b.row), c1: 0, r2: Math.max(a.row, b.row), c2: A1_MAX_COL };
  }
  if (a.kind === "cell" && b.kind === "cell") {
    return {
      r1: Math.min(a.ref.row, b.ref.row),
      c1: Math.min(a.ref.col, b.ref.col),
      r2: Math.max(a.ref.row, b.ref.row),
      c2: Math.max(a.ref.col, b.ref.col),
    };
  }
  throw new Error("A range's ends are of one kind");
}

class Parser {
  private i = 0;
  private depth = 0;
  private readonly toks: Token[];
  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.i] as Token;
  }

  private next(): Token {
    return this.toks[this.i++] as Token;
  }

  private nest(pos: number): void {
    if (++this.depth > LIMITS.maxSheetFormulaDepth) {
      throw new FormulaSyntaxError(
        `The formula nests deeper than ${LIMITS.maxSheetFormulaDepth} levels`,
        pos,
      );
    }
  }

  parse(): Node {
    const e = this.expr(0);
    const t = this.peek();
    if (t.t !== "eof") throw new FormulaSyntaxError(unexpected(t), t.start);
    return e;
  }

  private expr(minPower: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op") break;
      if (t.v === "%") {
        if (PERCENT_POWER <= minPower) break;
        this.next();
        left = { t: "pct", e: left };
        continue;
      }
      const power = BINARY_POWER[t.v];
      if (power === undefined || power <= minPower) break;
      this.next();
      const right = this.expr(power);
      left = { t: "bin", op: t.v as BinaryOp, a: left, b: right };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.t) {
      case "num":
        return { t: "num", v: t.v };
      case "str":
        return { t: "str", v: t.v };
      case "bool":
        return { t: "bool", v: t.v };
      case "err":
        return { t: "err", v: t.v };
      case "ref":
        return { t: "ref", row: t.ref.row, col: t.ref.col };
      case "range":
        return { t: "range", ...rangeCorners(t.a, t.b) };
      case "op":
        if (t.v === "-" || t.v === "+") {
          this.nest(t.start);
          const e = this.expr(PREFIX_POWER);
          this.depth--;
          return t.v === "-" ? { t: "neg", e } : { t: "pos", e };
        }
        throw new FormulaSyntaxError(unexpected(t), t.start);
      case "(": {
        this.nest(t.start);
        const e = this.expr(0);
        this.expect(")", "A ( is missing its )");
        this.depth--;
        return e;
      }
      case "func":
        return this.call(t);
      default:
        throw new FormulaSyntaxError(unexpected(t), t.start);
    }
  }

  private call(t: Extract<Token, { t: "func" }>): Node {
    const arity = Object.hasOwn(FUNCTION_ARITY, t.name) ? FUNCTION_ARITY[t.name] : undefined;
    if (!arity) {
      throw new FormulaSyntaxError(
        `${t.name} is not a function sheets support (supported: ${SHEET_FUNCTION_NAMES.join(", ")})`,
        t.start,
      );
    }
    this.nest(t.start);
    this.expect("(", `${t.name} needs (`);
    const args: Node[] = [];
    if (this.peek().t === ")") {
      this.next();
    } else {
      for (;;) {
        const p = this.peek();
        args.push(p.t === "," || p.t === ")" ? { t: "missing" } : this.expr(0));
        const sep = this.next();
        if (sep.t === ")") break;
        if (sep.t !== ",") throw new FormulaSyntaxError(`${t.name}: expected , or )`, sep.start);
      }
    }
    this.depth--;
    const [min, max] = arity;
    if (args.length < min || args.length > max) {
      const want =
        min === max
          ? `${min} argument${min === 1 ? "" : "s"}`
          : max === Number.POSITIVE_INFINITY
            ? `at least ${min} argument${min === 1 ? "" : "s"}`
            : `${min} to ${max} arguments`;
      throw new FormulaSyntaxError(`${t.name} takes ${want}, not ${args.length}`, t.start);
    }
    return { t: "call", name: t.name, args };
  }

  private expect(kind: "(" | ")", message: string): void {
    const t = this.next();
    if (t.t !== kind) throw new FormulaSyntaxError(message, t.start);
  }
}

function unexpected(t: Token): string {
  if (t.t === "eof") return "The formula ends too early";
  if (t.t === ")") return "Unexpected )";
  if (t.t === ",") return "Unexpected , (a list of values only goes inside a function)";
  if (t.t === "op") return `Unexpected ${t.v}`;
  return "Unexpected value: an operator is missing";
}

/** Parse the text after "=". Never throws. */
export function parseFormula(src: string): ParseResult {
  try {
    if (src.trim() === "") return { ok: false, error: { pos: 0, message: "The formula is empty" } };
    return { ok: true, ast: new Parser(lexFormula(src)).parse() };
  } catch (e) {
    if (e instanceof FormulaSyntaxError)
      return { ok: false, error: { pos: e.pos, message: e.message } };
    throw e;
  }
}
