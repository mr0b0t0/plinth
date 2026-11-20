// The export model of a deck: what the .pptx writer (pptxWriter.ts) needs, read from the slides as
// they are rendered, so the file matches the screen. The caller lays every slide out and fits it
// first (export.ts, as print does); this file only measures. Positions come from
// getBoundingClientRect relative to each slide canvas, divided by the canvas scale, then from
// canvas pixels to inches (/ 96); font sizes from computed styles, from pixels to points (* 0.75).
//
// Text is read from the sanitized slide DOM (deck.ts), never from the Markdown again, and a link
// keeps only what the doc's URL rules accept (isSafeHref): web and mail links, and #N, which
// becomes a link to slide N. Everything else in an href is dropped, the text stays.
import { SLIDE_ASPECTS, type SlideAspect } from "@plinth/shared";
import { isSafeHref } from "../doc/markdown.ts";
import { SLIDE_LINK_RE, type SlideView } from "./deck.ts";
import type { Box, Cell, DeckModel, Item, Para, Run, SlideModel } from "./pptxModel.ts";

const PX_PER_INCH = 96;
const PT_PER_PX = 0.75;
const HEADING_RE = /^h[1-6]$/;
/** The web and mail schemes a link in the file may keep. */
const LINK_RE = /^(https?:|mailto:)/i;

/** The computed style fields the model reads. */
export type StyleOf = (
  el: Element,
) => Pick<
  CSSStyleDeclaration,
  | "fontSize"
  | "fontWeight"
  | "textAlign"
  | "color"
  | "lineHeight"
  | "marginTop"
  | "backgroundColor"
  | "objectFit"
  | "borderBottomColor"
>;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Layout reads, injected so tests can stub what happy-dom does not lay out. */
export interface Geometry {
  rect: (el: Element) => Rect;
  style: StyleOf;
}

export function domGeometry(win: Window): Geometry {
  return {
    rect: (el) => el.getBoundingClientRect(),
    style: (el) => win.getComputedStyle(el),
  };
}

/** A CSS colour as RRGGBB, or null for a transparent or unreadable one. */
export function hexColor(css: string): string | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
    css.trim(),
  );
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number.parseFloat(m[4]) / (m[4].endsWith("%") ? 100 : 1);
    if (!(alpha > 0)) return null;
    return [m[1], m[2], m[3]]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(Number(v))))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase();
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  return hex?.[1] ? hex[1].toUpperCase() : null;
}

const round = (n: number, places = 3) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const px = (v: string) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** What every measure inside one slide needs. */
interface SlideCtx {
  g: Geometry;
  origin: Rect;
  scale: number;
  /** The canvas size in pixels, to clip boxes to the slide. */
  canvas: { width: number; height: number };
  count: number;
  fallbackColor: string;
}

function boxOf(c: SlideCtx, r: Rect): Box | null {
  const x = (r.left - c.origin.left) / c.scale;
  const y = (r.top - c.origin.top) / c.scale;
  let w = r.width / c.scale;
  let h = r.height / c.scale;
  // Content past the slide's edge (a slide that overflows at the smallest fit) is not on it.
  if (!(w > 0 && h > 0) || x >= c.canvas.width || y >= c.canvas.height) return null;
  w = Math.min(w, c.canvas.width - x);
  h = Math.min(h, c.canvas.height - y);
  return {
    x: round(x / PX_PER_INCH),
    y: round(y / PX_PER_INCH),
    w: round(w / PX_PER_INCH),
    h: round(h / PX_PER_INCH),
  };
}

function alignOf(v: string): Para["align"] {
  if (v === "center") return "center";
  if (v === "right" || v === "end") return "right";
  return "left";
}

/** A link target the file may keep: a web or mail URL, or a slide of this deck. */
function linkOf(href: string, count: number): Pick<Run, "href" | "slide"> {
  if (!isSafeHref(href)) return {};
  const slide = SLIDE_LINK_RE.exec(href);
  if (slide) {
    const n = Number(slide[1]);
    return n >= 1 && n <= count ? { slide: n } : {};
  }
  return LINK_RE.test(href.trim()) ? { href: href.trim() } : {};
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  slide?: number;
  color?: string;
}

