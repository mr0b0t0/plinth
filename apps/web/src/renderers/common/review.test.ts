// The whole-draft review in the frame (review.ts, editSession.ts): both sides rendered read-only
// against their own version's files, the two change lists with their files parts, ranges named,
// exactly two choices and Back, the Discard confirmation, the busy state, what closes it, and the
// phone switch. Also the frame key (frameKey.ts) and the file pinning (files.ts).
// @vitest-environment happy-dom
import { liveRules } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { ReviewSession, readEditMessage } from "./editSession.ts";
import { fileUrl, pinFiles, pinnedSrc } from "./files.ts";
import { takeFrameKey } from "./frameKey.ts";
import type { LiveDocClient } from "./live.ts";
import {
  CHANGED_ATTR,
  changedWords,
  DraftReview,
  itemWords,
  markChangedChildren,
  type ReviewPane,
} from "./review.ts";

const RULES = liveRules("doc");
if (!RULES) throw new Error("no doc rules");

const BASE = "# Plan\n\n![Chart](chart.png)\n\nFirst.\n\nSecond.\n";
const MINE = "# Plan\n\n![Chart](chart.png)\n\nFirst, by a person.\n\nSecond.\n";
const V6 = "# Plan\n\n![Chart](chart.png)\n\nFirst, by an agent.\n\nSecond.\n";
const FILES = {
  added: [{ path: "fonts/geist.woff2", kind: "added" as const, after: 10 }],
  removed: [],
  replaced: [{ path: "chart.png", kind: "replaced" as const, before: 4, after: 5 }],
  more: 12,
  same: 1,
};

/** The doc's pane, as the doc renderer draws it. */
const docPane: ReviewPane = {
  render(el, text, version) {
    const wrap = document.createElement("div");
    wrap.append(sanitizeHtml(renderMarkdown(text), document));
    pinFiles(wrap, version);
    el.replaceChildren(wrap);
    return () => true;
  },
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.className = "";
  vi.useRealTimers();
});

function setup(over: { pane?: ReviewPane } = {}) {
  const choose = vi.fn();
  const texts: Record<number, string> = { 5: BASE, 6: V6, 7: V6.replace("agent", "agent, twice") };
  const review = new DraftReview({
    win: window,
    type: "doc",
    sourcePath: "content.md",
    rules: RULES as NonNullable<typeof RULES>,
    pane: over.pane ?? docPane,
    choose,
    fetchText: async (n) => texts[n] ?? null,
  });
  return { review, choose };
}

const region = () => document.querySelector(".plinth-review") as HTMLElement;
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name) as
    | HTMLButtonElement
    | undefined;
const panes = () => [...document.querySelectorAll(".plinth-review__pane")] as HTMLElement[];

