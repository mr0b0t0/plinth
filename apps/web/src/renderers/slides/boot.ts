// Boots a deck: reads the payload the shell embeds (typedShellHtml in @plinth/shared), splits it
// with the shared parser, builds every slide (deck.ts), and runs the deck: paging, the overview,
// presenter view, printing and the app's messages. It runs synchronously at the end of <body>, so
// the comments bridge (which waits for DOMContentLoaded) sees the finished DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name, and it never loads /__plinth/runtime.js, so heading ids cannot clobber anything
// it uses. <html> carries data-ready ("ok" or "error"), data-slide and data-count for tests and
// thumbnails.
import {
  type DeckSettings,
  parseDeck,
  SLIDE_ASPECTS,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { buildDeck, type SlideView } from "./deck.ts";
import { iconButton } from "./icons.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { bindInput, DeckController, type DeckMode } from "./nav.ts";
import { bindOverview, revealSlide } from "./overview.ts";
import { Presenter, type PresenterClock } from "./presenter.ts";
import { pageRule, pageStyle, printDeck } from "./print.ts";
import { fromApp, postToApp, readSlidesAppMessage } from "./protocol.ts";
import {
  CONTROLS_INSET,
  fitScale,
  GUTTER,
  overviewColumns,
  overviewScale,
  prefersOverview,
  setScale,
} from "./stage.ts";

const ROOT_ID = "__plinth-slides";
const DATA_ID = "__plinth-content";
const FALLBACK = "This deck could not be shown.";
/** Controls hide this long after the last input (hover and keyboard focus keep them). */
export const CONTROLS_IDLE_MS = 2000;

export function readPayload(doc: Document): TypedPayload | null {
  const raw = doc.getElementById(DATA_ID)?.textContent;
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "slides") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  if (p.view !== undefined && p.view !== "overview") return null;
  return value as TypedPayload;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Test seams: layout measuring and the presenter's clock. */
export interface BootOptions {
  measure?: Measure;
  clock?: PresenterClock;
}

/** Renders the deck and starts listening. Returns a function that stops everything it started. */
export function boot(win: Window, opts: BootOptions = {}): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  const parsed = payload ? parseDeck(payload.text) : null;
  if (!root || !payload || !parsed || parsed.slides.length === 0) {
    if (root) root.replaceChildren(el(doc, "p", "plinth-slides__error", FALLBACK));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const measure = opts.measure ?? overflows;
  const settings: DeckSettings = parsed.settings;
  const canvas = SLIDE_ASPECTS[settings.aspect];
  const appOrigin = payload.app_origin;
  const fixedOverview = payload.view === "overview";
  html.setAttribute("data-theme", settings.theme);
  // A fixed overview has no current slide to mark and no slide to open on a click.
  if (fixedOverview) root.setAttribute("data-fixed", "");
  html.setAttribute("data-aspect", settings.aspect);

  const views = buildDeck(doc, parsed);
  const deckEl = el(doc, "div", "plinth-slides__deck");
  for (const v of views) deckEl.append(v.frame);
  const announcer = el(doc, "div", "plinth-slides__live");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");

  const deck = new DeckController(views.length);
  // The overview by itself: phones in portrait, until the person or the app picks a view.
  let auto = !fixedOverview;
  let mode: DeckMode = fixedOverview || prefersOverview(win) ? "overview" : "deck";
  let presenter: Presenter | null = null;
  const fitted = new WeakSet<SlideView>();

  const counter = el(doc, "span", "plinth-slides__counter");
  const controls = el(doc, "nav", "plinth-slides__controls");
  controls.setAttribute("aria-label", "Slides");
  controls.dataset.plinthControl = "";
  const separator = el(doc, "span", "plinth-slides__sep");
  separator.setAttribute("aria-hidden", "true");
  const overviewBtn = iconButton(doc, "squares-four", "Overview", () =>
    pick(mode === "overview" ? "deck" : "overview"),
  );
  // One counter on screen: a deck that shows its own page numbers has none in the pill.
  controls.append(
    iconButton(doc, "caret-left", "Previous slide", () => deck.prev()),
    ...(settings.paginate ? [] : [counter]),
    iconButton(doc, "caret-right", "Next slide", () => deck.next()),
    separator,
    overviewBtn,
  );
  root.replaceChildren(deckEl, controls, announcer);
  pageStyle(doc).textContent = pageRule(canvas, false);

  let idle: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    root.setAttribute("data-controls", "on");
    clearTimeout(idle);
    idle = setTimeout(() => root.removeAttribute("data-controls"), CONTROLS_IDLE_MS);
  };
  controls.addEventListener("focusin", activity);

  const fitView = (v: SlideView) => {
    fitSlide(v.el, v.body, measure);
    fitted.add(v);
  };
  // An image that loads late changes what fits.
  for (const v of views) {
    for (const img of Array.from(v.el.querySelectorAll("img"))) {
      img.addEventListener("load", () => {
        if (mode === "overview" || v.n === deck.current) fitView(v);
        if (presenter && Math.abs(presenter.slide - v.n) <= 1) presenter.show(presenter.slide);
      });
    }
  }

  const scale = () => {
    if (mode === "overview") {
      const cols = overviewColumns(win.innerWidth, fixedOverview);
      root.style.setProperty("--cols", String(cols));
      setScale(root, canvas, overviewScale(win.innerWidth, canvas.width, cols));
      root.style.removeProperty("--controls-bottom");
    } else {
      // The slide is centred with the stage's gutter on every side, full screen too; the controls
      // show one gutter above its bottom edge, wherever the letterbox puts it.
      const s = fitScale(
        win.innerWidth - 2 * GUTTER,
        win.innerHeight - 2 * GUTTER,
        canvas.width,
        canvas.height,
      );
      setScale(root, canvas, s);
      const below = Math.max(0, (win.innerHeight - canvas.height * s) / 2);
      root.style.setProperty("--controls-bottom", `${Math.floor(below) + CONTROLS_INSET}px`);
    }
    presenter?.layout();
  };

  const render = () => {
    const n = deck.current;
    root.setAttribute("data-mode", mode);
    // The overview marks the slide the person was on only when they chose it (not on phones).
    root.toggleAttribute("data-mark", !fixedOverview && !auto);
    for (const v of views) {
      if (v.n === n) {
        v.frame.setAttribute("data-active", "");
        v.el.setAttribute("aria-current", "true");
      } else {
        v.frame.removeAttribute("data-active");
        v.el.removeAttribute("aria-current");
      }
    }
    // Lazy images on hidden slides never load: the shown slide's and the next one's load now.
    for (const v of [views[n - 1], views[n]]) {
      for (const img of Array.from(v?.el.querySelectorAll("img") ?? [])) img.loading = "eager";
    }
    html.setAttribute("data-slide", String(n));
    html.setAttribute("data-count", String(views.length));
    counter.textContent = `${n} / ${views.length}`;
    overviewBtn.setAttribute("aria-pressed", String(mode === "overview"));
    scale();
    if (mode === "overview") {
      for (const v of views) if (!fitted.has(v)) fitView(v);
    } else if (mode === "deck") {
      const v = views[n - 1];
      if (v) fitView(v);
    }
    if (mode === "presenter") {
      if (!presenter) {
        presenter = new Presenter(doc, views, canvas, {
          exit: () => pick("deck"),
          prev: () => deck.prev(),
          next: () => deck.next(),
          viewport: () => ({ w: win.innerWidth, h: win.innerHeight }),
          clock: opts.clock,
          measure,
        });
        root.append(presenter.el);
        presenter.open(n);
      } else {
        presenter.show(n);
      }
    } else if (presenter) {
      presenter.close();
      presenter.el.remove();
      presenter = null;
    }
  };

  // The app keeps its own idea of the view (the menu, the version pause), so every change
  // is reported, whichever key, control or message made it.
  const reportView = () => postToApp(win, appOrigin, { type: "view", mode });

  function pick(next: DeckMode) {
    auto = false;
    // Review mode and the editor preview keep every slide in the DOM (comment pins anchor to them),
    // whatever asks for another view.
    if (fixedOverview || next === mode) return;
    mode = next;
    render();
    if (mode === "overview") revealSlide(doc, deck.current);
    root?.focus({ preventScroll: true });
    reportView();
  }

  deck.onChange((n) => {
    render();
    if (mode === "overview") revealSlide(doc, n);
    announcer.textContent = `Slide ${n} of ${views.length}`;
    postToApp(win, appOrigin, { type: "position", slide: n, count: views.length });
  });

  const print = (notes: boolean) =>
    void printDeck(win, root, {
      notes,
      canvas,
      prepare: () => {
        for (const v of views) fitView(v);
      },
      restore: render,
    });

  const unbindInput = bindInput(win, root, deck, {
    mode: () => mode,
    setMode: pick,
    fullscreen: () => postToApp(win, appOrigin, { type: "fullscreen" }),
    // Printing from presenter view prints the handout, each slide over its notes.
    print: () => print(mode === "presenter"),
    activity,
    fixedOverview,
    columns: () => overviewColumns(win.innerWidth, fixedOverview),
  });
  const unbindOverview = bindOverview(root, {
    active: () => mode === "overview",
    fixed: fixedOverview,
    open: (n) => {
      pick("deck");
      deck.go(n);
    },
  });

  const onMessage = (e: MessageEvent) => {
    if (!fromApp(e, win, appOrigin)) return;
    const m = readSlidesAppMessage(e.data);
    if (!m) return;
    if (m.type === "goto") deck.go(m.slide);
    else if (m.type === "view") {
      pick(m.mode);
      // A view the frame did not take: the app learns the one it shows.
      if (mode !== m.mode) reportView();
    } else print(mode === "presenter");
  };
  const onResize = () => {
    if (auto) {
      const want: DeckMode = prefersOverview(win) ? "overview" : "deck";
      if (want !== mode) {
        mode = want;
        render();
        reportView();
        return;
      }
    }
    scale();
  };
  win.addEventListener("message", onMessage);
  win.addEventListener("resize", onResize);

  render();
  html.setAttribute("data-ready", "ok");
  postToApp(win, appOrigin, { type: "ready", slide: deck.current, count: views.length });

  return () => {
    clearTimeout(idle);
    unbindInput();
    unbindOverview();
    presenter?.close();
    win.removeEventListener("message", onMessage);
    win.removeEventListener("resize", onResize);
  };
}
