// Writing the board to shared data through the page runtime. Every change is a whole block or
// arrow written at the rev it was read at (ifRev), so nobody's write is lost silently. A block
// save carries only the fields the viewer changed: on a conflict the latest copy is read and those
// fields are put on top of it, up to four times, and a field someone else changed meanwhile keeps
// their value (the viewer is told). One write per block is in flight at a time, and later changes
// to it are folded into the next one. A refusal the viewer cannot fix (read_only, forbidden) turns
// the board read-only. A peer's save of a block this viewer is saving, dragging, resizing or
// editing the text of is read once that is over, so it never replaces what the viewer is in the
// middle of. A text edit is written at the rev it started from, so a peer's text saved meanwhile
// is a conflict: their text is kept. A table's rows merge cell by cell: a typed cell goes onto the
// newer rows unless that same cell changed, or its row or column went. Typed text is never
// dropped, since a duplicate is better than a loss: whatever the viewer wrote that could not go in
// place (their text or cells kept over it, a block deleted under it, a save that kept conflicting)
// is written at once as a new note beside the block, and the viewer is offered "Use mine", which
// puts it in place (bringing back a removed row or column) and takes the note away again.
import {
  BOARD_LIMITS,
  type BoardArrow,
  type BoardBlock,
  cellText,
  cleanBlock,
  type TableCol,
  type TableRow,
} from "@plinth/shared";
import type { BoardModel, Bounds, Entry } from "./model.ts";
import type { RuntimeCollection, RuntimeError } from "./runtime.ts";

export interface SyncDeps {
  blocks: RuntimeCollection;
  arrows: RuntimeCollection;
  model: BoardModel;
  /** The model changed: redraw. */
  changed(): void;
  /** The server refused a write this viewer cannot fix: stop offering edits. */
  readOnly(): void;
  /** A short message for the viewer, with a button that does something about it. */
  say(text: string, action?: SayAction): void;
  /** Tell the room a block or arrow was saved (a no-op without a room). */
  emit(topic: "block.saved" | "arrow.saved", data: { id: string }): void;
  /**
   * Whether this viewer holds a block (a drag or a resize already drawn into the model, or an edit
   * of its text): a peer's save of it is read once that ends (release).
   */
  busy?(id: string): boolean;
  /** Waits; a test passes its own. */
  wait?(ms: number): Promise<void>;
  /**
   * What the viewer wrote that no note could hold yet (the board full, offline, the page
   * read-only): shown until it is written as a note or the viewer dismisses it. Empty to hide.
   */
  held?(texts: readonly string[]): void;
}

/** A button on a message. */
export interface SayAction {
  label: string;
  run(): void;
}

const ATTEMPTS = 4;
/** The longest a rate-limited write waits before its one retry. */
const MAX_BACKOFF_MS = 30_000;

export const READ_ONLY_TEXT = "View only";
export const KEPT_THEIRS_TEXT =
  "Someone else changed this block at the same time. Their change was kept.";
/** The button that writes the viewer's text over a peer's that was kept instead. */
export const USE_MINE_LABEL = "Use mine";
/** Their text was kept over the viewer's, which is now a note beside the block. */
export const KEPT_AS_NOTE_TEXT =
  "Someone else changed this block at the same time. Theirs was kept; yours is in a new note beside it.";
/** The block went while the viewer was writing in it; what they wrote is now a note there. */
export const DELETED_AS_NOTE_TEXT =
  "Someone deleted this block while you were writing in it. What you wrote is in a new note.";
export const KEPT_CHANGING_TEXT = "Someone else kept changing this block. Try again.";
/** A save was refused or did not arrive; what the viewer wrote is a note beside the block. */
export const SAVE_FAILED_NOTE_TEXT =
  "Your change could not be saved. What you wrote is in a new note beside it.";
/** A page older than its board's format (a 401 `stale_page`): the reload brings the current one. */
export const OUT_OF_DATE_TEXT = "Out of date. Reload.";
/** A save that kept conflicting; what the viewer wrote is a note beside the block. */
export const KEPT_CHANGING_NOTE_TEXT =
  "Someone else kept changing this block. What you wrote is in a new note beside it.";
/** How far beside a block the note with the viewer's text goes, and the note's size. */
const NOTE_GAP = 24;
const NOTE_SIZE = { w: 200, h: 140 };

