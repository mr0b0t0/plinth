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
import {
  a1,
  type Cell,
  colLetter,
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
const MIN_WIDTH = 40;
const MAX_WIDTH = 800;

export interface GridOptions {
  title: string;
  onDownload: (format: SheetExportFormat) => void;
  /** Some formulas were not computed within the browser's budget. */
  exhausted: boolean;
}

export interface Grid {
  el: HTMLElement;
  select(row: number, col: number): void;
  sortBy(col: number): void;
  filter(text: string): void;
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

  const freezeCell = (cell: HTMLElement, c: number) => {
    const left = lefts[c];
    if (left === undefined) return;
    cell.classList.add("plinth-sheet__frozen");
    if (c === freeze - 1) cell.classList.add("plinth-sheet__frozen--last");
    cell.style.left = `${left}px`;
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
    headers.push(th);
    names.append(th);
  });
  thead.append(letters, names);
  table.append(thead);

  // Rows in stored order; display order changes with the sort.
  const rows: HTMLTableRowElement[] = [];
  const texts: string[][] = [];
  const values: Value[][] = [];
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
  const updateCount = () => {
    const shown = rows.filter((tr) => !tr.hidden).length;
    const all = rows.length;
    const noun = all === 1 ? "row" : "rows";
    count.textContent = filterValue.trim() ? `${shown} of ${all} ${noun}` : `${all} ${noun}`;
  };
  updateCount();

  let selected: HTMLElement | null = null;
  let sort: SortState | null = null;
  const grid: Grid = {
    el: root,
    select(row, col) {
      const cell = byAddress.get(a1(row, col));
      if (!cell) return;
      selected?.classList.remove("plinth-sheet__selected");
      selected = cell;
      cell.classList.add("plinth-sheet__selected");
      fxAddr.textContent = a1(row, col);
      fxRaw.textContent =
        row === 1 ? (cols[col]?.name ?? "") : rawText((sheet.rows[row - 2] ?? [])[col] ?? null);
    },
    sortBy(col) {
      sort = nextSort(sort, col);
      headers.forEach((h, i) => {
        h.setAttribute("aria-sort", sort && sort.col === i ? sort.dir : "none");
      });
      order = sortedOrder(rows.length, (i) => (values[i] as Value[])[col] ?? null, sort);
      layout();
    },
    filter(text) {
      filterValue = text;
      rows.forEach((tr, i) => {
        tr.hidden = !rowMatches(texts[i] as string[], text);
      });
      updateCount();
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
  // Arrow keys move between visible cells.
  table.addEventListener("keydown", (e) => {
    const td = (e.target as Element).closest?.("td") as HTMLTableCellElement | null;
    if (!td) return;
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

  root.append(bar, fx, scroll);
  if (rows.length > 0) grid.select(2, 0);
  else grid.select(1, 0);
  return grid;
}
