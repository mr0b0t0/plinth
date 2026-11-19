// The whole-draft review (docs/spec.md "Editing"), inside the renderer on the artifact's content
// origin. It opens when a version vN was published while people had unpublished page changes that
// were not combined with it: a doc's that overlap (#49), and every sheet's (never merged). It
// shows both whole sides rendered side by side (one at a time, with a switch, at phone width),
// each read-only by the type's own renderer and against the files it would publish: the page
// changes against their base version's files, vN against vN's. Above each is its change list from
// the shared describers (what the page changes did since the base, and what vN did since the
// base, with vN's files when it changed any). Then exactly two choices, and Cancel:
// - "Publish mine": the page changes become the next version, with the files they were made with,
//   over vN, which stays in History;
// - "Discard mine": after a confirmation that names what will be lost, the page goes back to vN.
// Short labels only: the heading says what happened, and the two panes show the rest.
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
   * …)`. Returns a function that brings the pane to the place a change item names (false when it
   * cannot find it), or null.
   */
  render(el: HTMLElement, text: string, version: number): ((item: ChangeItem) => boolean) | null;
}

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
  /** Room mode: the others editing, by email, for the Discard confirmation. */
  editors: readonly string[];
}

/** The review's words, by range (exported for tests and the app's matching words). */
export const REVIEW_WORDS = {
  heading: (from: number, to: number) =>
    `${versionRange(from, to)} ${from >= to ? "was" : "were"} published while you were editing`,
  mine: "Your changes",
  theirs: (to: number) => `v${to}`,
  busy: "Another editor is choosing right now",
  label: (from: number, to: number) => `Review ${versionRange(from, to)} and the page changes`,
} as const;

const MAX_SUMMARY = 3;

/** "Slide 2: Title changed" style text for one item. */
export function itemText(item: ChangeItem): string {
  return item.where ? `${item.where}: ${item.what}` : item.what;
}

/** The Discard confirmation's description: what will be lost, from the page changes' list. */
export function discardDescription(
  list: ChangeList | null,
  to: number,
  mode: "room" | "solo",
  editors: readonly string[],
): string {
  const items = list?.items ?? [];
  const n = items.length;
  let lost: string;
  if (n === 0) lost = "The page changes will be lost.";
  else {
    const shown = items.slice(0, MAX_SUMMARY).map(itemText);
    const more = n - shown.length + (list?.truncated ? 1 : 0);
    const what = more > 0 ? `${shown.join(", ")}, and ${more} more` : shown.join(", ");
    lost =
      n === 1 && !list?.truncated
        ? `This change will be lost: ${what}.`
        : `These ${list?.truncated ? `${n}+` : n} changes will be lost: ${what}.`;
  }
  if (mode === "solo") return `${lost} The page will show v${to}.`;
  const who =
    editors.length > 0
      ? ` (${editors.slice(0, 5).join(", ")}${editors.length > 5 ? ", and others" : ""})`
      : "";
  return `${lost} The page will show v${to} for everyone editing${who}.`;
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
  private confirm: HTMLElement | null = null;
  private opened = 0;
  private mineList: ChangeList | null = null;

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
    this.mineList = baseText === null ? null : describeChanges(type, baseText, state.draft);
    const theirList =
      baseText === null || theirs === null ? null : describeChanges(type, baseText, theirs);
    this.draw(state, theirs, theirList);
    if (reopened) {
      this.announce(
        `v${state.n} was published too. The review now covers ${versionRange(state.base + 1, state.n)}.`,
      );
    }
  }

  private draw(state: ReviewState, theirs: string | null, theirList: ChangeList | null): void {
    const d = this.doc;
    const from = state.base + 1;
    const to = state.n;
    this.root?.remove();
    this.closeConfirm();
    const root = el(d, "section", "plinth-review");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", REVIEW_WORDS.label(from, to));
    root.dataset.show = "mine";
    const heading = el(d, "h2", "plinth-review__heading", REVIEW_WORDS.heading(from, to));
    heading.tabIndex = -1;

    // ---- the phone switch ----
    const sw = el(d, "div", "plinth-review__switch");
    sw.setAttribute("role", "radiogroup");
    sw.setAttribute("aria-label", "Show");
    const sides: [string, string][] = [
      ["mine", "Mine"],
      ["theirs", `v${to}`],
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
          gotos.push(this.setup.pane.render(body, text, version));
        } catch {
          body.replaceChildren(el(d, "p", "plinth-review__missing", "This could not be shown."));
          gotos.push(null);
        }
      }
      bodies.push(body);
      s.append(body);
      return s;
    };
    panes.append(
      // Page changes never change files, so only vN's side can list any.
      pane("mine", REVIEW_WORDS.mine, this.mineList, fileLines(null), state.draft, state.base),
      pane("theirs", REVIEW_WORDS.theirs(to), theirList, fileLines(state.files), theirs, to),
    );
    // The two sides scroll together.
    let syncing = false;
    for (const [i, b] of bodies.entries()) {
      b.addEventListener("scroll", () => {
        if (syncing) return;
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
    const publish = el(d, "button", "plinth-review__primary", "Publish mine");
    publish.type = "button";
    publish.addEventListener("click", () => this.choose("publish"));
    const discard = el(d, "button", "plinth-review__danger", "Discard mine");
    discard.type = "button";
    discard.addEventListener("click", () => this.openConfirm(discard));
    const cancel = el(d, "button", "plinth-review__secondary", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      this.setup.choose("cancelled");
      this.close();
    });
    const reason = el(d, "p", "plinth-review__reason");
    reason.setAttribute("role", "status");
    if (unpublishable) {
      publish.disabled = true;
      reason.textContent = "These page changes can't be published yet.";
      reason.id = nextId("reason");
      publish.setAttribute("aria-describedby", reason.id);
    }
    choices.append(publish, discard, cancel, reason);
    this.buttons = [publish, discard];
    this.publishButton = publish;
    this.reason = reason;

    root.append(heading, sw, panes, choices);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.confirm) {
        e.stopPropagation();
        this.setup.choose("cancelled");
        this.close();
      }
    });
    d.body.append(root);
    d.documentElement.classList.add("plinth-reviewing");
    this.root = root;
    heading.focus();
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
        if (item.before !== undefined || item.after !== undefined) {
          li.append(
            el(
              d,
              "span",
              "plinth-review__values",
              `${item.before ?? "(empty)"} → ${item.after ?? "(empty)"}`,
            ),
          );
        }
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

  private choose(outcome: "publish" | "discard", note?: string): void {
    if (!this.state || this.pending) return;
    this.pending = outcome;
    this.setButtons(false, outcome === "publish" ? "Publishing…" : "Discarding…");
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
        this.close("Another editor already published or discarded the page changes.");
        return;
      case "conflict":
        // A newer version froze the draft: the review opens again on it.
        this.setButtons(true, "A newer version was published. Review it too.");
        return;
      case "failed":
        this.setButtons(true, "");
        return;
      case "done":
        this.close(
          chose === "discard"
            ? "The page changes were discarded."
            : "Your page changes were published.",
        );
        return;
    }
  }

  private openConfirm(from: HTMLElement): void {
    const s = this.state;
    if (!s || this.confirm) return;
    const d = this.doc;
    const box = el(d, "div", "plinth-review__confirm");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const t = el(d, "h3", "plinth-review__confirm-title", "Discard the page changes?");
    t.id = nextId("confirm");
    const p = el(
      d,
      "p",
      "plinth-review__confirm-text",
      discardDescription(this.mineList, s.n, s.mode, s.editors),
    );
    p.id = nextId("confirm-text");
    box.setAttribute("aria-labelledby", t.id);
    box.setAttribute("aria-describedby", p.id);
    const no = el(d, "button", "plinth-review__secondary", "Cancel");
    no.type = "button";
    const yes = el(d, "button", "plinth-review__danger", "Discard");
    yes.type = "button";
    const done = () => {
      this.closeConfirm();
      from.focus();
    };
    no.addEventListener("click", done);
    yes.addEventListener("click", () => {
      this.closeConfirm();
      this.choose("discard");
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done();
      } else if (e.key === "Tab") {
        // Focus stays in the confirmation.
        const first = no;
        const last = yes;
        if (e.shiftKey && d.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && d.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    const actions = el(d, "div", "plinth-review__confirm-actions");
    actions.append(no, yes);
    box.append(t, p, actions);
    const scrim = el(d, "div", "plinth-review__scrim");
    scrim.append(box);
    this.root?.append(scrim);
    this.confirm = scrim;
    no.focus();
  }

  private closeConfirm(): void {
    this.confirm?.remove();
    this.confirm = null;
  }

  /** Close the review, saying why when someone else's choice (or a version) closed it. */
  close(message?: string): void {
    this.opened++;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    this.closeConfirm();
    this.root?.remove();
    this.root = null;
    this.state = null;
    this.pending = null;
    this.doc.documentElement.classList.remove("plinth-reviewing");
    if (message) this.announce(message);
  }
}

/** Where a version's file is, for panes that draw images (re-exported for the type panes). */
export { fileUrl };
