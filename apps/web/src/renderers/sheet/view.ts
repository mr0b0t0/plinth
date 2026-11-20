// Sort and filter, for the viewer only: they reorder and hide rows on the page, formulas are always
// computed in the stored order, and nothing is saved.
import { compareValues, isError, type Value } from "@plinth/shared";

export type SortDirection = "ascending" | "descending";
export interface SortState {
  col: number;
  dir: SortDirection;
}

/** The next state when a column's header is clicked: ascending, descending, then off. */
export function nextSort(current: SortState | null, col: number): SortState | null {
  if (!current || current.col !== col) return { col, dir: "ascending" };
  return current.dir === "ascending" ? { col, dir: "descending" } : null;
}

/** Rank for sorting: empty cells always last, errors just before them. */
function rank(v: Value): number {
  if (v === null || v === "") return 2;
  return isError(v) ? 1 : 0;
}

/**
 * Row indexes in display order for a sort (stable; ties keep the stored order). `value(i)` is
 * row i's value in the sorted column.
 */
export function sortedOrder(
  count: number,
  value: (i: number) => Value,
  sort: SortState | null,
): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (!sort) return order;
  const sign = sort.dir === "ascending" ? 1 : -1;
  const vals = order.map(value);
  return order.sort((a, b) => {
    const va = vals[a] as Value;
    const vb = vals[b] as Value;
    const ra = rank(va);
    const rb = rank(vb);
    if (ra !== rb) return ra - rb;
    if (ra !== 0) return a - b;
    return sign * compareValues(va, vb) || a - b;
  });
}

/** Whether a row's shown texts contain the filter text, ignoring case. An empty filter matches. */
export function rowMatches(texts: readonly string[], filter: string): boolean {
  const q = filter.trim().toLocaleLowerCase();
  if (q === "") return true;
  return texts.some((t) => t.toLocaleLowerCase().includes(q));
}
