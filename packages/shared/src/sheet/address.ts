// A1 addresses for sheets. Rows are 1-based A1 row numbers (row 1 is the header line), columns are
// 0-based indexes (A is 0). Pure, no dependencies: the Worker, the renderer and the CLI's server
// share it.

/** The last column a formula may name (Excel's XFD) and the last row (Excel's 1048576). */
export const A1_MAX_COL = 16_383;
export const A1_MAX_ROW = 1_048_576;

/** "A" for 0, "Z" for 25, "AA" for 26, ..., "CV" for 99. */
export function colLetter(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 0 for "A", 99 for "CV"; -1 for anything that is not 1 to 3 letters. Case-insensitive. */
export function colIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "B7" for row 7, column 1. */
export function a1(row: number, col: number): string {
  return `${colLetter(col)}${row}`;
}

export interface CellRef {
  row: number;
  col: number;
  rowAbs: boolean;
  colAbs: boolean;
}

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/;

/** "B7", "$B$7", "b$7": the cell, or null. Rows and columns past Excel's last are null. */
export function parseA1(s: string): CellRef | null {
  const m = CELL_RE.exec(s);
  if (!m) return null;
  const col = colIndex(m[2] as string);
  const row = Number(m[4]);
  if (col < 0 || col > A1_MAX_COL || row > A1_MAX_ROW) return null;
  return { row, col, colAbs: m[1] === "$", rowAbs: m[3] === "$" };
}

/** A rectangle of cells, inclusive. Whole columns run to A1_MAX_ROW, whole rows to A1_MAX_COL. */
export interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/**
 * "A1:D20", "B:D" (whole columns), "2:50" (whole rows) or one cell "B7": the range with its
 * corners ordered, or null.
 */
export function parseRange(s: string): CellRange | null {
  const t = s.trim();
  const parts = t.split(":");
  if (parts.length === 1) {
    const c = parseA1(parts[0] as string);
    return c ? { r1: c.row, c1: c.col, r2: c.row, c2: c.col } : null;
  }
  if (parts.length !== 2) return null;
  const [a, b] = parts as [string, string];
  const ca = parseA1(a);
  const cb = parseA1(b);
  if (ca && cb) return ordered(ca.row, ca.col, cb.row, cb.col);
  const cols = /^\$?([A-Za-z]{1,3})$/;
  const ma = cols.exec(a);
  const mb = cols.exec(b);
  if (ma && mb) {
    const x = colIndex(ma[1] as string);
    const y = colIndex(mb[1] as string);
    if (x < 0 || y < 0 || x > A1_MAX_COL || y > A1_MAX_COL) return null;
    return ordered(1, x, A1_MAX_ROW, y);
  }
  const rows = /^\$?([1-9]\d{0,6})$/;
  const ra = rows.exec(a);
  const rb = rows.exec(b);
  if (ra && rb) {
    const x = Number(ra[1]);
    const y = Number(rb[1]);
    if (x > A1_MAX_ROW || y > A1_MAX_ROW) return null;
    return ordered(x, 0, y, A1_MAX_COL);
  }
  return null;
}

function ordered(ra: number, ca: number, rb: number, cb: number): CellRange {
  return {
    r1: Math.min(ra, rb),
    c1: Math.min(ca, cb),
    r2: Math.max(ra, rb),
    c2: Math.max(ca, cb),
  };
}
