// Pairing the two sides of one changed region: the items of a region that differs are matched in
// order, so "the second paragraph became this" reads as one change, not a removal and an addition.

export interface Paired<T> {
  /** Matched in order: [before, after]. */
  pairs: [T, T][];
  /** Before items with no match. */
  removed: T[];
  /** After items with no match. */
  added: T[];
}

/** How far ahead `pairInOrder` looks for a better match, so a large region stays linear. */
const LOOKAHEAD = 32;

/**
 * Matches `before[k]` with `after[k]` while both exist and `alike` holds; the rest of the region is
 * removed and added. Order is kept on both sides. With `prefer`, an alike pair that `prefer` does
 * not hold for is skipped when either side has a preferred match a little further on: a row added
 * above a "Total" row reads as one added row, not as every cell of "Total" changed.
 */
export function pairInOrder<T>(
  before: readonly T[],
  after: readonly T[],
  alike: (a: T, b: T) => boolean = () => true,
  prefer?: (a: T, b: T) => boolean,
): Paired<T> {
  const out: Paired<T> = { pairs: [], removed: [], added: [] };
  const ahead = (list: readonly T[], from: number, test: (x: T) => boolean) => {
    for (let k = from; k < list.length && k < from + LOOKAHEAD; k++) {
      if (test(list[k] as T)) return true;
    }
    return false;
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const a = before[i] as T;
    const b = after[j] as T;
    if (alike(a, b)) {
      if (prefer && !prefer(a, b)) {
        if (ahead(after, j + 1, (x) => alike(a, x) && prefer(a, x))) {
          out.added.push(b);
          j++;
          continue;
        }
        if (ahead(before, i + 1, (x) => alike(x, b) && prefer(x, b))) {
          out.removed.push(a);
          i++;
          continue;
        }
      }
      out.pairs.push([a, b]);
      i++;
      j++;
    } else if (before.length - i > after.length - j) {
      out.removed.push(a);
      i++;
    } else {
      out.added.push(b);
      j++;
    }
  }
  for (; i < before.length; i++) out.removed.push(before[i] as T);
  for (; j < after.length; j++) out.added.push(after[j] as T);
  return out;
}

/** One step of a changed region: a removal (`x`), an addition (`y`) or a pair (both). */
export type RegionStep<T> = { x: T; y?: undefined } | { x?: undefined; y: T } | { x: T; y: T };

/**
 * A changed region's removals, pairs and additions in reading order, each with a sort key: a pair
 * or an addition sits at its position in the new version, a removal just after the pair before it
 * (or at the start of the region). `aAt` and `bAt` give positions in the old and new version.
 */
export function inReadingOrder<T>(
  p: Paired<T>,
  aAt: (x: T) => number,
  bAt: (y: T) => number,
  bStart: number,
): { key: number; step: RegionStep<T> }[] {
  const out: { key: number; step: RegionStep<T> }[] = [];
  for (const [x, y] of p.pairs) out.push({ key: bAt(y), step: { x, y } });
  for (const y of p.added) out.push({ key: bAt(y), step: { y } });
  // Removals and pairs are both in old-version order: one pass, so a large region stays linear.
  let key = bStart - 0.5;
  let k = 0;
  for (const x of p.removed) {
    for (; k < p.pairs.length && aAt((p.pairs[k] as [T, T])[0]) < aAt(x); k++) {
      key = bAt((p.pairs[k] as [T, T])[1]) + 0.5;
    }
    out.push({ key, step: { x } });
  }
  // A stable sort: a removal and the pairs keep their own order on equal keys.
  return out.sort((u, v) => u.key - v.key);
}

/** Whether two texts share a word of four or more letters, ignoring case. */
export function sharesWord(a: string, b: string): boolean {
  const words = (t: string) =>
    t
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4);
  const seen = new Set(words(a));
  return words(b).some((w) => seen.has(w));
}

/**
 * Multiset difference of two lists of keys: what `after` has more of, and what `before` has more
 * of, each in first-seen order.
 */
export function multisetChanges(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const tally = new Map<string, number>();
  for (const k of before) tally.set(k, (tally.get(k) ?? 0) - 1);
  for (const k of after) tally.set(k, (tally.get(k) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, n] of tally) {
    for (let x = 0; x < n; x++) added.push(k);
    for (let x = 0; x < -n; x++) removed.push(k);
  }
  return { added, removed };
}
