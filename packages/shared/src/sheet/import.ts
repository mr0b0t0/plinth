// Turning a CSV or .xlsx file into a sheet. The first row names the columns; each column's type is
// inferred from its values (all numbers: number, all dates: date, all TRUE or FALSE: checkbox, all
// links: url, else text). CSV holds values only: text starting with = stays text (a CSV import
// never makes a formula), and the ' a CSV export put before =, +, - or @ is dropped. From an
// .xlsx, a formula is kept when it parses as a sheet formula (the function allowlist, one sheet),
// otherwise its cached value is used; number formats become the column's format where they map.
// The result is checked by parseSheet like any published sheet.
import { LIMITS } from "../constants.ts";
import { utf8Bytes } from "../pageComments.ts";
import { colLetter } from "./address.ts";
import { readCsv } from "./csv.ts";
import {
  type Cell,
  isSheetLinkUrl,
  parseSheet,
  type Sheet,
  type SheetColumn,
  type SheetColumnType,
  type SheetNumberFormat,
  serializeSheet,
} from "./format.ts";
import { isoDateSerial, MIN_DATE_SERIAL, numberFromText, serialIso } from "./formula/values.ts";
import { platform } from "./platform.ts";
import { checkSheetBytes, type RawCell, readXlsx, SheetImportError } from "./xlsxRead.ts";

export { SheetImportError } from "./xlsxRead.ts";

/** The formats an import reads: the sheet's own JSON lines, CSV, or an .xlsx (base64 on the wire). */
export const SHEET_CONTENT_FORMATS = ["jsonl", "csv", "xlsx"] as const;
export type SheetContentFormat = (typeof SHEET_CONTENT_FORMATS)[number];

/** A value before its column's type is known. */
type In =
  | null
  | { t: "s"; v: string }
  | { t: "n"; v: number; fmt?: SheetNumberFormat | "date" }
  | { t: "b"; v: boolean }
  | { t: "f"; f: string; cached: In };

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** A column name is read from this many characters of its header cell, and keeps at most 100. */
export const COLUMN_NAME_SOURCE_CHARS = 1_000;

/** The first `n` UTF-16 units of `s`, one fewer when the last would split a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

function columnName(raw: string, i: number): string {
  // Cut before the replaces and normalize: header cells are not counted toward the sheet's size,
  // and one shared string of megabytes can stand behind all 100 of them.
  const name = cut(raw, COLUMN_NAME_SOURCE_CHARS)
    .replace(CONTROL_OR_FORMAT, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  return cut(name || colLetter(i), 100).trimEnd();
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
      return v.v;
    case "n":
      if (type === "date") return serialIso(v.v);
      if (v.fmt === "date" && type === "text") return serialIso(v.v) ?? v.v;
      return v.v;
    case "s":
      return type === "url" ? v.v : literal(v.v);
  }
}

/** A sheet from a header row and data rows of typed values. Throws SheetImportError. */
function build(names: string[], data: In[][], widths?: Map<number, number>, freezeCols = 0): Sheet {
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
  for (let c = 0; c < width; c++) {
    const { type, format } = inferType(data.map((r) => r[c] ?? null));
    const col: SheetColumn = { name: columnName(names[c] ?? "", c), type };
    if (format) col.format = format;
    const w = widths?.get(c);
    if (w !== undefined) col.width = Math.min(800, Math.max(40, w));
    columns.push(col);
  }
  const rows = data.map((r) => columns.map((col, c) => cellFor(r[c] ?? null, col.type)));
  const sheet: Sheet = { header: { columns }, rows };
  const fc = Math.min(5, freezeCols, width);
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
  return checked.sheet;
}

const GUARDED = /^'[=+\-@]/;

function csvValue(s: string): In {
  if (s === "") return null;
  const t = s.trim();
  if (/^(true|false)$/i.test(t)) return { t: "b", v: t.toLowerCase() === "true" };
  const date = isoDateSerial(t);
  if (date !== null) return { t: "n", v: date, fmt: "date" };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(t)) {
    const n = numberFromText(t);
    if (n !== null)
      return t.endsWith("%") ? { t: "n", v: n, fmt: { style: "percent" } } : { t: "n", v: n };
  }
  return { t: "s", v: GUARDED.test(s) ? s.slice(1) : s };
}

/** A sheet from CSV text. Throws SheetImportError. */
export function sheetFromCsv(text: string): Sheet {
  if (utf8Bytes(text) > LIMITS.maxSheetImportBytes) {
    throw new SheetImportError(
      `A CSV import is at most ${Math.round(LIMITS.maxSheetImportBytes / (1024 * 1024))} MB`,
    );
  }
  // Rows past the limit are counted, never built, and the cells are counted before any value is
  // made from them: a long or wide file is a refusal, not a Worker out of memory.
  const { rows: table, rowCount } = readCsv(text, LIMITS.maxSheetRows);
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
    const out = r.map(csvValue);
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  });
  return build(head, data);
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

/** A sheet from the first worksheet of an .xlsx file. Throws SheetImportError. */
export function sheetFromXlsx(bytes: Uint8Array): Sheet {
  const raw = readXlsx(bytes);
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
  return build(names, data, raw.widths, raw.freezeCols);
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