/**
 * The inline runs of `el`, split into lines at each <br>. Lists, tables and images inside are
 * skipped (they are their own items or paragraphs). `pre` keeps whitespace and splits at newlines.
 */
function lines(c: SlideCtx, el: Element, pre = false): Run[][] {
  const out: Run[][] = [[]];
  const push = (text: string, s: RunStyle) => {
    const parts = pre ? text.split("\n") : [text.replace(/\s+/g, " ")];
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part !== "") out[out.length - 1]?.push({ text: part, ...s });
    });
  };
  const walk = (node: Node, s: RunStyle) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        push(child.textContent ?? "", s);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const e = child as Element;
      const tag = e.localName;
      if (tag === "br") out.push([]);
      else if (tag === "p") {
        // A loose list item's paragraphs: each starts its own line.
        if ((out[out.length - 1]?.length ?? 0) > 0) out.push([]);
        walk(e, s);
      } else if (tag === "ul" || tag === "ol" || tag === "table" || tag === "img") continue;
      else if (tag === "strong" || tag === "b") walk(e, { ...s, bold: true });
      else if (tag === "em" || tag === "i") walk(e, { ...s, italic: true });
      else if (tag === "del" || tag === "s") walk(e, { ...s, strike: true });
      else if (tag === "code") walk(e, { ...s, code: !pre || s.code });
      else if (tag === "a") {
        const link = linkOf(e.getAttribute("href") ?? "", c.count);
        const color = link.href || link.slide ? hexColor(c.g.style(e).color) : null;
        walk(e, { ...s, ...link, ...(color ? { color } : {}) });
      } else walk(e, s);
    }
  };
  walk(el, {});
  const tidied = out.map((runs) => tidy(runs, pre));
  if (!pre) return tidied.filter((runs) => runs.length > 0);
  // A code block keeps its blank lines, as the screen does, each as one empty run (an empty
  // paragraph at the block's size in the file). The newline that ends the block draws no line.
  if (tidied.length > 1 && tidied[tidied.length - 1]?.length === 0) tidied.pop();
  return tidied.map((runs) => (runs.length > 0 ? runs : [{ text: "" }]));
}

/** Drops the line's leading and trailing whitespace (not in a code block) and empty runs. */
function tidy(runs: Run[], pre: boolean): Run[] {
  if (pre) return runs.filter((r) => r.text !== "");
  const out = runs.map((r) => ({ ...r }));
  while (out[0] && out[0].text.trim() === "") out.shift();
  while (out.length > 0 && (out[out.length - 1]?.text.trim() ?? "") === "") out.pop();
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((r) => r.text !== "");
}

/** Paragraph properties from a block's computed style. */
function paraOf(c: SlideCtx, el: Element, runs: Run[], o: Partial<Para> = {}): Para {
  const st = c.g.style(el);
  const size = px(st.fontSize) || 30;
  const lh = px(st.lineHeight);
  return {
    runs,
    level: 0,
    bullet: "none",
    size: round(size * PT_PER_PX, 1),
    bold: Number.parseInt(st.fontWeight, 10) >= 600,
    align: alignOf(st.textAlign),
    mono: false,
    color: hexColor(st.color) ?? c.fallbackColor,
    lineHeight: lh > 0 ? round(lh / size, 2) : 1.2,
    spaceBefore: 0,
    ...o,
  };
}

/**
 * A list's items as paragraphs, nested lists one level deeper. The space above each item is the
 * gap the screen shows: an item's top margin, and for a nested list's first item the list's own.
 * The top-level list's margin is outside its box, so its first item has none.
 */
function listParas(c: SlideCtx, list: Element, level: number, out: Para[]): void {
  const bullet = list.localName === "ol" ? "number" : "disc";
  let first = true;
  for (const li of Array.from(list.children)) {
    if (li.localName !== "li") continue;
    const runs = lines(c, li).flatMap((line, i) => (i > 0 ? [{ text: " " }, ...line] : line));
    if (runs.length > 0) {
      let margin = "0";
      if (!first) margin = c.g.style(li).marginTop;
      else if (level > 0) margin = c.g.style(list).marginTop;
      const spaceBefore = round(px(margin) * PT_PER_PX, 1);
      out.push(paraOf(c, li, runs, { level, bullet, spaceBefore }));
    }
    first = false;
    for (const nested of Array.from(li.children)) {
      if (nested.localName === "ul" || nested.localName === "ol") {
        listParas(c, nested, level + 1, out);
      }
    }
  }
}

