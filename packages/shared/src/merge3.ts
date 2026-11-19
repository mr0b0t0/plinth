// A line-level three-way merge with no dependencies (#36): when a version is published while
// people have unsaved page edits on a doc, their draft is rebased onto it when that is safe, and
// frozen for review when it is not. The rule is deliberately conservative, because a merge must
// never drop text: a change made on only one side is taken; the same change made on both sides is
// taken once; changes that overlap or touch (adjacent lines, or an insert at the edge of another
// change) and differ are a conflict. A diff of more than `maxEdits` line edits is a conflict too.
//
// With `rows` (a sheet, where each line is one row), changes that only touch merge: a row
// changed on one side next to a row changed on the other keeps both, and so do an insert and a
// change beside it. Rows inserted at the same place on both sides still conflict unless they are
// the same, and changes that overlap still do.
//
// A line merge knows nothing of what the lines mean. A type whose lines refer to each other by
// position (a sheet's formulas and columns) passes `refuse`, which sees both sides' hunks and turns
// a clean line merge into a review (`refused`).
//
// The diff is Myers' O((N+M)D) algorithm in its linear-space form (the middle snake, divide and
// conquer), on lines interned to integers, after trimming the common prefix and suffix.
import { LIVE_DOC } from "./liveDoc.ts";

/** Base lines [aStart, aEnd) became the other text's lines [bStart, bEnd). */
export interface LineHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface LineDiff {
  hunks: LineHunk[];
  /** Line edits (deleted plus inserted lines). */
  edits: number;
  /** Steps the diff took: a measure of its cost that tests can bound without a clock. */
  work: number;
}

/** A region both sides changed differently, in base line numbers. */
export interface Merge3Conflict {
  baseStart: number;
  baseEnd: number;
  ours: string[];
  theirs: string[];
}

export type Merge3Result =
  | { clean: true; text: string; work: number }
  | {
      clean: false;
      /**
       * `too_large`: a diff had more than maxEdits edits, so nothing was compared. `refused`: the
       * lines merged, but `refuse` said the result would not mean what either side meant.
       */
      reason: "conflict" | "too_large" | "refused";
      conflicts: Merge3Conflict[];
      work: number;
    };

/** What `refuse` sees: the three texts' lines and how each side changed the base. */
export interface Merge3Sides {
  base: readonly string[];
  ours: readonly string[];
  theirs: readonly string[];
  oursHunks: readonly LineHunk[];
  theirsHunks: readonly LineHunk[];
}

interface DiffState {
  a: Int32Array;
  b: Int32Array;
  hunks: LineHunk[];
  edits: number;
  work: number;
  maxEdits: number;
}

class TooManyEdits extends Error {}

function intern(x: readonly string[], y: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (lines: readonly string[]) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] as string;
      let id = ids.get(l);
      if (id === undefined) {
        id = ids.size;
        ids.set(l, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(x), map(y)];
}

function pushHunk(s: DiffState, aStart: number, aEnd: number, bStart: number, bEnd: number) {
  s.edits += aEnd - aStart + (bEnd - bStart);
  if (s.edits > s.maxEdits) throw new TooManyEdits();
  const last = s.hunks[s.hunks.length - 1];
  if (last && last.aEnd === aStart && last.bEnd === bStart) {
    last.aEnd = aEnd;
    last.bEnd = bEnd;
  } else s.hunks.push({ aStart, aEnd, bStart, bEnd });
}

/** Diff a[a0, a1) against b[b0, b1), appending hunks in order. */
function diffRange(s: DiffState, a0: number, a1: number, b0: number, b1: number): void {
  const { a, b } = s;
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    a0++;
    b0++;
    s.work++;
  }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
    a1--;
    b1--;
    s.work++;
  }
  if (a0 === a1 && b0 === b1) return;
  if (a0 === a1 || b0 === b1) {
    pushHunk(s, a0, a1, b0, b1);
    return;
  }
  const split = middleSnake(s, a0, a1, b0, b1);
  if (!split) {
    pushHunk(s, a0, a1, b0, b1);
    return;
  }
  diffRange(s, a0, split[0], b0, split[1]);
  diffRange(s, split[0], a1, split[1], b1);
}

/**
 * The point where a shortest edit path crosses the middle (Myers 1986, section 4b), searching
 * from both ends at once. Returns absolute indexes, or null when the ranges share nothing.
 */
function middleSnake(
  s: DiffState,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): [number, number] | null {
  const { a, b } = s;
  const n = a1 - a0;
  const m = b1 - b0;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    // This range needs more than 2d - 1 edits by now; stop early when that is over budget.
    if (s.edits + 2 * d - 1 > s.maxEdits) throw new TooManyEdits();
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      s.work++;
      const k1o = off + k1;
      let x1 =
        k1 === -d || (k1 !== d && (v1[k1o - 1] as number) < (v1[k1o + 1] as number))
          ? (v1[k1o + 1] as number)
          : (v1[k1o - 1] as number) + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[a0 + x1] === b[b0 + y1]) {
        x1++;
        y1++;
        s.work++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1) {
          const x2 = n - (v2[k2o] as number);
          if (x1 >= x2) return [a0 + x1, b0 + y1];
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      s.work++;
      const k2o = off + k2;
      let x2 =
        k2 === -d || (k2 !== d && (v2[k2o - 1] as number) < (v2[k2o + 1] as number))
          ? (v2[k2o + 1] as number)
          : (v2[k2o - 1] as number) + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[a0 + n - x2 - 1] === b[b0 + m - y2 - 1]) {
        x2++;
        y2++;
        s.work++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o] as number;
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return [a0 + x1, b0 + y1];
        }
      }
    }
  }
  return null;
}

