// The sheet file (sheet.jsonl): JSON lines. Line 1 is the header, {"plinth":"sheet","v":1,
// "columns":[...]}, whose column names are row 1 in A1 terms; every later line is one row, a JSON
// array of cells. A cell is null, a finite number, a boolean or a string; a string starting with
// "=" is a formula and a leading "'" keeps the rest literal. One parser for the Worker (publish),
// the renderer and the editor; no zod, so the renderer bundle stays small.
//
// Looks are data from fixed lists, never CSS: a select column may give its options a colour
// (`colors`), any column may list highlight rules (`highlight`: a colour for the cells whose value
// matches), and a row may end with an object {"style": {"B": {...}}} that styles its cells (bold,
// italic, a fill, alignment, wrap, borders). Every colour is one of SHEET_COLORS, a name the
// renderer maps to a class with a light and a dark value.
//
// serializeSheet writes the canonical form the Worker stores: the header's keys in a fixed order,
// one JSON.stringify per row with trailing nulls trimmed (its style object, if any, last), no
// trailing newline. So each row has one spelling, and a version diff shows only the rows that
// changed.
import { LIMITS } from "../constants.ts";
import { utf8Length } from "../utf8.ts";
import { a1, colIndex, colLetter } from "./address.ts";
import { parseFormula } from "./formula/parser.ts";
import { isoDateSerial } from "./formula/values.ts";
import { platform } from "./platform.ts";

/**
 * The formats a sheet's content is sent in: its own JSON lines, CSV, or an .xlsx (base64 on the
 * wire), which import.ts converts. Here rather than in import.ts, so the API schemas name them
 * without bundling the importer.
 */
export const SHEET_CONTENT_FORMATS = ["jsonl", "csv", "xlsx"] as const;
export type SheetContentFormat = (typeof SHEET_CONTENT_FORMATS)[number];

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
  /** Select columns only: a colour for some options, by option (read it with optionColor). */
  colors?: Record<string, SheetColor>;
  /** Rules that colour a cell by its computed value; the first one that matches wins. */
  highlight?: SheetHighlightRule[];
}

/**
 * The colours a sheet may use, for fills, highlights and select options: names, never CSS. The
 * renderer maps each to a class with a light and a dark value, and the .xlsx export to the light
 * one.
 */
export const SHEET_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type SheetColor = (typeof SHEET_COLORS)[number];

/** When a highlight rule applies: a comparison with `value`, a span, emptiness or a text match. */
export const SHEET_HIGHLIGHT_WHEN = [
  "<",
  "<=",
  ">",
  ">=",
  "=",
  "<>",
  "between",
  "empty",
  "not_empty",
  "contains",
] as const;
export type SheetHighlightWhen = (typeof SHEET_HIGHLIGHT_WHEN)[number];

/** A column's highlight rule: the cells whose computed value matches show `color`. */
export interface SheetHighlightRule {
  when: SheetHighlightWhen;
  /**
   * What the value is compared with: a number, text or true/false; in a date column a date
   * `YYYY-MM-DD`. Absent for `empty` and `not_empty`.
   */
  value?: number | string | boolean;
  /** `between` only: the span's other end (inclusive). */
  to?: number | string;
  color: SheetColor;
}

/** The most highlight rules a column lists. */
export const MAX_HIGHLIGHT_RULES = 10;
/** The longest text a highlight rule compares with. */
export const MAX_HIGHLIGHT_TEXT = 100;

export const SHEET_ALIGNS = ["left", "center", "right"] as const;
export type SheetAlign = (typeof SHEET_ALIGNS)[number];
export const SHEET_BORDER_SIDES = ["top", "right", "bottom", "left"] as const;
export type SheetBorderSide = (typeof SHEET_BORDER_SIDES)[number];

/** How one cell looks; an absent key is the default (plain, no fill, the type's alignment). */
export interface SheetCellStyle {
  bold?: true;
  italic?: true;
  fill?: SheetColor;
  align?: SheetAlign;
  /** Long text wraps onto more lines instead of being cut. */
  wrap?: true;
  /** The sides drawn with a line, in the order top, right, bottom, left. */
  border?: SheetBorderSide[];
}

