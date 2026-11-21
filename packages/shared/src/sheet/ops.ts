// Cell, row and column changes to a sheet (edit_sheet's ops, and `move_rows`, which only a live
// sheet's struct frame sends: edit_sheet's schema does not take it). Pure and atomic: applySheetOps works
// on a copy and throws SheetOpError (with the op's index) for the first op it cannot apply, so the
// caller's sheet never changes. Inserting or deleting rows and columns moves the references of
// every formula (refs.ts). The result is not checked against the column types here: the caller
// parses the serialized result once, after every op, so an agent can change a column's type and
// fix its cells in one call.
//
// Cell styles (sheet.styles) follow their cells: rows inserted, deleted or moved take their styles
// with them, and so do columns. `format` changes the styles of a range and nothing else.
import { LIMITS } from "../constants.ts";
import { colIndex, colLetter, parseA1, parseRange } from "./address.ts";
import {
  type Cell,
  isFormula,
  MAX_FREEZE_COLS,
  parseSheet,
  type Sheet,
  type SheetColor,
  type SheetColumn,
  type SheetColumnType,
  type SheetHighlightRule,
  type SheetNumberFormat,
  type SheetRowStyle,
  serializeSheet,
} from "./format.ts";
import { mergeCellStyle, type SheetStyleChange } from "./looks.ts";
import { type StructuralChange, shiftFormula } from "./refs.ts";

export interface SheetColumnInput {
  name: string;
  type?: SheetColumnType;
  width?: number;
  format?: SheetNumberFormat;
  options?: string[];
  colors?: Record<string, SheetColor>;
  highlight?: SheetHighlightRule[];
}

export type SheetOp =
  | { op: "set"; at: string; values: Cell[][] }
  | { op: "append_rows"; values: Cell[][] }
  | { op: "insert_rows"; before: number; count?: number; values?: Cell[][] }
  | { op: "delete_rows"; from: number; count?: number }
  /** Rows `from` to `from + count - 1` (A1) moved so that the first of them is row `to`. */
  | { op: "move_rows"; from: number; count?: number; to: number }
  | {
      op: "set_column";
      column: string;
      name?: string;
      type?: SheetColumnType;
      format?: SheetNumberFormat | null;
      options?: string[] | null;
      width?: number | null;
      /** A select column's option colours (replaces them); null clears them. */
      colors?: Record<string, SheetColor> | null;
      /** The highlight rules (replaces them); null clears them. */
      highlight?: SheetHighlightRule[] | null;
    }
  | { op: "insert_columns"; before: string; columns: SheetColumnInput[] }
  | { op: "delete_columns"; from: string; count?: number }
  /** The styles of a range's cells changed (SheetStyleChange); `style` null clears them. */
  | { op: "format"; range: string; style: SheetStyleChange | null };

export class SheetOpError extends Error {
  readonly index: number;
  /** A stable name for a refusal callers may act on (details.reason), when it has one. */
  readonly reason: string | undefined;
  constructor(index: number, message: string, reason?: string) {
    super(message);
    this.index = index;
    this.reason = reason;
  }
}

export interface SheetOpChanges {
  cells: number;
  rows_inserted: number;
  rows_deleted: number;
  columns_inserted: number;
  columns_deleted: number;
  /** Cells whose style a `format` op set or cleared. */
  cells_styled: number;
}

function copyColors(c: Record<string, SheetColor>): Record<string, SheetColor> {
  return Object.assign(Object.create(null) as Record<string, SheetColor>, c);
}

function copySheet(s: Sheet): Sheet {
  const out: Sheet = {
    header: {
      columns: s.header.columns.map((c) => ({
        ...c,
        ...(c.format ? { format: { ...c.format } } : {}),
        ...(c.options ? { options: [...c.options] } : {}),
        ...(c.colors ? { colors: copyColors(c.colors) } : {}),
        ...(c.highlight ? { highlight: c.highlight.map((r) => ({ ...r })) } : {}),
      })),
      ...(s.header.freeze ? { freeze: { ...s.header.freeze } } : {}),
    },
    rows: s.rows.map((r) => [...r]),
  };
  if (s.styles) {
    const styles: (SheetRowStyle | undefined)[] = [];
    s.styles.forEach((r, i) => {
      if (r)
        styles[i] = r.map((x) =>
          x ? { ...x, ...(x.border ? { border: [...x.border] } : {}) } : x,
        );
    });
    out.styles = styles;
  }
  return out;
}

