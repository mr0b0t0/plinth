// The whole-draft review (docs/spec.md "Editing"), inside the renderer on the artifact's content
// origin. It opens when a version vN was published while people had unpublished page changes that
// were not combined with it: a doc's that overlap (#49), and every sheet's (never merged). It
// shows both whole sides rendered side by side (one at a time, with a switch, at phone width),
// each read-only by the type's own renderer and against the files it would publish: the page
// changes against their base version's files, vN against vN's. Above each is its change list from
// the shared describers (what the page changes did since the base, and what vN did since the
// base, with vN's files when it changed any; a changed text shows only the words that changed).
// Each pane marks what changed since the base (the type's blocks or cells) and opens at its first
// change. Then exactly two choices, and Back:
// - "Publish your changes": they become the next version, with the files they were made with,
//   over vN, which stays in History;
// - "Discard your changes": the app confirms it with its own dialog over the dimmed page, then
//   the page goes back to vN.
// Short labels only: the edit strip above the frame says what happened, so the review has no
// heading of its own; the two panes show the rest. Back is its one way out (the strip shows no
// Done while it is open), and its styles follow the app's (ink primary, bronze live state).
// The renderer only asks: it posts the choice to the app (`resolved`), which makes the REST call;
// the room decides, under its checkpoint lock, and closes every open review with its `reset`.
//
// Every string here is a text node. The versions are read from this origin (/__plinth/v/<n>/), so
// no version text crosses to the app, and no draft text does in room mode.
import {
  type ArtifactType,
  type ChangeItem,
  type ChangeList,
  describeChanges,
  diffSequence,
  type FileChange,
  type FileChangeSummary,
  type LiveTypeRules,
  versionRange,
} from "@plinth/shared";
import { fetchVersionSource, fileUrl } from "./files.ts";

/** One side of the review, drawn read-only by the type's renderer. */
export interface ReviewPane {
  /**
   * Draw `text` (the type's live form) into `el`, resolving every file through `fileUrl(version,
   * …)`, and mark what differs from `base` (the base version's live form, null when it could not
   * be read) with CHANGED_ATTR. Returns a function that brings the pane to the place a change item
   * names (false when it cannot find it), or null.
   */
  render(
    el: HTMLElement,
    text: string,
    version: number,
    base: string | null,
  ): ((item: ChangeItem) => boolean) | null;
}

/** The attribute a pane sets on each block or cell that changed since the base. */
export const CHANGED_ATTR = "data-review-changed";

export type ReviewOutcome = "publish" | "discard" | "cancelled";

export interface ReviewSetup {
  win: Window;
  type: ArtifactType;
  /** The type's source file, read from /__plinth/v/<n>/ for the base and vN. */
  sourcePath: string;
  rules: LiveTypeRules;
  pane: ReviewPane;
  /** The choice, for the app. `note` only with "publish", when the person wrote one. */
  choose(outcome: ReviewOutcome, note?: string): void;
  /** For tests: reads a version's source. */
  fetchText?: (n: number) => Promise<string | null>;
}

export interface ReviewState {
  mode: "room" | "solo";
  /** The draft's base version. */
  base: number;
  /** The newest version it is reviewed against. */
  n: number;
  /** The files vN changed since the base, or null when they are not known. */
  files: FileChangeSummary | null;
  /** The draft, in the type's live form. */
  draft: string;
}

/** The review's words (exported for tests). One noun throughout: "your changes". */
export const REVIEW_WORDS = {
  mine: "Your changes",
  theirs: (to: number) => `v${to}`,
  publish: "Publish your changes",
  discard: "Discard your changes",
  back: "Back",
  busy: "Another editor is choosing right now",
  unpublishable: "These changes can't be published yet.",
  label: (from: number, to: number) => `Review ${versionRange(from, to)} and your changes`,
} as const;

/** "Slide 2: Title changed" style text for one item. */
export function itemText(item: ChangeItem): string {
  return item.where ? `${item.where}: ${item.what}` : item.what;
}

