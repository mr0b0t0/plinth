// An HTML slide's export model (pptxModel.ts), read from the slide as rendered, as the Markdown
// deck's is (exportModel.ts): every box keeps the place, size and colours the screen shows. What
// PowerPoint has a match for becomes its editable kind: text (headings, paragraphs, lists, a box
// of words) as text boxes with their runs, a table as a table, a painted box (its background, its
// border, its radius) as a rectangle, an ellipse or a rounded rectangle, an <x-shape> as its
// shape, an image as an image. What it has none for becomes a picture: an inline <svg> (its still
// copy), an <x-icon> and an <x-connector>, drawn in the colour on screen. An <x-embed> runs code,
// so it is left out and counted. The file is 13.333 x 7.5 in at 16:9 (10 x 7.5 at 4:3): 144
// canvas pixels to the inch.
import { DECK_FAMILY_RE, type HtmlDeck } from "@plinth/shared";
import type { SlideView } from "../deck.ts";
import {
  boxOf,
  type Geometry,
  hexColor,
  imageRect,
  lines,
  listParas,
  notesText,
  paraOf,
  px,
  round,
  type SlideCtx,
  tableItem,
} from "../exportModel.ts";
import type { DeckModel, Item, Para, ShapeKind, SlideModel } from "../pptxModel.ts";

/** An HTML deck's canvas pixels per inch in the file: 1920 px is 13.333 in. */
export const HTML_PPI = 144;

const INLINE = new Set(["b", "i", "u", "a", "span", "br"]);
const SHAPES: Record<string, ShapeKind> = {
  rect: "rect",
  rounded: "roundRect",
  ellipse: "ellipse",
  diamond: "diamond",
  "arrow-right": "rightArrow",
  "arrow-left": "leftArrow",
  "arrow-up": "upArrow",
  "arrow-down": "downArrow",
  line: "line",
};

type Style = CSSStyleDeclaration;

function alphaOf(css: string): number {
  const m = /rgba?\([^)]*[,/]\s*([\d.]+%?)\s*\)$/i.exec(css.trim());
  if (!m?.[1]) return 1;
  return Number.parseFloat(m[1]) / (m[1].endsWith("%") ? 100 : 1);
}

/** A fill from a computed background: its colour, else a gradient's first stop. */
function fillOf(st: Style, opacity: number): { color: string; transparency: number } | null {
  let css = st.backgroundColor ?? "";
  let color = hexColor(css);
  if (!color && st.backgroundImage && st.backgroundImage !== "none") {
    const stop = /rgba?\([^)]*\)|#[0-9a-f]{6}/i.exec(st.backgroundImage)?.[0];
    if (stop) {
      css = stop;
      color = hexColor(stop);
    }
  }
  if (!color) return null;
  const a = alphaOf(css) * opacity;
  return { color, transparency: Math.round((1 - Math.max(0, Math.min(1, a))) * 100) };
}

/** The border all four sides share, or null (each other side becomes a thin bar). */
function lineOf(
  st: Style,
  ppi: number,
): NonNullable<Extract<Item, { kind: "shape" }>["line"]> | null {
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  const width = (s: (typeof sides)[number]) => px(st[`border${s}Width`] ?? "");
  const style = (s: (typeof sides)[number]) => st[`border${s}Style`] ?? "none";
  const color = (s: (typeof sides)[number]) => hexColor(st[`border${s}Color`] ?? "");
  const w = width("Top");
  if (!(w > 0) || style("Top") === "none" || !color("Top")) return null;
  if (
    !sides.every((s) => width(s) === w && style(s) === style("Top") && color(s) === color("Top"))
  ) {
    return null;
  }
  const dash = style("Top") === "dashed" ? "dash" : style("Top") === "dotted" ? "sysDot" : "solid";
  return { color: color("Top") as string, width: round((w * 72) / ppi, 2), dash };
}

/** The sides that have a border of their own, as bars (an accent rule, a divider line). */
function sideBars(c: SlideCtx, e: Element, st: Style, items: Item[]): void {
  const r = c.g.rect(e);
  const s = c.scale;
  const bar = (side: "Top" | "Right" | "Bottom" | "Left") => {
    const w = px(st[`border${side}Width`] ?? "") * s;
    const color = hexColor(st[`border${side}Color`] ?? "");
    if (!(w > 0) || st[`border${side}Style`] === "none" || !color) return;
    const rect =
      side === "Top"
        ? { left: r.left, top: r.top, width: r.width, height: w }
        : side === "Bottom"
          ? { left: r.left, top: r.top + r.height - w, width: r.width, height: w }
          : side === "Left"
            ? { left: r.left, top: r.top, width: w, height: r.height }
            : { left: r.left + r.width - w, top: r.top, width: w, height: r.height };
    const box = boxOf(c, rect);
    if (box)
      items.push({
        kind: "shape",
        box,
        shape: "rect",
        fill: { color, transparency: 0 },
        line: null,
      });
  };
  bar("Top");
  bar("Right");
  bar("Bottom");
  bar("Left");
}

