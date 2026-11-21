// Drawing a board, shared by the whiteboard renderer's view and both of its exports: each shape's
// outline as SVG path data, where a shape's words sit inside it, an arrow's route, heads and label
// place, a table's layout and shading, and a block's text split into lines and inline marks.
//
// Pure: numbers and strings in, numbers and strings out. Nothing here builds or parses markup, so
// whatever a collaborator writes stays text; a link's address is kept only when it parses as an
// http(s) URL.
import {
  type ArrowEndHead,
  type ArrowSide,
  arrowEndpoints,
  arrowLabelAt,
  type BoardArrow,
  type BoardBlock,
  type BoardPaint,
  DEFAULT_TEXT_PX,
  type ShapeKind,
  TEXT_SIZE_PX,
  type TextSize,
} from "./whiteboard.ts";

// Present in browsers, Workers and Node; the shared package compiles without DOM or Node types.
declare class URL {
  constructor(input: string);
  readonly protocol: string;
  readonly href: string;
}

export interface Point {
  x: number;
  y: number;
}

type Box = Pick<BoardBlock, "x" | "y" | "w" | "h">;

const r2 = (n: number) => Math.round(n * 100) / 100;
/** SVG path data from commands and numbers, rounded to hundredths. */
const d = (parts: TemplateStringsArray, ...nums: number[]) =>
  parts.reduce((s, p, i) => s + p + (i < nums.length ? String(r2(nums[i] as number)) : ""), "");

// ---------- shapes ----------

/** A rounded box's path, corners of radius `r` (a note, a section, a table). */
export function roundRectPath(w: number, h: number, r: number): string {
  return d`M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
}

/** A cloud drawn in a 100 x 60 design and scaled to the box: arcs scale exactly. */
const CLOUD: [number, number, number][] = [
  [8, 36, 15],
  [28, 13, 16],
  [65, 8, 20],
  [90, 27, 17],
  [82, 60, 17],
];

/**
 * The outline of a shape `w` by `h`, as SVG path data in the box's own units (0,0 at its top
 * left). A database and a queue add the lip of their visible end as a second, open part.
 */
export function shapePath(kind: ShapeKind, w: number, h: number): string {
  switch (kind) {
    case "rect":
      return d`M0 0H${w}V${h}H0Z`;
    case "rounded":
      return roundRectPath(w, h, Math.min(16, w / 4, h / 4));
    case "pill":
      return roundRectPath(w, h, Math.min(w, h) / 2);
    case "ellipse":
      return d`M0 ${h / 2}A${w / 2} ${h / 2} 0 1 1 ${w} ${h / 2}A${w / 2} ${h / 2} 0 1 1 0 ${h / 2}Z`;
    case "diamond":
      return d`M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case "hexagon": {
      const i = Math.min(w / 4, h / 2);
      return d`M${i} 0H${w - i}L${w} ${h / 2}L${w - i} ${h}H${i}L0 ${h / 2}Z`;
    }
    case "parallelogram": {
      const s = Math.min(w / 4, h / 2);
      return d`M${s} 0H${w}L${w - s} ${h}H0Z`;
    }
    case "database": {
      const e = Math.min(h / 5, w / 4, 18);
      return `${d`M0 ${e}A${w / 2} ${e} 0 0 1 ${w} ${e}V${h - e}A${w / 2} ${e} 0 0 1 0 ${h - e}Z`}${d`M0 ${e}A${w / 2} ${e} 0 0 0 ${w} ${e}`}`;
    }
    case "queue": {
      const e = Math.min(w / 5, h / 4, 18);
      return `${d`M${e} 0H${w - e}A${e} ${h / 2} 0 0 1 ${w - e} ${h}H${e}A${e} ${h / 2} 0 0 1 ${e} 0Z`}${d`M${w - e} 0A${e} ${h / 2} 0 0 0 ${w - e} ${h}`}`;
    }
    case "document": {
      const a = Math.min(h / 8, 12);
      return d`M0 0H${w}V${h - a}Q${w * 0.75} ${h - 3 * a} ${w / 2} ${h - a}T0 ${h - a}Z`;
    }
    case "cloud": {
      const sx = w / 100;
      const sy = h / 60;
      let out = d`M${22 * sx} ${60 * sy}`;
      for (const [x, y, r] of CLOUD) out += d`A${r * sx} ${r * sy} 0 0 1 ${x * sx} ${y * sy}`;
      return `${out}Z`;
    }
    case "person": {
      const r = Math.min(w * 0.18, h * 0.22);
      const cx = w / 2;
      const cy = r + 1;
      const top = 2 * r + Math.max(4, h * 0.06);
      const k = Math.min(w * 0.2, (h - top) / 2);
      return `${d`M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}Z`}${d`M${w * 0.1} ${h}V${top + k}Q${w * 0.1} ${top} ${cx} ${top}Q${w * 0.9} ${top} ${w * 0.9} ${top + k}V${h}Z`}`;
    }
  }
}

