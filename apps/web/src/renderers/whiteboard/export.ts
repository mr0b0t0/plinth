// Export: the board as an SVG (built with DOM APIs, serialized with XMLSerializer) or a PNG (drawn
// with Canvas 2D), downloaded through a blob: link, which the frame's allow-downloads permits. All
// in the frame, from the model: nothing is fetched, no image is loaded, no foreignObject, no link
// (a link in a block's text is drawn as underlined words). Both formats draw the same list of
// primitives (scene), so they always agree. Attribute values come only from numbers, fixed lists
// and colours checked against a pattern; text only goes in as text nodes.
import {
  arrowHeads,
  arrowRoute,
  type BoardBlock,
  type BoardColor,
  type BoardInk,
  type BoardPaint,
  cellText,
  HEX_COLOR_RE,
  heatOf,
  isDarkHex,
  isShapeKind,
  lineHeightOf,
  type MarkRun,
  parseMarks,
  roundRectPath,
  routeHeads,
  routeLabelAt,
  routePath,
  shapePath,
  tableLayout,
  textInset,
  textPx,
  trimRoute,
} from "@plinth/shared";
import type { BoardModel, Bounds } from "./model.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ExportTheme {
  background: string;
  text: string;
  arrow: string;
  border: string;
  /** Fill of a note in each colour, and of a shape with no colour (`none`). */
  fills: Record<BoardColor | "none", string>;
  /** Each colour's deeper tone, for text, outlines and arrows in that colour. */
  inks: Record<BoardColor, string>;
}

/** The light palette, used when the page's tokens cannot be read. */
export const LIGHT_THEME: ExportTheme = {
  background: "#f6f5f1",
  text: "#1d1c1a",
  arrow: "#6b675e",
  border: "#8a857a",
  fills: {
    none: "#ffffff",
    yellow: "#fcefa8",
    green: "#cdebc5",
    blue: "#c9def5",
    pink: "#f6d0dc",
    purple: "#e2d5f5",
    gray: "#e4e2dc",
  },
  inks: {
    yellow: "#8a6a00",
    green: "#2f7a3a",
    blue: "#2b62b0",
    pink: "#b23a64",
    purple: "#6b44b0",
    gray: "#6b675e",
  },
};

const COLOR_KEYS = ["none", "yellow", "green", "blue", "pink", "purple", "gray"] as const;
const INK_KEYS = ["yellow", "green", "blue", "pink", "purple", "gray"] as const;
/** A CSS colour as getComputedStyle returns it: a hex or rgb()/rgba() of plain numbers. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %/]+\))$/i;

/** The export palette from the page's own CSS tokens (light or dark), else LIGHT_THEME. */
export function themeOf(win: Window, el: Element): ExportTheme {
  let style: CSSStyleDeclaration;
  try {
    style = win.getComputedStyle(el);
  } catch {
    return LIGHT_THEME;
  }
  const read = (name: string, fallback: string) => {
    const v = style.getPropertyValue(name).trim();
    return SAFE_COLOR.test(v) ? v : fallback;
  };
  const fills = { ...LIGHT_THEME.fills };
  for (const k of COLOR_KEYS) fills[k] = read(`--wb-fill-${k}`, LIGHT_THEME.fills[k]);
  const inks = { ...LIGHT_THEME.inks };
  for (const k of INK_KEYS) inks[k] = read(`--wb-ink-${k}`, LIGHT_THEME.inks[k]);
  return {
    background: read("--wb-bg", LIGHT_THEME.background),
    text: read("--wb-block-fg", LIGHT_THEME.text),
    arrow: read("--wb-arrow", LIGHT_THEME.arrow),
    border: read("--wb-shape-border", LIGHT_THEME.border),
    fills,
    inks,
  };
}

export const FONT_SIZE = 14;
export const LINE_HEIGHT = 18;
const PAD = 10;
const MARGIN = 40;
const FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const FONT = `${FONT_SIZE}px ${FAMILY}`;

