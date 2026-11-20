// Writing the board to shared data through the page runtime. Every change is a whole block or
// arrow written at the rev it was read at (ifRev), so nobody's write is lost silently. A block
// save carries only the fields the viewer changed: on a conflict the latest copy is read and those
// fields are put on top of it, up to four times, and a field someone else changed meanwhile keeps
// their value (the viewer is told). One write per block is in flight at a time, and later changes
// to it are folded into the next one. A refusal the viewer cannot fix (read_only, forbidden) turns
// the board read-only. A peer's save of a block this viewer is saving, dragging, resizing or
// editing the text of is read once that is over, so it never replaces what the viewer is in the
// middle of. A text edit is written at the rev it started from, so a peer's text saved meanwhile
// is a conflict: their text is kept, and the viewer is offered to put theirs back.
import { type BoardArrow, type BoardBlock, cleanBlock } from "@plinth/shared";
import type { BoardModel, Entry } from "./model.ts";
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
      return "Your access changed. Reload the page.";
    case "invalid":
      return "That change does not fit on a board.";
    default:
      return "Could not save. Check your connection and try again.";
  }
}

const code = (e: unknown) => (e as RuntimeError | undefined)?.code;

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
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const base = this.known.get(id);
      if (!base || !m.blocks.has(id)) return false;
      // Everything this change set was someone else's to keep: the board shows theirs.
      if (Object.keys(patch).length === 0) return true;
      const data: BoardBlock = { ...base.data, ...patch };
      try {
        const doc = await this.d.blocks.set(id, data, { ifRev: base.rev });
        this.known.set(id, { data, rev: doc.rev });
        // Keep what the viewer did since (a queued change goes next), at the new rev.
        m.blocks.set(id, { data: m.blocks.get(id)?.data ?? data, rev: doc.rev });
        this.d.emit("block.saved", { id });
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
        if (code(e) !== "conflict") return this.fail(e);
        // Someone else saved it: read theirs, then put this change's fields on top of it.
        const fresh = await this.d.blocks.get(id).catch(() => undefined);
        if (fresh === null) {
          m.remove("blocks", id);
          this.d.changed();
          this.d.say("Someone deleted this block.");
          return false;
        }
        if (fresh) {
          const theirs = cleanBlock(fresh.data) ?? base.data;
          patch = this.rebase(id, patch, base.data, theirs, fresh.rev);
        }
      }
    }
    this.d.say("Someone else kept changing this block. Try again.");
    return false;
  }

  /**
   * Take a newer server copy as the base. A field this change, or the change queued behind it,
   * sets that the other writer changed too keeps their value: the viewer made it without seeing
   * theirs. The rest stays. Returns what is left of this change.
   */
  private rebase(
    id: string,
    patch: BlockPatch,
    was: BoardBlock,
    theirs: BoardBlock,
    rev: number,
  ): BlockPatch {
    const left: BlockPatch = { ...patch };
    const queued = this.queued.get(id);
    let kept = false;
    /** The viewer's newest text, when theirs was kept instead: offered back to them. */
    let lostText: string | undefined;
    const keys = new Set([...Object.keys(patch), ...Object.keys(queued ?? {})]);
    for (const k of keys as Set<keyof BoardBlock>) {
      const mine = k in patch ? patch[k] : queued?.[k];
      if (same(theirs[k], was[k]) || same(theirs[k], mine)) continue;
      kept = true;
      if (k === "text") lostText = queued && "text" in queued ? queued.text : patch.text;
      delete left[k];
      if (queued) delete queued[k];
    }
    if (queued && Object.keys(queued).length === 0) this.queued.delete(id);
    this.known.set(id, { data: theirs, rev });
    this.d.model.blocks.set(id, { data: { ...theirs, ...left, ...queued }, rev });
    this.d.changed();
    if (kept && lostText !== undefined && lostText !== theirs.text) {
      const text = lostText;
      this.d.say(KEPT_THEIRS_TEXT, {
        label: USE_MINE_LABEL,
        run: () => void this.saveBlock(id, { text }),
      });
    } else if (kept) this.d.say(KEPT_THEIRS_TEXT);
    return left;
  }

  /** A new block; resolves to its id, or null when the server refused it. */
  async addBlock(data: BoardBlock): Promise<string | null> {
    if (this.stopped) return null;
    try {
      const doc = await this.d.blocks.add(data);
      this.d.model.upsertBlock(doc.id, doc.data, doc.rev);
      this.d.changed();
      this.d.emit("block.saved", { id: doc.id });
      return doc.id;
    } catch (e) {
      return this.fail(e) || null;
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
