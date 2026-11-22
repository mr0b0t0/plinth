// Builds an HTML deck's slides (docs/spec.md "HTML decks"). The author's markup never reaches a
// parser here: the shared parser (packages/shared/src/slidesHtml.ts) has already read each slide
// file into a tree of allowlisted elements and attributes, and this file creates exactly that
// tree with createElement and setAttribute, in a shadow root per slide. The deck's CSS goes into
// the same shadow root (css.ts), so it styles that slide and nothing of the renderer around it.
// No author script runs anywhere in the shell: the shell's CSP is script-src 'self', the tree has
// no script, handler or javascript: URL, and an <x-embed>'s page runs only in its own frame with
// an opaque origin and no network (embeds.ts, the content host's embed loader).
//
// An inline <svg> becomes an <img> of its own XML (as Claude shows it: one opaque picture), so its
// markup is never part of the shell's DOM either. Shapes, icons and connectors are drawn by
// Plinth (base.ts, icons.ts, connectors.ts).
import type { DeckElement, DeckNode, HtmlDeck, HtmlSlide } from "@plinth/shared";
import type { SlideView } from "../deck.ts";
import { el } from "../dom.ts";
import { baseCss, STILL_ATTR, STILL_CSS } from "./base.ts";
import { mapProjectUrls, scopeDeckCss } from "./css.ts";
import { X_ICONS } from "./icons.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** What one HTML slide's view holds besides the SlideView fields. */
export interface HtmlParts {
  slide: HtmlSlide;
  root: ShadowRoot;
  /** The slide's own <section>, inside the shadow root. */
  section: HTMLElement;
  /** Its fragments, one list per click, in the order they appear (fragments.ts). */
  steps: HTMLElement[][];
  /** Its <x-embed> boxes, each with the page it runs. */
  embeds: { box: HTMLElement; page: string }[];
}

/** What every slide of a deck shares: its rules, its size, and how a link names another slide. */
export interface HtmlDeckContext {
  doc: Document;
  deck: HtmlDeck;
  /** The slides shown, in order (a hidden slide is skipped). */
  shown: readonly HtmlSlide[];
  /** One stylesheet text for every shadow root: base, scoped deck.css, the motion switch. */
  css: string;
  /** Counter names deck.css increments, so a slide's own counter starts at its place. */
  counters: readonly string[];
}

/** The deck's shared parts, and its @property rules for the document's head. */
export function htmlDeckContext(
  doc: Document,
  deck: HtmlDeck,
): { ctx: HtmlDeckContext; properties: string[] } {
  const scoped = scopeDeckCss(deck.css, deck.canvas);
  const counters = new Set<string>();
  for (const m of deck.css.matchAll(/counter-increment\s*:\s*([^;}]+)/gi)) {
    for (const name of (m[1] ?? "").trim().split(/\s+/)) {
      if (/^-?[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) && name !== "none") counters.add(name);
    }
  }
  return {
    ctx: {
      doc,
      deck,
      shown: deck.slides.filter((s) => !s.hidden),
      css: `${baseCss(deck.canvas)}\n${scoped.css}\n${STILL_CSS}`,
      counters: [...counters],
    },
    properties: scoped.properties,
  };
}

