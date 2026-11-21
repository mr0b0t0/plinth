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
// cell's address alone (__plinth-cell-B7), never from its content.
//
// On-page editing (#36, edit.ts) keeps the grid and changes what it shows: update() repaints the
// cells whose computed value changed when the rows and columns are the same (a rebuild otherwise,
// with the view carried over), setHolders() tints the rows other people hold (the holder named on
// the row number for a pointer, and in each of the row's cells' accessible description), and the
// editor's Row and Column menus sit in the bar (`tools`). In edit mode the editor also puts the
// width handle on each column header's edge (setHeaderTools) and previews a width while it changes
// (setWidth). The scroll container keeps the sticky header rows and the frozen columns out of the
// area a cell scrolls into (scroll-padding), so a cell that takes the focus or opens is never left
// under them.
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
  isError,
  isSheetLinkUrl,
  type Sheet,
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

export interface Grid {
  el: HTMLElement;
  /** The cells' table, for the editor's listeners. */
  table: HTMLTableElement;
  /** Between the bar (and its note) and the cells. */
  slot: HTMLElement;
  /** In the bar, before the filter: the editor's Row and Column menus go here. */
  tools: HTMLElement;
  /** The bar's filter field (a rebuild gives the focus back to the new one). */
  filterInput: HTMLInputElement;
  select(row: number, col: number): void;
  /** The selected cell's A1 row and column. */
  selected(): { row: number; col: number };
  /** A cell by its A1 row and column (row 1 is the header), or null. */
  cell(row: number, col: number): HTMLElement | null;
  sortBy(col: number): void;
  filter(text: string): void;
  /** The formula bar's text, while a cell is being edited. */
  showRaw(text: string): void;
  /**
   * Show `sheet` in place when it has the same columns and number of rows: only cells whose
   * value changed are repainted, and cells `locked` holds (the open editor's) are left alone.
   * False when the shape changed (the caller builds a new grid and carries the view over).
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
  restore(v: GridView): void;
}

export interface GridView {
  sort: SortState | null;
  filter: string;
  top: number;
  left: number;
  row: number;
  col: number;
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

/** The text the formula bar shows for a stored cell: exactly what the sheet holds. */
export function rawText(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return String(cell);
}

function fillCell(doc: Document, td: HTMLElement, d: Display): void {
  td.className = `plinth-sheet__cell plinth-sheet__cell--${d.kind}`;
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
    default:
      td.textContent = d.text;
  }
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
  let current = sheet;
  let locked: (td: HTMLElement) => boolean = () => false;
  const paint = (td: HTMLElement, d: Display, c: number) => {
    const sel = td.classList.contains("plinth-sheet__selected");
    td.replaceChildren();
    fillCell(doc, td, d);
    freezeCell(td, c);
    if (sel) td.classList.add("plinth-sheet__selected");
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
    for (let c = 0; c < cols.length; c++) {
      const td = el(doc, "td");
      td.id = `__plinth-cell-${a1(r, c)}`;
      byAddress.set(a1(r, c), td);
      td.tabIndex = -1;
      const v = ev.value(r, c);
      const d = displayValue(v, cols[c] as SheetColumn);
      fillCell(doc, td, d);
      freezeCell(td, c);
      rowTexts.push(d.kind === "check" ? d.label : d.text);
      rowValues.push(v);
      tr.append(td);
    }
    texts.push(rowTexts);
    values.push(rowValues);
    rows.push(tr);
  });

  let order = rows.map((_, i) => i);
  let bodies: HTMLTableSectionElement[] = [];
  const layout = () => {
    for (const b of bodies) b.remove();
    bodies = [];
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
  let sort: SortState | null = null;
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
  };
  const grid: Grid = {
    el: root,
    table,
    slot: el(doc, "div", "plinth-sheet__slot"),
    tools,
    filterInput,
    selected: () => ({ row: selRow, col: selCol }),
    cell: (row, col) => byAddress.get(a1(row, col)) ?? null,
    select(row, col) {
      const cell = byAddress.get(a1(row, col));
      if (!cell) return;
      selected?.classList.remove("plinth-sheet__selected");
      // One cell is in the tab order: the selected one.
      if (selected && selected !== cell) stop(selected).tabIndex = -1;
      stop(cell).tabIndex = 0;
      selected = cell;
      selRow = row;
      selCol = col;
      cell.classList.add("plinth-sheet__selected");
      fxAddr.textContent = a1(row, col);
      const stored = row === 1 ? null : ((current.rows[row - 2] ?? [])[col] ?? null);
      fxRaw.textContent = row === 1 ? (cols[col]?.name ?? "") : rawText(stored);
      // Monospace only for a formula, so a plain value reads as it does in the grid.
      fxRaw.classList.toggle("plinth-sheet__fx-raw--formula", isFormula(stored));
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
        for (let c = 0; c < cols.length; c++) {
          const v = nextEv.value(r, c);
          if (sameValue(v, rowValues[c] ?? null)) continue;
          rowValues[c] = v;
          const d = displayValue(v, cols[c] as SheetColumn);
          rowTexts[c] = d.kind === "check" ? d.label : d.text;
          changed = true;
          const td = byAddress.get(a1(r, c));
          if (td && !locked(td)) paint(td, d, c);
        }
      }
      if (changed) {
        applyFilter();
        updateCount();
        if (sort) resort();
      }
      grid.select(selRow, selCol);
      return true;
    },
    repaint(row, col) {
      const td = byAddress.get(a1(row, col));
      const c = cols[col];
      if (!td || !c || row < 2) {
        if (td && c && row === 1) fillHeader(td, c, col);
        return;
      }
      paint(td, displayValue((values[row - 2] as Value[])[col] ?? null, c), col);
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
    view: () => ({
      sort,
      filter: filterValue,
      top: scroll.scrollTop,
      left: scroll.scrollLeft,
      row: selRow,
      col: selCol,
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
      grid.select(Math.min(v.row, rows.length + 1), Math.min(v.col, cols.length - 1));
    },
  };
  filterInput.addEventListener("input", () => grid.filter(filterInput.value));

  /** The next row shown above or below an A1 row (1 is the header), in the order shown. */
  const nextShown = (row: number, step: -1 | 1): number | null => {
    let at = row === 1 ? -1 : order.indexOf(row - 2);
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
  table.addEventListener("focusin", (e) => {
    const at = addressOf((e.target as Element).closest?.("td, th") ?? null);
    if (!at) return;
    grid.select(at[0], at[1]);
    // After the browser's own scroll for the focus, which can leave a wide cell under the frozen
    // columns.
    queueMicrotask(() => grid.reveal(at[0], at[1]));
  });
  table.addEventListener("click", (e) => {
    const td = (e.target as Element).closest?.("td");
    if (td && !(e.target as Element).closest("a")) (td as HTMLElement).focus();
  });
  // The arrows, Home and End move between the cells shown, the header row included: not while a
  // cell's own field has the keys, and not with Alt, which the editor takes.
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
    else return;
    const cell = to ? byAddress.get(a1(to[0], to[1])) : undefined;
    if (cell) {
      e.preventDefault();
      stop(cell).focus();
    }
  });

  // Frozen columns wider than half the frame would leave a phone almost nothing to scroll, so
  // there they scroll with the rest (sheet.css, plinth-sheet--unfrozen). A grid that was replaced
  // (a live sheet whose shape changed) stops listening the next time the width crosses the line.
  const frozenWidth = freeze > 0 ? ROW_NUMBER_WIDTH + frozenWidthOf(cols, freeze) : 0;
  const narrow =
    frozenWidth > 0 ? doc.defaultView?.matchMedia?.(`(max-width: ${frozenWidth * 2}px)`) : null;
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
  root.append(grid.slot, scroll);
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