/** The styles aligned with the rows (padded to their length), so a splice hits the same rows. */
function alignedStyles(s: Sheet): (SheetRowStyle | undefined)[] | null {
  if (!s.styles) return null;
  if (s.styles.length < s.rows.length) s.styles.length = s.rows.length;
  return s.styles;
}

/** Rows spliced, their styles with them. */
function spliceRows(s: Sheet, start: number, del: number, insert: Cell[][]): Cell[][] {
  alignedStyles(s)?.splice(start, del, ...new Array<SheetRowStyle | undefined>(insert.length));
  return s.rows.splice(start, del, ...insert);
}

/** The option colours a column keeps for its options (a removed option's colour goes). */
function keptColors(col: SheetColumn): Record<string, SheetColor> | undefined {
  if (!col.colors || col.type !== "select") return undefined;
  const out = Object.create(null) as Record<string, SheetColor>;
  let any = false;
  for (const o of col.options ?? []) {
    if (Object.hasOwn(col.colors, o)) {
      out[o] = col.colors[o] as SheetColor;
      any = true;
    }
  }
  return any ? out : undefined;
}

const WHOLE_COLUMNS = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/;
const WHOLE_ROWS = /^\$?\d{1,7}:\$?\d{1,7}$/;

/** Moves every formula's references for `change`, charging each formula's length first. */
function shiftAll(rows: Cell[][], change: StructuralChange, charge: (chars: number) => void): void {
  for (const r of rows) {
    for (let c = 0; c < r.length; c++) {
      const v = r[c];
      if (isFormula(v)) {
        charge(v.length);
        r[c] = shiftFormula(v, change);
      }
    }
  }
}

function columnDef(c: SheetColumnInput): SheetColumn {
  const out: SheetColumn = { name: c.name, type: c.type ?? "text" };
  if (c.width !== undefined) out.width = c.width;
  if (c.format !== undefined) out.format = { ...c.format };
  if (c.options !== undefined) out.options = [...c.options];
  if (c.colors !== undefined) out.colors = copyColors(c.colors);
  if (c.highlight !== undefined) out.highlight = c.highlight.map((r) => ({ ...r }));
  return out;
}