/** Width of a line of text: the canvas's measureText where there is one, else an estimate. */
export type Measure = (s: string, px?: number, bold?: boolean) => number;

export function estimateMeasure(s: string, px = FONT_SIZE, bold = false): number {
  return [...s].length * px * 0.56 * (bold ? 1.06 : 1);
}

const fontOf = (px: number, bold?: boolean, italic?: boolean, code?: boolean) =>
  `${italic ? "italic " : ""}${bold ? "700 " : ""}${px}px ${code ? MONO : FAMILY}`;

/** A measure from a Canvas 2D context, or the estimate when the browser gives none. */
export function canvasMeasure(doc: Document): Measure {
  try {
    const ctx = doc.createElement("canvas").getContext("2d");
    if (!ctx) return estimateMeasure;
    return (s, px = FONT_SIZE, bold = false) => {
      ctx.font = fontOf(px, bold);
      return ctx.measureText(s).width;
    };
  } catch {
    return estimateMeasure;
  }
}

/**
 * The lines a block's text takes at `width`, breaking at spaces (a word wider than the line is cut),
 * at most `maxLines` of them, the last ending in an ellipsis when text was left out.
 */
export function wrapText(
  text: string,
  width: number,
  maxLines: number,
  measure: Measure,
): string[] {
  return layoutLines(
    text.split("\n").map((t) => [{ text: t }]),
    width,
    maxLines,
    FONT_SIZE,
    measure,
    true,
  ).map((l) => l.map((s) => s.text).join(""));
}

/** One stretch of a laid-out line with the same marks. */
export type Seg = Omit<MarkRun, "href"> & { link?: true };

const sameStyle = (a: Seg, b: Seg) =>
  a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.link === b.link;

function styleOf(r: MarkRun): Seg {
  const s: Seg = { text: "" };
  if (r.bold) s.bold = true;
  if (r.italic) s.italic = true;
  if (r.code) s.code = true;
  if (r.href) s.link = true;
  return s;
}

/**
 * Lines of marked runs laid out at `width`: words wrap at spaces (when `wrap`), a word wider than
 * the line is cut, and past `maxLines` the last line ends in an ellipsis.
 */
export function layoutLines(
  lines: MarkRun[][],
  width: number,
  maxLines: number,
  px: number,
  measure: Measure,
  wrap: boolean,
): Seg[][] {
  const out: Seg[][] = [];
  const room = Math.max(1, maxLines);
  for (const runs of lines) {
    let line: Seg[] = [];
    let used = 0;
    const push = (text: string, style: Seg) => {
      const last = line[line.length - 1];
      if (last && sameStyle(last, style)) last.text += text;
      else line.push({ ...style, text });
    };
    const breakLine = () => {
      const last = line[line.length - 1];
      if (last) last.text = last.text.replace(/\s+$/, "");
      out.push(line.filter((s) => s.text));
      line = [];
      used = 0;
    };
    for (const run of runs) {
      const style = styleOf(run);
      for (const token of run.text.split(/(\s+)/)) {
        if (!token) continue;
        const w = measure(token, px, style.bold);
        if (/^\s+$/.test(token)) {
          if (used === 0 && line.length === 0) continue;
          push(token, style);
          used += w;
          continue;
        }
        if (wrap && used > 0 && used + w > width) breakLine();
        let word = token;
        // A word wider than a whole line: cut it into pieces that fit.
        while (wrap && measure(word, px, style.bold) > width && [...word].length > 1) {
          const chars = [...word];
          let n = chars.length - 1;
          while (n > 1 && measure(chars.slice(0, n).join(""), px, style.bold) > width) n--;
          if (used > 0) breakLine();
          push(chars.slice(0, n).join(""), style);
          breakLine();
          word = chars.slice(n).join("");
        }
        push(word, style);
        used += measure(word, px, style.bold);
      }
    }
    breakLine();
  }
  if (out.length <= room) return out;
  const kept = out.slice(0, room);
  const last = kept[room - 1] ?? [];
  const tail = last[last.length - 1];
  if (tail) tail.text = `${tail.text}…`;
  else last.push({ text: "…" });
  return kept;
}

