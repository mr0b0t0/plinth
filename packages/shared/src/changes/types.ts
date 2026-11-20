// The change list's types, its collector and (from limits.ts) its limits, shared by every
// describer. Pure and zod-free: the app's Compare page imports it, and so can a renderer bundle or
// the room.
import type { AlignBudget } from "./align.ts";
import type { SequenceDiffOptions } from "./diff.ts";
import { CHANGE_LIMITS, changeClock } from "./limits.ts";
import { changeExcerpt, withoutBidi } from "./text.ts";

/** What happened to one thing a person can see. */
export type ChangeKind = "added" | "removed" | "changed" | "moved";

/**
 * One line of a change list, in plain language. Every string is text for a text node: a
 * describer never returns markup or source, only what a person sees on the page (visible text,
 * names, values and settings).
 */
export interface ChangeItem {
  kind: ChangeKind;
  /**
   * Where it is, for a person: "Under “Pricing”", "Slide 3", "Board “Home”", "Tokens". "" for the
   * artifact as a whole.
   */
  where: string;
  /** What happened, as a short sentence without its place: "Paragraph changed", "B7 changed". */
  what: string;
  /**
   * Visible text or the value before, at most CHANGE_LIMITS.excerptChars characters (the
   * collector cuts a longer one).
   */
  before?: string;
  /** Visible text or the value after, cut like `before`. */
  after?: string;
}

export interface ChangeList {
  items: ChangeItem[];
  /**
   * More changes were found than CHANGE_LIMITS.maxItems, a diff gave up on a large region, or the
   * list's deadline (CHANGE_LIMITS.totalMs) passed before every change was looked at.
   */
  truncated: boolean;
}

export { CHANGE_LIMITS, changeClock } from "./limits.ts";

/** `s` without bidi controls, or an excerpt of it when it is longer than CHANGE_LIMITS.excerptChars. */
function capped(s: string): string {
  const clean = withoutBidi(s);
  return clean.length > CHANGE_LIMITS.excerptChars ? changeExcerpt(clean) : clean;
}

/**
 * Collects items up to the cap, in the order they are found. It also cuts every `before` and
 * `after` longer than CHANGE_LIMITS.excerptChars, so the bound holds whatever a describer passes
 * (a 256-character token value, a long board or column name), and drops bidirectional controls
 * from every string, so no name or value can reorder how its item reads. It also holds the one
 * alignment budget that every changed region of the list draws on (`alignRegion`), so a version of
 * many regions cannot multiply the bound, and one deadline for the whole list
 * (CHANGE_LIMITS.totalMs): every diff gets at most the time left (`diffOptions`), and every loop
 * over lists, boards or regions stops once `done()`, so many small diffs cannot multiply
 * their own time cap either.
 */
export class ChangeCollector {
  readonly items: ChangeItem[] = [];
  truncated = false;
  /** Cells and word comparisons left to the alignments of this list: CHANGE_LIMITS.alignWork. */
  readonly alignBudget: AlignBudget = { left: CHANGE_LIMITS.alignWork };
  // A plain field, not a parameter property: Node loads this file with type stripping only (the
  // web build's config imports @plinth/shared).
  private readonly max: number;
  /** When the list stops looking, on changeClock. */
  private readonly deadline: number;
  constructor(max: number = CHANGE_LIMITS.maxItems, totalMs: number = CHANGE_LIMITS.totalMs) {
    this.max = max;
    this.deadline = changeClock.now() + totalMs;
  }

  /** Milliseconds left before the deadline; 0 once it has passed. */
  timeLeft(): number {
    return Math.max(0, this.deadline - changeClock.now());
  }

  /** A diff's options: its own time cap, or the time the list has left when that is less. */
  diffOptions(): SequenceDiffOptions {
    return { timeoutMs: Math.min(CHANGE_LIMITS.timeoutMs, this.timeLeft()) };
  }

  /**
   * True once the deadline has passed and a change has been found, in the list or among the
   * `pending` items a caller holds before it adds them; then the list is marked cut. A list cut by
   * time still names the first changes it found, never nothing.
   */
  expired(pending = 0): boolean {
    if (this.items.length + pending === 0 || changeClock.now() < this.deadline) return false;
    this.truncated = true;
    return true;
  }

  /**
   * True once the list is full or `expired`: the caller starts no more costly work (a region's
   * alignment, a list's or a board's diff) and marks the list cut when there is more to look at.
   * Items already found are still added.
   */
  done(pending = 0): boolean {
    return this.full || this.expired(pending);
  }

  /** Items the list still has room for. */
  get room(): number {
    return Math.max(0, this.max - this.items.length);
  }

  /** Adds the item; false once the list is full (the caller may stop looking). */
  add(item: ChangeItem): boolean {
    if (this.items.length >= this.max) {
      this.truncated = true;
      return false;
    }
    const clean: ChangeItem = {
      kind: item.kind,
      where: withoutBidi(item.where),
      what: withoutBidi(item.what),
    };
    const before = capped(item.before ?? "");
    const after = capped(item.after ?? "");
    if (before !== "") clean.before = before;
    if (after !== "") clean.after = after;
    this.items.push(clean);
    return true;
  }

  get full(): boolean {
    return this.items.length >= this.max;
  }

  list(): ChangeList {
    return { items: this.items, truncated: this.truncated };
  }
}