/** Apply `ops` in order to a copy of `sheet`. Throws SheetOpError; never changes `sheet`. */
export function applySheetOps(
  sheet: Sheet,
  ops: readonly SheetOp[],
): { sheet: Sheet; changed: SheetOpChanges } {
  if (ops.length > LIMITS.maxSheetOps) {
    throw new SheetOpError(LIMITS.maxSheetOps, `At most ${LIMITS.maxSheetOps} ops in one call`);
  }
  const s = copySheet(sheet);
  const changed: SheetOpChanges = {
    cells: 0,
    rows_inserted: 0,
    rows_deleted: 0,
    columns_inserted: 0,
    columns_deleted: 0,
    cells_styled: 0,
  };
  let written = 0;
  const count = (n: number, i: number) => {
    written += n;
    if (written > LIMITS.maxSheetOpCells) {
      throw new SheetOpError(i, `One call writes at most ${LIMITS.maxSheetOpCells} cells`);
    }
  };
  // Re-reading formulas is what an insert or delete costs; the cells it writes are counted above.
  let shifted = 0;
  const shiftCharge = (i: number) => (chars: number) => {
    shifted += chars;
    if (shifted > LIMITS.maxSheetOpShiftChars) {
      throw new SheetOpError(
        i,
        `One call moves the references of at most ${LIMITS.maxSheetOpShiftChars} characters of formulas, and each insert or delete of rows or columns moves every formula in the sheet; send fewer inserts and deletes per call (one op can insert or delete several rows or columns)`,
      );
    }
  };
  const width = () => s.header.columns.length;
  const checkRows = (values: Cell[][], i: number) => {
    values.forEach((r, k) => {
      if (r.length > width()) {
        throw new SheetOpError(
          i,
          `values row ${k + 1} has ${r.length} cells; the sheet has ${width()} columns (insert_columns first)`,
        );
      }
    });
    count(
      values.reduce((n, r) => n + r.length, 0),
      i,
    );
  };
  const column = (letter: string, i: number, allowEnd = false): number => {
    const c = colIndex(letter);
    const last = width() - (allowEnd ? 0 : 1);
    if (c < 0 || c > last) {
      throw new SheetOpError(
        i,
        `${letter} is not a column of this sheet (A to ${colLetter(width() - 1)}${allowEnd ? `, or ${colLetter(width())} to add at the end` : ""})`,
      );
    }
    return c;
  };
  const rowLimit = (i: number) => {
    if (s.rows.length > LIMITS.maxSheetRows) {
      throw new SheetOpError(i, `A sheet holds at most ${LIMITS.maxSheetRows} rows`);
    }
  };
  // Checked before an op grows the sheet, so a far-off row costs nothing to refuse.
  const rowsFit = (rows: number, i: number) => {
    if (rows > LIMITS.maxSheetRows) {
      throw new SheetOpError(
        i,
        `A sheet holds at most ${LIMITS.maxSheetRows} rows (2 to ${LIMITS.maxSheetRows + 1}); this op reaches row ${rows + 1}`,
      );
    }
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case "set": {
        const at = parseA1(op.at);
        if (!at || at.row < 2) {
          throw new SheetOpError(
            i,
            `at must be a cell from row 2 down, such as "B2" (row 1 is the header)`,
          );
        }
        if (at.col + op.values.reduce((w, r) => Math.max(w, r.length), 0) > width()) {
          throw new SheetOpError(
            i,
            `the values reach past column ${colLetter(width() - 1)} (insert_columns first)`,
          );
        }
        if (op.values.length > 0) rowsFit(at.row - 2 + op.values.length, i);
        const gap = at.row - 2 - s.rows.length;
        if (op.values.length > 0 && gap > LIMITS.maxSheetSetGapRows) {
          throw new SheetOpError(
            i,
            `a set at ${op.at} would add ${gap} empty rows after the sheet's last row (${s.rows.length + 1}); a set adds at most ${LIMITS.maxSheetSetGapRows}. Write from row ${s.rows.length + 2} or use append_rows`,
            "too_far_past_end",
          );
        }
        count(
          op.values.reduce((n, r) => n + r.length, 0),
          i,
        );
        // Rows the set adds past the end (the empty ones before it included) are inserted rows.
        if (op.values.length > 0) {
          changed.rows_inserted += Math.max(0, at.row - 2 + op.values.length - s.rows.length);
        }
        op.values.forEach((vals, k) => {
          const ri = at.row - 2 + k;
          while (s.rows.length <= ri) s.rows.push([]);
          rowLimit(i);
          const row = s.rows[ri] as Cell[];
          vals.forEach((v, j) => {
            while (row.length < at.col + j) row.push(null);
            row[at.col + j] = v;
            changed.cells++;
          });
        });
        break;
      }
      case "append_rows": {
        rowsFit(s.rows.length + op.values.length, i);
        checkRows(op.values, i);
        for (const r of op.values) s.rows.push([...r]);
        rowLimit(i);
        changed.rows_inserted += op.values.length;
        changed.cells += op.values.reduce((n, r) => n + r.length, 0);
        break;
      }
      case "insert_rows": {
        const last = s.rows.length + 2;
        if (!Number.isInteger(op.before) || op.before < 2 || op.before > last) {
          throw new SheetOpError(i, `before must be a row from 2 to ${last}`);
        }
        const values = op.values ?? [];
        const n = op.count ?? Math.max(1, values.length);
        if (!Number.isInteger(n) || n < 1) throw new SheetOpError(i, "count must be at least 1");
        if (values.length > n)
          throw new SheetOpError(i, `values has ${values.length} rows; count is ${n}`);
        rowsFit(s.rows.length + n, i);
        checkRows(values, i);
        shiftAll(s.rows, { kind: "insert_rows", before: op.before, count: n }, shiftCharge(i));
        const fresh = Array.from({ length: n }, (_, k) => [...(values[k] ?? [])]);
        spliceRows(s, op.before - 2, 0, fresh);
        rowLimit(i);
        changed.rows_inserted += n;
        changed.cells += values.reduce((x, r) => x + r.length, 0);
        break;
      }
      case "delete_rows": {
        const n = op.count ?? 1;
        const last = s.rows.length + 1;
        if (!Number.isInteger(op.from) || op.from < 2 || op.from > last) {
          throw new SheetOpError(
            i,
            last < 2 ? "The sheet has no rows to delete" : `from must be a row from 2 to ${last}`,
          );
        }
        if (!Number.isInteger(n) || n < 1 || op.from + n - 1 > last) {
          throw new SheetOpError(i, `count must be from 1 to ${last - op.from + 1}`);
        }
        spliceRows(s, op.from - 2, n, []);
        shiftAll(s.rows, { kind: "delete_rows", from: op.from, count: n }, shiftCharge(i));
        changed.rows_deleted += n;
        break;
      }
      case "move_rows": {
        const n = op.count ?? 1;
        const last = s.rows.length + 1;
        if (!Number.isInteger(op.from) || op.from < 2 || op.from > last) {
          throw new SheetOpError(
            i,
            last < 2 ? "The sheet has no rows to move" : `from must be a row from 2 to ${last}`,
          );
        }
        if (!Number.isInteger(n) || n < 1 || op.from + n - 1 > last) {
          throw new SheetOpError(i, `count must be from 1 to ${last - op.from + 1}`);
        }
        const lastTo = last - n + 1;
        if (!Number.isInteger(op.to) || op.to < 2 || op.to > lastTo || op.to === op.from) {
          throw new SheetOpError(
            i,
            `to must be a row from 2 to ${lastTo} other than ${op.from} (the row the first moved row lands on)`,
          );
        }
        shiftAll(s.rows, { kind: "move_rows", from: op.from, count: n, to: op.to }, shiftCharge(i));
        const styles = alignedStyles(s);
        const moved = s.rows.splice(op.from - 2, n);
        s.rows.splice(op.to - 2, 0, ...moved);
        if (styles) styles.splice(op.to - 2, 0, ...styles.splice(op.from - 2, n));
        break;
      }
      case "set_column": {
        const c = column(op.column, i);
        const col = s.header.columns[c] as SheetColumn;
        if (op.name !== undefined) col.name = op.name;
        if (op.type !== undefined) col.type = op.type;
        if (op.width === null) delete col.width;
        else if (op.width !== undefined) col.width = op.width;
        if (op.format === null) delete col.format;
        else if (op.format !== undefined) col.format = { ...op.format };
        if (op.options === null) delete col.options;
        else if (op.options !== undefined) col.options = [...op.options];
        if (op.colors === null) delete col.colors;
        else if (op.colors !== undefined) col.colors = copyColors(op.colors);
        else if (col.colors) {
          // Options or the type changed without new colours: each option kept keeps its colour.
          const kept = keptColors(col);
          if (kept) col.colors = kept;
          else delete col.colors;
        }
        if (op.highlight === null) delete col.highlight;
        else if (op.highlight !== undefined) col.highlight = op.highlight.map((r) => ({ ...r }));
        break;
      }
      case "insert_columns": {
        const c = column(op.before, i, true);
        if (op.columns.length < 1) throw new SheetOpError(i, "columns lists at least one column");
        if (width() + op.columns.length > LIMITS.maxSheetColumns) {
          throw new SheetOpError(i, `A sheet has at most ${LIMITS.maxSheetColumns} columns`);
        }
        const n = op.columns.length;
        shiftAll(s.rows, { kind: "insert_columns", before: c, count: n }, shiftCharge(i));
        s.header.columns.splice(c, 0, ...op.columns.map(columnDef));
        for (const r of s.rows) if (r.length > c) r.splice(c, 0, ...new Array<Cell>(n).fill(null));
        for (const st of s.styles ?? []) {
          if (st && st.length > c) st.splice(c, 0, ...new Array<null>(n).fill(null));
        }
        // Columns inserted among the frozen ones are frozen too, as formula references move (at
        // most the 5 a sheet freezes).
        const fr = s.header.freeze;
        if (fr && c < fr.cols) fr.cols = Math.min(MAX_FREEZE_COLS, fr.cols + n);
        changed.columns_inserted += n;
        break;
      }
      case "delete_columns": {
        const c = column(op.from, i);
        const n = op.count ?? 1;
        if (!Number.isInteger(n) || n < 1 || c + n > width()) {
          throw new SheetOpError(i, `count must be from 1 to ${width() - c}`);
        }
        if (n >= width()) throw new SheetOpError(i, "A sheet keeps at least one column");
        s.header.columns.splice(c, n);
        for (const r of s.rows) if (r.length > c) r.splice(c, n);
        for (const st of s.styles ?? []) if (st && st.length > c) st.splice(c, n);
        shiftAll(s.rows, { kind: "delete_columns", from: c, count: n }, shiftCharge(i));
        // Frozen columns deleted leave the frozen pane, so the columns after them keep their place.
        const fr = s.header.freeze;
        if (fr && c < fr.cols) fr.cols -= Math.min(n, fr.cols - c);
        changed.columns_deleted += n;
        break;
      }
      case "format": {
        const text = op.range.trim();
        const r = parseRange(text);
        if (!r) {
          throw new SheetOpError(i, `${op.range} is not an A1 range such as B2:D9, B:D or 2:9`);
        }
        const lastRow = s.rows.length + 1;
        const lastCol = width() - 1;
        // Whole columns are their data rows; whole rows are every column.
        const r1 = WHOLE_COLUMNS.test(text) ? 2 : r.r1;
        const r2 = WHOLE_COLUMNS.test(text) ? lastRow : r.r2;
        const c2 = WHOLE_ROWS.test(text) ? lastCol : r.c2;
        if (r1 < 2) {
          throw new SheetOpError(i, "range starts at row 2 or below (row 1 is the column names)");
        }
        if (r2 > lastRow) {
          throw new SheetOpError(
            i,
            `range reaches row ${r2}, past the sheet's last row (${lastRow}); add the rows first`,
          );
        }
        if (c2 > lastCol) {
          throw new SheetOpError(
            i,
            `range reaches past column ${colLetter(lastCol)} (insert_columns first)`,
          );
        }
        if (r2 < r1) break;
        const n = (r2 - r1 + 1) * (c2 - r.c1 + 1);
        count(n, i);
        if (!s.styles) s.styles = new Array(s.rows.length);
        const styles = alignedStyles(s) as (SheetRowStyle | undefined)[];
        for (let row = r1; row <= r2; row++) {
          let st: SheetRowStyle | undefined = styles[row - 2];
          for (let c = r.c1; c <= c2; c++) {
            const next = mergeCellStyle(st?.[c], op.style);
            if (next) {
              st ??= [];
              st[c] = next;
            } else if (st) st[c] = null;
          }
          styles[row - 2] = st?.some((x: unknown) => !!x) ? st : undefined;
        }
        changed.cells_styled += n;
        break;
      }
      default:
        throw new SheetOpError(i, `Unknown op ${JSON.stringify((op as { op: unknown }).op)}`);
    }
  });
  return { sheet: s, changed };
}

