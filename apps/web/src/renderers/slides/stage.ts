// Scales the fixed slide canvas to the space it is shown in. A slide is always laid out at its
// canvas size (1280x720 or 1024x768 CSS pixels) and shrunk or grown with a CSS transform, so text
// wraps the same way on a phone, a projector and in print.

/** Gap around and between the slides in the overview, in CSS pixels. */
export const OVERVIEW_GUTTER = 16;
/** From this frame width the overview is a grid of thumbnails; below it, one column. */
export const OVERVIEW_GRID_MIN = 700;
/** From this frame width the grid has four columns instead of three. */
export const OVERVIEW_GRID_WIDE = 1100;
/** The band under the slide in deck view that holds the controls, in CSS pixels. */
export const CONTROLS_BAND = 48;

/** The scale that fits a w x h canvas in a box, letterboxed. */
export function fitScale(boxW: number, boxH: number, w: number, h: number): number {
  if (!(boxW > 0 && boxH > 0)) return 1;
  return Math.min(boxW / w, boxH / h);
}

/** In portrait at under 600 px wide the deck shows the overview, so nothing scrolls sideways. */
export function prefersOverview(win: Pick<Window, "innerWidth" | "innerHeight">): boolean {
  return win.innerWidth < 600 && win.innerHeight > win.innerWidth;
}

/**
 * Columns of the overview: a grid of three or four thumbnails on a wide frame, one column on a
 * narrow one and in a fixed overview (review mode and the editor preview read every slide).
 */
export function overviewColumns(frameWidth: number, fixed = false): number {
  if (fixed || frameWidth < OVERVIEW_GRID_MIN) return 1;
  return frameWidth < OVERVIEW_GRID_WIDE ? 3 : 4;
}

/** The scale of each slide in the overview: its column's width, never larger than the canvas. */
export function overviewScale(frameWidth: number, w: number, columns = 1): number {
  const cols = Math.max(1, Math.trunc(columns));
  const room = frameWidth - 2 * OVERVIEW_GUTTER - (cols - 1) * OVERVIEW_GUTTER;
  return Math.max(0.1, Math.min(1, room / cols / w));
}

/** Sets the canvas size and the scale on an element: the CSS reads --w, --h and --s from it. */
export function setScale(
  el: HTMLElement,
  canvas: { width: number; height: number },
  scale: number,
): void {
  el.style.setProperty("--w", `${canvas.width}px`);
  el.style.setProperty("--h", `${canvas.height}px`);
  el.style.setProperty("--s", String(Math.round(scale * 10000) / 10000));
}
