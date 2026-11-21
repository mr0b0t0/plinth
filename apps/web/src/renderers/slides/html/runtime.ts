// An HTML deck in the slides renderer: its slides (build.ts), the deck's faces, and what changes as
// the deck is shown. boot.ts keeps paging, the views, presenter view, print and the .pptx for
// both formats, and asks this for what an HTML deck does differently:
//
// - Fragments: a click shows the current slide's next step before the deck moves on; going back
//   shows the slide before it whole, as reveal.js does. Every slide shows whole in the overview,
//   in print, in the .pptx, in a still, in an audience window and while following a presenter,
//   whose steps never cross the room or the app (only slide numbers do).
// - Motion: a slide's CSS animations play when it arrives in the deck view and in presenter
//   view's current pane, and are off (the plain rule, the finished look) everywhere else, under
//   reduced motion, in print and in a still such as a thumbnail. Transitions play only between
//   slides of the deck view.
// - Embeds run only on stage (embeds.ts), connectors are drawn once a slide is laid out
//   (connectors.ts), and a slide whose content runs past its canvas is marked as a Markdown
//   slide that does not fit is.
import type { HtmlDeck } from "@plinth/shared";
import type { SlideView } from "../deck.ts";
import type { Geometry } from "../exportModel.ts";
import type { DeckMode } from "../nav.ts";
import type { DeckModel } from "../pptxModel.ts";
import {
  buildHtmlSlide,
  type HtmlDeckContext,
  type HtmlParts,
  htmlDeckContext,
  setStill,
  showSteps,
  slideImages,
} from "./build.ts";
import { drawConnectors } from "./connectors.ts";
import { EmbedFrames, embedLoaderUrl } from "./embeds.ts";
import { buildHtmlExportModel } from "./export.ts";
import { playTransition, type Running } from "./transitions.ts";

const FACES_ID = "__plinth-slides-faces";

/**
 * Whether a slide's flow runs past its canvas, where it is cut. A pinned box past the edge (a
 * full-bleed picture, a card that bleeds off on purpose) is the author's choice, never marked.
 */
export function flowOverflows(section: HTMLElement): boolean {
  const win = section.ownerDocument.defaultView;
  if (!win) return false;
  for (const child of Array.from(section.children) as HTMLElement[]) {
    const pos = win.getComputedStyle(child).position;
    if (pos === "absolute" || pos === "fixed") continue;
    if (child.offsetTop + child.offsetHeight > section.clientHeight + 1) return true;
    if (child.offsetLeft + child.offsetWidth > section.clientWidth + 1) return true;
  }
  return false;
}

/** The deck's faces: its Google Fonts links, and its own font files as @font-face rules. */
export function loadFaces(
  doc: Document,
  deck: Pick<HtmlDeck, "faces">,
  properties: string[],
): void {
  doc.getElementById(FACES_ID)?.remove();
  const style = doc.createElement("style");
  style.id = FACES_ID;
  const rules: string[] = [...properties];
  for (const f of deck.faces) {
    if (f.href) {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = f.href;
      link.dataset.plinthFace = f.key;
      doc.head.append(link);
    } else if (f.src) {
      // The family and the path passed the deck parser's rules: letters, digits, spaces, _ and -,
      // and a plain relative path, so neither can end the string or the rule.
      const format = /\.woff2$/i.test(f.src)
        ? "woff2"
        : /\.woff$/i.test(f.src)
          ? "woff"
          : /\.otf$/i.test(f.src)
            ? "opentype"
            : "truetype";
      rules.push(
        `@font-face { font-family: "${f.family}"; src: url("${f.src}") format("${format}"); font-display: swap; }`,
      );
    }
  }
  style.textContent = rules.join("\n");
  doc.head.append(style);
}

export interface HtmlState {
  mode: DeckMode;
  current: number;
  /** Every fragment shows: the overview, an audience window, a follower, review mode. */
  allBuilt: boolean;
}

export class HtmlDeckRuntime {
  readonly views: SlideView[] = [];
  private readonly parts = new Map<SlideView, HtmlParts>();
  private readonly ctx: HtmlDeckContext;
  private readonly embeds: EmbedFrames;
  private readonly drawn = new WeakSet<HTMLElement>();
  /** Steps shown on the current slide. */
  step = 0;
  private running: Running | null = null;
  /** The presenter's current pane, which mirrors the steps. */
  private paneCurrent: HtmlParts | null = null;
  private paneEmbeds: HtmlParts[] = [];

  constructor(
    private readonly win: Window,
    readonly deck: HtmlDeck,
    private readonly o: {
      /** No motion anywhere: reduced motion, or a still (a thumbnail capture). */
      motionOff: boolean;
      /** No embeds: a still. */
      noEmbeds: boolean;
    },
  ) {
    const doc = win.document;
    const { ctx, properties } = htmlDeckContext(doc, deck);
    this.ctx = ctx;
    loadFaces(doc, deck, properties);
    ctx.shown.forEach((slide, i) => {
      const { view, parts } = buildHtmlSlide(ctx, slide, i + 1);
      this.views.push(view);
      this.parts.set(view, parts);
    });
    this.embeds = new EmbedFrames(win, embedLoaderUrl(win.location));
    // Web fonts change what fits: draw again and mark again once they are in.
    void doc.fonts?.ready.then(() => {
      for (const v of this.views) if (this.drawn.has(v.el)) this.layout(v);
    });
  }

