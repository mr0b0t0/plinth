// The sheet file (sheet.jsonl): JSON lines. Line 1 is the header, {"plinth":"sheet","v":1,
// "columns":[...]}, whose column names are row 1 in A1 terms; every later line is one row, a JSON
// array of cells. A cell is null, a finite number, a boolean or a string; a string starting with
// "=" is a formula and a leading "'" keeps the rest literal. One parser for the Worker (publish),
// the renderer and the editor; no zod, so the renderer bundle stays small.
//
// serializeSheet writes the canonical form the Worker stores: the header's keys in a fixed order,
// one JSON.stringify per row with trailing nulls trimmed, no trailing newline. So each row has one
// spelling, and a version diff shows only the rows that changed.
import { LIMITS } from "../constants.ts";
import { utf8Length } from "../utf8.ts";
import { a1 } from "./address.ts";
import { parseFormula } from "./formula/parser.ts";
import { isoDateSerial } from "./formula/values.ts";
import { platform } from "./platform.ts";

export const SHEET_COLUMN_TYPES = ["text", "number", "date", "checkbox", "select", "url"] as const;
export type SheetColumnType = (typeof SHEET_COLUMN_TYPES)[number];

export const SHEET_NUMBER_STYLES = ["plain", "percent", "currency"] as const;
export type SheetNumberStyle = (typeof SHEET_NUMBER_STYLES)[number];

export interface SheetNumberFormat {
  style: SheetNumberStyle;
  /** 0 to 10; absent shows what the number needs. */
  decimals?: number;
  /** ISO 4217 code, for style currency only. */
  currency?: string;
  /** Thousands separators; absent means on. */
  grouping?: boolean;
}

export interface SheetColumn {
  name: string;
  type: SheetColumnType;
  /** Pixels, 40 to 800. */
  width?: number;
  /** Number columns only. */
  format?: SheetNumberFormat;
  /** Select columns only: the values a cell may take. */
  options?: string[];
}

export interface SheetHeader {
  columns: SheetColumn[];
  /** Columns kept in view while the grid scrolls sideways (the header row always is). */
  freeze?: { cols: number };
}

export type Cell = null | number | boolean | string;

export interface Sheet {
  header: SheetHeader;
  /** Data rows; rows[0] is A1 row 2. A row may be shorter than the columns (empty cells). */
  rows: Cell[][];
}

export interface SheetIssue {
  /** 1-based line of sheet.jsonl (line 1 is the header). */
  line: number;
  /** The cell's address, e.g. "B7", when the issue is about one cell. */
  cell?: string;
  code: "limit" | "line" | "header" | "row" | "cell" | "formula";
  message: string;
}

export type SheetParseResult =
  | { ok: true; sheet: Sheet }
  | { ok: false; errors: SheetIssue[]; count: number };

/** At most this many issues are listed; `count` says how many there were. */
export const MAX_SHEET_ISSUES = 20;

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HEADER_KEYS = new Set(["plinth", "v", "columns", "freeze"]);
const COLUMN_KEYS = new Set(["name", "type", "width", "format", "options"]);
const FORMAT_KEYS = new Set(["style", "decimals", "currency", "grouping"]);

export function isFormula(cell: Cell | undefined): cell is string {
  return typeof cell === "string" && cell.startsWith("=");
}

/** A text cell as shown: a leading "'" is dropped (it keeps "=..." or "'..." literal). */
export function literalText(cell: string): string {
  return cell.startsWith("'") ? cell.slice(1) : cell;
}

/**
 * An absolute http:, https: or mailto: URL of at most 2,000 characters, with no whitespace,
 * control or format characters: the only links a url cell may hold. Checked at publish and again
 * in the renderer before it becomes an href.
 */
