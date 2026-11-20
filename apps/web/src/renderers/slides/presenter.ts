// Presenter view, inside the deck's own frame. At desktop width it has two columns: on the left the
// current slide, as large as fits, with the bar directly under it (the elapsed timer with pause,
// previous and next with "3 / 20" between them, the clock and Exit); on the right the next slide,
// its top level with the current slide's, and the speaker notes down to the bar's bottom edge. The
// "Next" caption sits in a row above both columns, which are centred in the frame's height
// together, so neither column ends in bare stage while the other runs on. On a narrow or portrait
// frame the same parts stack in one column: current, bar, next, notes. Touch screens have no keys
// and presenter view takes no swipes, so its bar pages. A slide that does not fit is marked on the
// current pane. Everything here is made with createElement and textContent; the slides and notes
// it shows are copies of what deck.ts already sanitized.
import { dropIds, type SlideView } from "./deck.ts";
import { el } from "./dom.ts";
import { iconButton, setIcon } from "./icons.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { GUTTER, setScale } from "./stage.ts";

export interface PresenterClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
  /** The wall clock at `at`, as the bar shows it. */
  time(at: number): string;
}

export const systemClock: PresenterClock = {
  now: () => Date.now(),
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  time: (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
};

/** "4:05" or "1:02:09". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Between the two columns, in CSS pixels (slides.css uses the same). */
export const PRESENTER_COLUMN_GAP = 24;
/** Between a slide and the bar under it, and between the stacked parts (slides.css). */
export const PRESENTER_ROW_GAP = 12;
/** The bar's height (slides.css min-height). */
export const PRESENTER_BAR = 40;
/** The row above the two columns that holds the "Next" caption (slides.css). */
export const PRESENTER_CAPTION = 24;
/** The current slide's column takes at most this share of the width; Next and Notes get the rest. */
export const CURRENT_MAX_SHARE = 0.72;
/** In two columns the next slide takes at most this share of the height. */
const NEXT_MAX_SHARE = 0.4;

/** One column below 600 px wide or in portrait, as the deck's own overview rule. */
export function presenterNarrow(w: number, h: number): boolean {
  return w < 600 || h > w;
}

export interface PresenterLayout {
  narrow: boolean;
  /** Scales of the current and the next slide. */
  current: number;
  next: number;
  /** The left column's width in two columns (the current slide's width), or null in one. */
  column: number | null;
  /** The columns' height in two columns (the current slide and the bar under it), or null. */
  row: number | null;
}

/** Sizes presenter view for a w x h frame: everything fits its height in two columns. */
export function presenterLayout(
  w: number,
  h: number,
  canvas: { width: number; height: number },
): PresenterLayout {
  const innerW = Math.max(1, w - 2 * GUTTER);
  const innerH = Math.max(1, h - 2 * GUTTER);
  if (presenterNarrow(w, h)) {
    // Each slide as wide as the frame, unless that would leave the notes no room.
    const s = Math.min(innerW / canvas.width, (innerH * 0.45) / canvas.height);
    return { narrow: true, current: s, next: s, column: null, row: null };
  }
  const widest = CURRENT_MAX_SHARE * (innerW - PRESENTER_COLUMN_GAP);
  const room = innerH - PRESENTER_CAPTION - PRESENTER_BAR - PRESENTER_ROW_GAP;
  const tallest = (room * canvas.width) / canvas.height;
  const column = Math.max(1, Math.floor(Math.min(widest, tallest)));
  const side = innerW - PRESENTER_COLUMN_GAP - column;
  const row =
    Math.ceil((column * canvas.height) / canvas.width) + PRESENTER_ROW_GAP + PRESENTER_BAR;
  return {
    narrow: false,
    current: column / canvas.width,
    next: Math.max(0.05, Math.min(side / canvas.width, (row * NEXT_MAX_SHARE) / canvas.height)),
    column,
    row,
  };
}

/** A copy of a slide's frame for a pane: no ids, out of the tab order and the reading order. */
function copyOf(view: SlideView): HTMLElement {
  const copy = view.frame.cloneNode(true) as HTMLElement;
  dropIds(copy);
  copy.setAttribute("data-active", "");
  copy.removeAttribute("data-n");
  return copy;
}

export class Presenter {
  readonly el: HTMLElement;
  private readonly current: HTMLElement;
  private readonly next: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private startedAt: number;
  private pausedAt: number | null = null;
  private stopTick: (() => void) | null = null;
  private n = 1;

  constructor(
    private readonly doc: Document,
    private readonly views: SlideView[],
    private readonly canvas: { width: number; height: number },
    private readonly o: {
      exit: () => void;
      prev: () => void;
      next: () => void;
      /** The frame's size, which presenter view fills. */
      viewport: () => { w: number; h: number };
      clock?: PresenterClock;
      measure?: Measure;
    },
  ) {
    const clock = this.clock;
    this.startedAt = clock.now();
    this.el = el(doc, "div", "plinth-slides__presenter");
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Presenter view");
    this.el.dataset.plinthControl = "";

    // The current slide with the bar directly under it.
    const main = el(doc, "div", "plinth-slides__main");
    this.current = el(doc, "div", "plinth-slides__pane plinth-slides__pane--current");
    const bar = el(doc, "div", "plinth-slides__pbar");
    const timing = el(doc, "div", "plinth-slides__group");
    this.timer = el(doc, "span", "plinth-slides__timer", "0:00");
    this.timer.setAttribute("role", "timer");
    this.timer.setAttribute("aria-label", "Elapsed time");
    this.pauseBtn = iconButton(doc, "pause", "Pause timer", () => this.togglePause());
    timing.append(this.timer, this.pauseBtn);
    const paging = el(doc, "div", "plinth-slides__group plinth-slides__group--paging");
    this.counter = el(doc, "span", "plinth-slides__count");
    paging.append(
      iconButton(doc, "caret-left", "Previous slide", () => this.o.prev()),
      this.counter,
      iconButton(doc, "caret-right", "Next slide", () => this.o.next()),
    );
    const end = el(doc, "div", "plinth-slides__group plinth-slides__group--end");
    this.clockEl = el(doc, "span", "plinth-slides__clock");
    end.append(
      this.clockEl,
      iconButton(doc, "x", "Exit presenter view", () => this.o.exit()),
    );
    bar.append(timing, paging, end);
    main.append(this.current, bar);

    // Next at the top, level with the current slide (its caption in the row above), the notes
    // filling the rest. In one column the caption comes between the bar and the next slide.
    const side = el(doc, "div", "plinth-slides__side");
    const nextLabel = el(doc, "p", "plinth-slides__caption plinth-slides__caption--next", "Next");
    this.next = el(doc, "div", "plinth-slides__pane plinth-slides__pane--next");
    this.next.setAttribute("inert", "");
    this.next.setAttribute("aria-hidden", "true");
    const notesLabel = el(
      doc,
      "p",
      "plinth-slides__caption plinth-slides__caption--notes",
      "Notes",
    );
    this.notes = el(doc, "div", "plinth-slides__notes");
    side.append(this.next, notesLabel, this.notes);

    this.el.append(main, nextLabel, side);
  }

  private get clock(): PresenterClock {
    return this.o.clock ?? systemClock;
  }

  /** Starts the timer's display and shows slide `n`. */
  open(n: number): void {
    this.stopTick?.();
    this.stopTick = this.clock.every(1000, () => this.tick());
    this.show(n);
  }

  close(): void {
    this.stopTick?.();
    this.stopTick = null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  elapsed(): number {
    return (this.pausedAt ?? this.clock.now()) - this.startedAt;
  }

  togglePause(): void {
    const now = this.clock.now();
    if (this.pausedAt === null) {
      this.pausedAt = now;
      setIcon(this.pauseBtn, "play", "Resume timer");
    } else {
      this.startedAt += now - this.pausedAt;
      this.pausedAt = null;
      setIcon(this.pauseBtn, "pause", "Pause timer");
    }
    this.tick();
  }

  tick(): void {
    this.timer.textContent = formatElapsed(this.elapsed());
    this.clockEl.textContent = this.clock.time(this.clock.now());
  }

  /** Shows slide `n` as current, the one after it as next, and its notes. */
  show(n: number): void {
    this.n = n;
    const view = this.views[n - 1];
    const following = this.views[n];
    const measure = this.o.measure ?? overflows;
    /** Puts a fitted copy of `v` in `pane`; false when there is no such slide. */
    const place = (pane: HTMLElement, v: SlideView | undefined): boolean => {
      pane.replaceChildren();
      if (!v) return false;
      const copy = copyOf(v);
      pane.append(copy);
      const slide = copy.querySelector<HTMLElement>(".plinth-slides__slide");
      const body = copy.querySelector<HTMLElement>(".plinth-slides__body");
      if (slide && body) fitSlide(slide, body, measure);
      return true;
    };
    place(this.current, view);
    if (!place(this.next, following)) {
      this.next.append(el(this.doc, "p", "plinth-slides__end", "End of deck"));
    }
    // A slide without notes leaves the notes pane empty.
    this.notes.replaceChildren(...(view ? [view.notes.cloneNode(true)] : []));
    this.counter.textContent = `${n} / ${this.views.length}`;
    this.tick();
    this.layout();
  }

  /** Sizes the columns and scales the two slides to the frame (presenterLayout). */
  layout(): void {
    const { w, h } = this.o.viewport();
    const l = presenterLayout(w, h, this.canvas);
    this.el.toggleAttribute("data-narrow", l.narrow);
    if (l.column === null) this.el.style.removeProperty("--pcol");
    else this.el.style.setProperty("--pcol", `${l.column}px`);
    if (l.row === null) this.el.style.removeProperty("--prow");
    else this.el.style.setProperty("--prow", `${l.row}px`);
    setScale(this.current, this.canvas, l.current);
    setScale(this.next, this.canvas, l.next);
  }

  get slide(): number {
    return this.n;
  }
}
