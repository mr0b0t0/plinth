// On-page editing of a sheet (#36), inside the sheet renderer. The live draft is the sheet's
// canonical JSON lines: line 0 is the header (row 1), and row r is line r - 1. In edit mode Enter,
// F2, a double-click or typing opens the selected cell: the editor asks the room for a lease on
// the cell's row line, and once it is granted the cell becomes a field (<input>, a <select> for a
// select column, <input type="date"> for a date). Typing sends the whole row line, re-serialized,
// at most every 250 ms; Enter, Tab and the up and down arrows commit and move; Escape puts the row
// back as it was. A checkbox toggles with Enter, Space or a double-click; Delete clears a cell;
// pasting tab-separated text writes the rows it covers. Rows other people hold show their email.
//
// Rows and columns: the edit strip, a row's menu (from its number, or Alt+Down in a cell) and a
// column's menu (its header's button, or Alt+Down in the header) insert, delete and move them with
// a `struct` frame, which the room applies only while nobody else holds a lease; Alt+Shift+Up and
// Down move the selected row. Everything else about a column goes through a lease on the header
// line, re-serialized: the column settings (name, type, number format with its decimals, currency
// and thousands separators, width, and a select column's options as a list to add to, rename,
// reorder and remove from), its width by dragging the header's edge or with Alt+Left and
// Alt+Right (8 px a step, 40 to 800), and "Freeze up to this column" or "Unfreeze". Renaming an
// option that cells hold also renames it in those cells, in one change of the whole sheet. Every
// line this sends is checked first with the same rules the room applies (checkRow, the header
// rules), so a refused value never leaves the frame and the room's draft is always a valid sheet.
//
// At phone width an open cell's field is not in the cell: it is docked at the bottom of the page
// with the column's name and a Done button, and the menus and the settings are full-width sheets.
//
// Two backends, as for docs: the room's socket (../common/live.ts, "room" mode) or a local copy of
// the lines that only this frame edits (LocalSheet, "solo" mode). Everything is built with
// createElement and filled through .value and textContent; no data is parsed as HTML.
import {
  a1,
  applyLineEdit,
  applySheetStruct,
  blockLines,
  type Cell,
  checkRow,
  colLetter,
  joinLines,
  LIMITS,
  type LineRange,
  liveRules,
  rangesOverlap,
  SHEET_COLUMN_TYPES,
  type SheetColumn,
  type SheetColumnType,
  type SheetHeader,
  type SheetNumberFormat,
  type SheetStructOp,
  serializeSheet,
  sheetHeaderLine,
  splitLines,
  trimRow,
} from "@plinth/shared";
import {
  type ClientLease,
  type LeaseDenial,
  type LeaseLoss,
  type LiveBackend,
  locateBlock,
} from "../common/live.ts";
import { clampWidth, columnWidth, type Grid } from "./grid.ts";
import { cellFromInput, inputText, type NumberLocale, numberLocale, parseTsv } from "./input.ts";

export const EDIT_DEBOUNCE_MS = 250;
/** Alt+Left and Alt+Right change a width by this much; it is sent once the keys rest. */
export const WIDTH_STEP = 8;
export const WIDTH_DEBOUNCE_MS = 400;
/** At most this many columns stay in view (the header's `freeze`). */
export const MAX_FROZEN = 5;
/** A select column lists at most this many options, each at most this long. */
export const MAX_OPTIONS = 100;
export const MAX_OPTION_CHARS = 100;
/** Below this width (the frame's), an open cell's field docks at the bottom of the page. */
export const DOCK_QUERY = "(max-width: 640px)";
const STALE_RETRIES = 3;
const RULES = liveRules("sheet");

/** The live draft of a sheet: a LiveBackend that also takes rows and columns. */
export interface SheetBackend extends LiveBackend {
  struct(op: SheetStructOp): boolean;
}

/** The lines only this frame edits (solo mode): every lease is granted and applied at once. */
export class LocalSheet implements SheetBackend {
  lines: string[];
  readonly ready = true;
  readonly connected = true;
  readonly settled = true;
  mine: ClientLease | null = null;
  readonly leases = new Map<string, ClientLease>();
  readonly you = { id: "local", email: "", right: "write" as const };
  readonly conflictVersion = null;
  ackedText: string | null = null;
  readonly durableText = null;
  private n = 0;

  constructor(
    readonly baseText: string,
    private readonly events: {
      granted(l: ClientLease): void;
      changed(): void;
      structLanded?(op: SheetStructOp): void;
    },
  ) {
    this.lines = splitLines(baseText);
  }

  get text(): string {
    return joinLines(this.lines);
  }

  get dirty(): boolean {
    return this.text !== this.baseText;
  }

  lease(range: LineRange): boolean {
    this.mine = { id: `local${++this.n}`, ...range, by: "", holder: "local", at: Date.now() };
    this.ackedText = joinLines(this.lines.slice(range.start, range.end));
    this.events.granted(this.mine);
    return true;
  }

  edit(text: string): boolean {
    const l = this.mine;
    if (!l || !RULES) return false;
    const ins = blockLines(text);
    if (RULES.checkEdit(this.lines, l.start, l.end - l.start, ins)) return false;
    const next = applyLineEdit(this.lines, l.start, l.end - l.start, ins);
    if (RULES.tooLarge(joinLines(next))) return false;
    this.lines = next;
    this.mine = { ...l, end: l.start + ins.length, at: Date.now() };
    this.ackedText = text;
    this.events.changed();
    return true;
  }

  release(): void {
    this.mine = null;
    this.events.changed();
  }

  takeover(): boolean {
    return false;
  }

  struct(op: SheetStructOp): boolean {
    const next = applySheetStruct(this.lines, op);
    if (!next || !RULES) return false;
    const text = joinLines(next);
    if (RULES.tooLarge(text) || !RULES.valid(text)) return false;
    this.mine = null;
    this.lines = next;
    this.events.structLanded?.(op);
    this.events.changed();
    return true;
  }
}

/** The editor's hooks into the frame. */
export interface SheetEditorHooks {
  /** Ctrl/Cmd+S in the frame. */
  save(): void;
  /** Something the app's status line shows changed. */
  status(): void;
  /** Show the backend's lines now (before a granted lease puts a field in a cell). */
  refresh(): void;
  /** Esc in the grid with no cell open: the app moves focus to its strip. */
  leave?(): void;
}

type Field = HTMLInputElement | HTMLSelectElement;

interface Open {
  row: number;
  col: number;
  field: Field;
  td: HTMLElement;
  /** The row's line when the lease was granted: Escape puts it back. */
  original: string;
  /** The header line when it opened. */
  head: string;
  sent: boolean;
  invalid: string | null;
  /** The field is docked at the bottom of the page (phone width), not in the cell. */
  docked: boolean;
  /** A commit was refused with a notice, which goes once a value is kept. */
  refused?: boolean;
}

/** One item of a row's or a column's menu. */
interface MenuItem {
  label: string;
  run: () => void;
  /** Why it cannot be chosen now: the item stays in the menu, with this as its description. */
  off?: string;
}

/** What a granted lease is for. */
type Want =
  | {
      kind: "cell";
      row: number;
      col: number;
      /** A key typed to open the cell: the field starts with it. */
      initial?: string;
      /** The field's text to keep (a row re-taken after a reconnect or a merge). */
      keep?: string;
      /** The row's line as the room last had it, to find the row again. */
      line: string;
      /** The header line then: a row is found again only under the same columns. */
      head: string;
      tries: number;
    }
  | {
      kind: "write";
      range: LineRange;
      /** The range's lines when it was asked for, to find them again and to check on grant. */
      text: string;
      /** The header line then. */
      head: string;
      /** The lines to put in place of the lease, from the lines as they are when granted. */
      make: (lines: readonly string[], lease: LineRange) => string[] | { error: string };
      tries: number;
      /** Said in the frame's live region once the change is sent. */
      said?: string;
    };

/** A struct frame sent and not answered yet, and how to aim it again at the lines as they are. */
interface SentStruct {
  op: SheetStructOp;
  tries: number;
  /** The op for the same rows or column in `lines` now, or null when they are gone. */
  again: (lines: readonly string[]) => SheetStructOp | null;
}

/** Whether two header lines have the same columns in the same places (their names, in order). */
function sameColumns(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  const x = sheetHeaderLine(a)?.columns;
  const y = sheetHeaderLine(b)?.columns;
  return !!x && !!y && x.length === y.length && x.every((c, i) => c.name === y[i]?.name);
}

/** Where a column (its whole definition) is in a header now, nearest `near` first; -1 if gone. */
function findColumn(header: SheetHeader, was: SheetColumn, near: number): number {
  const want = JSON.stringify(was);
  if (JSON.stringify(header.columns[near]) === want) return near;
  const at = header.columns.flatMap((c, i) => (JSON.stringify(c) === want ? [i] : []));
  return at.length === 1 ? (at[0] as number) : -1;
}

