// Cell, row and column changes to a sheet (edit_sheet's ops). Pure and atomic: applySheetOps works
// on a copy and throws SheetOpError (with the op's index) for the first op it cannot apply, so the
// caller's sheet never changes. Inserting or deleting rows and columns moves the references of
// every formula (refs.ts). The result is not checked against the column types here: the caller
// parses the serialized result once, after every op, so an agent can change a column's type and
// fix its cells in one call.
import { LIMITS } from "../constants.ts";
import { colIndex, colLetter, parseA1 } from "./address.ts";
import {
  type Cell,
  isFormula,
  type Sheet,
  type SheetColumn,
  type SheetColumnType,
  type SheetNumberFormat,
} from "./format.ts";
import { type StructuralChange, shiftFormula } from "./refs.ts";

export interface SheetColumnInput {
  name: string;
  type?: SheetColumnType;
  width?: number;
  format?: SheetNumberFormat;
  options?: string[];
}

export type SheetOp =
  | { op: "set"; at: string; values: Cell[][] }
  | { op: "append_rows"; values: Cell[][] }
  | { op: "insert_rows"; before: number; count?: number; values?: Cell[][] }
  | { op: "delete_rows"; from: number; count?: number }
  | {
      op: "set_column";
      column: string;
      name?: string;
      type?: SheetColumnType;
      format?: SheetNumberFormat | null;
      options?: string[] | null;
      width?: number | null;
    }
  | { op: "insert_columns"; before: string; columns: SheetColumnInput[] }
  | { op: "delete_columns"; from: string; count?: number };

export const SHEET_OP_KINDS = [
  "set",
  "append_rows",
  "insert_rows",
  "delete_rows",
  "set_column",
  "insert_columns",
  "delete_columns",
] as const;

export class SheetOpError extends Error {
  readonly index: number;
  constructor(index: number, message: string) {
    super(message);
    this.index = index;
  }
}

export interface SheetOpChanges {
  cells: number;
  rows_inserted: number;
  rows_deleted: number;
  columns_inserted: number;
  columns_deleted: number;
}

function copySheet(s: Sheet): Sheet {
  return {
    header: {
      columns: s.header.columns.map((c) => ({
        ...c,
        ...(c.format ? { format: { ...c.format } } : {}),
        ...(c.options ? { options: [...c.options] } : {}),
      })),
      ...(s.header.freeze ? { freeze: { ...s.header.freeze } } : {}),
    },
    rows: s.rows.map((r) => [...r]),
  };
}

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
        count(
          op.values.reduce((n, r) => n + r.length, 0),
          i,
        );
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
        s.rows.splice(op.before - 2, 0, ...fresh);
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
        s.rows.splice(op.from - 2, n);
        shiftAll(s.rows, { kind: "delete_rows", from: op.from, count: n }, shiftCharge(i));
        changed.rows_deleted += n;
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
        shiftAll(s.rows, { kind: "delete_columns", from: c, count: n }, shiftCharge(i));
        if (s.header.freeze && s.header.freeze.cols > width()) s.header.freeze.cols = width();
        changed.columns_deleted += n;
        break;
      }
      default:
        throw new SheetOpError(i, `Unknown op ${JSON.stringify((op as { op: unknown }).op)}`);
    }
  });
  return { sheet: s, changed };
}