function textItem(c: SlideCtx, el: Element, paras: Para[], items: Item[], oneLine = false): void {
  if (paras.length === 0) return;
  const box = boxOf(c, c.g.rect(el));
  if (box) items.push({ kind: "text", box, paras, ...(oneLine ? { oneLine: true as const } : {}) });
}

/** The rectangle an image is drawn in: its box, or with object-fit contain, the fitted picture. */
function imageRect(c: SlideCtx, img: HTMLImageElement): Rect {
  const r = c.g.rect(img);
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (
    c.g.style(img).objectFit !== "contain" ||
    !(nw > 0 && nh > 0 && r.width > 0 && r.height > 0)
  ) {
    return r;
  }
  const s = Math.min(r.width / nw, r.height / nh);
  const w = nw * s;
  const h = nh * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

function imageItems(c: SlideCtx, el: Element, items: Item[]): void {
  const imgs = el.localName === "img" ? [el] : Array.from(el.querySelectorAll("img"));
  for (const img of imgs as HTMLImageElement[]) {
    const src = img.getAttribute("src") ?? "";
    if (src === "") continue;
    const box = boxOf(c, imageRect(c, img));
    if (box) items.push({ kind: "image", box, src, alt: img.getAttribute("alt") ?? "" });
  }
}

function tableItem(c: SlideCtx, table: HTMLTableElement, items: Item[]): void {
  const rows: Cell[][] = [];
  for (const tr of Array.from(table.rows)) {
    rows.push(
      Array.from(tr.cells).map((cell) => ({
        runs: lines(c, cell).flatMap((line, i) => (i > 0 ? [{ text: " " }, ...line] : line)),
        header: cell.localName === "th",
        align: alignOf(c.g.style(cell).textAlign),
      })),
    );
  }
  if (rows.length === 0) return;
  const box = boxOf(c, c.g.rect(table));
  if (!box) return;
  const firstRow = table.rows[0];
  const colW = Array.from(firstRow?.cells ?? []).map((cell) =>
    round(c.g.rect(cell).width / c.scale / PX_PER_INCH),
  );
  const st = c.g.style(table);
  const td = table.querySelector("td");
  const th = table.querySelector("th");
  items.push({
    kind: "table",
    box,
    rows,
    colW,
    size: round((px(st.fontSize) || 22) * PT_PER_PX, 1),
    color: hexColor(st.color) ?? c.fallbackColor,
    headColor: (th && hexColor(c.g.style(th).color)) ?? hexColor(st.color) ?? c.fallbackColor,
    rule: (td && hexColor(c.g.style(td).borderBottomColor)) ?? "D8DEE4",
  });
}

/** Every block under `container`, in document order, as items. */
function blocks(c: SlideCtx, container: Element, items: Item[]): void {
  for (const el of Array.from(container.children)) {
    const tag = el.localName;
    if (HEADING_RE.test(tag) || tag === "p") {
      textItem(
        c,
        el,
        lines(c, el).map((runs) => paraOf(c, el, runs)),
        items,
      );
      imageItems(c, el, items);
    } else if (tag === "ul" || tag === "ol") {
      const paras: Para[] = [];
      listParas(c, el, 0, paras);
      textItem(c, el, paras, items);
    } else if (tag === "pre") {
      const code = el.querySelector("code") ?? el;
      textItem(
        c,
        el,
        lines(c, code, true).map((runs) => paraOf(c, code, runs, { mono: true })),
        items,
      );
    } else if (tag === "blockquote") {
      const paras: Para[] = [];
      for (const part of Array.from(el.children)) {
        if (part.localName === "ul" || part.localName === "ol") listParas(c, part, 0, paras);
        else paras.push(...lines(c, part).map((runs) => paraOf(c, part, runs)));
      }
      if (el.children.length === 0) paras.push(...lines(c, el).map((runs) => paraOf(c, el, runs)));
      textItem(c, el, paras, items);
    } else if (tag === "table") {
      tableItem(c, el as HTMLTableElement, items);
    } else if (tag === "img") {
      imageItems(c, el, items);
    } else if (tag === "hr") {
      // A rule is decoration; the file leaves it out.
    } else if (tag === "div" || tag === "section") {
      blocks(c, el, items);
    } else {
      textItem(
        c,
        el,
        lines(c, el).map((runs) => paraOf(c, el, runs)),
        items,
      );
    }
  }
}

/** Speaker notes as plain text: one line per paragraph, list items with "• " or "1. ". */
export function notesText(root: ParentNode): string {
  const out: string[] = [];
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const list = (l: Element, depth: number) => {
    let i = Number.parseInt(l.getAttribute("start") ?? "1", 10) || 1;
    for (const li of Array.from(l.children)) {
      if (li.localName !== "li") continue;
      const own = Array.from(li.childNodes)
        .filter((n) => !(n.nodeType === 1 && /^(ul|ol)$/.test((n as Element).localName)))
        .map((n) => n.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const mark = l.localName === "ol" ? `${i++}. ` : "• ";
      out.push(`${"  ".repeat(depth)}${mark}${own}`);
      for (const nested of Array.from(li.children)) {
        if (/^(ul|ol)$/.test(nested.localName)) list(nested, depth + 1);
      }
    }
  };
  const walk = (parent: ParentNode) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.localName;
      if (tag === "ul" || tag === "ol") list(el, 0);
      else if (tag === "pre") out.push(...(el.textContent ?? "").replace(/\n$/, "").split("\n"));
      else if (tag === "blockquote" || tag === "div") walk(el);
      else if (tag === "table") {
        for (const tr of Array.from((el as HTMLTableElement).rows)) {
          out.push(
            Array.from(tr.cells)
              .map((cell) => text(cell))
              .join(" | "),
          );
        }
      } else if (tag !== "hr") {
        const t = text(el);
        if (t) out.push(t);
      }
    }
  };
  walk(root);
  return out.join("\n");
}

