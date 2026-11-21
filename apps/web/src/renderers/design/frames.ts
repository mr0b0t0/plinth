// The board frames: one iframe per artboard, mounted while the board is on screen, at most
// DESIGN_LIMITS.maxLiveFrames at once (least recently visible out first, unless pinned).
//
// Each mount is a new iframe element: sandboxed with BOARD_IFRAME_SANDBOX (never
// allow-same-origin, so the board's document has an opaque origin), opened at the fixed board
// loader on the artifact's origin. The loader posts `ready`; only a `ready` whose event.source is
// that element's own window is answered, once, with that board's own document, posted with "*"
// (the frame's origin is opaque, so no target origin can name it, and the board's HTML is what the
// framed design may see anyway). Later `ready`s from it, and messages from any other window, are
// ignored. The loader then says `loaded` when the board's document has finished loading.
//
// A fluid board (height="auto") is told so in `render`, and its loader reports its content's
// height with `size` (before `loaded`, then on every change): the board takes it, kept between
// its least height and DESIGN_LIMITS.maxAutoHeight, and remembers it while its frame is away. A
// link with href="#board=<id>" in a board makes its loader post `goto`, which the canvas follows
// only from the board in use. Board scripts share the loader's window and can forge any of these;
// none reaches beyond the canvas's own view.
import {
  BOARD_IFRAME_SANDBOX,
  BOARD_MESSAGE_SOURCE,
  BOARD_PROTOCOL_VERSION,
  DESIGN_LIMITS,
  type DesignBoard,
  isArtboardId,
} from "@plinth/shared";

type BoardMessage =
  | { type: "ready" }
  | { type: "loaded" }
  | { type: "size"; height: number }
  | { type: "goto"; board: string };

/** A message from a board loader, or null. The caller checks which window sent it. */
export function readBoardMessage(data: unknown): BoardMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== BOARD_MESSAGE_SOURCE || m.v !== BOARD_PROTOCOL_VERSION) return null;
  if (m.type === "ready" || m.type === "loaded") return { type: m.type };
  if (m.type === "size") {
    const h = m.height;
    return typeof h === "number" && Number.isFinite(h) && h > 0
      ? { type: "size", height: Math.ceil(h) }
      : null;
  }
  if (m.type === "goto") return isArtboardId(m.board) ? { type: "goto", board: m.board } : null;
  return null;
}

export function renderMessage(html: string, fluid = false) {
  return {
    source: BOARD_MESSAGE_SOURCE,
    v: BOARD_PROTOCOL_VERSION,
    type: "render",
    html,
    ...(fluid ? { fluid: true } : {}),
  };
}

/** A fluid board's height for a measured content height: never under its least, never over the cap. */
export function fluidHeight(board: Pick<DesignBoard, "height">, measured: number): number {
  return Math.min(DESIGN_LIMITS.maxAutoHeight, Math.max(board.height, Math.ceil(measured)));
}

interface Slot {
  board: DesignBoard;
  el: HTMLElement;
  frame: HTMLIFrameElement | null;
  rendered: boolean;
  loaded: boolean;
  /** Tick of the last update that saw it on screen. */
  seen: number;
}

export interface BoardFramesOptions {
  win: Window;
  loaderUrl: string;
  /** The whole document a board renders (boardDocument with the shared section and base). */
  documentFor: (board: DesignBoard) => string;
  /** After any board's frame mounts, unmounts or finishes loading. */
  onChange?: () => void;
  /** A fluid board's height changed (already clamped by fluidHeight). */
  onResize?: (id: string, height: number) => void;
  /** A link in board `from` asked for board `to` (a prototype flow). */
  onGoto?: (from: string, to: string) => void;
  /** Most frames alive at once outside print. */
  maxLive?: number;
  /** Test seam: makes the (empty) iframe element each mount uses. */
  createFrame?: (doc: Document) => HTMLIFrameElement;
}

export class BoardFrames {
  private readonly slots = new Map<string, Slot>();
  private readonly pinned = new Set<string>();
  private tick = 0;
  private all = false;
  /** Fluid boards' measured heights, kept while their frames are away. */
  private readonly heights = new Map<string, number>();
  private readonly onMessage: (e: MessageEvent) => void;

  constructor(private readonly o: BoardFramesOptions) {
    this.onMessage = (e) => this.message(e);
    o.win.addEventListener("message", this.onMessage as EventListener);
  }

  /** Register a board and the element its frame goes into (before its cover). */
  add(board: DesignBoard, el: HTMLElement): void {
    this.slots.set(board.id, { board, el, frame: null, rendered: false, loaded: false, seen: 0 });
  }

  get maxLive(): number {
    return this.o.maxLive ?? DESIGN_LIMITS.maxLiveFrames;
  }