/** Lays a pane out at 300 × 400 px, its content `scrollWidth` wide (happy-dom has no layout). */
function sized(el: HTMLElement, scrollWidth: number) {
  el.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400);
  el.getClientRects = () => [new DOMRect(0, 0, 300, 400)] as unknown as DOMRectList;
  Object.defineProperty(el, "clientWidth", { value: 300, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
}

describe("the whole-draft review", () => {
  it("renders both sides read-only, each against the files it would publish", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: FILES, draft: MINE });
    expect(region().getAttribute("aria-label")).toBe("Review v6 and your changes");
    // No heading: the edit strip above the frame already says what happened. Focus moves to the
    // named review itself.
    expect(region().querySelector("h2")).toBeNull();
    expect(document.activeElement).toBe(region());
    const [mine, theirs] = panes();
    expect(mine?.querySelector("h3")?.textContent).toBe("Your changes");
    expect(theirs?.querySelector("h3")?.textContent).toBe("v6");
    // Short labels only: no explanatory paragraph.
    expect(region().querySelector(".plinth-review__intro, .plinth-review__why")).toBeNull();
    // The draft against v5's files, v6 against v6's.
    expect(mine?.querySelector(".plinth-review__body img")?.getAttribute("src")).toBe(
      "/__plinth/v/5/chart.png",
    );
    expect(theirs?.querySelector(".plinth-review__body img")?.getAttribute("src")).toBe(
      "/__plinth/v/6/chart.png",
    );
    expect(mine?.textContent).toContain("First, by a person.");
    expect(theirs?.textContent).toContain("First, by an agent.");
    // Nothing in either pane is editable.
    expect(region().querySelector("textarea, [contenteditable]")).toBeNull();
  });

  it("lists both sides' changes, with vN's files: none listed for your changes", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: FILES, draft: MINE });
    const [mine, theirs] = panes();
    expect(mine?.querySelector('[aria-label="Changes"]')).not.toBeNull();
    expect(theirs?.querySelector('[aria-label="Changes"]')).not.toBeNull();
    // Page edits never change files, so your changes' side lists none.
    expect(mine?.querySelector(".plinth-review__files")).toBeNull();
    const files = theirs?.querySelector(".plinth-review__files")?.textContent ?? "";
    expect(files).toContain("fonts/geist.woff2 added");
    expect(files).toContain("chart.png replaced");
    expect(files).toContain("and 12 more files");
    // Items are buttons; their text is the describers' plain words.
    expect(mine?.querySelector(".plinth-review__item-button")?.textContent).toMatch(/changed/);
  });

  it("names a range in the region, and the newest version on its side", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 7, files: null, draft: MINE });
    expect(region().getAttribute("aria-label")).toBe("Review v6 to v7 and your changes");
    expect(panes()[1]?.querySelector("h3")?.textContent).toBe("v7");
  });

  it("Publish your changes asks the app; the buttons go off until the answer", async () => {
    const { review, choose } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    // Exactly two choices and Back: no separate "with a note" path, and one way out.
    expect(
      [...region().querySelectorAll(".plinth-review__choices button")].map((b) => b.textContent),
    ).toEqual(["Back", "Discard your changes", "Publish your changes"]);
    expect(button("Publish your changes with a note…")).toBeUndefined();
    button("Publish your changes")?.click();
    expect(choose).toHaveBeenCalledWith("publish", undefined);
    expect(button("Discard your changes")?.disabled).toBe(true);
    expect(review.chosen).toBe("publish");
    // Another editor's choice holds the lock: the buttons stay off, with the reason.
    review.answer("busy");
    expect(region().textContent).toContain("Another editor is choosing right now");
    expect(button("Discard your changes")?.disabled).toBe(true);
  });

  it("re-enables the choices a while after busy, and keeps them for a failed answer", async () => {
    vi.useFakeTimers();
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    button("Publish your changes")?.click();
    review.answer("busy");
    vi.advanceTimersByTime(5000);
    expect(button("Publish your changes")?.disabled).toBe(false);
    button("Publish your changes")?.click();
    review.answer("failed");
    expect(button("Publish your changes")?.disabled).toBe(false);
    expect(review.isOpen).toBe(true);
  });

  it("Discard your changes asks the app, which confirms it; a cancelled confirmation comes back", async () => {
    const { review, choose } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    button("Discard your changes")?.click();
    // The app confirms it with its own dialog over the dimmed page: the frame shows none.
    expect(choose).toHaveBeenCalledWith("discard", undefined);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    // The buttons stay as they are behind the app's backdrop, and nothing says "Discarding…".
    expect(region().querySelector(".plinth-review__reason")?.textContent).toBe("");
    expect(button("Publish your changes")?.disabled).toBe(false);
    // A second choice waits on the app's answer.
    button("Publish your changes")?.click();
    expect(choose).toHaveBeenCalledTimes(1);
    // Cancel there answers failed: the buttons come back, with focus on Discard.
    review.answer("failed");
    expect(button("Discard your changes")?.disabled).toBe(false);
    expect(document.activeElement).toBe(button("Discard your changes"));
    expect(review.isOpen).toBe(true);
  });

  it("Back closes the review and tells the app; the draft stays frozen", async () => {
    const { review, choose } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    button("Back")?.click();
    expect(choose).toHaveBeenCalledWith("cancelled");
    expect(review.isOpen).toBe(false);
    expect(region()).toBeNull();
  });

  it("at phone width shows one side at a time, with a Your changes and v6 switch", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    const options = [...document.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(options.map((o) => o.textContent)).toEqual(["Your changes", "v6"]);
    expect(region().dataset.show).toBe("mine");
    options[1]?.click();
    expect(region().dataset.show).toBe("theirs");
    expect(options[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("an item brings both panes to its place", async () => {
    const goto = vi.fn(() => true);
    const { review } = setup({ pane: { render: () => goto } });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    (document.querySelector(".plinth-review__item-button") as HTMLButtonElement).click();
    expect(goto).toHaveBeenCalledTimes(2);
  });

  it("marks a side that scrolls sideways until it reaches the end", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    const body = document.querySelector(".plinth-review__body") as HTMLElement;
    Object.defineProperty(body, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(body, "clientWidth", { value: 300, configurable: true });
    body.dispatchEvent(new Event("scroll"));
    expect(body.dataset.more).toBe("");
    Object.defineProperty(body, "scrollLeft", { value: 300, configurable: true });
    body.dispatchEvent(new Event("scroll"));
    expect(body.dataset.more).toBeUndefined();
  });
});

describe("what changed, in the review", () => {
  it("each pane gets the base to mark its changes against", async () => {
    const render = vi.fn<ReviewPane["render"]>(() => null);
    const { review } = setup({ pane: { render } });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    expect(render.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [5, BASE],
      [6, BASE],
    ]);
  });

  it("shows only the words that changed, with none of the words both sides share", () => {
    const before =
      "We ship the hosted beta to the first 200 teams on 2 December, with self-hosting docs the same week.";
    const after =
      "We ship the hosted beta (moved up a week) to the first 200 teams on 2 December, with self-hosting docs the same week.";
    expect(changedWords(before, after)).toEqual([{ kind: "added", text: "(moved up a week)" }]);
    expect(changedWords("Reach 50 teams.", "Reach 80 teams.")).toEqual([
      { kind: "removed", text: "50" },
      { kind: "added", text: "80" },
    ]);
    // Two changes are told apart by "…"; more than two end with one.
    expect(changedWords("a b c d e f", "a X c d Y f")).toEqual([
      { kind: "removed", text: "b" },
      { kind: "added", text: "X" },
      { kind: "gap", text: "…" },
      { kind: "removed", text: "e" },
      { kind: "added", text: "Y" },
    ]);
    expect(changedWords("a b c d e f", "X b Y d Z f").at(-1)).toEqual({ kind: "gap", text: "…" });
    // Excerpts that agree in every word say nothing: the item's line is enough.
    expect(changedWords("Same words…", "Same words…")).toEqual([]);
  });

  it("labels each change shortly, naming its place only where two would read the same", () => {
    const item = (where: string, what: string) => ({ kind: "changed" as const, where, what });
    expect(
      itemWords([
        item("Under “Q4 launch plan”", "Paragraph changed"),
        item("Under “Goals”", "Heading “Goals” renamed"),
      ]).map((w) => w.label),
    ).toEqual(["Paragraph changed", "Heading “Goals” renamed"]);
    expect(
      itemWords([
        item("Under “Goals”", "Paragraph changed"),
        item("Under “Risks”", "Paragraph changed"),
      ]).map((w) => w.label),
    ).toEqual(["Under “Goals”: Paragraph changed", "Under “Risks”: Paragraph changed"]);
    // A pane's own words win.
    expect(
      itemWords([item("Row 3, “Qty”", "B3 changed")], () => ({ label: "Qty, row 3" }))[0],
    ).toEqual({ label: "Qty, row 3" });
  });

  it("renders a short value as before → after, and a text as its changed words", () => {
    const { review } = setup();
    const values = (item: object) =>
      (review as unknown as { values(i: object): HTMLElement | null }).values(item);
    const text = values({
      kind: "changed",
      where: "Under “Goals”",
      what: "Paragraph changed",
      before: "Reach 50 weekly active teams by the end of the quarter.",
      after: "Reach 80 weekly active teams by the end of the quarter.",
    });
    expect(text?.querySelector("del")?.textContent).toBe("removed: 50");
    expect(text?.querySelector("ins")?.textContent).toBe("added: 80");
    expect(text?.textContent).toBe("removed: 50 added: 80");
    // A value that changed whole (a sheet's cell): one plain line.
    const cell = values({
      kind: "changed",
      where: "",
      what: "B3 changed",
      before: "18",
      after: "24",
    });
    expect(cell?.textContent).toBe("18 → 24");
    expect(cell?.querySelector("del, ins")).toBeNull();
    // Excerpts that show no difference: no values line at all.
    expect(
      values({ kind: "changed", where: "", what: "Paragraph changed", before: "A…", after: "A…" }),
    ).toBeNull();
  });

  it("marks the blocks that changed, the items of a list, and where blocks went", () => {
    const html = (md: string) => {
      const el = document.createElement("div");
      el.append(sanitizeHtml(renderMarkdown(md), document));
      return el;
    };
    const after = html("# Plan\n\nFirst, changed.\n\n- one\n- two, changed\n\nLast.\n");
    const n = markChangedChildren(
      html("# Plan\n\nFirst.\n\n- one\n- two\n\nGone.\n\nLast.\n"),
      after,
    );
    const marked = [...after.querySelectorAll(`[${CHANGED_ATTR}]`)];
    expect(marked.map((e) => e.tagName)).toEqual(["P", "LI", "DIV"]);
    expect(marked[0]?.textContent).toBe("First, changed.");
    expect(marked[1]?.textContent).toBe("two, changed");
    // The removed paragraph leaves a marker in its place, hidden from screen readers.
    expect(marked[2]?.className).toBe("plinth-review__gone");
    expect(marked[2]?.getAttribute("aria-hidden")).toBe("true");
    expect(n).toBe(3);
  });

  it("opens a pane scrolled to its first change: centred down, its left edge past what sticks", async () => {
    const pane: ReviewPane = {
      render(el) {
        const far = document.createElement("p");
        far.setAttribute(CHANGED_ATTR, "");
        el.append(far);
        // Laid out below and to the right of what the pane shows.
        far.getBoundingClientRect = () => new DOMRect(500, 900, 80, 20);
        sized(el, 2000);
        return null;
      },
    };
    const { review } = setup({ pane });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    const body = document.querySelector(".plinth-review__body") as HTMLElement;
    expect(body.scrollTop).toBe(900 - 190);
    // Its column starts at the pane's left edge: no part of another column beside it.
    expect(body.scrollLeft).toBe(500);
  });

  /** A sheet-like row: sticky row numbers (48px), then cells of the given widths. */
  const rowPane = (widths: number[], changed: number, scrollWidth: number): ReviewPane => ({
    render(el) {
      const row = document.createElement("tr");
      const num = document.createElement("th");
      num.style.position = "sticky";
      num.getBoundingClientRect = () => new DOMRect(0, 0, 48, 20);
      row.append(num);
      let x = 48;
      for (const [i, w] of widths.entries()) {
        const cell = document.createElement("td");
        const left = x;
        cell.getBoundingClientRect = () => new DOMRect(left, 0, w, 20);
        if (i === changed) cell.setAttribute(CHANGED_ATTR, "");
        row.append(cell);
        x += w;
      }
      el.append(row);
      sized(el, scrollWidth);
      return null;
    },
  });

  it("leaves a sheet's sticky row numbers clear of the cell it scrolls to", async () => {
    const { review } = setup({ pane: rowPane([160, 120, 120, 120, 120], 3, 2000) });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    const body = document.querySelector(".plinth-review__body") as HTMLElement;
    // Column D starts right after the row numbers.
    expect(body.scrollLeft).toBe(48 + 160 + 120 + 120 - 48);
  });

  it("near the far end, starts at a whole column rather than a sliver of one", async () => {
    // 568px wide in a 300px pane: it scrolls at most 268px, which would cut column B.
    const { review } = setup({ pane: rowPane([160, 120, 120, 120], 2, 568) });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE });
    const body = document.querySelector(".plinth-review__body") as HTMLElement;
    // Column B starts after the row numbers instead, and C still shows whole.
    expect(body.scrollLeft).toBe(48 + 160 - 48);
  });
});