/** The fields of a block one change sets. */
export type BlockPatch = Partial<BoardBlock>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function errorText(e: RuntimeError | undefined): string {
  switch (e?.code) {
    case "rate_limited":
      return "Slow down a moment: too many changes. Trying again shortly.";
    case "quota_exceeded":
      return "This board is full. Delete a few blocks first.";
    case "read_only":
    case "forbidden":
      return READ_ONLY_TEXT;
    case "expired":
      return e.reason === "stale_page" ? OUT_OF_DATE_TEXT : "Your access changed. Reload the page.";
    case "invalid":
      return "That change does not fit on a board.";
    default:
      return "Could not save. Check your connection and try again.";
  }
}

const code = (e: unknown) => (e as RuntimeError | undefined)?.code;

/** A table cell the viewer typed that the newer copy could not take. */
export interface LostCell {
  row: string;
  col: string;
  text: string;
}

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined =>
  o && Object.hasOwn(o, k) ? o[k] : undefined;

/**
 * A table's rows with the cells the viewer changed (`mine` against `was`, the copy the change was
 * made over) put on a newer copy (`theirs`), one cell at a time: a cell goes in unless the other
 * writer changed that same cell, or removed its row or column, and then it is `lost`, never
 * dropped. Everything else the other writer did stays.
 */
export function mergeRows(
  was: Pick<BoardBlock, "rows">,
  theirs: Pick<BoardBlock, "rows" | "cols">,
  mine: Record<string, TableRow>,
): { rows: Record<string, TableRow>; lost: LostCell[] } {
  const rows: Record<string, TableRow> = { ...(theirs.rows ?? {}) };
  const lost: LostCell[] = [];
  for (const [row, mrow] of Object.entries(mine)) {
    const wrow = own(was.rows, row);
    for (const [col, v] of Object.entries(mrow)) {
      if (col === "at" || typeof v !== "string") continue;
      const before = cellText(was, row, col);
      if (wrow && v === before) continue;
      const trow = own(rows, row);
      if (!trow || own(theirs.cols, col) === undefined) {
        lost.push({ row, col, text: v });
        continue;
      }
      const now = cellText(theirs, row, col);
      if (now === v) continue;
      if (now !== before) {
        lost.push({ row, col, text: v });
        continue;
      }
      rows[row] = { ...trow, [col]: v } as TableRow;
    }
  }
  return { rows, lost };
}

/**
 * The change that puts typed cells back on a table: each into its row, bringing back from `was` a
 * row or a column that was removed meanwhile (with the row's other cells that still have a
 * column). It may duplicate what someone else did; it never loses what the viewer typed.
 */
export function putCells(
  cur: BoardBlock,
  was: Pick<BoardBlock, "rows" | "cols">,
  cells: readonly LostCell[],
): BlockPatch {
  const cols: Record<string, TableCol> = { ...(cur.cols ?? {}) };
  const rows: Record<string, TableRow> = { ...(cur.rows ?? {}) };
  const next = (list: { at: number }[]) => Math.max(0, ...list.map((x) => x.at)) + 1;
  let colsChanged = false;
  for (const c of cells) {
    if (own(cols, c.col)) continue;
    cols[c.col] = { ...(own(was.cols, c.col) ?? { at: next(Object.values(cols)) }) };
    colsChanged = true;
  }
  for (const c of cells) {
    let row = own(rows, c.row);
    if (!row) {
      const old = own(was.rows, c.row);
      row = { at: old?.at ?? next(Object.values(rows)) } as TableRow;
      for (const [k, v] of Object.entries(old ?? {})) {
        if (k !== "at" && own(cols, k) && typeof v === "string") row[k] = v;
      }
    }
    rows[c.row] = { ...row, [c.col]: c.text } as TableRow;
  }
  return colsChanged ? { rows, cols } : { rows };
}

/** What a save could not put in place: the viewer's newest text and table cells, by cell. */
interface Unsaved {
  text?: string;
  cells: Map<string, LostCell>;
}

const cellKey = (c: { row: string; col: string }) => `${c.row}\u0000${c.col}`;

/**
 * Note `patch`'s typed text and cells that `theirs` does not hold in `unsaved`: what the viewer
 * wrote, from a change that is not going to be written.
 */
