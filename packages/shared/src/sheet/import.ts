// Turning a CSV or .xlsx file into a sheet. The first row names the columns; each column's type is
// inferred from its values (all numbers: number, all dates: date, all TRUE or FALSE: checkbox, all
// links: url, else text). CSV holds values only: text starting with = stays text (a CSV import
// never makes a formula), and the ' a CSV export put before =, +, - or @ is dropped. A CSV field
// is a number only when no digit is lost or invented: no leading zero or + (00123 and +351...
// stay text) and at most 15 significant digits (a 20-digit id stays text). The decimal mark is a
// point, or a comma in a file separated by semicolons (1,50); thousands separators are read only
// where they cannot be the decimal mark (1,234.50, 1.234,50, 1,234,567), so 1,500 in a comma
// file and 1.500 in a semicolon file stay text. From an .xlsx, a formula is kept when it parses
// as a sheet formula (the function allowlist, one sheet), otherwise its cached value is used;
// number formats become the column's format where they map. The result is checked by parseSheet
// like any published sheet. What an import leaves out or changes (other sheets, formulas kept as
// values, column names cut to 100 characters) is reported by sheetImportWarnings, for the app to
// say before or after it sends the file.
import { LIMITS } from "../constants.ts";
import { utf8Length } from "../utf8.ts";
import { colLetter } from "./address.ts";
import { readCsv } from "./csv.ts";
import {
  type Cell,
  isSheetLinkUrl,
  MAX_FREEZE_COLS,
  parseSheet,
  type Sheet,
  type SheetColumn,
  type SheetColumnType,
  type SheetContentFormat,
  type SheetNumberFormat,
  serializeSheet,
} from "./format.ts";
import { isoDateSerial, MAX_CONVERTED_TEXT, MIN_DATE_SERIAL, serialIso } from "./formula/values.ts";
import { platform } from "./platform.ts";
import {
  COLUMN_NAME_SOURCE_CHARS,
  checkSheetBytes,
  type RawCell,
  readXlsx,
  SheetImportError,
} from "./xlsxRead.ts";

export { COLUMN_NAME_SOURCE_CHARS, MAX_OTHER_SHEET_NAMES, SheetImportError } from "./xlsxRead.ts";

/** The longest column name an import keeps; a longer header is cut to it. */
export const MAX_IMPORT_COLUMN_NAME = 100;

/**
 * What an import changed or left out of the file, for the person who sent it. Advisory: the sheet
 * is still made. `not_utf8` is the app's own, from reading a CSV file's bytes (the import itself
 * takes text).
 */
export type SheetImportWarning =
  /** An .xlsx with more than one sheet: only the first is imported. */
  | { code: "other_sheets"; count: number; names: string[] }
  /** Data cells whose formula is not kept (outside the allowlist, another sheet, shared): their values are. */
  | { code: "formulas_as_values"; count: number }
  /** Header cells longer than `max` (MAX_IMPORT_COLUMN_NAME) characters, cut to it. */
  | { code: "headers_truncated"; count: number; max: number }
  /** A CSV file that is not UTF-8, read as Windows-1252. */
  | { code: "not_utf8"; encoding: "windows-1252" };

/** A value before its column's type is known. */
type In =
  | null
  | { t: "s"; v: string }
  | { t: "n"; v: number; fmt?: SheetNumberFormat | "date"; raw?: string }
  | { t: "b"; v: boolean; raw?: string }
  | { t: "f"; f: string; cached: In };
// raw: a CSV field as written, which a text column keeps (1.50 stays 1.50 beside 00123).

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
/** A character a column name would show: not white space, control or format. */
const VISIBLE = /[^\s\p{Cc}\p{Cf}]/u;

