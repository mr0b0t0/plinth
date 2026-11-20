// Boots a design: reads the payload the shell embeds (typedShellHtml in @plinth/shared), parses it
// with the shared parser, lays the artboards out on the canvas and mounts a frame for each board
// on screen (frames.ts). Boards load their files from the version the payload names (base.ts); a
// payload without a valid version shows the error instead of any board. It runs synchronously at
// the end of <body>, so the comments bridge (which waits for DOMContentLoaded) sees the finished
// DOM.
//
// The shell's DOM never receives author markup: the shared section and the fragments exist here
// only as strings posted to board frames, names only as textContent, and ids are
// [a-z0-9-]. It reads only window properties the platform defines, never a global by name.
// <html> carries data-ready ("ok" or "error"), data-boards, data-boards-loaded and data-zoom for
// tests and thumbnails.
import {
  boardDocument,
  type DesignBoard,
  parseDesign,
  REVIEW_MODE_PARAM,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { boardBaseUrl, boardLoaderUrl } from "./base.ts";
import { bindCanvasInput, type Schedule, Viewport, ZOOM_STEP } from "./canvas.ts";
import { BoardFrames } from "./frames.ts";
import {
  fitTransform,
  type Insets,
  LAYOUT,
  type Layout,
  type LayoutItem,
  layoutBoards,
  type Size,
  screenRect,
  type Transform,
  visibleBoards,
  zoomToBoard,
} from "./layout.ts";
import { pageName, preparePrint } from "./print.ts";
import { fromApp, readDesignAppMessage } from "./protocol.ts";
import { boardLabel, boardSlot, el, toolbar } from "./ui.ts";

const ROOT_ID = "__plinth-design";
const DATA_ID = "__plinth-content";
export const FALLBACK = "This design could not be shown.";
/**
 * Room kept clear round the boards when fitting, besides the toolbar's at the bottom: 48 px, or
 * less on a small screen (6% of its shorter side, at least 16 px), so a phone's boards get the room.
 */
const fitPadding = (size: Size) =>
  Math.round(Math.min(48, Math.max(16, Math.min(size.width, size.height) * 0.06)));
/**
 * The toolbar's height plus its offset from the bottom (design.css), for when it has no layout
 * size yet: fitted boards end the fit padding above it.
 */
const TOOLBAR_SPACE = 66;
/** Label band height on screen, over each board. */
const LABEL_PX = 26;
/** Below this on-screen board width, a label shows only the board's name. */
const NARROW_LABEL_PX = 200;

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
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "design") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  return value as TypedPayload;
}

/** Test seams: the frame scheduler, the shell's location, the frame limit and frame elements. */
export interface BootOptions {
  schedule?: Schedule;
  location?: { href: string; search: string };
  maxLive?: number;
  createFrame?: (doc: Document) => HTMLIFrameElement;
}

export interface DesignHandle {
  stop: () => void;
  view: Viewport | null;
  frames: BoardFrames | null;
}

function fail(doc: Document, root: HTMLElement | null): DesignHandle {
  if (root) root.replaceChildren(el(doc, "p", "plinth-design__error", FALLBACK));
  doc.documentElement.setAttribute("data-ready", "error");
  return { stop: () => {}, view: null, frames: null };
}

