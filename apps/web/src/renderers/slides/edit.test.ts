// Editing a deck on its page (slides-text), booted from a real shell's payload in a modelled frame
// and edited alone (solo mode, a LocalDeck): edit mode draws every raw slide, empty ones with
// their placeholder; a click opens a block as formatted text and typing sends the block written
// back as Markdown, escaped so it never changes the deck's structure; emptying a slide keeps it as
// an empty slide (trimming a bare opening --- first); speaker notes are one part in their own
// panel; images and blocks the model cannot hold offer Ask an agent; deck settings are one
// set_deck; and the review's deck pane draws each side with its own version's files.
import {
  LIMITS,
  liveSlidesTooLarge,
  parseDeck,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRescue, mergeRescue } from "../../components/editor/draft.ts";
import { readRescueItems } from "../../components/viewer/rendererProtocol.ts";
import { boot, deckPane } from "./boot.ts";
import {
  DECK_WORDS,
  EDIT_DEBOUNCE_MS,
  holderName,
  LocalDeck,
  NOTICE_MS,
  placeBar,
} from "./edit.ts";
import { EDIT_VIEW_WORDS, type EditBlock } from "./editView.ts";
import type { Geometry } from "./exportModel.ts";
import type { PptxBuilder } from "./pptxModel.ts";
import { EDIT_NOTES_H, GUTTER } from "./stage.ts";

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

/** The texts of the items the frame's rescue reports put in the app's store, and still there. */
function rescued(f: Framed): string[] {
  const items = new Map<string, string>();
  for (const p of posts(f).filter((x) => x.type === "rescue")) {
    for (const it of readRescueItems(p.upsert) ?? []) items.set(it.id, it.text);
    for (const id of [...((p.written as string[]) ?? []), ...((p.gone as string[]) ?? [])]) {
      items.delete(id);
    }
  }
  return [...items.values()];
}

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
  it("draws every raw slide, an empty one at the edge with its placeholder", () => {
    const f = start("---\n\n# Intro\n\n---\n\n# Next\n");
    expect(document.querySelectorAll(".plinth-slides__frame")).toHaveLength(3);
    // The deck starts on the first slide it shows, now raw slide 2.
    expect(active().dataset.n).toBe("2");
    const first = document.querySelector('.plinth-slides__frame[data-n="1"]') as HTMLElement;
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
    // The panel is named for its slide; it shows the notes and nothing else: no heading, no
    // button (emptying the field is how notes are removed).
    const panel = active().querySelector(".plinth-slides__notepad") as HTMLElement;
    expect(panel.getAttribute("aria-label")).toBe(DECK_WORDS.notes(1));
    expect(panel.querySelector("h2")).toBeNull();
    expect(panel.querySelector("button")).toBeNull();
    body.click();
    const ed = active().querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    // Open, the whole card shows it, as an open block on the slide does.
    expect(active().querySelector(".plinth-slides__notepad")?.hasAttribute("data-open")).toBe(true);
    ed.textContent = "Welcome, everyone.";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    const text = collect(f);
    expect(text).toBe(SKILL.replace("Note: Welcome everyone.", "Note: Welcome, everyone."));
    expect(parseDeck(text).slides[0]?.notes).toBe("Welcome, everyone.");
  });

  it("adds speaker notes to a slide without them; emptied and left, they are no notes", () => {
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
    ed.textContent = "";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    text = collect(f);
    expect(text).toBe("# A\n\nbody\n\n---\n\n# B\n");
    // The panel is its one placeholder again.
    expect(active().querySelector(".plinth-slides__notepad-add")?.textContent).toBe(
      DECK_WORDS.addNotes,
    );
  });

  it("leaves no notes behind when Add speaker notes is left without typing", () => {
    const f = start("# A\n\nbody\n");
    (active().querySelector(".plinth-slides__notepad-add") as HTMLButtonElement).click();
    vi.advanceTimersByTime(1);
    const ed = active().querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(collect(f)).toBe("# A\n\nbody\n");
  });

  it("draws empty notes as none, and opens them in place rather than adding more", () => {
    const deck = "# A\n\nbody\n\nNote:\n";
    const f = start(deck);
    const add = active().querySelector(".plinth-slides__notepad-add") as HTMLButtonElement;
    expect(add.textContent).toBe(DECK_WORDS.addNotes);
    add.click();
    const ed = active().querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    ed.textContent = "Hi.";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    // The marker keeps its form (alone on its line).
    expect(collect(f)).toBe("# A\n\nbody\n\nNote:\nHi.\n");
  });
});