/** A cell style's keys, in their canonical order. */
export const SHEET_STYLE_KEYS = ["bold", "italic", "fill", "align", "wrap", "border"] as const;

/** A row's cell styles by column index (absent or null: none). */
export type SheetRowStyle = (SheetCellStyle | null | undefined)[];

/** The most columns a sheet keeps frozen. */
export const MAX_FREEZE_COLS = 5;

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
  /**
   * Cell styles by data row (styles[0] is A1 row 2), sparse: only a row that ends with a style
   * object has an entry. Absent when no row has one.
   */
  styles?: (SheetRowStyle | undefined)[];
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
const COLUMN_KEYS = new Set(["name", "type", "width", "format", "options", "colors", "highlight"]);
const FORMAT_KEYS = new Set(["style", "decimals", "currency", "grouping"]);
const RULE_KEYS = new Set(["when", "value", "to", "color"]);
const ROW_META_KEYS = new Set(["style"]);
const STYLE_KEYS = new Set<string>(SHEET_STYLE_KEYS);
const LETTERS_RE = /^[A-Z]{1,3}$/;

export function isFormula(cell: unknown): cell is string {
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

/** Whether `v` is one of the sheet colours. */
export function isSheetColor(v: unknown): v is SheetColor {
  return typeof v === "string" && (SHEET_COLORS as readonly string[]).includes(v);
}

/** The colour a select column gives an option, or null. */
export function optionColor(col: SheetColumn, value: unknown): SheetColor | null {
  const map = col.colors;
  if (!map || typeof value !== "string" || !Object.hasOwn(map, value)) return null;
  const c = map[value];
  return isSheetColor(c) ? c : null;
}

function checkColors(
  raw: unknown,
  options: readonly string[],
  where: string,
  issues: Issues,
): Record<string, SheetColor> | null {
  if (!isPlainObject(raw)) {
    issues.add({
      line: 1,
      code: "header",
      message: `${where}: colors maps options to colours, e.g. {"Done": "green"}`,
    });
    return null;
  }
  let ok = true;
  // A null-prototype map: an option named "constructor" or "__proto__" is just a key.
  const out = Object.create(null) as Record<string, SheetColor>;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.normalize("NFC");
    if (!options.includes(key)) {
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: colors names ${quote(k)}, which is not one of the options`,
      });
      ok = false;
    } else if (!isSheetColor(v)) {
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: the colour of ${quote(k)} must be one of ${SHEET_COLORS.join(", ")}`,
      });
      ok = false;
    } else out[key] = v;
  }
  return ok ? out : null;
}

/** A rule's comparison value for a column type: the value, or why it cannot be one. */
function ruleValue(
  v: unknown,
  type: SheetColumnType,
  what: string,
): { ok: true; value: number | string | boolean } | { ok: false; message: string } {
  if (type === "number") {
    return typeof v === "number" && Number.isFinite(v)
      ? { ok: true, value: v }
      : { ok: false, message: `${what} must be a number in a number column` };
  }
  if (type === "date") {
    return typeof v === "string" && isoDateSerial(v) !== null
      ? { ok: true, value: v }
      : { ok: false, message: `${what} must be a date YYYY-MM-DD in a date column` };
  }
  if (type === "checkbox") {
    return typeof v === "boolean"
      ? { ok: true, value: v }
      : { ok: false, message: `${what} must be true or false in a checkbox column` };
  }
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: v };
  if (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= MAX_HIGHLIGHT_TEXT &&
    !CONTROL_OR_FORMAT.test(v)
  ) {
    return { ok: true, value: v.normalize("NFC") };
  }
  return {
    ok: false,
    message: `${what} must be a number or 1 to ${MAX_HIGHLIGHT_TEXT} characters of text`,
  };
}

/**
 * One highlight rule checked against its column's type: the rule in its canonical form, or why it
 * cannot be one. `empty` and `not_empty` take no value; a comparison takes `value` (a number in a
 * number column, a date in a date column, true or false in a checkbox column with = or <>, else a
 * number or text); `between` takes `value` and `to` (numbers, or dates in a date column), the
 * lower one first; `contains` takes text.
 */
