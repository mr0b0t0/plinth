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

/** Split text into lines. "\r\n" and "\r" count as line breaks; a final newline adds no line. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type TextLineKind = "context" | "added" | "removed";

export interface TextDiffLine {
  kind: TextLineKind;
  text: string;
  /** 1-based line number in the old text (null for added lines). */
  oldNo: number | null;
  /** 1-based line number in the new text (null for removed lines). */
  newNo: number | null;
}

export interface TextLineDiff {
  lines: TextDiffLine[];
  added: number;
  removed: number;
  /** Both texts have the same lines. */
  identical: boolean;
  /** False when the diff gave up and shows the changed middle as one replaced block. */
  exact: boolean;
}

/** Line diff of two texts: every line, marked unchanged, removed or added. */
export function diffTextLines(
  oldText: string,
  newText: string,
  options: SequenceDiffOptions = {},
): TextLineDiff {
  const a = textLines(oldText);
  const b = textLines(newText);
  const { hunks, exact } = diffSequence(a, b, options);
  const lines: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  const context = (to: number) => {
    while (i < to) lines.push({ kind: "context", text: a[i] as string, oldNo: ++i, newNo: ++j });
  };
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    context(h.aStart);
    for (; i < h.aEnd; removed++) {
      lines.push({ kind: "removed", text: a[i] as string, oldNo: ++i, newNo: null });
    }
    for (; j < h.bEnd; added++) {
      lines.push({ kind: "added", text: b[j] as string, oldNo: null, newNo: ++j });
    }
  }
  context(a.length);
  return { lines, added, removed, identical: added === 0 && removed === 0, exact };
}