describe("speaker notes after the deck's start moves", () => {
  it("opens the new notes on their own slide when the op drops a bare opening ---", () => {
    // Adding notes ends with the line-0 step, which removes the bare `---` and so the empty
    // slide before Intro: Intro becomes raw slide 1, and the notes opened are Intro's.
    const f = start("---\n# Intro\n---\n# Next\n\nNote: x");
    expect(active().dataset.n).toBe("2");
    (active().querySelector(".plinth-slides__notepad-add") as HTMLButtonElement).click();
    vi.advanceTimersByTime(1);
    const ed = document.querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    expect(ed).not.toBeNull();
    ed.textContent = "Say hello.";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    const slides = parseDeck(collect(f)).slides;
    expect(slides.map((x) => x.notes)).toEqual(["Say hello.", "x"]);
  });
});

describe("print and the .pptx while editing", () => {
  it("hold edit mode off while they run, so they take the deck, and turn it back on after", async () => {
    const f = start(SKILL);
    const root = () => document.getElementById("__plinth-slides");
    expect(root()?.hasAttribute("data-editing")).toBe(true);
    // Print: the deck prints, not edit mode's raw slides; edit mode comes back after the dialog.
    appMessage(f, msg({ type: "print" }));
    expect(root()?.getAttribute("data-print")).toBe("slides");
    expect(root()?.hasAttribute("data-editing")).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    f.target.dispatchEvent(new Event("afterprint"));
    expect(root()?.hasAttribute("data-print")).toBe(false);
    expect(root()?.hasAttribute("data-editing")).toBe(true);
  });

  it("makes the .pptx from the deck while editing, then edits again", async () => {
    mount("# One\n---\n# Two");
    const f = framed();
    const build = vi.fn<PptxBuilder>(async () => ({ blob: new Blob(["pk"]), imagesSkipped: 0 }));
    const save = vi.fn();
    const geometry: Geometry = {
      rect: (e) =>
        e.localName === "section"
          ? { left: 0, top: 0, width: 1280, height: 720 }
          : { left: 80, top: 64, width: 400, height: 40 },
      style: (e) => window.getComputedStyle(e),
    };
    stop = boot(f.win, {
      measure: () => false,
      loadWriter: async () => build,
      save,
      opaque: false,
      geometry,
    });
    appMessage(f, msg({ type: "edit", on: true, base: 1 }));
    const root = () => document.getElementById("__plinth-slides");
    expect(root()?.hasAttribute("data-editing")).toBe(true);
    appMessage(f, msg({ type: "export", format: "pptx", nonce: NONCE }));
    expect(root()?.hasAttribute("data-editing")).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(build).toHaveBeenCalledTimes(1);
    // The deck's two slides, not edit mode's raw ones.
    expect(build.mock.calls[0]?.[0].slides).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(posts(f).filter((p) => p.type === "exported")).toEqual([
      expect.objectContaining({ type: "exported", nonce: NONCE, ok: true }),
    ]);
    expect(root()?.hasAttribute("data-editing")).toBe(true);
  });

  it("makes no file from edit mode's slides when editing starts while an export waits", async () => {
    mount("---\n# One\n---\n# Two");
    const f = framed();
    const build = vi.fn<PptxBuilder>(async () => ({ blob: new Blob(["pk"]), imagesSkipped: 0 }));
    const save = vi.fn();
    const geometry: Geometry = {
      rect: (e) =>
        e.localName === "section"
          ? { left: 0, top: 0, width: 1280, height: 720 }
          : { left: 80, top: 64, width: 400, height: 40 },
      style: (e) => window.getComputedStyle(e),
    };
    stop = boot(f.win, {
      measure: () => false,
      loadWriter: async () => build,
      save,
      opaque: false,
      geometry,
    });
    appMessage(f, msg({ type: "export", format: "pptx", nonce: NONCE }));
    // Editing starts before the export measured the deck (it waits for images first): edit
    // mode's raw slides (the empty first one, with its placeholder) are never the file's.
    appMessage(f, msg({ type: "edit", on: true, base: 1 }));
    expect(document.querySelectorAll(".plinth-slides__frame")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(build).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(posts(f).filter((p) => p.type === "exported")).toEqual([
      expect.objectContaining({ type: "exported", nonce: NONCE, ok: false }),
    ]);
  });
});

describe("presenting alone", () => {
  it("shows the published deck and counts its slides, whatever the frame's own draft", () => {
    const f = start("# One\n---\n# Two\n---\n# Three");
    // The frame's own draft empties slide 3 (so it shows two slides), and edit mode ends.
    appMessage(f, msg({ type: "goto", slide: 3 }));
    (active().querySelector("h1") as HTMLElement).click();
    typeText("");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    appMessage(f, msg({ type: "edit", on: false }));
    const html = document.documentElement;
    expect(html.getAttribute("data-count")).toBe("2");
    // Full screen and presenter view show the version this frame is of.
    appMessage(f, msg({ type: "presenting", on: true }));
    expect(html.getAttribute("data-count")).toBe("3");
    appMessage(f, msg({ type: "presenting", on: false }));
    expect(html.getAttribute("data-count")).toBe("2");
    appMessage(f, msg({ type: "view", mode: "presenter" }));
    expect(html.getAttribute("data-count")).toBe("3");
    appMessage(f, msg({ type: "view", mode: "deck" }));
    expect(html.getAttribute("data-count")).toBe("2");
  });
});

describe("edit mode's layout", () => {
  it("never resizes the slide for the notice, and at phone width puts the controls under the notes", () => {
    mount(SKILL);
    const f = framed();
    Object.assign(f.win, { innerWidth: 360, innerHeight: 640 });
    stop = boot(f.win, { measure: () => false });
    appMessage(f, msg({ type: "edit", on: true, base: 1 }));
    const root = document.getElementById("__plinth-slides") as HTMLElement;
    expect(root.hasAttribute("data-top")).toBe(true);
    const s = (360 - 2 * GUTTER) / 1280;
    expect(root.style.getPropertyValue("--under-notes")).toBe(
      `${Math.ceil(GUTTER + 720 * s + EDIT_NOTES_H)}px`,
    );
    const scaled = root.style.getPropertyValue("--s");
    // A notice floats over the stage: the slide keeps its size when one shows.
    const notice = document.createElement("div");
    notice.className = "plinth-slides__notice";
    notice.textContent = "Someone is editing this.";
    root.append(notice);
    f.target.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--s")).toBe(scaled);
    expect(root.style.getPropertyValue("--notice-h")).toBe("");
    // Wide, the slide is centred again and nothing is placed under the notes.
    Object.assign(f.win, { innerWidth: 1280, innerHeight: 900 });
    f.target.dispatchEvent(new Event("resize"));
    expect(root.hasAttribute("data-top")).toBe(false);
    expect(root.style.getPropertyValue("--under-notes")).toBe("");
  });
});

describe("what is left to an agent", () => {
  it("offers only Ask an agent on an image, with a structural anchor", () => {
    const f = start(SKILL);
    appMessage(f, msg({ type: "goto", slide: 2 }));
    const img = active().querySelector("img") as HTMLImageElement;
    // Drawn from the draft's base version's files.
    expect(img.getAttribute("src")).toBe("/__plinth/v/1/chart.png");
    const block = img.closest("[data-plinth-edit]") as HTMLElement;
    // Its tint and selection are drawn on the image, not the paragraph as wide as the slide.
    expect(block.hasAttribute("data-plinth-image")).toBe(true);
    block.click();
    expect(block.hasAttribute("data-selected")).toBe(true);
    const bar = active().querySelector(".plinth-slides__blockbar") as HTMLElement;
    // Adding, replacing and deleting images stay with agents: one action, no Delete.
    const buttons = Array.from(bar.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual([DECK_WORDS.ask]);
    const ask = buttons[0];
    expect(ask?.textContent).toBe(DECK_WORDS.ask);
    expect(ask?.getAttribute("aria-description")).toBe(DECK_WORDS.imageNote);
    ask?.click();
    expect(block.hasAttribute("data-selected")).toBe(false);
    const sent = posts(f)
      .filter((p) => p.type === "ask")
      .at(-1);
    expect(sent).toMatchObject({
      anchor: { key: "slide-2:image-1", text: "Slide 2, image 1" },
      what: "image",
    });
    expect(collect(f)).toContain("chart.png");
  });

  it("shows a block the model cannot hold as it is, with Ask an agent", () => {
    const f = start("# A\n\n    indented code\n");
    const pre = active().querySelector("pre") as HTMLElement;
    expect(pre.getAttribute("data-plinth-edit")).toBe("other");
    expect(pre.hasAttribute("data-plinth-image")).toBe(false);
    pre.click();
    const ask = active().querySelector(".plinth-slides__blockbar button") as HTMLButtonElement;
    expect(ask.textContent).toBe(DECK_WORDS.ask);
    expect(ask.getAttribute("aria-description")).toBe(DECK_WORDS.readOnly);
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
      `[role="dialog"][aria-label="${DECK_WORDS.settings}"]`,
    ) as HTMLElement;
    expect(pop).not.toBeNull();
    // The dialog takes focus itself: no setting is ringed before a key moves to it.
    expect(document.activeElement).toBe(pop);
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

describe("the editor's words", () => {
  it("name whoever holds a place by a first name, never by an address", () => {
    expect(DECK_WORDS.held(holderName("ana.costa@example.com"), 3)).toBe("Ana is editing slide 3.");
    expect(holderName("42@example.com")).toBe(DECK_WORDS.someone);
    expect(holderName(undefined)).toBe(DECK_WORDS.someone);
  });
});

describe("a selected block's bar", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

  function placed(blockTop: number, avoid: DOMRect[] = []) {
    const frame = document.createElement("div");
    const p = document.createElement("p");
    const img = document.createElement("img");
    p.append(img);
    frame.append(p);
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(100, 50, 800, 450));
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue(rect(400, 50 + blockTop, 200, 100));
    vi.spyOn(p, "getBoundingClientRect").mockReturnValue(rect(150, 50 + blockTop, 700, 100));
    const bar = document.createElement("div");
    Object.defineProperty(bar, "offsetWidth", { value: 160 });
    Object.defineProperty(bar, "offsetHeight", { value: 40 });
    placeBar(bar, { nodes: [p] } as unknown as EditBlock, frame, avoid);
    return bar.style;
  }

  it("sits just above an image, at its right edge", () => {
    const s = placed(200);
    expect(s.top).toBe("154px");
    expect(s.left).toBe("340px");
  });

  it("goes below it when there is no room above", () => {
    expect(placed(10).top).toBe("116px");
  });

  it("goes below it when above would cover more of the slide's other text", () => {
    // A list right above the image.
    expect(placed(200, [rect(150, 210, 700, 36)]).top).toBe("306px");
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

describe("typing the deck cannot write as typed, alone", () => {
  /** Leaves typing in the open block that cannot be written as Markdown as it stands. */
  const stick = () => {
    const el = editable();
    // Emphasis and strong that overlap without nesting, as a browser can leave them.
    el.innerHTML = "<em>a<strong>b</strong></em><strong>c</strong>";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
  };

  it("is in the app's rescue store, without its marks, and marked unsavable", async () => {
    const f = start("# One\n---\n## Two");
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("h2") as HTMLElement).click();
    stick();
    await Promise.resolve();
    expect(lastStatus(f)).toMatchObject({ unsavable: true, publishable: false });
    appMessage(f, msg({ type: "collect", nonce: NONCE }));
    const d = posts(f)
      .filter((p) => p.type === "draft")
      .at(-1);
    // The app's kept copy is the deck as written; the typing is kept beside it.
    expect(d).toMatchObject({ text: "# One\n---\n## Two", unsavable: true });
    expect(rescued(f)).toEqual(["## abc"]);
    // The keystroke is not undone.
    expect(editable().textContent).toBe("abc");
  });

  it("sends no save from the frame's Cmd/Ctrl+S while it cannot be written", () => {
    const f = start("# One\n---\n## Two");
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("h2") as HTMLElement).click();
    stick();
    f.target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }),
    );
    expect(posts(f).some((p) => p.type === "save")).toBe(false);
    // Once it can be written, the shortcut publishes again.
    typeText("Two again");
    f.target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }),
    );
    expect(posts(f).some((p) => p.type === "save")).toBe(true);
    expect(collect(f)).toBe("# One\n---\n## Two again");
  });

  it("is written without its marks when edit mode ends, not lost with the block", async () => {
    const f = start("# One\n---\n## Two");
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("h2") as HTMLElement).click();
    stick();
    appMessage(f, msg({ type: "edit", on: false }));
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    appMessage(f, msg({ type: "edit", on: true }));
    expect(collect(f)).toBe("# One\n---\n## abc");
    await Promise.resolve();
    expect(lastStatus(f)?.unsavable).toBeUndefined();
  });
});

