// Formula values and Excel's coercions between them, and the 1900 date system. Pure.

/** Every error a formula value can be: Excel's, plus #CYCLE! and #LIMIT! (Plinth's own). */
export const SHEET_ERROR_CODES = [
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#N/A",
  "#NUM!",
  "#NULL!",
  "#CYCLE!",
  "#LIMIT!",
] as const;
export type SheetErrorCode = (typeof SHEET_ERROR_CODES)[number];

export interface SheetError {
  readonly error: SheetErrorCode;
}

/** A computed cell value. null is an empty cell. */
export type Value = number | string | boolean | null | SheetError;

const ERRORS = new Map<SheetErrorCode, SheetError>(
  SHEET_ERROR_CODES.map((c) => [c, Object.freeze({ error: c })]),
);

/** The one error object for a code. */
export function err(code: SheetErrorCode): SheetError {
  return ERRORS.get(code) as SheetError;
}

export function isError(v: unknown): v is SheetError {
  return typeof v === "object" && v !== null && typeof (v as SheetError).error === "string";
}

/** What each error means, for the renderer's tooltip and the skill. */
export const SHEET_ERROR_MEANINGS: Readonly<Record<SheetErrorCode, string>> = {
  "#DIV/0!": "Division by zero",
  "#VALUE!": "A value of the wrong kind (text where a number is needed, say)",
  "#REF!": "A reference to a cell that was deleted or does not exist",
  "#NAME?": "A name the formula cannot resolve",
  "#N/A": "No value found (a lookup with no match)",
  "#NUM!": "A number out of range",
  "#NULL!": "Two ranges that do not intersect",
  "#CYCLE!": "The formula depends on itself (a circular reference)",
  "#LIMIT!": "Not calculated: the sheet needed more steps than the calculation budget",
};

/**
 * Characters of text that cost one step to read. A function or comparison that walks, compares or
 * lowercases text pays for it this way, so the step budget bounds its CPU: one long text read many
 * times costs what it does (=LEN(A2)+LEN(A2)+... over 32,767 characters took 1.4 s at 200,000
 * steps when a read was free). About what a step's own work costs, so short text is nearly free.
 */
export const TEXT_CHARS_PER_STEP = 32;

/** The steps reading `units` UTF-16 units of text costs. */
export function textSteps(units: number): number {
  return Math.floor(units / TEXT_CHARS_PER_STEP);
}

/** The steps reading `v` costs: its length for text, nothing for any other value. */
export function textCost(v: Value): number {
  return typeof v === "string" ? textSteps(v.length) : 0;
}

/**
 * Text longer than this is never read as a number or a boolean (#VALUE!), so a conversion costs at
 * most this much whatever a cell holds. No number or TRUE needs as many characters.
 */
export const MAX_CONVERTED_TEXT = 1_024;

/** Numbers rounded to 15 significant digits, as spreadsheets show them. */
export function round15(n: number): number {
  return n === 0 ? 0 : Number(n.toPrecision(15));
}

/** Text of a number the way a formula turns it into text (general format). */
export function numberText(n: number): string {
  const r = round15(n);
  if (Object.is(r, -0)) return "0";
  return String(r);
}

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A number from numeric text ("3", " 2.5 ", "50%", "2026-01-31"), or null. */
export function numberFromText(s: string): number | null {
  if (s.length > MAX_CONVERTED_TEXT) return null;
  const t = s.trim();
  if (t === "") return null;
  if (NUMERIC_TEXT.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (t.endsWith("%") && NUMERIC_TEXT.test(t.slice(0, -1).trim())) {
    const n = Number(t.slice(0, -1).trim()) / 100;
    return Number.isFinite(n) ? n : null;
  }
  return isoDateSerial(t);
}

/** A number, or #VALUE!: empty is 0, booleans are 1 and 0, numeric text converts. */
export function toNumber(v: Value): number | SheetError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return numberFromText(v) ?? err("#VALUE!");
  return v;
}

/** Text: empty is "", numbers in general format, booleans TRUE and FALSE. */
export function toText(v: Value): string | SheetError {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}

/** A boolean: empty is FALSE, numbers are non-zero, text only "TRUE" or "FALSE". */
export function toBoolean(v: Value): boolean | SheetError {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (v.length > MAX_CONVERTED_TEXT) return err("#VALUE!");
    const u = v.trim().toUpperCase();
    if (u === "TRUE") return true;
    if (u === "FALSE") return false;
    return err("#VALUE!");
  }
  return v;
}

/** A finite number, or #NUM!. */
export function finite(n: number): number | SheetError {
  return Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : err("#NUM!");
}

const RANK = (v: number | string | boolean) =>
  typeof v === "number" ? 1 : typeof v === "string" ? 2 : 3;

/**
 * Excel's comparison: -1, 0 or 1. Empty compares as 0, "" or FALSE against the other side; numbers
 * sort before text, text before booleans; text compares without case; numbers equal to 15
 * significant digits are equal.
 */
export function compareValues(a: Value, b: Value): number {
  let x = a as number | string | boolean | null;
  let y = b as number | string | boolean | null;
  if (x === null && y === null) return 0;
  if (x === null) x = typeof y === "number" ? 0 : typeof y === "string" ? "" : false;
  if (y === null) y = typeof x === "number" ? 0 : typeof x === "string" ? "" : false;
  const rx = RANK(x);
  const ry = RANK(y);
  if (rx !== ry) return rx < ry ? -1 : 1;
  if (typeof x === "number") {
    const p = round15(x);
    const q = round15(y as number);
    return p === q ? 0 : p < q ? -1 : 1;
  }
  if (typeof x === "string") {
    const p = x.toLowerCase();
    const q = (y as string).toLowerCase();
    return p === q ? 0 : p < q ? -1 : 1;
  }
  return x === y ? 0 : x ? 1 : -1;
}

// ---------- dates: the 1900 system, serials are days since 1899-12-30 ----------

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);
/** 9999-12-31, the last date a serial can name. */
export const MAX_DATE_SERIAL = 2_958_465;
/** 1900-03-01: the first date whose serial matches Excel's (Excel counts a 1900-02-29). */
export const MIN_DATE_SERIAL = 61;

/** The serial of a calendar date; months and days past their end roll over, as in DATE(). */
export function dateSerial(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round((t.getTime() - EPOCH) / DAY_MS);
}

/** Year, month (1 to 12) and day of a serial's whole part. */
export function serialDate(serial: number): { y: number; m: number; d: number } {
  const t = new Date(EPOCH + Math.floor(serial) * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The serial of a real YYYY-MM-DD date from 1900-03-01 to 9999-12-31, or null. */
export function isoDateSerial(s: string): number | null {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const serial = dateSerial(y, mo, d);
  const back = serialDate(serial);
  if (back.y !== y || back.m !== mo || back.d !== d) return null;
  if (serial < MIN_DATE_SERIAL || serial > MAX_DATE_SERIAL) return null;
  return serial;
}

/** YYYY-MM-DD for a serial in range, or null. */
export function serialIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_DATE_SERIAL + 1) return null;
  const { y, m, d } = serialDate(serial);
  if (y > 9999) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today's date (UTC) as a serial. */
export function todaySerial(now = Date.now()): number {
  return Math.floor((now - EPOCH) / DAY_MS);
}
