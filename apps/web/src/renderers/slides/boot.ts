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
//
// On-page editing (slides-text), as for docs: view mode renders exactly as before. With
// `live: "room"` in the payload (an owner or editor on the current version, rooms on) it also opens
// the room's draft socket, shows the live draft as it changes and reports its status to the app;
// edit code runs only once the app sends { type: "edit", on: true }. Without `live` that message
// turns on solo editing of the version's text, which the app saves through its own session after
// asking for it with `collect`. Edit mode draws every raw slide (editView.ts) and edits slide text,
// notes and the deck's settings in place (edit.ts); presenting, full screen and following the
// presenter wait until editing ends. A frozen draft is reviewed whole in the frame
// (common/review.ts) when the app sends `review`: both decks as slides, side by side. Every
// editing message to the app carries the frame key the app put in the address
// (common/frameKey.ts), which is taken out of it before anything renders.
import {
  applySlidesStruct,
  type ChangeItem,
  type DeckSettings,
  deckLayout,
  joinLines,
  LIMITS,
  liveRules,
  type ParsedDeck,
  parseDeck,
  SLIDE_ASPECTS,
  type SlidesStructOp,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { AskWhat, LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import {
  appPoster,
  type EditAppMessage,
  ReviewSession,
  readEditMessage,
} from "../common/editSession.ts";
import { pinFiles } from "../common/files.ts";
import { takeFrameKey } from "../common/frameKey.ts";
import { type ClientLease, LiveDocClient } from "../common/live.ts";
import { bringIntoPane, CHANGED_ATTR, DraftReview, type ReviewPane } from "../common/review.ts";
import { reconcile } from "../doc/blocks.ts";
import { buildDeck, type SlideView } from "./deck.ts";
import { el } from "./dom.ts";
import {
  DECK_WORDS,
  type DeckBackend,
  type DeckRescueReport,
  LocalDeck,
  SlidesEditor,
} from "./edit.ts";
import { buildEditDeck, type EditSlideView } from "./editView.ts";
import { collectImages, saveBlob, writerLoader } from "./export.ts";
import { buildExportModel, domGeometry, type Geometry, pptxFileName } from "./exportModel.ts";
import { Follow, type FollowSocket } from "./follow.ts";
import { iconButton } from "./icons.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { bindInput, DeckController, type DeckMode } from "./nav.ts";
import { bindOverview, revealSlide } from "./overview.ts";
import type { DeckModel, PptxBuilder } from "./pptxModel.ts";
import { Presenter, type PresenterClock } from "./presenter.ts";
import { imagesReady, pageRule, pageStyle, printDeck } from "./print.ts";
import { fromApp, postToApp, readSlidesAppMessage, type SlidesAppMessage } from "./protocol.ts";
import {
  CONTROLS_INSET,
  EDIT_NOTES_H,
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
const RULES = liveRules("slides");
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
  return value as TypedPayload;
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
  /** For tests: makes the room's draft socket (LiveDocClient's `connect`). */
  connectDoc?: ConstructorParameters<typeof LiveDocClient>[0]["connect"];
}

const ERRORS: Record<string, string> = {
  invalid: DECK_WORDS.refused,
  too_large: "That is more than a deck can hold. The change was not applied.",
  draft_limit:
    "These edits are live but not kept: the owner has too many pages with unpublished page edits. Publish a version.",
  rate_limited: "Typing too fast for the room. Your text is kept and sent again.",
  unavailable: "Live editing is unavailable right now. Your text is kept on this page.",
};

/** The source of each slide, for telling which slides of a pane changed since the base. */
function slideSources(parsed: ParsedDeck): string[] {
  return parsed.slides.map((s) => JSON.stringify([s.head, s.columns, s.notes]));
}

/**
 * The deck's side of the review: its slides as the deck shows them, stacked and scaled to the
 * pane, each drawn with that version's files, with the slides that differ from the base marked.
 */
export function deckPane(doc: Document): ReviewPane {
  return {
    render(host, text, version, base) {
      const parsed = parseDeck(text);
      const wrap = el(doc, "div", "plinth-slides plinth-review__deck");
      wrap.setAttribute("data-mode", "overview");
      wrap.setAttribute("data-fixed", "");
      const views = buildDeck(doc, parsed);
      const list = el(doc, "div", "plinth-slides__deck");
      const was = base === null ? null : slideSources(parseDeck(base));
      const now = slideSources(parsed);
      views.forEach((v, i) => {
        if (was && was[i] !== now[i]) v.frame.setAttribute(CHANGED_ATTR, "");
        list.append(v.frame);
      });
      if (parsed.slides.length === 0) {
        list.append(el(doc, "p", "plinth-slides__error", "This deck has no slides."));
      }
      wrap.append(list);
      pinFiles(wrap, version);
      const canvas = SLIDE_ASPECTS[parsed.settings.aspect];
      const width = Math.max(200, host.clientWidth || 360);
      wrap.style.setProperty("--cols", "1");
      setScale(wrap, canvas, Math.min(1, (width - 2 * GUTTER) / canvas.width));
      host.replaceChildren(wrap);
      for (const v of views) fitSlide(v.el, v.body);
      return (item: ChangeItem) => {
        const m = /^Slide (\d+)/.exec(item.where);
        const frame = m ? wrap.querySelector(`.plinth-slides__frame[data-n="${m[1]}"]`) : null;
        if (!frame) return false;
        bringIntoPane(frame);
        return true;
      };
    },
  };
}

/** Renders the deck and starts listening. Returns a function that stops everything it started. */
export function boot(win: Window, opts: BootOptions = {}): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  // The frame key leaves the address before anything renders (common/frameKey.ts).
  const key = takeFrameKey(win);
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  const parsed = payload ? parseDeck(payload.text) : null;
  if (!root || !payload || !parsed || parsed.slides.length === 0) {
    if (root) root.replaceChildren(el(doc, "p", "plinth-slides__error", FALLBACK));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const measure = opts.measure ?? overflows;
  let settings: DeckSettings = parsed.settings;
  let canvas = SLIDE_ASPECTS[settings.aspect];
  const appOrigin = payload.app_origin;
  const fixedOverview = payload.view === "overview";
  html.setAttribute("data-theme", settings.theme);
  // A fixed overview has no current slide to mark and no slide to open on a click.
  if (fixedOverview) root.setAttribute("data-fixed", "");
  html.setAttribute("data-aspect", settings.aspect);

  let views: SlideView[] = buildDeck(doc, parsed);
  /** The text the deck was last drawn from, and whether as edit mode's raw slides. */
  let drawn = { text: payload.text, raw: false };
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
  let fitted = new WeakSet<SlideView>();
  /** On-page editing is on (edit.ts draws and edits the raw slides). */
  let editing = false;
  /** The app shows this frame full screen (its `presenting` message). */
  let appPresenting = false;

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
          // Someone started or stopped leading: the deck shown may switch to or from the draft.
          changed: () => followChanged(),
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
    const fit = fitSlide(v.el, v.body, measure);
    fitted.add(v);
    // While editing, a slide whose text had to shrink says so with a quiet badge (not an error).
    let badge = v.frame.querySelector<HTMLElement>(".plinth-slides__dense");
    if (editing && fit < 1) {
      if (!badge) {
        badge = el(doc, "p", "plinth-slides__dense", DECK_WORDS.dense);
        v.frame.insertBefore(badge, v.frame.querySelector(".plinth-slides__canvas"));
      }
    } else badge?.remove();
  };
  // An image that loads late changes what fits.
  const watched = new WeakSet<SlideView>();
  const watchImages = (list: SlideView[]) => {
    for (const v of list) {
      if (watched.has(v)) continue;
      watched.add(v);
      for (const img of Array.from(v.el.querySelectorAll("img"))) {
        img.addEventListener("load", () => {
          if (!views.includes(v)) return;
          if (mode === "overview" || v.n === deck.current) fitView(v);
          if (presenter && Math.abs(presenter.slide - v.n) <= 1) presenter.show(presenter.slide);
        });
      }
    }
  };
  watchImages(views);

  const scale = () => {
    if (mode === "overview") {
      const cols = overviewColumns(win.innerWidth, fixedOverview);
      root.style.setProperty("--cols", String(cols));
      setScale(root, canvas, overviewScale(win.innerWidth, canvas.width, cols));
      root.style.removeProperty("--controls-bottom");
    } else {
      // The slide is centred with the stage's gutter on every side, full screen too; the controls
      // show one gutter above its bottom edge, wherever the letterbox puts it. While editing, the
      // notes panel takes its height under the slide.
      const notes = editing && mode === "deck" ? EDIT_NOTES_H : 0;
      const s = fitScale(
        win.innerWidth - 2 * GUTTER,
        win.innerHeight - 2 * GUTTER - notes,
        canvas.width,
        canvas.height,
      );
      setScale(root, canvas, s);
      // The slide and its notes are centred together: the controls stay over the slide's edge.
      const below = Math.max(0, (win.innerHeight - canvas.height * s - notes) / 2) + notes;
      root.style.setProperty("--controls-bottom", `${Math.floor(below) + CONTROLS_INSET}px`);
    }
    presenter?.layout();
  };

  const render = () => {
    const n = deck.current;
    root.setAttribute("data-mode", mode);
    root.toggleAttribute("data-editing", editing);
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

  /** Shows `next` in place of the slides on screen, with the deck's (maybe new) settings. */
  const setViews = (next: SlideView[], s: DeckSettings, current: number) => {
    const same = next.length === views.length && next.every((v, i) => v === views[i]);
    if (!same) {
      // Slides that stay keep their place: the one being typed in is never detached (which would
      // take the focus out of it).
      reconcile(
        deckEl,
        next.map((v) => v.frame),
      );
      views = next;
      fitted = new WeakSet();
      watchImages(next);
    }
    if (JSON.stringify(s) !== JSON.stringify(settings)) {
      settings = s;
      canvas = SLIDE_ASPECTS[s.aspect];
      html.setAttribute("data-theme", s.theme);
      html.setAttribute("data-aspect", s.aspect);
      pageStyle(doc).textContent = pageRule(canvas, false);
    }
    deck.setCount(next.length, current);
    if (presenter && !same) {
      // Presenter view holds the slides it shows: open it again on the new ones.
      presenter.close();
      presenter.el.remove();
      presenter = null;
    }
    render();
  };

  // The app keeps its own idea of the view (the menu, the version pause), so every change
  // is reported, whichever key, control or message made it.
  const reportView = () => postToApp(win, appOrigin, { type: "view", mode });

  function pick(next: DeckMode) {
    auto = false;
    // Review mode and the editor preview keep every slide in the DOM (comment pins anchor to them),
    // whatever asks for another view. Presenter view waits until editing ends.
    if (fixedOverview || next === mode) return;
    if (editing && next === "presenter") return;
    const was = mode;
    mode = next;
    // Into presenter view the published deck, out of it the draft that waited (redraw).
    if (!editing && (was === "presenter" || next === "presenter")) redraw();
    render();
    if (mode === "overview") revealSlide(doc, deck.current);
    root?.focus({ preventScroll: true });
    reportView();
  }

  /** The shown slide of edit mode's raw slide `n` (or of the nearest shown one), and back. */
  let rawOffset = 0;

  deck.onChange((n) => {
    render();
    if (mode === "overview") revealSlide(doc, n);
    announcer.textContent = `Slide ${n} of ${views.length}`;
    // While editing, the deck counts raw slides: the app hears the shown slide's number.
    if (!editing) postToApp(win, appOrigin, { type: "position", slide: n, count: views.length });
  });

  // Print and the .pptx wait until editing ends, as presenting does: edit mode's slides include
  // empty ones the deck never shows, with their labels and placeholders.
  const print = (notes: boolean) => {
    if (editing) return;
    void printDeck(win, root, {
      notes,
      canvas,
      prepare: () => {
        for (const v of views) fitView(v);
      },
      restore: render,
    });
  };

  const unbindInput = bindInput(win, root, deck, {
    mode: () => mode,
    setMode: pick,
    fullscreen: () => postToApp(win, appOrigin, { type: "fullscreen" }),
    // Printing from presenter view prints the handout, each slide over its notes.
    print: () => print(mode === "presenter"),
    activity,
    fixedOverview,
    columns: () => overviewColumns(win.innerWidth, fixedOverview),
    editing: () => editing,
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
    if (editing && answerTo === null) {
      // Not from edit mode's raw slides (the app offers no download while editing).
      postToApp(win, appOrigin, { type: "exported", nonce, ok: false, images_skipped: 0, opaque });
      return;
    }
    const report = (ok: boolean, skipped: number) =>
      postToApp(win, appOrigin, {
        type: "exported",
        nonce: answerTo ?? nonce,
        ok,
        // The app reads at most the version file cap; a deck of data: images could pass it.
        images_skipped: Math.min(skipped, LIMITS.maxAssetsCeiling),
        opaque,
      });
    const busy = answerTo !== null;
    answerTo = nonce;
    if (busy) return;
    try {
      // The writer loads while the images decode. Its failure is handled below, after the decode.
      const writer = loadWriter();
      writer.catch(() => undefined);
      await imagesReady(root);
      // Edit mode began while the images decoded: its raw slides, with their labels and
      // placeholders, are not the deck. No file is made from them.
      if (editing) throw new Error("editing");
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

  // ---------- on-page editing (edit.ts) ----------

  let live: ReturnType<typeof startLive> | null = null;
  /**
   * The deck as last published that this frame knows: its own version's text, or the room's draft
   * while the room says it has no edits since its base version (a page Publish, a reset).
   */
  let published = payload.text;
  /**
   * The published deck shown while the deck holds it (holdsPublished), as it was when that began:
   * a version published meanwhile waits until it ends (the app holds the version too while it
   * presents). Null otherwise.
   */
  let held: string | null = null;

  /**
   * The deck shows the published deck, not the live draft: while it is presented (presenter view,
   * full screen, an audience window) and while a presenter leads the room (this one included), so
   * a co-editor's typing never reaches a presented screen and every follower counts the slides
   * the leader counts.
   */
  const holdsPublished = () =>
    mode === "presenter" || appPresenting || (follow?.detached ?? false) || (follow?.led ?? false);

  function followChanged() {
    if (live && !editing) redraw();
  }

  /** Takes the room's draft as the published deck while it has no edits (see `published`). */
  function notePublished() {
    const state = live?.state();
    if (state?.clean && state.lines) published = joinLines(state.lines);
  }

  /** Draws the deck again: edit mode's raw slides from the editor's lines, else the draft's. */
  const redraw = () => {
    notePublished();
    const state = live?.state();
    if (editing && state?.editor && state.lines) {
      const lines = state.lines;
      const layout = deckLayout(lines);
      const cache = new Map<string, EditSlideView>();
      for (const v of views) {
        const key = (v as Partial<EditSlideView>).key;
        if (key) cache.set(key, v as EditSlideView);
      }
      const built = buildEditDeck(doc, lines, layout, cache, state.editor.held);
      const text = joinLines(lines);
      // Raw slides before the first shown one: the shown slide n is raw slide n + lo.
      const lo = Math.max(
        0,
        built.views.findIndex((v) => v.shownN === 1),
      );
      const want = drawn.raw ? deck.current : deck.current + lo;
      rawOffset = lo;
      drawn = { text, raw: true };
      setViews(built.views, built.settings, want);
      state.editor.decorate(built.views, layout);
      return;
    }
    // Outside edit mode, in room mode, the deck follows the draft's visible slides, as a doc's
    // frame follows its draft (the published deck while the draft shows none), except while it
    // holds the published deck (holdsPublished), and then the deck catches up.
    held = holdsPublished() ? (held ?? published) : null;
    const draft = state?.lines ? joinLines(state.lines) : null;
    const text = held ?? (draft !== null && parseDeck(draft).slides.length > 0 ? draft : published);
    if (!drawn.raw && text === drawn.text) return;
    const shown = parseDeck(text);
    const current = drawn.raw ? Math.max(1, deck.current - rawOffset) : deck.current;
    drawn = { text, raw: false };
    setViews(buildDeck(doc, shown), shown.settings, current);
  };

  function startLive() {
    let client: LiveDocClient | null = null;
    let local: LocalDeck | null = null;
    let editor: SlidesEditor | null = null;
    let queued = false;
    /** Solo: the version shown, whose files the draft is drawn with. */
    let soloBase: number | null = null;
    const backend = (): DeckBackend | null => local ?? (client as DeckBackend | null);
    /**
     * Typing that keeps every publish back (the app's `unsavable`): in a room, typing that cannot
     * be written as typed (the room holds the rest, or keeps it to write again); alone, any typing
     * the frame's text does not hold, since that text is the whole draft (the deck at its size
     * limit included).
     */
    const keptBack = () => (local ? (editor?.unwritten ?? false) : (editor?.unsavable ?? false));
    const poster = appPoster(win, appOrigin, key);
    const post = poster.post;
    const statusNow = () => {
      queued = false;
      const c = local ? null : client;
      const b = backend();
      const you = c?.you?.email;
      // Where each other editor is: the slide of their lease, never its content.
      const where = new Map<string, string>();
      for (const l of c?.leases.values() ?? []) {
        const w = editor?.whereOf(l);
        if (w) where.set(l.by, w);
      }
      const editors = (c?.editors ?? [])
        .filter((e) => e !== you)
        .slice(0, 50)
        .map((email) => {
          const w = where.get(email);
          return { email: email.slice(0, 254), block: w !== undefined, ...(w ? { where: w } : {}) };
        });
      const text = local ? local.text : (c?.text ?? "");
      const blocked = keptBack();
      const s: LiveFrameStatus = {
        connected: c?.connected ?? false,
        failed: client?.failed ?? false,
        editing: editor?.editing ?? false,
        holding: (editor?.editing ?? false) && b?.mine != null,
        dirty: local ? local.dirty : (c?.dirty ?? false),
        unflushed: c ? c.unflushed || (editor?.pending ?? false) : blocked,
        rev: c?.rev ?? 0,
        base_version: c?.baseVersion ?? 0,
        conflict_version: c?.conflictVersion ?? null,
        last_by_you: c?.lastByYou ?? false,
        last_edit_at: c?.lastEditAt ?? null,
        editors,
        publishable: RULES?.unpublishable(text) === null && !blocked,
        ...(blocked ? { unsavable: true as const } : {}),
      };
      post({ type: "live", ...s });
    };
    const status = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(statusNow);
    };
    const hooks = {
      save: () => post({ type: "save" }),
      status,
      // The rescue store: the app keeps a copy in its own storage (never this origin's).
      rescue: (r: DeckRescueReport) => post({ type: "rescue", ...r }),
      leave: () => {
        if (!session.isOpen) post({ type: "leave" });
      },
      fileVersion: () => {
        if (local) return soloBase;
        return client && client.baseVersion > 0 ? client.baseVersion : null;
      },
      // A place the person wants an agent to change (an image, a block shown read-only): the app
      // opens its Ask dialog. The anchor is a structural key and structural words, never content.
      ask: (anchor: { key: string; text: string }, what: AskWhat) =>
        post({ type: "ask", anchor, what }),
      redraw,
      current: () => deck.current,
      goto: (n: number) => deck.go(n),
      refit: () => {
        const v = views[deck.current - 1];
        if (v && mode === "deck") fitView(v);
      },
      announce: (text: string) => {
        announcer.textContent = text;
      },
    };
    const events = {
      granted: (l: ClientLease) => editor?.granted(l),
      changed: () => {
        redraw();
        editor?.changed();
        status();
      },
      structLanded: (op: SlidesStructOp) => editor?.structLanded(op),
      // A deck at its size limit keeps the typing (the editor checks first); only `invalid` puts
      // a block back.
      error: (code: "invalid" | "too_large") =>
        code === "invalid" ? editor?.refused(DECK_WORDS.refused) : editor?.notify(DECK_WORDS.full),
    };

    const review = new DraftReview({
      win,
      type: "slides",
      sourcePath: payload?.path ?? "slides.md",
      rules: RULES as NonNullable<typeof RULES>,
      pane: deckPane(doc),
      unpublishableWords: "Your deck has no slides, so it can't be published.",
      choose: (outcome, note) => session.choose(outcome, note),
    });
    const session = new ReviewSession(review, {
      post,
      rules: RULES as NonNullable<typeof RULES>,
      room: () => (local ? null : client),
      soloText: () => local?.text ?? null,
    });

    const goSolo = () => {
      // The deck's live form, as the room holds it: CRLF read as LF.
      local ??= new LocalDeck(RULES?.toLive(payload?.text ?? "") ?? "", events);
      if (editor) editor.setBackend(local);
      else editor = new SlidesEditor(win, local, hooks);
    };

    if (payload?.live === "room") {
      client = new LiveDocClient({
        win,
        applyStruct: (lines, op) => applySlidesStruct(lines, op as SlidesStructOp),
        // Typed text not in the draft yet keeps a hidden tab's socket, as unflushed text does.
        keepOpen: () => editor?.pending ?? false,
        ...(opts.connectDoc ? { connect: opts.connectDoc } : {}),
        listener: {
          changed: () => {
            if (local) return;
            redraw();
            editor?.changed();
          },
          status: () => {
            // A page Publish ends with a status frame (no edits since the new version).
            if (!local) notePublished();
            if (client && !client.connected && !local) editor?.disconnected();
            if (!local) editor?.roomStatus();
            if (client?.failed && !local && editor?.editing) {
              // The room never answered: keep editing alone.
              goSolo();
              redraw();
            }
            status();
          },
          granted: (l) => {
            if (!local) editor?.granted(l);
          },
          denied: (r, by) => {
            if (!local) editor?.denied(r, by);
          },
          lost: (r) => {
            if (!local) editor?.lost(r);
          },
          version: (kind, n, info) => {
            // The unpublished changes were discarded: so is typing kept to go back in.
            if (kind === "reset" && info.why === "discarded") editor?.clearKept();
            if (!local) session.version(kind, n, info);
            status();
          },
          error: (code) => {
            if (code === "invalid") editor?.refused(DECK_WORDS.refused);
            // A lease that went before its last frame was answered (a takeover): the editor says
            // what happened already.
            else if (code === "not_held") return;
            else editor?.notify(ERRORS[code] ?? "Something went wrong with live editing.");
          },
          structDenied: (r, by) => {
            if (!local) editor?.structDenied(r, by);
          },
          structLanded: (op) => {
            if (!local) editor?.structLanded(op as SlidesStructOp);
          },
        },
      });
      editor = new SlidesEditor(win, client as DeckBackend, hooks);
      client.start();
    }

    const setEditing = (on: boolean) => {
      if (on === editing) return;
      if (on) {
        // Presenting and editing exclude each other; following a presenter waits.
        if (mode === "presenter") mode = "deck";
        if (mode === "overview" && auto) mode = "deck";
        auto = false;
        follow?.pause(true);
        rawOffset = 0;
      }
      editing = on;
      editor?.setEditing(on);
      if (!on) {
        redraw();
        follow?.pause(false, deck.current);
        reportView();
      }
    };

    const onMessage = (m: EditAppMessage) => {
      if (m.type === "edit") {
        if (m.base !== undefined) soloBase = m.base;
        if (m.on && (!client || client.failed)) goSolo();
        setEditing(m.on);
        if (m.on && m.focus === "first") editor?.focusFirst();
        status();
      } else if (m.type === "rescue") {
        // What the app kept from an earlier frame (a reload), and its answers to this one's reports.
        if (m.items.length > 0) editor?.offerRescue(m.items);
        if (m.stored) editor?.rescueStored(m.stored.ids, m.stored.n);
      } else if (m.type === "collect" && local) {
        editor?.flush();
        // Typing the deck's text does not hold (it cannot be written as typed, or the deck is at
        // its size limit): the app publishes nothing, and keeps a copy with it in.
        if (keptBack()) {
          const kept = editor?.textWithTyping() ?? local.text;
          post({ type: "draft", nonce: m.nonce, text: kept, unsavable: true });
        } else post({ type: "draft", nonce: m.nonce, text: local.text });
      } else if (m.type === "review") {
        editor?.flush();
        void session.open(m);
      } else if (m.type === "reviewed") {
        session.answer(m);
      }
    };
    return {
      onMessage,
      settings: () => editor?.openSettings(),
      save: () => {
        editor?.flush();
        // Typing that cannot be written yet is not in the draft: no Publish goes out without it.
        if (editor && keptBack()) {
          editor.notify(editor.unsavable ? DECK_WORDS.unsavable : DECK_WORDS.fullHere);
          status();
          return;
        }
        post({ type: "save" });
      },
      state: () => {
        const b = backend();
        // The room's draft is the published deck while it has no edits since its base version.
        const c = local ? null : client;
        const clean =
          c !== null && c.ready && c.dirtyKnown && !c.dirty && c.conflictVersion === null;
        return { editor, lines: b?.ready ? b.lines : null, clean };
      },
      stop: () => {
        client?.stop();
        editor?.stop();
        review.close();
        poster.stop();
      },
    };
  }

  if (payload.live === "room" && appOrigin !== "" && !fixedOverview) live = startLive();

  const onSlidesMessage = (m: SlidesAppMessage) => {
    if (m.type === "goto") {
      // While the deck follows a presenter, the presenter's slide wins over the app's; while
      // editing, the app's number is a shown slide's.
      if (!follow?.holding) deck.go(editing ? m.slide + rawOffset : m.slide);
    } else if (m.type === "paired") {
      follow?.detach();
      followChanged();
    } else if (m.type === "lead") follow?.resumeLead();
    else if (m.type === "presenting") {
      appPresenting = m.on;
      followChanged();
    } else if (m.type === "view") {
      pick(m.mode);
      // A view the frame did not take: the app learns the one it shows.
      if (mode !== m.mode) reportView();
    } else if (m.type === "export") void runExport(m.nonce);
    else if (m.type === "deck_settings") live?.settings();
    else print(mode === "presenter");
  };

  const onMessage = (e: MessageEvent) => {
    if (!fromApp(e, win, appOrigin)) return;
    const m = readSlidesAppMessage(e.data);
    if (m) return onSlidesMessage(m);
    // On-page editing: never in review mode or the editor preview, which show every slide.
    if (fixedOverview) return;
    const edit = readEditMessage(e.data);
    if (!edit) return;
    live ??= startLive();
    live.onMessage(edit);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!editing || e.defaultPrevented) return;
    // Cmd/Ctrl+S publishes, from anywhere in the frame.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      live?.save();
    }
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
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("resize", onResize);

  render();
  html.setAttribute("data-ready", "ok");
  postToApp(win, appOrigin, { type: "ready", slide: deck.current, count: views.length });
  follow?.start();

  return () => {
    follow?.stop();
    live?.stop();
    clearTimeout(idle);
    unbindInput();
    unbindOverview();
    presenter?.close();
    win.removeEventListener("message", onMessage);
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("resize", onResize);
  };
}
