// The formula lexer. A formula is the text after a cell's leading "=". Tokens carry their position,
// so refs.ts can rewrite references in place and leave every other character as written.
//
// Supported: numbers, "..." strings with "" for a quote, TRUE and FALSE, Excel's error literals,
// cell references (A1, $A$1), ranges (A1:B5, A:A, 2:2), function names before "(", operators and
// punctuation. Not supported, by design: sheet names, external references ([book]), defined names,
// structured references, array constants and "@".
import { A1_MAX_COL, A1_MAX_ROW, type CellRef, colIndex, parseA1 } from "../address.ts";

/** Excel's error literals a formula may write. #CYCLE! and #LIMIT! are Plinth's, never literals. */
export const ERROR_LITERALS = [
  "#DIV/0!",
  "#N/A",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#NULL!",
] as const;

/** One end of a range: a cell, a whole column (A:A) or a whole row (2:2). */
export type RangeEnd =
  | { kind: "cell"; ref: CellRef }
  | { kind: "col"; col: number; abs: boolean }
  | { kind: "row"; row: number; abs: boolean };

export type Token = { start: number; end: number } & (
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: (typeof ERROR_LITERALS)[number] }
  | { t: "ref"; ref: CellRef }
  | { t: "range"; a: RangeEnd; b: RangeEnd }
  | { t: "func"; name: string }
  | { t: "op"; v: string }
  | { t: "("; v: "(" }
  | { t: ")"; v: ")" }
  | { t: ","; v: "," }
  | { t: "eof" }
);

export class FormulaSyntaxError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

const WS = /\s+/y;
const STRING = /"(?:[^"]|"")*"/y;
const ERROR = /#(?:DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!)/iy;
const CELL_RANGE = /(\$?[A-Za-z]{1,3}\$?\d+):(\$?[A-Za-z]{1,3}\$?\d+)(?![A-Za-z0-9_.(])/y;
const COL_RANGE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/y;
const ROW_RANGE = /(\$?)(\d+):(\$?)(\d+)(?![A-Za-z0-9_.(])/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const REF = /\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_.(])/y;
const IDENT = /[A-Za-z_\\][A-Za-z0-9_.]*/y;
const OPS = ["<=", ">=", "<>", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%"];

function at(re: RegExp, src: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(src);
}

function cellEnd(text: string, pos: number): RangeEnd {
  const ref = parseA1(text);
  if (!ref) throw new FormulaSyntaxError(`${text} is not a cell this sheet can name`, pos);
  return { kind: "cell", ref };
}

/** Every token of `src`, ending with eof. Throws FormulaSyntaxError at the first bad character. */
export function lexFormula(src: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  const n = src.length;
  while (pos < n) {
    const ws = at(WS, src, pos);
    if (ws) {
      pos += ws[0].length;
      continue;
    }
    const start = pos;
    const ch = src[pos] as string;
    let m: RegExpExecArray | null;
    if (ch === '"') {
      m = at(STRING, src, pos);
      if (!m) throw new FormulaSyntaxError("A string is missing its closing quote", pos);
      pos += m[0].length;
      out.push({ t: "str", v: m[0].slice(1, -1).replace(/""/g, '"'), start, end: pos });
      continue;
    }
    if (ch === "#") {
      m = at(ERROR, src, pos);
      if (!m) throw new FormulaSyntaxError("Unknown error value", pos);
      pos += m[0].length;
      const v = m[0].toUpperCase() as (typeof ERROR_LITERALS)[number];
      out.push({ t: "err", v, start, end: pos });
      continue;
    }
    m = at(CELL_RANGE, src, pos);
    if (m) {
      pos += m[0].length;
      const a = cellEnd(m[1] as string, start);
      const b = cellEnd(m[2] as string, start + (m[1] as string).length + 1);
      out.push({ t: "range", a, b, start, end: pos });
      continue;
    }
    m = at(COL_RANGE, src, pos);
    if (m) {
      const x = colIndex(m[2] as string);
      const y = colIndex(m[4] as string);
      if (x > A1_MAX_COL || y > A1_MAX_COL) {
        throw new FormulaSyntaxError(`${m[0]} names a column past the last one`, pos);
      }
      pos += m[0].length;
      out.push({
        t: "range",
        a: { kind: "col", col: x, abs: m[1] === "$" },
        b: { kind: "col", col: y, abs: m[3] === "$" },
        start,
        end: pos,
      });
      continue;
    }
    m = at(ROW_RANGE, src, pos);
    if (m) {
      const x = Number(m[2]);
      const y = Number(m[4]);
      if (x < 1 || y < 1 || x > A1_MAX_ROW || y > A1_MAX_ROW) {
        throw new FormulaSyntaxError(`${m[0]} names a row that does not exist`, pos);
      }
      pos += m[0].length;
      out.push({
        t: "range",
        a: { kind: "row", row: x, abs: m[1] === "$" },
        b: { kind: "row", row: y, abs: m[3] === "$" },
        start,
        end: pos,
      });
      continue;
    }
    m = at(NUMBER, src, pos);
    if (m) {
      pos += m[0].length;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw new FormulaSyntaxError(`${m[0]} is too large`, start);
      out.push({ t: "num", v, start, end: pos });
      continue;
    }
    m = at(REF, src, pos);
    if (m) {
      const ref = parseA1(m[0]);
      if (!ref) throw new FormulaSyntaxError(`${m[0]} is not a cell this sheet can name`, pos);
      pos += m[0].length;
      out.push({ t: "ref", ref, start, end: pos });
      continue;
    }
    m = at(IDENT, src, pos);
    if (m) {
      const word = m[0];
      pos += word.length;
      let next = pos;
      while (next < n && /\s/.test(src[next] as string)) next++;
      if (src[next] === "(") {
        out.push({ t: "func", name: word.toUpperCase(), start, end: pos });
        continue;
      }
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        out.push({ t: "bool", v: upper === "TRUE", start, end: pos });
        continue;
      }
      throw new FormulaSyntaxError(
        `${word} is not a cell or a function; names, other sheets and other files are not supported`,
        start,
      );
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      pos++;
      out.push({ t: ch, v: ch, start, end: pos } as Token);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, pos));
    if (op) {
      pos += op.length;
      out.push({ t: "op", v: op, start, end: pos });
      continue;
    }
    throw new FormulaSyntaxError(
      ch === "[" || ch === "!" || ch === "{" || ch === "@" || ch === ";"
        ? `"${ch}" is not supported: no other sheets, files, arrays or "@"`
        : `Unexpected character "${ch}"`,
      pos,
    );
  }
  out.push({ t: "eof", start: n, end: n });
  return out;
}
