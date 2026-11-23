// Where a doc's "Comment" points (doc-blocks). The person asks about a block of the
// draft they are editing, but the agent reads the published version, where blocks above may have
// been added, moved or deleted since. So the key names the published block: the draft's blocks are
// matched to the published ones by their Markdown (the longest common run, in order), and a draft
// block with no match is named by the published block above it.
//
//   block-3            the published version's third top-level block
//   new-3              a block only in the draft, after published block 3 (new-0: before the first)
//   …:image            the image in that block (replace it)
//   …:add-image        a new image below that block
import { splitLines } from "@plinth/shared";
import { parseBlocks } from "./blocks.ts";

/** What an Ask about a block asks for its image: to replace it, to add one below, or neither. */
export type AskImage = "replace" | "add" | null;

/** The top-level blocks of a doc, as their own Markdown (their core lines). */
function blockCores(text: string): string[] {
  const lines = splitLines(text);
  return parseBlocks(text).map((b) => lines.slice(b.core.start, b.core.end).join("\n"));
}

/**
 * For each draft block, the index of the published block it is (the same Markdown, matched in
 * order by the longest common subsequence), or -1 for a block the published version lacks.
 */
export function matchBlocks(draft: readonly string[], published: readonly string[]): number[] {
  const n = draft.length;
  const m = published.length;
  // lcs[i][j]: the longest common subsequence of draft[i..] and published[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const below = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        draft[i] === published[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (draft[i] === published[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      i++;
    } else j++;
  }
  return out;
}

/**
 * The key of draft block `index` (0-based) as the published version names it, and whether that
 * block is published as it is in the draft.
 */
export function askKey(
  draft: string,
  published: string,
  index: number,
  image: AskImage = null,
): { key: string; published: boolean } {
  const match = matchBlocks(blockCores(draft), blockCores(published));
  const at = match[index] ?? -1;
  let where: string;
  if (at >= 0) where = `block-${at + 1}`;
  else {
    let above = 0;
    for (let i = Math.min(index, match.length) - 1; i >= 0; i--) {
      const p = match[i] as number;
      if (p >= 0) {
        above = p + 1;
        break;
      }
    }
    where = `new-${above}`;
  }
  const key =
    image === "replace" ? `${where}:image` : image === "add" ? `${where}:add-image` : where;
  return { key, published: at >= 0 };
}
