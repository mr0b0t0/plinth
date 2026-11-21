// The sheet's DOM: the title (for print and screen readers; the app's bar shows it on screen), one
// bar with the selected cell's address and raw text on the left and the filter on the right, then
// the grid, a <table> with the column letters and the header row in a sticky <thead>, frozen
// columns kept in view by left offsets (unless they would take more than half the frame), and the
// data rows in <tbody> chunks of 200 that the browser skips laying out while they are off screen
// (content-visibility), so comment pins, find in page, print and screen readers still see every
// cell. Downloads and print are in the app's
// artifact menu, which asks the frame (boot.ts).
//
// Built with createElement and textContent only: no data string is ever parsed as HTML. The only
// attributes taken from data are href (a link that passes isSheetLinkUrl again here), title (an
// error's meaning, a fixed string) and a width clamped to 40 to 800 pixels. Cell ids come from the
// cell's address alone (__plinth-cell-B7), never from its content. How a cell looks (its style,
// a highlight rule's colour, a coloured option's chip) is class names from fixed lists
// (cellLookClasses): a colour the parser did not accept never reaches a class.
//
// On-page editing (#36, edit.ts) keeps the grid and changes what it shows: update() repaints the
// cells whose computed value or look changed when the rows and columns are the same (a rebuild
// otherwise, with the view carried over), setHolders() tints the rows other people hold (the
// holder named on the row number for a pointer, and in each of the row's cells' accessible
// description), and the editor's menus sit in the bar (`tools`). In edit mode the editor also puts
// the width handle on each column header's edge (setHeaderTools), previews a width while it changes
// (setWidth) and puts the fill handle on the selection's corner (setFillHandle). The scroll
// container keeps the sticky header rows and the frozen columns out of the area a cell scrolls into
// (scroll-padding), so a cell that takes the focus or opens is never left under them.
//
// Selection: one cell, or a rectangle from an anchor to the selected cell in the order shown
// (Shift with an arrow, Home or End, Shift+click, or a drag), whose cells carry aria-selected and
// whose size is said to a screen reader. Copying (Ctrl or Cmd+C) puts the cells as the grid shows
// them on the clipboard as tab-separated text and an HTML table, in view and edit mode alike,
// only in the copy event a person's key or menu starts.
//
// Keyboard and screen readers: the table is a grid (role="grid", aria-rowcount, aria-colcount,
// row and column indexes, aria-readonly outside edit mode) with one cell in the tab order, the
// selected one (a roving tabindex; a header cell's stop is its sort button). The arrows, Home and
// End move among the rows shown, Ctrl+Home and Ctrl+End to the first and the last cell. Alt with
// an arrow is left to the editor (widths, row moves).
import {
  a1,
  type Cell,
  colLetter,
  highlightColor,
  isError,
  isSheetLinkUrl,
  optionColor,
  SHEET_COLORS,
  type Sheet,
  type SheetCellStyle,
  type SheetColor,
  type SheetColumn,
  type SheetEvaluation,
  type Value,
} from "@plinth/shared";
import { type Display, displayValue } from "./format.ts";
import { nextSort, rowMatches, type SortState, sortedOrder } from "./view.ts";

export const CHUNK_ROWS = 200;
export const ROW_NUMBER_WIDTH = 48;
export const DEFAULT_WIDTH = 120;
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 800;

export interface GridOptions {
  title: string;
  /** Some formulas were not computed within the browser's budget. */
  exhausted: boolean;
}

/** The selected cells: A1 rows in the order shown (1 is the header), and a span of columns. */
export interface GridRange {
  /** Rows a filter hides are left out. */
  rows: number[];
  c1: number;
  c2: number;
  anchor: { row: number; col: number };
  focus: { row: number; col: number };
}

/** What a copy carries: the text pasted elsewhere, and the cells as stored, for a paste here. */
export interface GridCopy {
  tsv: string;
  html: string;
  /** The raw cells (formulas as written), by the range's rows and columns; header row omitted. */
  cells: Cell[][];
  /** The A1 rows the raw cells came from. */
  rows: number[];
  c1: number;
}

export interface Grid {
  el: HTMLElement;
  /** The cells' table, for the editor's listeners. */
  table: HTMLTableElement;
  /** Between the bar (and its note) and the cells. */
  slot: HTMLElement;
  /** In the bar, before the filter: the editor's menus go here. */
  tools: HTMLElement;
  /** The bar's filter field (a rebuild gives the focus back to the new one). */
  filterInput: HTMLInputElement;
  /** Select one cell (the anchor moves to it). */
  select(row: number, col: number): void;
  /** Select from `anchor` to the cell given, which becomes the selected one. */
  selectRange(anchor: { row: number; col: number }, row: number, col: number): void;
  /** The selected cell's A1 row and column. */
  selected(): { row: number; col: number };
  /** The selected rectangle (one cell when nothing is extended). */
  range(): GridRange;
  /** A cell by its A1 row and column (row 1 is the header), or null. */
  cell(row: number, col: number): HTMLElement | null;
  sortBy(col: number): void;
  filter(text: string): void;
  /** The formula bar's text, while a cell is being edited. */
  showRaw(text: string): void;
  /**
   * Show `sheet` in place when it has the same columns and number of rows: only cells whose
   * value or look changed are repainted, and cells `locked` holds (the open editor's) are left
   * alone. False when the shape changed (the caller builds a new grid and carries the view over).
   */
  update(sheet: Sheet, ev: SheetEvaluation): boolean;
  /** Paint a cell again from its computed value (after its field closed). */
  repaint(row: number, col: number): void;
  /** Rows other people hold: A1 row to the holder's email (tinted, the name on the row number). */
  setHolders(rows: ReadonlyMap<number, string>): void;
  /** Cells the grid must not repaint (the one being edited). */
  setLocked(locked: (td: HTMLElement) => boolean): void;
  /** Edit mode: the grid is not read-only. */
  setEditable(on: boolean): void;
  /** The editor's controls in each column header (edit mode), or none. */
  setHeaderTools(make: ((col: number, column: SheetColumn) => HTMLElement[]) | null): void;
  /** The fill handle on the selection's corner (edit mode), with what a press on it does. */
  setFillHandle(press: ((e: PointerEvent) => void) | null): void;
  /** Mark the cells a fill would write (null: none). */
  markFill(rows: readonly number[] | null, c1?: number, c2?: number): void;
  /** Told what each copy carried (the editor pastes copied formulas as formulas). */
  setCopyListener(fn: ((c: GridCopy) => void) | null): void;
  /** Show a column `px` wide (clamped) until the next rebuild: a width while it changes. */
  setWidth(col: number, px: number): void;
  /** A column's width as shown now. */
  width(col: number): number;
  /** The focus to the selected cell (after a rebuild took it away). */
  focusSelected(): void;
  /** Scroll a cell sideways into view clear of the row numbers and frozen columns, start first. */
  reveal(row: number, col: number): void;
  /** Sort, filter, scroll and selection, to carry over to a rebuilt grid. */
  view(): GridView;
  /**
   * The next row shown above (-1) or below (1) an A1 row, in the order shown, past the rows a
   * filter hides: 1 above the first row shown, null below the last.
   */
  nextShown(row: number, step: -1 | 1): number | null;
  restore(v: GridView): void;
}