/**
 * How far a shape's words sit in from each edge, beyond the block's usual padding, so they stay
 * inside its outline: [top, right, bottom, left]. Zero for a box, an ellipse, a note and text, as
 * they were always drawn.
 */
export function textInset(
  kind: BoardBlock["kind"],
  w: number,
  h: number,
): [number, number, number, number] {
  switch (kind) {
    case "diamond":
      return [h / 4, w / 4, h / 4, w / 4];
    case "hexagon": {
      const i = Math.min(w / 4, h / 2) / 2;
      return [0, i, 0, i];
    }
    case "parallelogram": {
      const s = Math.min(w / 4, h / 2) / 2;
      return [0, s, 0, s];
    }
    case "pill": {
      const r = Math.min(w, h) / 4;
      return [0, r, 0, r];
    }
    case "database": {
      const e = Math.min(h / 5, w / 4, 18);
      return [2 * e, 0, e, 0];
    }
    case "queue": {
      const e = Math.min(w / 5, h / 4, 18);
      return [0, 2 * e, 0, e];
    }
    case "document":
      return [0, 0, 2 * Math.min(h / 8, 12), 0];
    case "cloud":
      return [h * 0.2, w * 0.14, h * 0.08, w * 0.14];
    case "person": {
      const r = Math.min(w * 0.18, h * 0.22);
      return [2 * r + Math.max(4, h * 0.06), w * 0.1, 0, w * 0.1];
    }
    default:
      return [0, 0, 0, 0];
  }
}

// ---------- text ----------

/** A block's text size in board units: its `size`, or 14 when it names none. */
export function textPx(size: TextSize | undefined): number {
  return size ? TEXT_SIZE_PX[size] : DEFAULT_TEXT_PX;
}

/** The line height for a text size: 18 at 14, as before sizes. */
export const lineHeightOf = (px: number) => Math.round(px * 1.3);

/** One stretch of a line with the same marks. `href` is a checked http(s) URL. */
export interface MarkRun {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  href?: string;
}

/** A line of a block's text: its runs, a list item's "• " or "1. " first. */
export type MarkLine = MarkRun[];

/**
 * The inline marks a block's text may carry: ***both***, **bold**, *italic*, `code` and
 * [label](https://…), never nested. Each needs a non-space just inside its stars, so "2 * 3 * 4"
 * stays plain.
 */
const MARK_RE =
  /\*\*\*(\S(?:[^*\n]*?\S)?)\*\*\*|\*\*(\S(?:[^*\n]*?\S)?)\*\*|\*(\S(?:[^*\n]*?\S)?)\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g;
const BULLET_RE = /^(\s*)- (.*)$/;
const NUMBER_RE = /^(\s*)(\d{1,3})\. (.*)$/;