/** The area exported: every block, with a margin; a small empty area for an empty board. */
export function exportBounds(model: BoardModel): Bounds {
  const b = model.bounds() ?? { x: 0, y: 0, w: 320, h: 200 };
  return { x: b.x - MARGIN, y: b.y - MARGIN, w: b.w + MARGIN * 2, h: b.h + MARGIN * 2 };
}

// ---------- the scene ----------

/** Path data drawn at (x, y): filled and or stroked. */
interface PathPrim {
  t: "path";
  d: string;
  x: number;
  y: number;
  fill: string | null;
  stroke: string | null;
  width: number;
  dash?: boolean;
  /** Opacity of the fill (a section's tint, a table's shading). */
  fillOpacity?: number;
}

/** One line of text, its top at y, anchored at x. */
interface TextPrim {
  t: "text";
  x: number;
  y: number;
  px: number;
  anchor: "start" | "middle" | "end";
  fill: string;
  segs: Seg[];
  /** A halo in this colour behind the words (an arrow's label). */
  halo?: string;
  /** Every segment bold (a table's header, a section's title). */
  bold?: boolean;
}

type Prim = PathPrim | TextPrim;

const hex = (v: string | undefined): v is string => typeof v === "string" && HEX_COLOR_RE.test(v);

function fillOf(theme: ExportTheme, paint: BoardPaint | undefined, fallback: string): string {
  if (hex(paint)) return paint;
  return paint ? theme.fills[paint as BoardColor] : fallback;
}

function inkOf(theme: ExportTheme, ink: BoardInk | undefined, fallback: string): string {
  if (hex(ink)) return ink;
  if (ink === "ink") return theme.text;
  return ink ? theme.inks[ink as BoardColor] : fallback;
}

/** The words' colour on a fill: the board's text, or white on a dark #rrggbb. */
const textOn = (theme: ExportTheme, paint: BoardPaint | undefined) =>
  hex(paint) ? (isDarkHex(paint) ? "#ffffff" : "#1d1c1a") : theme.text;

/** Lay a block's text out inside its box: one TextPrim per line. */
function blockText(
  b: BoardBlock,
  measure: Measure,
  fill: string,
  out: Prim[],
  box = { x: b.x, y: b.y, w: b.w, h: b.h },
  centered = false,
  bold = false,
): void {
  if (!b.text) return;
  const px = textPx(b.size);
  const lh = lineHeightOf(px);
  const [t, r, bt, l] = textInset(b.kind, box.w, box.h);
  const innerW = Math.max(1, box.w - PAD * 2 - l - r);
  const innerH = box.h - PAD * 2 - t - bt;
  const lines = layoutLines(
    parseMarks(b.text),
    innerW,
    Math.floor(innerH / lh),
    px,
    measure,
    b.wrap !== false,
  );
  const align = b.textAlign ?? (centered ? "center" : "left");
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x =
    align === "center"
      ? box.x + l + (box.w - l - r) / 2
      : align === "right"
        ? box.x + box.w - PAD - r
        : box.x + PAD + l;
  const top = centered ? box.y + t + (box.h - t - bt - lines.length * lh) / 2 : box.y + PAD + t;
  for (const [i, segs] of lines.entries()) {
    if (segs.length === 0) continue;
    out.push({ t: "text", x, y: top + i * lh + (lh - px) / 2, px, anchor, fill, segs, bold });
  }
}

