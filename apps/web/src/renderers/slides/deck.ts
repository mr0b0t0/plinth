// Builds a deck's DOM from the parsed source. Every slide part (head, columns) and the notes go
// through the doc's Markdown pipeline unchanged: markdown.ts (html off, URL allowlist) and then
// sanitize.ts (the DOM allowlist). Everything this file adds itself (canvases, footer, number) is
// made with createElement and textContent, never innerHTML, so the sanitizer's class allowlist
// does not need to change.
//
// Heading ids repeat across slides (every deck has several "Summary" slides), so each id in a
// slide is prefixed with s<n>- and the slide's own #id links follow. A #N link (a number) is a link
// to slide N and pages the deck (nav.ts); it is never rewritten.
import {
  type DeckSettings,
  type ParsedDeck,
  SLIDE_ASPECTS,
  type SlideSource,
} from "@plinth/shared";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { el } from "./dom.ts";
import { classifySlide, type SlideLayout } from "./layout.ts";

export interface SlideView {
  n: number;
  /** The wrapper of one slide: its overview label, its scaled canvas and its handout notes. */
  frame: HTMLElement;
  /** The slide canvas (section), at the deck's fixed size. */
  el: HTMLElement;
  /** The box whose overflow decides the fit (layout.ts fitSlide). */
  body: HTMLElement;
  layout: SlideLayout;
  /** The slide's notes, sanitized; cloned wherever they are shown. */
  notes: DocumentFragment;
  /** 1-based source line of the slide. */
  line: number;
}

/** A link to another slide: "#3". */
export const SLIDE_LINK_RE = /^#(\d{1,4})$/;

/** Markdown to a sanitized fragment, with the doc's heading anchors removed (a slide has none). */
export function renderPart(doc: Document, markdown: string): DocumentFragment {
  const frag = sanitizeHtml(renderMarkdown(markdown), doc);
  for (const a of Array.from(frag.querySelectorAll("a.plinth-doc__anchor"))) a.remove();
  return frag;
}

/**
 * Prefixes every id under `root` with `prefix` (unique within the slide) and rewrites the slide's
 * own #id links to match. #N slide links and links to ids the slide does not have stay as written.
 */
export function scopeIds(root: ParentNode, prefix: string): void {
  const renamed = new Map<string, string>();
  const used = new Set<string>();
  for (const node of Array.from(root.querySelectorAll("[id]"))) {
    const id = node.getAttribute("id") ?? "";
    let next = `${prefix}${id}`;
    for (let i = 2; used.has(next); i++) next = `${prefix}${id}-${i}`;
    used.add(next);
    if (!renamed.has(id)) renamed.set(id, next);
    node.setAttribute("id", next);
  }
  for (const a of Array.from(root.querySelectorAll('a[href^="#"]'))) {
    const href = a.getAttribute("href") ?? "";
    if (SLIDE_LINK_RE.test(href)) continue;
    const to = renamed.get(href.slice(1));
    if (to) a.setAttribute("href", `#${to}`);
  }
}

/** Removes every id under `root`: for copies of a slide (presenter view, notes). */
export function dropIds(root: ParentNode): void {
  for (const node of Array.from(root.querySelectorAll("[id]"))) node.removeAttribute("id");
}

function buildSlide(
  doc: Document,
  s: SlideSource,
  count: number,
  settings: DeckSettings,
): SlideView {
  const frame = el(doc, "div", "plinth-slides__frame");
  frame.dataset.n = String(s.n);
  const slide = el(doc, "section", "plinth-slides__slide");
  slide.setAttribute("aria-roledescription", "slide");
  slide.setAttribute("aria-label", `Slide ${s.n} of ${count}`);
  const body = el(doc, "div", "plinth-slides__body");
  const head = el(doc, "div", "plinth-slides__head");
  head.append(renderPart(doc, s.head));
  body.append(head);
  if (s.columns.length > 0) {
    const cols = el(doc, "div", "plinth-slides__columns");
    cols.dataset.count = String(s.columns.length);
    for (const c of s.columns) {
      const col = el(doc, "div", "plinth-slides__column");
      col.append(renderPart(doc, c));
      cols.append(col);
    }
    body.append(cols);
  }
  slide.append(body);
  scopeIds(slide, `s${s.n}-`);
  const layout = classifySlide(head, s.columns.length);
  slide.dataset.layout = layout;
  if (settings.footer) {
    const footer = el(doc, "div", "plinth-slides__footer");
    footer.textContent = settings.footer;
    slide.append(footer);
  }
  if (settings.paginate) {
    const number = el(doc, "div", "plinth-slides__number");
    number.textContent = String(s.n);
    number.setAttribute("aria-hidden", "true");
    slide.append(number);
  }
  const canvas = el(doc, "div", "plinth-slides__canvas");
  canvas.append(slide);
  const notes = renderPart(doc, s.notes);
  dropIds(notes);
  // The handout (print with speaker notes) shows each slide over its notes.
  const handout = el(doc, "div", "plinth-slides__handout");
  handout.append(notes.cloneNode(true));
  frame.append(canvas, handout);
  return { n: s.n, frame, el: slide, body, layout, notes, line: s.line };
}

/** One SlideView per slide, in order. Nothing is attached to the document. */
export function buildDeck(doc: Document, parsed: ParsedDeck): SlideView[] {
  const count = parsed.slides.length;
  return parsed.slides.map((s) => buildSlide(doc, s, count, parsed.settings));
}

/** The canvas size of a deck, in CSS pixels. */
export function canvasOf(settings: DeckSettings): { width: number; height: number } {
  return SLIDE_ASPECTS[settings.aspect];
}
