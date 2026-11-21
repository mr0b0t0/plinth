// Boots a deck: reads the payload the shell embeds (typedShellHtml in @plinth/shared), splits it
// with the shared parser, builds every slide (deck.ts), and runs the deck: paging, the overview,
// presenter view, printing, the .pptx download and the app's messages. It runs synchronously at
// the end of <body>, so the comments bridge (which waits for DOMContentLoaded) sees the finished
// DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name, and it never loads /__plinth/runtime.js, so heading ids cannot clobber anything
// it uses. <html> carries data-ready ("ok" or "error"), data-slide and data-count for tests and
// thumbnails; the root carries data-follow while the deck follows or leads a presenter (follow.ts).
import {
  type DeckSettings,
  HTML_DECK_CSS,
  HTML_DECK_INDEX,
  type HtmlDeck,
  LIMITS,
  parseDeck,
  parseHtmlDeck,
  SLIDE_ASPECTS,
  slideIdOfPath,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { buildDeck, type SlideView } from "./deck.ts";
import { el } from "./dom.ts";
import { collectImages, saveBlob, writerLoader } from "./export.ts";
import { buildExportModel, domGeometry, type Geometry, pptxFileName } from "./exportModel.ts";
import { Follow, type FollowSocket } from "./follow.ts";
import { HtmlDeckRuntime } from "./html/runtime.ts";
import { iconButton } from "./icons.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { bindInput, DeckController, type DeckMode } from "./nav.ts";
import { bindOverview, revealSlide } from "./overview.ts";
import type { DeckModel, PptxBuilder } from "./pptxModel.ts";
import { Presenter, type PresenterClock } from "./presenter.ts";
import { imagesReady, pageRule, pageStyle, printDeck } from "./print.ts";
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
/** The most live embeds an `exported` message counts: 8 a slide, LIMITS.maxSlides slides. */
export const EMBEDS_CAP = LIMITS.maxSlides * 8;
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
  if (p.follow !== undefined && p.follow !== "present" && p.follow !== "watch") return null;
  if (p.files !== undefined) {
    if (typeof p.files !== "object" || p.files === null || Array.isArray(p.files)) return null;
    if (!Object.values(p.files).every((t) => typeof t === "string")) return null;
  }
  return value as TypedPayload;
}

/**
 * An HTML deck from its payload (deck.json, deck.css and the slide files), read by the shared
 * parser as the Worker read it at publish, or null when it does not read: the renderer builds
 * only a tree the parser accepted.
 */
export function readHtmlDeck(payload: TypedPayload): HtmlDeck | null {
  if (payload.path !== HTML_DECK_INDEX) return null;
  const files = payload.files ?? {};
  const slides = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    if (slideIdOfPath(path) !== null) slides.set(path, text);
  }
  const r = parseHtmlDeck({
    index: payload.text,
    css: Object.hasOwn(files, HTML_DECK_CSS) ? (files[HTML_DECK_CSS] as string) : null,
    slides,
  });
  return r.ok ? r.deck : null;
}

/** Test seams: layout measuring, the presenter's clock and the .pptx export. */
export interface BootOptions {
  measure?: Measure;
  clock?: PresenterClock;
  /** Layout reads for the export model. */
  geometry?: Geometry;
  /** Loads the .pptx writer (by default the lazy slides-pptx.js). */
  loadWriter?: () => Promise<PptxBuilder>;
  /** This document's origin is opaque (by default: window.origin is "null"). */
  opaque?: boolean;
  /** Saves the finished file (by default an <a download> click in the frame). */
  save?: (blob: Blob, name: string) => void;
  /** Makes the follow socket (by default a WebSocket). */
  connect?: (url: string, protocols: string[]) => FollowSocket;
  /**
   * A still: no motion, every step shown and no live embeds (by default when the shell is the top
   * document, which only a thumbnail capture opens).
   */
  still?: boolean;
}

