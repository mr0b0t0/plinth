// Boots a design: reads the payload the shell embeds (typedShellHtml in @plinth/shared), parses it
// with the shared parser, lays the artboards out on the canvas and mounts a frame for each board
// on screen (frames.ts). With ?plinth-board=<id> it shows that one board alone at 100% instead
// (an unknown id shows the canvas). With ?plinth-print=1 it lays the boards out for the server's
// PNG and PDF export (services/designExport.ts in the Worker). It runs synchronously at the end of <body>, so the comments
// bridge (which waits for DOMContentLoaded) sees the finished DOM.
//
// The shell's DOM never receives author markup: the shared section and the fragments exist here
// only as strings posted to board frames, names and sections only as textContent, and ids are
// [a-z0-9-]. It reads only window properties the platform defines, never a global by name.
// <html> carries data-ready ("ok" or "error"), data-boards, data-boards-loaded and data-zoom for
// tests and thumbnails.
import {
  boardDocument,
  DESIGN_BOARD_PARAM,
  DESIGN_PRINT_PARAM,
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
  LAYOUT,
  layoutBoards,
  screenRect,
  type Transform,
  visibleBoards,
  zoomToBoard,
} from "./layout.ts";
import { pageName, preparePrint, printCss, printStyle } from "./print.ts";
import { fromApp, readDesignAppMessage } from "./protocol.ts";
import { boardLabel, boardList, boardSlot, button, el, sectionHeading, toolbar } from "./ui.ts";

