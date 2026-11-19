// The view onto the board: which board point sits at the viewport's top-left corner, and the zoom.
// Pure, except load and save, which keep each viewer's camera in this artifact's localStorage
// (each artifact is its own origin), inside try/catch: storage can be missing or throw.
import type { Bounds } from "./model.ts";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: c.x + sx / c.zoom, y: c.y + sy / c.zoom };
}

export function worldToScreen(c: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - c.x) * c.zoom, y: (wy - c.y) * c.zoom };
}

/** Zoom by `factor`, keeping the board point under (sx, sy) where it is on screen. */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  const at = screenToWorld(c, sx, sy);
  return { x: at.x - sx / zoom, y: at.y - sy / zoom, zoom };
}

/** Move by a screen distance. */
export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x - dx / c.zoom, y: c.y - dy / c.zoom };
}

/** A camera that shows `b` whole in a viewport of `w` by `h`, with a margin, at most 100%. */
export function fitCamera(b: Bounds | null, w: number, h: number, margin = 48): Camera {
  if (!b || w <= 0 || h <= 0) return { x: -margin, y: -margin, zoom: 1 };
  const zoom = clampZoom(Math.min(1, (w - margin * 2) / b.w, (h - margin * 2) / b.h));
  return {
    x: b.x + b.w / 2 - w / 2 / zoom,
    y: b.y + b.h / 2 - h / 2 / zoom,
    zoom,
  };
}

/** The board point at the middle of the viewport. */
export function center(c: Camera, w: number, h: number): { x: number; y: number } {
  return screenToWorld(c, w / 2, h / 2);
}

const KEY = "plinth-whiteboard-camera";

function valid(v: unknown): v is Camera {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    [c.x, c.y, c.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Math.abs(c.x as number) <= 2_000_000 &&
    Math.abs(c.y as number) <= 2_000_000
  );
}

export function loadCamera(win: Window): Camera | null {
  try {
    const raw = win.localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return valid(v) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : null;
  } catch {
    return null;
  }
}

export function saveCamera(win: Window, c: Camera): void {
  try {
    win.localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Storage blocked or full: the camera is a convenience.
  }
}
