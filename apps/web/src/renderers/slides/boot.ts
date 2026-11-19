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
  LIMITS,
  parseDeck,
  SLIDE_ASPECTS,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { buildDeck, type SlideView } from "./deck.ts";
import { clickDownload, collectImages, showReadyNotice, writerLoader } from "./export.ts";
import { buildExportModel, domGeometry, type Geometry, pptxFileName } from "./exportModel.ts";
import { Follow, type FollowSocket } from "./follow.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { bindInput, DeckController, type DeckMode } from "./nav.ts";
import { bindOverview, revealSlide } from "./overview.ts";
import type { DeckModel, PptxBuilder } from "./pptxModel.ts";
import { Presenter, type PresenterClock } from "./presenter.ts";
import { imagesReady, pageRule, pageStyle, printDeck } from "./print.ts";
import { fromApp, postToApp, readSlidesAppMessage } from "./protocol.ts";
import { fitScale, overviewScale, prefersOverview, setScale } from "./stage.ts";

const ROOT_ID = "__plinth-slides";
const DATA_ID = "__plinth-content";
const FALLBACK = "This deck could not be shown.";
/** Controls hide this long after the last input. */
export const CONTROLS_IDLE_MS = 2500;

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

function button(doc: Document, label: string, text: string, onClick: () => void) {
  const b = el(doc, "button", "plinth-slides__btn", text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
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
  /** Saves the finished file (by default an <a download> click and the ready notice). */
  save?: (blob: Blob, name: string) => void;
  /** Makes the follow socket (by default a WebSocket). */
  connect?: (url: string, protocols: string[]) => FollowSocket;
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
  controls.append(
    button(doc, "Previous slide", "‹", () => deck.prev()),
    counter,
    button(doc, "Next slide", "›", () => deck.next()),
    button(doc, "Overview", "Overview", () => pick(mode === "overview" ? "deck" : "overview")),
    button(doc, "Presenter view", "Presenter", () =>
      pick(mode === "presenter" ? "deck" : "presenter"),
    ),
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
          ...(opts.connect ? { connect: opts.connect } : {}),
        })
      : null;
  // A presenter's Lead viewers toggle, in the controls and in presenter view.
  const presenterLead = follow && payload.follow === "present" ? follow.leadButton() : null;
  if (follow && payload.follow === "present") controls.append(follow.leadButton());
  root.replaceChildren(deckEl, controls, announcer, ...(follow ? [follow.pill] : []));
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
    if (mode === "overview") setScale(root, canvas, overviewScale(win.innerWidth, canvas.width));
    else
      setScale(
        root,
        canvas,
        fitScale(win.innerWidth, win.innerHeight, canvas.width, canvas.height),
      );
    presenter?.layout();
  };

  const render = () => {
    const n = deck.current;
    root.setAttribute("data-mode", mode);
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
          clock: opts.clock,
          measure,
          ...(presenterLead && !follow?.detached ? { bar: [presenterLead] } : {}),
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

  // The app keeps its own idea of the view (the presenter strip, the version pause), so every change
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
    print: () => print(false),
    activity,
    fixedOverview,
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
  const save =
    opts.save ??
    ((blob: Blob, name: string) => {
      const url = URL.createObjectURL(blob);
      clickDownload(doc, url, name);
      showReadyNotice(doc, root, url, name);
    });
  /**
   * The nonce the running export answers, or null when none runs. A request that comes while one
   * runs (the app gave up waiting and the person asked again) takes over its answer: the app
   * listens only for its latest nonce, and the file is made once.
   */
  let answerTo: string | null = null;

  /** Lays out and fits every slide, measures it, and puts the screen view back, in one task. */
  const measureDeck = (): DeckModel => {
    const scaleWas = root.style.getPropertyValue("--s");
    root.setAttribute("data-export", "");
    root.style.setProperty("--s", "1");
    try {
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
    } else if (m.type === "paired") follow?.detach();
    else if (m.type === "view") {
      pick(m.mode);
      // A view the frame did not take: the app learns the one it shows.
      if (mode !== m.mode) reportView();
    } else if (m.type === "export") void runExport(m.nonce);
    else print(m.notes);
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
  follow?.start();

  return () => {
    follow?.stop();
    clearTimeout(idle);
    unbindInput();
    unbindOverview();
    presenter?.close();
    win.removeEventListener("message", onMessage);
    win.removeEventListener("resize", onResize);
  };
}