const ROOT_ID = "__plinth-design";
const DATA_ID = "__plinth-content";
export const FALLBACK = "This design could not be shown.";
/** Room the toolbar takes at the bottom, kept clear when fitting. */
const FIT_PADDING = 56;
/** Label band height on screen, over each board. */
const LABEL_PX = 26;
const HEADING_PX = 26;
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
  const baseHref = boardBaseUrl(loc);
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

  const soloId = search.get(DESIGN_BOARD_PARAM);
  const solo = soloId ? design.boards.find((b) => b.id === soloId) : undefined;

  // The export layout (?plinth-print=1, with ?plinth-board=<id> one board): what the server's
  // PNG and PDF export renders. Every board mounted at 100% in normal flow, one named page per
  // size, no chrome, no covers and no page background, and nothing printed from here: the
  // export's own browser prints or screenshots the page once data-boards-loaded reaches
  // data-boards. An unknown board id is an error, never a different board.
  if (search.get(DESIGN_PRINT_PARAM) === "1") {
    if (soloId !== null && !solo) {
      frames.destroy();
      return fail(doc, root);
    }
    const boards = solo ? [solo] : design.boards;
    root.setAttribute("data-mode", "export");
    root.setAttribute("data-print", "");
    html.setAttribute("data-export", "");
    printStyle(doc).textContent = printCss(boards);
    const stage = el(doc, "div", "plinth-design__export");
    for (const b of boards) {
      const { slot, cover } = boardSlot(doc, b, pageName(b));
      cover.remove();
      stage.append(slot);
      frames.add(b, slot);
    }
    root.replaceChildren(stage);
    html.setAttribute("data-boards", String(boards.length));
    html.setAttribute("data-boards-loaded", "0");
    html.setAttribute("data-zoom", "100");
    frames.mountAll();
    html.setAttribute("data-ready", "ok");
    return {
      stop: () => {
        for (const f of cleanups.splice(0)) f();
      },
      view: null,
      frames,
    };
  }

  // One board alone at 100% (?plinth-board=<id>): no canvas, no covers.
  if (solo) {
    root.setAttribute("data-mode", "solo");
    const { slot, cover } = boardSlot(doc, solo, pageName(solo));
    cover.remove();
    const stage = el(doc, "div", "plinth-design__solo");
    stage.append(slot);
    root.replaceChildren(stage);
    frames.add(solo, slot);
    frames.show([solo.id]);
    html.setAttribute("data-boards", "1");
    html.setAttribute("data-zoom", "100");
    listen("message", (e) => {
      if (!fromApp(e, win, appOrigin)) return;
      if (readDesignAppMessage(e.data)?.type === "print") void printNow([solo], () => {});
    });
    html.setAttribute("data-ready", "ok");
    return {
      stop: () => {
        for (const f of cleanups.splice(0)) f();
      },
      view: null,
      frames,
    };
  }

  const layout = layoutBoards(design.boards);
  const byId = new Map(design.boards.map((b) => [b.id, b]));
  const itemById = new Map(layout.items.map((it) => [it.id, it]));
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
  const headings: { el: HTMLElement; row: number }[] = [];

  let auto = true;
  let view: Viewport;
  const zoomTo = (id: string) => {
    const item = itemById.get(id);
    if (!item) return;
    auto = false;
    view.set(zoomToBoard(item, view.size(), FIT_PADDING, LAYOUT.label * layout.unit));
  };

  for (const b of design.boards) {
    const item = itemById.get(b.id);
    if (!item) continue;
    const { slot, cover } = boardSlot(doc, b, pageName(b));
    // Custom properties, so the print layout can drop the position without !important.
    slot.style.setProperty("--pd-x", `${item.x}px`);
    slot.style.setProperty("--pd-y", `${item.y}px`);
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
  for (const [i, row] of layout.rows.entries()) {
    if (!row.heading || row.section === null) continue;
    const h = sectionHeading(doc, row.section);
    overlay.append(h);
    headings.push({ el: h, row: i });
  }

  const done = button(doc, "plinth-design__done", "Done interacting", "Done", () =>
    setInteract(null),
  );
  done.hidden = true;

  function setInteract(id: string | null) {
    if (review) id = null;
    if (id !== null && !byId.has(id)) return;
    if (interacting === id) return;
    if (interacting) {
      covers.get(interacting)?.removeAttribute("hidden");
      slots.get(interacting)?.removeAttribute("data-interacting");
      const f = frames.frameOf(interacting);
      if (f) f.tabIndex = -1;
    }
    interacting = id;
    frames.pin(id);
    if (id) {
      covers.get(id)?.setAttribute("hidden", "");
      slots.get(id)?.setAttribute("data-interacting", "");
      const f = frames.frameOf(id);
      if (f) f.tabIndex = 0;
      done.hidden = false;
      announcer.textContent = `Interacting with ${byId.get(id)?.name ?? "the board"}. Press Done or Escape to stop.`;
    } else {
      done.hidden = true;
      announcer.textContent = "";
    }
  }

  const fitAll = () => {
    auto = true;
    view.set(fitTransform(layout.bounds, view.size(), FIT_PADDING));
  };
  const actual = () => {
    auto = false;
    view.zoomTo(1);
  };

  const bar = toolbar(doc, {
    zoomOut: () => {
      auto = false;
      view.zoomBy(1 / ZOOM_STEP);
    },
    zoomIn: () => {
      auto = false;
      view.zoomBy(ZOOM_STEP);
    },
    fit: fitAll,
    actual,
    toggleList: () => (list.isOpen() ? list.close() : list.open()),
  });
  const list = boardList(doc, design.boards, bar.list, (id) => {
    zoomTo(id);
    canvas.focus({ preventScroll: true });
  });
  bar.el.append(list.el);

  // Labels and headings keep their screen size: a label sits over its board, at most as wide as
  // the board (only the name when that is narrow), and a heading over its row's labels only where
  // it clears the row above.
  const rowBottom = new Map<number, number>();
  for (const it of layout.items)
    rowBottom.set(it.row, Math.max(rowBottom.get(it.row) ?? 0, it.y + it.h));
  const place = (t: Transform) => {
    for (const it of layout.items) {
      const label = labels.get(it.id);
      if (!label) continue;
      const r = screenRect(it, t);
      label.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y - LABEL_PX)}px)`;
      label.style.maxWidth = `${Math.max(Math.round(r.w), 72)}px`;
      label.toggleAttribute("data-narrow", r.w < NARROW_LABEL_PX);
    }
    for (const h of headings) {
      const first = layout.items.find((it) => it.row === h.row);
      if (!first) continue;
      const r = screenRect(first, t);
      const y = r.y - LABEL_PX - HEADING_PX;
      const above = rowBottom.get(h.row - 1);
      const clear = above === undefined || t.y + above * t.scale <= y;
      h.el.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(y)}px)`;
      h.el.hidden = !clear;
    }
  };

  view = new Viewport(win, canvas, world, schedule, (t) => {
    place(t);
    frames.show(visibleBoards(layout.items, t, view.size()));
    const pct = String(Math.round(t.scale * 100));
    bar.zoom.textContent = `${pct}%`;
    html.setAttribute("data-zoom", pct);
  });

  root.replaceChildren(canvas, bar.el, done, announcer);
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
        t.closest(
          ".plinth-design__toolbar, .plinth-design__label, .plinth-design__done, .plinth-design__frame",
        ) !== null,
      backgroundClick: (t) => {
        if (list.isOpen()) list.close();
        // A click outside the board being interacted with puts its cover back.
        if (interacting && !t.closest(`[data-board="${interacting}"]`)) setInteract(null);
      },
      coverActivate: (t) => {
        const cover = t.closest(".plinth-design__cover");
        const id = cover instanceof HTMLElement ? cover.dataset.board : undefined;
        if (id) setInteract(id);
      },
      escape: () => {
        if (list.isOpen()) {
          list.close();
          return true;
        }
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