function tableScene(theme: ExportTheme, b: BoardBlock, measure: Measure, out: Prim[]): void {
  const layout = tableLayout(b);
  const heat = heatOf(b);
  out.push({
    t: "path",
    d: roundRectPath(b.w, b.h, 4),
    x: b.x,
    y: b.y,
    fill: theme.fills.none,
    stroke: theme.border,
    width: 1,
  });
  for (const [ri, row] of layout.rows.entries()) {
    const head = ri === 0;
    if (head) {
      out.push({
        t: "path",
        d: `M0 0H${b.w}V${row.h}H0Z`,
        x: b.x,
        y: b.y + row.y,
        fill: fillOf(theme, b.color, theme.fills.gray),
        stroke: null,
        width: 0,
      });
    } else {
      out.push({
        t: "path",
        d: `M0 0H${b.w}`,
        x: b.x,
        y: b.y + row.y,
        fill: null,
        stroke: theme.border,
        width: 0.5,
      });
    }
    for (const col of layout.cols) {
      const cell = cellText(b, row.id, col.id);
      const fill = b.fills?.[row.id]?.[col.id];
      const shade = heat.get(`${row.id}\u0000${col.id}`);
      const at = { x: b.x + col.x, y: b.y + row.y, w: col.w, h: row.h };
      if (fill) {
        out.push({
          t: "path",
          d: `M0 0H${col.w}V${row.h}H0Z`,
          x: at.x,
          y: at.y,
          fill: fillOf(theme, fill, theme.fills.none),
          stroke: null,
          width: 0,
        });
      } else if (shade) {
        out.push({
          t: "path",
          d: `M0 0H${col.w}V${row.h}H0Z`,
          x: at.x,
          y: at.y,
          fill: hex(shade.paint) ? shade.paint : theme.inks[shade.paint as BoardColor],
          stroke: null,
          width: 0,
          fillOpacity: 0.12 + shade.level * 0.5,
        });
      }
      if (typeof cell === "string" && cell) {
        blockText(
          { ...b, kind: "table", text: cell, wrap: true },
          measure,
          fill ? textOn(theme, fill) : theme.text,
          out,
          at,
          false,
          head,
        );
      }
    }
  }
}

/**
 * What the board looks like, back to front: sections, then arrows, then every other block, each
 * as paths and lines of text. The view draws the same order.
 */
