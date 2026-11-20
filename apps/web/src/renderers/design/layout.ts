// Where each artboard sits on the canvas and how the view transforms it. Pure: world coordinates
// are CSS px at 100%; a transform maps them to the screen as screen = world * scale + (x, y).
//
// Boards are laid out in rows, left to right, in source order. Consecutive sections share a row,
// with a wider gap between sections than between boards, and a section moves to the next row
// whole when it does not fit. The row width is the one at which the whole layout, fitted into an
// area of the given aspect ratio, shows at the largest scale, so the first view fills the screen.
// The gaps grow with the design's tallest board (`unit`), so the band for labels, which keep
// their screen size at every zoom, still has room when a design of big boards is fitted.
import { DESIGN_LIMITS, type DesignBoard } from "@plinth/shared";

export const LAYOUT = {
  /** Between boards of one section in a row. */
  gap: 64,
  /** Between the last board of one section and the first board of the next in a row. */
  sectionGap: 160,
  /** The label band over each board (its name). */
  label: 28,
  /** Between rows: room for the next row's labels when a design is fitted. */
  rowGap: 96,
  /** The aspect ratio (width / height) a layout is made for when the viewport's is unknown. */
  aspect: 16 / 10,
  /** The tallest board at which the gaps above are used as they are; taller ones scale them. */
  unitHeight: 600,
  maxUnit: 6,
} as const;

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
}

export interface LayoutRow {
  /** The row's top, where its labels begin. */
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  items: LayoutItem[];
  rows: LayoutRow[];
  bounds: Rect;
  /** What every gap in LAYOUT is multiplied by for this design (1 for boards up to 600 px tall). */
  unit: number;
}

/** The gap multiplier for a design whose tallest board is `tallest` px. */
export function layoutUnit(tallest: number): number {
  return Math.min(LAYOUT.maxUnit, Math.max(1, tallest / LAYOUT.unitHeight));
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Room kept clear on each side of the viewport when fitting. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type Board = Pick<DesignBoard, "id" | "width" | "height" | "section">;

/** Consecutive boards of one section (or of none). */
function runsOf(boards: readonly Board[]): Board[][] {
  const runs: Board[][] = [];
  for (const b of boards) {
    const last = runs.at(-1);
    if (last && (last[0]?.section ?? null) === (b.section ?? null)) last.push(b);
    else runs.push([b]);
  }
  return runs;
}

/** The rows for one row width: greedy, a section moving to the next row when it does not fit. */
function pack(runs: readonly Board[][], maxWidth: number, unit: number): Layout {
  const gap = LAYOUT.gap * unit;
  const sectionGap = LAYOUT.sectionGap * unit;
  const label = LAYOUT.label * unit;
  const rowGap = LAYOUT.rowGap * unit;
  const items: LayoutItem[] = [];
  const rows: LayoutRow[] = [{ y: 0 }];
  let width = 0;
  let x = 0;
  let tallest = 0;
  const newRow = () => {
    const prev = rows.at(-1)?.y ?? 0;
    width = Math.max(width, x);
    rows.push({ y: prev + label + tallest + rowGap });
    x = 0;
    tallest = 0;
  };
  for (const run of runs) {
    const runWidth = run.reduce((s, b) => s + b.width, 0) + gap * (run.length - 1);
    if (x > 0 && x + sectionGap + runWidth > maxWidth) newRow();
    run.forEach((b, k) => {
      if (x > 0 && x + (k === 0 ? sectionGap : gap) + b.width > maxWidth) newRow();
      const left = x === 0 ? 0 : x + (k === 0 ? sectionGap : gap);
      const top = (rows.at(-1)?.y ?? 0) + label;
      items.push({ id: b.id, x: left, y: top, w: b.width, h: b.height, row: rows.length - 1 });
      x = left + b.width;
      tallest = Math.max(tallest, b.height);
    });
  }
  width = Math.max(width, x);
  const h = items.length ? (rows.at(-1)?.y ?? 0) + label + tallest : 0;
  return { items, rows, bounds: { x: 0, y: 0, w: width, h }, unit };
}

/**
 * Lays the boards out for an area of `aspect` (width / height of the room boards are fitted
 * into). Every width at which a first row could end is tried, and the layout that fits that area
 * at the largest scale wins; the narrowest wins a tie.
 */
export function layoutBoards(boards: readonly Board[], aspect: number = LAYOUT.aspect): Layout {
  const unit = layoutUnit(boards.reduce((m, b) => Math.max(m, b.height), 0));
  const runs = runsOf(boards);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : LAYOUT.aspect;
  const widths: number[] = [];
  let x = 0;
  for (const [r, run] of runs.entries()) {
    for (const [k, b] of run.entries()) {
      if (x > 0) x += (k === 0 && r > 0 ? LAYOUT.sectionGap : LAYOUT.gap) * unit;
      x += b.width;
      widths.push(x);
    }
  }
  let best = pack(runs, 0, unit);
  let bestScale = -1;
  for (const w of widths) {
    const l = pack(runs, w, unit);
    const scale = Math.min(ratio / Math.max(l.bounds.w, 1), 1 / Math.max(l.bounds.h, 1));
    if (scale > bestScale * (1 + 1e-9)) {
      best = l;
      bestScale = scale;
    }
  }
  return best;
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(DESIGN_LIMITS.maxZoom, Math.max(DESIGN_LIMITS.minZoom, scale));
}

const insetsOf = (p: number | Insets): Insets =>
  typeof p === "number" ? { top: p, right: p, bottom: p, left: p } : p;

/**
 * The transform that shows `rect` whole and centred in the room `padding` leaves (one number for
 * every side, or one per side), never above `maxScale` (100% by default, so a small design is not
 * blown up).
 */
export function fitTransform(
  rect: Rect,
  viewport: Size,
  padding: number | Insets = 48,
  maxScale = 1,
): Transform {
  const p = insetsOf(padding);
  const w = Math.max(viewport.width - p.left - p.right, 1);
  const h = Math.max(viewport.height - p.top - p.bottom, 1);
  const scale = clampZoom(Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1), maxScale));
  return {
    scale,
    x: p.left + (w - rect.w * scale) / 2 - rect.x * scale,
    y: p.top + (h - rect.h * scale) / 2 - rect.y * scale,
  };
}

