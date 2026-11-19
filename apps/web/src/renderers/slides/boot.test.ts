// The slides renderer, booted from a real shell's payload in a modelled frame: paging by keys,
// digits, clicks, taps, swipes and #N links; the overview, presenter view and printing; and the
// app messages it acts on (only from its parent at the app origin) and posts (only to it).
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPE_REGISTRY,
  typedShellHtml,
} from "@plinth/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { formatElapsed, type PresenterClock } from "./presenter.ts";
import { PAGE_STYLE_ID, pageRule, printDeck } from "./print.ts";
import { readSlidesAppMessage } from "./protocol.ts";
import { CONTROLS_BAND, overviewColumns, overviewScale } from "./stage.ts";

const APP = "https://plinth.example.com";
const DECK = [
  "# One",
  "Note: First notes **bold**.",
  "---",
  "## Two",
  "See [four](#4) and [here](#here).",
  "---",
  "## Three",
  "---",
  "## Four",
  "![pic](pic.png)",
  "---",
  "## Five",
].join("\n");

function mount(text = DECK, view?: "overview") {
  const html = typedShellHtml(TYPE_REGISTRY.slides, {
    title: "T",
    text,
    base: "",
    appOrigin: APP,
    ...(view ? { view } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
}

interface Framed {
  win: Window;
  target: EventTarget;
  parent: { postMessage: ReturnType<typeof vi.fn> };
  print: ReturnType<typeof vi.fn>;
  size: { w: number; h: number };
}

/** A framed deck: its own event target, a parent that records posts, a print stub. */
function framed(): Framed {
  const target = new EventTarget();
  const parent = { postMessage: vi.fn() };
  const print = vi.fn();
  const size = { w: 1280, h: 800 };
  const win = {
    document,
    parent,
    print,
    get innerWidth() {
      return size.w;
    },
    get innerHeight() {
      return size.h;
    },
    getSelection: () => window.getSelection(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return { win, target, parent, print, size };
}

const root = () => document.getElementById("__plinth-slides") as HTMLElement;
const slide = () => document.documentElement.getAttribute("data-slide");
const key = (f: Framed, k: string, init: KeyboardEventInit = {}) =>
  f.target.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true, ...init }));
const appMessage = (f: Framed, data: unknown, origin = APP, source: unknown = f.parent) =>
  f.target.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
const msg = (m: Record<string, unknown>) => ({
  source: RENDERER_MESSAGE_SOURCE,
  v: RENDERER_PROTOCOL_VERSION,
  ...m,
});
const posts = (f: Framed) => f.parent.postMessage.mock.calls;

const clock = (): PresenterClock & { t: number; tick?: () => void } => {
  const c = {
    t: 0,
    tick: undefined as (() => void) | undefined,
    now: () => c.t,
    every: (_ms: number, fn: () => void) => {
      c.tick = fn;
      return () => {
        c.tick = undefined;
      };
    },
    time: () => "10:00",
  };
  return c;
};

let stop: (() => void) | undefined;

beforeEach(() => {
  document.documentElement.removeAttribute("data-ready");
  document.documentElement.removeAttribute("data-slide");
});

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.getElementById(PAGE_STYLE_ID)?.remove();
});

