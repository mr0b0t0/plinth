// Export: the board as an SVG (built with DOM APIs, serialized with XMLSerializer) or a PNG (drawn
// with Canvas 2D), downloaded through a blob: link, which the frame's allow-downloads permits. All
// in the frame, from the model: nothing is fetched, no image is loaded, no foreignObject, no link.
// Attribute values come only from numbers and fixed lists; text only goes in as text nodes.
import { arrowEndpoints, arrowLabelAt, type BlockKind, type BoardColor } from "@plinth/shared";
import type { BoardModel, Bounds } from "./model.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ExportTheme {
  background: string;
  text: string;
  arrow: string;
  border: string;
  /** Fill of a note in each colour, and of a shape with no colour (`none`). */
  fills: Record<BoardColor | "none", string>;
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
};

const COLOR_KEYS = ["none", "yellow", "green", "blue", "pink", "purple", "gray"] as const;
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
  return {
    background: read("--wb-bg", LIGHT_THEME.background),
    text: read("--wb-block-fg", LIGHT_THEME.text),
    arrow: read("--wb-arrow", LIGHT_THEME.arrow),
    border: read("--wb-shape-border", LIGHT_THEME.border),
    fills,
  };
}

export const FONT_SIZE = 14;
export const LINE_HEIGHT = 18;
const PAD = 10;
const MARGIN = 40;
export const FONT = `${FONT_SIZE}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Width of a line of text: the canvas's measureText where there is one, else an estimate. */
export type Measure = (s: string) => number;

export function estimateMeasure(s: string): number {
  return [...s].length * FONT_SIZE * 0.56;
}

/** A measure from a Canvas 2D context, or the estimate when the browser gives none. */
export function canvasMeasure(doc: Document): Measure {
  try {
    const ctx = doc.createElement("canvas").getContext("2d");
    if (!ctx) return estimateMeasure;
    ctx.font = FONT;
    return (s) => ctx.measureText(s).width;
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
  const out: string[] = [];
  const room = Math.max(1, maxLines);
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (measure(w) > width && [...w].length > 1) {
        const chars = [...w];
        let n = chars.length - 1;
        while (n > 1 && measure(chars.slice(0, n).join("")) > width) n--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(chars.slice(0, n).join(""));
        w = chars.slice(n).join("");
      }
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > width) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  if (out.length <= room) return out;
  const kept = out.slice(0, room);
  kept[room - 1] = `${kept[room - 1] ?? ""}…`;
  return kept;
}

/** The area exported: every block, with a margin; a small empty area for an empty board. */
export function exportBounds(model: BoardModel): Bounds {
  const b = model.bounds() ?? { x: 0, y: 0, w: 320, h: 200 };
  return { x: b.x - MARGIN, y: b.y - MARGIN, w: b.w + MARGIN * 2, h: b.h + MARGIN * 2 };
}

const fillOf = (theme: ExportTheme, kind: BlockKind, color: BoardColor | undefined) =>
  kind === "text" ? "none" : theme.fills[color ?? (kind === "note" ? "yellow" : "none")];

const textLines = (b: { w: number; h: number; text: string }, measure: Measure) =>
  wrapText(b.text, b.w - PAD * 2, Math.floor((b.h - PAD * 2) / LINE_HEIGHT), measure);

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
  const defs = el("defs", {});
  const marker = el("marker", {
    id: "head",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 8,
    markerHeight: 8,
    orient: "auto-start-reverse",
  });
  marker.append(el("path", { d: "M0 0 10 5 0 10z", fill: theme.arrow }));
  defs.append(marker);
  svg.append(defs, el("rect", { x: r.x, y: r.y, width: r.w, height: r.h, fill: theme.background }));

  for (const [, { data: a }] of model.arrows) {
    const from = model.blocks.get(a.from)?.data;
    const to = model.blocks.get(a.to)?.data;
    if (!from || !to) continue;
    const p = arrowEndpoints(from, to);
    const head = a.head ?? "end";
    const line = el("line", { ...p, stroke: theme.arrow, "stroke-width": 2 });
    if (a.style === "dashed") line.setAttribute("stroke-dasharray", "6 4");
    if (head !== "none") line.setAttribute("marker-end", "url(#head)");
    if (head === "both") line.setAttribute("marker-start", "url(#head)");
    svg.append(line);
    if (a.label) {
      // A halo in the background colour keeps the label clear of the line it sits beside.
      const at = arrowLabelAt(p);
      const t = el("text", {
        x: at.x,
        y: at.y,
        "text-anchor": at.anchor,
        "dominant-baseline": "central",
        fill: theme.text,
        stroke: theme.background,
        "stroke-width": 4,
        "stroke-linejoin": "round",
        "paint-order": "stroke",
      });
      t.textContent = a.label;
      svg.append(t);
    }
  }

  for (const [, { data: b }] of model.ordered()) {
    const fill = fillOf(theme, b.kind, b.color);
    const shape =
      b.kind === "ellipse"
        ? el("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 })
        : el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.kind === "note" ? 6 : 2 });
    shape.setAttribute("fill", fill);
    if (b.kind === "rect" || b.kind === "ellipse") {
      shape.setAttribute("stroke", theme.border);
      shape.setAttribute("stroke-width", "1.5");
    }
    svg.append(shape);
    const lines = textLines(b, measure);
    if (lines.some(Boolean)) {
      const centered = b.kind === "rect" || b.kind === "ellipse";
      const top = centered ? b.y + (b.h - lines.length * LINE_HEIGHT) / 2 : b.y + PAD;
      const t = el("text", {
        x: centered ? b.x + b.w / 2 : b.x + PAD,
        y: top,
        fill: theme.text,
        "text-anchor": centered ? "middle" : "start",
        "dominant-baseline": "hanging",
      });
      for (const [i, line] of lines.entries()) {
        const s = el("tspan", { x: t.getAttribute("x") ?? 0, dy: i === 0 ? 0 : LINE_HEIGHT });
        s.textContent = line;
        t.append(s);
      }
      svg.append(t);
    }
  }
  return svg;
}

/** The SVG file: XML text of boardSvg. */
export function svgBlob(svg: SVGSVGElement): Blob {
  const text = new XMLSerializer().serializeToString(svg);
  return new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${text}`], { type: "image/svg+xml" });
}

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
  ctx.font = FONT;
  const measure: Measure = (s) => ctx.measureText(s).width;

  ctx.lineWidth = 2;
  for (const [, { data: a }] of model.arrows) {
    const from = model.blocks.get(a.from)?.data;
    const to = model.blocks.get(a.to)?.data;
    if (!from || !to) continue;
    const p = arrowEndpoints(from, to);
    ctx.strokeStyle = theme.arrow;
    ctx.fillStyle = theme.arrow;
    ctx.setLineDash(a.style === "dashed" ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(p.x1, p.y1);
    ctx.lineTo(p.x2, p.y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const head = a.head ?? "end";
    if (head !== "none") arrowHead(ctx, p.x1, p.y1, p.x2, p.y2);
    if (head === "both") arrowHead(ctx, p.x2, p.y2, p.x1, p.y1);
    if (a.label) {
      const at = arrowLabelAt(p);
      ctx.textAlign = at.anchor === "middle" ? "center" : at.anchor === "end" ? "right" : "left";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = theme.background;
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeText(a.label, at.x, at.y);
      ctx.lineWidth = 2;
      ctx.fillStyle = theme.text;
      ctx.fillText(a.label, at.x, at.y);
    }
  }

  for (const [, { data: b }] of model.ordered()) {
    const fill = fillOf(theme, b.kind, b.color);
    ctx.beginPath();
    if (b.kind === "ellipse") {
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    } else if (typeof ctx.roundRect === "function") {
      ctx.roundRect(b.x, b.y, b.w, b.h, b.kind === "note" ? 6 : 2);
    } else {
      ctx.rect(b.x, b.y, b.w, b.h);
    }
    if (fill !== "none") {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (b.kind === "rect" || b.kind === "ellipse") {
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    const lines = textLines(b, measure);
    const centered = b.kind === "rect" || b.kind === "ellipse";
    ctx.fillStyle = theme.text;
    ctx.textAlign = centered ? "center" : "left";
    ctx.textBaseline = "top";
    const top = centered ? b.y + (b.h - lines.length * LINE_HEIGHT) / 2 : b.y + PAD;
    for (const [i, line] of lines.entries()) {
      ctx.fillText(line, centered ? b.x + b.w / 2 : b.x + PAD, top + i * LINE_HEIGHT);
    }
  }
  return canvas;
}

function arrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const s = 10;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45));
  ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
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
