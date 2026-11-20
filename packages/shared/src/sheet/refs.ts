// Rewriting references when rows or columns are inserted or deleted, as Excel does for structural
// changes: references at or past an insert move by the count, references into a deleted range
// become #REF!, ranges grow or shrink, and absolute ($) references move like relative ones (this
// is a structural change, not a fill). Everything else in the formula is kept byte for byte.
import { A1_MAX_COL, A1_MAX_ROW, type CellRef, colLetter } from "./address.ts";
import { lexFormula, type RangeEnd } from "./formula/lexer.ts";

export type StructuralChange =
  /** `before` is the A1 row the new rows take; rows from it on move down. */
  | { kind: "insert_rows"; before: number; count: number }
  /** Rows `from` to `from + count - 1` (A1). */
  | { kind: "delete_rows"; from: number; count: number }
  /** `before` is the column index the new columns take. */
  | { kind: "insert_columns"; before: number; count: number }
  | { kind: "delete_columns"; from: number; count: number };

const rowsChange = (c: StructuralChange) => c.kind === "insert_rows" || c.kind === "delete_rows";

/** A position after the change, or null when it was deleted. */
function movePoint(p: number, c: StructuralChange, max: number): number | null {
  if (c.kind === "insert_rows" || c.kind === "insert_columns") {
    const q = p >= c.before ? p + c.count : p;
    return q > max ? null : q;
  }
  const end = c.from + c.count - 1;
  if (p < c.from) return p;
  if (p > end) return p - c.count;
  return null;
}

/** A span [lo, hi] after the change, or null when every position in it was deleted. */
function moveSpan(
  lo: number,
  hi: number,
  c: StructuralChange,
  max: number,
): [number, number] | null {
  if (c.kind === "insert_rows" || c.kind === "insert_columns") {
    const a = lo >= c.before ? lo + c.count : lo;
    const b = hi >= c.before ? hi + c.count : hi;
    if (a > max) return null;
    return [a, Math.min(b, max)];
  }
  const end = c.from + c.count - 1;
  if (lo >= c.from && hi <= end) return null;
  const a = lo < c.from ? lo : lo > end ? lo - c.count : c.from;
  const b = hi < c.from ? hi : hi > end ? hi - c.count : c.from - 1;
  return b < a ? null : [a, b];
}

function cellText(r: CellRef): string {
  return `${r.colAbs ? "$" : ""}${colLetter(r.col)}${r.rowAbs ? "$" : ""}${r.row}`;
}

function endText(e: RangeEnd): string {
  if (e.kind === "cell") return cellText(e.ref);
  if (e.kind === "col") return `${e.abs ? "$" : ""}${colLetter(e.col)}`;
  return `${e.abs ? "$" : ""}${e.row}`;
}

function shiftRef(ref: CellRef, c: StructuralChange): CellRef | null {
  if (rowsChange(c)) {
    const row = movePoint(ref.row, c, A1_MAX_ROW);
    return row === null ? null : { ...ref, row };
  }
  const col = movePoint(ref.col, c, A1_MAX_COL);
  return col === null ? null : { ...ref, col };
}

/** The range's ends after the change, or null for #REF!. */
function shiftRange(a: RangeEnd, b: RangeEnd, c: StructuralChange): [RangeEnd, RangeEnd] | null {
  const rows = rowsChange(c);
  if (a.kind === "col" && b.kind === "col") {
    if (rows) return [a, b];
    const lo = Math.min(a.col, b.col);
    const hi = Math.max(a.col, b.col);
    const s = moveSpan(lo, hi, c, A1_MAX_COL);
    if (!s) return null;
    const [x, y] = a.col <= b.col ? s : [s[1], s[0]];
    return [
      { ...a, col: x },
      { ...b, col: y },
    ];
  }
  if (a.kind === "row" && b.kind === "row") {
    if (!rows) return [a, b];
    const lo = Math.min(a.row, b.row);
    const hi = Math.max(a.row, b.row);
    const s = moveSpan(lo, hi, c, A1_MAX_ROW);
    if (!s) return null;
    const [x, y] = a.row <= b.row ? s : [s[1], s[0]];
    return [
      { ...a, row: x },
      { ...b, row: y },
    ];
  }
  if (a.kind !== "cell" || b.kind !== "cell") return [a, b];
  const key = rows ? "row" : "col";
  const max = rows ? A1_MAX_ROW : A1_MAX_COL;
  const lo = Math.min(a.ref[key], b.ref[key]);
  const hi = Math.max(a.ref[key], b.ref[key]);
  const s = moveSpan(lo, hi, c, max);
  if (!s) return null;
  const [x, y] = a.ref[key] <= b.ref[key] ? s : [s[1], s[0]];
  return [
    { kind: "cell", ref: { ...a.ref, [key]: x } },
    { kind: "cell", ref: { ...b.ref, [key]: y } },
  ];
}

/**
 * A cell's formula ("=...") with its references moved for `change`. Text that is not a formula, or
 * a formula that does not lex, is returned as it is.
 */
export function shiftFormula(cell: string, change: StructuralChange): string {
  if (!cell.startsWith("=")) return cell;
  const src = cell.slice(1);
  let toks: ReturnType<typeof lexFormula>;
  try {
    toks = lexFormula(src);
  } catch {
    return cell;
  }
  let out = "";
  let last = 0;
  for (const t of toks) {
    let replacement: string | null = null;
    if (t.t === "ref") {
      const r = shiftRef(t.ref, change);
      if (!r) replacement = "#REF!";
      else if (r.row !== t.ref.row || r.col !== t.ref.col) replacement = cellText(r);
    } else if (t.t === "range") {
      const r = shiftRange(t.a, t.b, change);
      if (!r) replacement = "#REF!";
      else {
        const text = `${endText(r[0])}:${endText(r[1])}`;
        if (text !== `${endText(t.a)}:${endText(t.b)}`) replacement = text;
      }
    }
    if (replacement !== null) {
      out += src.slice(last, t.start) + replacement;
      last = t.end;
    }
  }
  return `=${out}${src.slice(last)}`;
}
