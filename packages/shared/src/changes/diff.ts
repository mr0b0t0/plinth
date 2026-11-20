// Sequence diffs for change lists (moved from the web app's history/diff.ts): two lists of keys
// (lines, blocks, slides, rows, text runs) become the regions that differ. Common leading and
// trailing items are matched first (cheap, and the usual shape of an edit); only the middle goes
// through the Myers diff of `diff`, with an edit cap and a time cap. When either cap is reached the
// middle is reported as one replaced region: still correct, just not minimal.
import { diffArrays } from "diff";
import { CHANGE_LIMITS } from "./types.ts";

/** Items [aStart, aEnd) of the first list became items [bStart, bEnd) of the second. */
export interface SequenceHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export interface SequenceDiff {
  hunks: SequenceHunk[];
  /** False when a cap was reached and the changed middle is one hunk. */
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
  if (!changes) {
    return { hunks: [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }], exact: false };
  }
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
