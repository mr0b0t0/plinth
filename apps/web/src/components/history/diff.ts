// Pure diff logic for the compare page: a line diff of two documents, folding of long unchanged
// runs, unified and side-by-side row models, and asset changes between two versions.
// No React, no DOM: everything here is unit tested in diff.test.ts.
import type { AssetInfo } from "@plinth/shared";
import { diffArrays } from "diff";

export type LineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** 1-based line number in the old document (null for added lines). */
  oldNo: number | null;
  /** 1-based line number in the new document (null for removed lines). */
  newNo: number | null;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Both documents have the same lines. */
  identical: boolean;
  /**
   * False when the diff gave up (too slow or too different) and shows the changed middle as one
   * replaced block. Still correct, just not minimal.
   */
  exact: boolean;
}

export interface LineDiffOptions {
  /** Stop looking for a minimal diff after this many milliseconds. */
  timeoutMs?: number;
  /** Stop looking for a minimal diff beyond this many changed lines. */
  maxEditLength?: number;
}

/** Defaults that keep a 5,000-line document well under a frame budget on typical edits. */
export const DIFF_DEFAULTS: Required<LineDiffOptions> = { timeoutMs: 400, maxEditLength: 4000 };

/** Split text into lines. "\r\n" and "\r" count as line breaks; a final newline adds no line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff of two texts. Common leading and trailing lines are matched first (cheap, and the
 * usual shape of an edit); only the middle goes through the Myers diff, with a time and size cap.
 */
export function diffTextLines(
  oldText: string,
  newText: string,
  options: LineDiffOptions = {},
): LineDiff {
  const { timeoutMs, maxEditLength } = { ...DIFF_DEFAULTS, ...options };
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const context = (text: string) =>
    lines.push({ kind: "context", text, oldNo: oldNo++, newNo: newNo++ });
  const removed = (text: string) =>
    lines.push({ kind: "removed", text, oldNo: oldNo++, newNo: null });
  const added = (text: string) => lines.push({ kind: "added", text, oldNo: null, newNo: newNo++ });

  for (let i = 0; i < start; i++) context(a[i] as string);

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let exact = true;
  if (midA.length === 0) for (const t of midB) added(t);
  else if (midB.length === 0) for (const t of midA) removed(t);
  else {
    const changes = diffArrays(midA, midB, { timeout: timeoutMs, maxEditLength });
    if (changes) {
      for (const c of changes) {
        const emit = c.added ? added : c.removed ? removed : context;
        for (const t of c.value) emit(t);
      }
    } else {
      exact = false;
      for (const t of midA) removed(t);
      for (const t of midB) added(t);
    }
  }

  for (let i = endA; i < a.length; i++) context(a[i] as string);

  let addedCount = 0;
  let removedCount = 0;
  for (const l of lines) {
    if (l.kind === "added") addedCount++;
    else if (l.kind === "removed") removedCount++;
  }
  return {
    lines,
    added: addedCount,
    removed: removedCount,
    identical: addedCount === 0 && removedCount === 0,
    exact,
  };
}

// ---------- folding ----------

export type DiffBlock =
  | { type: "lines"; lines: DiffLine[] }
  /** A run of unchanged lines hidden behind an expander. `id` is stable for one diff. */
  | { type: "fold"; id: string; lines: DiffLine[] };

/**
 * Group lines into visible blocks and folds. Unchanged runs keep `context` lines next to each
 * change; anything longer than that (by at least `minFold` lines) is folded.
 */
export function foldUnchanged(lines: DiffLine[], context = 3, minFold = 4): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let visible: DiffLine[] = [];
  const flush = () => {
    if (visible.length) blocks.push({ type: "lines", lines: visible });
    visible = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.kind !== "context") {
      visible.push(line);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && (lines[j] as DiffLine).kind === "context") j++;
    const run = lines.slice(i, j);
    const keepBefore = i === 0 ? 0 : context; // after a change
    const keepAfter = j === lines.length ? 0 : context; // before a change
    if (run.length - keepBefore - keepAfter >= minFold) {
      visible.push(...run.slice(0, keepBefore));
      flush();
      const hidden = run.slice(keepBefore, run.length - keepAfter);
      blocks.push({ type: "fold", id: `fold-${hidden[0]?.oldNo ?? i}`, lines: hidden });
      visible.push(...run.slice(run.length - keepAfter));
    } else {
      visible.push(...run);
    }
    i = j;
  }
  flush();
  return blocks;
}

/** One row of the unified view: a line, or a folded run with its size. */
export type UnifiedRow =
  | { type: "line"; line: DiffLine }
  | { type: "fold"; id: string; count: number; firstOld: number; firstNew: number };

/** Rows of the unified view, with folds in `expanded` opened. */
export function unifiedRows(blocks: DiffBlock[], expanded: ReadonlySet<string>): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const b of blocks) {
    if (b.type === "fold" && !expanded.has(b.id)) {
      const first = b.lines[0];
      rows.push({
        type: "fold",
        id: b.id,
        count: b.lines.length,
        firstOld: first?.oldNo ?? 0,
        firstNew: first?.newNo ?? 0,
      });
    } else {
      for (const line of b.lines) rows.push({ type: "line", line });
    }
  }
  return rows;
}

/** One row of the side-by-side view. */
export type SplitRow =
  | { type: "pair"; left: DiffLine | null; right: DiffLine | null }
  | { type: "fold"; id: string; count: number; firstOld: number; firstNew: number };

/**
 * Side-by-side rows: unchanged lines sit on both sides; a run of removed lines is paired, line by
 * line, with the run of added lines that follows it.
 */
export function splitRows(rows: UnifiedRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] as UnifiedRow;
    if (row.type === "fold") {
      out.push(row);
      i++;
      continue;
    }
    if (row.line.kind === "context") {
      out.push({ type: "pair", left: row.line, right: row.line });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < rows.length) {
      const r = rows[i] as UnifiedRow;
      if (r.type !== "line" || r.line.kind !== "removed") break;
      removed.push(r.line);
      i++;
    }
    while (i < rows.length) {
      const r = rows[i] as UnifiedRow;
      if (r.type !== "line" || r.line.kind !== "added") break;
      added.push(r.line);
      i++;
    }
    const n = Math.max(removed.length, added.length);
    for (let k = 0; k < n; k++) {
      out.push({ type: "pair", left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return out;
}

// ---------- assets ----------

export type AssetChangeKind = "added" | "removed" | "changed" | "same";

export interface AssetChange {
  path: string;
  kind: AssetChangeKind;
  /** Size in the old version (absent when added). */
  before?: number;
  /** Size in the new version (absent when removed). */
  after?: number;
}

/**
 * Asset changes between two versions, by path. Only sizes are known, so a file with the same path
 * and size counts as "same" (it may still differ byte for byte). Sorted: added, removed, changed,
 * same, then by path.
 */
export function diffAssets(before: AssetInfo[], after: AssetInfo[]): AssetChange[] {
  const old = new Map(before.map((a) => [a.path, a.size_bytes]));
  const next = new Map(after.map((a) => [a.path, a.size_bytes]));
  const out: AssetChange[] = [];
  for (const [path, size] of next) {
    const was = old.get(path);
    if (was === undefined) out.push({ path, kind: "added", after: size });
    else out.push({ path, kind: was === size ? "same" : "changed", before: was, after: size });
  }
  for (const [path, size] of old) {
    if (!next.has(path)) out.push({ path, kind: "removed", before: size });
  }
  const order: Record<AssetChangeKind, number> = { added: 0, removed: 1, changed: 2, same: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.path.localeCompare(y.path));
}