/** The UTF-8 bytes of the edit frame that would carry `text` (the client refuses past the cap). */
function editFrameBytes(text: string): number {
  const frame = { t: "edit", lease: "x".repeat(32), seq: Number.MAX_SAFE_INTEGER, text };
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

/** A row line's cells, or null. */
function rowCells(line: string | undefined): Cell[] | null {
  if (line === undefined) return null;
  try {
    const v = JSON.parse(line) as unknown;
    return Array.isArray(v) ? (v as Cell[]) : null;
  } catch {
    return null;
  }
}

/** A row with one cell changed, canonical, or the reason it cannot hold it. */
export function rowWith(
  header: SheetHeader,
  line: string,
  row: number,
  col: number,
  cell: Cell,
): string | { error: string } {
  const cells = rowCells(line) ?? [];
  const next = [...cells];
  while (next.length <= col) next.push(null);
  next[col] = cell;
  return checkedRow(header, next, row);
}

/** A row's canonical line, or the first reason it cannot be in the sheet. */
function checkedRow(header: SheetHeader, cells: Cell[], row: number): string | { error: string } {
  const issue = checkRow(header, cells, row)[0];
  if (issue) return { error: issue.message };
  const line = JSON.stringify(trimRow(cells));
  if (new TextEncoder().encode(line).byteLength > LIMITS.maxSheetRowBytes) {
    return { error: `Row ${row} would be over ${LIMITS.maxSheetRowBytes / 1024} KiB` };
  }
  return line;
}

/** The header with one column changed, canonical, or the reason it cannot be. */
export function headerWith(
  header: SheetHeader,
  col: number,
  change: (c: SheetColumn) => SheetColumn,
): string | { error: string } {
  const columns = header.columns.map((c, i) => (i === col ? change({ ...c }) : c));
  const line = serializeSheet({ header: { ...header, columns }, rows: [] });
  if (!sheetHeaderLine(line)) {
    const c = columns[col] as SheetColumn;
    if (c.name.length === 0 || c.name.length > 100)
      return { error: "A column name is 1 to 100 characters" };
    if (c.type === "select" && !(c.options && c.options.length > 0)) {
      return { error: "A select column lists 1 to 100 options" };
    }
    return { error: "That column definition is not valid" };
  }
  return line;
}

/** Every row checked against a new header: the first problem, or null. */
function rowsProblem(lines: readonly string[], header: SheetHeader): string | null {
  for (let i = 1; i < lines.length; i++) {
    const cells = rowCells(lines[i]);
    if (!cells) return `Row ${i + 1} is not a row`;
    const issue = checkRow(header, cells, i + 1)[0];
    if (issue) return issue.message;
  }
  return null;
}

/** The header with its first `cols` columns frozen (0: none), canonical. */
export function headerFrozen(header: SheetHeader, cols: number): string {
  const h: SheetHeader = { columns: header.columns };
  if (cols > 0) h.freeze = { cols };
  return serializeSheet({ header: h, rows: [] });
}

/** A select column's option list as edited: each entry, and the option it was (null: added). */
export interface OptionEntry {
  from: string | null;
  value: string;
}

/**
 * The options an edited list stands for (trimmed, empty entries dropped), the options it renames
 * (old to new) and the ones it drops, or why the list cannot be a column's.
 */
export function readOptions(
  entries: readonly OptionEntry[],
  before: readonly string[],
): { options: string[]; renames: Map<string, string>; removed: string[] } | { error: string } {
  const options: string[] = [];
  const seen = new Set<string>();
  const kept = new Set<string>();
  const renames = new Map<string, string>();
  for (const e of entries) {
    const v = e.value.trim().normalize("NFC");
    if (v === "") continue;
    if (v.length > MAX_OPTION_CHARS) {
      return { error: `An option is at most ${MAX_OPTION_CHARS} characters` };
    }
    if (seen.has(v)) return { error: `The option "${v}" is listed twice` };
    seen.add(v);
    options.push(v);
    if (e.from !== null) {
      kept.add(e.from);
      if (e.from !== v) renames.set(e.from, v);
    }
  }
  if (options.length === 0 || options.length > MAX_OPTIONS) {
    return { error: `A select column lists 1 to ${MAX_OPTIONS} options` };
  }
  return { options, renames, removed: before.filter((o) => !kept.has(o)) };
}

/** The first cell of column `col` (from row 2 down) that holds one of `values`, or null. */
function firstUse(
  lines: readonly string[],
  col: number,
  values: ReadonlySet<string>,
): { at: string; value: string } | null {
  if (values.size === 0) return null;
  for (let i = 1; i < lines.length; i++) {
    const v = rowCells(lines[i])?.[col];
    if (typeof v === "string" && values.has(v)) return { at: a1(i + 1, col), value: v };
  }
  return null;
}

/** The lines with `col`'s cells renamed (old option to new), checked against `header`. */
function renamedRows(
  lines: readonly string[],
  header: SheetHeader,
  col: number,
  renames: ReadonlyMap<string, string>,
): string[] | { error: string } {
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const cells = rowCells(line);
    if (!cells) return { error: `Row ${i + 1} is not a row` };
    const v = cells[col];
    const to = typeof v === "string" ? renames.get(v) : undefined;
    if (to === undefined) {
      out.push(line);
      continue;
    }
    const next = [...cells];
    next[col] = to;
    const r = checkedRow(header, next, i + 1);
    if (typeof r !== "string") return r;
    out.push(r);
  }
  return out;
}