export function isSheetLinkUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 2000) return false;
  if (/\s/u.test(s) || CONTROL_OR_FORMAT.test(s)) return false;
  if (!/^(?:https?:\/\/[^/?#]|mailto:[^/])/i.test(s)) return false;
  let u: { protocol: string; hostname: string };
  try {
    u = new platform.URL(s);
  } catch {
    return false;
  }
  if (u.protocol === "mailto:") return true;
  return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
}

/** UTF-8 bytes of a string, measured only when it could be over `max`. */
function overBytes(s: string, max: number): boolean {
  if (s.length > max) return true;
  if (s.length * 3 <= max) return false;
  return utf8Length(s) > max;
}

class Issues {
  readonly list: SheetIssue[] = [];
  count = 0;
  add(issue: SheetIssue): void {
    this.count++;
    if (this.list.length < MAX_SHEET_ISSUES) this.list.push(issue);
  }
}

function quote(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkFormat(
  raw: unknown,
  where: string,
  issues: Issues,
): SheetNumberFormat | undefined | null {
  if (!isPlainObject(raw)) {
    issues.add({ line: 1, code: "header", message: `${where}: format must be an object` });
    return null;
  }
  let ok = true;
  const bad = (message: string) => {
    issues.add({ line: 1, code: "header", message: `${where}: ${message}` });
    ok = false;
  };
  for (const k of Object.keys(raw))
    if (!FORMAT_KEYS.has(k)) bad(`unknown key ${quote(k)} in format`);
  const style = raw.style;
  if (!SHEET_NUMBER_STYLES.includes(style as SheetNumberStyle)) {
    bad(`format.style must be one of ${SHEET_NUMBER_STYLES.join(", ")}`);
  }
  const f: SheetNumberFormat = { style: style as SheetNumberStyle };
  if (raw.decimals !== undefined) {
    if (
      !Number.isInteger(raw.decimals) ||
      (raw.decimals as number) < 0 ||
      (raw.decimals as number) > 10
    ) {
      bad("format.decimals must be a whole number from 0 to 10");
    } else f.decimals = raw.decimals as number;
  }
  if (style === "currency") {
    if (typeof raw.currency !== "string" || !CURRENCY_RE.test(raw.currency)) {
      bad('format.currency must be a three-letter currency code such as "EUR"');
    } else f.currency = raw.currency;
  } else if (raw.currency !== undefined) {
    bad("format.currency is only for style currency");
  }
  if (raw.grouping !== undefined) {
    if (typeof raw.grouping !== "boolean") bad("format.grouping must be true or false");
    else f.grouping = raw.grouping;
  }
  return ok ? f : null;
}

function checkName(raw: unknown, what: string, where: string, issues: Issues): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100) {
    issues.add({
      line: 1,
      code: "header",
      message: `${where}: ${what} must be 1 to 100 characters`,
    });
    return null;
  }
  if (CONTROL_OR_FORMAT.test(raw)) {
    issues.add({
      line: 1,
      code: "header",
      message: `${where}: ${what} cannot hold control or invisible characters`,
    });
    return null;
  }
  return raw.normalize("NFC");
}

function parseHeader(line: string, issues: Issues): SheetHeader | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    issues.add({
      line: 1,
      code: "header",
      message:
        'line 1 is not JSON: a sheet starts with a header line {"plinth":"sheet","v":1,"columns":[...]}',
    });
    return null;
  }
  if (!isPlainObject(raw)) {
    issues.add({ line: 1, code: "header", message: "line 1 must be the header object" });
    return null;
  }
  const before = issues.count;
  for (const k of Object.keys(raw)) {
    if (!HEADER_KEYS.has(k))
      issues.add({ line: 1, code: "header", message: `line 1: unknown key ${quote(k)}` });
  }
  if (raw.plinth !== "sheet") {
    issues.add({ line: 1, code: "header", message: 'line 1: "plinth" must be "sheet"' });
  }
  if (raw.v !== 1) issues.add({ line: 1, code: "header", message: 'line 1: "v" must be 1' });
  const cols = raw.columns;
  if (!Array.isArray(cols) || cols.length < 1 || cols.length > LIMITS.maxSheetColumns) {
    issues.add({
      line: 1,
      code: "header",
      message: `line 1: "columns" must list 1 to ${LIMITS.maxSheetColumns} columns`,
    });
    return null;
  }
  const columns: SheetColumn[] = [];
  cols.forEach((c, i) => {
    const where = `line 1, column ${i + 1}`;
    if (!isPlainObject(c)) {
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: a column is an object with a name`,
      });
      return;
    }
    for (const k of Object.keys(c)) {
      if (!COLUMN_KEYS.has(k)) {
        issues.add({ line: 1, code: "header", message: `${where}: unknown key ${quote(k)}` });
      }
    }
    const name = checkName(c.name, "name", where, issues);
    const type = c.type === undefined ? "text" : c.type;
    if (!SHEET_COLUMN_TYPES.includes(type as SheetColumnType)) {
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: type must be one of ${SHEET_COLUMN_TYPES.join(", ")}`,
      });
      return;
    }
    const col: SheetColumn = { name: name ?? "", type: type as SheetColumnType };
    if (c.width !== undefined) {
      if (!Number.isInteger(c.width) || (c.width as number) < 40 || (c.width as number) > 800) {
        issues.add({
          line: 1,
          code: "header",
          message: `${where}: width must be a whole number from 40 to 800`,
        });
      } else col.width = c.width as number;
    }
    if (c.format !== undefined) {
      if (type !== "number") {
        issues.add({
          line: 1,
          code: "header",
          message: `${where}: format is only for number columns`,
        });
      } else {
        const f = checkFormat(c.format, where, issues);
        if (f) col.format = f;
      }
    }
    if (type === "select") {
      const opts = c.options;
      if (!Array.isArray(opts) || opts.length < 1 || opts.length > 100) {
        issues.add({
          line: 1,
          code: "header",
          message: `${where}: a select column lists 1 to 100 options`,
        });
      } else {
        const seen = new Set<string>();
        const list: string[] = [];
        for (const o of opts) {
          const v = checkName(o, "each option", where, issues);
          if (v === null) continue;
          if (seen.has(v)) {
            issues.add({
              line: 1,
              code: "header",
              message: `${where}: option ${quote(v)} is listed twice`,
            });
            continue;
          }
          seen.add(v);
          list.push(v);
        }
        col.options = list;
      }
    } else if (c.options !== undefined) {
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: options are only for select columns`,
      });
    }
    columns.push(col);
  });
  const header: SheetHeader = { columns };
  if (raw.freeze !== undefined) {
    const fr = raw.freeze;
    const keys = isPlainObject(fr) ? Object.keys(fr) : [];
    const n = isPlainObject(fr) ? fr.cols : undefined;
    if (
      !isPlainObject(fr) ||
      keys.some((k) => k !== "cols") ||
      !Number.isInteger(n) ||
      (n as number) < 0 ||
      (n as number) > 5 ||
      (n as number) > columns.length
    ) {
      issues.add({
        line: 1,
        code: "header",
        message:
          'line 1: "freeze" is {"cols": n} with n from 0 to 5, at most the number of columns',
      });
    } else header.freeze = { cols: n as number };
  }
  return issues.count === before ? header : null;
}

/** Why a cell cannot be in its column, or null. `row` is the A1 row (2 for the first data row). */
export function cellProblem(
  col: SheetColumn,
  cell: unknown,
  row: number,
  colIdx: number,
): string | null {
  const at = a1(row, colIdx);
  const kind = `column ${col.name} is ${col.type}`;
  if (cell === null) return null;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return `${at}: numbers must be finite`;
    if (col.type === "text" || col.type === "number") return null;
    return `${at}: ${quote(cell)} is a number (${kind})`;
  }
  if (typeof cell === "boolean") {
    if (col.type === "text" || col.type === "checkbox") return null;
    return `${at}: ${quote(cell)} is true or false (${kind})`;
  }
  if (typeof cell !== "string") {
    return `${at}: a cell is null, a number, true or false, or a string`;
  }
  if (cell.length > LIMITS.maxSheetCellChars) {
    return `${at}: a cell holds at most ${LIMITS.maxSheetCellChars} characters`;
  }
  if (cell.startsWith("=")) {
    if (cell.length > LIMITS.maxSheetFormulaChars) {
      return `${at}: a formula is at most ${LIMITS.maxSheetFormulaChars} characters`;
    }
    const f = parseFormula(cell.slice(1));
    return f.ok
      ? null
      : `${at}: ${f.error.message} (in ${quote(cell)}; start text with ' to keep it literal)`;
  }
  switch (col.type) {
    case "text":
      return null;
    case "number":
      return `${at}: ${quote(cell)} is not a number (${kind})`;
    case "date":
      return isoDateSerial(cell) === null
        ? `${at}: ${quote(cell)} is not a date YYYY-MM-DD from 1900-03-01 to 9999-12-31 (${kind})`
        : null;
    case "checkbox":
      return `${at}: ${quote(cell)} is not true or false (${kind})`;
    case "select":
      return col.options?.includes(cell)
        ? null
        : `${at}: ${quote(cell)} is not one of the options of column ${col.name}`;
    case "url":
      return isSheetLinkUrl(cell)
        ? null
        : `${at}: ${quote(cell)} is not an http:, https: or mailto: link (${kind})`;
  }
}

