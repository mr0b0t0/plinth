// Editing a deck on its page (slides-text), booted from a real shell's payload in a modelled frame
// and edited alone (solo mode, a LocalDeck): edit mode draws every raw slide, empty ones with
// their placeholder; a click opens a block as formatted text and typing sends the block written
// back as Markdown, escaped so it never changes the deck's structure; emptying a slide keeps it as
// an empty slide (trimming a bare opening --- first); speaker notes are one part in their own
// panel; images and blocks the model cannot hold offer Ask an agent; deck settings are one
// set_deck; and the review's deck pane draws each side with its own version's files.
import {
  parseDeck,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, deckPane } from "./boot.ts";
import { DECK_WORDS, EDIT_DEBOUNCE_MS } from "./edit.ts";
import { EDIT_VIEW_WORDS } from "./editView.ts";

const APP = "https://plinth.example.com";

function mount(text: string) {
  const html = typedShellHtml(TYPE_REGISTRY.slides, { title: "T", text, base: "", appOrigin: APP });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

interface Framed {
  win: Window;
  target: EventTarget;
  parent: { postMessage: ReturnType<typeof vi.fn> };
}

function framed(): Framed {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const win = {
    document,
    parent,
    print: vi.fn(),
    innerWidth: 1280,
    innerHeight: 900,
    getSelection: () => window.getSelection(),
    getComputedStyle: (e: Element) => window.getComputedStyle(e),
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent };
}

const msg = (m: Record<string, unknown>) => ({
  source: RENDERER_MESSAGE_SOURCE,
  v: RENDERER_PROTOCOL_VERSION,
  ...m,
});
const appMessage = (f: Framed, data: unknown) =>
  f.target.dispatchEvent(
    new MessageEvent("message", { data, origin: APP, source: f.parent as unknown as Window }),
  );
const posts = (f: Framed) =>
  f.parent.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const NONCE = "n".repeat(20);

/** The solo draft, as the app collects it for Publish. */
function collect(f: Framed): string {
  vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
  appMessage(f, msg({ type: "collect", nonce: NONCE }));
  const d = posts(f)
    .filter((p) => p.type === "draft")
    .at(-1);
  if (!d) throw new Error("no draft");
  return d.text as string;
}

/** The last live status the frame posted. */
const lastStatus = (f: Framed) =>
  posts(f)
    .filter((p) => p.type === "live")
    .at(-1);

function start(text: string): Framed {
  mount(text);
  const f = framed();
  stop = boot(f.win, { measure: () => false });
  appMessage(f, msg({ type: "edit", on: true, base: 1 }));
  return f;
}

/** The shown slide's frame. */
const active = () => document.querySelector(".plinth-slides__frame[data-active]") as HTMLElement;
const editable = () =>
  document.querySelector('.plinth-slides__open [contenteditable="true"]') as HTMLElement;

/** Types into the open block as a browser would: the DOM changes, then `input`. */
function typeText(text: string) {
  const el = editable();
  el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.removeAttribute("data-ready");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SKILL = [
  "---",
  "aspect: 16:9",
  "footer: Q4 review",
  "---",
  "",
  "# Q4 review",
  "",
  "Revenue, hiring and what comes next",
  "",
  "Note: Welcome everyone.",
  "",
  "---",
  "",
  "## Revenue",
  "",
  "- Up 18% on Q3",
  "- Two new enterprise accounts",
  "",
  "![Revenue by month](chart.png)",
  "",
  "Note: The September dip was a billing change.",
  "",
].join("\n");

describe("edit mode", () => {
  it("draws every raw slide, an empty one at the edge with its placeholder and label", () => {
    const f = start("---\n\n# Intro\n\n---\n\n# Next\n");
    expect(document.querySelectorAll(".plinth-slides__frame")).toHaveLength(3);
    // The deck starts on the first slide it shows, now raw slide 2.
    expect(active().dataset.n).toBe("2");
    const first = document.querySelector('.plinth-slides__frame[data-n="1"]') as HTMLElement;
    expect(first.querySelector(".plinth-slides__hidden")?.textContent).toBe(EDIT_VIEW_WORDS.hidden);
    const ph = first.querySelector(".plinth-slides__placeholder") as HTMLButtonElement;
    expect(ph.textContent).toBe(EDIT_VIEW_WORDS.placeholder);
    expect(ph.getAttribute("aria-label")).toContain(DECK_WORDS.empty(1));
    // Each text element is a focus stop named by its role and place, never its text.
    const h = active().querySelector("h1") as HTMLElement;
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute("aria-label")).toBe("Slide 2, heading 1, editable");
    expect(f).toBeTruthy();
  });

  it("edits a block in place and changes only its lines", () => {
    const f = start(SKILL);
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("ul") as HTMLElement).click();
    expect(editable()).not.toBeNull();
    const walker = document.createTreeWalker(editable(), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (t.data.includes("18%")) t.data = t.data.replace("18%", "14%");
    }
    editable().dispatchEvent(new Event("input", { bubbles: true }));
    const text = collect(f);
    expect(text).toBe(SKILL.replace("Up 18%", "Up 14%"));
    expect(parseDeck(text).settings.footer).toBe("Q4 review");
  });

  it("writes text that reads as deck structure so that it stays text", () => {
    const f = start("# A\n\nbody\n\n---\n\n# B\n");
    (active().querySelector("p") as HTMLElement).click();
    typeText("---");
    let text = collect(f);
    expect(text).toBe("# A\n\n\\---\n\n---\n\n# B\n");
    typeText("Note: hello");
    text = collect(f);
    expect(text).toBe("# A\n\n\\Note: hello\n\n---\n\n# B\n");
    expect(parseDeck(text).slides.map((s) => s.notes)).toEqual(["", ""]);
    expect(parseDeck(text).slides).toHaveLength(2);
  });

  it("keeps an emptied New deck as one empty slide: Publish off, then a new title", async () => {
    const f = start("# Untitled deck\n");
    (active().querySelector("h1") as HTMLElement).click();
    typeText("");
    let text = collect(f);
    expect(text).toBe("");
    await Promise.resolve();
    expect(lastStatus(f)?.publishable).toBe(false);
    // The editor closes (Esc), and the slide shows its placeholder.
    editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const ph = active().querySelector(".plinth-slides__placeholder") as HTMLButtonElement;
    expect(ph).not.toBeNull();
    ph.click();
    typeText("Q1 plan");
    text = collect(f);
    expect(text).toBe("# Q1 plan\n");
    await Promise.resolve();
    expect(lastStatus(f)?.publishable).toBe(true);
  });

  it("trims a bare opening --- before emptying the slide under it", () => {
    const f = start("---\n\n# Intro\n\n---\n\n# Next");
    (active().querySelector("h1") as HTMLElement).click();
    typeText("");
    const text = collect(f);
    expect(text).toBe("\n\n---\n\n# Next");
    expect(parseDeck(text).settings).toEqual(parseDeck("# A").settings);
  });

  it("sends one blank line above an agent's setting-like line", () => {
    const f = start("# Intro\n---\naspect: 4:3\n---\n# Next");
    (active().querySelector("h1") as HTMLElement).click();
    typeText("");
    expect(collect(f)).toBe(" \n---\naspect: 4:3\n---\n# Next");
  });

  it("escapes a setting-like line typed in the slide after a bare opening ---", () => {
    const f = start("---\nIntro text\n---\n# Next");
    (active().querySelector("p") as HTMLElement).click();
    typeText("Date: 3 March");
    const text = collect(f);
    expect(text).toBe("---\nDate\\: 3 March\n---\n# Next");
    expect(parseDeck(text).slides).toHaveLength(2);
  });
});

