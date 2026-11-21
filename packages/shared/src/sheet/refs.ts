// Rewriting references when rows or columns are inserted or deleted, as Excel does for structural
// changes: references at or past an insert move by the count, references into a deleted range
// become #REF!, ranges grow or shrink, and absolute ($) references move like relative ones (this
// is a structural change, not a fill). Everything else in the formula is kept byte for byte.
//
// Moving rows (a live sheet's `move_rows`) is a cut and insert: references into the moved rows
// follow them, and every other reference shifts as for a delete of the moved rows followed by an
// insert where they land. A range is the span of rows it covers: one that holds every row the
// move reorders stays as it is, and otherwise it takes whichever reading of the reorder (the rows
// moved, or the rows they pass moved the other way) changes the fewest of its rows (moveRange).
// Nothing becomes #REF!.
import { A1_MAX_COL, A1_MAX_ROW, type CellRef, colLetter } from "./address.ts";
import { lexFormula, type RangeEnd } from "./formula/lexer.ts";

export type StructuralChange =
  /** `before` is the A1 row the new rows take; rows from it on move down. */
  | { kind: "insert_rows"; before: number; count: number }
  /** Rows `from` to `from + count - 1` (A1). */
  | { kind: "delete_rows"; from: number; count: number }
  /** `before` is the column index the new columns take. */
  | { kind: "insert_columns"; before: number; count: number }
  | { kind: "delete_columns"; from: number; count: number }
  /**
   * Rows `from` to `from + count - 1` (A1) taken out and put back so that the first of them is
   * row `to` afterwards.
   */
  | { kind: "move_rows"; from: number; count: number; to: number };

const rowsChange = (c: StructuralChange) =>
  c.kind === "insert_rows" || c.kind === "delete_rows" || c.kind === "move_rows";

type RowMove = Extract<StructuralChange, { kind: "move_rows" }>;

/** Where row `p` is after a move: a moved row follows it, any other shifts past the gap. */
function moveRow(p: number, c: RowMove): number {
  const end = c.from + c.count - 1;
  if (p >= c.from && p <= end) return p - c.from + c.to;
  const out = p > end ? p - c.count : p;
  return out >= c.to ? out + c.count : out;
}