describe("boot", () => {
  it("shows a fallback for a bad payload, a doc payload or a deck without slides", () => {
    for (const raw of ["{", JSON.stringify({ v: 1, type: "doc", text: "# x", app_origin: APP })]) {
      document.body.innerHTML =
        '<main id="__plinth-slides"></main>' +
        `<script type="application/json" id="__plinth-content">${raw}</script>`;
      boot(framed().win);
      expect(document.documentElement.getAttribute("data-ready")).toBe("error");
      expect(root().textContent).toBe("This deck could not be shown.");
    }
    mount("\n---\n");
    boot(framed().win);
    expect(document.documentElement.getAttribute("data-ready")).toBe("error");
  });

  it("renders slide 1, reports ready to the app origin only, and sets the page rule", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const html = document.documentElement;
    expect(html.getAttribute("data-ready")).toBe("ok");
    expect(slide()).toBe("1");
    expect(html.getAttribute("data-count")).toBe("5");
    expect(html.getAttribute("data-theme")).toBe("auto");
    expect(root().getAttribute("data-mode")).toBe("deck");
    expect(document.querySelectorAll(".plinth-slides__frame")).toHaveLength(5);
    expect(document.querySelector(".plinth-slides__frame[data-active]")?.textContent).toContain(
      "One",
    );
    expect(posts(f)).toEqual([[msg({ type: "ready", slide: 1, count: 5 }), APP]]);
    expect(document.getElementById(PAGE_STYLE_ID)?.textContent).toBe(
      "@page { size: 13.333in 7.5in; margin: 0; }",
    );
  });

  it("pages with keys, digits and Enter, Home and End, and posts each position", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "ArrowRight");
    expect(slide()).toBe("2");
    key(f, " ");
    key(f, "PageDown");
    expect(slide()).toBe("4");
    key(f, "ArrowLeft");
    key(f, "Backspace");
    expect(slide()).toBe("2");
    key(f, "End");
    expect(slide()).toBe("5");
    key(f, "ArrowRight");
    expect(slide()).toBe("5");
    key(f, "Home");
    expect(slide()).toBe("1");
    key(f, "3");
    key(f, "Enter");
    expect(slide()).toBe("3");
    key(f, "9");
    key(f, "9");
    key(f, "Enter");
    expect(slide()).toBe("5");
    expect(posts(f).at(-1)).toEqual([msg({ type: "position", slide: 5, count: 5 }), APP]);
    for (const [m, origin] of posts(f)) {
      expect(origin).toBe(APP);
      expect(Object.keys(m).sort()).toEqual(
        m.type === "fullscreen"
          ? ["source", "type", "v"]
          : ["count", "slide", "source", "type", "v"],
      );
    }
    expect(document.querySelector(".plinth-slides__live")?.textContent).toBe("Slide 5 of 5");
  });

  it("acts on app messages only from its parent at the app origin", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    appMessage(f, msg({ type: "goto", slide: 3 }), "https://evil.example");
    appMessage(f, msg({ type: "goto", slide: 3 }), APP, window);
    appMessage(f, msg({ type: "goto", slide: 3 }), APP, null);
    expect(slide()).toBe("1");
    for (const bad of [2.5, 0, -1, 501, "3", null]) {
      appMessage(f, msg({ type: "goto", slide: bad }));
    }
    expect(slide()).toBe("1");
    appMessage(f, msg({ type: "goto", slide: 3 }));
    expect(slide()).toBe("3");
    appMessage(f, msg({ type: "goto", slide: 400 }));
    expect(slide()).toBe("5");
    appMessage(f, msg({ type: "view", mode: "overview" }));
    expect(root().getAttribute("data-mode")).toBe("overview");
    appMessage(f, msg({ type: "view", mode: "toString" }));
    expect(root().getAttribute("data-mode")).toBe("overview");
    appMessage(f, msg({ type: "view", mode: "deck" }));
    expect(root().getAttribute("data-mode")).toBe("deck");
  });

  it("pages with #N links but keeps other fragments on the slide", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "ArrowRight");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-active] a"));
    const here = links.find((a) => a.textContent === "here");
    const here_ = new MouseEvent("click", { bubbles: true, cancelable: true });
    here?.dispatchEvent(here_);
    expect(here_.defaultPrevented).toBe(true);
    expect(slide()).toBe("2");
    links.find((a) => a.textContent === "four")?.click();
    expect(slide()).toBe("4");
  });

  it("pages on taps in the outer thirds and on swipes, never on a link or a control", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const tap = (x: number, target: Element = root(), dx = 0) => {
      target.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, bubbles: true }));
      target.dispatchEvent(new PointerEvent("pointerup", { clientX: x + dx, bubbles: true }));
    };
    tap(1200);
    expect(slide()).toBe("2");
    tap(640);
    expect(slide()).toBe("2");
    tap(50);
    expect(slide()).toBe("1");
    tap(600, root(), -200);
    expect(slide()).toBe("2");
    tap(600, root(), 200);
    expect(slide()).toBe("1");
    key(f, "ArrowRight");
    const link = document.querySelector("[data-active] a") as Element;
    tap(1200, link);
    expect(slide()).toBe("2");
    tap(1200, document.querySelector(".plinth-slides__controls button") as Element);
    expect(slide()).not.toBe("3");
  });

  it("toggles the overview with o and leaves it with Escape or a click on a slide", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "o");
    expect(root().getAttribute("data-mode")).toBe("overview");
    key(f, "Escape");
    expect(root().getAttribute("data-mode")).toBe("deck");
    key(f, "o");
    (
      document.querySelector(
        '.plinth-slides__frame[data-n="3"] .plinth-slides__slide',
      ) as HTMLElement
    ).click();
    expect(root().getAttribute("data-mode")).toBe("deck");
    expect(slide()).toBe("3");
  });

  it("stays in a fixed overview for review mode and the editor preview", () => {
    mount(DECK, "overview");
    const f = framed();
    stop = boot(f.win);
    expect(root().getAttribute("data-mode")).toBe("overview");
    // Nothing to open and no current slide: no click cursor, no ring.
    expect(root().hasAttribute("data-fixed")).toBe(true);
    expect(root().hasAttribute("data-mark")).toBe(false);
    key(f, "Escape");
    key(f, "o");
    key(f, "s");
    (document.querySelector('.plinth-slides__frame[data-n="2"]') as HTMLElement).click();
    expect(root().getAttribute("data-mode")).toBe("overview");
    // The controls and the app's view messages keep it too, and the app is told the view it shows.
    for (const b of Array.from(document.querySelectorAll(".plinth-slides__controls button"))) {
      (b as HTMLElement).click();
    }
    expect(root().getAttribute("data-mode")).toBe("overview");
    for (const mode of ["deck", "presenter"]) {
      appMessage(f, msg({ type: "view", mode }));
      expect(root().getAttribute("data-mode")).toBe("overview");
      expect(posts(f).at(-1)).toEqual([msg({ type: "view", mode: "overview" }), APP]);
    }
  });

  it("tells the app every view it changes to, by key, control or message", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const views = () =>
      posts(f)
        .map(([m]) => m as { type: string; mode?: string })
        .filter((m) => m.type === "view")
        .map((m) => m.mode);
    key(f, "s");
    key(f, "Escape");
    key(f, "o");
    key(f, "o");
    (document.querySelector('[aria-label="Overview"]') as HTMLElement).click();
    key(f, "s");
    (document.querySelector('[aria-label="Exit presenter view"]') as HTMLElement).click();
    appMessage(f, msg({ type: "view", mode: "presenter" }));
    // The view it already shows: nothing to report.
    appMessage(f, msg({ type: "view", mode: "presenter" }));
    expect(views()).toEqual([
      "presenter",
      "deck",
      "overview",
      "deck",
      "overview",
      "presenter",
      "deck",
      "presenter",
    ]);
    for (const [m, origin] of posts(f)) {
      expect(origin).toBe(APP);
      expect(Object.keys(m as object).sort()).toEqual(
        (m as { type: string }).type === "view"
          ? ["mode", "source", "type", "v"]
          : (m as { type: string }).type === "fullscreen"
            ? ["source", "type", "v"]
            : ["count", "slide", "source", "type", "v"],
      );
    }
  });

  it("shows the overview on a phone in portrait", () => {
    mount();
    const f = framed();
    f.size.w = 360;
    f.size.h = 740;
    stop = boot(f.win);
    expect(root().getAttribute("data-mode")).toBe("overview");
    // Nobody chose this overview: no slide is marked as the current one.
    expect(root().hasAttribute("data-mark")).toBe(false);
  });

  it("marks the current slide in an overview the person opened", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "o");
    expect(root().getAttribute("data-mode")).toBe("overview");
    expect(root().hasAttribute("data-mark")).toBe(true);
    expect(root().hasAttribute("data-fixed")).toBe(false);
  });

  it("lays the overview out as a grid on a wide frame, and moves the selection with the arrows", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "o");
    expect(root().style.getPropertyValue("--cols")).toBe("4");
    const thumb = Math.round(overviewScale(1280, 1280, 4) * 10000) / 10000;
    expect(root().style.getPropertyValue("--s")).toBe(String(thumb));
    key(f, "ArrowRight");
    expect(slide()).toBe("2");
    expect(root().getAttribute("data-mode")).toBe("overview");
    // Down moves a row of four, clamped to the deck; Home goes back to the first.
    key(f, "ArrowDown");
    expect(slide()).toBe("5");
    key(f, "Home");
    expect(slide()).toBe("1");
    key(f, "ArrowRight");
    key(f, "Enter");
    expect(root().getAttribute("data-mode")).toBe("deck");
    expect(slide()).toBe("2");
  });

  it("keeps a fixed overview in one column", () => {
    mount(DECK, "overview");
    const f = framed();
    stop = boot(f.win);
    expect(root().style.getPropertyValue("--cols")).toBe("1");
    key(f, "ArrowRight");
    expect(slide()).toBe("1");
  });

  it("has icon controls with names, and presses the overview button while the overview is on", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const controls = document.querySelector(".plinth-slides__controls") as HTMLElement;
    const names = Array.from(controls.querySelectorAll("button")).map((b) => [
      b.getAttribute("aria-label"),
      b.dataset.tip,
      b.querySelector("svg") !== null,
    ]);
    expect(names).toEqual([
      ["Previous slide", "Previous slide", true],
      ["Next slide", "Next slide", true],
      ["Overview", "Overview", true],
    ]);
    expect(controls.querySelector(".plinth-slides__counter")?.textContent).toBe("1 / 5");
    const overview = controls.querySelector('[aria-label="Overview"]') as HTMLElement;
    expect(overview.getAttribute("aria-pressed")).toBe("false");
    overview.click();
    expect(overview.getAttribute("aria-pressed")).toBe("true");
    overview.click();
    expect(overview.getAttribute("aria-pressed")).toBe("false");
  });

  it("fits the slide above the controls' band, and over the whole frame when it fills the screen", () => {
    mount();
    const f = framed();
    f.size.h = 700;
    stop = boot(f.win);
    // 1280x700 less the band: the height decides, and the band stays free under the slide.
    const scaled = (h: number) => String(Math.round((h / 720) * 10000) / 10000);
    expect(root().style.getPropertyValue("--s")).toBe(scaled(700 - CONTROLS_BAND));
    expect(root().style.getPropertyValue("--deck-top")).toBe("0px");
    expect(root().style.getPropertyValue("--deck-bottom")).toBe(`${CONTROLS_BAND}px`);
    (f.win as unknown as { screen: { width: number; height: number } }).screen = {
      width: 1280,
      height: 700,
    };
    f.target.dispatchEvent(new Event("resize"));
    expect(root().style.getPropertyValue("--s")).toBe(scaled(700));
    expect(root().style.getPropertyValue("--deck-bottom")).toBe("0px");
  });

  it("asks the app for full screen on f", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "f");
    expect(posts(f).at(-1)).toEqual([msg({ type: "fullscreen" }), APP]);
  });
});