/** Renders the deck and starts listening. Returns a function that stops everything it started. */
export function boot(win: Window, opts: BootOptions = {}): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  // An HTML deck (deck.json, Claude's slide format) or a Markdown deck (slides.md).
  const htmlDeck = payload && payload.path === HTML_DECK_INDEX ? readHtmlDeck(payload) : null;
  const parsed = payload && payload.path !== HTML_DECK_INDEX ? parseDeck(payload.text) : null;
  const shown = htmlDeck
    ? htmlDeck.slides.filter((s) => !s.hidden).length
    : (parsed?.slides.length ?? 0);
  if (!root || !payload || (!htmlDeck && !parsed) || shown === 0) {
    if (root) root.replaceChildren(el(doc, "p", "plinth-slides__error", FALLBACK));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const measure = opts.measure ?? overflows;
  // An HTML deck sets its own look on its canvas: the stage around it follows the viewer's scheme,
  // and its slides carry no number or footer of Plinth's.
  const settings: DeckSettings = htmlDeck
    ? { aspect: htmlDeck.size, theme: "auto", paginate: false, footer: "" }
    : (parsed as NonNullable<typeof parsed>).settings;
  const canvas = htmlDeck ? htmlDeck.canvas : SLIDE_ASPECTS[settings.aspect];
  const still = opts.still ?? win.top === win;
  const reducedMotion = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const htmlRuntime = htmlDeck
    ? new HtmlDeckRuntime(win, htmlDeck, { motionOff: still || reducedMotion, noEmbeds: still })
    : null;
  if (htmlDeck) html.setAttribute("data-format", "html");
  /** An audience window: its presenter's window moves it, steps and all, so it shows them all. */
  let paired = false;
  const appOrigin = payload.app_origin;
  const fixedOverview = payload.view === "overview";
  html.setAttribute("data-theme", settings.theme);
  // A fixed overview has no current slide to mark and no slide to open on a click.
  if (fixedOverview) root.setAttribute("data-fixed", "");
  html.setAttribute("data-aspect", settings.aspect);

  const views = htmlRuntime
    ? htmlRuntime.views
    : buildDeck(doc, parsed as NonNullable<typeof parsed>);
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
  // Following the presenter: only when the shell says so (an identified viewer, rooms on), never in
  // review mode or the editor preview, which keep the overview.
  const follow =
    payload.follow && !fixedOverview
      ? new Follow({
          win,
          root,
          deck,
          right: payload.follow,
          // The app remembers the lead, so a frame that replaces this one leads again (`lead`).
          onLead: (on) => postToApp(win, appOrigin, { type: "leading", on }),
          ...(opts.connect ? { connect: opts.connect } : {}),
        })
      : null;
  // A presenter's Lead viewers toggle, in the controls and in presenter view; a follower's status
  // is the controls' last item.
  const presenterLead = follow && payload.follow === "present" ? follow.leadButton() : null;
  if (follow && payload.follow === "present") controls.append(follow.leadButton());
  if (follow) controls.append(follow.pill);
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
    // An HTML slide never shrinks (Claude's rule: split it); it is only marked when it runs over.
    if (htmlRuntime) htmlRuntime.layout(v);
    else fitSlide(v.el, v.body, measure);
    fitted.add(v);
  };
  const imagesOf = (v: SlideView): HTMLImageElement[] =>
    htmlRuntime ? htmlRuntime.images(v) : Array.from(v.el.querySelectorAll("img"));
  // An image that loads late changes what fits.
  for (const v of views) {
    for (const img of imagesOf(v)) {
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
      for (const img of v ? imagesOf(v) : []) img.loading = "eager";
    }
    html.setAttribute("data-slide", String(n));
    html.setAttribute("data-count", String(views.length));
    counter.textContent = `${n} / ${views.length}`;
    overviewBtn.setAttribute("aria-pressed", String(mode === "overview"));
    scale();
    // An HTML deck's motion, steps and embeds follow the view (html/runtime.ts).
    htmlRuntime?.sync({ mode, current: n, allBuilt: allBuilt() });
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
          ...(presenterLead && !follow?.detached ? { bar: [presenterLead] } : {}),
          ...(htmlRuntime
            ? {
                copy: (v: SlideView, pane: "current" | "next") =>
                  htmlRuntime.copy(v, pane, allBuilt()),
              }
            : {}),
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
      htmlRuntime?.closePanes();
    }
  };

  /**
   * Every step of every slide shows: review mode and the editor preview, an audience window, a
   * deck that follows a presenter (only slide numbers cross the room and the app), and a still.
   */
  function allBuilt(): boolean {
    return fixedOverview || paired || still || follow?.holding === true;
  }

  // An HTML slide's fragments: next and prev step through the current slide first.
  if (htmlRuntime) {
    const step = (move: () => boolean) => {
      if ((mode !== "deck" && mode !== "presenter") || allBuilt()) return false;
      if (!move()) return false;
      htmlRuntime.sync({ mode, current: deck.current, allBuilt: false });
      return true;
    };
    deck.setStepper({
      next: () => step(() => htmlRuntime.stepNext(deck.current)),
      prev: () => step(() => htmlRuntime.stepPrev()),
    });
  }
  let shownSlide = deck.current;

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
    const from = shownSlide;
    shownSlide = n;
    htmlRuntime?.arrive(from, n, mode, Number(root.style.getPropertyValue("--s")) || 1);
    render();
    if (mode === "overview") revealSlide(doc, n);
    announcer.textContent = `Slide ${n} of ${views.length}`;
    postToApp(win, appOrigin, { type: "position", slide: n, count: views.length });
  });

  const print = (notes: boolean) =>
    void printDeck(win, root, {
      notes,
      canvas,
      prepare: async () => {
        // An HTML deck prints every slide whole and still, each live embed as it first draws.
        htmlRuntime?.still({ embeds: true });
        for (const v of views) fitView(v);
        await htmlRuntime?.embedsDrawn();
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

  // ---------- .pptx export (export.ts) ----------

  const loadWriter = opts.loadWriter ?? writerLoader(doc);
  const opaque = opts.opaque ?? win.origin === "null";
  const save = opts.save ?? ((blob: Blob, name: string) => saveBlob(win, blob, name));
  /**
   * The nonce the running export answers, or null when none runs. A request that comes while one
   * runs (the app gave up waiting and the person asked again) takes over its answer: the app
   * listens only for its latest nonce, and the file is made once.
   */
  let answerTo: string | null = null;
  /** Live embeds the last .pptx left out (an HTML deck's x-embeds run code; a file cannot). */
  let embedsSkipped = 0;

  /** Lays out and fits every slide, measures it, and puts the screen view back, in one task. */
  const measureDeck = (): DeckModel => {
    const scaleWas = root.style.getPropertyValue("--s");
    root.setAttribute("data-export", "");
    root.style.setProperty("--s", "1");
    try {
      if (htmlRuntime) {
        htmlRuntime.still();
        const r = htmlRuntime.exportModel(doc.title, opts.geometry ?? domGeometry(win));
        embedsSkipped = r.embedsSkipped;
        return r.model;
      }
      for (const v of views) fitView(v);
      const dark =
        settings.theme === "dark" ||
        (settings.theme === "auto" &&
          win.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
      return buildExportModel(views, {
        aspect: settings.aspect,
        theme: dark ? "dark" : "light",
        title: doc.title,
        geometry: opts.geometry ?? domGeometry(win),
      });
    } finally {
      root.removeAttribute("data-export");
      root.style.setProperty("--s", scaleWas);
      render();
    }
  };

  const runExport = async (nonce: string) => {
    const busy = answerTo !== null;
    answerTo = nonce;
    if (busy) return;
    const report = (ok: boolean, skipped: number) =>
      postToApp(win, appOrigin, {
        type: "exported",
        nonce: answerTo ?? nonce,
        ok,
        // The app reads at most the version file cap; a deck of data: images could pass it.
        images_skipped: Math.min(skipped, LIMITS.maxAssetsCeiling),
        ...(embedsSkipped > 0 ? { embeds_skipped: Math.min(embedsSkipped, EMBEDS_CAP) } : {}),
        opaque,
      });
    try {
      // The writer loads while the images decode. Its failure is handled below, after the decode.
      const writer = loadWriter();
      writer.catch(() => undefined);
      await imagesReady(root);
      const model = measureDeck();
      const [build, images] = await Promise.all([writer, collectImages(win, model, opaque)]);
      const { blob, imagesSkipped } = await build(model, images);
      save(blob, pptxFileName(model.title));
      report(true, imagesSkipped);
    } catch {
      report(false, 0);
    } finally {
      answerTo = null;
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (!fromApp(e, win, appOrigin)) return;
    const m = readSlidesAppMessage(e.data);
    if (!m) return;
    if (m.type === "goto") {
      // While the deck follows a presenter, the presenter's slide wins over the app's.
      if (!follow?.holding) deck.go(m.slide);
    } else if (m.type === "paired") {
      paired = true;
      follow?.detach();
      render();
    } else if (m.type === "lead") follow?.resumeLead();
    else if (m.type === "view") {
      pick(m.mode);
      // A view the frame did not take: the app learns the one it shows.
      if (mode !== m.mode) reportView();
    } else if (m.type === "export") void runExport(m.nonce);
    else print(mode === "presenter");
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
  htmlRuntime?.mounted();
  html.setAttribute("data-ready", "ok");
  postToApp(win, appOrigin, { type: "ready", slide: deck.current, count: views.length });
  follow?.start();

  return () => {
    htmlRuntime?.stop();
    follow?.stop();
    clearTimeout(idle);
    unbindInput();
    unbindOverview();
    presenter?.close();
    win.removeEventListener("message", onMessage);
    win.removeEventListener("resize", onResize);
  };
}
