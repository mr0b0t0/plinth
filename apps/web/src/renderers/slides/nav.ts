// Paging: which slide is shown, and the keys, clicks, swipes and links that move it.
import { SLIDE_LINK_RE } from "./deck.ts";

export type DeckMode = "deck" | "overview" | "presenter";

/**
 * Steps within a slide that next and prev take before the deck moves on (an HTML slide's
 * fragments): each returns true when it took the step. go() never steps.
 */
export interface Stepper {
  next(): boolean;
  prev(): boolean;
}

export class DeckController {
  private n = 1;
  private readonly listeners = new Set<(n: number) => void>();
  private stepper: Stepper | null = null;

  constructor(private total: number) {}

  get count(): number {
    return this.total;
  }

  /**
   * A deck drawn again with another number of slides (on-page editing): the slide shown is kept
   * when it is still there, else the last one, and listeners run when it changes.
   */
  setCount(count: number, current = this.n): void {
    this.total = Math.max(1, Math.trunc(count));
    const next = Math.min(Math.max(1, Math.trunc(current) || 1), this.total);
    if (next === this.n) return;
    this.n = next;
    for (const l of this.listeners) l(next);
  }

  setStepper(s: Stepper | null): void {
    this.stepper = s;
  }

  get current(): number {
    return this.n;
  }

  /** Shows slide `n`, clamped to the deck. Listeners run only when the slide changes. */
  go(n: number): void {
    const next = Math.min(Math.max(1, Math.trunc(n) || 1), this.count);
    if (next === this.n) return;
    this.n = next;
    for (const l of this.listeners) l(next);
  }

  next(): void {
    if (this.stepper?.next()) return;
    this.go(this.n + 1);
  }

  prev(): void {
    if (this.stepper?.prev()) return;
    this.go(this.n - 1);
  }

  onChange(fn: (n: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export interface InputHandlers {
  /** The current view, so Escape and clicks know what to do. */
  mode(): DeckMode;
  setMode(mode: DeckMode): void;
  /** Ask the app to put the frame full screen. */
  fullscreen(): void;
  print(): void;
  /** Any input: the controls show. */
  activity(): void;
  /** The overview stays (review mode, the editor preview): o and Escape do nothing. */
  fixedOverview: boolean;
  /** Columns of the overview grid, so the up and down arrows move a row. */
  columns(): number;
  /**
   * On-page editing: taps and swipes on the slide do not page (they place the caret and select
   * text), and presenter view and full screen wait until editing ends.
   */
  editing?(): boolean;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);
/** A horizontal move at least this long is a swipe. */
const SWIPE_PX = 50;
/** A pointer that moved less than this is a tap or click. */
const TAP_PX = 10;

function isEditable(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(input|textarea|select)$/i.test(e.localName ?? ""));
}

/** Whether a click or tap at this target is meant for something else than paging. */
function interactive(t: EventTarget | null): boolean {
  const e = t as Element | null;
  return !!e?.closest?.("a, button, input, textarea, select, summary, [data-plinth-control]");
}

/** Wires keys, clicks, swipes and #N links to `deck`. Returns a function that unwires them. */
export function bindInput(
  win: Window,
  root: HTMLElement,
  deck: DeckController,
  h: InputHandlers,
): () => void {
  const doc = win.document;
  let digits = "";

  // In the overview the arrows move the selected slide (a row for up and down) and Enter or Space
  // opens it. Moving picks the overview, so the selection shows even where it opened by itself.
  const overviewKey = (e: KeyboardEvent) => {
    const cols = Math.max(1, h.columns());
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -cols,
      ArrowDown: cols,
    };
    const by = moves[e.key];
    if (by !== undefined) {
      h.setMode("overview");
      deck.go(deck.current + by);
      e.preventDefault();
    } else if (e.key === "Home" || e.key === "End") {
      h.setMode("overview");
      deck.go(e.key === "Home" ? 1 : deck.count);
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === " ") {
      h.setMode("deck");
      e.preventDefault();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    h.activity();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      h.print();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Space and Enter on a focused control act on that control, and end any slide number typed
    // before them.
    if (interactive(e.target) && (e.key === " " || e.key === "Enter")) {
      digits = "";
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      digits = (digits + e.key).slice(-4);
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && digits !== "") {
      deck.go(Number(digits));
      digits = "";
      e.preventDefault();
      return;
    }
    digits = "";
    const mode = h.mode();
    if (e.key === "Escape") {
      if (mode !== "deck" && !h.fixedOverview) {
        h.setMode("deck");
        e.preventDefault();
      }
      return;
    }
    if (e.key === "o" || e.key === "O") {
      if (!h.fixedOverview) h.setMode(mode === "overview" ? "deck" : "overview");
      e.preventDefault();
      return;
    }
    if (e.key === "s" || e.key === "S") {
      if (!h.fixedOverview && !h.editing?.())
        h.setMode(mode === "presenter" ? "deck" : "presenter");
      e.preventDefault();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      if (!h.editing?.()) h.fullscreen();
      e.preventDefault();
      return;
    }
    if (mode === "overview") {
      if (h.fixedOverview) return;
      overviewKey(e);
      return;
    }
    if (NEXT_KEYS.has(e.key)) {
      deck.next();
      e.preventDefault();
    } else if (PREV_KEYS.has(e.key)) {
      deck.prev();
      e.preventDefault();
    } else if (e.key === "Home") {
      deck.go(1);
      e.preventDefault();
    } else if (e.key === "End") {
      deck.go(deck.count);
      e.preventDefault();
    }
  };

  // #N links page the deck; in deck view other #fragments stay on the slide.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    const m = SLIDE_LINK_RE.exec(href);
    if (m) {
      e.preventDefault();
      const n = Number(m[1]);
      if (h.mode() === "overview") {
        doc.querySelector(`.plinth-slides__frame[data-n="${Math.trunc(n)}"]`)?.scrollIntoView();
      } else {
        deck.go(n);
      }
    } else if (href.startsWith("#") && h.mode() !== "overview") {
      e.preventDefault();
    }
  };

  // A tap or click on the left or right third pages; a horizontal swipe pages.
  let down: { x: number; y: number; target: EventTarget | null } | null = null;
  const onDown = (e: PointerEvent) => {
    h.activity();
    down = { x: e.clientX, y: e.clientY, target: e.target };
  };
  const onUp = (e: PointerEvent) => {
    const start = down;
    down = null;
    if (!start || h.mode() !== "deck" || h.editing?.()) return;
    if (e.button !== undefined && e.button > 0) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) deck.next();
      else deck.prev();
      return;
    }
    if (Math.abs(dx) > TAP_PX || Math.abs(dy) > TAP_PX) return;
    if (interactive(start.target)) return;
    const selected = win.getSelection?.()?.toString() ?? "";
    if (selected !== "") return;
    const w = win.innerWidth || 1;
    if (e.clientX > (w * 2) / 3) deck.next();
    else if (e.clientX < w / 3) deck.prev();
  };
  const onMove = () => h.activity();

  win.addEventListener("keydown", onKey);
  root.addEventListener("click", onClick);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerup", onUp);
  win.addEventListener("pointermove", onMove);
  return () => {
    win.removeEventListener("keydown", onKey);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointerup", onUp);
    win.removeEventListener("pointermove", onMove);
  };
}