export interface ExportModelOptions {
  aspect: SlideAspect;
  theme: "light" | "dark";
  title: string;
  geometry: Geometry;
}

/** One slide's model. The slide must be laid out and fitted. */
export function slideModel(view: SlideView, count: number, o: ExportModelOptions): SlideModel {
  const canvas = SLIDE_ASPECTS[o.aspect];
  const g = o.geometry;
  const origin = g.rect(view.el);
  const scale = origin.width > 0 ? origin.width / canvas.width : 1;
  const st = g.style(view.el);
  const fallbackColor = hexColor(st.color) ?? (o.theme === "dark" ? "D6DBE0" : "1F2328");
  const c: SlideCtx = { g, origin, scale, canvas, count, fallbackColor };
  const items: Item[] = [];
  blocks(c, view.body, items);
  // The footer and the slide number, which sit on the canvas outside the body, each on one line:
  // their boxes fit the screen font, and the file's Arial is wider.
  for (const el of Array.from(view.el.children)) {
    if (
      el.classList.contains("plinth-slides__footer") ||
      el.classList.contains("plinth-slides__number")
    ) {
      textItem(
        c,
        el,
        lines(c, el).map((runs) => paraOf(c, el, runs)),
        items,
        true,
      );
    }
  }
  return {
    n: view.n,
    notes: notesText(view.notes),
    background: hexColor(st.backgroundColor) ?? (o.theme === "dark" ? "15181C" : "FFFFFF"),
    items,
  };
}

/** The whole deck's model. Every slide must be laid out and fitted. */
export function buildExportModel(views: readonly SlideView[], o: ExportModelOptions): DeckModel {
  const canvas = SLIDE_ASPECTS[o.aspect];
  return {
    title: o.title,
    width: round(canvas.width / PX_PER_INCH),
    height: round(canvas.height / PX_PER_INCH),
    theme: o.theme,
    slides: views.map((v) => slideModel(v, views.length, o)),
  };
}

/** The distinct image srcs of a model, in order of first use. */
export function imageSources(model: DeckModel): string[] {
  const seen = new Set<string>();
  for (const s of model.slides) {
    for (const item of s.items) if (item.kind === "image") seen.add(item.src);
  }
  return [...seen];
}

/** A file name for the deck: letters, digits, spaces, dots, dashes and underscores, at most 80. */
export function pptxFileName(title: string): string {
  const base = title
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "deck"}.pptx`;
}