export interface GridView {
  sort: SortState | null;
  filter: string;
  top: number;
  left: number;
  row: number;
  col: number;
  /** The selection's anchor, when it spans more than one cell. */
  anchor?: { row: number; col: number };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A width in whole pixels, within 40 to 800. */
export function clampWidth(w: number): number {
  const n = Number.isFinite(w) ? w : DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

/** "ana.costa-x1@example.com" -> "Ana": a first name from an email, for short notes. */
export function personName(email: string): string {
  const first = email
    .replace(/@.*$/, "")
    .split(/[\s._+-]+/)
    .find((w) => /^\p{L}/u.test(w));
  if (!first) return email;
  const [head = "", ...rest] = Array.from(first);
  return head.toLocaleUpperCase() + rest.join("");
}

/** A column's width in pixels, clamped. */
export function columnWidth(c: SheetColumn): number {
  return clampWidth(typeof c.width === "number" ? c.width : DEFAULT_WIDTH);
}

/** The left offset of each frozen column (the row numbers come first). */
export function frozenOffsets(columns: readonly SheetColumn[], freeze: number): number[] {
  return offsetsOf(columns.map(columnWidth), freeze);
}

function offsetsOf(widths: readonly number[], freeze: number): number[] {
  const out: number[] = [];
  let x = ROW_NUMBER_WIDTH;
  for (let i = 0; i < Math.min(freeze, widths.length); i++) {
    out.push(x);
    x += widths[i] as number;
  }
  return out;
}

/** The width of the first `freeze` columns, row numbers not included. */
export function frozenWidthOf(columns: readonly SheetColumn[], freeze: number): number {
  let w = 0;
  for (let i = 0; i < Math.min(freeze, columns.length); i++)
    w += columnWidth(columns[i] as SheetColumn);
  return w;
}

/**
 * The frames too narrow to keep the first `freeze` columns in view, as a media query, or null
 * when nothing is frozen. Frozen columns wider than half the frame would leave a phone almost
 * nothing to scroll, so there they scroll with the rest (sheet.css, plinth-sheet--unfrozen).
 */
export function unfreezeQuery(columns: readonly SheetColumn[], freeze: number): string | null {
  const n = Math.min(5, freeze, columns.length);
  if (n <= 0) return null;
  return `(max-width: ${(ROW_NUMBER_WIDTH + frozenWidthOf(columns, n)) * 2}px)`;
}

/** Whether the first `freeze` columns scroll with the rest in this frame (unfreezeQuery). */
export function freezeDropped(
  view: Window | null | undefined,
  columns: readonly SheetColumn[],
  freeze: number,
): boolean {
  const query = unfreezeQuery(columns, freeze);
  return query !== null && view?.matchMedia?.(query).matches === true;
}

/** The text the formula bar shows for a stored cell: exactly what the sheet holds. */
export function rawText(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell);
}

/** How a cell looks apart from its value: its style, its highlight, its option's chip. */
export interface CellLook {
  style: SheetCellStyle | null;
  highlight: SheetColor | null;
  chip: SheetColor | null;
}

const NO_LOOK: CellLook = { style: null, highlight: null, chip: null };

/** A colour as a class name part, only when it is one of the sheet colours. */
function colorPart(c: SheetColor | null | undefined): string | null {
  return c && (SHEET_COLORS as readonly string[]).includes(c) ? c : null;
}

/**
 * The classes a cell's look adds, from fixed lists only: bold, italic, a fill or a highlight
 * colour (the highlight wins), an alignment, wrapping and the sides with a border.
 */
export function cellLookClasses(look: CellLook): string[] {
  const out: string[] = [];
  const s = look.style;
  if (s?.bold) out.push("plinth-sheet__s-bold");
  if (s?.italic) out.push("plinth-sheet__s-italic");
  const hl = colorPart(look.highlight);
  const fill = colorPart(s?.fill);
  if (hl) out.push(`plinth-sheet__hl--${hl}`);
  else if (fill) out.push(`plinth-sheet__fill--${fill}`);
  if (s?.align === "left" || s?.align === "center" || s?.align === "right") {
    out.push(`plinth-sheet__s-${s.align}`);
  }
  if (s?.wrap) out.push("plinth-sheet__s-wrap");
  if (s?.border && s.border.length > 0) {
    out.push("plinth-sheet__bd");
    for (const side of s.border) {
      if (side === "top" || side === "right" || side === "bottom" || side === "left") {
        out.push(`plinth-sheet__bd--${side}`);
      }
    }
  }
  return out;
}

function fillCell(doc: Document, td: HTMLElement, d: Display, look: CellLook = NO_LOOK): void {
  td.className = `plinth-sheet__cell plinth-sheet__cell--${d.kind}`;
  const classes = cellLookClasses(look);
  if (classes.length > 0) td.classList.add(...classes);
  switch (d.kind) {
    case "empty":
      return;
    case "link": {
      // The link rule again, in the browser: a payload that skipped the server's check stays text.
      if (!isSheetLinkUrl(d.href)) {
        td.textContent = d.text;
        return;
      }
      const a = el(doc, "a", "plinth-sheet__link", d.text);
      a.href = d.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      td.append(a);
      return;
    }
    case "check": {
      const s = el(doc, "span", "plinth-sheet__check", d.text);
      s.setAttribute("role", "img");
      s.setAttribute("aria-label", d.label);
      td.append(s);
      return;
    }
    case "error": {
      const s = el(doc, "span", "plinth-sheet__error", d.text);
      s.title = d.title;
      td.append(s);
      return;
    }
    default: {
      const chip = colorPart(look.chip);
      if (chip && d.kind === "text") {
        td.append(el(doc, "span", `plinth-sheet__chip plinth-sheet__chip--${chip}`, d.text));
        return;
      }
      td.textContent = d.text;
    }
  }
}

/** A cell's look from the sheet: the row's style for it, its column's rules and option colours. */
function lookAt(sheet: Sheet, ri: number, c: number, col: SheetColumn, v: Value): CellLook {
  const style = sheet.styles?.[ri]?.[c] ?? null;
  const highlight = col.highlight ? highlightColor(col, v) : null;
  const chip = col.type === "select" && typeof v === "string" ? optionColor(col, v) : null;
  if (!style && !highlight && !chip) return NO_LOOK;
  return { style, highlight, chip };
}

const lookKey = (l: CellLook) =>
  l === NO_LOOK ? "" : JSON.stringify([l.style, l.highlight, l.chip]);

/** A cell's text as a copy carries it: its shown text, a checkbox as TRUE or FALSE. */
function copyTextOf(d: Display): string {
  if (d.kind === "check") return d.label === "Yes" ? "TRUE" : "FALSE";
  return d.text;
}

/**
 * Text for the HTML table a copy carries (to the clipboard only, never parsed here): & < > and "
 * escaped, so a cell's text is only ever text in the app it is pasted into.
 */
export function htmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One field of tab-separated text, quoted when it holds a tab, a newline or a quote. */
export function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the sheet's page. */
export function buildGrid(
  doc: Document,
  sheet: Sheet,
  ev: SheetEvaluation,
  opts: GridOptions,
): Grid {
  const cols = sheet.header.columns;
  const freeze = Math.min(5, sheet.header.freeze?.cols ?? 0, cols.length);
  /** The widths drawn: as stored, or as previewed while one changes (setWidth). */
  const widths = cols.map(columnWidth);
  let lefts = offsetsOf(widths, freeze);
  const root = el(doc, "div", "plinth-sheet__page");

  // ---------- title and bar ----------
  const heading = el(doc, "h1", "plinth-sheet__title", opts.title || "Sheet");
  const bar = el(doc, "div", "plinth-sheet__bar");
  const fx = el(doc, "div", "plinth-sheet__fx");
  fx.setAttribute("role", "group");
  fx.setAttribute("aria-label", "Selected cell");
  const fxAddr = el(doc, "span", "plinth-sheet__fx-addr");
  const fxRaw = el(doc, "span", "plinth-sheet__fx-raw");
  fx.append(fxAddr, fxRaw);
  // Shown only while a filter is set: "3 of 40 rows".
  const count = el(doc, "span", "plinth-sheet__count");
  count.setAttribute("aria-live", "polite");
  const filterInput = el(doc, "input", "plinth-sheet__filter-input");
  filterInput.type = "search";
  filterInput.placeholder = "Filter";
  filterInput.setAttribute("aria-label", "Filter rows");
  filterInput.autocomplete = "off";
  filterInput.spellcheck = false;
  const tools = el(doc, "div", "plinth-sheet__tools");
  bar.append(fx, count, tools, filterInput);
  const note = opts.exhausted
    ? el(
        doc,
        "p",
        "plinth-sheet__note",
        "Some formulas were not calculated here (#LIMIT!). A download calculates them.",
      )
    : null;
  // A selection of more than one cell is said here ("B2 to D5 selected, 12 cells").
  const rangeSaid = el(doc, "span", "plinth-sheet__sr");
  rangeSaid.setAttribute("aria-live", "polite");
  // What a copy selects when nothing else is selected (some browsers fire no copy event then).
  const clip = el(doc, "div", "plinth-sheet__clip", " ");
  clip.setAttribute("aria-hidden", "true");

  // ---------- grid ----------
  const scroll = el(doc, "div", "plinth-sheet__scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "Sheet cells");
  const table = el(doc, "table", "plinth-sheet__grid");
  // A grid of cells the arrow keys move between, read-only until edit mode.
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", opts.title || "Sheet");
  table.setAttribute("aria-readonly", "true");
  table.setAttribute("aria-multiselectable", "true");
  table.setAttribute("aria-rowcount", String(sheet.rows.length + 1));
  table.setAttribute("aria-colcount", String(cols.length + 1));
  const colgroup = el(doc, "colgroup");
  const numCol = el(doc, "col", "plinth-sheet__col-num");
  numCol.style.width = `${ROW_NUMBER_WIDTH}px`;
  colgroup.append(numCol);
  const colEls: HTMLTableColElement[] = [];
  for (const w of widths) {
    const col = el(doc, "col");
    col.style.width = `${w}px`;
    colEls.push(col);
    colgroup.append(col);
  }
  // Each frozen cell once, by its column (a repainted cell is frozen again; a width moves the
  // frozen columns after it), and whether the frame is too narrow for them to stay (set below).
  const frozenCells = new Map<HTMLElement, number>();
  let unfrozen = false;
  /** Where the row numbers and the frozen columns end, from the scroll container's left. */
  let frozenEdge = ROW_NUMBER_WIDTH;
  const sizeTable = () => {
    table.style.width = `${widths.reduce((t, w) => t + w, ROW_NUMBER_WIDTH)}px`;
    // A cell scrolled into view (focused, opened) clears the row numbers and the frozen columns
    // (unless they scroll with the rest, below).
    frozenEdge = ROW_NUMBER_WIDTH;
    for (let c = 0; c < (unfrozen ? 0 : freeze); c++) frozenEdge += widths[c] as number;
    scroll.style.scrollPaddingLeft = `${frozenEdge}px`;
  };
  sizeTable();
  table.append(colgroup);
  /** Draw the columns at their widths again, after one changed. */
  const fitColumns = () => {
    widths.forEach((w, i) => {
      const ce = colEls[i];
      if (ce) ce.style.width = `${w}px`;
    });
    sizeTable();
    // The frozen columns to the right of a changed one move with it.
    lefts = offsetsOf(widths, freeze);
    placeFrozen();
  };

  const freezeCell = (cell: HTMLElement, c: number) => {
    const left = lefts[c];
    if (left === undefined) return;
    cell.classList.add("plinth-sheet__frozen");
    if (c === freeze - 1) cell.classList.add("plinth-sheet__frozen--last");
    cell.style.left = unfrozen ? "" : `${left}px`;
    frozenCells.set(cell, c);
  };
  const placeFrozen = () => {
    for (const [cell, c] of frozenCells) cell.style.left = unfrozen ? "" : `${lefts[c]}px`;
  };

  const thead = el(doc, "thead");
  const letters = el(doc, "tr", "plinth-sheet__letters");
  // The column letters are a visual aid: the header row names the columns.
  letters.setAttribute("aria-hidden", "true");
  const corner = el(doc, "th", "plinth-sheet__corner plinth-sheet__rownum");
  letters.append(corner);
  const names = el(doc, "tr", "plinth-sheet__names");
  names.setAttribute("aria-rowindex", "1");
  const one = el(doc, "th", "plinth-sheet__rownum", "1");
  one.scope = "row";
  one.setAttribute("aria-colindex", "1");
  names.append(one);
  const headers: HTMLTableCellElement[] = [];
  // Every cell by its address, header included, for the formula bar.
  const byAddress = new Map<string, HTMLElement>();
  let headerTools: ((col: number, column: SheetColumn) => HTMLElement[]) | null = null;
  let selected: HTMLElement | null = null;
  /** A header cell's contents: its sort button, then the editor's controls in edit mode. */
  const fillHeader = (th: HTMLElement, c: SheetColumn, i: number) => {
    const wrap = el(doc, "div", "plinth-sheet__name-wrap");
    const b = el(doc, "button", "plinth-sheet__sort");
    b.type = "button";
    b.tabIndex = th === selected ? 0 : -1;
    b.append(el(doc, "span", "plinth-sheet__name-text", c.name));
    b.append(el(doc, "span", "plinth-sheet__sort-mark"));
    b.addEventListener("click", () => grid.sortBy(i));
    wrap.append(b, ...(headerTools ? headerTools(i, c) : []));
    th.replaceChildren(wrap);
    // The column's name is the header's name, whatever controls edit mode adds to the cell.
    th.setAttribute("aria-label", c.name);
  };
  cols.forEach((c, i) => {
    const l = el(doc, "th", "plinth-sheet__letter", colLetter(i));
    freezeCell(l, i);
    letters.append(l);
    const th = el(doc, "th", "plinth-sheet__name");
    th.scope = "col";
    th.id = `__plinth-cell-${a1(1, i)}`;
    th.setAttribute("aria-colindex", String(i + 2));
    byAddress.set(a1(1, i), th);
    th.setAttribute("aria-sort", "none");
    freezeCell(th, i);
    fillHeader(th, c, i);
    if (c.type === "number" || c.type === "date") th.classList.add("plinth-sheet__name--num");
    if (c.type === "checkbox") th.classList.add("plinth-sheet__name--check");
    headers.push(th);
    names.append(th);
  });
  thead.append(letters, names);
  table.append(thead);

  // Rows in stored order; display order changes with the sort.
  const rows: HTMLTableRowElement[] = [];
  const texts: string[][] = [];
  const values: Value[][] = [];
  const looks: string[][] = [];
  let current = sheet;
  let locked: (td: HTMLElement) => boolean = () => false;
  /** The cells a range marks, and the one that carries the fill handle. */
  let marked = new Set<HTMLElement>();
  let handleCell: HTMLElement | null = null;
  let handle: HTMLElement | null = null;
  const paint = (td: HTMLElement, d: Display, c: number, look: CellLook) => {
    const sel = td.classList.contains("plinth-sheet__selected");
    const inRange = marked.has(td);
    td.replaceChildren();
    fillCell(doc, td, d, look);
    freezeCell(td, c);
    if (sel) td.classList.add("plinth-sheet__selected");
    if (inRange) td.classList.add("plinth-sheet__in-range");
    if (td === handleCell && handle) td.append(handle);
  };
  sheet.rows.forEach((_row, ri) => {
    const r = ri + 2;
    const tr = el(doc, "tr", "plinth-sheet__row");
    tr.dataset.row = String(r);
    const th = el(doc, "th", "plinth-sheet__rownum", String(r));
    th.scope = "row";
    tr.append(th);
    const rowTexts: string[] = [];
    const rowValues: Value[] = [];
    const rowLooks: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const td = el(doc, "td");
      td.id = `__plinth-cell-${a1(r, c)}`;
      byAddress.set(a1(r, c), td);
      td.tabIndex = -1;
      const col = cols[c] as SheetColumn;
      const v = ev.value(r, c);
      const d = displayValue(v, col);
      const look = lookAt(sheet, ri, c, col, v);
      fillCell(doc, td, d, look);
      freezeCell(td, c);
      rowTexts.push(d.kind === "check" ? d.label : d.text);
      rowValues.push(v);
      rowLooks.push(lookKey(look));
      tr.append(td);
    }
    texts.push(rowTexts);
    values.push(rowValues);
    looks.push(rowLooks);
    rows.push(tr);
  });

  let order = rows.map((_, i) => i);
  /** Where each stored row is shown (its index in `order`). */
  let shownAt: number[] = order.slice();
  let bodies: HTMLTableSectionElement[] = [];
  const layout = () => {
    for (const b of bodies) b.remove();
    bodies = [];
    shownAt = new Array<number>(order.length);
    order.forEach((k, i) => {
      shownAt[k] = i;
    });
    for (let i = 0; i < order.length; i += CHUNK_ROWS) {
      const body = el(doc, "tbody", "plinth-sheet__chunk");
      order.slice(i, i + CHUNK_ROWS).forEach((k, j) => {
        const tr = rows[k] as HTMLTableRowElement;
        // Where the row is shown (the header row is 1), which a sort changes.
        tr.setAttribute("aria-rowindex", String(i + j + 2));
        body.append(tr);
      });
      bodies.push(body);
      table.append(body);
    }
  };
  layout();
  scroll.append(table);

  let filterValue = "";
  const applyFilter = () => {
    rows.forEach((tr, i) => {
      tr.hidden = !rowMatches(texts[i] as string[], filterValue);
    });
  };
  const updateCount = () => {
    const shown = rows.filter((tr) => !tr.hidden).length;
    const all = rows.length;
    const noun = all === 1 ? "row" : "rows";
    count.textContent = filterValue.trim() ? `${shown} of ${all} ${noun}` : "";
  };
  updateCount();

  let selRow = rows.length > 0 ? 2 : 1;
  let selCol = 0;
  let anchorRow = selRow;
  let anchorCol = selCol;
  /** The next focus move extends the selection instead of starting a new one. */
  let extending = false;
  let sort: SortState | null = null;
  let fillPress: ((e: PointerEvent) => void) | null = null;
  let copyListener: ((c: GridCopy) => void) | null = null;
  let fillMarked: HTMLElement[] = [];
  const holderTags = new Map<number, HTMLElement>();
  /** What takes the focus for a cell: a header's sort button, or the cell itself. */
  const stop = (cell: HTMLElement): HTMLElement =>
    cell.tagName === "TH" ? (cell.querySelector<HTMLElement>(".plinth-sheet__sort") ?? cell) : cell;
  /** The cells of an A1 row (1 is the header), without its row number. */
  const cellsOf = (row: number): HTMLElement[] => {
    const tr = row === 1 ? names : rows[row - 2];
    return tr ? ([...tr.cells].slice(1) as HTMLElement[]) : [];
  };
  const resort = () => {
    order = sortedOrder(rows.length, (i) => (values[i] as Value[])[sort?.col ?? 0] ?? null, sort);
    layout();
    paintRange();
  };

  /** An A1 row's place in the order shown (the header first), or null for a row not there. */
  const placeOf = (row: number): number | null => {
    if (row === 1) return -1;
    const p = shownAt[row - 2];
    return p === undefined ? null : p;
  };
  /** The selected rows from the anchor's to the selected cell's, in the order shown. */
  const rangeRows = (): number[] => {
    const a = placeOf(anchorRow);
    const b = placeOf(selRow);
    if (a === null || b === null) return [selRow];
    const out: number[] = [];
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
      if (p === -1) {
        out.push(1);
        continue;
      }
      const k = order[p] as number;
      if (!(rows[k] as HTMLTableRowElement).hidden || k + 2 === selRow || k + 2 === anchorRow)
        out.push(k + 2);
    }
    return out;
  };
  const currentRange = (): GridRange => ({
    rows: rangeRows(),
    c1: Math.min(anchorCol, selCol),
    c2: Math.max(anchorCol, selCol),
    anchor: { row: anchorRow, col: anchorCol },
    focus: { row: selRow, col: selCol },
  });
  const isSingle = () => anchorRow === selRow && anchorCol === selCol;
  /** Mark the range's cells (one cell marks none), and put the fill handle on its corner. */
  function paintRange(say = false): void {
    const next = new Set<HTMLElement>();
    const r = currentRange();
    if (!isSingle()) {
      for (const row of r.rows) {
        for (let c = r.c1; c <= r.c2; c++) {
          const td = byAddress.get(a1(row, c));
          if (td) next.add(td);
        }
      }
    }
    for (const td of marked) {
      if (next.has(td)) continue;
      td.classList.remove("plinth-sheet__in-range");
      td.removeAttribute("aria-selected");
    }
    for (const td of next) {
      if (marked.has(td)) continue;
      td.classList.add("plinth-sheet__in-range");
      td.setAttribute("aria-selected", "true");
    }
    marked = next;
    const last = r.rows[r.rows.length - 1] ?? selRow;
    const cornerCell = last > 1 ? (byAddress.get(a1(last, r.c2)) ?? null) : null;
    if (handleCell !== cornerCell || !fillPress) {
      handle?.remove();
      handleCell = fillPress ? cornerCell : null;
    }
    if (handleCell && fillPress && !locked(handleCell)) {
      handle ??= makeHandle();
      if (handle.parentNode !== handleCell) handleCell.append(handle);
    }
    const n = r.rows.length * (r.c2 - r.c1 + 1);
    fxAddr.textContent = isSingle()
      ? a1(selRow, selCol)
      : `${a1(r.rows[0] ?? selRow, r.c1)}:${a1(last, r.c2)}`;
    if (say && !isSingle()) {
      rangeSaid.textContent = `${a1(r.rows[0] ?? selRow, r.c1)} to ${a1(last, r.c2)} selected, ${n} cells`;
    }
  }
  function makeHandle(): HTMLElement {
    const h = el(doc, "span", "plinth-sheet__fill-handle");
    // Pointer only: Ctrl or Cmd+D fills down from the keyboard.
    h.setAttribute("aria-hidden", "true");
    h.addEventListener("pointerdown", (e) => fillPress?.(e));
    return h;
  }

