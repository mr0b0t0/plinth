// Presenter view, inside the deck's own frame: the current slide, the next one, the speaker notes,
// an elapsed timer with pause and reset, the wall clock, "Slide 3 of 20", and a warning when the
// current slide does not fit. Everything here is made with createElement and textContent; the
// slides and notes it shows are copies of what deck.ts already sanitized.
import { dropIds, type SlideView } from "./deck.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { fitScale, setScale } from "./stage.ts";

export interface PresenterClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
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
  private readonly warning: HTMLElement;
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
      clock?: PresenterClock;
      measure?: Measure;
      /** More controls for the bar, before Exit (a presenter's Lead viewers toggle). */
      bar?: readonly HTMLElement[];
    },
  ) {
    const clock = this.clock;
    this.startedAt = clock.now();
    this.el = el(doc, "div", "plinth-slides__presenter");
    this.el.setAttribute("role", "region");
    this.el.setAttribute("aria-label", "Presenter view");
    this.el.dataset.plinthControl = "";

    this.current = el(doc, "div", "plinth-slides__pane plinth-slides__pane--current");
    const side = el(doc, "div", "plinth-slides__side");
    const nextLabel = el(doc, "p", "plinth-slides__caption", "Next");
    this.next = el(doc, "div", "plinth-slides__pane plinth-slides__pane--next");
    this.next.setAttribute("inert", "");
    this.next.setAttribute("aria-hidden", "true");
    const notesLabel = el(doc, "p", "plinth-slides__caption", "Notes");
    this.notes = el(doc, "div", "plinth-slides__notes");
    side.append(nextLabel, this.next, notesLabel, this.notes);

    const bar = el(doc, "div", "plinth-slides__pbar");
    this.counter = el(doc, "span", "plinth-slides__count");
    this.timer = el(doc, "span", "plinth-slides__timer", "0:00");
    this.timer.setAttribute("role", "timer");
    this.timer.setAttribute("aria-label", "Elapsed time");
    this.pauseBtn = el(doc, "button", "plinth-slides__btn", "Pause");
    this.pauseBtn.type = "button";
    this.pauseBtn.addEventListener("click", () => this.togglePause());
    const reset = el(doc, "button", "plinth-slides__btn", "Reset");
    reset.type = "button";
    reset.addEventListener("click", () => this.reset());
    this.clockEl = el(doc, "span", "plinth-slides__clock");
    this.warning = el(doc, "span", "plinth-slides__warning", "This slide overflows");
    this.warning.hidden = true;
    const exit = el(doc, "button", "plinth-slides__btn", "Exit presenter view");
    exit.type = "button";
    exit.addEventListener("click", () => this.o.exit());
    bar.append(
      this.timer,
      this.pauseBtn,
      reset,
      this.clockEl,
      this.counter,
      this.warning,
      ...(this.o.bar ?? []),
      exit,
    );

    this.el.append(this.current, side, bar);
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
      this.pauseBtn.textContent = "Resume";
    } else {
      this.startedAt += now - this.pausedAt;
      this.pausedAt = null;
      this.pauseBtn.textContent = "Pause";
    }
    this.tick();
  }

  reset(): void {
    this.startedAt = this.clock.now();
    if (this.pausedAt !== null) this.pausedAt = this.startedAt;
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
    this.current.replaceChildren();
    this.next.replaceChildren();
    if (view) {
      const copy = copyOf(view);
      this.current.append(copy);
      const slide = copy.querySelector<HTMLElement>(".plinth-slides__slide");
      const body = copy.querySelector<HTMLElement>(".plinth-slides__body");
      if (slide && body) fitSlide(slide, body, measure);
      this.warning.hidden = slide?.getAttribute("data-overflow") !== "true";
    }
    if (following) {
      const copy = copyOf(following);
      this.next.append(copy);
      const slide = copy.querySelector<HTMLElement>(".plinth-slides__slide");
      const body = copy.querySelector<HTMLElement>(".plinth-slides__body");
      if (slide && body) fitSlide(slide, body, measure);
    } else {
      this.next.append(el(this.doc, "p", "plinth-slides__end", "End of deck"));
    }
    if (view && view.notes.childNodes.length > 0) {
      this.notes.replaceChildren(view.notes.cloneNode(true));
    } else {
      this.notes.replaceChildren(
        el(this.doc, "p", "plinth-slides__empty", "No notes for this slide."),
      );
    }
    this.counter.textContent = `Slide ${n} of ${this.views.length}`;
    this.tick();
    this.layout();
  }

  /** Scales the two slide panes to the space they have. */
  layout(): void {
    for (const pane of [this.current, this.next]) {
      const r = pane.getBoundingClientRect();
      setScale(
        pane,
        this.canvas,
        fitScale(r.width, r.height, this.canvas.width, this.canvas.height),
      );
    }
  }

  get slide(): number {
    return this.n;
  }
}