export function scene(model: BoardModel, theme: ExportTheme, measure: Measure): Prim[] {
  const out: Prim[] = [];
  const ordered = model.ordered();
  const blocks = (sections: boolean) =>
    ordered.filter(([, e]) => (e.data.kind === "container") === sections);

  for (const [, { data: b }] of blocks(true)) {
    out.push({
      t: "path",
      d: roundRectPath(b.w, b.h, 12),
      x: b.x,
      y: b.y,
      fill: b.hollow ? null : fillOf(theme, b.color, theme.fills.none),
      stroke: inkOf(theme, b.stroke, theme.border),
      width: 1,
      fillOpacity: 0.45,
    });
    if (b.text) {
      // The title stands above the section's box, on one line.
      const px = b.size ? textPx(b.size) : 16;
      const lines = layoutLines(parseMarks(b.text).slice(0, 1), b.w, 1, px, measure, false);
      const segs = lines[0] ?? [];
      if (segs.length) {
        out.push({
          t: "text",
          x: b.x,
          y: b.y - 6 - lineHeightOf(px) + (lineHeightOf(px) - px) / 2,
          px,
          anchor: "start",
          fill: theme.text,
          segs,
          bold: true,
        });
      }
    }
  }

  for (const [, { data: a }] of model.arrows) {
    const from = model.blocks.get(a.from)?.data;
    const to = model.blocks.get(a.to)?.data;
    if (!from || !to) continue;
    const route = arrowRoute(from, to, a);
    const heads = arrowHeads(a);
    const color = inkOf(theme, a.color, theme.arrow);
    out.push({
      t: "path",
      d: routePath(trimRoute(route, heads)),
      x: 0,
      y: 0,
      fill: null,
      stroke: color,
      width: 2,
      dash: a.style === "dashed",
    });
    for (const d of routeHeads(route, heads)) {
      if (d) out.push({ t: "path", d, x: 0, y: 0, fill: color, stroke: null, width: 0 });
    }
    if (a.label) {
      // A halo in the background colour keeps the label clear of the line it sits beside.
      const at = routeLabelAt(route);
      out.push({
        t: "text",
        x: at.x,
        y: at.y - 7,
        px: 13,
        anchor: at.anchor,
        fill: theme.text,
        segs: [{ text: a.label }],
        halo: theme.background,
      });
    }
  }

  for (const [, { data: b }] of blocks(false)) {
    if (b.kind === "table") {
      tableScene(theme, b, measure, out);
      continue;
    }
    if (b.kind !== "text") {
      const note = b.kind === "note";
      const shaped = isShapeKind(b.kind);
      const fallback = note ? theme.fills.yellow : theme.fills.none;
      const outline = shaped || b.stroke !== undefined;
      out.push({
        t: "path",
        d:
          note || b.kind === "rect"
            ? roundRectPath(b.w, b.h, note ? 6 : 2)
            : shapePath(isShapeKind(b.kind) ? b.kind : "rect", b.w, b.h),
        x: b.x,
        y: b.y,
        fill: b.hollow ? null : fillOf(theme, b.color, fallback),
        stroke: outline ? inkOf(theme, b.stroke, theme.border) : null,
        width: 1.5,
      });
    }
    const ink =
      b.kind === "text"
        ? inkOf(theme, b.color, theme.text)
        : b.hollow
          ? theme.text
          : textOn(theme, b.color);
    blockText(b, measure, ink, out, undefined, isShapeKind(b.kind));
  }
  return out;
}

// ---------- SVG ----------

/** The board as an <svg> element of `doc` (not attached). */
export function boardSvg(
  doc: Document,
  model: BoardModel,
  theme: ExportTheme,
  measure: Measure = estimateMeasure,
): SVGSVGElement {
  const el = <K extends keyof SVGElementTagNameMap>(
    name: K,
    attrs: Record<string, string | number>,
  ) => {
    const e = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const r = exportBounds(model);
  const svg = el("svg", {
    xmlns: SVG_NS,
    viewBox: `${r.x} ${r.y} ${r.w} ${r.h}`,
    width: r.w,
    height: r.h,
    "font-family": "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    "font-size": FONT_SIZE,
  });
  svg.append(el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: theme.background }));
  for (const p of scene(model, theme, measure)) {
    if (p.t === "path") {
      const path = el("path", { d: p.d });
      if (p.x || p.y) path.setAttribute("transform", `translate(${p.x} ${p.y})`);
      path.setAttribute("fill", p.fill ?? "none");
      if (p.fillOpacity !== undefined) path.setAttribute("fill-opacity", String(p.fillOpacity));
      if (p.stroke) {
        path.setAttribute("stroke", p.stroke);
        path.setAttribute("stroke-width", String(p.width));
        path.setAttribute("stroke-linejoin", "round");
        if (p.dash) path.setAttribute("stroke-dasharray", "6 4");
      }
      svg.append(path);
      continue;
    }
    const t = el("text", {
      x: p.x,
      y: p.y,
      "font-size": p.px,
      fill: p.fill,
      "text-anchor": p.anchor,
      "dominant-baseline": "hanging",
    });
    if (p.bold) t.setAttribute("font-weight", "700");
    if (p.halo) {
      t.setAttribute("stroke", p.halo);
      t.setAttribute("stroke-width", "4");
      t.setAttribute("stroke-linejoin", "round");
      t.setAttribute("paint-order", "stroke");
    }
    for (const s of p.segs) {
      if (!s.bold && !s.italic && !s.code && !s.link && p.segs.length === 1) {
        t.textContent = s.text;
        break;
      }
      const span = el("tspan", {});
      if (s.bold) span.setAttribute("font-weight", "700");
      if (s.italic) span.setAttribute("font-style", "italic");
      if (s.code) span.setAttribute("font-family", "ui-monospace, Menlo, Consolas, monospace");
      if (s.link) span.setAttribute("text-decoration", "underline");
      span.textContent = s.text;
      t.append(span);
    }
    svg.append(t);
  }
  return svg;
}

