// On-page editing of a sheet (#36), inside the sheet renderer. The live draft is the sheet's
// canonical JSON lines: line 0 is the header (row 1), and row r is line r - 1. In edit mode Enter,
// F2, a double-click or typing opens the selected cell: the editor asks the room for a lease on
// the cell's row line, and once it is granted the cell becomes a field (<input>, a <select> for a
// select column, <input type="date"> for a date). Typing sends the whole row line, re-serialized,
// at most every 250 ms; Enter, Tab and the up and down arrows commit and move; Escape puts the row
// back as it was. A checkbox toggles with Enter, Space or a double-click; Delete clears a cell;
// pasting tab-separated text writes the rows it covers. Rows other people hold show their email.
//
// Rows and columns: the edit strip inserts and deletes them with a `struct` frame, which the room
// applies only while nobody else holds a lease, and the column settings change a column's name,
// type and format through a lease on the header line. Every line this sends is checked first with
// the same rules the room applies (checkRow, the header rules), so a refused value never leaves the
// frame and the room's draft is always a valid sheet.
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
import type { Grid } from "./grid.ts";
import { cellFromInput, inputText, type NumberLocale, numberLocale, parseTsv } from "./input.ts";

export const EDIT_DEBOUNCE_MS = 250;
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
    private readonly events: { granted(l: ClientLease): void; changed(): void },
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