describe("speaker notes", () => {
  it("edits the notes as one part and keeps the marker on its line", () => {
    const f = start(SKILL);
    const body = active().querySelector(".plinth-slides__notepad-body") as HTMLElement;
    expect(active().querySelector(".plinth-slides__notepad-title")?.textContent).toBe(
      DECK_WORDS.notes(1),
    );
    body.click();
    const ed = active().querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    ed.textContent = "Welcome, everyone.";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    const text = collect(f);
    expect(text).toBe(SKILL.replace("Note: Welcome everyone.", "Note: Welcome, everyone."));
    expect(parseDeck(text).slides[0]?.notes).toBe("Welcome, everyone.");
  });

  it("adds speaker notes to a slide without them, and removes them", () => {
    const f = start("# A\n\nbody\n\n---\n\n# B\n");
    const add = active().querySelector(".plinth-slides__notepad-add") as HTMLButtonElement;
    expect(add.textContent).toBe(DECK_WORDS.addNotes);
    add.click();
    vi.advanceTimersByTime(1);
    const ed = active().querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    expect(ed).not.toBeNull();
    ed.textContent = "Say hello.";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    let text = collect(f);
    expect(parseDeck(text).slides[0]?.notes).toBe("Say hello.");
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (active().querySelector(".plinth-slides__notepad-remove") as HTMLButtonElement).click();
    text = collect(f);
    expect(text).toBe("# A\n\nbody\n\n---\n\n# B\n");
  });
});

