// The canvas viewport: one transform (translate, then scale, origin 0 0) on the world element that
// holds every board, and the input that moves it. Wheel pans; Ctrl/Cmd+wheel and a trackpad pinch
// (a wheel event with ctrlKey) zoom at the pointer; dragging pans (mouse, pen or one finger); two
// fingers pinch; keys work while the canvas has focus: + and = zoom in, - zooms out, 0 fits, 1 is
// 100%, the arrows pan (Shift for more).
//
// After each change, on the next frame, it dispatches a `scroll` event on the window, so the
// comments bridge in review mode re-reports where its pins are.
import { clampZoom, type Size, type Transform, zoomAt } from "./layout.ts";

/** One zoom step (buttons and keys). */
export const ZOOM_STEP = 1.25;
/** Pixels an arrow key pans, and with Shift. */
const PAN_STEP = 60;
const PAN_STEP_BIG = 300;
/** A pointer that moved less than this between down and up is a click, not a drag. */
export const CLICK_SLOP = 5;

export type Schedule = (fn: () => void) => void;

export class Viewport {
  t: Transform = { x: 0, y: 0, scale: 1 };
  private pending = false;

  constructor(
    private readonly win: Window,
    private readonly canvas: HTMLElement,
    private readonly world: HTMLElement,
    private readonly schedule: Schedule,
    private readonly onFrame: (t: Transform) => void,
  ) {}

  size(): Size {
    const w = this.canvas.clientWidth || this.win.innerWidth || 0;
    const h = this.canvas.clientHeight || this.win.innerHeight || 0;
    return { width: w, height: h };
  }

  set(t: Transform): void {
    const scale = clampZoom(t.scale);
    this.t = { x: Number.isFinite(t.x) ? t.x : 0, y: Number.isFinite(t.y) ? t.y : 0, scale };
    // A custom property, so the print layout can drop the transform without !important.
    this.world.style.setProperty(
      "--pd-transform",
      `translate(${this.t.x}px, ${this.t.y}px) scale(${scale})`,
    );
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.onFrame(this.t);
      this.win.dispatchEvent(new Event("scroll"));
    });
  }

  pan(dx: number, dy: number): void {
    this.set({ ...this.t, x: this.t.x + dx, y: this.t.y + dy });
  }

  zoomBy(factor: number, point?: { x: number; y: number }): void {
    const s = this.size();
    this.set(zoomAt(this.t, factor, point ?? { x: s.width / 2, y: s.height / 2 }));
  }

  /** Zoom to an exact scale around the centre. */
  zoomTo(scale: number): void {
    this.zoomBy(clampZoom(scale) / this.t.scale);
  }
}

export interface CanvasInput {
  fit: () => void;
  actual: () => void;
  /** The pointer went down and up without moving on the canvas background. */
  backgroundClick: (target: Element) => void;
  escape: () => boolean;
  /** Whether an element is one of Plinth's controls (no panning from there). */
  isControl: (target: Element) => boolean;
  /** The person moved or zoomed the view (so a resize no longer refits). */
  moved: () => void;
}

function wheelPixels(e: WheelEvent, size: Size): { x: number; y: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1;
  return { x: e.deltaX * k, y: e.deltaY * k };
}

/** Wires the canvas's input. Returns a function that removes every listener. */
export function bindCanvasInput(canvas: HTMLElement, view: Viewport, o: CanvasInput): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; target: Element } | null = null;
  let dragged = false;
  let pinch: { d: number } | null = null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    o.moved();
    const d = wheelPixels(e, view.size());
    if (e.ctrlKey || e.metaKey) {
      // Trackpads send pinches as ctrl+wheel with small deltas; a mouse wheel notch is ~100.
      view.zoomBy(Math.exp(-Math.max(-50, Math.min(50, d.y)) * 0.01), local(e));
    } else {
      view.pan(-d.x, -d.y);
    }
  };

  const onDown = (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (!target || o.isControl(target)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      start = { x: e.clientX, y: e.clientY, target };
      dragged = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b) pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      dragged = true;
    }
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, next);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      if (pinch.d > 0 && d > 0) view.zoomBy(d / pinch.d, mid);
      // The midpoint moves by half of this pointer's move.
      view.pan((next.x - prev.x) / 2, (next.y - prev.y) / 2);
      pinch.d = d;
      o.moved();
      return;
    }
    if (start && !dragged && Math.hypot(next.x - start.x, next.y - start.y) < CLICK_SLOP) return;
    if (!dragged) {
      // Captured only once it is a drag, so a plain click still targets what is under it (the
      // comments bridge picks the board's cover in review mode).
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch {
        // Not every pointer can be captured (synthetic events).
      }
    }
    dragged = true;
    o.moved();
    view.pan(next.x - prev.x, next.y - prev.y);
  };

  const onUp = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    const s = start;
    start = null;
    if (!s || dragged) return;
    o.backgroundClick(s.target);
  };

  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) start = null;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey) return;
    const target = e.target as Element | null;
    if (target && target !== canvas && o.isControl(target)) return;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    switch (e.key) {
      case "+":
      case "=":
        if (mod) return;
        view.zoomBy(ZOOM_STEP);
        break;
      case "-":
      case "_":
        if (mod) return;
        view.zoomBy(1 / ZOOM_STEP);
        break;
      case "0":
        if (mod) return;
        o.fit();
        break;
      case "1":
        if (mod) return;
        o.actual();
        break;
      case "ArrowLeft":
        view.pan(e.shiftKey ? PAN_STEP_BIG : PAN_STEP, 0);
        break;
      case "ArrowRight":
        view.pan(-(e.shiftKey ? PAN_STEP_BIG : PAN_STEP), 0);
        break;
      case "ArrowUp":
        view.pan(0, e.shiftKey ? PAN_STEP_BIG : PAN_STEP);
        break;
      case "ArrowDown":
        view.pan(0, -(e.shiftKey ? PAN_STEP_BIG : PAN_STEP));
        break;
      case "Escape":
        handled = o.escape();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      // Fit (0) keeps refitting on resize, as the Fit button does; Escape moves nothing.
      if (e.key !== "Escape" && e.key !== "0") o.moved();
    }
  };

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("keydown", onKey);
  return () => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("keydown", onKey);
  };
}
