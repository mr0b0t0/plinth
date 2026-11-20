// Aligning the two sides of one changed region by what their blocks say: one rule for HTML and
// board text runs, doc blocks and list items, slides and boards. Two blocks are alike by the
// content words they share (Jaccard overlap of their word sets), and the region's old and new
// blocks are aligned in order so that the total likeness is as high as it can be (a weighted
// longest common subsequence). A block is never paired with another only because of where it is:
// a paragraph inserted next to an edited one shares no content words with it and reads as added.
import { CHANGE_LIMITS } from "./limits.ts";
import type { Paired } from "./pairs.ts";

/**
 * Words that say nothing about what a text is about: the 50 most common English function words
 * of three letters or more (shorter words are never content words). Two texts that share only
 * these are not alike.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "has",
  "had",
  "not",
  "but",
  "are",
  "was",
  "were",
  "will",
  "would",
  "can",
  "could",
  "should",
  "its",
  "they",
  "them",
  "their",
  "there",
  "then",
  "than",
  "these",
  "those",
  "what",
  "which",
  "who",
  "when",
  "where",
  "how",
  "all",
  "any",
  "each",
  "some",
  "into",
  "about",
  "also",
  "been",
  "being",
  "our",
  "your",
  "his",
  "her",
  "she",
  "you",
]);

/** The least likeness (Jaccard overlap of content words) at which two blocks may pair. */
export const SIMILARITY_MIN = 0.3;

/** Scripts written without spaces between words: cut into overlapping pairs of characters. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const UNSPACED_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{M}]+/gu;

/**
 * A text's content words: lowercased after NFKC, made of letters (with their combining marks)
 * and digits only, three characters or longer, and not in STOPWORDS. Text in a script written
 * without spaces (Chinese, Japanese, Thai, Lao, Khmer, Myanmar) gives its overlapping pairs of
 * characters instead, as search engines index it, since it has no spaces to find words by.
 */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  const add = (w: string) => {
    if ([...w].length >= 3 && !STOPWORDS.has(w)) out.add(w);
  };
  for (const token of text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (!UNSPACED.test(token)) {
      add(token);
      continue;
    }
    for (const rest of token.split(UNSPACED_RUN)) if (rest !== "") add(rest);
    for (const run of token.match(UNSPACED_RUN) ?? []) {
      const chars = [...run];
      for (let k = 0; k + 1 < chars.length; k++) out.add(`${chars[k]}${chars[k + 1]}`);
    }
  }
  return out;
}

/** Every word of a text, of any length, function words included: lowercased after NFKC. */
function allWords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [],
  );
}

/**
 * Jaccard overlap of two sets: shared over all; 1 when both are empty, since two texts with no
 * words at all (a slide of only an image) say the same.
 */
function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (large.size === 0) return 1;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Whether Jaccard of sets this size can reach `bar`: it is at most the smaller over the larger. */
function canReach(a: number, b: number, bar: number): boolean {
  return Math.min(a, b) >= bar * Math.max(a, b);
}

/**
 * How alike two texts are, 0 to 1: the Jaccard overlap of their content words. Two texts with no
 * content words at all (a table of figures, "OK") compare all their words instead, and two with
 * no words at all are alike 1.
 */
export function similarity(a: string, b: string): number {
  const ca = contentWords(a);
  const cb = contentWords(b);
  return ca.size === 0 && cb.size === 0 ? jaccard(allWords(a), allWords(b)) : jaccard(ca, cb);
}

export interface AlignOptions<T> {
  /** What makes two blocks the same: equal keys are alike 1, and match even past the limits. */
  key: (x: T) => string;
  /** The visible text whose content words say how alike two blocks are. */
  text: (x: T) => string;
  /** Whether two blocks may pair at all (a heading only with a heading). Default: always. */
  compatible?: (x: T, y: T) => boolean;
}

/** An alignment: the pairs and the rest, in order, and whether the limits made it keys only. */
export interface Aligned<T> extends Paired<T> {
  /** False when the region passed alignCells or alignWork and only equal keys were matched. */
  aligned: boolean;
}

/**
 * Aligns the blocks of one changed region. Blocks pair when their keys are equal or they are alike
 * (`similarity`) by SIMILARITY_MIN or more, and the pairs are chosen in order on both sides to make
 * the summed likeness as high as it can be; between alignments equally alike, the one whose pairs
 * share more of all their words (short and function words included: "Row 3" over "Row 4") wins,
 * and then the one that pairs earlier blocks. Two blocks with no words at all are alike 1. Pairs
 * come in order, as do the old blocks left over (`removed`) and the new ones (`added`). A region
 * of more than CHANGE_LIMITS.alignCells old×new cells, or one whose word comparisons (counted from
 * the sizes of the sets compared) would pass CHANGE_LIMITS.alignWork, matches equal keys only
 * (each old block, in order, with the first new block of its key after the last match) and lists
 * the rest as removed and added: it is never paired by position.
 */