  stepsOf(n: number): number {
    const v = this.views[n - 1];
    return v ? (this.parts.get(v)?.steps.length ?? 0) : 0;
  }

  /** The next step of the current slide, if it has one left; false: the deck moves on. */
  stepNext(n: number): boolean {
    if (this.step >= this.stepsOf(n)) return false;
    this.step++;
    return true;
  }

  stepPrev(): boolean {
    if (this.step <= 0) return false;
    this.step--;
    return true;
  }

  /** The deck moved from slide `from` to `to`: the steps to show there, and its transition. */
  arrive(from: number, to: number, mode: DeckMode, scale: number): void {
    this.running?.finish();
    this.running = null;
    this.step = to < from ? this.stepsOf(to) : 0;
    if (mode !== "deck" || this.o.motionOff || from === to) return;
    const leaving = this.views[from - 1];
    const arriving = this.views[to - 1];
    const kind = leaving ? this.parts.get(leaving)?.slide.transition : null;
    if (leaving && arriving && kind) {
      this.running = playTransition(kind, leaving, arriving, to > from, scale);
    }
  }

  /** Connectors and the overflow mark, for a slide that is laid out. */
  layout(v: SlideView): void {
    const p = this.parts.get(v);
    if (!p) return;
    drawConnectors(p.section, this.win);
    this.drawn.add(v.el);
    v.el.toggleAttribute("data-overflow", flowOverflows(p.section));
  }

  /**
   * Once the slides are in the document: every connector drawn (those with px coordinates need no
   * layout, so a slide printed or captured without ever showing has them), and a still made still.
   */
  mounted(): void {
    for (const v of this.views) {
      const p = this.parts.get(v);
      if (p) drawConnectors(p.section, this.win);
    }
    if (this.o.noEmbeds) this.still();
  }

  /** Brings every slide to what `s` shows: motion, steps, embeds; then lays out the visible ones. */
  sync(s: HtmlState): void {
    for (const v of this.views) {
      const p = this.parts.get(v);
      if (!p) continue;
      const onStage = s.mode === "deck" && v.n === s.current;
      setStill(v.el, this.o.motionOff || !onStage);
      const k =
        s.allBuilt || s.mode === "overview" ? Number.POSITIVE_INFINITY : onStage ? this.step : 0;
      showSteps(p.steps, k);
      this.embeds.set(p.embeds, onStage && !this.o.noEmbeds);
      if (s.mode === "overview" || onStage) this.layout(v);
    }
    if (this.paneCurrent)
      showSteps(this.paneCurrent.steps, s.allBuilt ? Number.POSITIVE_INFINITY : this.step);
  }

  /** Every slide whole and still, laid out: before print and the .pptx measure. */
  still(): void {
    this.running?.finish();
    this.running = null;
    for (const v of this.views) {
      const p = this.parts.get(v);
      if (!p) continue;
      setStill(v.el, true);
      showSteps(p.steps, Number.POSITIVE_INFINITY);
      this.embeds.set(p.embeds, false);
      this.layout(v);
    }
  }

  /** A fresh copy of a slide for presenter view: the current pane moves, the next one is still. */
  copy(v: SlideView, pane: "current" | "next", allBuilt: boolean): HTMLElement {
    const p = this.parts.get(v);
    if (!p) return v.frame.cloneNode(true) as HTMLElement;
    const { view, parts } = buildHtmlSlide(this.ctx, p.slide, v.n);
    const frame = view.frame;
    frame.setAttribute("data-active", "");
    frame.removeAttribute("data-n");
    const live = pane === "current" && !this.o.motionOff;
    setStill(view.el, !live);
    showSteps(parts.steps, pane === "next" || allBuilt ? Number.POSITIVE_INFINITY : this.step);
    if (pane === "current") {
      for (const old of this.paneEmbeds) this.embeds.set(old.embeds, false);
      this.paneCurrent = parts;
      this.paneEmbeds = [parts];
    } else {
      frame.setAttribute("inert", "");
    }
    // Embeds and connectors need the copy in the document: presenter view appends it right away.
    queueMicrotask(() => {
      if (!frame.isConnected) return;
      drawConnectors(parts.section, this.win);
      if (pane === "current" && !this.o.noEmbeds) this.embeds.set(parts.embeds, true);
    });
    return frame;
  }

  /** Presenter view closed: its panes' embeds stop. */
  closePanes(): void {
    for (const p of this.paneEmbeds) this.embeds.set(p.embeds, false);
    this.paneEmbeds = [];
    this.paneCurrent = null;
  }

  images(v: SlideView): HTMLImageElement[] {
    return slideImages(v.el);
  }

  exportModel(title: string, geometry: Geometry): { model: DeckModel; embedsSkipped: number } {
    return buildHtmlExportModel(this.views, this.deck, { title, geometry });
  }

  stop(): void {
    this.running?.finish();
    this.embeds.stop();
  }
}