  /** The selection's cells as text, an HTML table and the stored cells. */
  const copyOf = (): GridCopy => {
    const r = currentRange();
    const lines: string[] = [];
    const html: string[] = [];
    const cells: Cell[][] = [];
    const dataRows: number[] = [];
    for (const row of r.rows) {
      const fields: string[] = [];
      const tags: string[] = [];
      const raw: Cell[] = [];
      const tag = row === 1 ? "th" : "td";
      for (let c = r.c1; c <= r.c2; c++) {
        let text: string;
        if (row === 1) text = cols[c]?.name ?? "";
        else {
          const col = cols[c] as SheetColumn;
          text = copyTextOf(displayValue((values[row - 2] as Value[])[c] ?? null, col));
          raw.push((current.rows[row - 2] ?? [])[c] ?? null);
        }
        fields.push(tsvField(text));
        tags.push(`<${tag}>${htmlText(text)}</${tag}>`);
      }
      if (row > 1) {
        cells.push(raw);
        dataRows.push(row);
      }
      lines.push(fields.join("\t"));
      html.push(`<tr>${tags.join("")}</tr>`);
    }
    return {
      tsv: lines.join("\n"),
      html: `<table>${html.join("")}</table>`,
      cells,
      rows: dataRows,
      c1: r.c1,
    };
  };