/** A painted box (or an x-shape) as a shape item, before its content. */
function paintedBox(c: SlideCtx, e: Element, st: Style, opacity: number, items: Item[]): void {
  const tag = e.localName;
  const kind = tag === "x-shape" ? (SHAPES[e.getAttribute("kind") ?? "rect"] ?? "rect") : null;
  const fill = fillOf(st, opacity);
  const line = lineOf(st, c.ppi);
  if (!kind && !fill && !line) {
    sideBars(c, e, st, items);
    return;
  }
  const r = c.g.rect(e);
  const box = boxOf(c, r);
  if (!box) return;
  let shape: ShapeKind = kind ?? "rect";
  let radius: number | undefined;
  const corner = px(st.borderTopLeftRadius ?? "");
  if (!kind && corner > 0) {
    const half = Math.min(r.width, r.height) / c.scale / 2;
    if (corner >= half - 0.5 && Math.abs(r.width - r.height) < 1) shape = "ellipse";
    else {
      shape = "roundRect";
      radius = round(Math.min(1, corner / Math.max(1, half)), 3);
    }
  }
  if (kind === "line") {
    // A line shape draws in its border colour along its box's middle.
    const stroke = hexColor(st.borderTopColor ?? "") ?? fill?.color ?? c.fallbackColor;
    const w = px(st.borderTopWidth ?? "") || 2;
    items.push({
      kind: "shape",
      box: { ...box, h: Math.max(box.h, 0.001) },
      shape: "line",
      fill: null,
      line: { color: stroke, width: round((w * 72) / c.ppi, 2), dash: "solid" },
    });
    return;
  }
  items.push({
    kind: "shape",
    box,
    shape,
    fill: kind && !fill ? { color: c.fallbackColor, transparency: 0 } : fill,
    line,
    ...(radius !== undefined ? { radius } : {}),
  });
  if (!kind && !line) sideBars(c, e, st, items);
}

/** An <svg> element of Plinth's own drawing (an icon, a connector) as a standalone picture. */
function pictureOf(
  c: SlideCtx,
  svg: SVGSVGElement,
  color: string,
  bounds: DOMRect | null,
): Item | null {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
    for (const attr of ["fill", "stroke"]) {
      if (node.getAttribute(attr) === "currentColor") node.setAttribute(attr, `#${color}`);
    }
  }
  const r = c.g.rect(svg);
  let rect = r;
  if (bounds) {
    clone.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    clone.setAttribute("width", String(Math.max(1, Math.round(bounds.width))));
    clone.setAttribute("height", String(Math.max(1, Math.round(bounds.height))));
    clone.removeAttribute("style");
    rect = {
      left: r.left + bounds.x * c.scale,
      top: r.top + bounds.y * c.scale,
      width: bounds.width * c.scale,
      height: bounds.height * c.scale,
    } as DOMRect;
  } else {
    clone.setAttribute("width", String(Math.max(1, Math.round(r.width / c.scale))));
    clone.setAttribute("height", String(Math.max(1, Math.round(r.height / c.scale))));
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const box = boxOf(c, rect);
  if (!box) return null;
  const xml = new XMLSerializer().serializeToString(clone);
  return {
    kind: "image",
    box,
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    alt: "",
  };
}

/** A connector's drawn extent, from its points, its width added around them. */
function connectorBounds(svg: SVGSVGElement): DOMRect | null {
  const xs: number[] = [];
  const ys: number[] = [];
  let w = 2;
  for (const p of Array.from(svg.querySelectorAll("polyline, polygon"))) {
    w = Math.max(w, Number.parseFloat(p.getAttribute("stroke-width") ?? "") || 0);
    for (const pair of (p.getAttribute("points") ?? "").trim().split(/\s+/)) {
      const [x, y] = pair.split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x as number);
        ys.push(y as number);
      }
    }
  }
  if (xs.length === 0) return null;
  const pad = w * 2;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return new DOMRect(x, y, Math.max(...xs) + pad - x, Math.max(...ys) + pad - y);
}

/**
 * A text item at the element's content box (inside its padding and border), where the words are
 * on screen: the file's text box has no margin of its own.
 */
function textAt(c: SlideCtx, e: Element, st: Style, paras: Para[], items: Item[]): void {
  if (paras.length === 0) return;
  const r = c.g.rect(e);
  const inset = (side: "Top" | "Right" | "Bottom" | "Left") =>
    (px(st[`padding${side}`] ?? "") + px(st[`border${side}Width`] ?? "")) * c.scale;
  const left = inset("Left");
  const top = inset("Top");
  const box = boxOf(c, {
    left: r.left + left,
    top: r.top + top,
    width: Math.max(1, r.width - left - inset("Right")),
    height: Math.max(1, r.height - top - inset("Bottom")),
  });
  if (box) items.push({ kind: "text", box, paras });
}

function hasText(e: Element): boolean {
  for (const n of Array.from(e.childNodes)) {
    if (n.nodeType === 3 && (n.textContent ?? "").trim() !== "") return true;
  }
  return false;
}