describe("presenter view", () => {
  it("shows the current and next slide, the notes, the counter and a timer", () => {
    mount();
    const f = framed();
    const c = clock();
    stop = boot(f.win, { clock: c });
    key(f, "s");
    const p = document.querySelector(".plinth-slides__presenter") as HTMLElement;
    expect(root().getAttribute("data-mode")).toBe("presenter");
    expect(p.querySelector(".plinth-slides__pane--current")?.textContent).toContain("One");
    expect(p.querySelector(".plinth-slides__pane--next")?.textContent).toContain("Two");
    expect(p.querySelector(".plinth-slides__pane--next")?.hasAttribute("inert")).toBe(true);
    expect(p.querySelector(".plinth-slides__notes strong")?.textContent).toBe("bold");
    expect(p.querySelector(".plinth-slides__count")?.textContent).toBe("1 / 5");
    expect(p.querySelector("[id]")).toBeNull();

    key(f, "ArrowRight");
    expect(p.querySelector(".plinth-slides__count")?.textContent).toBe("2 / 5");
    expect(p.querySelector(".plinth-slides__notes")?.textContent).toBe("No notes for this slide.");
    key(f, "End");
    expect(p.querySelector(".plinth-slides__pane--next")?.textContent).toBe("End of deck");

    const timer = p.querySelector(".plinth-slides__timer") as HTMLElement;
    c.t = 65_000;
    c.tick?.();
    expect(timer.textContent).toBe("1:05");
    const [pause] = Array.from(p.querySelectorAll("button"));
    expect(pause?.getAttribute("aria-label")).toBe("Pause timer");
    pause?.click();
    expect(pause?.getAttribute("aria-label")).toBe("Resume timer");
    c.t = 125_000;
    c.tick?.();
    expect(timer.textContent).toBe("1:05");
    pause?.click();
    c.t = 130_000;
    c.tick?.();
    expect(timer.textContent).toBe("1:10");
    key(f, "Escape");
    expect(document.querySelector(".plinth-slides__presenter")).toBeNull();
    // The timer starts again each time presenter view opens.
    key(f, "s");
    expect(document.querySelector(".plinth-slides__timer")?.textContent).toBe("0:00");
  });

  it("pages with its own previous and next buttons, for touch screens", () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "s");
    const bar = document.querySelector(".plinth-slides__pbar") as HTMLElement;
    const names = Array.from(bar.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Pause timer", "Previous slide", "Next slide", "Exit presenter view"]);
    (bar.querySelector('[aria-label="Next slide"]') as HTMLElement).click();
    (bar.querySelector('[aria-label="Next slide"]') as HTMLElement).click();
    expect(slide()).toBe("3");
    (bar.querySelector('[aria-label="Previous slide"]') as HTMLElement).click();
    expect(slide()).toBe("2");
    expect(bar.querySelector(".plinth-slides__count")?.textContent).toBe("2 / 5");
  });

  it("marks the current slide when it overflows, on the pane only", () => {
    mount();
    const f = framed();
    stop = boot(f.win, { measure: () => true });
    key(f, "s");
    const current = document.querySelector(
      ".plinth-slides__pane--current .plinth-slides__slide",
    ) as HTMLElement;
    expect(current.getAttribute("data-overflow")).toBe("true");
    expect(document.querySelector(".plinth-slides__warning")).toBeNull();
  });

  it("picks three or four overview columns by width, one when narrow or fixed", () => {
    expect(overviewColumns(360)).toBe(1);
    expect(overviewColumns(699)).toBe(1);
    expect(overviewColumns(700)).toBe(3);
    expect(overviewColumns(1099)).toBe(3);
    expect(overviewColumns(1100)).toBe(4);
    expect(overviewColumns(1600, true)).toBe(1);
    // Each column's width, less the gutters, never above the canvas.
    expect(overviewScale(1280, 1280, 4)).toBeCloseTo((1280 - 32 - 48) / 4 / 1280, 6);
    expect(overviewScale(360, 1280)).toBeCloseTo((360 - 32) / 1280, 6);
    expect(overviewScale(4000, 1280)).toBe(1);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("printing", () => {
  it("has the page rule for 16:9 and 4:3, and a margined handout", () => {
    expect(pageRule({ width: 1280, height: 720 }, false)).toBe(
      "@page { size: 13.333in 7.5in; margin: 0; }",
    );
    expect(pageRule({ width: 1024, height: 768 }, false)).toBe(
      "@page { size: 10.667in 8in; margin: 0; }",
    );
    expect(pageRule({ width: 1024, height: 768 }, true)).toBe("@page { margin: 16mm; }");
  });

  it("prints after images decode, with the handout for notes, and cleans up after", async () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    const decode = vi.fn(() => Promise.resolve());
    for (const img of Array.from(document.querySelectorAll("img"))) {
      Object.defineProperty(img, "decode", { value: decode });
    }
    const order: string[] = [];
    decode.mockImplementation(() => {
      order.push("decode");
      return Promise.resolve();
    });
    f.print.mockImplementation(() => order.push("print"));
    await printDeck(f.win, root(), {
      notes: true,
      canvas: { width: 1280, height: 720 },
      prepare: () => order.push("prepare"),
      restore: () => order.push("restore"),
    });
    expect(order).toEqual(["decode", "prepare", "print"]);
    expect(document.querySelector("img")?.getAttribute("loading")).toBe("eager");
    expect(root().getAttribute("data-print")).toBe("handout");
    expect(document.getElementById(PAGE_STYLE_ID)?.textContent).toBe("@page { margin: 16mm; }");
    f.target.dispatchEvent(new Event("afterprint"));
    expect(root().hasAttribute("data-print")).toBe(false);
    expect(document.getElementById(PAGE_STYLE_ID)?.textContent).toBe(
      "@page { size: 13.333in 7.5in; margin: 0; }",
    );
    expect(order.at(-1)).toBe("restore");
  });

  it("prints on the app's print message and on Ctrl+P", async () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    appMessage(f, msg({ type: "print" }));
    await vi.waitFor(() => expect(f.print).toHaveBeenCalledTimes(1));
    expect(root().getAttribute("data-print")).toBe("slides");
    key(f, "p", { ctrlKey: true });
    await vi.waitFor(() => expect(f.print).toHaveBeenCalledTimes(2));
  });

  it("prints the handout with the notes from presenter view", async () => {
    mount();
    const f = framed();
    stop = boot(f.win);
    key(f, "s");
    appMessage(f, msg({ type: "print" }));
    await vi.waitFor(() => expect(f.print).toHaveBeenCalledTimes(1));
    expect(root().getAttribute("data-print")).toBe("handout");
    f.target.dispatchEvent(new Event("afterprint"));
    key(f, "p", { ctrlKey: true });
    await vi.waitFor(() => expect(f.print).toHaveBeenCalledTimes(2));
    expect(root().getAttribute("data-print")).toBe("handout");
  });
});

describe("readSlidesAppMessage", () => {
  it("accepts goto, view and print, and nothing malformed", () => {
    expect(readSlidesAppMessage(msg({ type: "goto", slide: 2 }))).toEqual({
      type: "goto",
      slide: 2,
    });
    expect(readSlidesAppMessage(msg({ type: "print" }))).toEqual({ type: "print" });
    expect(readSlidesAppMessage(msg({ type: "view", mode: "presenter" }))).toEqual({
      type: "view",
      mode: "presenter",
    });
    for (const bad of [
      null,
      "goto",
      { type: "goto", slide: 1 },
      { ...msg({ type: "goto", slide: 1 }), v: 2 },
      msg({ type: "goto", slide: 1.5 }),
      msg({ type: "goto", slide: 501 }),
      msg({ type: "view", mode: "edit" }),
      msg({ type: "edit", on: true }),
    ]) {
      expect(readSlidesAppMessage(bad)).toBeNull();
    }
  });
});