  /** Keep a board's frame alive whatever is on screen (the board being interacted with). */
  pin(id: string | null): void {
    this.pinned.clear();
    if (id) {
      this.pinned.add(id);
      const s = this.slots.get(id);
      if (s && !s.frame) this.mount(s);
    }
  }

  /**
   * Mount the boards now on screen (nearest the centre first) up to the limit, and unmount the
   * least recently seen others when the limit is passed.
   */
  show(visible: readonly string[]): void {
    if (this.all) return;
    this.tick++;
    const want = new Set<string>(this.pinned);
    for (const id of visible) {
      if (want.size >= this.maxLive) break;
      want.add(id);
    }
    for (const id of want) {
      const s = this.slots.get(id);
      if (s) s.seen = this.tick;
    }
    const live = [...this.slots.values()].filter((s) => s.frame);
    let count = live.length + [...want].filter((id) => !this.slots.get(id)?.frame).length;
    if (count > this.maxLive) {
      const out = live.filter((s) => !want.has(s.board.id)).sort((a, b) => a.seen - b.seen);
      for (const s of out) {
        if (count <= this.maxLive) break;
        this.unmount(s);
        count--;
      }
    }
    for (const id of want) {
      const s = this.slots.get(id);
      if (s && !s.frame) this.mount(s);
    }
    this.o.onChange?.();
  }

  /** Print: every board mounted, whatever the limit, until `release`. */
  mountAll(): void {
    this.all = true;
    for (const s of this.slots.values()) if (!s.frame) this.mount(s);
    this.o.onChange?.();
  }

  release(): void {
    this.all = false;
  }

  /** A board's height now: a fluid board's measured one, else its own. */
  heightOf(board: DesignBoard): number {
    return board.autoHeight ? (this.heights.get(board.id) ?? board.height) : board.height;
  }

  frameOf(id: string): HTMLIFrameElement | null {
    return this.slots.get(id)?.frame ?? null;
  }

  liveCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.frame) n++;
    return n;
  }

  loadedCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.loaded) n++;
    return n;
  }

  /** Resolves once every board has loaded, or after `timeoutMs`. */
  whenAllLoaded(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearInterval(poll);
        clearTimeout(cap);
        resolve();
      };
      const poll = setInterval(() => {
        if (this.loadedCount() >= this.slots.size) done();
      }, 50);
      const cap = setTimeout(done, timeoutMs);
      if (this.loadedCount() >= this.slots.size) done();
    });
  }

  destroy(): void {
    this.o.win.removeEventListener("message", this.onMessage as EventListener);
    for (const s of this.slots.values()) this.unmount(s);
  }

  private mount(s: Slot): void {
    const doc = s.el.ownerDocument;
    const f = this.o.createFrame ? this.o.createFrame(doc) : doc.createElement("iframe");
    f.className = "plinth-design__frame";
    f.setAttribute("sandbox", BOARD_IFRAME_SANDBOX);
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("scrolling", "no");
    f.setAttribute("allow", "");
    f.setAttribute("width", String(s.board.width));
    f.setAttribute("height", String(this.heightOf(s.board)));
    f.title = s.board.name;
    f.tabIndex = -1;
    s.frame = f;
    s.rendered = false;
    s.loaded = false;
    f.src = this.o.loaderUrl;
    s.el.prepend(f);
    s.el.setAttribute("data-live", "");
    s.el.removeAttribute("data-loaded");
  }

  private unmount(s: Slot): void {
    s.frame?.remove();
    s.frame = null;
    s.rendered = false;
    s.loaded = false;
    s.el.removeAttribute("data-live");
    s.el.removeAttribute("data-loaded");
  }

  private message(e: MessageEvent): void {
    if (!e.source) return;
    let slot: Slot | null = null;
    for (const s of this.slots.values()) {
      if (s.frame && s.frame.contentWindow === e.source) {
        slot = s;
        break;
      }
    }
    if (!slot?.frame) return;
    const m = readBoardMessage(e.data);
    if (!m) return;
    if (m.type === "ready") {
      if (slot.rendered) return;
      slot.rendered = true;
      const html = this.o.documentFor(slot.board);
      slot.frame.contentWindow?.postMessage(renderMessage(html, slot.board.autoHeight), "*");
      return;
    }
    if (!slot.rendered) return;
    if (m.type === "size") {
      if (!slot.board.autoHeight) return;
      const h = fluidHeight(slot.board, m.height);
      if (h === this.heightOf(slot.board)) return;
      this.heights.set(slot.board.id, h);
      slot.frame.setAttribute("height", String(h));
      this.o.onResize?.(slot.board.id, h);
      return;
    }
    if (m.type === "goto") {
      this.o.onGoto?.(slot.board.id, m.board);
      return;
    }
    if (m.type === "loaded" && !slot.loaded) {
      slot.loaded = true;
      slot.el.setAttribute("data-loaded", "");
      this.o.onChange?.();
    }
  }
}
