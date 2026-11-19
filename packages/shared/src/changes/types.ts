// The change list's types, its collector and (from limits.ts) its limits, shared by every
// describer. Pure and zod-free: the app's Compare page imports it, and so can a renderer bundle or
// the room.
import { CHANGE_LIMITS } from "./limits.ts";
import { changeExcerpt } from "./text.ts";

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

/** `s`, or an excerpt of it when it is longer than CHANGE_LIMITS.excerptChars. */
function capped(s: string): string {
  return s.length > CHANGE_LIMITS.excerptChars ? changeExcerpt(s) : s;
}

/**
 * Collects items up to the cap, in the order they are found. It also cuts every `before` and
 * `after` longer than CHANGE_LIMITS.excerptChars, so the bound holds whatever a describer passes
 * (a 256-character token value, a long board or column name).
 */
export class ChangeCollector {
  readonly items: ChangeItem[] = [];
  truncated = false;
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
    const clean: ChangeItem = { kind: item.kind, where: item.where, what: item.what };
    if (item.before !== undefined && item.before !== "") clean.before = capped(item.before);
    if (item.after !== undefined && item.after !== "") clean.after = capped(item.after);
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
