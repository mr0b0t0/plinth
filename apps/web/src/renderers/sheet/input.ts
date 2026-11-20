// What a person types into a cell, as the cell the sheet stores (on-page editing, #36). Pure: no
// DOM. A leading "=" is a formula and a leading "'" keeps text literal in every column, as in the
// file format; otherwise the column's type decides: numbers in the viewer's locale (its decimal
// and grouping separators, a trailing % for a percent column), dates as YYYY-MM-DD, TRUE/FALSE for
// checkboxes, one of the options for a select. The row is then checked by checkRow, exactly as
// the room checks it, so a refused value never leaves the frame.
import type { Cell, SheetColumn } from "@plinth/shared";

export interface NumberLocale {
  decimal: string;
  group: string;
}

/** The decimal and grouping separators of a locale (the viewer's by default). */
export function numberLocale(locale?: string): NumberLocale {
  let decimal = ".";
  let group = ",";
  try {
    for (const p of new Intl.NumberFormat(locale).formatToParts(12345.6)) {
      if (p.type === "decimal") decimal = p.value;
      if (p.type === "group") group = p.value;
    }
  } catch {
    // the defaults
  }
  return { decimal, group };
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** A number typed in the locale, or null when the text is not one. */
export function parseLocaleNumber(text: string, loc: NumberLocale, percent = false): number | null {
  let t = text.trim().replace(/[\s  ]/g, "");
  let scale = 1;
  if (t.endsWith("%")) {
    t = t.slice(0, -1);
    scale = 100;
  } else if (percent && t !== "") {
    // A percent column shows 12.5% for 0.125: typing 12.5 means the same.
    scale = 100;
  }
  if (loc.group && loc.group !== loc.decimal) t = t.split(loc.group).join("");
  if (loc.decimal !== ".") t = t.split(loc.decimal).join(".");
  if (!NUMBER_RE.test(t)) return null;
  const n = Number(t) / scale;
  return Number.isFinite(n) ? n : null;
}

/** What a typed text becomes in a column: the cell, or a message saying why it cannot. */
export function cellFromInput(
  text: string,
  col: SheetColumn,
  loc: NumberLocale = numberLocale(),
): { ok: true; cell: Cell } | { ok: false; message: string } {
  if (text === "") return { ok: true, cell: null };
  if (text.startsWith("=") || text.startsWith("'")) return { ok: true, cell: text };
  switch (col.type) {
    case "text":
      return { ok: true, cell: text };
    case "number": {
      const n = parseLocaleNumber(text, loc, col.format?.style === "percent");
      return n === null
        ? { ok: false, message: `${col.name} takes numbers` }
        : { ok: true, cell: n };
    }
    case "checkbox": {
      const t = text.trim().toLowerCase();
      if (t === "true" || t === "yes" || t === "1" || t === "x") return { ok: true, cell: true };
      if (t === "false" || t === "no" || t === "0") return { ok: true, cell: false };
      return { ok: false, message: `${col.name} is a checkbox: TRUE or FALSE` };
    }
    case "date":
    case "select":
    case "url":
      // Checked by checkRow (a real date, one of the options, an http:, https: or mailto: link).
      return { ok: true, cell: text.trim() };
  }
}

/** A cell as its field shows it for editing: what the sheet holds, numbers in the locale. */
export function inputText(
  cell: Cell,
  col: SheetColumn,
  loc: NumberLocale = numberLocale(),
): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell === "number") {
    if (col.type !== "number") return String(cell);
    const n = col.format?.style === "percent" ? Number((cell * 100).toPrecision(15)) : cell;
    const s = String(n);
    return /e/i.test(s) || loc.decimal === "." ? s : s.replace(".", loc.decimal);
  }
  return cell;
}

/**
 * Tab-separated text as a spreadsheet app copies it: rows by line, cells by tab, a cell in double
 * quotes may hold tabs, newlines and "" for a quote. A trailing newline ends the last row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const t = text.replace(/\r\n?/g, "\n");
  while (i <= t.length) {
    let cell = "";
    if (t[i] === '"') {
      i++;
      for (;;) {
        if (i >= t.length) break;
        if (t[i] === '"') {
          if (t[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += t[i];
        i++;
      }
      // Anything after the closing quote, up to the separator, is kept as written.
      while (i < t.length && t[i] !== "\t" && t[i] !== "\n") cell += t[i++];
    } else {
      while (i < t.length && t[i] !== "\t" && t[i] !== "\n") cell += t[i++];
    }
    row.push(cell);
    if (i >= t.length) {
      rows.push(row);
      break;
    }
    if (t[i] === "\t") {
      i++;
      continue;
    }
    // A newline: the row ends.
    i++;
    rows.push(row);
    row = [];
    if (i === t.length) break;
  }
  return rows;
}
