// Presenter view, inside the deck's own frame: the current slide, the next one and the speaker
// notes, over one bar: the elapsed timer (it starts again each time presenter view opens),
// previous and next with "3 / 20" between them (touch screens have no keys, and presenter view
// takes no swipes), and Exit. A slide that does not fit is marked on the
// current pane. Everything here is made with createElement and textContent; the slides and notes
// it shows are copies of what deck.ts already sanitized.
import { dropIds, type SlideView } from "./deck.ts";
import { iconButton } from "./icons.ts";
import { fitSlide, type Measure, overflows } from "./layout.ts";
import { fitScale, setScale } from "./stage.ts";

export interface PresenterClock {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}

export const systemClock: PresenterClock = {
  now: () => Date.now(),
  every(ms, fn) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
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
  private readonly timer: HTMLElement;
  private readonly startedAt: number;
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

    this.current = el(doc, "div", "plinth-slides__pane plinth-slides__pane--current");
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
    side.append(nextLabel, this.next, notesLabel, this.notes);

    // The timer on the left, paging in the middle, Exit on the right.
    const bar = el(doc, "div", "plinth-slides__pbar");
    const timing = el(doc, "div", "plinth-slides__group");
    this.timer = el(doc, "span", "plinth-slides__timer", "0:00");
    this.timer.setAttribute("role", "timer");
    this.timer.setAttribute("aria-label", "Elapsed time");
    timing.append(this.timer);
    const paging = el(doc, "div", "plinth-slides__group plinth-slides__group--paging");
    this.counter = el(doc, "span", "plinth-slides__count");
    paging.append(
      iconButton(doc, "caret-left", "Previous slide", () => this.o.prev()),
      this.counter,
      iconButton(doc, "caret-right", "Next slide", () => this.o.next()),
    );
    const end = el(doc, "div", "plinth-slides__group plinth-slides__group--end");
    end.append(iconButton(doc, "x", "Exit presenter view", () => this.o.exit()));
    bar.append(timing, paging, end);

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

  elapsed(): number {
    return this.clock.now() - this.startedAt;
  }

  tick(): void {
    this.timer.textContent = formatElapsed(this.elapsed());
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
    // A slide without notes leaves the notes pane empty.
    this.notes.replaceChildren(...(view ? [view.notes.cloneNode(true)] : []));
    this.counter.textContent = `${n} / ${this.views.length}`;
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
