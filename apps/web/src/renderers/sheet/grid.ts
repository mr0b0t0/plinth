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
// with the view carried over), setHolders() marks the rows other people hold with their initials
// in the row number, the editor's Row and Column menus sit in the bar (`tools`), and the slot
// between the bar and the cells is kept for what the editor adds there.
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
const MIN_WIDTH = 40;
const MAX_WIDTH = 800;

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
  /** Rows other people hold: A1 row to the holder's email (shown as initials, named in full). */
  setHolders(rows: ReadonlyMap<number, string>): void;
  /** Cells the grid must not repaint (the one being edited). */
  setLocked(locked: (td: HTMLElement) => boolean): void;
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

/** "ana.costa-x1@example.com" -> "AC": two letters from an email's name part, for a held row. */
export function initialsOf(email: string): string {
  const words = email
    .replace(/@.*$/, "")
    .split(/[\s._+-]+/)
    .filter((w) => /^\p{L}/u.test(w));
  const letters =
    words.length > 1
      ? `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words[1] ?? "")[0] ?? ""}`
      : Array.from(words[0] ?? "")
          .slice(0, 2)
          .join("");
  return letters.toLocaleUpperCase() || "?";
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
  const w = typeof c.width === "number" && Number.isFinite(c.width) ? c.width : DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

/** The left offset of each frozen column (the row numbers come first). */
export function frozenOffsets(columns: readonly SheetColumn[], freeze: number): number[] {
  const out: number[] = [];
  let x = ROW_NUMBER_WIDTH;
  for (let i = 0; i < Math.min(freeze, columns.length); i++) {
    out.push(x);
    x += columnWidth(columns[i] as SheetColumn);
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
  const lefts = frozenOffsets(cols, freeze);
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
  const colgroup = el(doc, "colgroup");
  const numCol = el(doc, "col", "plinth-sheet__col-num");
  numCol.style.width = `${ROW_NUMBER_WIDTH}px`;
  colgroup.append(numCol);
  let total = ROW_NUMBER_WIDTH;
  for (const c of cols) {
    const col = el(doc, "col");
    const w = columnWidth(c);
    total += w;
    col.style.width = `${w}px`;
    colgroup.append(col);
  }
  table.style.width = `${total}px`;
  table.append(colgroup);

  // Each frozen cell once (a repainted cell is frozen again), and whether the frame is too narrow
  // for them to stay (set below).
  const frozenCells = new Map<HTMLElement, number>();
  let unfrozen = false;
  const freezeCell = (cell: HTMLElement, c: number) => {
    const left = lefts[c];
    if (left === undefined) return;
    cell.classList.add("plinth-sheet__frozen");
    if (c === freeze - 1) cell.classList.add("plinth-sheet__frozen--last");
    cell.style.left = unfrozen ? "" : `${left}px`;
    frozenCells.set(cell, left);
  };

  const thead = el(doc, "thead");
  const letters = el(doc, "tr", "plinth-sheet__letters");
  const corner = el(doc, "th", "plinth-sheet__corner plinth-sheet__rownum");
  corner.setAttribute("aria-hidden", "true");
  letters.append(corner);
  const names = el(doc, "tr", "plinth-sheet__names");
  const one = el(doc, "th", "plinth-sheet__rownum", "1");
  one.scope = "row";
  names.append(one);
  const headers: HTMLTableCellElement[] = [];
  // Every cell by its address, header included, for the formula bar.
  const byAddress = new Map<string, HTMLElement>();
  cols.forEach((c, i) => {
    const l = el(doc, "th", "plinth-sheet__letter", colLetter(i));
    l.setAttribute("aria-hidden", "true");
    freezeCell(l, i);
    letters.append(l);
    const th = el(doc, "th", "plinth-sheet__name");
    th.scope = "col";
    th.id = `__plinth-cell-${a1(1, i)}`;
    byAddress.set(a1(1, i), th);
    th.setAttribute("aria-sort", "none");
    freezeCell(th, i);
    const b = el(doc, "button", "plinth-sheet__sort");
    b.type = "button";
    b.append(el(doc, "span", "plinth-sheet__name-text", c.name));
    b.append(el(doc, "span", "plinth-sheet__sort-mark"));
    b.addEventListener("click", () => grid.sortBy(i));
    th.append(b);
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
      for (const k of order.slice(i, i + CHUNK_ROWS)) body.append(rows[k] as HTMLTableRowElement);
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

  let selected: HTMLElement | null = null;
  let selRow = rows.length > 0 ? 2 : 1;
  let selCol = 0;
  let sort: SortState | null = null;
  const holderTags = new Map<number, HTMLElement>();
  const resort = () => {
    order = sortedOrder(rows.length, (i) => (values[i] as Value[])[sort?.col ?? 0] ?? null, sort);
    layout();
  };
  const grid: Grid = {
    el: root,
    table,
    slot: el(doc, "div", "plinth-sheet__slot"),
    tools,
    selected: () => ({ row: selRow, col: selCol }),
    cell: (row, col) => byAddress.get(a1(row, col)) ?? null,
    select(row, col) {
      const cell = byAddress.get(a1(row, col));
      if (!cell) return;
      selected?.classList.remove("plinth-sheet__selected");
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
        if (td && c && row === 1) {
          td.replaceChildren();
          const b = el(doc, "button", "plinth-sheet__sort");
          b.type = "button";
          b.append(el(doc, "span", "plinth-sheet__name-text", c.name));
          b.append(el(doc, "span", "plinth-sheet__sort-mark"));
          b.addEventListener("click", () => grid.sortBy(col));
          td.append(b);
        }
        return;
      }
      paint(td, displayValue((values[row - 2] as Value[])[col] ?? null, c), col);
    },
    setHolders(held) {
      for (const [row, tag] of holderTags) {
        if (held.has(row)) continue;
        tag.remove();
        holderTags.delete(row);
        const tr = row === 1 ? names : rows[row - 2];
        tr?.classList.remove("plinth-sheet__row--held");
      }
      for (const [row, email] of held) {
        const tr = row === 1 ? names : rows[row - 2];
        const num = tr?.cells[0];
        if (!tr || !num) continue;
        tr.classList.add("plinth-sheet__row--held");
        let tag = holderTags.get(row);
        if (!tag) {
          tag = el(doc, "span", "plinth-sheet__holder");
          holderTags.set(row, tag);
          num.append(tag);
        }
        // Initials inside the row number; the name in full for a pointer and a screen reader.
        const said = `${personName(email)} is editing`;
        const short = el(doc, "span", undefined, initialsOf(email));
        short.setAttribute("aria-hidden", "true");
        tag.replaceChildren(short, el(doc, "span", "plinth-sheet__sr", said));
        tag.title = said;
      }
    },
    setLocked(fn) {
      locked = fn;
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

  const addressOf = (cell: Element | null): [number, number] | null => {
    const m = cell?.id ? /^__plinth-cell-([A-Z]{1,3})(\d+)$/.exec(cell.id) : null;
    if (!m) return null;
    let c = 0;
    for (const ch of m[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
    return [Number(m[2]), c - 1];
  };
  table.addEventListener("focusin", (e) => {
    const at = addressOf((e.target as Element).closest?.("td, th") ?? null);
    if (at) grid.select(at[0], at[1]);
  });
  table.addEventListener("click", (e) => {
    const td = (e.target as Element).closest?.("td");
    if (td && !(e.target as Element).closest("a")) (td as HTMLElement).focus();
  });
  // Arrow keys move between visible cells (not while a cell's own field has the keys).
  table.addEventListener("keydown", (e) => {
    const td = (e.target as Element).closest?.("td") as HTMLTableCellElement | null;
    if (!td || (e.target as Element).closest?.("input, select, textarea")) return;
    const tr = td.parentElement as HTMLTableRowElement;
    const index = td.cellIndex;
    const visible = () =>
      [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")].filter((r) => !r.hidden);
    let target: Element | null | undefined = null;
    if (e.key === "ArrowLeft") target = index > 1 ? tr.cells[index - 1] : null;
    else if (e.key === "ArrowRight") target = tr.cells[index + 1];
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const list = visible();
      const at = list.indexOf(tr);
      target = list[at + (e.key === "ArrowUp" ? -1 : 1)]?.cells[index];
    } else return;
    if (target instanceof HTMLElement) {
      e.preventDefault();
      target.focus();
    }
  });
  // The first data cell is where Tab enters the grid.
  const first = rows[0]?.cells[1];
  if (first) first.tabIndex = 0;

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
      for (const [cell, left] of frozenCells) cell.style.left = unfrozen ? "" : `${left}px`;
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
