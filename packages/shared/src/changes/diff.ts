// Sequence diffs for change lists (moved from the web app's history/diff.ts): two lists of keys
// (lines, blocks, slides, rows, text runs) become the regions that differ. Common leading and
// trailing items are matched first (cheap, and the usual shape of an edit); only the middle goes
// through the Myers diff of `diff`, with an edit cap and a time cap. When either cap is reached the
// middle is anchored instead (`anchoredHunks`): items found once on each side keep their place, so
// an insertion does not shift every later pair. Still correct, just not minimal.
import { diffArrays } from "diff";
import { CHANGE_LIMITS } from "./limits.ts";

/** Items [aStart, aEnd) of the first list became items [bStart, bEnd) of the second. */
export interface SequenceHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface SequenceDiff {
  hunks: SequenceHunk[];
  /** False when a cap was reached and the changed middle was anchored instead (not minimal). */
  exact: boolean;
}

export interface SequenceDiffOptions {
  /** Stop looking for a minimal diff beyond this many changed items. */
  maxEdits?: number;
  /** Stop looking for a minimal diff after this many milliseconds. */
  timeoutMs?: number;
}

/** The regions where `a` and `b` differ, in order. */
export function diffSequence(
  a: readonly string[],
  b: readonly string[],
  options: SequenceDiffOptions = {},
): SequenceDiff {
  const maxEdits = options.maxEdits ?? CHANGE_LIMITS.maxEdits;
  const timeoutMs = options.timeoutMs ?? CHANGE_LIMITS.timeoutMs;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return { hunks: [], exact: true };
  if (start === endA || start === endB) {
    return { hunks: [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }], exact: true };
  }
  const changes = diffArrays(a.slice(start, endA), b.slice(start, endB), {
    timeout: timeoutMs,
    maxEditLength: maxEdits,
  });
  if (!changes) return { hunks: anchoredHunks(a, b, start, endA, endB), exact: false };
  const hunks: SequenceHunk[] = [];
  let i = start;
  let j = start;
  let open: SequenceHunk | null = null;
  for (const c of changes) {
    const n = c.count ?? c.value.length;
    if (!c.added && !c.removed) {
      if (open) hunks.push(open);
      open = null;
      i += n;
      j += n;
      continue;
    }
    open ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (c.removed) {
      i += n;
      open.aEnd = i;
    } else {
      j += n;
      open.bEnd = j;
    }
  }
  if (open) hunks.push(open);
  return { hunks, exact: true };
}

/**
 * The regions where `a[start, endA)` and `b[start, endB)` differ, found without the Myers diff, in
 * O(n log n): a patience diff of one level. Keys found exactly once on each side are anchors; the
 * longest run of them in the same order on both sides is kept unchanged, and each gap between two
 * anchors loses its common leading and trailing items. What is left of a gap is one region, so
 * the pairing inside it starts again at every anchor.
 */
function anchoredHunks(
  a: readonly string[],
  b: readonly string[],
  start: number,
  endA: number,
  endB: number,
): SequenceHunk[] {
  // For each key: how often it is in each side, and where (the last place seen).
  const seen = new Map<string, { na: number; nb: number; i: number; j: number }>();
  for (let i = start; i < endA; i++) {
    const k = a[i] as string;
    const s = seen.get(k);
    if (s) {
      s.na++;
      s.i = i;
    } else seen.set(k, { na: 1, nb: 0, i, j: -1 });
  }
  for (let j = start; j < endB; j++) {
    const s = seen.get(b[j] as string);
    if (!s) continue;
    s.nb++;
    s.j = j;
  }
  // Unique on both sides, in the order of `a`: the longest run increasing in `b` (patience sort).
  const candidates: [number, number][] = [];
  for (let i = start; i < endA; i++) {
    const s = seen.get(a[i] as string);
    if (s && s.na === 1 && s.nb === 1) candidates.push([i, s.j]);
  }
  const tails: number[] = []; // index into candidates of the smallest tail of each run length
  const back = new Int32Array(candidates.length);
  for (let c = 0; c < candidates.length; c++) {
    const j = (candidates[c] as [number, number])[1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((candidates[tails[mid] as number] as [number, number])[1] < j) lo = mid + 1;
      else hi = mid;
    }
    back[c] = lo > 0 ? (tails[lo - 1] as number) : -1;
    tails[lo] = c;
  }
  const anchors: [number, number][] = [];
  for (
    let c = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
    c >= 0;
    c = back[c] as number
  ) {
    anchors.push(candidates[c] as [number, number]);
  }
  anchors.reverse();
  anchors.push([endA, endB]);

  const hunks: SequenceHunk[] = [];
  let i = start;
  let j = start;
  for (const [ai, bj] of anchors) {
    let aEnd = ai;
    let bEnd = bj;
    while (i < aEnd && j < bEnd && a[i] === b[j]) {
      i++;
      j++;
    }
    while (aEnd > i && bEnd > j && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    if (i < aEnd || j < bEnd) hunks.push({ aStart: i, aEnd, bStart: j, bEnd });
    i = ai + 1;
    j = bj + 1;
  }
  return hunks;
}