describe("what is left to an agent", () => {
  it("offers Ask an agent and Delete on an image, with a structural anchor", () => {
    const f = start(SKILL);
    appMessage(f, msg({ type: "goto", slide: 2 }));
    const img = active().querySelector("img") as HTMLImageElement;
    // Drawn from the draft's base version's files.
    expect(img.getAttribute("src")).toBe("/__plinth/v/1/chart.png");
    (img.closest("[data-plinth-edit]") as HTMLElement).click();
    const bar = active().querySelector(".plinth-slides__blockbar") as HTMLElement;
    const [ask, del] = Array.from(bar.querySelectorAll("button"));
    expect(ask?.textContent).toBe(DECK_WORDS.askImage);
    ask?.click();
    const sent = posts(f)
      .filter((p) => p.type === "ask")
      .at(-1);
    expect(sent).toMatchObject({
      anchor: { key: "slide-2:image-1", text: "Slide 2, image 1" },
      what: "image",
    });
    (img.closest("[data-plinth-edit]") as HTMLElement).click();
    (active().querySelector(".plinth-slides__blockbar button:last-child") as HTMLElement).click();
    expect(del?.textContent).toBe(DECK_WORDS.delete);
    expect(collect(f)).not.toContain("chart.png");
  });

  it("shows a block the model cannot hold as it is, with Ask an agent", () => {
    const f = start("# A\n\n    indented code\n");
    const pre = active().querySelector("pre") as HTMLElement;
    expect(pre.getAttribute("data-plinth-edit")).toBe("other");
    pre.click();
    const ask = active().querySelector(".plinth-slides__blockbar button") as HTMLButtonElement;
    expect(ask.textContent).toBe(DECK_WORDS.askBlock);
    ask.click();
    expect(
      posts(f)
        .filter((p) => p.type === "ask")
        .at(-1),
    ).toMatchObject({
      anchor: { key: "slide-1:block-2" },
    });
  });
});

describe("deck settings", () => {
  it("opens from the app's message and writes the front matter canonically", () => {
    const f = start("# A\n");
    appMessage(f, msg({ type: "deck_settings" }));
    const pop = document.querySelector(
      '[role="dialog"][aria-label="Deck settings"]',
    ) as HTMLElement;
    expect(pop).not.toBeNull();
    const [aspect, theme] = Array.from(pop.querySelectorAll("select"));
    (aspect as HTMLSelectElement).value = "4:3";
    (theme as HTMLSelectElement).value = "dark";
    const footer = pop.querySelector('input[type="text"]') as HTMLInputElement;
    footer.value = " Q1 plan ";
    (pop.querySelector(".plinth-slides__settings-apply") as HTMLButtonElement).click();
    const text = collect(f);
    expect(text).toBe("---\naspect: 4:3\ntheme: dark\nfooter: Q1 plan\n---\n# A\n");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.documentElement.getAttribute("data-aspect")).toBe("4:3");
  });
});

describe("the review's deck pane", () => {
  it("draws each side with its own version's files and marks the slides that changed", () => {
    const pane = deckPane(document);
    const host = document.createElement("div");
    document.body.append(host);
    const base = "# A\n---\n## B\n\n![c](chart.png)";
    const mine = "# A\n---\n## B, edited\n\n![c](chart.png)";
    const goto = pane.render(host, mine, 5, base);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/__plinth/v/5/chart.png");
    const frames = Array.from(host.querySelectorAll(".plinth-slides__frame"));
    expect(frames.map((x) => x.hasAttribute("data-review-changed"))).toEqual([false, true]);
    expect(goto?.({ kind: "changed", where: "Slide 2", what: "Title changed" })).toBe(true);
  });
});