/**
 * The line hunks that turn `a` into `b`, in order and never touching each other, or null when
 * that takes more than `maxEdits` line edits.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number = LIVE_DOC.maxMergeEdits,
): LineDiff | null {
  const [ia, ib] = intern(a, b);
  const s: DiffState = { a: ia, b: ib, hunks: [], edits: 0, work: 0, maxEdits };
  try {
    diffRange(s, 0, ia.length, 0, ib.length);
  } catch (e) {
    if (e instanceof TooManyEdits) return null;
    throw e;
  }
  return { hunks: s.hunks, edits: s.edits, work: s.work };
}

interface Tagged extends LineHunk {
  side: 0 | 1;
}

/** One side's text for base lines [from, to): base lines, with that side's hunks applied. */
function sideText(
  base: readonly string[],
  side: readonly string[],
  hunks: readonly Tagged[],
  from: number,
  to: number,
): string[] {
  const out: string[] = [];
  let pos = from;
  for (const h of hunks) {
    for (let i = pos; i < h.aStart; i++) out.push(base[i] as string);
    for (let i = h.bStart; i < h.bEnd; i++) out.push(side[i] as string);
    pos = h.aEnd;
  }
  for (let i = pos; i < to; i++) out.push(base[i] as string);
  return out;
}

function sameLines(x: readonly string[], y: readonly string[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Whether a hunk belongs to the cluster that ends at base line `end`: it overlaps it or, for
 * text, touches it. For rows, touching joins only an insert at the same place as another insert.
 */
function joins(h: Tagged, cluster: readonly Tagged[], end: number, rows: boolean): boolean {
  if (h.aStart < end) return true;
  if (h.aStart > end) return false;
  if (!rows) return true;
  return h.aStart === h.aEnd && cluster.some((c) => c.aStart === c.aEnd && c.aStart === end);
}

/**
 * Merge two edits of the same base text, line by line. `ours` is the live draft, `theirs` the
 * version published meanwhile. Texts are split on "\n" and joined back the same way, so a
 * trailing newline is a line like any other.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  opts: {
    maxEdits?: number;
    rows?: boolean;
    /** Asked about a merge whose lines merged cleanly (both sides changed): true makes it `refused`. */
    refuse?: ((sides: Merge3Sides) => boolean) | undefined;
  } = {},
): Merge3Result {
  if (ours === theirs || theirs === base) return { clean: true, text: ours, work: 0 };
  if (ours === base) return { clean: true, text: theirs, work: 0 };
  const maxEdits = opts.maxEdits ?? LIVE_DOC.maxMergeEdits;
  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");
  const dOurs = diffLines(b, o, maxEdits);
  const dTheirs = dOurs && diffLines(b, t, maxEdits);
  if (!dOurs || !dTheirs) {
    return {
      clean: false,
      reason: "too_large",
      conflicts: [],
      work: (dOurs?.work ?? 0) + (dTheirs?.work ?? 0),
    };
  }
  const work = dOurs.work + dTheirs.work;
  const all: Tagged[] = [
    ...dOurs.hunks.map((h) => ({ ...h, side: 0 as const })),
    ...dTheirs.hunks.map((h) => ({ ...h, side: 1 as const })),
  ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd || x.side - y.side);

  const out: string[] = [];
  const conflicts: Merge3Conflict[] = [];
  let pos = 0;
  let i = 0;
  while (i < all.length) {
    // A cluster: hunks whose base ranges overlap or touch, chained.
    const first = all[i] as Tagged;
    const cluster: Tagged[] = [first];
    let start = first.aStart;
    let end = first.aEnd;
    i++;
    while (i < all.length && joins(all[i] as Tagged, cluster, end, opts.rows === true)) {
      const h = all[i] as Tagged;
      cluster.push(h);
      start = Math.min(start, h.aStart);
      end = Math.max(end, h.aEnd);
      i++;
    }
    for (let k = pos; k < start; k++) out.push(b[k] as string);
    const mine = cluster.filter((h) => h.side === 0);
    const yours = cluster.filter((h) => h.side === 1);
    const oursText = sideText(b, o, mine, start, end);
    const theirsText = sideText(b, t, yours, start, end);
    if (yours.length === 0) out.push(...oursText);
    else if (mine.length === 0) out.push(...theirsText);
    else if (sameLines(oursText, theirsText)) out.push(...oursText);
    else conflicts.push({ baseStart: start, baseEnd: end, ours: oursText, theirs: theirsText });
    pos = end;
  }
  for (let k = pos; k < b.length; k++) out.push(b[k] as string);
  if (conflicts.length > 0) return { clean: false, reason: "conflict", conflicts, work };
  const sides = { base: b, ours: o, theirs: t, oursHunks: dOurs.hunks, theirsHunks: dTheirs.hunks };
  if (opts.refuse?.(sides)) return { clean: false, reason: "refused", conflicts: [], work };
  return { clean: true, text: out.join("\n"), work };
}
