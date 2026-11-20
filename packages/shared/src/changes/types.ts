// The change list's types, its collector and (from limits.ts) its limits, shared by every
// describer. Pure and zod-free: the app's Compare page imports it, and so can a renderer bundle or
// the room.
import type { AlignBudget } from "./align.ts";
import { CHANGE_LIMITS } from "./limits.ts";
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
  /** More changes were found than CHANGE_LIMITS.maxItems, or a diff gave up on a large region. */
  truncated: boolean;
}

export { CHANGE_LIMITS } from "./limits.ts";

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
 * many regions cannot multiply the bound.
 */
export class ChangeCollector {
  readonly items: ChangeItem[] = [];
  truncated = false;
  /** Cells and word comparisons left to the alignments of this list: CHANGE_LIMITS.alignWork. */
  readonly alignBudget: AlignBudget = { left: CHANGE_LIMITS.alignWork };
  // A plain field, not a parameter property: Node loads this file with type stripping only (the
  // web build's config imports @plinth/shared).
  private readonly max: number;
  constructor(max: number = CHANGE_LIMITS.maxItems) {
    this.max = max;
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