/** Problems of one row against the header. `rowNumber` is the A1 row (line number). */
export function checkRow(header: SheetHeader, row: unknown, rowNumber: number): SheetIssue[] {
  if (!Array.isArray(row)) {
    return [
      {
        line: rowNumber,
        code: "row",
        message: `line ${rowNumber}: a row is a JSON array of cells`,
      },
    ];
  }
  if (row.length > header.columns.length) {
    return [
      {
        line: rowNumber,
        code: "row",
        message: `line ${rowNumber}: ${row.length} cells, but the sheet has ${header.columns.length} columns`,
      },
    ];
  }
  const out: SheetIssue[] = [];
  for (let c = 0; c < row.length; c++) {
    const problem = cellProblem(header.columns[c] as SheetColumn, row[c], rowNumber, c);
    if (problem) {
      out.push({
        line: rowNumber,
        cell: a1(rowNumber, c),
        code: isFormula(row[c]) ? "formula" : "cell",
        message: problem,
      });
    }
  }
  return out;
}

/** Parse and check a whole sheet file. Never throws. */
export function parseSheet(text: string): SheetParseResult {
  const issues = new Issues();
  if (overBytes(text, LIMITS.maxSheetBytes)) {
    issues.add({
      line: 1,
      code: "limit",
      message: `A sheet is at most ${LIMITS.maxSheetBytes / (1024 * 1024)} MB`,
    });
    return { ok: false, errors: issues.list, count: issues.count };
  }
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (lines.length - 1 > LIMITS.maxSheetRows) {
    issues.add({
      line: LIMITS.maxSheetRows + 2,
      code: "limit",
      message: `A sheet holds at most ${LIMITS.maxSheetRows} rows; this one has ${lines.length - 1}`,
    });
    return { ok: false, errors: issues.list, count: issues.count };
  }
  const header = parseHeader((lines[0] as string).replace(/\r$/, ""), issues);
  const rows: Cell[][] = [];
  let formulas = 0;
  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const line = (lines[i] as string).replace(/\r$/, "");
    if (line.trim() === "") {
      issues.add({ line: n, code: "line", message: `line ${n} is blank: an empty row is []` });
      continue;
    }
    if (overBytes(line, LIMITS.maxSheetRowBytes)) {
      issues.add({
        line: n,
        code: "limit",
        message: `line ${n} is over ${LIMITS.maxSheetRowBytes / 1024} KiB; a row line is at most that`,
      });
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      issues.add({
        line: n,
        code: "row",
        message: `line ${n} is not JSON: a row is a JSON array of cells`,
      });
      continue;
    }
    if (!Array.isArray(row)) {
      issues.add({ line: n, code: "row", message: `line ${n}: a row is a JSON array of cells` });
      continue;
    }
    if (header) for (const issue of checkRow(header, row, n)) issues.add(issue);
    for (const c of row) if (isFormula(c)) formulas++;
    rows.push(row as Cell[]);
  }
  if (formulas > LIMITS.maxSheetFormulaCells) {
    issues.add({
      line: 1,
      code: "limit",
      message: `A sheet holds at most ${LIMITS.maxSheetFormulaCells} formulas; this one has ${formulas}`,
    });
  }
  if (!header || issues.count > 0) return { ok: false, errors: issues.list, count: issues.count };
  return { ok: true, sheet: { header, rows } };
}