/** One run of a changed text: words both sides share, or words only one side has. */
export interface WordRun {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Words of context kept on each side of a change. */
const CONTEXT_WORDS = 3;
/** Changes shown in one item's words; more end with "…". */
const MAX_HUNKS = 2;
/** Words shown of one removed or added run; a longer one ends with "…". */
const MAX_RUN_WORDS = 12;

/**
 * What changed between two short texts (a change item's `before` and `after`), as runs: only the
 * words that differ, with a few words of context around each change and "…" where text is left
 * out, so a change deep in a long paragraph is what shows, not the opening both sides share. Empty
 * when the two do not differ in their words (the change lies past both excerpts).
 */
export function changedWords(before: string, after: string): WordRun[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const { hunks } = diffSequence(a, b, { maxEdits: 200 });
  if (hunks.length === 0) return [];
  const runs: WordRun[] = [];
  const push = (kind: WordRun["kind"], words: string[]) => {
    if (words.length === 0) return;
    const cut = words.length > MAX_RUN_WORDS ? [...words.slice(0, MAX_RUN_WORDS), "…"] : words;
    // A "…" stays on the line of the word beside it (a no-break space).
    const text = cut.join(" ").replace(/^… /, "… ").replace(/ …$/, " …");
    const last = runs.at(-1);
    if (last && last.kind === kind) last.text += ` ${text}`;
    else runs.push({ kind, text });
  };
  const shown = hunks.slice(0, MAX_HUNKS);
  let j = 0;
  for (const [i, h] of shown.entries()) {
    // Context before: what follows the previous change, cut to a few words on each side (before
    // the first change, only the words just before it, after a "…").
    const gap = b.slice(j, h.bStart);
    const lead = i === 0 ? 0 : CONTEXT_WORDS;
    if (gap.length > lead + CONTEXT_WORDS) {
      push("same", [...gap.slice(0, lead), "…", ...gap.slice(-CONTEXT_WORDS)]);
    } else push("same", gap);
    push("removed", a.slice(h.aStart, h.aEnd));
    push("added", b.slice(h.bStart, h.bEnd));
    j = h.bEnd;
  }
  const tail = b.slice(j);
  const more = hunks.length > shown.length;
  if (tail.length > CONTEXT_WORDS || more) push("same", [...tail.slice(0, CONTEXT_WORDS), "…"]);
  else push("same", tail);
  return runs;
}

/** "chart.png replaced" style lines for vN's files part, and how many more there are. */
export function fileLines(files: FileChangeSummary | null): { lines: string[]; more: number } {
  if (!files) return { lines: [], more: 0 };
  const line = (c: FileChange) => `${c.path} ${c.kind}`;
  return {
    lines: [...files.added, ...files.removed, ...files.replaced].map(line),
    more: files.more,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let ids = 0;
const nextId = (p: string) => `plinth-review-${p}-${++ids}`;

export class DraftReview {
  private root: HTMLElement | null = null;
  private state: ReviewState | null = null;
  private announcer: HTMLElement | null = null;
  private buttons: HTMLButtonElement[] = [];
  private publishButton: HTMLButtonElement | null = null;
  private reason: HTMLElement | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: ReviewOutcome | null = null;
  private discardButton: HTMLButtonElement | null = null;
  private opened = 0;

  constructor(private readonly setup: ReviewSetup) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** The choice this frame sent and the app has not answered, if any. */
  get chosen(): ReviewOutcome | null {
    return this.pending;
  }

  /** The versions reviewed now: v(base+1) to vN. */
  get range(): { from: number; to: number } | null {
    return this.state ? { from: this.state.base + 1, to: this.state.n } : null;
  }

  private get doc(): Document {
    return this.setup.win.document;
  }

  /** A polite live region that outlives the review, for what happened to it. */
  announce(text: string): void {
    if (!this.announcer) {
      const a = el(this.doc, "div", "plinth-review__announce");
      a.setAttribute("role", "status");
      a.setAttribute("aria-live", "polite");
      this.doc.body.append(a);
      this.announcer = a;
    }
    this.announcer.textContent = "";
    // A changed text node is announced even when the words repeat.
    this.announcer.textContent = text;
  }

  private read(n: number): Promise<string | null> {
    return this.setup.fetchText
      ? this.setup.fetchText(n)
      : fetchVersionSource(this.setup.win, n, this.setup.sourcePath);
  }

  /** Open the review (or open it again on a newer range). */
  async open(state: ReviewState): Promise<void> {
    const run = ++this.opened;
    const reopened = this.root !== null && this.state !== null && this.state.n !== state.n;
    this.state = state;
    this.pending = null;
    const [baseRaw, theirsRaw] = await Promise.all([this.read(state.base), this.read(state.n)]);
    if (run !== this.opened || this.state !== state) return;
    const { rules, type } = this.setup;
    const baseText = baseRaw === null ? null : rules.toLive(baseRaw);
    const theirs = theirsRaw === null ? null : rules.toLive(theirsRaw);
    const mineList = baseText === null ? null : describeChanges(type, baseText, state.draft);
    const theirList =
      baseText === null || theirs === null ? null : describeChanges(type, baseText, theirs);
    this.draw(state, baseText, theirs, mineList, theirList);
    if (reopened) {
      this.announce(
        `v${state.n} was published too. The review now covers ${versionRange(state.base + 1, state.n)}.`,
      );
    }
  }

  private draw(
    state: ReviewState,
    base: string | null,
    theirs: string | null,
    mineList: ChangeList | null,
    theirList: ChangeList | null,
  ): void {
    const d = this.doc;
    const from = state.base + 1;
    const to = state.n;
    this.root?.remove();
    const root = el(d, "section", "plinth-review");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", REVIEW_WORDS.label(from, to));
    root.dataset.show = "mine";
    // Focus moves to the review itself when it opens (it is named), not to a heading: the strip
    // above the frame already says what happened.
    root.tabIndex = -1;

    // ---- the phone switch ----
    const sw = el(d, "div", "plinth-review__switch");
    sw.setAttribute("role", "radiogroup");
    sw.setAttribute("aria-label", "Show");
    const sides: [string, string][] = [
      ["mine", REVIEW_WORDS.mine],
      ["theirs", REVIEW_WORDS.theirs(to)],
    ];
    const swButtons = sides.map(([side, label]) => {
      const b = el(d, "button", "plinth-review__switch-option", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", side === "mine" ? "true" : "false");
      b.dataset.side = side;
      b.addEventListener("click", () => {
        root.dataset.show = side;
        for (const o of swButtons) {
          o.setAttribute("aria-checked", o.dataset.side === side ? "true" : "false");
        }
        // A side hidden until now opens at its first change, as the other did.
        toFirstChange();
      });
      return b;
    });
    sw.append(...swButtons);

    // ---- the two panes ----
    const panes = el(d, "div", "plinth-review__panes");
    const gotos: (((item: ChangeItem) => boolean) | null)[] = [];
    const bodies: HTMLElement[] = [];
    const goTo = (item: ChangeItem) => {
      for (const g of gotos) g?.(item);
    };
    const pane = (
      side: "mine" | "theirs",
      label: string,
      list: ChangeList | null,
      files: { lines: string[]; more: number },
      text: string | null,
      version: number,
    ) => {
      const s = el(d, "section", "plinth-review__pane");
      s.dataset.side = side;
      s.setAttribute("aria-label", label);
      s.append(el(d, "h3", "plinth-review__label", label));
      s.append(this.changes(list, files, goTo));
      const body = el(d, "div", "plinth-review__body");
      body.tabIndex = 0;
      body.setAttribute("aria-label", label);
      if (text === null) {
        body.append(el(d, "p", "plinth-review__missing", "This version could not be loaded."));
        gotos.push(null);
      } else {
        try {
          gotos.push(this.setup.pane.render(body, text, version, base));
        } catch {
          body.replaceChildren(el(d, "p", "plinth-review__missing", "This could not be shown."));
          gotos.push(null);
        }
      }
      bodies.push(body);
      s.append(body);
      return s;
    };
    // A side wider than its pane (a sheet at phone width) fades at the edge it scrolls toward.
    const edges = () => {
      for (const b of bodies) {
        if (b.scrollLeft + b.clientWidth < b.scrollWidth - 1) b.dataset.more = "";
        else delete b.dataset.more;
      }
    };
    panes.append(
      // Page changes never change files, so only vN's side can list any.
      pane("mine", REVIEW_WORDS.mine, mineList, fileLines(null), state.draft, state.base),
      pane("theirs", REVIEW_WORDS.theirs(to), theirList, fileLines(state.files), theirs, to),
    );
    // Each side opens at its first change (once it is shown: one at a time at phone width), without
    // moving the other side with it.
    const placed = new Set<HTMLElement>();
    let quiet = 0;
    const toFirstChange = () => {
      const win = this.setup.win;
      for (const b of bodies) {
        if (placed.has(b) || b.getClientRects().length === 0) continue;
        placed.add(b);
        const first = b.querySelector(`[${CHANGED_ATTR}]`);
        if (first && scrollIntoPane(b, first)) {
          quiet++;
          // Scroll events fire on the next frame; the sync below skips those.
          win.requestAnimationFrame(() => win.requestAnimationFrame(() => quiet--));
        }
      }
      edges();
    };
    // The two sides scroll together.
    let syncing = false;
    for (const [i, b] of bodies.entries()) {
      b.addEventListener("scroll", () => {
        edges();
        if (syncing || quiet > 0) return;
        const other = bodies[1 - i];
        if (!other) return;
        const max = b.scrollHeight - b.clientHeight;
        const ratio = max > 0 ? b.scrollTop / max : 0;
        syncing = true;
        other.scrollTop = ratio * (other.scrollHeight - other.clientHeight);
        syncing = false;
      });
    }

    // ---- the choices ----
    const choices = el(d, "div", "plinth-review__choices");
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Keep one");
    const unpublishable = this.setup.rules.unpublishable(state.draft);
    const publish = el(d, "button", "plinth-review__primary", REVIEW_WORDS.publish);
    publish.type = "button";
    publish.addEventListener("click", () => this.choose("publish"));
    const discard = el(d, "button", "plinth-review__danger", REVIEW_WORDS.discard);
    discard.type = "button";
    // The app asks first, with its own confirmation over the dimmed page.
    discard.addEventListener("click", () => this.choose("discard"));
    const back = el(d, "button", "plinth-review__ghost", REVIEW_WORDS.back);
    back.type = "button";
    back.setAttribute("aria-keyshortcuts", "Escape");
    back.addEventListener("click", () => {
      this.setup.choose("cancelled");
      this.close();
    });
    const reason = el(d, "p", "plinth-review__reason");
    reason.setAttribute("role", "status");
    if (unpublishable) {
      publish.disabled = true;
      reason.textContent = REVIEW_WORDS.unpublishable;
      reason.id = nextId("reason");
      publish.setAttribute("aria-describedby", reason.id);
    }
    // The app's dialog footer order: the way out first, the primary last.
    choices.append(reason, back, discard, publish);
    this.buttons = [publish, discard];
    this.publishButton = publish;
    this.discardButton = discard;
    this.reason = reason;

    root.append(sw, panes, choices);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.setup.choose("cancelled");
        this.close();
      }
    });
    d.body.append(root);
    d.documentElement.classList.add("plinth-reviewing");
    this.root = root;
    root.focus();
    toFirstChange();
  }

  /** One side's change list, and its files when it changed any. Items are buttons that bring both
   * panes there. */
  private changes(
    list: ChangeList | null,
    files: { lines: string[]; more: number },
    goTo: (item: ChangeItem) => void,
  ): HTMLElement {
    const d = this.doc;
    const s = el(d, "div", "plinth-review__changes");
    if (!list) {
      s.append(el(d, "p", "plinth-review__none", "These changes could not be listed."));
    } else if (list.items.length === 0) {
      s.append(el(d, "p", "plinth-review__none", "No changes."));
    } else {
      const ul = el(d, "ul", "plinth-review__list");
      ul.setAttribute("aria-label", "Changes");
      for (const item of list.items) {
        const li = el(d, "li", "plinth-review__item");
        li.dataset.kind = item.kind;
        const b = el(d, "button", "plinth-review__item-button", itemText(item));
        b.type = "button";
        b.addEventListener("click", () => goTo(item));
        li.append(b);
        const values = this.values(item);
        if (values) li.append(values);
        ul.append(li);
      }
      if (list.truncated) ul.append(el(d, "li", "plinth-review__item", "and more"));
      s.append(ul);
    }
    if (files.lines.length > 0 || files.more > 0) {
      const ul = el(d, "ul", "plinth-review__list plinth-review__files");
      ul.setAttribute("aria-label", "Files");
      for (const line of files.lines) ul.append(el(d, "li", "plinth-review__item", line));
      if (files.more > 0) {
        ul.append(
          el(
            d,
            "li",
            "plinth-review__item",
            `and ${files.more} more ${files.more === 1 ? "file" : "files"}`,
          ),
        );
      }
      s.append(ul);
    }
    return s;
  }

  /**
   * An item's values: a short value as "18 → 24", a longer text as only the words that changed
   * (removed ones struck through), or nothing when the excerpts do not show the change.
   */
  private values(item: ChangeItem): HTMLElement | null {
    const d = this.doc;
    const { before, after } = item;
    if (before === undefined && after === undefined) return null;
    const span = el(d, "span", "plinth-review__values");
    if (before === undefined || after === undefined) {
      span.textContent = before ?? after ?? "";
      return span;
    }
    const runs = changedWords(before, after);
    if (runs.length === 0) return null;
    if (runs.every((r) => r.kind !== "same")) {
      // The whole value changed: one plain line.
      span.textContent = `${before} → ${after}`;
      return span;
    }
    for (const [i, r] of runs.entries()) {
      if (i > 0) span.append(" ");
      if (r.kind === "same") {
        span.append(r.text);
        continue;
      }
      const mark = el(d, r.kind === "removed" ? "del" : "ins", "plinth-review__word");
      // Screen readers do not announce del and ins, so the words say which they are.
      mark.append(
        el(d, "span", "plinth-review__sr", r.kind === "removed" ? "removed: " : "added: "),
      );
      mark.append(r.text);
      span.append(mark);
    }
    return span;
  }

  private choose(outcome: "publish" | "discard", note?: string): void {
    if (!this.state || this.pending) return;
    this.pending = outcome;
    // A Discard waits on the app's confirmation, whose backdrop covers the frame: the buttons
    // stay as they are behind it (a second choice waits on the answer all the same).
    if (outcome === "publish") this.setButtons(false, "Publishing…");
    this.setup.choose(outcome, note);
  }

  private setButtons(on: boolean, reason: string): void {
    const unpublishable = this.state ? this.setup.rules.unpublishable(this.state.draft) : null;
    for (const b of this.buttons)
      b.disabled = !on || (b === this.publishButton && unpublishable !== null);
    if (this.reason) this.reason.textContent = reason;
  }

  /** The app's answer to this frame's choice. */
  answer(result: "busy" | "resolved" | "conflict" | "failed" | "done"): void {
    if (!this.root) return;
    const chose = this.pending;
    this.pending = null;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    switch (result) {
      case "busy":
        // Another editor's choice (or a save) holds the room's lock; its outcome closes this.
        this.setButtons(false, REVIEW_WORDS.busy);
        this.busyTimer = setTimeout(() => {
          this.busyTimer = null;
          if (this.root) this.setButtons(true, REVIEW_WORDS.busy);
        }, 5000);
        return;
      case "resolved":
        this.close("Another editor already published or discarded these changes.");
        return;
      case "conflict":
        // A newer version froze the draft: the review opens again on it.
        this.setButtons(true, "A newer version was published. Review it too.");
        return;
      case "failed":
        // Also the answer to a Discard whose confirmation was cancelled: back to the button.
        this.setButtons(true, "");
        if (chose === "discard") this.discardButton?.focus();
        return;
      case "done":
        this.close(
          chose === "discard" ? "Your changes were discarded." : "Your changes were published.",
        );
        return;
    }
  }

  /** Close the review, saying why when someone else's choice (or a version) closed it. */
  close(message?: string): void {
    this.opened++;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    this.root?.remove();
    this.root = null;
    this.state = null;
    this.pending = null;
    this.doc.documentElement.classList.remove("plinth-reviewing");
    if (message) this.announce(message);
  }
}

/**
 * Scroll `pane` so `target` is in view, centred, when it is not already wholly in view (a sheet's
 * sticky header row and column stay clear of a centred cell). True when it scrolled.
 */
function scrollIntoPane(pane: HTMLElement, target: Element): boolean {
  const p = pane.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  let moved = false;
  if (t.top < p.top || t.bottom > p.bottom) {
    pane.scrollTop += t.top - p.top - Math.max(0, (p.height - t.height) / 2);
    moved = true;
  }
  if (t.left < p.left || t.right > p.right) {
    pane.scrollLeft += t.left - p.left - Math.max(0, (p.width - t.width) / 2);
    moved = true;
  }
  return moved;
}

/** A thin mark where blocks were removed, for `parent` (an item in a list). */
function goneMarker(parent: Element): Element {
  const gone = parent.ownerDocument.createElement(/^(UL|OL)$/.test(parent.tagName) ? "li" : "div");
  gone.className = "plinth-review__gone";
  gone.setAttribute(CHANGED_ATTR, "");
  gone.setAttribute("aria-hidden", "true");
  return gone;
}

/**
 * Marks the children of `after` that differ from those of `before` (the same content rendered
 * from the base) with CHANGED_ATTR: a changed or added child is marked, a list, quote or table
 * whose items changed has those items marked instead, and where children were removed a thin
 * marker stands in their place. For the panes that draw blocks (a doc). Returns how many it marked.
 */
export function markChangedChildren(before: Element, after: Element, depth = 0): number {
  const a = [...before.children];
  const b = [...after.children];
  const { hunks } = diffSequence(
    a.map((e) => e.outerHTML),
    b.map((e) => e.outerHTML),
  );
  let marked = 0;
  for (const h of hunks) {
    if (h.bStart === h.bEnd) {
      // Only removed here: a marker where they were (none inside a table).
      if (/^(TABLE|THEAD|TBODY|TR)$/.test(after.tagName)) continue;
      after.insertBefore(goneMarker(after), b[h.bStart] ?? null);
      marked++;
      continue;
    }
    const pairs = Math.min(h.aEnd - h.aStart, h.bEnd - h.bStart);
    if (h.aEnd - h.aStart > pairs && !/^(TABLE|THEAD|TBODY|TR)$/.test(after.tagName)) {
      // More went than came: a marker after what came, for the rest.
      after.insertBefore(goneMarker(after), b[h.bEnd] ?? null);
      marked++;
    }
    for (let k = h.bStart; k < h.bEnd; k++) {
      const nb = b[k] as Element;
      const na = k - h.bStart < pairs ? a[h.aStart + (k - h.bStart)] : undefined;
      const inner =
        na &&
        depth < 3 &&
        na.tagName === nb.tagName &&
        /^(UL|OL|BLOCKQUOTE|TABLE|THEAD|TBODY)$/.test(nb.tagName)
          ? markChangedChildren(na, nb, depth + 1)
          : 0;
      if (inner === 0) nb.setAttribute(CHANGED_ATTR, "");
      marked += Math.max(1, inner);
    }
  }
  return marked;
}

/** Where a version's file is, for panes that draw images (re-exported for the type panes). */
export { fileUrl };