/** An http(s) address as the URL parser reads it, or null. */
export function safeHref(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Whether a text has anything parseMarks would draw differently from the text itself. */
export function hasMarks(text: string): boolean {
  MARK_RE.lastIndex = 0;
  if (MARK_RE.test(text)) return true;
  return text.split("\n").some((l) => BULLET_RE.test(l));
}

function inlineRuns(s: string): MarkRun[] {
  const out: MarkRun[] = [];
  let at = 0;
  MARK_RE.lastIndex = 0;
  for (let m = MARK_RE.exec(s); m; m = MARK_RE.exec(s)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    const [all, both, bold, italic, code, label, url] = m;
    if (both !== undefined) out.push({ text: both, bold: true, italic: true });
    else if (bold !== undefined) out.push({ text: bold, bold: true });
    else if (italic !== undefined) out.push({ text: italic, italic: true });
    else if (code !== undefined) out.push({ text: code, code: true });
    else if (label !== undefined && url !== undefined) {
      const href = safeHref(url);
      out.push(href ? { text: label, href } : { text: all });
    }
    at = m.index + all.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/**
 * A block's text as lines of marked runs: a line that starts "- " is a bullet ("• "), one that
 * starts "1. " keeps its number. Headings and HTML stay as typed: this only splits text, it never
 * reads markup.
 */
export function parseMarks(text: string): MarkLine[] {
  return text.split("\n").map((line) => {
    const bullet = BULLET_RE.exec(line);
    if (bullet) return [{ text: `${bullet[1]}• ` }, ...inlineRuns(bullet[2] ?? "")];
    const num = NUMBER_RE.exec(line);
    if (num) return [{ text: `${num[1]}${num[2]}. ` }, ...inlineRuns(num[3] ?? "")];
    return inlineRuns(line);
  });
}

// ---------- arrows ----------

const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** What each end of an arrow carries: `heads`, or what `head` says (an arrowhead at `to`). */
export function arrowHeads(a: Pick<BoardArrow, "head" | "heads">): [ArrowEndHead, ArrowEndHead] {
  if (a.heads) return a.heads;
  const head = a.head ?? "end";
  return head === "both"
    ? ["arrow", "arrow"]
    : head === "none"
      ? ["none", "none"]
      : ["none", "arrow"];
}

const NORMAL: Record<ArrowSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** The middle of a side, `gap` units outside it. */
function sidePoint(b: Box, side: ArrowSide, gap: number): Point {
  const c = center(b);
  const n = NORMAL[side];
  return { x: c.x + n.x * (b.w / 2 + gap), y: c.y + n.y * (b.h / 2 + gap) };
}

/** The side of a box that faces a point. */
function facing(b: Box, p: Point): ArrowSide {
  const c = center(b);
  const dx = (p.x - c.x) / Math.max(1, b.w / 2);
  const dy = (p.y - c.y) / Math.max(1, b.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const inside = (b: Box, p: Point) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

/** Drop repeated points and the middle of three in a line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    const prev = out[out.length - 2];
    if (prev && last) {
      const sameX = Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01;
      const sameY = Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - p.y) < 0.01;
      if (sameX || sameY) out.pop();
    }
    out.push(p);
  }
  return out;
}

/** How far a right-angle route runs straight out of a side before it turns. */
const STUB = 16;

/** A right-angle route between two sides. */
function sideRoute(a: Box, b: Box, fs: ArrowSide, ts: ArrowSide, gap: number): Point[] {
  const p0 = sidePoint(a, fs, gap);
  const p3 = sidePoint(b, ts, gap);
  const n0 = NORMAL[fs];
  const n3 = NORMAL[ts];
  const s0 = { x: p0.x + n0.x * STUB, y: p0.y + n0.y * STUB };
  const s3 = { x: p3.x + n3.x * STUB, y: p3.y + n3.y * STUB };
  const h0 = n0.y === 0;
  const h3 = n3.y === 0;
  let mid: Point[];
  if (h0 && h3) {
    // Facing each other with room between: one upright leg halfway. Otherwise around.
    const facingEach = n0.x !== n3.x && (p3.x - p0.x) * n0.x >= 0;
    if (facingEach) {
      const mx = (p0.x + p3.x) / 2;
      mid = [
        { x: mx, y: s0.y },
        { x: mx, y: s3.y },
      ];
    } else if (n0.x === n3.x) {
      const x = n0.x > 0 ? Math.max(s0.x, s3.x) : Math.min(s0.x, s3.x);
      mid = [
        { x, y: s0.y },
        { x, y: s3.y },
      ];
    } else {
      const apart = a.y + a.h < b.y || b.y + b.h < a.y;
      const y = apart ? (s0.y + s3.y) / 2 : Math.max(a.y + a.h, b.y + b.h) + STUB;
      mid = [s0, { x: s0.x, y }, { x: s3.x, y }];
    }
  } else if (!h0 && !h3) {
    const facingEach = n0.y !== n3.y && (p3.y - p0.y) * n0.y >= 0;
    if (facingEach) {
      const my = (p0.y + p3.y) / 2;
      mid = [
        { x: s0.x, y: my },
        { x: s3.x, y: my },
      ];
    } else if (n0.y === n3.y) {
      const y = n0.y > 0 ? Math.max(s0.y, s3.y) : Math.min(s0.y, s3.y);
      mid = [
        { x: s0.x, y },
        { x: s3.x, y },
      ];
    } else {
      const apart = a.x + a.w < b.x || b.x + b.w < a.x;
      const x = apart ? (s0.x + s3.x) / 2 : Math.max(a.x + a.w, b.x + b.w) + STUB;
      mid = [s0, { x, y: s0.y }, { x, y: s3.y }];
    }
  } else {
    // One level end and one upright: a single corner, on whichever side runs forward from both.
    const corner = h0 ? { x: s3.x, y: s0.y } : { x: s0.x, y: s3.y };
    mid = [s0, corner, s3];
  }
  return simplify([p0, ...mid, s3, p3]);
}

/**
 * A route planned with `bends` (Claude's whiteboard format): it leaves `from` level ("h") or
 * upright ("v") through the centre, the legs then take turns, each number placing one middle leg
 * (the first half, rounded up, from the centre of `from`, the rest from `to`), and the last leg
 * drops into `to` through its centre. Null when a corner would fall inside either block.
 */
function bendRoute(a: Box, b: Box, bends: ["h" | "v", ...number[]], gap: number): Point[] | null {
  const [dir, ...nums] = bends;
  const ca = center(a);
  const cb = center(b);
  const k = nums.length;
  const fromHalf = Math.ceil(k / 2);
  // Each leg: level (fixed y) or upright (fixed x).
  const legs: { level: boolean; at: number }[] = [];
  const firstLevel = dir === "h";
  legs.push({ level: firstLevel, at: firstLevel ? ca.y : ca.x });
  for (let i = 0; i < k; i++) {
    const level = i % 2 === 0 ? !firstLevel : firstLevel;
    const base = i < fromHalf ? ca : cb;
    const n = nums[i] as number;
    legs.push({ level, at: level ? base.y + n : base.x + n });
  }
  const lastLevel = k % 2 === 0 ? !firstLevel : firstLevel;
  legs.push({ level: lastLevel, at: lastLevel ? cb.y : cb.x });
  const corners: Point[] = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    const l = legs[i] as { level: boolean; at: number };
    const m = legs[i + 1] as { level: boolean; at: number };
    corners.push(l.level ? { x: m.at, y: l.at } : { x: l.at, y: m.at });
  }
  const first = corners[0] as Point;
  const last = corners[corners.length - 1] as Point;
  if (inside(a, first) || inside(b, last)) return null;
  const start: Point = firstLevel
    ? { x: first.x > ca.x ? a.x + a.w + gap : a.x - gap, y: ca.y }
    : { x: ca.x, y: first.y > ca.y ? a.y + a.h + gap : a.y - gap };
  const end: Point = lastLevel
    ? { x: last.x > cb.x ? b.x + b.w + gap : b.x - gap, y: cb.y }
    : { x: cb.x, y: last.y > cb.y ? b.y + b.h + gap : b.y - gap };
  return simplify([start, ...corners, end]);
}

/**
 * The points an arrow from block `a` to block `b` is drawn through. An arrow with no sides and no
 * bends is the straight line between the blocks' centres, clipped at their edges (as every arrow
 * was drawn before sides). With a side, it runs in right angles from that side's middle (the other
 * end takes the side facing it); with `bends`, along that plan when it can be drawn cleanly.
 */
export function arrowRoute(
  a: Box,
  b: Box,
  arrow: Pick<BoardArrow, "fromSide" | "toSide" | "bends">,
  gap = 4,
): Point[] {
  if (arrow.bends) {
    const r = bendRoute(a, b, arrow.bends, gap);
    if (r) return r;
  }
  if (!arrow.fromSide && !arrow.toSide && !arrow.bends) {
    const p = arrowEndpoints(a, b, gap);
    return [
      { x: p.x1, y: p.y1 },
      { x: p.x2, y: p.y2 },
    ];
  }
  const fs = arrow.fromSide ?? facing(a, center(b));
  const ts = arrow.toSide ?? facing(b, center(a));
  return sideRoute(a, b, fs, ts, gap);
}

/** Where a route's label goes: beside the middle of its longest leg (arrowLabelAt). */
export function routeLabelAt(points: readonly Point[]) {
  let best = { x1: 0, y1: 0, x2: 0, y2: 0 };
  let len = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i] as Point;
    const q = points[i + 1] as Point;
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l > len) {
      len = l;
      best = { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
    }
  }
  return arrowLabelAt(best);
}

/** How far a line stops short of an end that carries an arrowhead, so its tip stays sharp. */
const HEAD_TRIM = 6;
const HEAD_SIZE = 10;
export const CIRCLE_HEAD_R = 4.5;

/** The route an arrow's line takes: shortened under the heads it carries. */
export function trimRoute(points: readonly Point[], heads: [ArrowEndHead, ArrowEndHead]): Point[] {
  const out = points.map((p) => ({ ...p }));
  const trim = (end: Point, toward: Point, by: number) => {
    const l = Math.hypot(toward.x - end.x, toward.y - end.y);
    if (l <= by * 2) return;
    end.x += ((toward.x - end.x) / l) * by;
    end.y += ((toward.y - end.y) / l) * by;
  };
  const by = (h: ArrowEndHead) => (h === "arrow" ? HEAD_TRIM : h === "circle" ? CIRCLE_HEAD_R : 0);
  if (out.length >= 2) {
    trim(out[0] as Point, out[1] as Point, by(heads[0]));
    trim(out[out.length - 1] as Point, out[out.length - 2] as Point, by(heads[1]));
  }
  return out;
}

/** SVG path data for a polyline. */
export function routePath(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)} ${r2(p.y)}`).join("");
}

/**
 * The head at `tip`, the end of a leg coming from `from`: a filled triangle pointing along the leg
 * (an arrow) or a filled dot (a circle), as SVG path data; "" for none.
 */
export function headPath(tip: Point, from: Point, kind: ArrowEndHead): string {
  if (kind === "none") return "";
  if (kind === "circle") {
    const r = CIRCLE_HEAD_R;
    return d`M${tip.x - r} ${tip.y}A${r} ${r} 0 1 0 ${tip.x + r} ${tip.y}A${r} ${r} 0 1 0 ${tip.x - r} ${tip.y}Z`;
  }
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const s = HEAD_SIZE;
  return d`M${tip.x} ${tip.y}L${tip.x - s * Math.cos(a - 0.45)} ${tip.y - s * Math.sin(a - 0.45)}L${tip.x - s * Math.cos(a + 0.45)} ${tip.y - s * Math.sin(a + 0.45)}Z`;
}

/** Both heads of a route, from end first: [path data, path data] ("" where an end has none). */
export function routeHeads(
  points: readonly Point[],
  heads: [ArrowEndHead, ArrowEndHead],
): [string, string] {
  if (points.length < 2) return ["", ""];
  const p0 = points[0] as Point;
  const p1 = points[1] as Point;
  const pn = points[points.length - 1] as Point;
  const pm = points[points.length - 2] as Point;
  return [headPath(p0, p1, heads[0]), headPath(pn, pm, heads[1])];
}

// ---------- tables ----------

export interface TableLayout {
  /** Columns left to right: id, x from the table's left and width, in board units. */
  cols: { id: string; x: number; w: number }[];
  /** Rows top to bottom; the first is the header. */
  rows: { id: string; y: number; h: number }[];
}

/** The width weight a column without `w` gets. */
export const DEFAULT_COL_WIDTH = 120;

const byPlace = (a: [string, { at: number }], b: [string, { at: number }]) =>
  a[1].at - b[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Where a table's cells sit: columns in `at` order share its w in proportion to their widths, rows
 * in `at` order share its h equally.
 */
export function tableLayout(b: Pick<BoardBlock, "w" | "h" | "cols" | "rows">): TableLayout {
  const cols = Object.entries(b.cols ?? {}).sort(byPlace);
  const rows = Object.entries(b.rows ?? {}).sort(byPlace);
  const total = cols.reduce((s, [, c]) => s + (c.w ?? DEFAULT_COL_WIDTH), 0) || 1;
  let x = 0;
  const outCols = cols.map(([id, c]) => {
    const w = (b.w * (c.w ?? DEFAULT_COL_WIDTH)) / total;
    const col = { id, x, w };
    x += w;
    return col;
  });
  const rh = rows.length ? b.h / rows.length : b.h;
  return { cols: outCols, rows: rows.map(([id], i) => ({ id, y: i * rh, h: rh })) };
}

/** A cell's number, for heat shading: "1,200", "$20", "35%" and "-4.5" read as numbers. */
export function cellNumber(s: string): number | null {
  const t = s.replace(/[\s,$€£¥%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * How strongly each cell of a shaded column (or row) is tinted, 0 to 1 by its number between the
 * lowest and highest there, keyed "row id\u0000col id" with the colour. The header row is never
 * shaded, nor is a cell that holds no number.
 */
export function heatOf(
  b: Pick<BoardBlock, "w" | "h" | "cols" | "rows" | "heat">,
): Map<string, { paint: BoardPaint; level: number }> {
  const out = new Map<string, { paint: BoardPaint; level: number }>();
  if (!b.heat) return out;
  const layout = tableLayout(b);
  const body = layout.rows.slice(1);
  const lines: { paint: BoardPaint; cells: [string, string][] }[] = [];
  if (b.heat.cols) {
    for (const [cid, paint] of Object.entries(b.heat.cols)) {
      lines.push({ paint, cells: body.map((r) => [r.id, cid]) });
    }
  } else if (b.heat.rows) {
    for (const [rid, paint] of Object.entries(b.heat.rows)) {
      if (rid === layout.rows[0]?.id) continue;
      lines.push({ paint, cells: layout.cols.map((c) => [rid, c.id]) });
    }
  }
  for (const { paint, cells } of lines) {
    const nums = cells
      .map(([rid, cid]) => {
        const v = b.rows?.[rid]?.[cid];
        return [rid, cid, typeof v === "string" ? cellNumber(v) : null] as const;
      })
      .filter((c): c is readonly [string, string, number] => c[2] !== null);
    if (nums.length === 0) continue;
    const lo = Math.min(...nums.map((n) => n[2]));
    const hi = Math.max(...nums.map((n) => n[2]));
    for (const [rid, cid, v] of nums) {
      out.set(`${rid}\u0000${cid}`, { paint, level: hi > lo ? (v - lo) / (hi - lo) : 1 });
    }
  }
  return out;
}

/** Whether `#rrggbb` is dark enough that words on it read best in white. */
export function isDarkHex(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return false;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l < 0.179;
}
