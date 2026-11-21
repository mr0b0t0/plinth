// A deck's slides as edit mode draws them (slides-text): every raw slide of the draft
// (deckLayout), the empty ones at the deck's edges included, each part (the head and each column)
// drawn block by block, so the editor (edit.ts) can find the lines of the block a person clicks.
// Each block is the doc's Markdown pipeline on the part's text (doc/blocks.ts parseBlocks, then
// the unchanged sanitizer), so a slide looks exactly as the deck shows it; the block's lines and
// model live in a WeakMap keyed by its top-level nodes, never in the DOM, so a page can never
// forge a range. Everything else is made with createElement and textContent.
import {
  type DeckLayout,
  type DeckRange,
  type DeckSettings,
  deckPartShown,
  notesText,
  parseLaidOut,
  type RawSlideLayout,
  shownRange,
} from "@plinth/shared";
import { parseBlocks } from "../doc/blocks.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { dropIds, renderPart, type SlideView, scopeIds } from "./deck.ts";
import { el } from "./dom.ts";
import { classifySlide } from "./layout.ts";

/** One block of a slide part, with its lines in the deck. */
export interface EditBlock {
  /** The block's lines [start, end) in the deck, without the blank lines after it. */
  start: number;
  end: number;
  /** The block's Markdown as the deck hands it to Markdown (`\Note:` read as `Note:`). */
  shown: string;
  /** The block's index in its slide, from 1 (for Ask an agent's anchor). */
  index: number;
  /** Its top-level nodes in the slide. */
  nodes: Node[];
  part: EditPart;
}

/** One part of a slide: its head or a column (notes are drawn by the editor's notes panel). */
export interface EditPart {
  range: DeckRange;
  /** The part's Markdown as the deck shows it, which its blocks are read with (references). */
  shown: string;
  blocks: EditBlock[];
  /** The element the part's blocks are drawn in. */
  el: HTMLElement;
}

export interface EditSlideView extends SlideView {
  raw: RawSlideLayout;
  /** The slide's number as the deck shows it, or null for an empty slide at an edge. */
  shownN: number | null;
  parts: EditPart[];
  /** Nothing to show on the slide (no block in its head or columns). */
  empty: boolean;
  /** Where the notes panel goes (edit.ts fills it). */
  notesHost: HTMLElement;
  /** What the slide was drawn from, for reusing it when nothing changed. */
  key: string;
}

const blocksOf = new WeakMap<Node, EditBlock>();

/** The block a node of an edit-mode slide belongs to, if any. */
export function blockAt(node: Node | null, stop: Node): EditBlock | null {
  for (let n = node; n && n !== stop; n = n.parentNode) {
    const b = blocksOf.get(n);
    if (b) return b;
  }
  return null;
}

/** Draws the blocks of one part into `into`, and records them. */
function drawPart(
  doc: Document,
  lines: readonly string[],
  range: DeckRange,
  into: HTMLElement,
  counter: { n: number },
): EditPart {
  const shownLines = deckPartShown(lines.slice(range.start, range.end), false);
  const shown = shownLines.join("\n");
  const part: EditPart = { range, shown, blocks: [], el: into };
  for (const b of parseBlocks(shown)) {
    const frag = sanitizeHtml(b.html, doc);
    for (const a of Array.from(frag.querySelectorAll("a.plinth-doc__anchor"))) a.remove();
    const nodes = Array.from(frag.childNodes).filter(
      (n) => n.nodeType === 1 || (n.textContent ?? "").trim() !== "",
    );
    if (nodes.length === 0) continue;
    const block: EditBlock = {
      start: range.start + b.core.start,
      end: range.start + b.core.end,
      shown: shownLines.slice(b.core.start, b.core.end).join("\n"),
      index: ++counter.n,
      nodes,
      part,
    };
    for (const n of nodes) blocksOf.set(n, block);
    part.blocks.push(block);
    into.append(...nodes);
  }
  return part;
}

/** The labels edit mode shows, exported for tests. */
export const EDIT_VIEW_WORDS = {
  placeholder: "Click to add a title",
  hidden: "Empty: not shown until it has content",
} as const;

