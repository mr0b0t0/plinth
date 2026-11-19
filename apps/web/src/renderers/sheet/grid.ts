// The sheet's DOM: a toolbar (title, row count, filter, downloads), a formula bar, then the grid,
// a <table> with the column letters and the header row in a sticky <thead>, frozen columns kept
// in view by left offsets, and the data rows in <tbody> chunks of 200 that the browser skips
// laying out while they are off screen (content-visibility), so comment pins, find in page, print
// and screen readers still see every cell.
//
// Built with createElement and textContent only: no data string is ever parsed as HTML. The only
// attributes taken from data are href (a link that passes isSheetLinkUrl again here), title (an
// error's meaning, a fixed string) and a width clamped to 40 to 800 pixels. Cell ids come from the
// cell's address alone (__plinth-cell-B7), never from its content.
//
// On-page editing (#36, edit.ts) keeps the grid and changes what it shows: update() repaints the
// cells whose computed value changed when the rows and columns are the same (a rebuild otherwise,
// with the view carried over), setHolders() marks the rows other people hold with their email,
// and the edit strip (rows, columns) sits in the slot between the formula bar and the cells. In
// edit mode the editor also puts its own controls in each column header (setHeaderTools: the
// column menu button and the width handle) and previews a width while it changes (setWidth).
//
// Keyboard and screen readers: the table is a grid (role="grid", aria-rowcount, aria-colcount,
// row and column indexes, aria-readonly outside edit mode) with one cell in the tab order, the
// selected one (a roving tabindex; a header cell's stop is its sort button). The arrows, Home and
// End move among the rows shown, Ctrl+Home and Ctrl+End to the first and the last cell. Alt with
// an arrow is left to the editor (widths, row moves, menus).
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
import type { SheetExportFormat } from "./protocol.ts";
import { nextSort, rowMatches, type SortState, sortedOrder } from "./view.ts";

export const CHUNK_ROWS = 200;
export const ROW_NUMBER_WIDTH = 48;
export const DEFAULT_WIDTH = 120;
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 800;

export interface GridOptions {
  title: string;
  onDownload: (format: SheetExportFormat) => void;
  /** Some formulas were not computed within the browser's budget. */
  exhausted: boolean;
}

