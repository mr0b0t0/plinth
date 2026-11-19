// The whole-draft review of a sheet (#36). A sheet's live draft is never merged with a version
// published meanwhile: the editors see the draft and that version whole, side by side, and choose
// one. This module is pure (no DOM): what each side shows as a grid, and the plain-language lists
// of what each side changed since the draft's base ("B7: 12 → 14", "Row 10 added (Pears)").
//
// Everything here becomes text nodes in the app (React), never HTML: a sheet's cells are
// untrusted text, as in the source diff the review replaces.
import {
  a1,
  type Cell,
  colLetter,
  diffLines,
  evaluateSheet,
  isFormula,
  LIMITS,
  literalText,
  parseSheet,
  type Sheet,
  type SheetColumn,
  type SheetHeader,
  serializeSheet,
} from "@plinth/shared";
import { displayValue } from "../../renderers/sheet/format.ts";

/** Rows each side of the review shows; the rest is counted ("and 1,200 more rows"). */
export const REVIEW_MAX_ROWS = 500;
/** Items a change list shows; the rest is counted ("and 40 more"). */
export const CHANGE_LIST_MAX = 200;
/** Characters of a cell a change list quotes. */
const QUOTE_MAX = 40;

export interface ReviewCell {
  text: string;
  /** The cell as typed, when it differs from what it shows (a formula). */
  title?: string;
  number: boolean;
}

export interface ReviewRow {
  /** The A1 row number (2 for the first data row). */
  n: number;
  cells: ReviewCell[];
  /** Changed or added since the base. */
  changed: boolean;
}

export interface ReviewGrid {
  /** "A · Item", one per column. */
  columns: string[];
  rows: ReviewRow[];
  /** Rows not shown (past REVIEW_MAX_ROWS). */
  more: number;
}

export interface ChangeList {
  items: string[];
  /** Items past CHANGE_LIST_MAX, counted only. */
  more: number;
}

function parsed(text: string): Sheet | null {
  const r = parseSheet(text);
  return r.ok ? r.sheet : null;
}

/** The row lines of a sheet's canonical text (line 0 is the header). */
function rowLines(sheet: Sheet): string[] {
  return serializeSheet(sheet).split("\n").slice(1);
}