/** The first `n` UTF-16 units of `s`, one fewer when the last would split a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** A column's name from its header cell, and whether it was cut to MAX_IMPORT_COLUMN_NAME. */
function columnName(raw: string, i: number): { name: string; truncated: boolean } {
  // Cut before the replaces and normalize: header cells are not counted toward the sheet's size,
  // and one shared string of megabytes can stand behind all 100 of them.
  const source = cut(raw, COLUMN_NAME_SOURCE_CHARS);
  const name = source.replace(CONTROL_OR_FORMAT, " ").replace(/\s+/g, " ").trim().normalize("NFC");
  const full = name || colLetter(i);
  // Text past the source cut is dropped as well, even when what is left collapses (runs of white
  // space) to fewer than MAX_IMPORT_COLUMN_NAME characters: that is a cut name too.
  const dropped = raw.length > source.length && VISIBLE.test(raw.slice(source.length));
  return {
    name: cut(full, MAX_IMPORT_COLUMN_NAME).trimEnd(),
    truncated: full.length > MAX_IMPORT_COLUMN_NAME || dropped,
  };
}

/** Text as a literal cell: a leading = or ' would change its meaning, so it is kept with a '. */
function literal(s: string): string {
  return s.startsWith("=") || s.startsWith("'") ? `'${s}` : s;
}

function inferType(values: In[]): { type: SheetColumnType; format?: SheetNumberFormat } {
  const seen = values
    .map((v) => (v?.t === "f" ? v.cached : v))
    .filter((v): v is Exclude<In, null> => v !== null);
  if (seen.length === 0) return { type: "text" };
  if (
    seen.every(
      (v) => v.t === "n" && v.fmt === "date" && serialIso(v.v) !== null && v.v >= MIN_DATE_SERIAL,
    )
  ) {
    return { type: "date" };
  }
  if (seen.every((v) => v.t === "n")) {
    const fmt = seen
      .map((v) => (v as { fmt?: SheetNumberFormat | "date" }).fmt)
      .find((f) => f && f !== "date");
    return fmt && fmt !== "date" ? { type: "number", format: fmt } : { type: "number" };
  }
  if (seen.every((v) => v.t === "b")) return { type: "checkbox" };
  if (seen.every((v) => v.t === "s" && isSheetLinkUrl(v.v))) return { type: "url" };
  return { type: "text" };
}

function cellFor(v: In, type: SheetColumnType): Cell {
  if (v === null) return null;
  switch (v.t) {
    case "f":
      return `=${v.f}`;
    case "b":
      return type === "text" && v.raw !== undefined ? literal(v.raw) : v.v;
    case "n":
      if (type === "text" && v.raw !== undefined) return literal(v.raw);
      if (type === "date") return serialIso(v.v);
      if (v.fmt === "date" && type === "text") return serialIso(v.v) ?? v.v;
      return v.v;
    case "s":
      return type === "url" ? v.v : literal(v.v);
  }
}

/**
 * A sheet from a header row and data rows of typed values, adding `headers_truncated` to
 * `warnings`. Throws SheetImportError.
 */
function build(
  names: string[],
  data: In[][],
  warnings: SheetImportWarning[],
  widths?: Map<number, number>,
  freezeCols = 0,
): Sheet {
  // The row count is checked first, and the width found with a loop: spreading every row into
  // Math.max throws RangeError on a long file.
  if (data.length > LIMITS.maxSheetRows) {
    throw new SheetImportError(
      `A sheet holds at most ${LIMITS.maxSheetRows} rows; this file has ${data.length}`,
    );
  }
  const width = data.reduce((w, r) => Math.max(w, r.length), names.length);
  if (width === 0) throw new SheetImportError("The file has no columns");
  if (width > LIMITS.maxSheetColumns) {
    throw new SheetImportError(
      `A sheet has at most ${LIMITS.maxSheetColumns} columns; this file has ${width}`,
    );
  }
  const columns: SheetColumn[] = [];
  let truncated = 0;
  for (let c = 0; c < width; c++) {
    const { type, format } = inferType(data.map((r) => r[c] ?? null));
    const named = columnName(names[c] ?? "", c);
    if (named.truncated) truncated++;
    const col: SheetColumn = { name: named.name, type };
    if (format) col.format = format;
    const w = widths?.get(c);
    if (w !== undefined) col.width = Math.min(800, Math.max(40, w));
    columns.push(col);
  }
  const rows = data.map((r) => columns.map((col, c) => cellFor(r[c] ?? null, col.type)));
  const sheet: Sheet = { header: { columns }, rows };
  const fc = Math.min(MAX_FREEZE_COLS, freezeCols, width);
  if (fc > 0) sheet.header.freeze = { cols: fc };
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (typeof v === "string" && v.length > LIMITS.maxSheetCellChars) {
        throw new SheetImportError(
          `Column ${columns[c]?.name ?? colLetter(c)} has a cell over ${LIMITS.maxSheetCellChars} characters`,
        );
      }
    }
  }
  const checked = parseSheet(serializeSheet(sheet));
  if (!checked.ok) {
    throw new SheetImportError(
      `The file does not make a valid sheet: ${checked.errors
        .slice(0, 3)
        .map((e) => e.message)
        .join("; ")}`,
    );
  }
  if (truncated > 0) {
    warnings.push({ code: "headers_truncated", count: truncated, max: MAX_IMPORT_COLUMN_NAME });
  }
  return checked.sheet;
}

