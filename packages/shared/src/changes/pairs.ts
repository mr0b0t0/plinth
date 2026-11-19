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

/**
 * Matches `before[k]` with `after[k]` while both exist and `alike` holds; the rest of the region is
 * removed and added. Order is kept on both sides.
 */
export function pairInOrder<T>(
  before: readonly T[],
  after: readonly T[],
  alike: (a: T, b: T) => boolean = () => true,
): Paired<T> {
  const out: Paired<T> = { pairs: [], removed: [], added: [] };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const a = before[i] as T;
    const b = after[j] as T;
    if (alike(a, b)) {
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