/** An <svg> as Claude shows it: a picture of its own XML, the still copy where motion is off. */
export function svgSource(svg: NonNullable<DeckElement["svg"]>, still: boolean): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(still ? svg.still : svg.xml)}`;
}

/**
 * Sets each declaration inline with !important. Inside the slide's shadow tree (its `html`, an
 * embed's frame) no author rule outranks that. The host is in the page's tree, where a shadow
 * `:host { … !important }` rule would win over it (the inner context wins for !important), so
 * css.ts drops every selector that could name the host; the host's pins are a second line, and
 * containment holds through the canvas, which no deck rule can select.
 */
export function pin(e: HTMLElement, decls: Record<string, string>): void {
  for (const [k, v] of Object.entries(decls)) e.style.setProperty(k, v, "important");
}

/** What keeps a slide on its canvas: the host's place and size, as slides.css has them. */
export const HOST_PINNED = {
  position: "absolute",
  top: "0px",
  left: "0px",
  display: "block",
  width: "var(--w)",
  height: "var(--h)",
  overflow: "hidden",
  "z-index": "auto",
  contain: "strict",
} as const;

/** The canvas around a host clips and contains everything the slide draws, fixed boxes included. */
export const CANVAS_PINNED = { contain: "strict", overflow: "hidden" } as const;

/** The shadow root's own `html`, the slide's canvas. */
function htmlPinned(canvas: { width: number; height: number }): Record<string, string> {
  return {
    position: "absolute",
    inset: "0",
    width: `${canvas.width}px`,
    height: `${canvas.height}px`,
    overflow: "hidden",
    contain: "strict",
  };
}

/** Each inline drawing's two pictures, live and still. */
const drawings = new WeakMap<HTMLImageElement, { live: string; still: string }>();

function iconSvg(doc: Document, name: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  // The glyph fills about two thirds of its box, as Claude draws it.
  svg.setAttribute("viewBox", "-40 -40 336 336");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // Own keys only: a name such as "constructor" is no icon.
  const paths = Object.hasOwn(X_ICONS, name) ? X_ICONS[name as keyof typeof X_ICONS] : [];
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** A link's href on a slide: #N and #<slide id> page the deck; a web or mail link opens a tab. */
function linkHref(ctx: HtmlDeckContext, a: HTMLElement, href: string): void {
  const h = href.trim();
  if (h.startsWith("#")) {
    const ref = h.slice(1);
    const byId = ctx.shown.findIndex((s) => s.id === ref);
    a.setAttribute("href", /^\d{1,4}$/.test(ref) ? `#${ref}` : byId >= 0 ? `#${byId + 1}` : "#");
    return;
  }
  a.setAttribute("href", h);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
}

interface BuildState {
  ctx: HtmlDeckContext;
  embeds: HtmlParts["embeds"];
}

function build(s: BuildState, n: DeckNode): Node {
  const doc = s.ctx.doc;
  if (n.kind === "text") return doc.createTextNode(n.text);
  if (n.svg) {
    const img = doc.createElement("img");
    for (const [k, v] of n.attrs) img.setAttribute(k, k === "style" ? mapProjectUrls(v) : v);
    const live = svgSource(n.svg, false);
    img.setAttribute("src", live);
    img.setAttribute("alt", n.svg.alt);
    img.dataset.plinthSvg = "";
    drawings.set(img, { live, still: svgSource(n.svg, true) });
    return img;
  }
  const e = doc.createElement(n.tag);
  for (const [k, v] of n.attrs) {
    if (n.tag === "a" && k === "href") linkHref(s.ctx, e, v);
    else e.setAttribute(k, k === "style" ? mapProjectUrls(v) : v);
  }
  if (n.tag === "img") {
    e.setAttribute("loading", "lazy");
    e.setAttribute("decoding", "async");
    if (!e.hasAttribute("alt")) e.setAttribute("alt", "");
  }
  if (n.tag === "x-icon") {
    e.setAttribute("aria-hidden", "true");
    e.append(iconSvg(doc, e.getAttribute("name") ?? ""));
    return e;
  }
  if (n.tag === "x-shape" || n.tag === "x-connector") {
    e.setAttribute("aria-hidden", "true");
    return e;
  }
  if (n.tag === "x-embed") {
    s.embeds.push({ box: e, page: n.embed ?? "" });
    return e;
  }
  for (const c of n.children) e.append(build(s, c));
  return e;
}