  const grid: Grid = {
    el: root,
    table,
    slot: el(doc, "div", "plinth-sheet__slot"),
    tools,
    filterInput,
    selected: () => ({ row: selRow, col: selCol }),
    range: currentRange,
    cell: (row, col) => byAddress.get(a1(row, col)) ?? null,
    select(row, col) {
      grid.selectRange({ row, col }, row, col);
    },
    selectRange(anchor, row, col) {
      const cell = byAddress.get(a1(row, col));
      if (!cell) return;
      selected?.classList.remove("plinth-sheet__selected");
      // One cell is in the tab order: the selected one.
      if (selected && selected !== cell) stop(selected).tabIndex = -1;
      stop(cell).tabIndex = 0;
      selected = cell;
      selRow = row;
      selCol = col;
      const a = byAddress.get(a1(anchor.row, anchor.col));
      anchorRow = a ? anchor.row : row;
      anchorCol = a ? anchor.col : col;
      cell.classList.add("plinth-sheet__selected");
      const stored = row === 1 ? null : ((current.rows[row - 2] ?? [])[col] ?? null);
      fxRaw.textContent = row === 1 ? (cols[col]?.name ?? "") : rawText(stored);
      // Monospace only for a formula, so a plain value reads as it does in the grid.
      fxRaw.classList.toggle("plinth-sheet__fx-raw--formula", isFormula(stored));
      paintRange();
    },
    showRaw(text) {
      fxRaw.textContent = text;
      fxRaw.classList.toggle("plinth-sheet__fx-raw--formula", isFormula(text));
    },
    sortBy(col) {
      sort = nextSort(sort, col);
      headers.forEach((h, i) => {
        h.setAttribute("aria-sort", sort && sort.col === i ? sort.dir : "none");
      });
      resort();
    },
    filter(text) {
      filterValue = text;
      applyFilter();
      updateCount();
      paintRange();
    },
    update(next, nextEv) {
      if (
        next.rows.length !== rows.length ||
        JSON.stringify(next.header) !== JSON.stringify(current.header)
      ) {
        return false;
      }
      current = next;
      let changed = false;
      for (let ri = 0; ri < rows.length; ri++) {
        const r = ri + 2;
        const rowValues = values[ri] as Value[];
        const rowTexts = texts[ri] as string[];
        const rowLooks = looks[ri] as string[];
        for (let c = 0; c < cols.length; c++) {
          const col = cols[c] as SheetColumn;
          const v = nextEv.value(r, c);
          const look = lookAt(next, ri, c, col, v);
          const key = lookKey(look);
          const same = sameValue(v, rowValues[c] ?? null);
          if (same && key === rowLooks[c]) continue;
          rowValues[c] = v;
          rowLooks[c] = key;
          const d = displayValue(v, col);
          rowTexts[c] = d.kind === "check" ? d.label : d.text;
          if (!same) changed = true;
          const td = byAddress.get(a1(r, c));
          if (td && !locked(td)) paint(td, d, c, look);
        }
      }
      if (changed) {
        applyFilter();
        updateCount();
        if (sort) resort();
      }
      grid.selectRange({ row: anchorRow, col: anchorCol }, selRow, selCol);
      return true;
    },
    repaint(row, col) {
      const td = byAddress.get(a1(row, col));
      const c = cols[col];
      if (!td || !c || row < 2) {
        if (td && c && row === 1) fillHeader(td, c, col);
        return;
      }
      const v = (values[row - 2] as Value[])[col] ?? null;
      paint(td, displayValue(v, c), col, lookAt(current, row - 2, col, c, v));
      paintRange();
    },
    setHolders(held) {
      for (const [row, tag] of holderTags) {
        if (held.has(row)) continue;
        tag.parentElement?.removeAttribute("title");
        tag.remove();
        holderTags.delete(row);
        const tr = row === 1 ? names : rows[row - 2];
        tr?.classList.remove("plinth-sheet__row--held");
        for (const c of cellsOf(row)) c.removeAttribute("aria-describedby");
      }
      for (const [row, email] of held) {
        const tr = row === 1 ? names : rows[row - 2];
        const num = tr?.cells[0];
        if (!tr || !num) continue;
        tr.classList.add("plinth-sheet__row--held");
        let tag = holderTags.get(row);
        if (!tag) {
          tag = el(doc, "span", "plinth-sheet__holder plinth-sheet__sr");
          tag.id = `__plinth-held-${row}`;
          holderTags.set(row, tag);
          num.append(tag);
        }
        // The tint is the one cue on screen; the row number names the holder for a pointer and a
        // screen reader (the edit bar lists who is editing).
        const name = personName(email);
        tag.textContent = `${name} is editing`;
        num.title = `${name} is editing`;
        // Each cell of the row says so too, in its accessible description.
        for (const c of cellsOf(row)) c.setAttribute("aria-describedby", tag.id);
      }
    },
    setLocked(fn) {
      locked = fn;
    },
    setEditable(on) {
      table.setAttribute("aria-readonly", on ? "false" : "true");
    },
    setHeaderTools(make) {
      headerTools = make;
      cols.forEach((c, i) => {
        const th = headers[i];
        if (th) fillHeader(th, c, i);
      });
    },
    setFillHandle(press) {
      fillPress = press;
      paintRange();
    },
    markFill(list, c1 = 0, c2 = 0) {
      for (const td of fillMarked) td.classList.remove("plinth-sheet__fill-target");
      fillMarked = [];
      for (const row of list ?? []) {
        for (let c = c1; c <= c2; c++) {
          const td = byAddress.get(a1(row, c));
          if (!td) continue;
          td.classList.add("plinth-sheet__fill-target");
          fillMarked.push(td);
        }
      }
    },
    setCopyListener(fn) {
      copyListener = fn;
    },
    setWidth(col, px) {
      if (col < 0 || col >= widths.length) return;
      widths[col] = clampWidth(px);
      fitColumns();
    },
    width: (col) => widths[col] ?? DEFAULT_WIDTH,
    focusSelected() {
      if (selected) stop(selected).focus();
    },
    reveal(row, col) {
      const cell = byAddress.get(a1(row, col));
      // A frozen column is always in view (unless the frozen columns scroll with the rest).
      if (!cell || (col < freeze && !unfrozen)) return;
      const box = scroll.getBoundingClientRect();
      const r = cell.getBoundingClientRect();
      const left = r.left - box.left;
      const right = r.right - box.left;
      const width = scroll.clientWidth;
      if (left < frozenEdge) scroll.scrollLeft -= frozenEdge - left;
      else if (right > width) scroll.scrollLeft += Math.min(right - width, left - frozenEdge);
    },
    nextShown: (row, step) => nextShown(row, step),
    view: () => ({
      sort,
      filter: filterValue,
      top: scroll.scrollTop,
      left: scroll.scrollLeft,
      row: selRow,
      col: selCol,
      ...(isSingle() ? {} : { anchor: { row: anchorRow, col: anchorCol } }),
    }),
    restore(v) {
      if (v.sort && v.sort.col < cols.length) {
        sort = v.sort;
        headers.forEach((h, i) => {
          h.setAttribute("aria-sort", sort && sort.col === i ? sort.dir : "none");
        });
        resort();
      }
      if (v.filter) {
        filterInput.value = v.filter;
        grid.filter(v.filter);
      }
      scroll.scrollTop = v.top;
      scroll.scrollLeft = v.left;
      const row = Math.min(v.row, rows.length + 1);
      const col = Math.min(v.col, cols.length - 1);
      const anchor = v.anchor
        ? {
            row: Math.min(v.anchor.row, rows.length + 1),
            col: Math.min(v.anchor.col, cols.length - 1),
          }
        : { row, col };
      grid.selectRange(anchor, row, col);
    },
  };
  filterInput.addEventListener("input", () => grid.filter(filterInput.value));

