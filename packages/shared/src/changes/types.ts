// The change list's types and limits, shared by every describer. Pure and zod-free: the app's
// Compare page imports it, and so can a renderer bundle or the room.

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
  /** Visible text or the value before, at most CHANGE_LIMITS.excerptChars characters. */
  before?: string;
  /** Visible text or the value after, at most CHANGE_LIMITS.excerptChars characters. */
  after?: string;
}

export interface ChangeList {
  items: ChangeItem[];
  /** More changes were found than CHANGE_LIMITS.maxItems, or a diff gave up on a large region. */
  truncated: boolean;
}

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
  /** Formula steps a sheet may spend so that a calculation's results can be listed. */
  sheetEvalSteps: 1_000_000,
} as const;

/** Collects items up to the cap, in the order they are found. */
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
    if (item.before !== undefined && item.before !== "") clean.before = item.before;
    if (item.after !== undefined && item.after !== "") clean.after = item.after;
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