/** The SVG file: XML text of boardSvg. */
export function svgBlob(svg: SVGSVGElement): Blob {
  const text = new XMLSerializer().serializeToString(svg);
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${text}`], { type: "image/svg+xml" });
}

// ---------- PNG ----------

/** At most this many pixels in a PNG, and this long a side. */
export const PNG_MAX_PIXELS = 32_000_000;
export const PNG_MAX_SIDE = 8192;

/** The scale a PNG of a `w` by `h` board is drawn at: 2, or less to stay within both caps. */
export function pngScale(w: number, h: number, maxSide = PNG_MAX_SIDE): number {
  let s = Math.min(2, maxSide / Math.max(w, h, 1));
  if (w * s * (h * s) > PNG_MAX_PIXELS) s = Math.sqrt(PNG_MAX_PIXELS / (w * h));
  return s;
}

/** The board drawn on a canvas of `doc`, or null when the browser gives no 2D context. */
export function drawPng(
  doc: Document,
  model: BoardModel,
  theme: ExportTheme,
  maxSide = PNG_MAX_SIDE,
): HTMLCanvasElement | null {
  const r = exportBounds(model);
  const scale = pngScale(r.w, r.h, maxSide);
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(r.w * scale));
  canvas.height = Math.max(1, Math.floor(r.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.translate(-r.x, -r.y);
  ctx.fillStyle = theme.background;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const measure: Measure = (s, px = FONT_SIZE, bold = false) => {
    ctx.font = fontOf(px, bold);
    return ctx.measureText(s).width;
  };
  ctx.lineJoin = "round";
  for (const p of scene(model, theme, measure)) {
    if (p.t === "path") {
      if (typeof Path2D !== "function") continue;
      const path = new Path2D(p.d);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.fill) {
        ctx.globalAlpha = p.fillOpacity ?? 1;
        ctx.fillStyle = p.fill;
        ctx.fill(path);
        ctx.globalAlpha = 1;
      }
      if (p.stroke) {
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.width;
        ctx.setLineDash(p.dash ? [6, 4] : []);
        ctx.stroke(path);
      }
      ctx.restore();
      continue;
    }
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const fonts = p.segs.map((s) => fontOf(p.px, p.bold || s.bold, s.italic, s.code));
    const widths = p.segs.map((s, i) => {
      ctx.font = fonts[i] ?? FONT;
      return ctx.measureText(s.text).width;
    });
    const total = widths.reduce((a, b) => a + b, 0);
    let x = p.anchor === "middle" ? p.x - total / 2 : p.anchor === "end" ? p.x - total : p.x;
    for (const [i, s] of p.segs.entries()) {
      ctx.font = fonts[i] ?? FONT;
      if (p.halo) {
        ctx.strokeStyle = p.halo;
        ctx.lineWidth = 4;
        ctx.strokeText(s.text, x, p.y);
      }
      ctx.fillStyle = p.fill;
      ctx.fillText(s.text, x, p.y);
      const w = widths[i] ?? 0;
      if (s.link) ctx.fillRect(x, p.y + p.px + 1, w, Math.max(1, p.px / 14));
      x += w;
    }
  }
  return canvas;
}

/** The PNG file of a canvas. */
export function pngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/** A file name from the board's title: letters, digits and dashes. */
export function exportName(title: string, ext: "png" | "svg"): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "whiteboard"}.${ext}`;
}

/** Download a file made in the frame: a blob: link with the download attribute. */
export function download(doc: Document, blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