function canonicalColumn(c: SheetColumn): SheetColumn {
  const out: SheetColumn = { name: c.name, type: c.type };
  if (c.width !== undefined) out.width = c.width;
  if (c.format) {
    const f: SheetNumberFormat = { style: c.format.style };
    if (c.format.currency !== undefined) f.currency = c.format.currency;
    if (c.format.decimals !== undefined) f.decimals = c.format.decimals;
    if (c.format.grouping !== undefined) f.grouping = c.format.grouping;
    out.format = f;
  }
  if (c.options) out.options = [...c.options];
  return out;
}

/** A row without its trailing empty cells. */
export function trimRow(row: readonly Cell[]): Cell[] {
  let end = row.length;
  while (end > 0 && (row[end - 1] === null || row[end - 1] === undefined)) end--;
  return row.slice(0, end).map((c) => (c === undefined ? null : c));
}

/** The canonical text of a sheet: what the Worker stores. No trailing newline. */
export function serializeSheet(sheet: Sheet): string {
  const header: Record<string, unknown> = {
    plinth: "sheet",
    v: 1,
    columns: sheet.header.columns.map(canonicalColumn),
  };
  if (sheet.header.freeze && sheet.header.freeze.cols > 0)
    header.freeze = { cols: sheet.header.freeze.cols };
  const lines = [JSON.stringify(header)];
  for (const row of sheet.rows) lines.push(JSON.stringify(trimRow(row)));
  return lines.join("\n");
}