const isPrintable = (e: KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ";

/** A key that opens the menu of the row or the column it is pressed in. */
const isMenuKey = (e: KeyboardEvent) =>
  (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === "ArrowDown") ||
  (e.shiftKey && e.key === "F10") ||
  e.key === "ContextMenu";

export class SheetEditor {
  editing = false;
  private grid: Grid | null = null;
  private open: Open | null = null;
  private want: Want | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notice: HTMLElement | null = null;
  private strip: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private lastStruct: SentStruct | null = null;
  private readonly loc: NumberLocale;
  /** The docked field's panel (phone width), while a cell is open there. */
  private dock: HTMLElement | null = null;
  /**
   * The open row or column menu, the control that opened it, where focus goes back, and whether
   * the row or column it names is still where it was when it opened.
   */
  private menu: {
    el: HTMLElement;
    button: HTMLElement | null;
    back: HTMLElement | null;
    still: () => boolean;
  } | null = null;
  /** The frame's polite live region (row moves, widths, freezing). */
  private announcer: HTMLElement | null = null;
  /** A width changed with Alt+arrows, sent once the keys rest. */
  private widthPending: { col: number; was: SheetColumn; width: number } | null = null;
  private widthTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A row move sent: the column to select where the row lands, whether to focus it, and whether
   * the room (or the local copy) has said that this frame's move was applied.
   */
  private moving: { col: number; focus: boolean; arrived: boolean } | null = null;
  private readonly dockOpt: boolean | undefined;

  constructor(
    private readonly win: Window,
    private backend: SheetBackend,
    private readonly hooks: SheetEditorHooks,
    opts: { locale?: string; dock?: boolean } = {},
  ) {
    this.loc = numberLocale(opts.locale);
    this.dockOpt = opts.dock;
  }

  /** Phone width: an open cell's field docks at the bottom, and menus are full-width sheets. */
  private narrow(): boolean {
    if (this.dockOpt !== undefined) return this.dockOpt;
    return typeof this.win.matchMedia === "function" && this.win.matchMedia(DOCK_QUERY).matches;
  }

  get doc(): Document {
    return this.win.document;
  }

  /**
   * A cell's text or a width is waiting in the debounce, or a one-shot write waits for its lease
   * (while connected: a lease asked for on a socket that closed is never answered).
   */
  get pending(): boolean {
    return (
      this.timer !== null ||
      this.widthTimer !== null ||
      (this.want?.kind === "write" && this.backend.connected)
    );
  }

  /** The room's socket closed: a write still waiting for its lease will not be answered. */
  disconnected(): void {
    if (this.want?.kind !== "write") return;
    this.want = null;
    this.showNotice("That change was not sent. Try again in a moment.");
    this.hooks.status();
  }

  setBackend(b: SheetBackend): void {
    this.backend = b;
  }

  // ---------- the grid ----------

  /** The grid to edit: a new one after a rebuild keeps the open field and its focus. */
  attach(grid: Grid): void {
    const old = this.grid;
    if (old && old !== grid) this.listen(old, false);
    this.grid = grid;
    // A docked field leaves its cell showing the value as it is typed.
    grid.setLocked((td) => this.open?.td === td && !this.open.docked);
    if (old !== grid && this.editing) this.listen(grid, true);
    grid.setEditable(this.editing);
    grid.setHeaderTools(this.editing ? this.headerTools : null);
    if (this.editing) this.mountStrip();
    const o = this.open;
    if (o) {
      const focused = this.doc.activeElement === o.field;
      const row = this.backend.mine ? this.backend.mine.start + 1 : o.row;
      const td = grid.cell(row, o.col);
      if (td) {
        o.row = row;
        o.td = td;
        this.place(o);
        if (focused) o.field.focus();
      }
    }
    this.render();
  }

  private listen(grid: Grid, on: boolean): void {
    const t = grid.table;
    if (on) {
      t.addEventListener("keydown", this.onKey);
      t.addEventListener("dblclick", this.onDouble);
      t.addEventListener("paste", this.onPaste);
      t.addEventListener("click", this.onRowNumber);
      t.addEventListener("focusin", this.onFocus);
    } else {
      t.removeEventListener("keydown", this.onKey);
      t.removeEventListener("dblclick", this.onDouble);
      t.removeEventListener("paste", this.onPaste);
      t.removeEventListener("click", this.onRowNumber);
      t.removeEventListener("focusin", this.onFocus);
    }
  }

  /** The strip's buttons follow the selected cell. */
  private readonly onFocus = () => this.updateStrip();

  /** Who holds which rows (only in edit mode). */
  render(): void {
    const g = this.grid;
    if (!g) return;
    const held = new Map<number, string>();
    if (this.editing) {
      for (const l of this.backend.leases.values()) {
        if (l.id === this.backend.mine?.id) continue;
        for (let line = l.start; line < l.end; line++) held.set(line + 1, l.by);
      }
    }
    g.setHolders(held);
    this.updateStrip();
  }

  // ---------- edit mode ----------

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (!on) {
      // A width still waiting for the keys to rest is still sent: its lease is asked for here,
      // while edit mode is on, and granted() writes it after edit mode has ended.
      this.close(true);
      this.commitWidth();
    }
    this.editing = on;
    const g = this.grid;
    if (g) this.listen(g, on);
    g?.setEditable(on);
    g?.setHeaderTools(on ? this.headerTools : null);
    if (on) {
      this.win.addEventListener("keydown", this.onSaveKey);
      this.mountStrip();
    } else {
      this.win.removeEventListener("keydown", this.onSaveKey);
      this.strip?.remove();
      this.strip = null;
      this.closePanel();
      this.closeMenu(false);
      this.hideNotice();
      this.announcer?.remove();
      this.announcer = null;
      this.moving = null;
    }
    g?.el.classList.toggle("plinth-sheet__page--editing", on);
    this.render();
    this.hooks.status();
  }

  /** A polite announcement in the frame, of this person's own row moves, widths and freezing. */
  private announce(text: string): void {
    let el = this.announcer;
    if (!el) {
      el = this.doc.createElement("div");
      el.className = "plinth-sheet__announce";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      this.doc.body.append(el);
      this.announcer = el;
    }
    el.textContent = text;
  }

  private readonly onSaveKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.flush();
      this.hooks.save();
    }
  };

  private header(): SheetHeader | null {
    return sheetHeaderLine(this.backend.lines[0]);
  }

  private cellAt(row: number, col: number): Cell {
    if (row === 1) return this.header()?.columns[col]?.name ?? null;
    return rowCells(this.backend.lines[row - 1])?.[col] ?? null;
  }

  /** The A1 row and column of a table cell, or null. */
  private addressOf(target: EventTarget | null): { row: number; col: number } | null {
    const cell = (target as Element | null)?.closest?.("td, th");
    const m = cell?.id ? /^__plinth-cell-([A-Z]{1,3})(\d+)$/.exec(cell.id) : null;
    if (!m) return null;
    let c = 0;
    for (const ch of m[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]), col: c - 1 };
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (this.open && e.target === this.open.field) return;
    if (e.key === "Escape" && !this.open && !e.defaultPrevented) {
      this.hooks.leave?.();
      return;
    }
    const at = this.addressOf(e.target);
    if (!at) return;
    const header = at.row === 1;
    if (isMenuKey(e)) {
      e.preventDefault();
      const from = e.target as HTMLElement;
      if (header) this.columnMenu(at.col, from, null);
      else this.rowMenu(at.row, from);
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (header && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        this.nudgeWidth(at.col, e.key === "ArrowLeft" ? -WIDTH_STEP : WIDTH_STEP);
      } else if (!header && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        this.moveRow(e.key === "ArrowUp" ? -1 : 1, at.row, true);
      }
      return;
    }
    // In the header the sort button has the focus: F2 renames, Enter still sorts.
    if (header && e.key !== "F2") return;
    const col = this.header()?.columns[at.col];
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      this.activate(at.row, at.col);
    } else if (e.key === " " && col?.type === "checkbox" && !header) {
      e.preventDefault();
      this.toggle(at.row, at.col);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !header) {
      e.preventDefault();
      this.clearCell(at.row, at.col);
    } else if (isPrintable(e)) {
      e.preventDefault();
      this.openCell(at.row, at.col, e.key);
    }
  };

  private readonly onDouble = (e: MouseEvent) => {
    if (this.open?.td.contains(e.target as Node)) return;
    // The header's own controls (its menu button, its width handle) are not the cell.
    if ((e.target as Element).closest?.(".plinth-sheet__tool")) return;
    const at = this.addressOf(e.target);
    if (!at) return;
    e.preventDefault();
    this.activate(at.row, at.col);
  };

  private readonly onPaste = (e: ClipboardEvent) => {
    if (this.open) return;
    const at = this.addressOf(e.target);
    const text = e.clipboardData?.getData("text/plain");
    if (!at || text === undefined || text === "") return;
    e.preventDefault();
    this.paste(at.row, at.col, text);
  };

  /** A click on a row's number opens the row's menu. */
  private readonly onRowNumber = (e: MouseEvent) => {
    const th = (e.target as Element).closest?.("tbody th.plinth-sheet__rownum") as
      | HTMLElement
      | null
      | undefined;
    const row = Number((th?.parentElement as HTMLElement | null)?.dataset.row);
    if (!th || !Number.isInteger(row) || row < 2) return;
    this.rowMenu(row, th);
  };

  /** Enter or a double-click: a checkbox toggles, any other cell opens. */
  private activate(row: number, col: number): void {
    const c = this.header()?.columns[col];
    const v = this.cellAt(row, col);
    if (row > 1 && c?.type === "checkbox" && (v === null || typeof v === "boolean")) {
      this.toggle(row, col);
    } else this.openCell(row, col);
  }

  /** May this frame write now? Says why not. */
  private canWrite(): boolean {
    const b = this.backend;
    if (!this.editing || !b.ready) return false;
    if (b.you?.right !== "write") {
      this.showNotice("Sign in to edit this sheet.");
      return false;
    }
    if (b.conflictVersion !== null) {
      this.showNotice("Editing is paused until the changes are reviewed.");
      return false;
    }
    return true;
  }

  private heldBy(range: LineRange): ClientLease | undefined {
    const b = this.backend;
    for (const l of b.leases.values()) {
      if (l.id !== b.mine?.id && rangesOverlap(l, range)) return l;
    }
    return undefined;
  }

  private explainHeld(l: ClientLease, what: string): void {
    const idle = Date.now() - l.at >= LIMITS.liveLeaseIdleS * 1000;
    this.showNotice(
      `${l.by} is editing ${what}.`,
      idle && this.backend.you?.right === "write"
        ? {
            label: "Take over",
            run: () => {
              this.close(true);
              const row = l.start + 1;
              const sel = this.grid?.selected();
              this.want = { ...this.cellWant(row, sel?.col ?? 0), tries: 0 };
              if (this.backend.takeover(l.id)) this.hideNotice();
            },
          }
        : undefined,
    );
  }

  /** Ask for a cell's row, then open a field in it. */
  openCell(row: number, col: number, initial?: string): void {
    if (!this.canWrite()) return;
    const b = this.backend;
    const range = { start: row - 1, end: row };
    if (range.end > b.lines.length) return;
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other, row === 1 ? "the column names" : "this row");
      return;
    }
    const o = this.open;
    if (o && o.row === row && o.col === col) {
      o.field.focus();
      return;
    }
    if (o && !this.commit()) return;
    this.want = {
      ...this.cellWant(row, col),
      ...(initial !== undefined ? { initial } : {}),
      tries: 0,
    };
    if (!b.lease(range)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  /** A cell to open, with the lines it is found again by. */
  private cellWant(row: number, col: number) {
    const lines = this.backend.lines;
    return { kind: "cell" as const, row, col, line: lines[row - 1] ?? "", head: lines[0] ?? "" };
  }

  /** A one-shot change of lines under a lease: the lines are made when it is granted. */
  private write(
    range: LineRange,
    make: Extract<Want, { kind: "write" }>["make"],
    opts: { what?: string; said?: string } = {},
  ): void {
    if (!this.canWrite()) return;
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other, opts.what ?? (range.start === 0 ? "the column names" : "this row"));
      return;
    }
    if (this.open && !this.commit()) return;
    this.close(true);
    const lines = this.backend.lines;
    this.want = {
      kind: "write",
      range,
      text: joinLines(lines.slice(range.start, range.end)),
      head: lines[0] ?? "",
      make,
      tries: 0,
      ...(opts.said ? { said: opts.said } : {}),
    };
    if (!this.backend.lease(range)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  // The lines a write makes come from the lines and the header as they are when the lease is
  // granted, and its row numbers from the lease, so a row found again elsewhere is written right.

  toggle(row: number, col: number): void {
    this.write({ start: row - 1, end: row }, (lines, l) => {
      const header = sheetHeaderLine(lines[0]);
      if (!header) return { error: "The sheet changed meanwhile. Try again." };
      const v = rowCells(lines[l.start])?.[col] ?? null;
      const r = rowWith(header, lines[l.start] ?? "[]", l.start + 1, col, v !== true);
      return typeof r === "string" ? [r] : r;
    });
  }

  clearCell(row: number, col: number): void {
    if (!this.header() || this.cellAt(row, col) === null) return;
    this.write({ start: row - 1, end: row }, (lines, l) => {
      const header = sheetHeaderLine(lines[0]);
      if (!header) return { error: "The sheet changed meanwhile. Try again." };
      const r = rowWith(header, lines[l.start] ?? "[]", l.start + 1, col, null);
      return typeof r === "string" ? [r] : r;
    });
  }

  /** Tab-separated text from the selected cell on: the rows it covers, new rows past the end. */
  paste(row: number, col: number, text: string): void {
    const header = this.header();
    if (!header) return;
    if (row < 2) {
      this.showNotice("Paste into a cell below the column names.");
      return;
    }
    const block = parseTsv(text);
    const wide = block.reduce((w, r) => Math.max(w, r.length), 0);
    if (col + wide > header.columns.length) {
      this.showNotice(
        `The pasted cells reach past column ${colLetter(header.columns.length - 1)}. Add columns first.`,
      );
      return;
    }
    const lines = this.backend.lines;
    const start = row - 1;
    const range = { start, end: Math.min(start + block.length, lines.length) };
    if (lines.length - (range.end - range.start) + block.length - 1 > LIMITS.maxSheetRows) {
      this.showNotice(`A sheet holds at most ${LIMITS.maxSheetRows} rows.`);
      return;
    }
    const loc = this.loc;
    const make = (now: readonly string[], l: LineRange): string[] | { error: string } => {
      const head = sheetHeaderLine(now[0]);
      if (!head) return { error: "The sheet changed meanwhile. Try again." };
      const out: string[] = [];
      for (let k = 0; k < block.length; k++) {
        const r = l.start + 1 + k;
        const base = l.start + k < l.end ? (rowCells(now[l.start + k]) ?? []) : [];
        const cells = [...base];
        const values = block[k] as string[];
        for (let j = 0; j < values.length; j++) {
          const c = head.columns[col + j] as SheetColumn;
          const v = cellFromInput(values[j] as string, c, loc);
          if (!v.ok) return { error: `${a1(r, col + j)}: ${v.message}` };
          while (cells.length <= col + j) cells.push(null);
          cells[col + j] = v.cell;
        }
        const line = checkedRow(head, cells, r);
        if (typeof line !== "string") return line;
        out.push(line);
      }
      return out;
    };
    // Checked now, before any lease: a paste that does not fit, or (with the room) is more than
    // one edit frame carries, says so and leaves the sheet as it was.
    const now = make(lines, range);
    if (!Array.isArray(now)) {
      this.showNotice(now.error);
      return;
    }
    const room = !(this.backend instanceof LocalSheet);
    if (room && editFrameBytes(now.join("\n")) > LIMITS.liveDocFrameBytes) {
      this.showNotice(
        `That paste is more than ${LIMITS.liveDocFrameBytes / 1024} KiB, the most one change can send. Paste fewer rows at a time.`,
      );
      return;
    }
    this.write(range, make);
  }

  // ---------- lease events (from the backend) ----------

  granted(lease: ClientLease): void {
    const w = this.want;
    this.want = null;
    // A write asked for before edit mode ended (a width the keys had not sent yet) is still made.
    if (!w || (!this.editing && w.kind !== "write")) {
      if (!this.open) this.backend.release();
      return;
    }
    if (w.kind === "write") {
      const lines = this.backend.lines;
      // The rows written are the rows asked for (a header write re-reads the header itself).
      const moved =
        lease.start > 0 &&
        (joinLines(lines.slice(lease.start, lease.end)) !== w.text ||
          !sameColumns(w.head, lines[0]));
      const r = moved ? { error: "The sheet changed meanwhile. Try again." } : w.make(lines, lease);
      if (!Array.isArray(r)) {
        this.backend.release();
        this.showNotice(r.error);
        return;
      }
      // A refused send has said why (too large, not connected): that notice stays.
      const sent = this.backend.edit(r.join("\n"));
      this.backend.release();
      if (sent) {
        this.hideNotice();
        if (w.said && this.editing) this.announce(w.said);
      } else if (!this.notice) {
        this.showNotice("That change was not sent. Try again in a moment.");
      }
      this.hooks.status();
      return;
    }
    this.hooks.refresh();
    const row = lease.start + 1;
    const td = this.grid?.cell(row, w.col);
    const header = this.header();
    const col = header?.columns[w.col];
    if (!td || !header || !col) {
      this.backend.release();
      return;
    }
    // A row taken again keeps its open field, and what was typed in it meanwhile.
    const kept = w.keep !== undefined ? this.open : null;
    if (kept && kept.td !== td) {
      if (kept.docked) kept.td.classList.remove("plinth-sheet__cell--docked");
      else kept.field.remove();
    }
    const value =
      kept?.field.value ??
      w.keep ??
      w.initial ??
      (row === 1 ? col.name : inputText(this.cellAt(row, w.col), col, this.loc));
    const field = kept?.field ?? this.makeField(row, w.col, col, value);
    field.value = value;
    if (kept && kept.row !== row) this.grid?.repaint(kept.row, kept.col);
    this.open = {
      row,
      col: w.col,
      field,
      td,
      original: this.backend.lines[lease.start] ?? "",
      head: this.backend.lines[0] ?? "",
      sent: false,
      invalid: null,
      docked: kept?.docked ?? this.narrow(),
    };
    this.place(this.open);
    this.grid?.select(row, w.col);
    this.grid?.showRaw(value);
    this.hideNotice();
    field.focus();
    if (field instanceof HTMLInputElement && w.initial !== undefined && field.type === "text") {
      field.setSelectionRange(field.value.length, field.value.length);
    }
    if (w.initial !== undefined || w.keep !== undefined) this.schedule(0);
    this.hooks.status();
  }

  denied(reason: LeaseDenial, by?: string): void {
    const w = this.want;
    this.want = null;
    if (reason === "stale" && w && w.tries < STALE_RETRIES) {
      // The lines moved meanwhile (the room's change is already applied here): ask again for the
      // same rows where they are now, or give up when they are gone or the columns moved.
      const next = this.relocate(w);
      if (next) {
        this.want = next;
        const range = next.kind === "write" ? next.range : { start: next.row - 1, end: next.row };
        if (!this.backend.lease(range)) this.want = null;
        return;
      }
    }
    if (w?.kind === "cell" && w.keep !== undefined) {
      this.dropKept(w);
      return;
    }
    if (reason === "held") this.showNotice(`${by ?? "Someone"} is editing this row.`);
    else if (reason === "frozen")
      this.showNotice("Editing is paused until the changes are reviewed.");
    else if (reason === "watch") this.showNotice("Sign in to edit this sheet.");
    else this.showNotice("The sheet changed meanwhile. Try again.");
  }

  /**
   * A want aimed at the lines as they are now: its row found again by its line (nearest where it
   * was), under the same columns, or null. A header write keeps line 0 and re-reads it on grant.
   */
  private relocate(w: Want): Want | null {
    const lines = this.backend.lines;
    if (!sameColumns(w.head, lines[0])) return null;
    const head = lines[0] ?? "";
    if (w.kind === "write") {
      if (w.range.start === 0) return { ...w, head, tries: w.tries + 1 };
      const at = locateBlock(lines, w.text, w.range.start);
      if (at < 1) return null;
      const range = { start: at, end: at + (w.range.end - w.range.start) };
      return { ...w, range, head, tries: w.tries + 1 };
    }
    if (w.row === 1) return { ...w, line: head, head, tries: w.tries + 1 };
    const at = locateBlock(lines, w.line, w.row - 1);
    if (at < 1) return null;
    return { ...w, row: at + 1, head, tries: w.tries + 1 };
  }

  lost(reason: LeaseLoss): void {
    const o = this.open;
    this.cancelTimer();
    if (!o || !this.editing) return;
    if (reason === "reconnect" || reason === "rebased") {
      // Keep the text, find the row again once the draft is back, and take it again.
      const line = reason === "reconnect" ? this.backend.durableText : this.backend.ackedText;
      this.want = {
        kind: "cell",
        row: o.row,
        col: o.col,
        keep: o.field.value,
        line: line ?? o.original,
        head: o.head,
        tries: 0,
      };
      return;
    }
    this.closeField();
    this.showNotice(
      reason === "takeover"
        ? "Someone else took over this row."
        : "Editing is paused: the sheet changed. Your cell was closed.",
    );
    this.hooks.status();
  }

  /** The backend's lines or leases changed (the grid was redrawn). */
  changed(): void {
    const w = this.want;
    const b = this.backend;
    if (w?.kind === "cell" && w.keep !== undefined && !b.mine && b.connected && b.settled) {
      this.want = null;
      const next = w.tries < STALE_RETRIES ? this.relocate(w) : null;
      if (next?.kind !== "cell") {
        this.dropKept(w);
      } else {
        this.want = next;
        if (!b.lease({ start: next.row - 1, end: next.row })) this.want = { ...w, tries: 0 };
      }
    }
    this.landed();
    this.staleMenu();
    this.render();
  }

  /**
   * A menu names a row or a column by its number, and its items act on that number. When someone
   * else's change moved what sits there, the menu closes and says so, rather than act on another
   * row or column than the one it names.
   */
  private staleMenu(): void {
    const m = this.menu;
    if (!m || m.still()) return;
    const inside = m.el.contains(this.doc.activeElement);
    this.closeMenu(false);
    if (inside) this.grid?.focusSelected();
    this.showNotice("The sheet changed while the menu was open. Open it again.");
  }

  /** A row could not be taken again: its field closes, and the text it held is shown. */
  private dropKept(w: Extract<Want, { kind: "cell" }>): void {
    const text = w.keep ?? "";
    this.closeField();
    this.showNotice(
      `${a1(w.row, w.col)} changed while you were away. Your text was not kept: ${text}`,
    );
    this.hooks.status();
  }

  /** The room refused this frame's struct. */
  structDenied(reason: LeaseDenial, by?: string): void {
    const s = this.lastStruct;
    if (reason === "stale" && s && s.tries < STALE_RETRIES) {
      // Someone else's change came first and is applied here: the same op again would hit other
      // rows or columns, so it is aimed again at the ones chosen, or dropped when they are gone.
      const op = s.again(this.backend.lines);
      if (op) {
        this.lastStruct = { ...s, op, tries: s.tries + 1 };
        if (this.backend.struct(op)) return;
      }
    }
    this.lastStruct = null;
    this.moving = null;
    if (reason === "held") {
      this.showNotice(`${by ?? "Someone"} is editing. Rows and columns change once they finish.`);
    } else if (reason === "frozen") {
      this.showNotice("Editing is paused until the changes are reviewed.");
    } else if (reason === "watch") this.showNotice("Sign in to edit this sheet.");
    else this.showNotice("The sheet changed meanwhile. Try again.");
  }

  // ---------- the field ----------

  private makeField(row: number, index: number, col: SheetColumn, value: string): Field {
    const label = `Edit ${a1(row, index)}. Enter to finish, Escape to cancel.`;
    const formula = value.startsWith("=");
    let field: Field;
    if (row > 1 && col.type === "select" && !formula) {
      const sel = this.doc.createElement("select");
      const options = ["", ...(col.options ?? [])];
      if (value !== "" && !options.includes(value)) options.push(value);
      for (const o of options) {
        const opt = this.doc.createElement("option");
        opt.value = o;
        opt.textContent = o === "" ? "(empty)" : o;
        sel.append(opt);
      }
      sel.addEventListener("change", () => {
        this.schedule(0);
        this.commit();
      });
      field = sel;
    } else {
      const input = this.doc.createElement("input");
      input.type = row > 1 && col.type === "date" && !formula ? "date" : "text";
      input.autocomplete = "off";
      input.spellcheck = col.type === "text";
      if (row > 1 && col.type === "number" && !formula) input.inputMode = "decimal";
      input.addEventListener("input", () => {
        this.grid?.showRaw(input.value);
        this.schedule(EDIT_DEBOUNCE_MS);
      });
      field = input;
    }
    field.className = "plinth-sheet__input";
    field.setAttribute("aria-label", label);
    field.addEventListener("keydown", (e) => this.onFieldKey(e as KeyboardEvent));
    field.addEventListener("blur", () => {
      // Leaving the frame (the app's bar, another window) keeps the cell open; moving to another
      // place in the sheet commits it.
      setTimeout(() => {
        if (this.open?.field !== field || this.doc.activeElement === field) return;
        if (!this.doc.hasFocus()) return;
        // The docked panel's own Done button commits by itself.
        if (this.dock?.contains(this.doc.activeElement)) return;
        if (this.want?.kind === "cell" && this.want.keep !== undefined) return;
        if (!this.commit()) this.cancel();
      }, 0);
    });
    return field;
  }

  private onFieldKey(e: KeyboardEvent): void {
    const o = this.open;
    if (!o) return;
    const text = o.field instanceof HTMLInputElement && o.field.type === "text";
    if (e.key === "Escape") {
      e.preventDefault();
      this.cancel();
      this.focusCell(o.row, o.col);
    } else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (this.commit()) this.focusCell(o.row + 1, o.col, o.row, o.col);
    } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (this.commit()) this.focusCell(o.row, o.col + (e.shiftKey ? -1 : 1), o.row, o.col);
    } else if (text && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (this.commit())
        this.focusCell(o.row + (e.key === "ArrowUp" ? -1 : 1), o.col, o.row, o.col);
    }
  }

  /** Focus a cell, or the fallback when it does not exist. */
  private focusCell(row: number, col: number, fbRow?: number, fbCol?: number): void {
    const g = this.grid;
    const td = g?.cell(row, col) ?? (fbRow !== undefined ? g?.cell(fbRow, fbCol ?? 0) : null);
    td?.focus();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, ms);
    this.hooks.status();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The open field's row line (or header), checked; false when it cannot be sent. */
  private send(): boolean {
    const o = this.open;
    const mine = this.backend.mine;
    const header = this.header();
    if (!o || !mine || !header) return false;
    const col = header.columns[o.col] as SheetColumn;
    const value = o.field.value;
    let line: string | { error: string };
    if (o.row === 1) {
      line = headerWith(header, o.col, (c) => ({ ...c, name: value.normalize("NFC") }));
    } else {
      const v = cellFromInput(value, col, this.loc);
      line = v.ok
        ? rowWith(header, this.backend.lines[mine.start] ?? "[]", o.row, o.col, v.cell)
        : { error: `${a1(o.row, o.col)}: ${v.message}` };
    }
    if (typeof line !== "string") {
      o.invalid = line.error;
      o.field.setAttribute("aria-invalid", "true");
      o.field.title = line.error;
      return false;
    }
    o.invalid = null;
    o.field.removeAttribute("aria-invalid");
    o.field.removeAttribute("title");
    if (line !== this.backend.lines[mine.start]) {
      if (!this.backend.edit(line)) return false;
      o.sent = true;
    }
    return true;
  }

  /** Send a pending cell (and a width waiting for the keys to rest) now. */
  flush(): void {
    this.commitWidth();
    if (!this.timer) return;
    this.cancelTimer();
    this.send();
  }

  /** Send the open cell and close it; false (the field stays) when its value cannot be kept. */
  commit(): boolean {
    const o = this.open;
    if (!o) return true;
    this.cancelTimer();
    if (this.backend.mine && !this.send()) {
      this.showNotice(o.invalid ?? "This value cannot be kept here.");
      o.refused = true;
      o.field.focus();
      return false;
    }
    if (o.refused) this.hideNotice();
    this.close(true);
    return true;
  }

  /** Escape: the row goes back to what it was when the cell opened. */
  cancel(): void {
    const o = this.open;
    if (!o) return;
    this.cancelTimer();
    if (o.sent && this.backend.mine) this.backend.edit(o.original);
    this.close(true);
  }

  /** Close the open field without sending: release the lease, show the cell again. */
  close(release: boolean): void {
    this.want = null;
    if (!this.open) return;
    this.closeField();
    if (release && this.backend.mine) this.backend.release();
    this.hooks.status();
  }

  private closeField(): void {
    const o = this.open;
    this.open = null;
    this.cancelTimer();
    if (!o) return;
    o.field.remove();
    this.closeDock();
    o.td.classList.remove("plinth-sheet__cell--docked");
    this.grid?.repaint(o.row, o.col);
    this.grid?.select(o.row, o.col);
  }

  /** Put an open field where it is edited: in its cell, or docked at the bottom of the page. */
  private place(o: Open): void {
    if (!o.docked) {
      o.td.replaceChildren(o.field);
      return;
    }
    o.td.classList.add("plinth-sheet__cell--docked");
    const d = this.doc;
    const name = o.row === 1 ? "Column name" : (this.header()?.columns[o.col]?.name ?? "");
    const where = a1(o.row, o.col);
    let dock = this.dock;
    if (!dock) {
      dock = d.createElement("div");
      dock.className = "plinth-sheet__dock";
      dock.setAttribute("role", "group");
      d.body.append(dock);
      d.body.classList.add("plinth-sheet--docked");
      this.dock = dock;
    }
    dock.setAttribute("aria-label", `Edit ${where}`);
    const label = d.createElement("div");
    label.className = "plinth-sheet__dock-label";
    const strong = d.createElement("span");
    strong.className = "plinth-sheet__dock-name";
    strong.textContent = name;
    const addr = d.createElement("span");
    addr.className = "plinth-sheet__dock-addr";
    addr.textContent = where;
    label.append(strong, addr);
    const done = d.createElement("button");
    done.type = "button";
    done.className = "plinth-sheet__btn plinth-sheet__dock-done";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      const at = this.open;
      if (!at) return;
      if (this.commit()) this.focusCell(at.row, at.col);
    });
    o.field.setAttribute(
      "aria-label",
      `Edit ${where}${name && o.row > 1 ? `, ${name}` : ""}. Enter to finish, Escape to cancel.`,
    );
    dock.replaceChildren(label, o.field, done);
    // The page keeps the cell above the docked panel in view.
    this.doc.documentElement.style.setProperty("--sheet-dock-h", `${dock.offsetHeight || 120}px`);
    o.td.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  private closeDock(): void {
    if (!this.dock) return;
    this.dock.remove();
    this.dock = null;
    this.doc.body.classList.remove("plinth-sheet--docked");
  }

  // ---------- rows and columns ----------

  private mountStrip(): void {
    const g = this.grid;
    if (!g) return;
    if (!this.strip) this.strip = this.makeStrip();
    if (this.strip.parentNode !== g.slot) g.slot.append(this.strip);
    if (this.panel && this.panel.parentNode !== g.slot) g.slot.append(this.panel);
  }

  private stripButtons = new Map<string, HTMLButtonElement>();

  private makeStrip(): HTMLElement {
    const d = this.doc;
    const strip = d.createElement("div");
    strip.className = "plinth-sheet__strip";
    strip.setAttribute("role", "toolbar");
    strip.setAttribute("aria-label", "Rows and columns");
    const add = (key: string, label: string, run: () => void) => {
      const b = d.createElement("button");
      b.type = "button";
      b.className = "plinth-sheet__btn";
      b.textContent = label;
      b.addEventListener("click", run);
      this.stripButtons.set(key, b);
      strip.append(b);
    };
    add("rowAbove", "Row above", () => this.rowAction("above"));
    add("rowBelow", "Row below", () => this.rowAction("below"));
    add("rowDelete", "Delete row", () => this.rowAction("delete"));
    add("rowUp", "Move row up", () => this.moveRow(-1));
    add("rowDown", "Move row down", () => this.moveRow(1));
    add("colLeft", "Column left", () => this.columnAction("left"));
    add("colRight", "Column right", () => this.columnAction("right"));
    add("colDelete", "Delete column", () => this.columnAction("delete"));
    add("colEdit", "Column settings", () => this.openPanel());
    const hint = d.createElement("span");
    hint.className = "plinth-sheet__hint";
    hint.textContent =
      "Double-click a cell, or select it and type, to edit. Alt+Down opens a row's or a column's menu.";
    strip.append(hint);
    return strip;
  }

  private updateStrip(): void {
    if (!this.strip || !this.grid) return;
    const { row } = this.grid.selected();
    const cols = this.header()?.columns.length ?? 0;
    const last = this.backend.lines.length;
    const set = (k: string, disabled: boolean) => {
      const b = this.stripButtons.get(k);
      if (b) b.disabled = disabled;
    };
    set("rowAbove", row < 2);
    set("rowDelete", row < 2);
    set("rowUp", row <= 2);
    set("rowDown", row < 2 || row >= last);
    set("colDelete", cols <= 1);
    set("colLeft", cols >= LIMITS.maxSheetColumns);
    set("colRight", cols >= LIMITS.maxSheetColumns);
  }

  /** Send a struct; `again` aims it at the same rows or column if the room says it is stale. */
  private struct(op: SheetStructOp, again: SentStruct["again"]): boolean {
    if (!this.canWrite()) return false;
    if (this.open && !this.commit()) return false;
    this.close(true);
    const b = this.backend;
    for (const l of b.leases.values()) {
      if (l.id !== b.mine?.id) {
        this.showNotice(`${l.by} is editing. Rows and columns change once they finish.`);
        return false;
      }
    }
    this.lastStruct = { op, tries: 0, again };
    if (!b.struct(op)) {
      this.lastStruct = null;
      this.showNotice(
        b.connected
          ? "That change does not fit the sheet."
          : "Not connected. Try again in a moment.",
      );
      return false;
    }
    this.hideNotice();
    return true;
  }

  // A row action is tied to the selected row's line, and a column action to the selected
  // column's definition, so a retry after someone else's change finds them where they are now.

  private rowAction(kind: "above" | "below" | "delete"): void {
    const g = this.grid;
    if (!g) return;
    const { row } = g.selected();
    const lines = this.backend.lines;
    if (kind === "delete") {
      const line = lines[row - 1];
      if (row < 2 || line === undefined) return;
      this.struct({ op: "delete_rows", from: row, count: 1 }, (now) => {
        const at = locateBlock(now, line, row - 1);
        return at >= 1 ? { op: "delete_rows", from: at + 1, count: 1 } : null;
      });
      return;
    }
    const before = kind === "above" ? Math.max(2, row) : Math.max(2, row + 1);
    // The row the new one goes next to: above it, or below it (the header: always row 2).
    const next = kind === "above" ? before : before - 1;
    const line = lines[next - 1];
    if (line === undefined) return;
    this.struct({ op: "insert_rows", before, count: 1 }, (now) => {
      if (next === 1) return { op: "insert_rows", before: 2, count: 1 };
      const at = locateBlock(now, line, next - 1);
      if (at < 1) return null;
      return { op: "insert_rows", before: kind === "above" ? at + 1 : at + 2, count: 1 };
    });
  }

  /**
   * Move a row (the selected one by default) up or down by one, in the sheet's own order: the
   * room rewrites every formula's references so they keep pointing at the same cells. Once it
   * lands the row stays selected where it went, and the move is announced.
   */
  moveRow(dir: -1 | 1, row = this.grid?.selected().row ?? 0, focus = false): void {
    const g = this.grid;
    if (!g) return;
    if (g.view().sort) {
      this.showNotice("Rows move in the sheet's own order. Turn the sort off first.");
      return;
    }
    const lines = this.backend.lines;
    const to = row + dir;
    const line = lines[row - 1];
    if (row < 2 || to < 2 || to > lines.length || line === undefined) return;
    const op: SheetStructOp = { op: "move_rows", from: row, count: 1, to };
    // Set first: alone (solo), the move lands before struct() returns.
    this.moving = { col: g.selected().col, focus, arrived: false };
    const sent = this.struct(op, (now) => {
      const at = locateBlock(now, line, row - 1);
      const from = at + 1;
      if (at < 1 || from + dir < 2 || from + dir > now.length) return null;
      return { op: "move_rows", from, count: 1, to: from + dir };
    });
    if (!sent) this.moving = null;
  }

  /**
   * The backend applied this frame's own struct. Only the move last sent counts: the lines alone
   * cannot tell, since a move between two equal rows leaves them as they were.
   */
  structLanded(op: SheetStructOp): void {
    const m = this.moving;
    const s = this.lastStruct?.op;
    if (!m || s?.op !== "move_rows" || op.op !== "move_rows") return;
    if (op.from === s.from && op.count === s.count && op.to === s.to) m.arrived = true;
  }

  /** A row move landed: the row stays selected (and focused) where it went, and it is said. */
  private landed(): void {
    const m = this.moving;
    const op = this.lastStruct?.op;
    if (!m?.arrived || op?.op !== "move_rows") return;
    this.moving = null;
    this.grid?.select(op.to, m.col);
    if (m.focus) this.grid?.cell(op.to, m.col)?.focus();
    this.announce(`Row ${op.from} moved to row ${op.to}.`);
    this.updateStrip();
  }

  private columnAction(kind: "left" | "right" | "delete", which?: number): void {
    const g = this.grid;
    const header = this.header();
    const head = this.backend.lines[0];
    if (!g || !header || head === undefined) return;
    const col = which ?? g.selected().col;
    const was = header.columns[col];
    if (!was) return;
    const make = (h: SheetHeader, at: number): SheetStructOp => {
      if (kind === "delete") return { op: "delete_columns", from: colLetter(at), count: 1 };
      const names = new Set(h.columns.map((c) => c.name));
      let n = h.columns.length + 1;
      while (names.has(`Column ${n}`)) n++;
      return {
        op: "insert_columns",
        before: colLetter(kind === "left" ? at : at + 1),
        columns: [{ name: `Column ${n}`, type: "text" }],
      };
    };
    const op = make(header, col);
    this.struct(op, (now) => {
      if (now[0] === head) return op;
      const h = sheetHeaderLine(now[0]);
      const at = h ? findColumn(h, was, col) : -1;
      return h && at >= 0 ? make(h, at) : null;
    });
  }

  // ---------- the header: widths, freezing, menus ----------

  /**
   * A column header's controls in edit mode: its menu button, and the handle on its edge. Built
   * from the column the grid shows (the room's lines may not have arrived yet).
   */
  private readonly headerTools = (col: number, c: SheetColumn): HTMLElement[] => {
    const d = this.doc;
    const menu = d.createElement("button");
    menu.type = "button";
    menu.className = "plinth-sheet__tool plinth-sheet__colmenu";
    // The header's own stop is its sort button (Alt+Down opens this menu from there).
    menu.tabIndex = -1;
    menu.setAttribute("aria-label", `Column ${colLetter(col)} menu: ${c.name}`);
    menu.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("aria-expanded", "false");
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      this.columnMenu(col, menu, menu);
    });
    const handle = d.createElement("span");
    handle.className = "plinth-sheet__tool plinth-sheet__resize";
    // Pointer only: Alt+Left and Alt+Right, and the settings' Width field, do it by keyboard.
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to change the width";
    handle.addEventListener("pointerdown", (e) => this.dragWidth(e, col, handle));
    return [menu, handle];
  };

  /** Drag a header's edge: the width shows as it moves, and is sent when the pointer lets go. */
  private dragWidth(e: PointerEvent, col: number, handle: HTMLElement): void {
    const g = this.grid;
    const was = this.header()?.columns[col];
    if (!g || !was || e.button !== 0 || !this.canWrite()) return;
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const from = g.width(col);
    let w = from;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer
    }
    const move = (ev: PointerEvent) => {
      w = clampWidth(from + ev.clientX - start);
      g.setWidth(col, w);
    };
    const end = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      if (ev.type === "pointercancel" || w === from) {
        g.setWidth(col, from);
        return;
      }
      this.setWidth(col, was, w);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Alt+Left or Alt+Right in a header: 8 px narrower or wider, sent once the keys rest. */
  private nudgeWidth(col: number, delta: number): void {
    const g = this.grid;
    const c = this.header()?.columns[col];
    if (!g || !c || !this.canWrite()) return;
    const p =
      this.widthPending?.col === col ? this.widthPending : { col, was: c, width: columnWidth(c) };
    if (this.widthPending && this.widthPending.col !== col) this.commitWidth();
    const width = clampWidth(p.width + delta);
    this.widthPending = { ...p, width };
    g.setWidth(col, width);
    this.announce(`${c.name}: ${width} pixels wide.`);
    if (this.widthTimer) clearTimeout(this.widthTimer);
    this.widthTimer = setTimeout(() => this.commitWidth(), WIDTH_DEBOUNCE_MS);
    this.hooks.status();
  }

  /** Send a width that Alt+arrows changed, now. */
  private commitWidth(): void {
    if (this.widthTimer) clearTimeout(this.widthTimer);
    this.widthTimer = null;
    const p = this.widthPending;
    this.widthPending = null;
    if (p && p.width !== columnWidth(p.was)) this.setWidth(p.col, p.was, p.width);
  }

  /** A column's width, through a lease on the header line. */
  private setWidth(col: number, was: SheetColumn, width: number): void {
    this.writeColumn(col, was, (c) => ({ ...c, width: clampWidth(width) }), {
      said: `${was.name}: ${clampWidth(width)} pixels wide.`,
    });
  }

  /** One column's definition changed through a lease on the header line, found where it is now. */
  private writeColumn(
    col: number,
    was: SheetColumn,
    change: (c: SheetColumn) => SheetColumn,
    opts: { said?: string } = {},
  ): void {
    this.write(
      { start: 0, end: 1 },
      (lines) => {
        const now = sheetHeaderLine(lines[0]);
        const at = now ? findColumn(now, was, col) : -1;
        if (!now || at < 0) return { error: "The column changed meanwhile. Try again." };
        const line = headerWith(now, at, change);
        if (typeof line !== "string") return line;
        const problem = rowsProblem(lines, sheetHeaderLine(line) as SheetHeader);
        if (problem) return { error: `Some cells do not fit: ${problem}` };
        return [line];
      },
      opts,
    );
  }

  /** "Freeze up to this column" (the first `col + 1` columns stay in view), or none with -1. */
  freezeTo(col: number): void {
    const header = this.header();
    if (!header) return;
    const was = col >= 0 ? header.columns[col] : undefined;
    if (col >= 0 && !was) return;
    if (col + 1 > MAX_FROZEN) {
      this.showNotice(`At most ${MAX_FROZEN} columns stay in view.`);
      return;
    }
    const said =
      col < 0
        ? "No columns stay in view."
        : col === 0
          ? "Column A stays in view."
          : `Columns A to ${colLetter(col)} stay in view.`;
    this.write(
      { start: 0, end: 1 },
      (lines) => {
        const now = sheetHeaderLine(lines[0]);
        if (!now) return { error: "The sheet changed meanwhile. Try again." };
        if (!was) return [headerFrozen(now, 0)];
        const at = findColumn(now, was, col);
        if (at < 0) return { error: "The column changed meanwhile. Try again." };
        if (at + 1 > MAX_FROZEN) return { error: `At most ${MAX_FROZEN} columns stay in view.` };
        return [headerFrozen(now, at + 1)];
      },
      { said },
    );
  }

  /** A column's menu, from its header's button or Alt+Down in the header. */
  private columnMenu(col: number, from: HTMLElement, button: HTMLElement | null): void {
    const header = this.header();
    const c = header?.columns[col];
    if (!header || !c || !this.canWrite()) return;
    const frozen = header.freeze?.cols ?? 0;
    const items: MenuItem[] = [{ label: "Column settings…", run: () => this.openPanel(col) }];
    if (frozen !== col + 1) {
      items.push({
        label: "Freeze up to this column",
        run: () => this.freezeTo(col),
        ...(col + 1 > MAX_FROZEN ? { off: `At most ${MAX_FROZEN} columns stay in view.` } : {}),
      });
    }
    if (frozen > 0) items.push({ label: "Unfreeze columns", run: () => this.freezeTo(-1) });
    items.push(
      { label: "Insert column left", run: () => this.columnAction("left", col) },
      { label: "Insert column right", run: () => this.columnAction("right", col) },
      {
        label: "Delete column",
        run: () => this.columnAction("delete", col),
        ...(header.columns.length <= 1 ? { off: "A sheet keeps at least one column." } : {}),
      },
    );
    const back = this.grid?.cell(1, col)?.querySelector<HTMLElement>(".plinth-sheet__sort") ?? from;
    // Column names are unique, so the same name at the same letter is the same column.
    const still = () => {
      const h = this.header();
      return h?.columns[col]?.name === c.name && (h.freeze?.cols ?? 0) === frozen;
    };
    this.openMenu(from, `Column ${colLetter(col)}, ${c.name}`, items, back, button, still);
  }

  /** A row's menu, from its number or Alt+Down in one of its cells. */
  private rowMenu(row: number, from: HTMLElement): void {
    const g = this.grid;
    if (!g || row < 2 || !this.canWrite()) return;
    const last = this.backend.lines.length;
    const col = g.selected().col;
    const select = () => g.select(row, col);
    const items: MenuItem[] = [
      {
        label: "Insert row above",
        run: () => {
          select();
          this.rowAction("above");
        },
      },
      {
        label: "Insert row below",
        run: () => {
          select();
          this.rowAction("below");
        },
      },
      {
        label: "Move row up",
        run: () => {
          select();
          this.moveRow(-1, row, true);
        },
        ...(row <= 2 ? { off: "This is the first row." } : {}),
      },
      {
        label: "Move row down",
        run: () => {
          select();
          this.moveRow(1, row, true);
        },
        ...(row >= last ? { off: "This is the last row." } : {}),
      },
      {
        label: "Delete row",
        run: () => {
          select();
          this.rowAction("delete");
        },
      },
    ];
    const line = this.backend.lines[row - 1];
    const still = () => this.backend.lines[row - 1] === line;
    this.openMenu(from, `Row ${row}`, items, g.cell(row, col) ?? from, null, still);
  }

  /**
   * A menu of buttons (role="menu"): next to what opened it, or a full-width sheet at phone width.
   * The arrows, Home and End move between its items, Escape closes it and goes back, and Tab or
   * a click elsewhere closes it.
   */
  private openMenu(
    anchor: HTMLElement,
    label: string,
    items: readonly MenuItem[],
    back: HTMLElement | null,
    button: HTMLElement | null,
    still: () => boolean,
  ): void {
    this.closeMenu(false);
    const d = this.doc;
    const menu = d.createElement("div");
    menu.className = "plinth-sheet__menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    const buttons: HTMLButtonElement[] = [];
    items.forEach((it, i) => {
      const b = d.createElement("button");
      b.type = "button";
      b.className = "plinth-sheet__menu-item";
      b.setAttribute("role", "menuitem");
      b.tabIndex = -1;
      b.textContent = it.label;
      if (it.off) {
        // Kept in the menu with its reason, as a menu item that cannot be chosen now.
        b.setAttribute("aria-disabled", "true");
        const why = d.createElement("span");
        why.id = `__plinth-menu-why-${i}`;
        why.hidden = true;
        why.textContent = it.off;
        menu.append(why);
        b.setAttribute("aria-describedby", why.id);
        b.title = it.off;
      }
      b.addEventListener("click", () => {
        if (it.off) {
          this.announce(it.off);
          return;
        }
        if (!still()) {
          this.staleMenu();
          return;
        }
        this.closeMenu(false);
        it.run();
      });
      buttons.push(b);
      menu.append(b);
    });
    menu.addEventListener("keydown", (e) => {
      const at = buttons.indexOf(d.activeElement as HTMLButtonElement);
      let to = -1;
      if (e.key === "ArrowDown") to = (at + 1) % buttons.length;
      else if (e.key === "ArrowUp") to = (at - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = buttons.length - 1;
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu(true);
        return;
      } else if (e.key === "Tab") {
        this.closeMenu(false);
        return;
      } else return;
      e.preventDefault();
      buttons[to]?.focus();
    });
    if (this.narrow()) menu.classList.add("plinth-sheet__menu--sheet");
    else {
      const r = anchor.getBoundingClientRect();
      const width = this.win.innerWidth || d.documentElement.clientWidth || 0;
      menu.style.top = `${Math.round(r.bottom + 2)}px`;
      menu.style.left = `${Math.max(8, Math.round(Math.min(r.left, width - 248)))}px`;
    }
    d.body.append(menu);
    button?.setAttribute("aria-expanded", "true");
    this.menu = { el: menu, button, back, still };
    d.addEventListener("pointerdown", this.onOutside, true);
    buttons[0]?.focus();
  }

  private readonly onOutside = (e: Event) => {
    if (this.menu && !this.menu.el.contains(e.target as Node)) this.closeMenu(false);
  };

  private closeMenu(goBack: boolean): void {
    const m = this.menu;
    if (!m) return;
    this.menu = null;
    this.doc.removeEventListener("pointerdown", this.onOutside, true);
    m.el.remove();
    m.button?.setAttribute("aria-expanded", "false");
    // A rebuild meanwhile (someone else's width or row) replaced the cell focus went back to.
    if (goBack) {
      if (m.back?.isConnected) m.back.focus();
      else this.grid?.focusSelected();
    }
  }

  // ---------- column settings ----------

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  /** The settings of a column (the selected one by default). */
  openPanel(which?: number): void {
    const g = this.grid;
    const header = this.header();
    if (!g || !header || !this.canWrite()) return;
    this.closePanel();
    const col = which ?? g.selected().col;
    const c = header.columns[col];
    if (!c) return;
    const d = this.doc;
    const form = d.createElement("form");
    form.className = "plinth-sheet__panel";
    if (this.narrow()) form.classList.add("plinth-sheet__panel--sheet");
    form.setAttribute("aria-label", `Column ${colLetter(col)} settings`);
    const field = (labelText: string, input: HTMLElement) => {
      const label = d.createElement("label");
      label.className = "plinth-sheet__panel-field";
      const span = d.createElement("span");
      span.textContent = labelText;
      label.append(span, input);
      form.append(label);
      return label;
    };
    const name = d.createElement("input");
    name.value = c.name;
    name.maxLength = 100;
    field("Name", name);
    const type = d.createElement("select");
    for (const t of SHEET_COLUMN_TYPES) {
      const o = d.createElement("option");
      o.value = t;
      o.textContent = t;
      type.append(o);
    }
    type.value = c.type;
    field("Type", type);
    const style = d.createElement("select");
    for (const [v, t] of [
      ["", "automatic"],
      ["plain", "plain"],
      ["percent", "percent"],
      ["currency", "currency"],
    ] as const) {
      const o = d.createElement("option");
      o.value = v;
      o.textContent = t;
      style.append(o);
    }
    style.value = c.format?.style ?? "";
    const styleRow = field("Number format", style);
    const currency = d.createElement("input");
    currency.value = c.format?.currency ?? "EUR";
    currency.maxLength = 3;
    currency.size = 4;
    const currencyRow = field("Currency", currency);
    const decimals = d.createElement("input");
    decimals.type = "number";
    decimals.min = "0";
    decimals.max = "10";
    decimals.value = c.format?.decimals !== undefined ? String(c.format.decimals) : "";
    const decimalsRow = field("Decimals", decimals);
    const grouping = d.createElement("input");
    grouping.type = "checkbox";
    grouping.checked = c.format?.grouping !== false;
    const groupingRow = field("Thousands separators", grouping);
    groupingRow.classList.add("plinth-sheet__panel-field--check");
    const width = d.createElement("input");
    width.type = "number";
    width.min = String(40);
    width.max = String(800);
    width.step = "1";
    width.placeholder = "Automatic";
    const widthWas = c.width !== undefined ? String(c.width) : "";
    width.value = widthWas;
    field("Width in pixels", width);
    const options = this.optionList(c.options ?? []);
    form.append(options.el);
    const sync = () => {
      const num = type.value === "number";
      styleRow.hidden = !num;
      decimalsRow.hidden = !num || style.value === "";
      groupingRow.hidden = !num || style.value === "";
      currencyRow.hidden = !num || style.value !== "currency";
      options.el.hidden = type.value !== "select";
    };
    type.addEventListener("change", sync);
    style.addEventListener("change", sync);
    sync();
    const apply = d.createElement("button");
    apply.type = "submit";
    apply.className = "plinth-sheet__btn";
    apply.textContent = "Apply";
    const cancel = d.createElement("button");
    cancel.type = "button";
    cancel.className = "plinth-sheet__btn";
    cancel.textContent = "Cancel";
    const back = () => {
      this.closePanel();
      this.grid?.focusSelected();
    };
    cancel.addEventListener("click", back);
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        back();
      }
    });
    const actions = d.createElement("div");
    actions.className = "plinth-sheet__panel-actions";
    actions.append(apply, cancel);
    form.append(actions);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = type.value as SheetColumnType;
      const w = width.value.trim();
      const px = w === "" ? null : Number(w);
      if (px !== null && (!Number.isInteger(px) || px < 40 || px > 800)) {
        this.showNotice("A width is a whole number of pixels from 40 to 800.");
        width.focus();
        return;
      }
      const list = t === "select" ? readOptions(options.entries(), c.options ?? []) : null;
      if (list && "error" in list) {
        this.showNotice(list.error);
        return;
      }
      const renames = list && c.type === "select" ? list.renames : new Map<string, string>();
      const change = (old: SheetColumn): SheetColumn => {
        const next: SheetColumn = { name: name.value.normalize("NFC"), type: t };
        // An untouched width field keeps the width as it is now (dragged meanwhile, say).
        if (w === widthWas) {
          if (old.width !== undefined) next.width = old.width;
        } else if (px !== null) next.width = px;
        if (t === "number" && style.value !== "") {
          const f: SheetNumberFormat = { style: style.value as SheetNumberFormat["style"] };
          if (style.value === "currency") f.currency = currency.value.trim().toUpperCase();
          if (decimals.value !== "") f.decimals = Number(decimals.value);
          // Separators are on unless turned off; an explicit "on" stays as it was written.
          if (!grouping.checked) f.grouping = false;
          else if (old.format?.grouping === true) f.grouping = true;
          next.format = f;
        }
        if (list && !("error" in list)) next.options = list.options;
        return next;
      };
      const first = headerWith(header, col, change);
      if (typeof first !== "string") {
        this.showNotice(first.error);
        return;
      }
      const lines = this.backend.lines;
      // An option that cells hold cannot just go: say where, and keep the panel open.
      if (list && !("error" in list) && c.type === "select") {
        const held = firstUse(lines, col, new Set(list.removed));
        if (held) {
          this.showNotice(
            `${held.at} holds "${held.value}". Change those cells first, or keep the option.`,
          );
          return;
        }
      }
      const said = `Column ${colLetter(col)} settings applied.`;
      // Renaming options that cells hold renames them in those cells too: one change of the
      // whole sheet, header and rows, so the rows always fit the header.
      if (firstUse(lines, col, new Set(renames.keys()))) {
        const make = (now: readonly string[], l: LineRange): string[] | { error: string } => {
          if (l.start !== 0 || l.end !== now.length) {
            return { error: "The sheet changed meanwhile. Try again." };
          }
          const h = sheetHeaderLine(now[0]);
          const at = h ? findColumn(h, c, col) : -1;
          if (!h || at < 0) return { error: "The column changed meanwhile. Try again." };
          const line = headerWith(h, at, change);
          if (typeof line !== "string") return line;
          const next = sheetHeaderLine(line) as SheetHeader;
          const rows = renamedRows(now, next, at, renames);
          if (!Array.isArray(rows)) return rows;
          const problem = rowsProblem([line, ...rows], next);
          if (problem) return { error: `Some cells do not fit: ${problem}` };
          return [line, ...rows];
        };
        const range = { start: 0, end: lines.length };
        const now = make(lines, range);
        if (!Array.isArray(now)) {
          this.showNotice(now.error);
          return;
        }
        if (
          !(this.backend instanceof LocalSheet) &&
          editFrameBytes(now.join("\n")) > LIMITS.liveDocFrameBytes
        ) {
          this.showNotice(
            `Renaming those options rewrites more than ${LIMITS.liveDocFrameBytes / 1024} KiB of rows, the most one change can send. Change the cells in smaller steps, then rename the option.`,
          );
          return;
        }
        this.closePanel();
        this.write(range, make, { what: "this sheet", said });
        return;
      }
      this.closePanel();
      this.writeColumn(col, c, change, { said });
    });
    this.panel = form;
    g.slot.append(form);
    name.focus();
  }

  /**
   * A select column's options as a list: each one a field to rename it, with Move up, Move down
   * and Remove, then a field and a button to add one (at most 100, of at most 100 characters).
   */
  private optionList(initial: readonly string[]): { el: HTMLElement; entries(): OptionEntry[] } {
    const d = this.doc;
    const box = d.createElement("fieldset");
    box.className = "plinth-sheet__options";
    const legend = d.createElement("legend");
    legend.textContent = "Options";
    const list = d.createElement("ol");
    list.className = "plinth-sheet__options-list";
    const rows: { from: string | null; input: HTMLInputElement }[] = initial.map((o) => {
      const input = d.createElement("input");
      input.value = o;
      return { from: o, input };
    });
    const addInput = d.createElement("input");
    addInput.maxLength = MAX_OPTION_CHARS;
    addInput.placeholder = "New option";
    addInput.setAttribute("aria-label", "New option");
    const add = d.createElement("button");
    add.type = "button";
    add.className = "plinth-sheet__btn";
    add.textContent = "Add option";
    const count = d.createElement("p");
    count.className = "plinth-sheet__options-count";
    const small = (text: string, label: string, run: () => void, off: boolean) => {
      const b = d.createElement("button");
      b.type = "button";
      b.className = "plinth-sheet__btn plinth-sheet__btn--small";
      b.textContent = text;
      b.setAttribute("aria-label", label);
      b.disabled = off;
      b.addEventListener("click", run);
      return b;
    };
    const draw = (focus?: { at: number; part: "input" | "up" | "down" | "remove" }) => {
      const items = rows.map((r, i) => {
        const li = d.createElement("li");
        li.className = "plinth-sheet__option";
        r.input.maxLength = MAX_OPTION_CHARS;
        const shown = () => r.input.value.trim() || `option ${i + 1}`;
        r.input.setAttribute("aria-label", `Option ${i + 1}`);
        const up = small("↑", `Move ${shown()} up`, () => swap(i, i - 1, "up"), i === 0);
        const down = small(
          "↓",
          `Move ${shown()} down`,
          () => swap(i, i + 1, "down"),
          i === rows.length - 1,
        );
        const remove = small("Remove", `Remove ${shown()}`, () => drop(i), false);
        r.input.oninput = () => {
          up.setAttribute("aria-label", `Move ${shown()} up`);
          down.setAttribute("aria-label", `Move ${shown()} down`);
          remove.setAttribute("aria-label", `Remove ${shown()}`);
        };
        li.append(r.input, up, down, remove);
        if (focus?.at === i) {
          const target = { input: r.input, up, down, remove }[focus.part];
          queueMicrotask(() => (target.disabled ? r.input : target).focus());
        }
        return li;
      });
      list.replaceChildren(...items);
      const full = rows.length >= MAX_OPTIONS;
      add.disabled = full;
      addInput.disabled = full;
      count.textContent = `${rows.length} of ${MAX_OPTIONS} options`;
    };
    const swap = (i: number, j: number, part: "up" | "down") => {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) return;
      rows[i] = b;
      rows[j] = a;
      draw({ at: j, part });
    };
    const drop = (i: number) => {
      rows.splice(i, 1);
      draw();
      queueMicrotask(() => (rows[i]?.input ?? rows[i - 1]?.input ?? addInput).focus());
    };
    const push = () => {
      const v = addInput.value.trim();
      if (v === "" || rows.length >= MAX_OPTIONS) return;
      const input = d.createElement("input");
      input.value = v;
      rows.push({ from: null, input });
      addInput.value = "";
      draw();
      addInput.focus();
    };
    add.addEventListener("click", push);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // Enter adds the option; it does not apply the whole panel.
        e.preventDefault();
        push();
      }
    });
    const adder = d.createElement("div");
    adder.className = "plinth-sheet__options-add";
    adder.append(addInput, add);
    box.append(legend, list, adder, count);
    draw();
    return {
      el: box,
      entries: () => [
        ...rows.map((r) => ({ from: r.from, value: r.input.value })),
        // Text left in the new option's field is added too.
        ...(addInput.value.trim() ? [{ from: null, value: addInput.value }] : []),
      ],
    };
  }

  // ---------- notices ----------

  /** A message in the frame's own status line (errors from the room). */
  notify(text: string): void {
    if (this.editing) this.showNotice(text);
  }

  private showNotice(text: string, action?: { label: string; run: () => void }): void {
    let el = this.notice;
    if (!el) {
      el = this.doc.createElement("div");
      el.className = "plinth-sheet__notice";
      el.setAttribute("role", "status");
      this.doc.body.append(el);
      this.notice = el;
    }
    const msg = this.doc.createElement("span");
    msg.textContent = text;
    const parts: Node[] = [msg];
    if (action) {
      const btn = this.doc.createElement("button");
      btn.type = "button";
      btn.className = "plinth-sheet__btn";
      btn.textContent = action.label;
      btn.addEventListener("click", action.run);
      parts.push(btn);
    }
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "plinth-sheet__notice-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => this.hideNotice());
    parts.push(close);
    el.replaceChildren(...parts);
  }

  private hideNotice(): void {
    this.notice?.remove();
    this.notice = null;
  }

  /** For tests and the status line. */
  get field(): Field | null {
    return this.open?.field ?? null;
  }
}