// ---------- live sheets: structural changes to the draft's lines ----------

/**
 * A structural change to a live sheet draft (the room's `struct` frame): the four edit_sheet ops
 * that move rows or columns, without values, and `move_rows`. Rows are A1 rows (2 is the first
 * data row), columns letters. `move_rows` takes rows `from` to `from + count - 1` and puts them
 * back so that the first of them is row `to`; the references into them follow them (refs.ts).
 */
export type SheetStructOp =
  | { op: "insert_rows"; before: number; count: number }
  | { op: "delete_rows"; from: number; count: number }
  | { op: "insert_columns"; before: string; columns: SheetColumnInput[] }
  | { op: "delete_columns"; from: string; count: number }
  | { op: "move_rows"; from: number; count: number; to: number };

export const SHEET_STRUCT_KINDS = [
  "insert_rows",
  "delete_rows",
  "insert_columns",
  "delete_columns",
  "move_rows",
] as const;

/**
 * The lines of a canonical sheet (line 0 the header, then one row per line) after a structural
 * change, or null when the lines are not a valid sheet or the op does not apply. Pure and
 * deterministic: the room and every renderer apply the same op to the same lines and get the same
 * lines, so a struct frame never carries text. The result is canonical (serializeSheet); whether
 * it is still a valid sheet (an inserted column's definition, the limits) is the caller's check.
 */
export function applySheetStruct(lines: readonly string[], op: SheetStructOp): string[] | null {
  const parsed = parseSheet(lines.join("\n"));
  if (!parsed.ok) return null;
  try {
    const { sheet } = applySheetOps(parsed.sheet, [op]);
    return serializeSheet(sheet).split("\n");
  } catch (e) {
    if (e instanceof SheetOpError) return null;
    throw e;
  }
}