/** A position after the change, or null when it was deleted. */
function movePoint(p: number, c: StructuralChange, max: number): number | null {
  if (c.kind === "move_rows") return moveRow(p, c);
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

/**
 * The same reorder read the other way: moving rows past their neighbours is moving those
 * neighbours past them (row 5 up to 4 is row 4 down to 5).
 */
function otherMove(c: RowMove): RowMove {
  return c.to > c.from
    ? { kind: "move_rows", from: c.from + c.count, count: c.to - c.from, to: c.from }
    : { kind: "move_rows", from: c.to, count: c.from - c.to, to: c.to + c.count };
}

/**
 * A span after the move, read as `c`: inside the moved rows it follows them, and otherwise it
 * shrinks or grows as a delete of the moved rows, then an insert where they land, would.
 */
function readMove(lo: number, hi: number, c: RowMove): [number, number] {
  const end = c.from + c.count - 1;
  if (lo >= c.from && hi <= end) return [lo - c.from + c.to, hi - c.from + c.to];
  const out = moveSpan(lo, hi, { kind: "delete_rows", from: c.from, count: c.count }, A1_MAX_ROW);
  if (!out) return [lo, hi];
  const ins = moveSpan(
    out[0],
    out[1],
    { kind: "insert_rows", before: c.to, count: c.count },
    A1_MAX_ROW,
  );
  return ins ?? out;
}

/** How many of rows `lo` to `hi` are in rows `x` to `y` once the move is made. */
function keptRows(lo: number, hi: number, x: number, y: number, c: RowMove): number {
  const end = c.from + c.count - 1;
  const down = c.to > c.from;
  // Each block of rows shifts as one: the moved rows, the rows they pass, and the rest.
  const blocks: [number, number, number][] = [
    [c.from, end, c.to - c.from],
    down ? [end + 1, c.to + c.count - 1, -c.count] : [c.to, c.from - 1, c.count],
    [Number.NEGATIVE_INFINITY, Math.min(c.from, c.to) - 1, 0],
    [Math.max(end, c.to + c.count - 1) + 1, Number.POSITIVE_INFINITY, 0],
  ];
  let n = 0;
  for (const [s, t, d] of blocks) {
    const from = Math.max(s, lo) + d;
    const to = Math.min(t, hi) + d;
    n += Math.max(0, Math.min(to, y) - Math.max(from, x) + 1);
  }
  return n;
}

/**
 * A range's ends after a row move, read as the span of rows it covers. A span that holds every
 * row the move reorders only has them in a new order, so the range stays as it is. Otherwise the
 * move is read both ways (the rows moved, or the rows they pass moved the other way, which gives
 * the same order), and the range takes the reading that drops the fewest of its own rows plus
 * takes in the fewest others; on a tie, the shorter one, then the one that starts higher up. So
 * the result depends only on the new order of the rows, and a total moved next to its range never
 * adds itself. Each end keeps its own $, and the range keeps the direction it was written in.
 */
function moveRange(a: RangeEnd, b: RangeEnd, c: RowMove): [RangeEnd, RangeEnd] {
  if (a.kind === "col" || b.kind === "col") return [a, b];
  const rowOf = (e: RangeEnd) => (e.kind === "cell" ? e.ref.row : e.kind === "row" ? e.row : 0);
  const put = (e: RangeEnd, row: number): RangeEnd =>
    e.kind === "cell"
      ? { kind: "cell", ref: { ...e.ref, row } }
      : e.kind === "row"
        ? { ...e, row }
        : e;
  const ra = rowOf(a);
  const rb = rowOf(b);
  const lo = Math.min(ra, rb);
  const hi = Math.max(ra, rb);
  let span: [number, number] = [lo, hi];
  if (lo > Math.min(c.from, c.to) || hi < Math.max(c.from, c.to) + c.count - 1) {
    let best = Number.POSITIVE_INFINITY;
    for (const read of [c, otherMove(c)]) {
      const [x, y] = readMove(lo, hi, read);
      const kept = keptRows(lo, hi, x, y, c);
      const cost = hi - lo + 1 - kept + (y - x + 1 - kept);
      const len = y - x;
      const was = span[1] - span[0];
      if (cost < best || (cost === best && (len < was || (len === was && x < span[0])))) {
        best = cost;
        span = [x, y];
      }
    }
  }
  return ra <= rb ? [put(a, span[0]), put(b, span[1])] : [put(a, span[1]), put(b, span[0])];
}

/** The range's ends after the change, or null for #REF!. */
function shiftRange(a: RangeEnd, b: RangeEnd, c: StructuralChange): [RangeEnd, RangeEnd] | null {
  if (c.kind === "move_rows") return moveRange(a, b, c);
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

/** A reference copied by an offset: its relative parts move, its $ parts stay; null off the sheet. */
function offsetRef(ref: CellRef, dRow: number, dCol: number): CellRef | null {
  const row = ref.rowAbs ? ref.row : ref.row + dRow;
  const col = ref.colAbs ? ref.col : ref.col + dCol;
  if (row < 1 || row > A1_MAX_ROW || col < 0 || col > A1_MAX_COL) return null;
  return { ...ref, row, col };
}

function offsetEnd(e: RangeEnd, dRow: number, dCol: number): RangeEnd | null {
  if (e.kind === "cell") {
    const ref = offsetRef(e.ref, dRow, dCol);
    return ref ? { kind: "cell", ref } : null;
  }
  if (e.kind === "col") {
    const col = e.abs ? e.col : e.col + dCol;
    return col < 0 || col > A1_MAX_COL ? null : { ...e, col };
  }
  const row = e.abs ? e.row : e.row + dRow;
  return row < 1 || row > A1_MAX_ROW ? null : { ...e, row };
}

/**
 * A formula copied `dRow` rows down and `dCol` columns right (negative: up, left), as Excel's fill
 * and paste copy one: relative references move by the offset, the parts written with $ stay, and
 * a reference that would leave the sheet becomes #REF!. Text that is not a formula, or a formula
 * that does not lex, is returned as it is.
 */
export function offsetFormula(cell: string, dRow: number, dCol: number): string {
  if (!cell.startsWith("=") || (dRow === 0 && dCol === 0)) return cell;
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
      const r = offsetRef(t.ref, dRow, dCol);
      replacement = r ? cellText(r) : "#REF!";
    } else if (t.t === "range") {
      const a = offsetEnd(t.a, dRow, dCol);
      const b = offsetEnd(t.b, dRow, dCol);
      replacement = a && b ? `${endText(a)}:${endText(b)}` : "#REF!";
    }
    if (replacement !== null) {
      out += src.slice(last, t.start) + replacement;
      last = t.end;
    }
  }
  return `=${out}${src.slice(last)}`;
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