/** Renders the design and starts listening. */
export function boot(win: Window, opts: BootOptions = {}): DesignHandle {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  const parsed = payload ? parseDesign(payload.text) : null;
  if (!root || !payload || !parsed?.ok) return fail(doc, root);
  const design = parsed.design;
  const loc = opts.location ?? win.location;
  const search = new URLSearchParams(loc.search);
  const review = search.has(REVIEW_MODE_PARAM);
  // Never the shell's own directory: at the root that follows the current version.
  const baseHref = boardBaseUrl(loc, payload.version);
  if (baseHref === null) return fail(doc, root);
  const documentFor = (board: DesignBoard) =>
    boardDocument({ board, shared: design.shared, baseHref });
  const schedule: Schedule =
    opts.schedule ??
    ((fn) => {
      if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(() => fn());
      else setTimeout(fn, 16);
    });
  const appOrigin = payload.app_origin;
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
    win.addEventListener(type, fn as EventListener);
    cleanups.push(() => win.removeEventListener(type, fn as EventListener));
  };

  let frames: BoardFrames;
  const loadedChanged = () => html.setAttribute("data-boards-loaded", String(frames.loadedCount()));
  frames = new BoardFrames({
    win,
    loaderUrl: boardLoaderUrl(loc),
    documentFor,
    onChange: loadedChanged,
    ...(opts.maxLive ? { maxLive: opts.maxLive } : {}),
    ...(opts.createFrame ? { createFrame: opts.createFrame } : {}),
  });
  cleanups.push(() => frames.destroy());

  const printNow = (boards: readonly DesignBoard[], after: () => void) =>
    preparePrint(win, {
      root,
      boards,
      enter: () => frames.mountAll(),
      loaded: (ms) => frames.whenAllLoaded(ms),
      leave: () => {
        frames.release();
        after();
      },
    });

  const byId = new Map(design.boards.map((b) => [b.id, b]));
  root.setAttribute("data-mode", "canvas");
  if (review) root.setAttribute("data-review", "");

  const canvas = el(doc, "div", "plinth-design__canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "region");
  canvas.setAttribute("aria-roledescription", "canvas");
  canvas.setAttribute(
    "aria-label",
    `${design.boards.length} artboard${design.boards.length === 1 ? "" : "s"}. Drag or use the arrow keys to move, + and - to zoom, 0 to fit.`,
  );
  const world = el(doc, "div", "plinth-design__world");
  const overlay = el(doc, "div", "plinth-design__labels");
  canvas.append(world, overlay);

  const announcer = el(doc, "div", "plinth-design__live");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");

  let interacting: string | null = null;
  const covers = new Map<string, HTMLElement>();
  const slots = new Map<string, HTMLElement>();
  const labels = new Map<string, HTMLElement>();

  let auto = true;
  let view: Viewport;
  let layout: Layout = layoutBoards(design.boards);
  let itemById = new Map<string, LayoutItem>();

  // The board last zoomed to: its label offers Interact (design.css) until Fit.
  const setActive = (id: string | null) => {
    for (const [bid, label] of labels) label.toggleAttribute("data-active", bid === id);
  };
  const zoomTo = (id: string) => {
    const item = itemById.get(id);
    if (!item) return;
    auto = false;
    setActive(id);
    const size = view.size();
    view.set(zoomToBoard(item, size, insets(size), LAYOUT.label * layout.unit));
  };

  for (const b of design.boards) {
    const { slot, cover } = boardSlot(doc, b, pageName(b));
    world.append(slot);
    frames.add(b, slot);
    covers.set(b.id, cover);
    slots.set(b.id, slot);
    const label = boardLabel(doc, b, {
      zoomTo,
      interact: review ? null : (id) => setInteract(id),
    });
    overlay.append(label);
    labels.set(b.id, label);
  }

  const bar = toolbar(doc, {
    zoomOut: () => {
      auto = false;
      view.zoomBy(1 / ZOOM_STEP);
    },
    zoomIn: () => {
      auto = false;
      view.zoomBy(ZOOM_STEP);
    },
    fit: () => fitAll(),
    actual: () => actual(),
    done: () => setInteract(null),
  });

  /** The room fitted boards leave: the fit padding on every side, plus the toolbar at the bottom. */
  function insets(size: Size): Insets {
    const r = bar.el.getBoundingClientRect();
    const space = r.height > 0 ? Math.max(size.height - r.top, 0) : TOOLBAR_SPACE;
    const p = fitPadding(size);
    return { top: p, right: p, bottom: p + space, left: p };
  }

  /** Lays the boards out for the room the viewport leaves them. */
  function relayout(size: Size) {
    const p = insets(size);
    layout = layoutBoards(
      design.boards,
      (size.width - p.left - p.right) / (size.height - p.top - p.bottom),
    );
    itemById = new Map(layout.items.map((it) => [it.id, it]));
    for (const it of layout.items) {
      // Custom properties, so the print layout can drop the position without !important.
      slots.get(it.id)?.style.setProperty("--pd-x", `${it.x}px`);
      slots.get(it.id)?.style.setProperty("--pd-y", `${it.y}px`);
    }
  }

  // While a board is in use, the toolbar holds only Done, and that board's label no Interact.
  function setInteract(id: string | null) {
    if (review) id = null;
    if (id !== null && !byId.has(id)) return;
    if (interacting === id) return;
    const prev = interacting;
    const doneHadFocus = doc.activeElement === bar.done;
    if (prev) {
      covers.get(prev)?.removeAttribute("hidden");
      slots.get(prev)?.removeAttribute("data-interacting");
      labels.get(prev)?.removeAttribute("data-interacting");
      const f = frames.frameOf(prev);
      if (f) f.tabIndex = -1;
    }
    interacting = id;
    frames.pin(id);
    bar.setInteracting(id !== null);
    if (id) {
      const label = labels.get(id);
      const chipHadFocus = label?.contains(doc.activeElement) ?? false;
      covers.get(id)?.setAttribute("hidden", "");
      slots.get(id)?.setAttribute("data-interacting", "");
      label?.setAttribute("data-interacting", "");
      const f = frames.frameOf(id);
      if (f) f.tabIndex = 0;
      // The Interact button just went away: keep focus on what is in use now.
      if (chipHadFocus || doneHadFocus) (f ?? bar.done).focus();
      announcer.textContent = `Interacting with ${byId.get(id)?.name ?? "the board"}. Press Done or Escape to stop.`;
    } else {
      announcer.textContent = "";
      if (doneHadFocus && prev) {
        labels.get(prev)?.querySelector<HTMLElement>(".plinth-design__label-name")?.focus();
      }
    }
  }

  function fitAll() {
    auto = true;
    setActive(null);
    const size = view.size();
    relayout(size);
    view.set(fitTransform(layout.bounds, size, insets(size)));
  }
  function actual() {
    auto = false;
    view.zoomTo(1);
  }

  // Labels keep their screen size: a label sits over its board, at most as wide as the board
  // (only the name when that is narrow).
  const place = (t: Transform) => {
    for (const it of layout.items) {
      const label = labels.get(it.id);
      if (!label) continue;
      const r = screenRect(it, t);
      label.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y - LABEL_PX)}px)`;
      label.style.maxWidth = `${Math.max(Math.round(r.w), 72)}px`;
      label.toggleAttribute("data-narrow", r.w < NARROW_LABEL_PX);
    }
  };

  view = new Viewport(win, canvas, world, schedule, (t) => {
    place(t);
    frames.show(visibleBoards(layout.items, t, view.size()));
    const pct = String(Math.round(t.scale * 100));
    bar.zoom.textContent = `${pct}%`;
    html.setAttribute("data-zoom", pct);
  });

  root.replaceChildren(canvas, bar.el, announcer);
  html.setAttribute("data-boards", String(design.boards.length));
  html.setAttribute("data-boards-loaded", "0");

  cleanups.push(
    bindCanvasInput(canvas, view, {
      fit: fitAll,
      actual,
      moved: () => {
        auto = false;
      },
      isControl: (t) =>
        t.closest(".plinth-design__toolbar, .plinth-design__label, .plinth-design__frame") !== null,
      backgroundClick: (t) => {
        // A click outside the board being interacted with puts its cover back.
        if (interacting && !t.closest(`[data-board="${interacting}"]`)) setInteract(null);
      },
      escape: () => {
        if (interacting) {
          setInteract(null);
          return true;
        }
        return false;
      },
    }),
  );

  const printAll = () => {
    setInteract(null);
    void printNow(design.boards, () => view.set(view.t));
  };
  listen("message", (e) => {
    if (!fromApp(e, win, appOrigin)) return;
    if (readDesignAppMessage(e.data)?.type === "print") printAll();
  });
  // Ctrl/Cmd+P inside the frame prints the design, one board per page, not the app around it.
  listen("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      printAll();
    }
  });
  listen("resize", () => {
    if (auto) fitAll();
    else view.set(view.t);
  });

  fitAll();
  html.setAttribute("data-ready", "ok");
  return {
    stop: () => {
      for (const f of cleanups.splice(0)) f();
    },
    view,
    frames,
  };
}
