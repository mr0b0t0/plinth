// The whole-draft review of a sheet (#36). A sheet's live draft is never merged with a version
// published meanwhile: the editors see the draft and that version whole, side by side, and choose
// one. This module is pure (no DOM): what each side shows as a grid (with the cells changed since
// the draft's base marked), and the plain-language lists of what each side changed ("B7: 12 → 14",
// "Row 10 removed (Pears)"); the review shows only the changes its grids cannot.
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
  /** Changed since the base (or in a row added since). */
  changed: boolean;
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
  /** Per column: added or renamed since the base. */
  columnsChanged: boolean[];
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

/** A change in plain words, and whether the review's grid shows it (a cell, a row added). */
interface Change {
  text: string;
  inGrid: boolean;
}

function headerChanges(before: SheetHeader, after: SheetHeader, out: Change[]): void {
  const start = out.length;
  const b = before.columns;
  const a = after.columns;
  if (b.length === a.length) {
    for (let i = 0; i < a.length; i++) {
      const x = b[i] as SheetColumn;
      const y = a[i] as SheetColumn;
      if (sameColumn(x, y)) continue;
      const L = colLetter(i);
      if (x.name !== y.name)
        out.push({ text: `Column ${L} renamed: ${x.name} → ${y.name}`, inGrid: true });
      if (x.type !== y.type)
        out.push({ text: `Column ${L} (${y.name}): type changed to ${y.type}`, inGrid: false });
      if (x.name === y.name && x.type === y.type)
        out.push({ text: `Column ${L} (${y.name}): settings changed`, inGrid: false });
    }
  } else {
    // Columns added or removed: named by what is left over on each side.
    const left = b.map((c) => c.name);
    for (const c of a) {
      const k = left.indexOf(c.name);
      if (k >= 0) left.splice(k, 1);
      else out.push({ text: `Column added: ${c.name}`, inGrid: true });
    }
    for (const name of left) out.push({ text: `Column removed: ${name}`, inGrid: false });
    if (out.length === start) out.push({ text: "Columns changed", inGrid: false });
  }
  if ((before.freeze?.cols ?? 0) !== (after.freeze?.cols ?? 0)) {
    out.push({
      text: `Frozen columns: ${before.freeze?.cols ?? 0} → ${after.freeze?.cols ?? 0}`,
      inGrid: false,
    });
  }
}

/**
 * What changed from `before` to `after` (two sheets' JSON lines), in plain words: columns first,
 * then rows in order. A row changed in place lists its cells ("B7: 12 → 14") when the columns
 * kept their count; rows inserted or deleted are listed as added or removed.
 */
export function describeSheetChanges(before: string, after: string): ChangeList {
  return listOf(changes(before, after).map((c) => c.text));
}

/**
 * The changes the review's grid of `after` cannot show (rows and columns removed, a column's type
 * or settings, frozen columns), in plain words; cells changed and rows added are marked in the
 * grid instead.
 */
export function offGridChanges(before: string, after: string): ChangeList {
  return listOf(
    changes(before, after)
      .filter((c) => !c.inGrid)
      .map((c) => c.text),
  );
}

function listOf(out: string[]): ChangeList {
  return {
    items: out.slice(0, CHANGE_LIST_MAX),
    more: Math.max(0, out.length - CHANGE_LIST_MAX),
  };
}

