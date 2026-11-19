// Writing the board to shared data through the page runtime. Every change is a whole block or
// arrow written at the rev it was read at (ifRev), so nobody's write is lost silently: on a
// conflict the latest copy is read and the change applied on top of it, up to four times. One
// write per block is in flight at a time, and later changes to it are folded into the next one.
// A refusal the viewer cannot fix (read_only, forbidden) turns the board read-only.
import type { BoardArrow, BoardBlock } from "@plinth/shared";
import type { BoardModel } from "./model.ts";
import type { RuntimeCollection, RuntimeError } from "./runtime.ts";

export interface SyncDeps {
  blocks: RuntimeCollection;
  arrows: RuntimeCollection;
  model: BoardModel;
  /** The model changed: redraw. */
  changed(): void;
  /** The server refused a write this viewer cannot fix: stop offering edits. */
  readOnly(): void;
  /** A short message for the viewer. */
  say(text: string): void;
  /** Tell the room a block or arrow was saved (a no-op without a room). */
  emit(topic: "block.saved" | "arrow.saved", data: { id: string }): void;
  /** Waits; a test passes its own. */
  wait?(ms: number): Promise<void>;
}

const ATTEMPTS = 4;
/** The longest a rate-limited write waits before its one retry. */
const MAX_BACKOFF_MS = 30_000;

export const READ_ONLY_TEXT = "You can view this board but not change it.";

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
  private readonly queued = new Map<string, BoardBlock>();
  private readonly running = new Map<string, Promise<boolean>>();
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
   * Save a block's new data: shown at once, written behind. While a write of this block runs, the
   * newest data waits and goes next, so a drag that ends during a save makes one more write, not
   * many. Resolves true once the server has the data (or newer).
   */
  saveBlock(id: string, data: BoardBlock): Promise<boolean> {
    const m = this.d.model;
    const cur = m.blocks.get(id);
    if (!cur || this.stopped) return Promise.resolve(false);
    m.blocks.set(id, { data, rev: cur.rev });
    this.d.changed();
    this.queued.set(id, data);
    let running = this.running.get(id);
    if (!running) {
      running = this.drain(id).finally(() => this.running.delete(id));
      this.running.set(id, running);
    }
    return running;
  }

  /** Write this block's newest queued data until none is left. */
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

  private async write(id: string, data: BoardBlock): Promise<boolean> {
    const m = this.d.model;
    let backedOff = false;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const cur = m.blocks.get(id);
      if (!cur) return false;
      try {
        const doc = await this.d.blocks.set(id, data, { ifRev: cur.rev });
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
        // Someone else saved it: read theirs, then put this change on top of it.
        const fresh = await this.d.blocks.get(id).catch(() => undefined);
        if (fresh === null) {
          m.remove("blocks", id);
          this.d.changed();
          this.d.say("Someone deleted this block.");
          return false;
        }
        if (fresh) m.blocks.set(id, { data: m.blocks.get(id)?.data ?? data, rev: fresh.rev });
      }
    }
    this.d.say("Someone else kept changing this block. Try again.");
    return false;
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
      // A block this viewer is still saving keeps its local data until its write settles.
      if (collection === "blocks" && this.running.has(id)) return;
      if (doc === null) m.remove(collection, id);
      else if (collection === "blocks") m.upsertBlock(doc.id, doc.data, doc.rev);
      else m.upsertArrow(doc.id, doc.data, doc.rev);
      this.d.changed();
    } catch {
      // The next snapshot catches up.
    }
  }

  /** Whether a block has a write in flight (its local copy is ahead of the server's). */
  saving(id: string): boolean {
    return this.running.has(id);
  }
}