export function checkHighlightRule(
  raw: unknown,
  type: SheetColumnType,
): { ok: true; rule: SheetHighlightRule } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: "a rule is an object with when and color" };
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.has(k)) return { ok: false, message: `unknown key ${quote(k)} in a rule` };
  }
  const when = raw.when as SheetHighlightWhen;
  if (!(SHEET_HIGHLIGHT_WHEN as readonly unknown[]).includes(when)) {
    return { ok: false, message: `when must be one of ${SHEET_HIGHLIGHT_WHEN.join(" ")}` };
  }
  if (!isSheetColor(raw.color)) {
    return { ok: false, message: `color must be one of ${SHEET_COLORS.join(", ")}` };
  }
  const rule: SheetHighlightRule = { when, color: raw.color };
  if (when !== "between" && raw.to !== undefined) {
    return { ok: false, message: "to is only for between" };
  }
  if (when === "empty" || when === "not_empty") {
    if (raw.value !== undefined) return { ok: false, message: `${when} takes no value` };
    return { ok: true, rule };
  }
  if (raw.value === undefined) return { ok: false, message: `${when} needs a value` };
  if (when === "contains") {
    if (type === "checkbox") return { ok: false, message: "contains is not for checkbox columns" };
    const v = raw.value;
    if (
      typeof v !== "string" ||
      v.length < 1 ||
      v.length > MAX_HIGHLIGHT_TEXT ||
      CONTROL_OR_FORMAT.test(v)
    ) {
      return { ok: false, message: `contains takes 1 to ${MAX_HIGHLIGHT_TEXT} characters of text` };
    }
    rule.value = v.normalize("NFC");
    return { ok: true, rule };
  }
  if (type === "checkbox" && when !== "=" && when !== "<>") {
    return { ok: false, message: "a checkbox column compares with = or <> only" };
  }
  if (when === "between") {
    const numeric = type === "date" ? "date" : "number";
    const lo = ruleValue(raw.value, numeric, "value");
    if (!lo.ok) return lo;
    if (raw.to === undefined) return { ok: false, message: "between needs value and to" };
    const hi = ruleValue(raw.to, numeric, "to");
    if (!hi.ok) return hi;
    const a = numeric === "date" ? isoDateSerial(lo.value as string) : (lo.value as number);
    const b = numeric === "date" ? isoDateSerial(hi.value as string) : (hi.value as number);
    if ((a as number) > (b as number)) {
      return { ok: false, message: "between's value is the lower end and to the higher one" };
    }
    rule.value = lo.value;
    rule.to = hi.value as number | string;
    return { ok: true, rule };
  }
  const v = ruleValue(raw.value, type, "value");
  if (!v.ok) return v;
  rule.value = v.value;
  return { ok: true, rule };
}

function checkHighlight(
  raw: unknown,
  type: SheetColumnType,
  where: string,
  issues: Issues,
): SheetHighlightRule[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_HIGHLIGHT_RULES) {
    issues.add({
      line: 1,
      code: "header",
      message: `${where}: highlight lists 1 to ${MAX_HIGHLIGHT_RULES} rules`,
    });
    return null;
  }
  const out: SheetHighlightRule[] = [];
  let ok = true;
  raw.forEach((r, i) => {
    const checked = checkHighlightRule(r, type);
    if (checked.ok) out.push(checked.rule);
    else {
      ok = false;
      issues.add({
        line: 1,
        code: "header",
        message: `${where}: highlight rule ${i + 1}: ${checked.message}`,
      });
    }
  });
  return ok ? out : null;
}

/**
 * One cell's style checked: the style in its canonical form (null when it sets nothing), or why
 * it cannot be one.
 */