describe("typing a deck at its size limit cannot take, alone", () => {
  // A third slide fills the deck to 23 bytes under its size limit; the typing adds 104.
  const deck = `# One\n---\n## Two\n---\n${"y".repeat(LIMITS.maxSlidesBytes - 40)}`;
  const typed = `Two ${"z".repeat(100)}`;
  /** The last draft the frame answered a `collect` with. */
  const lastDraft = (f: Framed) =>
    posts(f)
      .filter((p) => p.type === "draft")
      .at(-1);

  /** Opens slide 2's title and types more than the deck can take, pausing when `paused`. */
  const typeTooMuch = (paused = true) => {
    const f = start(deck);
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("h2") as HTMLElement).click();
    typeText(typed);
    if (paused) vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    return f;
  };

  it("keeps it in its block and tells the app nothing can be published", async () => {
    const f = typeTooMuch();
    // Not written, and not put back: the block still holds what was typed.
    expect(editable().textContent).toBe(typed);
    await Promise.resolve();
    // The app's Publish, Done and leave warning all read `unsavable` in solo mode.
    expect(lastStatus(f)).toMatchObject({ unsavable: true, publishable: false });
  });

  it("answers the app's collect (Publish) as unsavable, its copy one that can be published", () => {
    const f = typeTooMuch();
    appMessage(f, msg({ type: "collect", nonce: NONCE }));
    // The kept copy is the deck as written, within its size limit, so a reload can still publish
    // every edit written before; the typing it could not take is in the rescue store beside it.
    expect(lastDraft(f)).toEqual(
      expect.objectContaining({ type: "draft", nonce: NONCE, text: deck, unsavable: true }),
    );
    expect(liveSlidesTooLarge(deck)).toBe(false);
    expect(rescued(f)).toEqual([`## ${typed}`]);
  });

  it("answers a collect right after typing as unsavable too, before the pause ends", () => {
    const f = typeTooMuch(false);
    appMessage(f, msg({ type: "collect", nonce: NONCE }));
    expect(lastDraft(f)).toMatchObject({ text: deck, unsavable: true });
    expect(rescued(f)).toEqual([`## ${typed}`]);
  });

  it("keeps the edits written before it publishable in the kept copy", () => {
    const f = start(deck);
    // An edit the deck takes, then typing it cannot.
    (active().querySelector("h1") as HTMLElement).click();
    typeText("Uno");
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector("h2") as HTMLElement).click();
    typeText(typed);
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    appMessage(f, msg({ type: "collect", nonce: NONCE }));
    const kept = lastDraft(f);
    expect(kept).toMatchObject({ text: deck.replace("# One", "# Uno"), unsavable: true });
    expect(liveSlidesTooLarge(kept?.text as string)).toBe(false);
    expect(rescued(f)).toEqual([`## ${typed}`]);
  });

  it("sends no save from the frame's Cmd/Ctrl+S", () => {
    const f = typeTooMuch();
    f.target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }),
    );
    expect(posts(f).some((p) => p.type === "save")).toBe(false);
    expect(document.querySelector(".plinth-slides__live")?.textContent).toBe(DECK_WORDS.fullHere);
    // Said on the page too, for a few seconds, in the one notice over the stage; the live region
    // reads it.
    const notices = document.querySelectorAll(".plinth-slides__notice");
    expect(notices).toHaveLength(1);
    const toast = notices[0];
    expect(toast?.textContent).toBe(DECK_WORDS.fullHere);
    expect(toast?.getAttribute("aria-hidden")).toBe("true");
    expect(toast?.closest(".plinth-slides__slide")).toBeNull();
    vi.advanceTimersByTime(NOTICE_MS + 1);
    expect(document.querySelector(".plinth-slides__notice")).toBeNull();
  });

  it.each([false, true])(
    "keeps its block open, as typed, on Escape (after the pause: %s)",
    async (paused) => {
      const f = typeTooMuch(paused);
      editable().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".plinth-slides__open")).not.toBeNull();
      expect(editable().textContent).toBe(typed);
      expect(document.querySelector(".plinth-slides__live")?.textContent).toBe(DECK_WORDS.fullHere);
      await Promise.resolve();
      expect(lastStatus(f)?.unsavable).toBe(true);
    },
  );

  it("keeps its block open when another block is clicked", () => {
    typeTooMuch();
    (document.querySelector('.plinth-slides__frame[data-n="1"] h1') as HTMLElement).click();
    expect(editable().textContent).toBe(typed);
    expect(document.querySelectorAll(".plinth-slides__open")).toHaveLength(1);
  });

  it("is written, and publishable again, once shortened", async () => {
    const f = typeTooMuch();
    typeText("Two, short");
    const text = collect(f);
    expect(text).toBe(deck.replace("## Two\n", "## Two, short\n"));
    expect(lastDraft(f)?.unsavable).toBeUndefined();
    await Promise.resolve();
    expect(lastStatus(f)?.unsavable).toBeUndefined();
    expect(lastStatus(f)?.publishable).toBe(true);
  });

  it("is kept with Copy when edit mode ends anyway, and opens again when it starts", async () => {
    // The app's Done ends edit mode at once when nothing was written yet and no status said
    // otherwise (typing inside the pause): the frame keeps the typing.
    const f = typeTooMuch(false);
    appMessage(f, msg({ type: "edit", on: false }));
    expect(document.querySelector(".plinth-slides__open")).toBeNull();
    const bar = document.querySelector(".plinth-slides__kept");
    expect(bar?.textContent).toContain(DECK_WORDS.stuckKept);
    expect(bar?.querySelector("button")?.textContent).toBe(DECK_WORDS.copy);
    await Promise.resolve();
    expect(lastStatus(f)).toMatchObject({ unsavable: true, publishable: false });
    // Publish sees it; the app's kept copy is the deck as written, the typing in its store.
    appMessage(f, msg({ type: "collect", nonce: NONCE }));
    const kept = lastDraft(f);
    expect(kept?.unsavable).toBe(true);
    expect(kept?.text).toBe(deck);
    expect(rescued(f)).toEqual([`## ${typed}`]);
    // Editing again opens it in a block of its own, to be shortened.
    appMessage(f, msg({ type: "edit", on: true }));
    expect(editable().textContent).toBe(typed);
    expect(document.querySelector(".plinth-slides__kept")).toBeNull();
    typeText("Two, again");
    expect(collect(f)).toBe(deck.replace("## Two\n", "## Two\n\n## Two, again\n"));
    expect(lastDraft(f)?.unsavable).toBeUndefined();
    // Written: the store lets it go.
    expect(rescued(f)).toEqual([]);
  });

  it("is written back from the app's store after a reload, once the deck can take it", async () => {
    const USER = "u1";
    const ART = "art1";
    sessionStorage.clear();
    let f = typeTooMuch();
    for (const p of posts(f).filter((x) => x.type === "rescue")) {
      mergeRescue(USER, ART, readRescueItems(p.upsert) ?? [], [
        ...((p.written as string[]) ?? []),
        ...((p.gone as string[]) ?? []),
      ]);
    }
    // A reload: the kept copy was published from the notice with some room made, and editing
    // starts again on it; the app offers what its store kept.
    stop?.();
    stop = undefined;
    const roomy = `# One\n---\n## Two\n---\n${"y".repeat(100)}`;
    f = start(roomy);
    appMessage(f, msg({ type: "rescue", items: readRescueItems(loadRescue(USER, ART)) }));
    await Promise.resolve();
    const text = collect(f);
    expect(text).toContain(typed);
    expect(parseDeck(text).slides[1]?.head).toContain(typed);
    sessionStorage.clear();
  });
});