function changes(before: string, after: string): Change[] {
  if (before === after) return [];
  const x = parsed(before);
  const y = parsed(after);
  if (!x || !y) return [{ text: "The sheet changed", inGrid: false }];
  const out: Change[] = [];
  headerChanges(x.header, y.header, out);
  const sameCount = x.header.columns.length === y.header.columns.length;
  const diff = diffLines(rowLines(x), rowLines(y), LIMITS.maxSheetRows * 2);
  if (!diff) out.push({ text: "Most rows changed", inGrid: true });
  for (const h of diff?.hunks ?? []) {
    const del = h.aEnd - h.aStart;
    const ins = h.bEnd - h.bStart;
    if (del === ins) {
      for (let k = 0; k < del; k++) {
        const r = h.bStart + k + 2;
        const was = x.rows[h.aStart + k] ?? [];
        const now = y.rows[h.bStart + k] ?? [];
        if (!sameCount) {
          out.push({ text: `Row ${r} changed`, inGrid: true });
          continue;
        }
        const width = Math.max(was.length, now.length);
        for (let c = 0; c < width; c++) {
          if (JSON.stringify(was[c] ?? null) === JSON.stringify(now[c] ?? null)) continue;
          const col = y.header.columns[c];
          out.push({
            text: `${a1(r, c)}: ${cellWords(was[c], col)} → ${cellWords(now[c], col)}`,
            inGrid: true,
          });
        }
      }
      continue;
    }
    for (let k = 0; k < del; k++) {
      out.push({
        text: `Row ${h.aStart + k + 2} removed${rowName(x.rows[h.aStart + k], x.header)}`,
        inGrid: false,
      });
    }
    for (let k = 0; k < ins; k++) {
      out.push({
        text: `Row ${h.bStart + k + 2} added${rowName(y.rows[h.bStart + k], y.header)}`,
        inGrid: true,
      });
    }
  }
  return out;
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
 * The columns both sides of the review show: the first (a row's name, mostly) and every column a
 * cell or name changed in on either side, so the changes are in view without scrolling across.
 * Null (every column) when the sides differ in columns, nothing changed in a cell, or every column
 * would be kept anyway.
 */
export function changedColumns(a: ReviewGrid | null, b: ReviewGrid | null): number[] | null {
  if (!a || !b || a.columns.length !== b.columns.length) return null;
  const keep = new Set<number>();
  for (const g of [a, b]) {
    g.columnsChanged.forEach((c, i) => {
      if (c) keep.add(i);
    });
    for (const r of g.rows) {
      r.cells.forEach((c, i) => {
        if (c.changed) keep.add(i);
      });
    }
  }
  if (keep.size === 0) return null;
  keep.add(0);
  if (keep.size >= a.columns.length) return null;
  return [...keep].sort((x, y) => x - y);
}

/** `grid` with only the columns `keep` names (their labels keep their letters). */
export function onlyColumns(grid: ReviewGrid | null, keep: number[] | null): ReviewGrid | null {
  if (!grid || !keep) return grid;
  return {
    ...grid,
    columns: keep.map((i) => grid.columns[i] ?? ""),
    columnsChanged: keep.map((i) => grid.columnsChanged[i] ?? false),
    rows: grid.rows.map((r) => ({
      ...r,
      cells: keep.map((i) => r.cells[i] ?? { text: "", number: false, changed: false }),
    })),
  };
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
  // Rows changed since the base: null marks the whole row, a set only those cells.
  const changed = new Map<number, Set<number> | null>();
  const baseSheet = base === null ? null : parsed(base);
  const sameCount = baseSheet?.header.columns.length === cols.length;
  if (baseSheet) {
    const d = diffLines(rowLines(baseSheet), rowLines(sheet), LIMITS.maxSheetRows * 2);
    for (const h of d?.hunks ?? []) {
      const inPlace = sameCount && h.aEnd - h.aStart === h.bEnd - h.bStart;
      for (let i = h.bStart; i < h.bEnd; i++) {
        if (!inPlace) {
          changed.set(i, null);
          continue;
        }
        const was = baseSheet.rows[h.aStart + (i - h.bStart)] ?? [];
        const now = sheet.rows[i] ?? [];
        const cells = new Set<number>();
        for (let c = 0; c < Math.max(was.length, now.length); c++) {
          if (JSON.stringify(was[c] ?? null) !== JSON.stringify(now[c] ?? null)) cells.add(c);
        }
        changed.set(i, cells);
      }
    }
    if (!d) for (let i = 0; i < sheet.rows.length; i++) changed.set(i, null);
  }
  const baseNames = baseSheet?.header.columns.map((c) => c.name) ?? null;
  const shown = Math.min(sheet.rows.length, REVIEW_MAX_ROWS);
  const rows: ReviewRow[] = [];
  for (let i = 0; i < shown; i++) {
    const n = i + 2;
    const raw = sheet.rows[i] ?? [];
    const marks = changed.get(i);
    const cells: ReviewCell[] = cols.map((col, c) => {
      const d = displayValue(ev.value(n, c), col);
      const typed = raw[c];
      return {
        text: d.kind === "check" ? `${d.text} ${d.label}` : d.text,
        number: d.kind === "number",
        changed: marks === null || (marks?.has(c) ?? false),
        ...(isFormula(typed) ? { title: typed } : {}),
      };
    });
    rows.push({ n, cells, changed: changed.has(i) });
  }
  return {
    columns: cols.map((c, i) => `${colLetter(i)} · ${c.name}`),
    columnsChanged: cols.map((c, i) =>
      baseNames === null
        ? false
        : sameCount
          ? baseNames[i] !== c.name
          : !baseNames.includes(c.name),
    ),
    rows,
    more: sheet.rows.length - shown,
  };
}
