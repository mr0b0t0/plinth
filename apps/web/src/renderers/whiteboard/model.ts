// The board as the renderer holds it: blocks and arrows by id, each with the rev it was read at.
// Pure: no DOM. Every document is passed through the shared lenient readers (cleanBlock,
// cleanArrow), so whatever a stored row holds, what is drawn is in bounds and well formed.
import {
  BOARD_LIMITS,
  type BoardArrow,
  type BoardBlock,
  cleanArrow,
  cleanBlock,
  isBoardId,
} from "@plinth/shared";

export interface Entry<T> {
  data: T;
  /** The rev the data was read at; 0 for a block that exists only here (not yet saved). */
  rev: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A document as a snapshot or a single read gives it. */
export interface DocIn {
  id: string;
  data: unknown;
  rev: number;
}

export class BoardModel {
  readonly blocks = new Map<string, Entry<BoardBlock>>();
  readonly arrows = new Map<string, Entry<BoardArrow>>();

  /** Put a block, unless the copy held is newer. Returns whether it changed the model. */
  upsertBlock(id: string, data: unknown, rev: number): boolean {
    const clean = isBoardId(id) ? cleanBlock(data) : null;
    if (!clean) return false;
    const cur = this.blocks.get(id);
    if (cur && rev < cur.rev) return false;
    this.blocks.set(id, { data: clean, rev });
    return true;
  }

  upsertArrow(id: string, data: unknown, rev: number): boolean {
    const clean = isBoardId(id) ? cleanArrow(data) : null;
    if (!clean) return false;
    const cur = this.arrows.get(id);
    if (cur && rev < cur.rev) return false;
    this.arrows.set(id, { data: clean, rev });
    return true;
  }

  /** A whole collection as read: replaces what the model held for it. */
  applySnapshot(collection: "blocks" | "arrows", docs: readonly DocIn[]): void {
    const seen = new Set<string>();
    for (const d of docs) {
      seen.add(d.id);
      if (collection === "blocks") this.upsertBlock(d.id, d.data, d.rev);
      else this.upsertArrow(d.id, d.data, d.rev);
    }
    const map = collection === "blocks" ? this.blocks : this.arrows;
    for (const [id, e] of [...map]) if (!seen.has(id) && e.rev > 0) map.delete(id);
  }

  remove(collection: "blocks" | "arrows", id: string): void {
    (collection === "blocks" ? this.blocks : this.arrows).delete(id);
  }

  /** The arrows that start or end at a block. */
  arrowsOf(blockId: string): [string, Entry<BoardArrow>][] {
    return [...this.arrows].filter(([, a]) => a.data.from === blockId || a.data.to === blockId);
  }

  /**
   * Blocks in draw order: sections behind everything else, then z, then id. Arrows are drawn
   * between the two, so an arrow inside a section shows over its tint.
   */
  ordered(): [string, Entry<BoardBlock>][] {
    return [...this.blocks].sort(([ia, a], [ib, b]) => {
      const ds = Number(b.data.kind === "container") - Number(a.data.kind === "container");
      if (ds !== 0) return ds;
      const dz = (a.data.z ?? 0) - (b.data.z ?? 0);
      return dz !== 0 ? dz : ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  }

  /** The blocks lying wholly inside a section, which move with it (sections inside it stay). */
  inside(id: string): string[] {
    const s = this.blocks.get(id)?.data;
    if (s?.kind !== "container") return [];
    return [...this.blocks]
      .filter(
        ([bid, { data: b }]) =>
          bid !== id &&
          b.kind !== "container" &&
          b.x >= s.x &&
          b.y >= s.y &&
          b.x + b.w <= s.x + s.w &&
          b.y + b.h <= s.y + s.h,
      )
      .map(([bid]) => bid);
  }

  /** The highest z on the board, for a block brought to the front. */
  topZ(): number {
    let z = 0;
    for (const b of this.blocks.values()) z = Math.max(z, b.data.z ?? 0);
    return z;
  }

  /**
   * The z for a new block: in front of every other, but never past the largest z a block may have
   * (a block already there ties with it and the id breaks the tie).
   */
  nextZ(): number {
    return Math.min(BOARD_LIMITS.maxZ, this.topZ() + 1);
  }

  /** The box around every block, or null for an empty board. */
  bounds(): Bounds | null {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const { data: b } of this.blocks.values()) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
}
