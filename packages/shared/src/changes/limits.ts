// The change list's limits, in a module of their own so that both the collector (types.ts) and
// the text helpers (text.ts) can read them without importing each other.

export const CHANGE_LIMITS = {
  /** Items one list holds; the rest are summed up by `truncated`. */
  maxItems: 200,
  /** Longest excerpt of visible text in an item. */
  excerptChars: 160,
  /** Longest name quoted inside a sentence ("Heading “…” added"). */
  nameChars: 60,
  /**
   * Line or block edits a diff looks for before it reports the rest of the region as replaced, a
   * cost cap like merge3's maxEdits.
   */
  maxEdits: 4000,
  /** And the wall-clock cap of one diff, for inputs whose edits are few but costly to find. */
  timeoutMs: 400,
  /**
   * Old × new blocks of one changed region that `alignRegion` aligns by likeness; past this a
   * region matches equal blocks only and lists the rest as removed and added.
   */
  alignCells: 40_000,
  /** And the word comparisons it may make in one region, under the same fallback. */
  alignWork: 4_000_000,
  /** Formula steps a sheet may spend so that a calculation's results can be listed. */
  sheetEvalSteps: 1_000_000,
} as const;
