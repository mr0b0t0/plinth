// The whole-draft review in the frame (review.ts, editSession.ts): both sides rendered read-only
// against their own version's files, the two change lists with their files parts, ranges named,
// exactly two choices and Cancel, the Discard confirmation, the busy state, what closes it, and the
// phone switch. Also the frame key (frameKey.ts) and the file pinning (files.ts).
// @vitest-environment happy-dom
import { type ChangeItem, liveRules } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { ReviewSession, readEditMessage } from "./editSession.ts";
import { fileUrl, pinFiles, pinnedSrc } from "./files.ts";
import { takeFrameKey } from "./frameKey.ts";
import type { LiveDocClient } from "./live.ts";
import { DraftReview, discardDescription, REVIEW_WORDS, type ReviewPane } from "./review.ts";

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

describe("the whole-draft review", () => {
  it("renders both sides read-only, each against the files it would publish", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: FILES, draft: MINE, editors: [] });
    expect(region().getAttribute("aria-label")).toBe("Review v6 and the page changes");
    expect(region().querySelector("h2")?.textContent).toBe(
      "v6 was published while you were editing",
    );
    expect(document.activeElement).toBe(region().querySelector("h2"));
    const [mine, theirs] = panes();
    expect(mine?.querySelector("h3")?.textContent).toBe(
      "Your page changes (not published, based on v5)",
    );
    expect(theirs?.querySelector("h3")?.textContent).toBe("v6");
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

  it("lists both sides' changes, with the files part: none for the page changes", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: FILES, draft: MINE, editors: [] });
    const [mine, theirs] = panes();
    expect(mine?.querySelector("h4")?.textContent).toBe("Your page changes, since v5");
    expect(theirs?.querySelector("h4")?.textContent).toBe("What v6 changed, since v5");
    expect(mine?.querySelector(".plinth-review__files")?.textContent).toContain("No files changed");
    const files = theirs?.querySelector(".plinth-review__files")?.textContent ?? "";
    expect(files).toContain("fonts/geist.woff2 added");
    expect(files).toContain("chart.png replaced");
    expect(files).toContain("and 12 more files");
    // Items are buttons; their text is the describers' plain words.
    expect(mine?.querySelector(".plinth-review__item-button")?.textContent).toMatch(/changed/);
  });

  it("names a range in the heading, the list, the Publish description and the confirmation", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 7, files: null, draft: MINE, editors: [] });
    expect(region().querySelector("h2")?.textContent).toBe(
      "v6 to v7 were published while you were editing",
    );
    expect(panes()[1]?.querySelector("h3")?.textContent).toBe("v7, the latest of v6 to v7");
    expect(panes()[1]?.querySelector("h4")?.textContent).toBe("What v6 to v7 changed, since v5");
    const why = document.getElementById(
      button("Publish mine")?.getAttribute("aria-describedby") ?? "",
    );
    expect(why?.textContent).toBe(REVIEW_WORDS.publish(6, 7, 5));
    expect(why?.textContent).toContain("The text and file changes of v6 to v7");
    expect(why?.textContent).toContain("become v8");
  });

  it("Publish mine asks the app with the note; the buttons go off until the answer", async () => {
    const { review, choose } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE, editors: [] });
    button("Publish mine with a note…")?.click();
    const input = document.querySelector(".plinth-review__note-input") as HTMLInputElement;
    input.value = "Counted again";
    (document.querySelector(".plinth-review__note") as HTMLFormElement).requestSubmit();
    expect(choose).toHaveBeenCalledWith("publish", "Counted again");
    expect(button("Discard mine")?.disabled).toBe(true);
    expect(review.chosen).toBe("publish");
    // Another editor's choice holds the lock: the buttons stay off, with the reason.
    review.answer("busy");
    expect(region().textContent).toContain("Another editor is choosing right now");
    expect(button("Discard mine")?.disabled).toBe(true);
  });

  it("re-enables the choices a while after busy, and keeps them for a failed answer", async () => {
    vi.useFakeTimers();
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE, editors: [] });
    button("Publish mine")?.click();
    review.answer("busy");
    vi.advanceTimersByTime(5000);
    expect(button("Publish mine")?.disabled).toBe(false);
    button("Publish mine")?.click();
    review.answer("failed");
    expect(button("Publish mine")?.disabled).toBe(false);
    expect(review.isOpen).toBe(true);
  });

  it("Discard mine asks first, naming what will be lost, and goes only on confirm", async () => {
    const { review, choose } = setup();
    await review.open({
      mode: "room",
      base: 5,
      n: 6,
      files: null,
      draft: MINE,
      editors: ["ana@example.org", "ben@example.org"],
    });
    button("Discard mine")?.click();
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Discard the page changes?");
    expect(dialog.textContent).toMatch(
      /This change will be lost: .+\. They are not kept anywhere\./,
    );
    expect(dialog.textContent).toContain("The page will show v6.");
    expect(dialog.textContent).toContain(
      "This drops the unpublished changes of everyone editing (ana@example.org, ben@example.org).",
    );
    // Focus starts on Cancel.
    expect(document.activeElement?.textContent).toBe("Cancel");
    (document.activeElement as HTMLButtonElement).click();
    expect(choose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    button("Discard mine")?.click();
    button("Discard the page changes")?.click();
    expect(choose).toHaveBeenCalledWith("discard", undefined);
  });

  it("says how many changes a discard drops, and that solo drops only this tab's", () => {
    const items: ChangeItem[] = Array.from({ length: 7 }, (_, i) => ({
      kind: "changed",
      where: `Slide ${i + 1}`,
      what: "Title changed",
    }));
    expect(discardDescription({ items, truncated: false }, 6, "solo", [])).toBe(
      "These 7 changes will be lost: Slide 1: Title changed, Slide 2: Title changed, Slide 3: Title changed, and 4 more. They are not kept anywhere. The page will show v6.",
    );
    expect(discardDescription({ items: [], truncated: false }, 7, "room", [])).toBe(
      "The page changes will be lost. They are not kept anywhere. The page will show v7. This drops the unpublished changes of everyone editing.",
    );
  });

  it("Cancel closes the review and tells the app; the draft stays frozen", async () => {
    const { review, choose } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE, editors: [] });
    button("Cancel")?.click();
    expect(choose).toHaveBeenCalledWith("cancelled");
    expect(review.isOpen).toBe(false);
    expect(region()).toBeNull();
  });

  it("at phone width shows one side at a time, with a Mine and v6 switch", async () => {
    const { review } = setup();
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE, editors: [] });
    const options = [...document.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(options.map((o) => o.textContent)).toEqual(["Mine", "v6"]);
    expect(region().dataset.show).toBe("mine");
    options[1]?.click();
    expect(region().dataset.show).toBe("theirs");
    expect(options[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("an item brings both panes to its place", async () => {
    const goto = vi.fn(() => true);
    const { review } = setup({ pane: { render: () => goto } });
    await review.open({ mode: "room", base: 5, n: 6, files: null, draft: MINE, editors: [] });
    (document.querySelector(".plinth-review__item-button") as HTMLButtonElement).click();
    expect(goto).toHaveBeenCalledTimes(2);
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
    button("Publish mine")?.click();
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
      "Another editor published the page changes as v7.",
    );
    expect(post).toHaveBeenLastCalledWith({ type: "resolved", nonce: NONCE, outcome: "cancelled" });

    await s.open({ type: "review", nonce: NONCE });
    button("Discard mine")?.click();
    button("Discard the page changes")?.click();
    s.version("reset", 6, { why: "discarded", was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "The page changes were discarded. The page shows v6.",
    );
  });

  it("closes on any unfreeze with what really happened, never as another editor's choice", async () => {
    const { s } = session(client());
    await s.open({ type: "review", nonce: NONCE });
    // A doc whose newer version merged cleanly.
    s.version("rebased", 7, { was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 was published, and your page changes were kept on top of it.",
    );
    await s.open({ type: "review", nonce: NONCE });
    // A version that is the draft itself.
    s.version("reset", 7, { was: 6 });
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 is the same as your page changes, so nothing is left to publish.",
    );
  });

  it("a never-merged type: a version that undid the reviewed one keeps the page changes", async () => {
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
      "v7 undid the changes of v6. Your page changes are kept.",
    );
  });

  it("a newer version reopens the review on the whole range", async () => {
    const c = client();
    const { s } = session(c);
    await s.open({ type: "review", nonce: NONCE });
    (c as { conflictVersion: number }).conflictVersion = 7;
    s.version("conflict", 7, { was: 6 });
    await vi.waitFor(() =>
      expect(region()?.querySelector("h2")?.textContent).toBe(
        "v6 to v7 were published while you were editing",
      ),
    );
    expect(document.querySelector(".plinth-review__announce")?.textContent).toBe(
      "v7 was published too. The review now covers v6 to v7.",
    );
  });

  it("solo: opens on the version the app names, and Publish mine sends the frame's own copy", async () => {
    const { s, post } = session(null, MINE);
    await s.open({ type: "review", nonce: NONCE, n: 6, base: 5, files: FILES });
    button("Publish mine")?.click();
    expect(post).toHaveBeenCalledWith({
      type: "resolved",
      nonce: NONCE,
      outcome: "publish",
      text: MINE,
    });
  });

  it("reads review messages field by field", () => {
    const m = { source: "plinth-renderer", v: 1, nonce: NONCE };
    expect(readEditMessage({ ...m, type: "review" })).toEqual({ type: "review", nonce: NONCE });
    expect(readEditMessage({ ...m, type: "review", n: 6, base: 5, files: FILES })).toMatchObject({
      n: 6,
      base: 5,
    });
    for (const bad of [
      { ...m, type: "review", n: 6 },
      { ...m, type: "review", n: 5, base: 5, files: FILES },
      { ...m, type: "review", n: 6, base: 5, files: { ...FILES, more: -1 } },
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