export interface Grid {
  el: HTMLElement;
  /** The cells' table, for the editor's listeners. */
  table: HTMLTableElement;
  /** Between the formula bar and the cells: the editor's strip goes here. */
  slot: HTMLElement;
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
  /** Rows other people hold: A1 row to the holder's email. */
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

/** A column's width in pixels, clamped. */
export function columnWidth(c: SheetColumn): number {
  return clampWidth(typeof c.width === "number" ? c.width : DEFAULT_WIDTH);
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

  // ---------- toolbar ----------
  const bar = el(doc, "div", "plinth-sheet__bar");
  const heading = el(doc, "h1", "plinth-sheet__title", opts.title || "Sheet");
  const count = el(doc, "span", "plinth-sheet__count");
  count.setAttribute("aria-live", "polite");
  const filterLabel = el(doc, "label", "plinth-sheet__filter");
  const filterText = el(doc, "span", "plinth-sheet__filter-label", "Filter");
  const filterInput = el(doc, "input", "plinth-sheet__filter-input");
  filterInput.type = "search";
  filterInput.autocomplete = "off";
  filterInput.spellcheck = false;
  filterLabel.append(filterText, filterInput);
  const downloads = el(doc, "div", "plinth-sheet__downloads");
  downloads.setAttribute("role", "group");
  downloads.setAttribute("aria-label", "Download");
  downloads.append(el(doc, "span", "plinth-sheet__downloads-label", "Download"));
  for (const [format, label, name] of [
    ["csv", "CSV", "Download as CSV"],
    ["xlsx", "Excel", "Download as Excel (.xlsx)"],
  ] as const) {
    const b = el(doc, "button", "plinth-sheet__btn", label);
    b.type = "button";
    b.setAttribute("aria-label", name);
    b.dataset.format = format;
    b.addEventListener("click", () => opts.onDownload(format));
    downloads.append(b);
  }
  bar.append(heading, count, filterLabel, downloads);
  if (opts.exhausted) {
    bar.append(
      el(
        doc,
        "p",
        "plinth-sheet__note",
        "Some formulas were not calculated in the browser (#LIMIT!): this sheet needs more steps than a page may spend. A download opened in a spreadsheet app calculates them.",
      ),
    );
  }

  // ---------- formula bar ----------
  const fx = el(doc, "div", "plinth-sheet__fx");
  fx.setAttribute("role", "group");
  fx.setAttribute("aria-label", "Selected cell");
  const fxAddr = el(doc, "span", "plinth-sheet__fx-addr");
  const fxRaw = el(doc, "span", "plinth-sheet__fx-raw");
  fx.append(fxAddr, fxRaw);

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
  const widths = cols.map(columnWidth);
  const colEls: HTMLTableColElement[] = [];
  for (const w of widths) {
    const col = el(doc, "col");
    col.style.width = `${w}px`;
    colEls.push(col);
    colgroup.append(col);
  }
  const sizeTable = () => {
    table.style.width = `${widths.reduce((t, w) => t + w, ROW_NUMBER_WIDTH)}px`;
  };
  sizeTable();
  table.append(colgroup);

  // The cells kept in view while the grid scrolls sideways, by column, so a width can move them.
  const frozen: HTMLElement[][] = cols.map(() => []);
  const freezeCell = (cell: HTMLElement, c: number, first = false) => {
    const left = lefts[c];
    if (left === undefined) return;
    cell.classList.add("plinth-sheet__frozen");
    if (c === freeze - 1) cell.classList.add("plinth-sheet__frozen--last");
    cell.style.left = `${left}px`;
    if (first) frozen[c]?.push(cell);
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
  let tools: ((col: number, column: SheetColumn) => HTMLElement[]) | null = null;
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
    wrap.append(b, ...(tools ? tools(i, c) : []));
    th.replaceChildren(wrap);
    // The column's name is the header's name, whatever controls edit mode adds to the cell.
    th.setAttribute("aria-label", c.name);
  };
  cols.forEach((c, i) => {
    const l = el(doc, "th", "plinth-sheet__letter", colLetter(i));
    freezeCell(l, i, true);
    letters.append(l);
    const th = el(doc, "th", "plinth-sheet__name");
    th.scope = "col";
    th.id = `__plinth-cell-${a1(1, i)}`;
    th.setAttribute("aria-colindex", String(i + 2));
    byAddress.set(a1(1, i), th);
    th.setAttribute("aria-sort", "none");
    freezeCell(th, i, true);
    fillHeader(th, c, i);
    if (c.type === "number" || c.type === "date") th.classList.add("plinth-sheet__name--num");
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
      freezeCell(td, c, true);
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
    count.textContent = filterValue.trim() ? `${shown} of ${all} ${noun}` : `${all} ${noun}`;
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
      fxRaw.textContent =
        row === 1 ? (cols[col]?.name ?? "") : rawText((current.rows[row - 2] ?? [])[col] ?? null);
    },
    showRaw(text) {
      fxRaw.textContent = text;
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
        tag.remove();
        doc.getElementById(`__plinth-held-${row}`)?.remove();
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
          tag = el(doc, "span", "plinth-sheet__holder");
          holderTags.set(row, tag);
          num.append(tag);
        }
        tag.textContent = `${email} is editing`;
        // Each cell of the row says so in its accessible description.
        const id = `__plinth-held-${row}`;
        let said = doc.getElementById(id);
        if (!said) {
          said = el(doc, "span");
          said.id = id;
          said.hidden = true;
          num.append(said);
        }
        said.textContent = `Being edited by ${email}`;
        for (const c of cellsOf(row)) c.setAttribute("aria-describedby", id);
      }
    },
    setLocked(fn) {
      locked = fn;
    },
    setEditable(on) {
      table.setAttribute("aria-readonly", on ? "false" : "true");
    },
    setHeaderTools(make) {
      tools = make;
      cols.forEach((c, i) => {
        const th = headers[i];
        if (th) fillHeader(th, c, i);
      });
    },
    setWidth(col, px) {
      if (col < 0 || col >= widths.length) return;
      const w = clampWidth(px);
      widths[col] = w;
      const ce = colEls[col];
      if (ce) ce.style.width = `${w}px`;
      sizeTable();
      // The frozen columns to its right move with it.
      let x = ROW_NUMBER_WIDTH;
      for (let c = 0; c < freeze; c++) {
        for (const cell of frozen[c] ?? []) cell.style.left = `${x}px`;
        x += widths[c] as number;
      }
    },
    width: (col) => widths[col] ?? DEFAULT_WIDTH,
    focusSelected() {
      if (selected) stop(selected).focus();
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
    if (at) grid.select(at[0], at[1]);
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

  root.append(bar, fx, grid.slot, scroll);
  if (rows.length > 0) grid.select(2, 0);
  else grid.select(1, 0);
  return grid;
}

/** The same computed value (an error by its code). */
function sameValue(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.error === b.error;
  return false;
}