export function checkCellStyle(
  raw: unknown,
): { ok: true; style: SheetCellStyle | null } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: "a cell's style is an object" };
  for (const k of Object.keys(raw)) {
    if (!STYLE_KEYS.has(k)) {
      return {
        ok: false,
        message: `unknown key ${quote(k)} in a style (${SHEET_STYLE_KEYS.join(", ")})`,
      };
    }
  }
  const out: SheetCellStyle = {};
  for (const k of ["bold", "italic", "wrap"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (v !== true) return { ok: false, message: `${k} is true or left out` };
    out[k] = true;
  }
  if (raw.fill !== undefined) {
    if (!isSheetColor(raw.fill)) {
      return { ok: false, message: `fill must be one of ${SHEET_COLORS.join(", ")}` };
    }
    out.fill = raw.fill;
  }
  if (raw.align !== undefined) {
    if (!(SHEET_ALIGNS as readonly unknown[]).includes(raw.align)) {
      return { ok: false, message: `align must be one of ${SHEET_ALIGNS.join(", ")}` };
    }
    out.align = raw.align as SheetAlign;
  }
  if (raw.border !== undefined) {
    const b = raw.border;
    if (
      !Array.isArray(b) ||
      b.length < 1 ||
      b.some((s) => !(SHEET_BORDER_SIDES as readonly unknown[]).includes(s)) ||
      new Set(b).size !== b.length
    ) {
      return {
        ok: false,
        message: `border lists sides from ${SHEET_BORDER_SIDES.join(", ")}, each once`,
      };
    }
    out.border = SHEET_BORDER_SIDES.filter((s) => b.includes(s));
  }
  return { ok: true, style: Object.keys(out).length > 0 ? canonicalStyle(out) : null };
}

/** A style with its keys in the canonical order. */
export function canonicalStyle(s: SheetCellStyle): SheetCellStyle {
  const out: SheetCellStyle = {};
  if (s.bold) out.bold = true;
  if (s.italic) out.italic = true;
  if (s.fill) out.fill = s.fill;
  if (s.align) out.align = s.align;
  if (s.wrap) out.wrap = true;
  if (s.border && s.border.length > 0) {
    const sides = s.border;
    out.border = SHEET_BORDER_SIDES.filter((x) => sides.includes(x));
  }
  return out;
}

/** A row array split into its cells and the style object it may end with. */
export function splitRow(row: readonly unknown[]): { cells: unknown[]; meta: unknown } {
  const last = row[row.length - 1];
  if (row.length > 0 && isPlainObject(last)) {
    return { cells: row.slice(0, -1), meta: last };
  }
  return { cells: [...row], meta: undefined };
}

/**
 * A row's style object ({"style": {"B": {...}}}) checked against the number of columns: the
 * styles by column index (null when it styles nothing), or why it cannot be.
 */
export function checkRowMeta(
  meta: unknown,
  columns: number,
  rowNumber: number,
): { ok: true; style: SheetRowStyle | null } | { ok: false; message: string } {
  if (meta === undefined) return { ok: true, style: null };
  if (!isPlainObject(meta)) return { ok: false, message: `line ${rowNumber}: bad style object` };
  for (const k of Object.keys(meta)) {
    if (!ROW_META_KEYS.has(k)) {
      return {
        ok: false,
        message: `line ${rowNumber}: a row's last object holds only "style", not ${quote(k)}`,
      };
    }
  }
  const raw = meta.style;
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      message: `line ${rowNumber}: "style" maps column letters to styles, e.g. {"B": {"bold": true}}`,
    };
  }
  const out: SheetRowStyle = [];
  let any = false;
  for (const [letter, s] of Object.entries(raw)) {
    const col = LETTERS_RE.test(letter) ? colIndex(letter) : -1;
    if (col < 0 || col >= columns) {
      return {
        ok: false,
        message: `line ${rowNumber}: style names ${quote(letter)}, which is not a column of this sheet`,
      };
    }
    const checked = checkCellStyle(s);
    if (!checked.ok) return { ok: false, message: `${a1(rowNumber, col)}: ${checked.message}` };
    if (checked.style) {
      out[col] = checked.style;
      any = true;
    }
  }
  return { ok: true, style: any ? out : null };
}

/** One row line, canonical: its cells with trailing empty ones trimmed, then its style, if any. */
export function serializeRow(cells: readonly Cell[], style?: SheetRowStyle | null): string {
  const out: unknown[] = trimRow(cells);
  const meta = styleObject(style);
  if (meta) out.push({ style: meta });
  return JSON.stringify(out);
}

/** A row's styles as the file writes them, by column letter in column order; null when none. */
function styleObject(style: SheetRowStyle | null | undefined): Record<string, unknown> | null {
  if (!style) return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (let c = 0; c < style.length; c++) {
    const s = style[c];
    if (!s) continue;
    const canon = canonicalStyle(s);
    if (Object.keys(canon).length === 0) continue;
    out[colLetter(c)] = canon;
    any = true;
  }
  return any ? out : null;
}