const isPrintable = (e: KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ";

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

  constructor(
    private readonly win: Window,
    private backend: SheetBackend,
    private readonly hooks: SheetEditorHooks,
    opts: { locale?: string } = {},
  ) {
    this.loc = numberLocale(opts.locale);
  }

  get doc(): Document {
    return this.win.document;
  }

  /** A cell's text is waiting in the debounce, not yet sent. */
  get pending(): boolean {
    return this.timer !== null;
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
    grid.setLocked((td) => this.open?.td === td);
    if (old !== grid && this.editing) this.listen(grid, true);
    if (this.editing) this.mountStrip();
    const o = this.open;
    if (o) {
      const focused = this.doc.activeElement === o.field;
      const row = this.backend.mine ? this.backend.mine.start + 1 : o.row;
      const td = grid.cell(row, o.col);
      if (td) {
        o.row = row;
        o.td = td;
        td.replaceChildren(o.field);
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
    } else {
      t.removeEventListener("keydown", this.onKey);
      t.removeEventListener("dblclick", this.onDouble);
      t.removeEventListener("paste", this.onPaste);
    }
  }

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
    if (!on) this.close(true);
    this.editing = on;
    const g = this.grid;
    if (g) this.listen(g, on);
    if (on) {
      this.win.addEventListener("keydown", this.onSaveKey);
      this.mountStrip();
    } else {
      this.win.removeEventListener("keydown", this.onSaveKey);
      this.strip?.remove();
      this.strip = null;
      this.closePanel();
      this.hideNotice();
    }
    g?.el.classList.toggle("plinth-sheet__page--editing", on);
    this.render();
    this.hooks.status();
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
  private write(range: LineRange, make: Extract<Want, { kind: "write" }>["make"]): void {
    if (!this.canWrite()) return;
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other, range.start === 0 ? "the column names" : "this row");
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
    if (!this.editing || !w) {
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
      if (sent) this.hideNotice();
      else if (!this.notice) this.showNotice("That change was not sent. Try again in a moment.");
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
    if (kept && kept.td !== td) kept.field.remove();
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
    };
    td.replaceChildren(field);
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
    this.render();
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

  /** Send a pending cell now. */
  flush(): void {
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
      o.field.focus();
      return false;
    }
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
    this.grid?.repaint(o.row, o.col);
    this.grid?.select(o.row, o.col);
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
    add("colLeft", "Column left", () => this.columnAction("left"));
    add("colRight", "Column right", () => this.columnAction("right"));
    add("colDelete", "Delete column", () => this.columnAction("delete"));
    add("colEdit", "Column settings", () => this.openPanel());
    const hint = d.createElement("span");
    hint.className = "plinth-sheet__hint";
    hint.textContent = "Double-click a cell, or select it and type, to edit.";
    strip.append(hint);
    return strip;
  }

  private updateStrip(): void {
    if (!this.strip || !this.grid) return;
    const { row } = this.grid.selected();
    const cols = this.header()?.columns.length ?? 0;
    const set = (k: string, disabled: boolean) => {
      const b = this.stripButtons.get(k);
      if (b) b.disabled = disabled;
    };
    set("rowAbove", row < 2);
    set("rowDelete", row < 2);
    set("colDelete", cols <= 1);
    set("colLeft", cols >= LIMITS.maxSheetColumns);
    set("colRight", cols >= LIMITS.maxSheetColumns);
  }

  /** Send a struct; `again` aims it at the same rows or column if the room says it is stale. */
  private struct(op: SheetStructOp, again: SentStruct["again"]): void {
    if (!this.canWrite()) return;
    if (this.open && !this.commit()) return;
    this.close(true);
    const b = this.backend;
    for (const l of b.leases.values()) {
      if (l.id !== b.mine?.id) {
        this.showNotice(`${l.by} is editing. Rows and columns change once they finish.`);
        return;
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
      return;
    }
    this.hideNotice();
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

  private columnAction(kind: "left" | "right" | "delete"): void {
    const g = this.grid;
    const header = this.header();
    const head = this.backend.lines[0];
    if (!g || !header || head === undefined) return;
    const { col } = g.selected();
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

  // ---------- column settings ----------

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private openPanel(): void {
    const g = this.grid;
    const header = this.header();
    if (!g || !header || !this.canWrite()) return;
    this.closePanel();
    const col = g.selected().col;
    const c = header.columns[col] as SheetColumn;
    const d = this.doc;
    const form = d.createElement("form");
    form.className = "plinth-sheet__panel";
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
    const options = d.createElement("textarea");
    options.rows = 3;
    options.value = (c.options ?? []).join("\n");
    const optionsRow = field("Options, one per line", options);
    const sync = () => {
      const num = type.value === "number";
      styleRow.hidden = !num;
      decimalsRow.hidden = !num || style.value === "";
      currencyRow.hidden = !num || style.value !== "currency";
      optionsRow.hidden = type.value !== "select";
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
    cancel.addEventListener("click", () => this.closePanel());
    const actions = d.createElement("div");
    actions.className = "plinth-sheet__panel-actions";
    actions.append(apply, cancel);
    form.append(actions);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = type.value as SheetColumnType;
      const change = (old: SheetColumn): SheetColumn => {
        const next: SheetColumn = { name: name.value.normalize("NFC"), type: t };
        if (old.width !== undefined) next.width = old.width;
        if (t === "number" && style.value !== "") {
          const f: SheetNumberFormat = { style: style.value as SheetNumberFormat["style"] };
          if (style.value === "currency") f.currency = currency.value.trim().toUpperCase();
          if (decimals.value !== "") f.decimals = Number(decimals.value);
          if (old.format?.grouping !== undefined) f.grouping = old.format.grouping;
          next.format = f;
        }
        if (t === "select") {
          next.options = [
            ...new Set(
              options.value
                .split("\n")
                .map((o) => o.trim())
                .filter(Boolean),
            ),
          ];
        }
        return next;
      };
      const first = headerWith(header, col, change);
      if (typeof first !== "string") {
        this.showNotice(first.error);
        return;
      }
      this.closePanel();
      this.write({ start: 0, end: 1 }, (lines) => {
        const now = sheetHeaderLine(lines[0]);
        // The column as it was when the panel opened, wherever it is now.
        const at = now ? findColumn(now, c, col) : -1;
        if (!now || at < 0) return { error: "The column changed meanwhile. Try again." };
        const line = headerWith(now, at, change);
        if (typeof line !== "string") return line;
        const next = sheetHeaderLine(line) as SheetHeader;
        const problem = rowsProblem(lines, next);
        if (problem) return { error: `Some cells do not fit: ${problem}` };
        return [line];
      });
    });
    this.panel = form;
    g.slot.append(form);
    name.focus();
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