export function alignRegion<T>(
  before: readonly T[],
  after: readonly T[],
  options: AlignOptions<T>,
): Aligned<T> {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0)
    return { pairs: [], removed: [...before], added: [...after], aligned: true };
  if (n * m > CHANGE_LIMITS.alignCells) return equalKeysOnly(before, after, options.key);
  const ka = before.map(options.key);
  const kb = after.map(options.key);
  const wordsOf = (t: string) => {
    const all = allWords(t);
    const content = contentWords(t);
    return { all, content: content.size === 0 ? null : content };
  };
  const wa = before.map((x) => wordsOf(options.text(x)));
  const wb = after.map((y) => wordsOf(options.text(y)));
  // Which cells are compared, and what every comparison costs, known before any is made. A Jaccard
  // walks the smaller of its two sets, so a cell costs the smaller of the sets it compares (a text
  // without spaces has a character pair for nearly every character, not one word per run) plus
  // the smaller of the two all-word sets, for the tie.
  const compatible = options.compatible ?? (() => true);
  const EQUAL = 1;
  const COMPARE = 2;
  const plan = new Uint8Array(n * m);
  let work = 0;
  for (let i = 0; i < n; i++) {
    const a = wa[i] as (typeof wa)[number];
    for (let j = 0; j < m; j++) {
      const b = wb[j] as (typeof wb)[number];
      const tieCost = Math.min(a.all.size, b.all.size);
      if (ka[i] === kb[j]) {
        plan[i * m + j] = EQUAL;
        work += tieCost;
      } else if (compatible(before[i] as T, after[j] as T)) {
        const [x, y] = a.content || b.content ? [a.content, b.content] : [a.all, b.all];
        if (x && y && canReach(x.size, y.size, SIMILARITY_MIN)) {
          plan[i * m + j] = COMPARE;
          work += Math.min(x.size, y.size) + tieCost;
        }
      }
    }
    if (work > CHANGE_LIMITS.alignWork) return equalKeysOnly(before, after, options.key);
  }

  // For each cell, the likeness (0 when below SIMILARITY_MIN or not compatible) and, to choose
  // between alignments that are equally alike, the overlap of all words, function words included.
  const sim = new Float64Array(n * m);
  const tie = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    const a = wa[i] as (typeof wa)[number];
    for (let j = 0; j < m; j++) {
      const b = wb[j] as (typeof wb)[number];
      const cell = plan[i * m + j];
      let s = 0;
      if (cell === EQUAL) s = 1;
      else if (cell === COMPARE) {
        const [x, y] = a.content || b.content ? [a.content, b.content] : [a.all, b.all];
        s = jaccard(x as Set<string>, y as Set<string>);
      }
      if (s < SIMILARITY_MIN) continue;
      sim[i * m + j] = s;
      tie[i * m + j] = jaccard(a.all, b.all);
    }
  }
  // best[i][j]: the most likeness the first i old and first j new blocks can pair up to, then the
  // most overlap of all words; how[i][j]: the step that got there (pair, removal or addition).
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  const bestTie = new Float64Array((n + 1) * w);
  const how = new Uint8Array((n + 1) * w);
  const PAIR = 0;
  const REMOVE = 1;
  const ADD = 2;
  const EPS = 1e-9;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const at = i * w + j;
      if (i === 0 || j === 0) {
        how[at] = i === 0 ? ADD : REMOVE;
        continue;
      }
      let v = -1;
      let t = -1;
      let step = REMOVE;
      // The first step considered wins a full tie. Read back from the end, leaving the later
      // blocks unpaired first means a tie pairs the earlier ones: an old paragraph equally like
      // two new ones pairs with the first, and the second was added after it.
      const consider = (cv: number, ct: number, cs: number) => {
        if (cv > v + EPS || (cv > v - EPS && ct > t + EPS)) {
          v = cv;
          t = ct;
          step = cs;
        }
      };
      consider(best[at - 1] as number, bestTie[at - 1] as number, ADD);
      consider(best[at - w] as number, bestTie[at - w] as number, REMOVE);
      const s = sim[(i - 1) * m + (j - 1)] as number;
      if (s > 0) {
        const d = at - w - 1;
        consider(
          (best[d] as number) + s,
          (bestTie[d] as number) + (tie[(i - 1) * m + (j - 1)] as number),
          PAIR,
        );
      }
      best[at] = v;
      bestTie[at] = t;
      how[at] = step;
    }
  }
  const pairs: [T, T][] = [];
  const removed: T[] = [];
  const added: T[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = how[i * w + j];
    if (step === PAIR) {
      pairs.push([before[--i] as T, after[--j] as T]);
    } else if (step === REMOVE) {
      removed.push(before[--i] as T);
    } else {
      added.push(after[--j] as T);
    }
  }
  return {
    pairs: pairs.reverse(),
    removed: removed.reverse(),
    added: added.reverse(),
    aligned: true,
  };
}

/** Equal keys matched in order, first come first matched, in linear time; the rest unmatched. */
function equalKeysOnly<T>(
  before: readonly T[],
  after: readonly T[],
  key: (x: T) => string,
): Aligned<T> {
  const waiting = new Map<string, { at: number[]; next: number }>();
  for (const [j, y] of after.entries()) {
    const k = key(y);
    const q = waiting.get(k);
    if (q) q.at.push(j);
    else waiting.set(k, { at: [j], next: 0 });
  }
  const out: Aligned<T> = { pairs: [], removed: [], added: [], aligned: false };
  const taken = new Uint8Array(after.length);
  let last = -1;
  for (const x of before) {
    const q = waiting.get(key(x));
    if (q) while (q.next < q.at.length && (q.at[q.next] as number) <= last) q.next++;
    const j = q?.at[q.next];
    if (q && j !== undefined) {
      q.next++;
      last = j;
      taken[j] = 1;
      out.pairs.push([x, after[j] as T]);
    } else out.removed.push(x);
  }
  for (const [j, y] of after.entries()) if (!taken[j]) out.added.push(y);
  return out;
}