function buildEditSlide(
  doc: Document,
  lines: readonly string[],
  raw: RawSlideLayout,
  settings: DeckSettings,
  count: number,
  shownN: number | null,
): EditSlideView {
  const n = raw.n;
  const frame = el(doc, "div", "plinth-slides__frame");
  frame.dataset.n = String(n);
  const slide = el(doc, "section", "plinth-slides__slide");
  slide.setAttribute("aria-roledescription", "slide");
  slide.setAttribute("aria-label", `Slide ${n} of ${count}`);
  const body = el(doc, "div", "plinth-slides__body");
  const head = el(doc, "div", "plinth-slides__head");
  body.append(head);
  const counter = { n: 0 };
  const parts: EditPart[] = [drawPart(doc, lines, raw.head, head, counter)];
  // As the deck shows them: one column joins the head, a fourth or later joins the third.
  const cols = raw.columns;
  if (cols.length === 1) {
    parts.push(drawPart(doc, lines, cols[0] as DeckRange, head, counter));
  } else if (cols.length > 1) {
    const wrap = el(doc, "div", "plinth-slides__columns");
    wrap.dataset.count = String(Math.min(cols.length, 3));
    let col: HTMLElement | null = null;
    cols.forEach((range, i) => {
      if (i < 3 || !col) {
        col = el(doc, "div", "plinth-slides__column");
        wrap.append(col);
      }
      parts.push(drawPart(doc, lines, range, col, counter));
    });
    body.append(wrap);
  }
  slide.append(body);
  scopeIds(slide, `s${n}-`);
  const empty = parts.every((p) => p.blocks.length === 0);
  const layout = classifySlide(head, cols.length > 1 ? Math.min(cols.length, 3) : 0);
  slide.dataset.layout = layout;
  if (settings.footer) slide.append(el(doc, "div", "plinth-slides__footer", settings.footer));
  if (settings.paginate && shownN !== null) {
    const number = el(doc, "div", "plinth-slides__number", String(shownN));
    number.setAttribute("aria-hidden", "true");
    slide.append(number);
  }
  const canvas = el(doc, "div", "plinth-slides__canvas");
  canvas.append(slide);
  if (shownN === null) frame.append(el(doc, "p", "plinth-slides__hidden", EDIT_VIEW_WORDS.hidden));
  frame.append(canvas);
  const notesHost = el(doc, "div", "plinth-slides__notepad-host");
  frame.append(notesHost);
  const notes = renderPart(
    doc,
    raw.notes ? notesText(lines.slice(raw.notes.start, raw.notes.end)) : "",
  );
  dropIds(notes);
  return {
    n,
    frame,
    el: slide,
    body,
    layout,
    notes,
    line: raw.start + 1,
    raw,
    shownN,
    parts,
    empty,
    notesHost,
    key: "",
  };
}

/** What a slide is drawn from: its own lines, its number and the deck's settings. */
export function slideKey(
  lines: readonly string[],
  raw: RawSlideLayout,
  count: number,
  shownN: number | null,
  settings: DeckSettings,
  skip?: DeckRange | null,
): string {
  const own: string[] = [];
  for (let i = raw.start; i < raw.end; i++) {
    if (skip && i >= skip.start && i < skip.end) continue;
    own.push(lines[i] ?? "");
  }
  // The slide that holds the open block is drawn apart from the same slide without it.
  const held =
    skip && skip.start >= raw.start && skip.start <= raw.end ? skip.start - raw.start : -1;
  return JSON.stringify([
    raw.n,
    count,
    shownN,
    settings,
    raw.head,
    raw.columns,
    raw.notes,
    held,
    own,
  ]);
}

/**
 * Every raw slide of the lines, for edit mode. `reuse` holds the slides drawn last time by key:
 * a slide whose key is the same is kept as it is (so the slide being typed in is not drawn again
 * on every keystroke's ack), and `skip` is the range of the block open in the editor, whose own
 * lines do not count towards its slide's key.
 */
export function buildEditDeck(
  doc: Document,
  lines: readonly string[],
  layout: DeckLayout,
  reuse: ReadonlyMap<string, EditSlideView>,
  skip: DeckRange | null,
): { views: EditSlideView[]; settings: DeckSettings } {
  const parsed = parseLaidOut(lines, layout);
  const { lo, hi } = shownRange(lines, layout);
  const count = layout.slides.length;
  const views = layout.slides.map((raw, i) => {
    const shownN = i >= lo && i < hi ? i - lo + 1 : null;
    const key = slideKey(lines, raw, count, shownN, parsed.settings, skip);
    const kept = reuse.get(key);
    if (kept) return kept;
    const v = buildEditSlide(doc, lines, raw, parsed.settings, count, shownN);
    v.key = key;
    return v;
  });
  return { views, settings: parsed.settings };
}