  /** The next row shown above or below an A1 row (1 is the header), in the order shown. */
  const nextShown = (row: number, step: -1 | 1): number | null => {
    let at = row === 1 ? -1 : (shownAt[row - 2] ?? -2);
    if (row !== 1 && at < 0) return null;
    for (at += step; at >= 0 && at < order.length; at += step) {
      const k = order[at] as number;
      if (!(rows[k] as HTMLTableRowElement).hidden) return k + 2;
    }
    return step < 0 && row !== 1 ? 1 : null;
  };
  /** The last row shown, or the header. */
  const lastShown = (): number => {
    for (let at = order.length - 1; at >= 0; at--) {
      const k = order[at] as number;
      if (!(rows[k] as HTMLTableRowElement).hidden) return k + 2;
    }
    return 1;
  };

  const addressOf = (cell: Element | null): [number, number] | null => {
    const m = cell?.id ? /^__plinth-cell-([A-Z]{1,3})(\d+)$/.exec(cell.id) : null;
    if (!m) return null;
    let c = 0;
    for (const ch of m[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
    return [Number(m[2]), c - 1];
  };
  /** Move the focus to a cell, extending the selection to it rather than starting a new one. */
  const extendTo = (cell: HTMLElement) => {
    extending = true;
    try {
      stop(cell).focus({ preventScroll: false });
    } finally {
      extending = false;
    }
  };
  table.addEventListener("focusin", (e) => {
    const at = addressOf((e.target as Element).closest?.("td, th") ?? null);
    if (!at) return;
    if (extending) {
      grid.selectRange({ row: anchorRow, col: anchorCol }, at[0], at[1]);
      paintRange(true);
    } else grid.select(at[0], at[1]);
    // After the browser's own scroll for the focus, which can leave a wide cell under the frozen
    // columns.
    queueMicrotask(() => grid.reveal(at[0], at[1]));
  });
  table.addEventListener("click", (e) => {
    const td = (e.target as Element).closest?.("td");
    if (td && !(e.target as Element).closest("a")) (td as HTMLElement).focus();
  });
  // A press on a cell selects it (Shift: extends to it) and a drag from it extends the selection
  // over the cells it crosses; no words are selected on the way. Fields, links and buttons in a
  // cell keep their own presses.
  let dragging = false;
  const endDrag = () => {
    dragging = false;
    root.classList.remove("plinth-sheet--dragging");
    doc.removeEventListener("mouseup", endDrag, true);
  };
  table.addEventListener("mousedown", (e) => {
    const t = e.target as Element;
    if (e.button !== 0 || t.closest?.("input, select, textarea, a, button, .plinth-sheet__tool")) {
      return;
    }
    if (t.closest?.(".plinth-sheet__fill-handle")) return;
    const td = t.closest?.("td") as HTMLElement | null;
    if (!td || !addressOf(td)) return;
    if (e.shiftKey) {
      // The cells between the two are selected, not the words.
      e.preventDefault();
      extendTo(td);
      return;
    }
    // The press focuses the cell as it always has; a cell's words are never selected (sheet.css).
    dragging = true;
    root.classList.add("plinth-sheet--dragging");
    doc.addEventListener("mouseup", endDrag, true);
  });
  table.addEventListener("mouseover", (e) => {
    if (!dragging) return;
    if (((e as MouseEvent).buttons & 1) === 0) {
      endDrag();
      return;
    }
    const td = (e.target as Element).closest?.("td") as HTMLElement | null;
    if (td && td !== selected && addressOf(td)) extendTo(td);
  });
  // The arrows, Home and End move between the cells shown, the header row included: not while a
  // cell's own field has the keys, and not with Alt, which the editor takes. With Shift they
  // extend the selection.
  table.addEventListener("keydown", (e) => {
    const t = e.target as Element;
    if (e.altKey || t.closest?.("input, select, textarea")) return;
    const at = addressOf(t.closest?.("td, th.plinth-sheet__name") ?? null);
    if (!at) return;
    const [row, col] = at;
    const ctrl = e.ctrlKey || e.metaKey;
    const last = cols.length - 1;
    let to: [number, number] | null = null;
    if (e.key === "ArrowLeft") to = col > 0 ? [row, col - 1] : null;
    else if (e.key === "ArrowRight") to = col < last ? [row, col + 1] : null;
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const r = nextShown(row, e.key === "ArrowUp" ? -1 : 1);
      to = r === null ? null : [r, col];
    } else if (e.key === "Home") to = ctrl ? [1, 0] : [row, 0];
    else if (e.key === "End") to = ctrl ? [lastShown(), last] : [row, last];
    else if (e.key === "Escape" && !isSingle()) {
      // Escape drops a selection of several cells first.
      e.preventDefault();
      grid.select(row, col);
      return;
    } else return;
    const cell = to ? byAddress.get(a1(to[0], to[1])) : undefined;
    if (cell) {
      e.preventDefault();
      if (e.shiftKey) extendTo(cell);
      else stop(cell).focus();
    } else if (e.shiftKey) e.preventDefault();
  });

  // Copy: the selected cells, whenever the focus is on one of them and no field is open there.
  const copyHere = (): boolean => {
    const a = doc.activeElement;
    return !!a && table.contains(a) && !a.closest?.("input, select, textarea");
  };
  root.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "c" || !copyHere()) return;
    // A browser that fires no copy event without a selection gets one, off screen; the event
    // below puts the cells on the clipboard instead of it.
    const sel = doc.getSelection?.();
    if (sel?.isCollapsed) {
      const r = doc.createRange();
      r.selectNodeContents(clip);
      sel.removeAllRanges();
      sel.addRange(r);
      setTimeout(() => {
        if (sel.rangeCount > 0 && sel.getRangeAt(0).startContainer === clip) sel.removeAllRanges();
      }, 0);
    }
  });
  // The event starts at the focused cell or at the selection made above, both inside the page.
  root.addEventListener("copy", (e) => {
    if (!copyHere() || !e.clipboardData) return;
    const c = copyOf();
    e.clipboardData.setData("text/plain", c.tsv);
    e.clipboardData.setData("text/html", c.html);
    e.preventDefault();
    copyListener?.(c);
  });

  // Frozen columns wider than half the frame scroll with the rest (unfreezeQuery). A grid that
  // was replaced (a live sheet whose shape changed) stops listening the next time the width
  // crosses the line.
  const query = unfreezeQuery(cols, freeze);
  const narrow = query ? doc.defaultView?.matchMedia?.(query) : null;
  if (narrow) {
    let applied = false;
    const apply = () => {
      if (applied && !root.isConnected) {
        narrow.removeEventListener?.("change", apply);
        return;
      }
      applied = true;
      unfrozen = narrow.matches;
      root.classList.toggle("plinth-sheet--unfrozen", unfrozen);
      placeFrozen();
      sizeTable();
    };
    apply();
    narrow.addEventListener?.("change", apply);
  }

  root.append(heading, bar);
  if (note) root.append(note);
  root.append(grid.slot, scroll, rangeSaid, clip);
  if (rows.length > 0) grid.select(2, 0);
  else grid.select(1, 0);
  return grid;
}

/** Stored text that is a formula (the formula bar shows it in monospace). */
function isFormula(v: Cell | string): boolean {
  return typeof v === "string" && v.startsWith("=");
}

/** The same computed value (an error by its code). */
function sameValue(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.error === b.error;
  return false;
}