/** Whether a row style styles any cell. */
export function hasStyle(style: SheetRowStyle | null | undefined): style is SheetRowStyle {
  return !!style && style.some((s) => !!s && Object.keys(s).length > 0);
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
    if (c.colors !== undefined) {
      if (type !== "select") {
        issues.add({
          line: 1,
          code: "header",
          message: `${where}: colors are only for select columns`,
        });
      } else {
        const colors = checkColors(c.colors, col.options ?? [], where, issues);
        if (colors) col.colors = colors;
      }
    }
    if (c.highlight !== undefined) {
      const rules = checkHighlight(c.highlight, col.type, where, issues);
      if (rules) col.highlight = rules;
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
      (n as number) > MAX_FREEZE_COLS ||
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

/**
 * Problems of one row against the header. `rowNumber` is the A1 row (line number). The row may
 * end with its style object (splitRow).
 */
export function checkRow(header: SheetHeader, raw: unknown, rowNumber: number): SheetIssue[] {
  if (!Array.isArray(raw)) {
    return [
      {
        line: rowNumber,
        code: "row",
        message: `line ${rowNumber}: a row is a JSON array of cells`,
      },
    ];
  }
  const { cells: row, meta } = splitRow(raw);
  const style = checkRowMeta(meta, header.columns.length, rowNumber);
  if (!style.ok) return [{ line: rowNumber, code: "row", message: style.message }];
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
  const styles: (SheetRowStyle | undefined)[] = [];
  let styled = false;
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
    const { cells, meta } = splitRow(row);
    for (const c of cells) if (isFormula(c)) formulas++;
    if (meta !== undefined && header) {
      const s = checkRowMeta(meta, header.columns.length, n);
      if (s.ok && s.style) {
        styles[rows.length] = s.style;
        styled = true;
      }
    }
    rows.push(cells as Cell[]);
  }
  if (formulas > LIMITS.maxSheetFormulaCells) {
    issues.add({
      line: 1,
      code: "limit",
      message: `A sheet holds at most ${LIMITS.maxSheetFormulaCells} formulas; this one has ${formulas}`,
    });
  }
  if (!header || issues.count > 0) return { ok: false, errors: issues.list, count: issues.count };
  return { ok: true, sheet: styled ? { header, rows, styles } : { header, rows } };
}

/** A highlight rule with its keys in the canonical order. */
export function canonicalRule(r: SheetHighlightRule): SheetHighlightRule {
  // Built in this order so the colour comes last in every spelling.
  const out = { when: r.when } as SheetHighlightRule;
  if (r.value !== undefined) out.value = r.value;
  if (r.to !== undefined) out.to = r.to;
  out.color = r.color;
  return out;
}

/** A column with its keys in the canonical order (colours in the order of the options). */
export function canonicalColumn(c: SheetColumn): SheetColumn {
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
  if (c.colors) {
    const colors = Object.create(null) as Record<string, SheetColor>;
    let any = false;
    for (const o of c.options ?? []) {
      const color = optionColor(c, o);
      if (color) {
        colors[o] = color;
        any = true;
      }
    }
    if (any) out.colors = colors;
  }
  if (c.highlight && c.highlight.length > 0) out.highlight = c.highlight.map(canonicalRule);
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
  const styles = sheet.styles;
  sheet.rows.forEach((row, i) => {
    lines.push(serializeRow(row, styles?.[i]));
  });
  return lines.join("\n");
}

/** A row line's cells and style, or null when it is not a row array. Does not check them. */
export function readRowLine(
  line: string | undefined,
): { cells: Cell[]; style: SheetRowStyle | null } | null {
  if (line === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  const { cells, meta } = splitRow(v);
  let style: SheetRowStyle | null = null;
  if (isPlainObject(meta) && isPlainObject(meta.style)) {
    style = [];
    for (const [letter, s] of Object.entries(meta.style)) {
      const col = LETTERS_RE.test(letter) ? colIndex(letter) : -1;
      const checked = col >= 0 ? checkCellStyle(s) : null;
      if (checked?.ok && checked.style) style[col] = checked.style;
    }
  }
  return { cells: cells as Cell[], style };
}
