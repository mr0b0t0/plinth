// CSV out of a sheet (the renderer's download) and CSV in (an import). Pure, so both are tested
// once. Export writes values, not formulas: RFC 4180 quoting, UTF-8 with a BOM, CRLF, and the
// OWASP formula-injection guard: a text value starting with =, +, -, @, tab or carriage return is
// written with a leading ', so a spreadsheet opening the file never runs it. Numbers are never
// prefixed.
import type { Sheet } from "./format.ts";
import type { SheetEvaluation } from "./formula/evaluate.ts";
import { isError, numberText, serialIso, type Value } from "./formula/values.ts";

const NEEDS_GUARD = /^[=+\-@\t\r]/;

/** One CSV field: guarded when it is text a spreadsheet would run, quoted when it must be. */
export function csvField(v: string, text: boolean): string {
  const s = text && NEEDS_GUARD.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A computed value as the CSV writes it, and whether it is text (guarded). */
export function exportValue(v: Value, dateColumn: boolean): { s: string; text: boolean } {
  if (v === null) return { s: "", text: false };
  if (typeof v === "number") {
    if (dateColumn) {
      const iso = serialIso(v);
      if (iso) return { s: iso, text: false };
    }
    return { s: numberText(v), text: false };
  }
  if (typeof v === "boolean") return { s: v ? "TRUE" : "FALSE", text: false };
  if (isError(v)) return { s: v.error, text: false };
  return { s: v, text: true };
}

/** The sheet's values as CSV: the header row, then every row, CRLF, with a BOM. */
export function toCsv(sheet: Sheet, ev: SheetEvaluation): string {
  const cols = sheet.header.columns;
  const lines = [cols.map((c) => csvField(c.name, true)).join(",")];
  for (let i = 0; i < sheet.rows.length; i++) {
    const fields: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const { s, text } = exportValue(ev.value(i + 2, c), cols[c]?.type === "date");
      fields.push(csvField(s, text));
    }
    lines.push(fields.join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * Parse CSV text (a leading BOM dropped; the delimiter is the first line's most common of comma,
 * semicolon and tab outside quotes). Quoted fields may hold the delimiter, quotes ("") and line
 * breaks. A last empty line is dropped.
 */
export function parseCsv(input: string): string[][] {
  return readCsv(input, Number.POSITIVE_INFINITY).rows;
}

/**
 * parseCsv for an import, bounded by `maxRows`: it keeps the first record and at most `maxRows`
 * non-blank records after it (a blank record is one empty field, a line with nothing on it), and
 * past that only counts records without building their fields, so a long file costs no memory
 * beyond the rows a sheet can hold. `rowCount` is every non-blank record after the first.
 */
export function readCsv(input: string, maxRows: number): { rows: string[][]; rowCount: number } {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const delim = detectDelimiter(text);
  const rows: string[][] = [];
  let rowCount = 0;
  let first = true;
  let keep = true;
  let row: string[] = [];
  let field = "";
  // The field's length, counted while fields are no longer kept, and whether the record so far
  // holds any character or delimiter (a record without either is blank).
  let fieldLen = 0;
  let filled = false;
  let quoted = false;
  const add = (s: string) => {
    if (keep) field += s;
    fieldLen += s.length;
    filled = true;
  };
  const endField = () => {
    if (keep) row.push(field);
    field = "";
    fieldLen = 0;
  };
  const endRecord = () => {
    endField();
    if (first) first = false;
    else if (filled && ++rowCount > maxRows) keep = false;
    if (keep) rows.push(row);
    row = [];
    filled = false;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          add('"');
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      add(ch);
      i++;
      continue;
    }
    if (ch === '"' && fieldLen === 0) {
      quoted = true;
      i++;
    } else if (ch === delim) {
      endField();
      filled = true;
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endRecord();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      add(ch);
      i++;
    }
  }
  if (filled) endRecord();
  return { rows, rowCount };
}

function detectDelimiter(text: string): string {
  const counts = new Map<string, number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const ch = text[i] as string;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) as number) + 1);
  }
  let best = ",";
  for (const [d, c] of counts) if (c > (counts.get(best) as number)) best = d;
  return best;
}