const GUARDED = /^'[=+\-@]/;

/** A CSV file's decimal mark: a comma when its fields are separated by semicolons. */
type DecimalMark = "." | ",";

/** The most significant digits a CSV number keeps exactly (a double holds 15 safely). */
const MAX_CSV_DIGITS = 15;

// Each pattern has one way to read each character, so it runs in time linear in the text. No
// leading zero but "0" itself (0.5 is a number, 00123 is not) and no "+".
const PLAIN: Record<DecimalMark, RegExp> = {
  ".": /^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,
  ",": /^-?(?:(?:0|[1-9]\d*)(?:,\d*)?|,\d+)(?:[eE][+-]?\d+)?$/,
};
// Thousands separators only where they cannot be the decimal mark: followed by a fraction, or in
// two groups or more.
const GROUPED: Record<DecimalMark, RegExp> = {
  ".": /^-?[1-9]\d{0,2}(?:(?:,\d{3})+\.\d+|(?:,\d{3}){2,})$/,
  ",": /^-?[1-9]\d{0,2}(?:(?:\.\d{3})+,\d+|(?:\.\d{3}){2,})$/,
};

/** Digits from the first non-zero one to the last of the integer part or the last non-zero one. */
function significantDigits(plain: string): number {
  const mantissa = plain.replace(/^-/, "").split(/[eE]/)[0] ?? "";
  const [whole = "", fraction = ""] = mantissa.split(".");
  return `${whole}${fraction.replace(/0+$/, "")}`.replace(/^0+/, "").length;
}

/** The number a CSV field spells with `mark` as its decimal mark, exactly, or null. */
function csvNumber(t: string, mark: DecimalMark): number | null {
  const group = mark === "." ? "," : ".";
  let plain: string;
  if (PLAIN[mark].test(t)) plain = t;
  else if (GROUPED[mark].test(t)) plain = t.split(group).join("");
  else return null;
  if (mark === ",") plain = plain.replace(",", ".");
  if (significantDigits(plain) > MAX_CSV_DIGITS) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

function csvValue(s: string, mark: DecimalMark): In {
  if (s === "") return null;
  // No number, date or boolean is this long, so a long field is text without a pattern run on it
  // (build() refuses it later if it passes the cell limit).
  if (s.length > MAX_CONVERTED_TEXT) return { t: "s", v: GUARDED.test(s) ? s.slice(1) : s };
  const t = s.trim();
  if (/^(true|false)$/i.test(t)) return { t: "b", v: t.toLowerCase() === "true", raw: s };
  const date = isoDateSerial(t);
  if (date !== null) return { t: "n", v: date, fmt: "date", raw: s };
  if (t.endsWith("%")) {
    const n = csvNumber(t.slice(0, -1).trimEnd(), mark);
    if (n !== null) return { t: "n", v: n / 100, fmt: { style: "percent" }, raw: s };
  } else {
    const n = csvNumber(t, mark);
    if (n !== null) return { t: "n", v: n, raw: s };
  }
  return { t: "s", v: GUARDED.test(s) ? s.slice(1) : s };
}

/**
 * A sheet from CSV text. What the import changed is added to `warnings` when given. Throws
 * SheetImportError.
 */
export function sheetFromCsv(text: string, warnings: SheetImportWarning[] = []): Sheet {
  if (utf8Length(text) > LIMITS.maxSheetImportBytes) {
    throw new SheetImportError(
      `A CSV import is at most ${Math.round(LIMITS.maxSheetImportBytes / (1024 * 1024))} MB`,
    );
  }
  // Rows past the limit are counted, never built, and the cells are counted before any value is
  // made from them: a long or wide file is a refusal, not a Worker out of memory.
  const { rows: table, rowCount, delimiter } = readCsv(text, LIMITS.maxSheetRows);
  const mark: DecimalMark = delimiter === ";" ? "," : ".";
  if (table.length === 0) throw new SheetImportError("The CSV is empty");
  if (rowCount > LIMITS.maxSheetRows) {
    throw new SheetImportError(
      `A sheet holds at most ${LIMITS.maxSheetRows} rows; this file has ${rowCount}`,
    );
  }
  const [head, ...rest] = table as [string[], ...string[][]];
  const records = rest.filter((r) => !(r.length === 1 && r[0] === ""));
  let bytes = 0;
  for (const r of records) for (const s of r) if (s !== "") bytes += 2;
  checkSheetBytes(bytes);
  const data = records.map((r) => {
    const out = r.map((s) => csvValue(s, mark));
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  });
  return build(head, data, warnings);
}

// ---------- .xlsx ----------

const BUILT_IN: Record<number, SheetNumberFormat | "date"> = {
  1: { style: "plain", decimals: 0, grouping: false },
  2: { style: "plain", decimals: 2, grouping: false },
  3: { style: "plain", decimals: 0 },
  4: { style: "plain", decimals: 2 },
  9: { style: "percent", decimals: 0 },
  10: { style: "percent", decimals: 2 },
  14: "date",
  15: "date",
  16: "date",
  17: "date",
  22: "date",
};

const SYMBOLS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
};