describe("speaker notes the deck at its size limit cannot take, alone", () => {
  const deck = `# One\n\nNote: hi\n---\n${"y".repeat(LIMITS.maxSlidesBytes - 40)}`;
  const more = `hi ${"z".repeat(200)}`;

  /** Opens slide 1's notes and types more than the deck can take. */
  const typeTooMuch = () => {
    const f = start(deck);
    (active().querySelector(".plinth-slides__notepad-body") as HTMLElement).click();
    const ed = document.querySelector(
      '.plinth-slides__notepad-edit [contenteditable="true"]',
    ) as HTMLElement;
    ed.textContent = more;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS + 1);
    return { f, ed };
  };

  it("refuses to add notes elsewhere while the open notes hold that typing", async () => {
    const { f, ed } = typeTooMuch();
    // Another slide's Add speaker notes: no struct op goes out from under the open notes.
    appMessage(f, msg({ type: "goto", slide: 2 }));
    (active().querySelector(".plinth-slides__notepad-add") as HTMLButtonElement).click();
    vi.advanceTimersByTime(1);
    // Nothing changed: the notes are in the deck, still open with the typing, under their lease.
    expect(collect(f)).toBe(deck);
    expect(ed.isConnected).toBe(true);
    expect(ed.textContent).toBe(more);
    expect(document.querySelector(".plinth-slides__live")?.textContent).toBe(DECK_WORDS.fullHere);
    await Promise.resolve();
    expect(lastStatus(f)?.unsavable).toBe(true);
    // Shortened, it is written in place, and the notes close as usual.
    ed.textContent = "short";
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    const text = collect(f);
    expect(text).toBe(deck.replace("Note: hi", "Note: short"));
    expect(parseDeck(text).slides[1]?.notes).toBe("");
    await Promise.resolve();
    expect(lastStatus(f)?.unsavable).toBeUndefined();
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".plinth-slides__notepad-edit")).toBeNull();
  });
});

describe("a local deck's struct op that removes its held lines", () => {
  it("ends the lease through lost(), as a room's closed draft does", () => {
    const lost = vi.fn();
    const changed = vi.fn();
    const d = new LocalDeck("# One\n\nNote: hi\n---\n# Two", {
      granted: vi.fn(),
      changed,
      structLanded: vi.fn(),
      error: vi.fn(),
      lost,
    });
    d.lease({ start: 2, end: 3 });
    expect(d.struct({ op: "remove_notes", n: 1 })).toBe(true);
    expect(d.mine).toBeNull();
    expect(lost).toHaveBeenCalledWith("closed");
  });

  it("keeps a lease the op does not touch, moved with its lines", () => {
    const lost = vi.fn();
    const d = new LocalDeck("# One\n\nNote: hi\n---\n# Two", {
      granted: vi.fn(),
      changed: vi.fn(),
      structLanded: vi.fn(),
      error: vi.fn(),
      lost,
    });
    d.lease({ start: 4, end: 5 });
    expect(d.struct({ op: "remove_notes", n: 1 })).toBe(true);
    expect(d.lines[d.mine?.start ?? -1]).toBe("# Two");
    expect(lost).not.toHaveBeenCalled();
  });
});