/** The fragments of a section, one list per click (Claude's and reveal.js's order). */
export function fragmentSteps(section: HTMLElement): HTMLElement[][] {
  const all = Array.from(section.querySelectorAll<HTMLElement>(".fragment"));
  const indexed = new Map<number, HTMLElement[]>();
  const plain: HTMLElement[] = [];
  for (const f of all) {
    const raw = f.getAttribute("data-fragment-index");
    const i = raw !== null && /^\d{1,4}$/.test(raw.trim()) ? Number(raw) : null;
    if (i === null) plain.push(f);
    else indexed.set(i, [...(indexed.get(i) ?? []), f]);
  }
  const steps = [...indexed.keys()].sort((a, b) => a - b).map((i) => indexed.get(i) ?? []);
  for (const f of plain) steps.push([f]);
  return steps;
}

/** Shows the first `k` steps of a slide's fragments (all of them for k >= steps.length). */
export function showSteps(steps: readonly HTMLElement[][], k: number): void {
  steps.forEach((group, i) => {
    for (const f of group) {
      f.classList.toggle("visible", i < k);
      f.classList.toggle("current-fragment", i === k - 1);
    }
  });
}

/**
 * One HTML slide's frame: its overview wrapper, the scaled canvas, the host whose shadow root
 * holds the slide, and the handout notes. `n` is its place among the slides shown.
 */
export function buildHtmlSlide(
  ctx: HtmlDeckContext,
  slide: HtmlSlide,
  n: number,
): { view: SlideView; parts: HtmlParts } {
  const doc = ctx.doc;
  const count = ctx.shown.length;
  const frame = el(doc, "div", "plinth-slides__frame");
  frame.dataset.n = String(n);
  const host = el(doc, "section", "plinth-slides__slide");
  host.dataset.format = "html";
  host.setAttribute("aria-roledescription", "slide");
  host.setAttribute(
    "aria-label",
    slide.title ? `Slide ${n} of ${count}: ${slide.title}` : `Slide ${n} of ${count}`,
  );
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = ctx.css;
  const html = doc.createElement("html");
  pin(html, htmlPinned(ctx.deck.canvas));
  pin(host, HOST_PINNED);
  const body = doc.createElement("body");
  if (ctx.counters.length > 0) {
    html.style.setProperty("counter-reset", ctx.counters.map((c) => `${c} ${n - 1}`).join(" "));
  }
  const state: BuildState = { ctx, embeds: [] };
  const section = build(state, slide.section) as HTMLElement;
  // The author's section is the slide: `hidden` skipped it already, and its id stays its own.
  section.removeAttribute("hidden");
  body.append(section);
  html.append(body);
  root.append(style, html);
  const canvas = el(doc, "div", "plinth-slides__canvas");
  pin(canvas, CANVAS_PINNED);
  canvas.append(host);
  const notes = doc.createDocumentFragment();
  for (const para of slide.notes.split(/\n{2,}/)) {
    if (para.trim() === "") continue;
    const p = doc.createElement("p");
    para.split("\n").forEach((line, i) => {
      if (i > 0) p.append(doc.createElement("br"));
      p.append(doc.createTextNode(line));
    });
    notes.append(p);
  }
  const handout = el(doc, "div", "plinth-slides__handout");
  handout.append(notes.cloneNode(true));
  frame.append(canvas, handout);
  const steps = fragmentSteps(section);
  return {
    view: { n, frame, el: host, body: host, layout: "default", notes, line: 1 },
    parts: { slide, root, section, steps, embeds: state.embeds },
  };
}

/** Marks a host still (motion off) or not. */
export function setStill(host: HTMLElement, still: boolean): void {
  host.toggleAttribute(STILL_ATTR, still);
  const root = host.shadowRoot;
  if (!root) return;
  // An inline <svg>'s own animation lives in its picture: the still copy has none.
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-plinth-svg]"))) {
    const pics = drawings.get(img);
    const want = pics ? (still ? pics.still : pics.live) : null;
    if (want && img.getAttribute("src") !== want) img.setAttribute("src", want);
  }
}

/** Every <img> of a host's slide, for eager loading, decoding before print and the export. */
export function slideImages(host: HTMLElement): HTMLImageElement[] {
  return Array.from(host.shadowRoot?.querySelectorAll<HTMLImageElement>("img") ?? []);
}