/** A cell style's number format as a column format, "date", or undefined. */
export function numberFormatOf(code: string): SheetNumberFormat | "date" | undefined {
  if (code.startsWith("#")) return BUILT_IN[Number(code.slice(1))];
  const firstSection = code.split(";")[0] ?? "";
  // A bracket's contents exclude [ as well as ], so no search runs past the next bracket: the
  // patterns stay linear in the code's length.
  const bracket = /\[\$([^[\]-]*)(?:-[^[\]]*)?\]/.exec(firstSection);
  const bare = firstSection
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^[\]]*\]/g, "")
    .replace(/\\./g, "");
  if (/[dy]/i.test(bare) || /m{3,}/i.test(bare)) return "date";
  const decimals = /\.([0#]+)/.exec(bare)?.[1]?.length;
  const grouping = /[#0],[#0]/.test(bare);
  const dec = decimals !== undefined ? { decimals: Math.min(10, decimals) } : {};
  if (bare.includes("%")) return { style: "percent", ...dec };
  let currency: string | undefined;
  if (bracket?.[1]) {
    const sym = bracket[1];
    currency = /^[A-Z]{3}$/.test(sym) ? sym : SYMBOLS[sym];
  }
  if (!currency) {
    const unbracketed = firstSection.replace(/\[[^[\]]*\]/g, "");
    const sym = Object.keys(SYMBOLS).find((s) => unbracketed.includes(s));
    if (sym) currency = SYMBOLS[sym];
  }
  if (currency)
    return { style: "currency", currency, ...dec, ...(grouping ? {} : { grouping: false }) };
  if (decimals !== undefined || /0/.test(bare))
    return { style: "plain", ...dec, ...(grouping ? {} : { grouping: false }) };
  return undefined;
}

/** A cell style's column format, worked out once per format code however many cells use it. */
type FormatOf = (style: number) => SheetNumberFormat | "date" | undefined;

function formatsOf(styles: string[]): FormatOf {
  const seen = new Map<string, SheetNumberFormat | "date" | undefined>();
  return (style) => {
    const code = styles[style];
    if (code === undefined) return undefined;
    if (!seen.has(code)) seen.set(code, numberFormatOf(code));
    return seen.get(code);
  };
}

function xlsxValue(c: RawCell, formatOf: FormatOf): In {
  if (c === null) return null;
  switch (c.t) {
    case "s":
      return c.v === "" ? null : { t: "s", v: c.v };
    case "b":
      return { t: "b", v: c.v };
    case "e":
      return { t: "s", v: c.v };
    case "n": {
      const fmt = formatOf(c.style);
      return fmt ? { t: "n", v: c.v, fmt } : { t: "n", v: c.v };
    }
    case "f":
      // readXlsx keeps only formulas that parse (keptFormula), their prefixes already dropped.
      return { t: "f", f: c.f, cached: xlsxValue(c.cached, formatOf) };
  }
}

/**
 * A sheet from the first worksheet of an .xlsx file. What the import changed or left out is added
 * to `warnings` when given. Throws SheetImportError.
 */
export function sheetFromXlsx(bytes: Uint8Array, warnings: SheetImportWarning[] = []): Sheet {
  const raw = readXlsx(bytes);
  const found: SheetImportWarning[] = [];
  if (raw.otherSheets.count > 0) {
    found.push({
      code: "other_sheets",
      count: raw.otherSheets.count,
      names: raw.otherSheets.names,
    });
  }
  if (raw.formulasAsValues > 0) {
    found.push({ code: "formulas_as_values", count: raw.formulasAsValues });
  }
  const header = raw.rows[0] ?? [];
  // raw.rows is sparse where the worksheet leaves out a blank row: a plain loop reads a hole as
  // an empty row (map and a spread would keep it as undefined, and Math.max would give NaN).
  let width = 0;
  for (let r = 0; r < raw.rows.length; r++) width = Math.max(width, raw.rows[r]?.length ?? 0);
  const names: string[] = [];
  for (let c = 0; c < width; c++) {
    const h = header[c] ?? null;
    const v = h && h.t === "f" ? h.cached : h;
    names.push(
      v === null
        ? ""
        : v.t === "s" || v.t === "e"
          ? v.v
          : v.t === "n"
            ? String(v.v)
            : v.t === "b"
              ? v.v
                ? "TRUE"
                : "FALSE"
              : "",
    );
  }
  const data: In[][] = [];
  const formatOf = formatsOf(raw.styles);
  for (let r = 1; r < raw.rows.length; r++) {
    const row = raw.rows[r] ?? [];
    const out: In[] = [];
    for (let c = 0; c < row.length; c++) out.push(xlsxValue(row[c] ?? null, formatOf));
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    data.push(out);
    // Each raw row is let go once converted, so the two copies of a large sheet never coexist.
    raw.rows[r] = [];
  }
  while (data.length > 0 && (data[data.length - 1] as In[]).length === 0) data.pop();
  const sheet = build(names, data, found, raw.widths, raw.freezeCols);
  warnings.push(...found);
  return sheet;
}

/** Bytes of base64 text (an .xlsx on the wire). Throws SheetImportError for bad base64. */
export function base64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new SheetImportError("An .xlsx import is sent as base64 in content");
  }
  if ((clean.length * 3) / 4 > LIMITS.maxSheetImportBytes + 3) {
    throw new SheetImportError(
      `An .xlsx import is at most ${Math.round(LIMITS.maxSheetImportBytes / (1024 * 1024))} MB`,
    );
  }
  const bin = platform.atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The canonical sheet text of content in `format`. Throws SheetImportError. */
export function importSheet(content: string, format: Exclude<SheetContentFormat, "jsonl">): string {
  const sheet = format === "csv" ? sheetFromCsv(content) : sheetFromXlsx(base64Bytes(content));
  return serializeSheet(sheet);
}

/**
 * What importing content in `format` would change or leave out (other sheets, formulas kept as
 * values, long column names), in that order; [] when nothing. The import runs in full, so a file
 * the import refuses throws SheetImportError here too.
 */
export function sheetImportWarnings(
  content: string | Uint8Array,
  format: Exclude<SheetContentFormat, "jsonl">,
): SheetImportWarning[] {
  const warnings: SheetImportWarning[] = [];
  if (format === "csv") {
    if (typeof content !== "string") throw new SheetImportError("A CSV import is sent as text");
    sheetFromCsv(content, warnings);
  } else {
    sheetFromXlsx(typeof content === "string" ? base64Bytes(content) : content, warnings);
  }
  return warnings;
}