/** Whether every child is a phrase (text, b, i, u, a, span, br): the box is one text item. */
function onlyPhrases(e: Element): boolean {
  return Array.from(e.children).every((ch) => INLINE.has(ch.localName));
}

interface Counts {
  embeds: number;
}

function walk(c: SlideCtx, parent: Element, items: Item[], counts: Counts, opacity: number): void {
  for (const e of Array.from(parent.children)) {
    const st = c.g.style(e) as Style;
    if (st.display === "none" || st.visibility === "hidden") continue;
    const own = Number.parseFloat(st.opacity ?? "1");
    const alpha = opacity * (Number.isFinite(own) ? own : 1);
    if (!(alpha > 0.01)) continue;
    const tag = e.localName;
    if (tag === "x-embed") {
      counts.embeds++;
      continue;
    }
    if (tag === "x-icon" || tag === "x-connector") {
      const svg = e.querySelector("svg");
      const color = hexColor(st.color) ?? c.fallbackColor;
      const item = svg
        ? pictureOf(c, svg, color, tag === "x-connector" ? connectorBounds(svg) : null)
        : null;
      if (item) items.push(item);
      continue;
    }
    paintedBox(c, e, st, alpha, items);
    if (tag === "x-shape" || tag === "hr" || tag === "br") continue;
    if (tag === "img") {
      const src = e.getAttribute("src") ?? "";
      const box = boxOf(c, imageRect(c, e as HTMLImageElement));
      const img = e as HTMLImageElement;
      const cover = st.objectFit === "cover" && img.naturalWidth > 0 && img.naturalHeight > 0;
      if (src && box) {
        items.push({
          kind: "image",
          box,
          src,
          alt: e.getAttribute("alt") ?? "",
          ...(cover ? { cover: { ratio: round(img.naturalHeight / img.naturalWidth, 4) } } : {}),
        });
      }
      continue;
    }
    if (tag === "table") {
      tableItem(c, e as HTMLTableElement, items);
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const paras: Para[] = [];
      listParas(c, e, 0, paras);
      textAt(
        c,
        e,
        st,
        paras.map((p) => withFont(c, e, p)),
        items,
      );
      continue;
    }
    if ((hasText(e) || e.children.length > 0) && onlyPhrases(e)) {
      const paras = lines(c, e).map((runs) => withFont(c, e, paraOf(c, e, runs)));
      textAt(c, e, st, paras, items);
      continue;
    }
    walk(c, e, items, counts, alpha);
  }
}

/**
 * A paragraph in the face the screen uses (its first family, unless that is a generic one), and in
 * capitals where the screen sets them (an eyebrow's text-transform).
 */
function withFont(c: SlideCtx, e: Element, p: Para): Para {
  const st = c.g.style(e) as Style;
  const upper = st.textTransform === "uppercase";
  const runs = upper ? p.runs.map((r) => ({ ...r, text: r.text.toUpperCase() })) : p.runs;
  const family = (st.fontFamily ?? "")
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  const generic =
    !family ||
    /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-[a-z-]+)$/i.test(
      family,
    );
  // The .pptx writes the name into its XML as is (typeface="…"), so only a name deck.json could
  // give a face is passed on; any other keeps the slide's default face.
  const named = !generic && family !== undefined && DECK_FAMILY_RE.test(family);
  return { ...p, runs, ...(named ? { font: family } : {}) };
}

/** One HTML slide's model, its embeds counted. The slide must be laid out, at its final look. */
export function htmlSlideModel(
  view: SlideView,
  count: number,
  canvas: { width: number; height: number },
  g: Geometry,
  counts: Counts,
): SlideModel {
  const section = view.el.shadowRoot?.querySelector("body > section") ?? null;
  const origin = g.rect(section ?? view.el);
  const scale = origin.width > 0 ? origin.width / canvas.width : 1;
  const st = section ? (g.style(section) as Style) : null;
  const fallbackColor = (st && hexColor(st.color)) ?? "1F2328";
  const c: SlideCtx = {
    g,
    origin,
    scale,
    canvas,
    count,
    fallbackColor,
    ppi: HTML_PPI,
    phrases: true,
  };
  const items: Item[] = [];
  if (section) walk(c, section, items, counts, 1);
  const bg = st ? fillOf(st, 1) : null;
  return {
    n: view.n,
    notes: notesText(view.notes),
    background: bg && bg.transparency < 100 ? bg.color : "FFFFFF",
    items,
  };
}

/** The whole HTML deck's model, and how many live embeds it left out. */
export function buildHtmlExportModel(
  views: readonly SlideView[],
  deck: Pick<HtmlDeck, "canvas">,
  o: { title: string; geometry: Geometry },
): { model: DeckModel; embedsSkipped: number } {
  const counts: Counts = { embeds: 0 };
  const slides = views.map((v) => htmlSlideModel(v, views.length, deck.canvas, o.geometry, counts));
  return {
    model: {
      title: o.title,
      width: round(deck.canvas.width / HTML_PPI),
      height: round(deck.canvas.height / HTML_PPI),
      theme: "light",
      slides,
    },
    embedsSkipped: counts.embeds,
  };
}