/** Zoom by `factor`, keeping the world point under `point` (screen px) where it is. */
export function zoomAt(t: Transform, factor: number, point: { x: number; y: number }): Transform {
  const scale = clampZoom(t.scale * factor);
  const k = scale / t.scale;
  return { scale, x: point.x - (point.x - t.x) * k, y: point.y - (point.y - t.y) * k };
}

/** Show one board (with its label band of `label` world px) whole, centred, at most at 100%. */
export function zoomToBoard(
  item: Rect,
  viewport: Size,
  padding: number | Insets = 48,
  label: number = LAYOUT.label,
): Transform {
  return fitTransform(
    { x: item.x, y: item.y - label, w: item.w, h: item.h + label },
    viewport,
    padding,
  );
}

/** A board's rectangle on the screen. */
export function screenRect(item: Rect, t: Transform): Rect {
  return {
    x: t.x + item.x * t.scale,
    y: t.y + item.y * t.scale,
    w: item.w * t.scale,
    h: item.h * t.scale,
  };
}

/**
 * The boards on the screen (or within `margin` px of it), nearest the viewport's centre first, so
 * the frames that may stay alive go to the boards a person is looking at.
 */
export function visibleBoards(
  items: readonly LayoutItem[],
  t: Transform,
  viewport: Size,
  margin = 200,
): string[] {
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const seen: { id: string; d: number }[] = [];
  for (const it of items) {
    const r = screenRect(it, t);
    if (r.x > viewport.width + margin || r.y > viewport.height + margin) continue;
    if (r.x + r.w < -margin || r.y + r.h < -margin) continue;
    const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
    const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
    seen.push({ id: it.id, d: dx * dx + dy * dy });
  }
  seen.sort((a, b) => a.d - b.d);
  return seen.map((s) => s.id);
}