function noteUnsaved(unsaved: Unsaved, theirs: BoardBlock, patch: BlockPatch | undefined): void {
  if (!patch) return;
  if (patch.text !== undefined && patch.text !== theirs.text) unsaved.text = patch.text;
  for (const [row, r] of Object.entries(patch.rows ?? {})) {
    for (const [col, v] of Object.entries(r)) {
      if (col === "at" || typeof v !== "string" || v === cellText(theirs, row, col)) continue;
      unsaved.cells.set(cellKey({ row, col }), { row, col, text: v });
    }
  }
}

/** The texts of `pieces` joined into as few notes as the text limit allows, empty ones left out. */
export function noteTexts(pieces: readonly string[]): string[] {
  const max = BOARD_LIMITS.maxText;
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (p === "") continue;
    for (let rest = [...p]; rest.length > 0; rest = rest.slice(max)) {
      const part = rest.slice(0, max).join("");
      const joined = cur === "" ? part : `${cur}\n${part}`;
      if ([...joined].length <= max) cur = joined;
      else {
        out.push(cur);
        cur = part;
      }
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** What a delete leaves to undo it with. */
export interface Undo {
  undo(): Promise<void>;
}

export class BoardSync {
  /** The fields waiting for the next write of each block. */
  private readonly queued = new Map<string, BlockPatch>();
  private readonly running = new Map<string, Promise<boolean>>();
  /** The server's copy of each block being saved, at its rev: what the next write starts from. */
  private readonly known = new Map<string, Entry<BoardBlock>>();
  /** Blocks a peer saved while this viewer was busy with them: read again when it is done. */
  private readonly deferred = new Set<string>();
  private stopped = false;
  /** What the viewer wrote that no note could hold yet, with where it goes (held, flushHeld). */
  private kept: { near: Bounds; text: string }[] = [];
  private flushing = false;

  constructor(private readonly d: SyncDeps) {}

  private wait(ms: number): Promise<void> {
    return this.d.wait ? this.d.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** A refusal: read-only for good, or a message. Returns false. */
  private fail(e: unknown): false {
    const c = code(e);
    if (c === "read_only" || c === "forbidden") {
      this.stopped = true;
      this.d.readOnly();
    }
    this.d.say(errorText(e as RuntimeError));
    return false;
  }

  /**
   * Save the fields a viewer changed on a block: shown at once, written behind. `before` holds
   * those fields as they were when the change began, for a change already drawn into the model (a
   * drag); it defaults to the model's values. While a write of this block runs, the newest fields
   * wait and go next, so a drag that ends during a save makes one more write, not many. Resolves
   * true once the server has the change, or a newer copy that kept someone else's value instead
   * (and the viewer was told). `since` is the rev the change was made over, for one that began
   * before the model's copy (a text edit): a peer's save since then is a conflict, never written
   * over.
   */
  saveBlock(id: string, patch: BlockPatch, before?: BlockPatch, since?: number): Promise<boolean> {
    const m = this.d.model;
    const cur = m.blocks.get(id);
    if (!cur || this.stopped) return Promise.resolve(false);
    if (!this.known.has(id)) {
      // What the server holds: the model's copy, with the fields a drag already moved put back.
      const was: Record<string, unknown> = {};
      for (const k of Object.keys(patch) as (keyof BoardBlock)[]) {
        was[k] = before && k in before ? before[k] : cur.data[k];
      }
      const rev = since === undefined ? cur.rev : Math.min(since, cur.rev);
      this.known.set(id, { data: { ...cur.data, ...was } as BoardBlock, rev });
    }
    m.blocks.set(id, { data: { ...cur.data, ...patch }, rev: cur.rev });
    this.d.changed();
    this.queued.set(id, { ...this.queued.get(id), ...patch });
    let running = this.running.get(id);
    if (!running) {
      running = this.drain(id).finally(() => {
        this.running.delete(id);
        this.known.delete(id);
        this.release(id);
      });
      this.running.set(id, running);
    }
    return running;
  }

  /** Write this block's newest queued fields until none are left. */
  private async drain(id: string): Promise<boolean> {
    let ok = false;
    for (let next = this.queued.get(id); next; next = this.queued.get(id)) {
      this.queued.delete(id);
      ok = await this.write(id, next);
      if (!ok) {
        this.queued.delete(id);
        break;
      }
    }
    return ok;
  }

  private async write(id: string, change: BlockPatch): Promise<boolean> {
    const m = this.d.model;
    let patch = change;
    let backedOff = false;
    /** The copy this change was made over: Use mine brings a removed row or column back from it. */
    const was = this.known.get(id)?.data;
    /** What the viewer wrote that the newer copies could not take, over every attempt. */
    const unsaved: Unsaved = { cells: new Map() };
    let kept = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const base = this.known.get(id);
      if (!base || !m.blocks.has(id)) return false;
      // Everything this change set was someone else's to keep: the board shows theirs.
      if (Object.keys(patch).length === 0) {
        this.report(id, was ?? base.data, unsaved, kept);
        return true;
      }
      const data: BoardBlock = { ...base.data, ...patch };
      try {
        const doc = await this.d.blocks.set(id, data, { ifRev: base.rev });
        this.known.set(id, { data, rev: doc.rev });
        // Keep what the viewer did since (a queued change goes next), at the new rev.
        m.blocks.set(id, { data: m.blocks.get(id)?.data ?? data, rev: doc.rev });
        this.d.emit("block.saved", { id });
        this.report(id, was ?? base.data, unsaved, kept);
        this.wrote();
        return true;
      } catch (e) {
        if (code(e) === "rate_limited" && !backedOff) {
          backedOff = true;
          attempt--;
          this.d.say(errorText(e as RuntimeError));
          const s = (e as RuntimeError).retryAfter ?? 5;
          await this.wait(Math.min(MAX_BACKOFF_MS, Math.max(1, s) * 1000));
          continue;
        }
        if (code(e) !== "conflict") {
          // Refused or offline: the next snapshot would put the old text back, so what the viewer
          // wrote, here and queued behind it, is kept as a note (held on the page until one fits).
          const failed = this.fail(e);
          noteUnsaved(unsaved, base.data, patch);
          noteUnsaved(unsaved, base.data, this.queued.get(id));
          const pieces = this.pieces(unsaved);
          if (pieces.length > 0) void this.keepTyped(base.data, pieces, SAVE_FAILED_NOTE_TEXT);
          return failed;
        }
        // Someone else saved it: read theirs, then put this change's fields on top of it.
        const fresh = await this.d.blocks.get(id).catch(() => undefined);
        if (fresh === null) {
          // Deleted: what the viewer wrote in it goes into a note where it was.
          noteUnsaved(unsaved, base.data, patch);
          noteUnsaved(unsaved, base.data, this.queued.get(id));
          this.queued.delete(id);
          m.remove("blocks", id);
          this.d.changed();
          void this.keepTyped(base.data, this.pieces(unsaved), DELETED_AS_NOTE_TEXT);
          return false;
        }
        if (fresh) {
          const theirs = cleanBlock(fresh.data) ?? base.data;
          const r = this.rebase(id, patch, base.data, theirs, fresh.rev, unsaved);
          patch = r.left;
          kept ||= r.kept;
        }
      }
    }
    // It kept conflicting: what the viewer wrote, now and queued behind it, is kept as a note.
    const last = this.known.get(id)?.data;
    if (last) {
      noteUnsaved(unsaved, last, patch);
      noteUnsaved(unsaved, last, this.queued.get(id));
    }
    const pieces = this.pieces(unsaved);
    if (pieces.length > 0 && last) {
      void this.keepTyped(
        last,
        pieces,
        KEPT_CHANGING_NOTE_TEXT,
        this.restorer(id, was ?? last, unsaved),
      );
    } else this.d.say(KEPT_CHANGING_TEXT);
    return false;
  }

  /** The texts in `unsaved`, the block's text first, then each cell's. */
  private pieces(unsaved: Unsaved): string[] {
    return [
      ...(unsaved.text !== undefined ? [unsaved.text] : []),
      ...[...unsaved.cells.values()].map((c) => c.text),
    ];
  }

  /**
   * Use mine: write `unsaved` over the block as it is now, bringing back rows or columns. Resolves
   * true only when the block now holds all of it.
   */
  private restorer(id: string, was: BoardBlock, unsaved: Unsaved): () => Promise<boolean> {
    const text = unsaved.text;
    const cells = [...unsaved.cells.values()];
    return () => {
      const cur = this.d.model.blocks.get(id)?.data;
      if (!cur) return Promise.resolve(false);
      return this.saveBlock(id, {
        ...(text !== undefined ? { text } : {}),
        ...(cells.length > 0 ? putCells(cur, was, cells) : {}),
      }).then((ok) => ok && this.inPlace(id, { text, cells }));
    };
  }

  /** Whether block `id` holds `text` and each of `cells` as the viewer wrote them. */
  inPlace(id: string, typed: { text?: string; cells?: readonly LostCell[] }): boolean {
    const b = this.d.model.blocks.get(id)?.data;
    if (!b) return false;
    if (typed.text !== undefined && b.text !== typed.text) return false;
    return (typed.cells ?? []).every((c) => cellText(b, c.row, c.col) === c.text);
  }

  /** Tell the viewer how a save that went through ended: their text kept as a note, or theirs. */
  private report(id: string, was: BoardBlock, unsaved: Unsaved, kept: boolean): void {
    const pieces = this.pieces(unsaved);
    const near = this.d.model.blocks.get(id)?.data ?? was;
    if (unsaved.text !== undefined || unsaved.cells.size > 0) {
      void this.keepTyped(near, pieces, KEPT_AS_NOTE_TEXT, this.restorer(id, was, unsaved));
    } else if (kept) this.d.say(KEPT_THEIRS_TEXT);
  }

  /**
   * Keep text the viewer wrote that could not go where they wrote it: as new notes beside `near`
   * (the block, where it was), written before the viewer is told, so it survives a missed message
   * or a closed tab. `restore`, when it can still go in place, is offered as Use mine; it resolves
   * true only when the block now holds the text, and only then do the notes go again (unless
   * someone changed them meanwhile). Text no note could take (the board full, offline, read-only)
   * is held on the page (`held`) until a later write lets it become a note or the viewer dismisses
   * it: no message replaces it and it never times out.
   */
  async keepTyped(
    near: Bounds,
    pieces: readonly string[],
    message: string,
    restore?: () => Promise<boolean>,
  ): Promise<void> {
    const texts = noteTexts(pieces);
    const use = (notes: { id: string; rev: number }[]) =>
      restore
        ? {
            label: USE_MINE_LABEL,
            run: () =>
              void restore().then((inPlace) => {
                if (inPlace) void this.dropNotes(notes);
              }),
          }
        : undefined;
    if (texts.length === 0) {
      // Nothing typed is at stake (a cell was emptied, say): the offer is enough.
      if (restore) this.d.say(KEPT_THEIRS_TEXT, use([]));
      else this.d.say("Someone deleted this block.");
      return;
    }
    const notes: { id: string; rev: number }[] = [];
    for (const [i, text] of texts.entries()) {
      const id = await this.addBlock(this.noteAt(near, i, text), false);
      if (!id) {
        // No note could take it: hold it, and everything after it, on the page.
        for (const rest of texts.slice(i)) this.hold(near, rest);
        if (restore && !this.stopped) this.d.say(KEPT_THEIRS_TEXT, use(notes));
        return;
      }
      notes.push({ id, rev: this.d.model.blocks.get(id)?.rev ?? 0 });
    }
    this.d.say(message, use(notes));
  }

  /** The `i`th note holding the viewer's text beside `near`. */
  private noteAt(near: Bounds, i: number, text: string): BoardBlock {
    const clampTo = (v: number) =>
      Math.min(BOARD_LIMITS.maxCoord, Math.max(-BOARD_LIMITS.maxCoord, Math.round(v)));
    return {
      kind: "note",
      x: clampTo(near.x + near.w + NOTE_GAP),
      y: clampTo(near.y + i * (NOTE_SIZE.h + NOTE_GAP)),
      ...NOTE_SIZE,
      text,
      z: this.d.model.nextZ(),
    };
  }

  /**
   * Hold text the viewer wrote that cannot be written now (the page is read-only, say, or no note
   * fits): shown on the page until a later write lets it become a note beside `near`, or the
   * viewer dismisses it.
   */
  hold(near: Bounds, text: string): void {
    if (text === "") return;
    this.kept.push({ near: { x: near.x, y: near.y, w: near.w, h: near.h }, text });
    this.d.held?.(this.heldTexts());
  }

  /** What is held, oldest first. */
  heldTexts(): string[] {
    return this.kept.map((k) => k.text);
  }

  /** The viewer copied or let go of what was held. */
  dismissHeld(): void {
    this.kept = [];
    this.d.held?.([]);
  }

  /** A write went through: what is held may fit in a note now. */
  private wrote(): void {
    if (this.kept.length > 0 && !this.flushing) void this.flushHeld();
  }

  /**
   * Write what is held as notes, oldest first, stopping at the first that does not fit (it stays
   * held). Called after any write of the viewer's goes through and when the board becomes
   * writable again.
   */
  async flushHeld(): Promise<void> {
    if (this.flushing || this.stopped || this.kept.length === 0) return;
    this.flushing = true;
    let wrote = 0;
    try {
      while (this.kept.length > 0) {
        const k = this.kept[0] as { near: Bounds; text: string };
        if (!(await this.addBlock(this.noteAt(k.near, 0, k.text), false))) break;
        this.kept.shift();
        wrote++;
      }
    } finally {
      this.flushing = false;
    }
    this.d.held?.(this.heldTexts());
    if (wrote > 0 && this.kept.length === 0) {
      this.d.say("What you wrote is saved in a new note.");
    }
  }

  /** Take away notes that held the viewer's text, now in place, unless they were changed since. */
  private async dropNotes(notes: readonly { id: string; rev: number }[]): Promise<void> {
    const m = this.d.model;
    for (const n of notes) {
      if (m.blocks.get(n.id)?.rev !== n.rev) continue;
      try {
        await this.d.blocks.delete(n.id, { ifRev: n.rev });
      } catch {
        continue;
      }
      m.remove("blocks", n.id);
      this.d.emit("block.saved", { id: n.id });
    }
    this.d.changed();
  }

  /**
   * Take a newer server copy as the base. A field this change, or the change queued behind it,
   * sets that the other writer changed too keeps their value: the viewer made it without seeing
   * theirs. The rest stays. A table's rows merge cell by cell. What the viewer wrote that lost (their
   * text, or a cell) goes into `unsaved`, to be kept as a note. Returns what is left of this change,
   * and whether a field of the other writer's was kept over one of the viewer's.
   */
  private rebase(
    id: string,
    patch: BlockPatch,
    was: BoardBlock,
    theirs: BoardBlock,
    rev: number,
    unsaved: Unsaved,
  ): { left: BlockPatch; kept: boolean } {
    const left: BlockPatch = { ...patch };
    const queued = this.queued.get(id);
    let kept = false;
    const keys = new Set([...Object.keys(patch), ...Object.keys(queued ?? {})]);
    for (const k of keys as Set<keyof BoardBlock>) {
      const mine = k in patch ? patch[k] : queued?.[k];
      if (same(theirs[k], was[k]) || same(theirs[k], mine)) continue;
      if (k === "rows" && theirs.kind === "table") {
        // A table's rows merge cell by cell, so another writer's cells and the viewer's both stay.
        for (const target of [left, queued]) {
          if (!target?.rows) continue;
          const m = mergeRows(was, theirs, target.rows);
          for (const l of m.lost) unsaved.cells.set(cellKey(l), l);
          if (same(m.rows, theirs.rows)) delete target.rows;
          else target.rows = m.rows;
        }
        continue;
      }
      kept = true;
      if (k === "text") {
        const text = queued && "text" in queued ? queued.text : patch.text;
        if (text !== undefined && text !== theirs.text) unsaved.text = text;
      }
      delete left[k];
      if (queued) delete queued[k];
    }
    if (queued && Object.keys(queued).length === 0) this.queued.delete(id);
    this.known.set(id, { data: theirs, rev });
    this.d.model.blocks.set(id, { data: { ...theirs, ...left, ...queued }, rev });
    this.d.changed();
    return { left, kept };
  }

  /**
   * A new block; resolves to its id, or null when the server refused it. A rate limit waits once
   * and tries again, as a save does. `flush` false leaves what is held alone (a note being written
   * for it).
   */
  async addBlock(data: BoardBlock, flush = true): Promise<string | null> {
    if (this.stopped) return null;
    for (let backedOff = false; ; backedOff = true) {
      try {
        const doc = await this.d.blocks.add(data);
        this.d.model.upsertBlock(doc.id, doc.data, doc.rev);
        this.d.changed();
        this.d.emit("block.saved", { id: doc.id });
        if (flush) this.wrote();
        return doc.id;
      } catch (e) {
        if (code(e) === "rate_limited" && !backedOff) {
          this.d.say(errorText(e as RuntimeError));
          const s = (e as RuntimeError).retryAfter ?? 5;
          await this.wait(Math.min(MAX_BACKOFF_MS, Math.max(1, s) * 1000));
          if (this.stopped) return null;
          continue;
        }
        return this.fail(e) || null;
      }
    }
  }

  /** A new arrow between two blocks (none twice for the same pair). */
  async addArrow(from: string, to: string): Promise<string | null> {
    if (this.stopped || from === to) return null;
    for (const a of this.d.model.arrows.values()) {
      if (a.data.from === from && a.data.to === to) return null;
    }
    try {
      const doc = await this.d.arrows.add({ from, to } satisfies BoardArrow);
      this.d.model.upsertArrow(doc.id, doc.data, doc.rev);
      this.d.changed();
      this.d.emit("arrow.saved", { id: doc.id });
      return doc.id;
    } catch (e) {
      return this.fail(e) || null;
    }
  }

  async deleteArrow(id: string): Promise<boolean> {
    const a = this.d.model.arrows.get(id);
    if (!a || this.stopped) return false;
    try {
      await this.d.arrows.delete(id, { ifRev: a.rev });
    } catch (e) {
      if (code(e) !== "not_found") return this.fail(e);
    }
    this.d.model.remove("arrows", id);
    this.d.changed();
    this.d.emit("arrow.saved", { id });
    this.wrote();
    return true;
  }

  /**
   * Delete a block and the arrows attached to it. Resolves to an undo that puts them back (as new
   * documents with the same ids, if nobody took those ids meanwhile), or null when nothing was
   * deleted.
   */
  async deleteBlock(id: string): Promise<Undo | null> {
    const m = this.d.model;
    const b = m.blocks.get(id);
    if (!b || this.stopped) return null;
    const attached = m.arrowsOf(id);
    try {
      await this.d.blocks.delete(id, { ifRev: b.rev });
    } catch (e) {
      if (code(e) === "conflict") {
        this.d.say("Someone changed this block just now. Look again before deleting it.");
        return null;
      }
      if (code(e) !== "not_found") return this.fail(e) || null;
    }
    m.remove("blocks", id);
    this.d.emit("block.saved", { id });
    for (const [aid, a] of attached) {
      await this.d.arrows.delete(aid, { ifRev: a.rev }).catch(() => undefined);
      m.remove("arrows", aid);
      this.d.emit("arrow.saved", { id: aid });
    }
    this.d.changed();
    this.wrote();
    const block = b.data;
    return {
      undo: async () => {
        try {
          const doc = await this.d.blocks.set(id, block, { ifRev: 0 });
          m.upsertBlock(id, doc.data, doc.rev);
          this.d.emit("block.saved", { id });
          for (const [aid, a] of attached) {
            const d = await this.d.arrows.set(aid, a.data, { ifRev: 0 }).catch(() => null);
            if (d) {
              m.upsertArrow(aid, d.data, d.rev);
              this.d.emit("arrow.saved", { id: aid });
            }
          }
          this.d.changed();
        } catch (e) {
          this.fail(e);
        }
      },
    };
  }

  /** Read one document again (a peer said it changed), or drop it when it is gone. */
  async refetch(collection: "blocks" | "arrows", id: string): Promise<void> {
    const coll = collection === "blocks" ? this.d.blocks : this.d.arrows;
    try {
      const doc = await coll.get(id);
      const m = this.d.model;
      // A block this viewer is saving, dragging, resizing or editing keeps its local copy (which a
      // drag's drop and a text edit's base are read from) and is read again once that is over.
      if (collection === "blocks" && this.held(id)) {
        this.deferred.add(id);
        return;
      }
      if (doc === null) m.remove(collection, id);
      else if (collection === "blocks") m.upsertBlock(doc.id, doc.data, doc.rev);
      else m.upsertArrow(doc.id, doc.data, doc.rev);
      this.d.changed();
    } catch {
      // The next snapshot catches up.
    }
  }

  private held(id: string): boolean {
    return this.running.has(id) || this.d.busy?.(id) === true;
  }

  /**
   * This viewer is done with a block (a gesture or a text edit ended, or its save settled): read it
   * again if a peer saved it meanwhile. A save that started keeps it deferred until that settles.
   */
  release(id: string): void {
    if (!this.deferred.has(id) || this.held(id)) return;
    this.deferred.delete(id);
    void this.refetch("blocks", id);
  }

  /** Whether a block has a write in flight (its local copy is ahead of the server's). */
  saving(id: string): boolean {
    return this.running.has(id);
  }
}
