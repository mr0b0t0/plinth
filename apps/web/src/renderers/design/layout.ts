// Where each artboard sits on the canvas and how the view transforms it. Pure: world coordinates
// are CSS px at 100%; a transform maps them to the screen as screen = world * scale + (x, y).
//
// Boards are laid out in rows, left to right: consecutive boards of one section form a row headed
// by the section's name, and a row that would grow wider than rowMaxWidth wraps. The gaps grow with
// the design's tallest board (`unit`), so the bands for labels and headings, which keep their
// screen size at every zoom, still have room when a design of big boards is fitted.
import { DESIGN_LIMITS, type DesignBoard } from "@plinth/shared";

export const LAYOUT = {
  /** Between boards in a row. */
  gap: 64,
  /** The label band over each board (name and size). */
  label: 28,
  /** Between rows. */
  rowGap: 48,
  /** A section heading over its first row. */
  heading: 44,
  /** A row wraps before it grows wider than this (a wider board still gets a row of its own). */
  rowMaxWidth: 8000,
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
  section: string | null;
  /** The row's top, where its heading (if it starts a section) or its labels begin. */
  y: number;
  /** Whether this row starts its section (and shows the heading). */
  heading: boolean;
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

type Board = Pick<DesignBoard, "id" | "width" | "height" | "section">;

export function layoutBoards(boards: readonly Board[]): Layout {
  const unit = layoutUnit(boards.reduce((m, b) => Math.max(m, b.height), 0));
  const gap = LAYOUT.gap * unit;
  const label = LAYOUT.label * unit;
  const rowGap = LAYOUT.rowGap * unit;
  const headingBand = LAYOUT.heading * unit;
  const items: LayoutItem[] = [];
  const rows: LayoutRow[] = [];
  let y = 0;
  let width = 0;
  let i = 0;
  while (i < boards.length) {
    const section = boards[i]?.section ?? null;
    let first = true;
    // One section: one or more rows.
    while (i < boards.length && (boards[i]?.section ?? null) === section) {
      const heading = first && section !== null;
      rows.push({ section, y, heading });
      const top = y + (heading ? headingBand : 0) + label;
      let x = 0;
      let tallest = 0;
      const row = rows.length - 1;
      while (i < boards.length && (boards[i]?.section ?? null) === section) {
        const b = boards[i] as Board;
        if (x > 0 && x + b.width > LAYOUT.rowMaxWidth) break;
        items.push({ id: b.id, x, y: top, w: b.width, h: b.height, row });
        x += b.width + gap;
        tallest = Math.max(tallest, b.height);
        i++;
      }
      width = Math.max(width, x - gap);
      y = top + tallest + rowGap;
      first = false;
    }
  }
  return {
    items,
    rows,
    bounds: { x: 0, y: 0, w: Math.max(width, 0), h: Math.max(y - rowGap, 0) },
    unit,
  };
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(DESIGN_LIMITS.maxZoom, Math.max(DESIGN_LIMITS.minZoom, scale));
}

/**
 * The transform that shows `rect` whole and centred in the viewport, inside `padding`, never above
 * `maxScale` (100% by default, so a small design is not blown up).
 */
export function fitTransform(rect: Rect, viewport: Size, padding = 48, maxScale = 1): Transform {
  const w = Math.max(viewport.width - 2 * padding, 1);
  const h = Math.max(viewport.height - 2 * padding, 1);
  const scale = clampZoom(Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1), maxScale));
  return {
    scale,
    x: (viewport.width - rect.w * scale) / 2 - rect.x * scale,
    y: (viewport.height - rect.h * scale) / 2 - rect.y * scale,
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
  padding = 48,
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