/** What a cell holds, quoted for a change list: "12", "=SUM(B2:B4)", "empty". */
export function cellWords(cell: Cell | undefined, col: SheetColumn | undefined): string {
  if (cell === null || cell === undefined || cell === "") return "empty";
  if (typeof cell === "boolean") {
    if (col?.type === "checkbox") return cell ? "checked" : "not checked";
    return cell ? "TRUE" : "FALSE";
  }
  const s = typeof cell === "number" ? String(cell) : isFormula(cell) ? cell : literalText(cell);
  const chars = Array.from(s.replace(/\s+/g, " "));
  return chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX - 1).join("")}…` : chars.join("");
}

/** A row named by its first non-empty cell, for "Row 10 added (Pears)". */
function rowName(row: readonly Cell[] | undefined, header: SheetHeader): string {
  const i = (row ?? []).findIndex((c) => c !== null && c !== "");
  if (i < 0) return " (empty)";
  return ` (${cellWords(row?.[i], header.columns[i])})`;
}

function sameColumn(a: SheetColumn, b: SheetColumn): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function headerChanges(before: SheetHeader, after: SheetHeader, out: string[]): void {
  const start = out.length;
  const b = before.columns;
  const a = after.columns;
  if (b.length === a.length) {
    for (let i = 0; i < a.length; i++) {
      const x = b[i] as SheetColumn;
      const y = a[i] as SheetColumn;
      if (sameColumn(x, y)) continue;
      const L = colLetter(i);
      if (x.name !== y.name) out.push(`Column ${L} renamed: ${x.name} → ${y.name}`);
      if (x.type !== y.type) out.push(`Column ${L} (${y.name}): type changed to ${y.type}`);
      if (x.name === y.name && x.type === y.type)
        out.push(`Column ${L} (${y.name}): settings changed`);
    }
  } else {
    // Columns added or removed: named by what is left over on each side.
    const left = b.map((c) => c.name);
    for (const c of a) {
      const k = left.indexOf(c.name);
      if (k >= 0) left.splice(k, 1);
      else out.push(`Column added: ${c.name}`);
    }
    for (const name of left) out.push(`Column removed: ${name}`);
    if (out.length === start) out.push("Columns changed");
  }
  if ((before.freeze?.cols ?? 0) !== (after.freeze?.cols ?? 0)) {
    out.push(`Frozen columns: ${before.freeze?.cols ?? 0} → ${after.freeze?.cols ?? 0}`);
  }
}

/**
 * What changed from `before` to `after` (two sheets' JSON lines), in plain words: columns first,
 * then rows in order. A row changed in place lists its cells ("B7: 12 → 14") when the columns
 * kept their count; rows inserted or deleted are listed as added or removed.
 */
export function describeSheetChanges(before: string, after: string): ChangeList {
  if (before === after) return { items: [], more: 0 };
  const x = parsed(before);
  const y = parsed(after);
  if (!x || !y) return { items: ["The sheet changed"], more: 0 };
  const out: string[] = [];
  headerChanges(x.header, y.header, out);
  const sameCount = x.header.columns.length === y.header.columns.length;
  const diff = diffLines(rowLines(x), rowLines(y), LIMITS.maxSheetRows * 2);
  if (!diff) out.push("Most rows changed");
  for (const h of diff?.hunks ?? []) {
    const del = h.aEnd - h.aStart;
    const ins = h.bEnd - h.bStart;
    if (del === ins) {
      for (let k = 0; k < del; k++) {
        const r = h.bStart + k + 2;
        const was = x.rows[h.aStart + k] ?? [];
        const now = y.rows[h.bStart + k] ?? [];
        if (!sameCount) {
          out.push(`Row ${r} changed`);
          continue;
        }
        const width = Math.max(was.length, now.length);
        for (let c = 0; c < width; c++) {
          if (JSON.stringify(was[c] ?? null) === JSON.stringify(now[c] ?? null)) continue;
          const col = y.header.columns[c];
          out.push(`${a1(r, c)}: ${cellWords(was[c], col)} → ${cellWords(now[c], col)}`);
        }
      }
      continue;
    }
    for (let k = 0; k < del; k++) {
      out.push(`Row ${h.aStart + k + 2} removed${rowName(x.rows[h.aStart + k], x.header)}`);
    }
    for (let k = 0; k < ins; k++) {
      out.push(`Row ${h.bStart + k + 2} added${rowName(y.rows[h.bStart + k], y.header)}`);
    }
  }
  return {
    items: out.slice(0, CHANGE_LIST_MAX),
    more: Math.max(0, out.length - CHANGE_LIST_MAX),
  };
}

/** "B7: 12 → 14, Row 10 added (Pears), and 4 more": the first few items of a change list. */
export function summarize(list: ChangeList, first = 3): string {
  const shown = list.items.slice(0, first);
  const rest = list.items.length - shown.length + list.more;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

/** How many changes a list counts, shown or not. */
export function changeCount(list: ChangeList): number {
  return list.items.length + list.more;
}

/**
 * One side of the review as a read-only grid: each cell as the sheet shows it (formulas computed
 * within the renderer's step budget), and which rows changed since `base`. Null when the text is
 * not a sheet.
 */
export function reviewGrid(text: string, base: string | null): ReviewGrid | null {
  const sheet = parsed(text);
  if (!sheet) return null;
  const cols = sheet.header.columns;
  const ev = evaluateSheet(sheet, { budget: LIMITS.sheetEvalBrowserBudget });
  const changed = new Set<number>();
  const baseSheet = base === null ? null : parsed(base);
  if (baseSheet) {
    const d = diffLines(rowLines(baseSheet), rowLines(sheet), LIMITS.maxSheetRows * 2);
    if (d) for (const h of d.hunks) for (let i = h.bStart; i < h.bEnd; i++) changed.add(i);
    else for (let i = 0; i < sheet.rows.length; i++) changed.add(i);
  }
  const shown = Math.min(sheet.rows.length, REVIEW_MAX_ROWS);
  const rows: ReviewRow[] = [];
  for (let i = 0; i < shown; i++) {
    const n = i + 2;
    const raw = sheet.rows[i] ?? [];
    const cells: ReviewCell[] = cols.map((col, c) => {
      const d = displayValue(ev.value(n, c), col);
      const typed = raw[c];
      return {
        text: d.kind === "check" ? `${d.text} ${d.label}` : d.text,
        number: d.kind === "number",
        ...(isFormula(typed) ? { title: typed } : {}),
      };
    });
    rows.push({ n, cells, changed: changed.has(i) });
  }
  return {
    columns: cols.map((c, i) => `${colLetter(i)} · ${c.name}`),
    rows,
    more: sheet.rows.length - shown,
  };
}
