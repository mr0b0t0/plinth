// On-page doc editing (#36): the pure line and lease helpers the room and the doc renderer share.
// Kept apart from liveDoc.ts (which holds the zod frame schemas) so the renderer bundle, which every
// doc viewer loads, does not carry zod. Re-exported by liveDoc.ts; see the model described there.

export interface LineRange {
  start: number;
  /** Exclusive; equal to start for an insert point. */
  end: number;
}

/** The draft's lines. `joinLines(splitLines(t)) === t` for every text. */
export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

/** The lines an edit's text puts in place of its range: none for "" (the block was cleared). */
export function blockLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Do two leases collide? Ranges that share a line do; so does an insert point strictly inside
 * the other range, and two insert points at the same line. An insert point at either edge of a
 * block does not.
 */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  if (a.start < b.end && b.start < a.end) return true;
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return b.start < a.start && a.start < b.end;
  if (b.start === b.end) return a.start < b.start && b.start < a.end;
  return false;
}

/** A replacement of `del` lines at `start` by `ins` lines. */
export interface LineEdit {
  start: number;
  del: number;
  ins: number;
}

/**
 * Where another lease lies after an edit. The lease does not overlap the edited range (leases are
 * exclusive): a lease that starts at or after the edited range's end moves by the change in line
 * count, any other lies before it and stays. An insert point at the edited range's start counts
 * as before it, one at its end as after it.
 */
export function shiftRange(r: LineRange, e: LineEdit): LineRange {
  if (r.start >= e.start + e.del) {
    const d = e.ins - e.del;
    return { start: r.start + d, end: r.end + d };
  }
  return r;
}

/** The lines after replacing `del` lines at `start` with `ins`. Pure; the input is unchanged. */
export function applyLineEdit(
  lines: readonly string[],
  start: number,
  del: number,
  ins: readonly string[],
): string[] {
  return [...lines.slice(0, start), ...ins, ...lines.slice(start + del)];
}