describe("the review session", () => {
  function client(over: Partial<LiveDocClient> = {}) {
    return {
      ready: true,
      conflictVersion: 6,
      baseVersion: 5,
      conflictFiles: FILES,
      text: MINE,
      rev: 9,
      editors: ["me@example.org", "ana@example.org"],
      you: { id: "s1", email: "me@example.org", right: "write" },
      ...over,
    } as unknown as LiveDocClient;
  }
  function session(c: LiveDocClient | null, solo: string | null = null) {
    const post = vi.fn();
    const { review } = setup();
    const s = new ReviewSession(review, {
      post,
      rules: RULES as NonNullable<typeof RULES>,
      room: () => c,
      soloText: () => solo,
    });
    // DraftReview's choose goes through the session, as the renderers wire it.
    (review as unknown as { setup: { choose: unknown } }).setup.choose = (
      o: "publish" | "discard" | "cancelled",
      n?: string,
    ) => s.choose(o, n);
    return { s, post, review };
  }
  const NONCE = "n".repeat(24);

  it("room: opens on the room's frozen draft and posts the version and rev reviewed", async () => {
    const c = client();
    const { s, post } = session(c);
    await s.open({ type: "review", nonce: NONCE });
    expect(panes()[1]?.querySelector(".plinth-review__files")?.textContent).toContain(
      "chart.png replaced",
    );
    button("Publish your changes")?.click();
    expect(post).toHaveBeenCalledWith({
      type: "resolved",
      nonce: NONCE,
      outcome: "publish",
      version: 6,
      rev: 9,
    });
    // The app's answer: another editor resolved it first.
    s.answer({ type: "reviewed", nonce: NONCE, result: "resolved" });
    expect(s.isOpen).toBe(false);
  });

  it("room: nothing frozen means nothing to review", async () => {
    const { s, post } = session(client({ conflictVersion: null }));
    await s.open({ type: "review", nonce: NONCE });
    expect(post).toHaveBeenCalledWith({ type: "resolved", nonce: NONCE, outcome: "cancelled" });
    expect(s.isOpen).toBe(false);
  });

  it("closes on the room's reset with why, naming whose choice it was", async () => {
    const { s, post } = session(client());
    await s.open({ type: "review", nonce: NONCE });
    s.version("reset", 7, { why: "published", was: 6 });
    expect(s.isOpen).toBe(false);
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "Another editor published these changes as v7.",
    );
    expect(post).toHaveBeenLastCalledWith({ type: "resolved", nonce: NONCE, outcome: "cancelled" });

    await s.open({ type: "review", nonce: NONCE });
    button("Discard your changes")?.click();
    button("Discard changes")?.click();
    s.version("reset", 6, { why: "discarded", was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "Your changes were discarded. The page shows v6.",
    );
  });

  it("closes on any unfreeze with what really happened, never as another editor's choice", async () => {
    const { s } = session(client());
    await s.open({ type: "review", nonce: NONCE });
    // A doc whose newer version merged cleanly.
    s.version("rebased", 7, { was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 was published, and your changes were kept on top of it.",
    );
    await s.open({ type: "review", nonce: NONCE });
    // A version that is the draft itself.
    s.version("reset", 7, { was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 is the same as your changes, so nothing is left to publish.",
    );
  });

  it("a never-merged type: a version that undid the reviewed one keeps your changes", async () => {
    const post = vi.fn();
    const rules = liveRules("sheet");
    if (!rules) throw new Error("no sheet rules");
    const { review } = setup();
    const s = new ReviewSession(review, {
      post,
      rules,
      room: () => client(),
      soloText: () => null,
    });
    await s.open({ type: "review", nonce: NONCE });
    s.version("rebased", 7, { was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 undid the changes of v6. Your changes are kept.",
    );
  });

  it("a newer version reopens the review on the whole range", async () => {
    const c = client();
    const { s } = session(c);
    await s.open({ type: "review", nonce: NONCE });
    (c as { conflictVersion: number }).conflictVersion = 7;
    s.version("conflict", 7, { was: 6 });
    await vi.waitFor(() =>
      expect(region()?.getAttribute("aria-label")).toBe("Review v6 to v7 and your changes"),
    );
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 was published too. The review now covers v6 to v7.",
    );
  });

  it("solo: opens on the version the app names, and Publish your changes sends the frame's own copy", async () => {
    const { s, post } = session(null, MINE);
    await s.open({ type: "review", nonce: NONCE, n: 6, base: 5, files: FILES });
    button("Publish your changes")?.click();
    expect(post).toHaveBeenCalledWith({
      type: "resolved",
      nonce: NONCE,
      outcome: "publish",
      text: MINE,
    });
  });

  it("solo: a copy the app kept from before a reload is reviewed and published as that copy", async () => {
    // The frame holds a copy of the shown version (edit mode was toggled), not the kept one.
    const { s, post } = session(null, BASE);
    await s.open({ type: "review", nonce: NONCE, n: 6, base: 5, files: FILES, text: MINE });
    expect(s.isOpen).toBe(true);
    expect(panes()[0]?.textContent).toContain("First, by a person.");
    button("Publish your changes")?.click();
    expect(post).toHaveBeenCalledWith({
      type: "resolved",
      nonce: NONCE,
      outcome: "publish",
      text: MINE,
    });
    // Without a copy of its own, too; and a kept copy the type cannot hold is never reviewed.
    const second = session(null, null);
    await second.s.open({ type: "review", nonce: NONCE, n: 6, base: 5, files: FILES, text: MINE });
    expect(second.s.isOpen).toBe(true);
    second.s.choose("cancelled");
    const third = session(null, null);
    await third.s.open({
      type: "review",
      nonce: NONCE,
      n: 6,
      base: 5,
      files: FILES,
      text: "<!doctype html><p>x</p>",
    });
    expect(third.s.isOpen).toBe(false);
    expect(third.post).toHaveBeenCalledWith({
      type: "resolved",
      nonce: NONCE,
      outcome: "cancelled",
    });
  });

  it("reads review messages field by field", () => {
    const m = { source: "plinth-renderer", v: 1, nonce: NONCE };
    expect(readEditMessage({ ...m, type: "review" })).toEqual({ type: "review", nonce: NONCE });
    expect(readEditMessage({ ...m, type: "review", n: 6, base: 5, files: FILES })).toMatchObject({
      n: 6,
      base: 5,
    });
    expect(
      readEditMessage({ ...m, type: "review", n: 6, base: 5, files: FILES, text: MINE }),
    ).toMatchObject({ n: 6, base: 5, text: MINE });
    for (const bad of [
      { ...m, type: "review", n: 6 },
      { ...m, type: "review", n: 5, base: 5, files: FILES },
      { ...m, type: "review", n: 6, base: 5, files: { ...FILES, more: -1 } },
      { ...m, type: "review", text: MINE },
      { ...m, type: "review", n: 6, base: 5, files: FILES, text: 7 },
      { ...m, type: "review", n: 6, base: 5, files: FILES, text: "x".repeat(2 * 1024 * 1024) },
      { ...m, type: "reviewed", result: "maybe" },
      { ...m, type: "review", nonce: "short" },
    ]) {
      expect(readEditMessage(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(readEditMessage({ ...m, type: "reviewed", result: "busy" })).toEqual({
      type: "reviewed",
      nonce: NONCE,
      result: "busy",
    });
    expect(
      readEditMessage({ source: "plinth-renderer", v: 1, type: "edit", on: true, base: 4 }),
    ).toEqual({ type: "edit", on: true, base: 4 });
  });
});

describe("the frame key", () => {
  it("is read once and taken out of the address, keeping any original fragment", () => {
    const key = "A".repeat(43);
    const replace = vi.fn();
    const win = {
      location: { hash: `#plinth-k=${key}&h=intro`, pathname: "/", search: "?x=1" },
      history: { state: null, replaceState: replace },
    } as unknown as Window;
    expect(takeFrameKey(win)).toBe(key);
    expect(replace).toHaveBeenCalledWith(null, "", "/?x=1#intro");
    for (const hash of ["", "#intro", `#plinth-k=${"A".repeat(42)}`, `#plinth-k=${key}x`]) {
      const w = {
        location: { hash, pathname: "/", search: "" },
        history: { replaceState: replace },
      };
      expect(takeFrameKey(w as unknown as Window), hash).toBeNull();
    }
  });
});

describe("a version's own files", () => {
  it("pins the artifact's own files to a version and leaves everything else", () => {
    expect(fileUrl(5, "img/a.png")).toBe("/__plinth/v/5/img/a.png");
    expect(pinnedSrc("img/a.png", 5)).toBe("/__plinth/v/5/img/a.png");
    expect(pinnedSrc("./a.png?x=1", 5)).toBe("/__plinth/v/5/a.png?x=1");
    expect(pinnedSrc("/a.png", 5)).toBe("/__plinth/v/5/a.png");
    for (const src of [
      "https://cdn.example/a.png",
      "//evil.example/a.png",
      "data:image/png;base64,x",
      "/__plinth/v/3/a.png",
      "",
    ]) {
      expect(pinnedSrc(src, 5), src).toBeNull();
    }
    const root = document.createElement("div");
    root.innerHTML = '<img src="chart.png"><img src="https://cdn.example/x.png">';
    pinFiles(root, 5);
    const [a, b] = [...root.querySelectorAll("img")];
    expect(a?.getAttribute("src")).toBe("/__plinth/v/5/chart.png");
    expect(b?.getAttribute("src")).toBe("https://cdn.example/x.png");
    // Pinned again to another version, or back to the page's own.
    pinFiles(root, 6);
    expect(a?.getAttribute("src")).toBe("/__plinth/v/6/chart.png");
    pinFiles(root, null);
    expect(a?.getAttribute("src")).toBe("chart.png");
  });
});
