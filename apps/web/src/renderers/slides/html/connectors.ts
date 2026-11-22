// Draws an HTML slide's <x-connector>s (Claude's format): a line with constant-size heads, from
// x1,y1 to x2,y2 in its parent's coordinates (canvas pixels, or % of the parent's box), straight
// or routed `hv` (across then down), `vh` (down then across) or `elbow` (three segments that turn
// at the middle of the longer run). Without coordinates it is a sized flow box whose line runs
// corner to corner from `from` (tl, tr, bl, br; a flat box gives a straight arrow). Its colour is
// the element's `color`, its width `border-width` (2px by default, at most 32) and its dash
// `border-style`. Plinth's own drawing, an <svg> made with createElementNS: the line a person
// sees is never author markup.
const SVG_NS = "http://www.w3.org/2000/svg";

type Point = [number, number];

/** A coordinate in px or % of `size`; NaN for anything else. */
export function coord(raw: string | null, size: number): number {
  const v = (raw ?? "").trim();
  if (v.endsWith("%")) return (Number.parseFloat(v) / 100) * size;
  return Number.parseFloat(v.replace(/px$/, ""));
}

/** The points of a route from a to b. */
export function routePoints(a: Point, b: Point, route: string): Point[] {
  if (route === "hv") return [a, [b[0], a[1]], b];
  if (route === "vh") return [a, [a[0], b[1]], b];
  if (route === "elbow") {
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx >= dy) {
      const mx = (a[0] + b[0]) / 2;
      return [a, [mx, a[1]], [mx, b[1]], b];
    }
    const my = (a[1] + b[1]) / 2;
    return [a, [a[0], my], [b[0], my], b];
  }
  return [a, b];
}

type HeadStyle = "none" | "open" | "filled";

function heads(e: Element): { start: HeadStyle; end: HeadStyle } {
  const head = e.getAttribute("head") ?? "end";
  const pick = (v: string | null, fallback: HeadStyle): HeadStyle =>
    v === "none" || v === "open" || v === "filled" ? v : fallback;
  const start = head === "both" ? "filled" : "none";
  const end = head === "none" ? "none" : "filled";
  return {
    start: pick(e.getAttribute("head-start"), start),
    end: pick(e.getAttribute("head-end"), end),
  };
}

/** A head at `tip`, pointing from `from`: a filled triangle or an open chevron, 4 widths long. */
function headPath(tip: Point, from: Point, w: number): Point[] {
  const len = Math.max(8, 4 * w);
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const bx = tip[0] - ux * len;
  const by = tip[1] - uy * len;
  const half = len * 0.55;
  return [[bx - uy * half, by + ux * half], tip, [bx + uy * half, by - ux * half]];
}

const fmt = (p: Point) => `${Math.round(p[0] * 100) / 100},${Math.round(p[1] * 100) / 100}`;

/**
 * The connector's drawing, in its own coordinates (its box's top left corner is 0,0): the line,
 * shortened under a filled head so the tip stays sharp, and the heads.
 */
export function connectorSvg(
  doc: Document,
  points: Point[],
  o: { width: number; dash: string; start: HeadStyle; end: HeadStyle },
): SVGSVGElement {
  const w = Math.max(1, Math.min(32, o.width));
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  svg.setAttribute("aria-hidden", "true");
  const line = points.map((p) => [...p] as Point);
  const trim = (i: number, j: number) => {
    const a = line[i] as Point;
    const b = line[j] as Point;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const cut = Math.min(d, Math.max(8, 4 * w) * 0.8);
    if (d > 0) {
      a[0] -= ((a[0] - b[0]) / d) * cut;
      a[1] -= ((a[1] - b[1]) / d) * cut;
    }
  };
  if (o.end === "filled" && line.length > 1) trim(line.length - 1, line.length - 2);
  if (o.start === "filled" && line.length > 1) trim(0, 1);
  const path = doc.createElementNS(SVG_NS, "polyline");
  path.setAttribute("points", line.map(fmt).join(" "));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", String(w));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (o.dash === "dashed") path.setAttribute("stroke-dasharray", `${w * 3} ${w * 2}`);
  if (o.dash === "dotted") path.setAttribute("stroke-dasharray", `0 ${w * 2}`);
  svg.append(path);
  const addHead = (style: HeadStyle, tip: Point, from: Point) => {
    if (style === "none") return;
    const h = doc.createElementNS(SVG_NS, style === "filled" ? "polygon" : "polyline");
    h.setAttribute("points", headPath(tip, from, w).map(fmt).join(" "));
    if (style === "filled") h.setAttribute("fill", "currentColor");
    else {
      h.setAttribute("fill", "none");
      h.setAttribute("stroke", "currentColor");
      h.setAttribute("stroke-width", String(w));
      h.setAttribute("stroke-linecap", "round");
      h.setAttribute("stroke-linejoin", "round");
    }
    svg.append(h);
  };
  const n = points.length;
  if (n > 1) {
    addHead(o.end, points[n - 1] as Point, points[n - 2] as Point);
    addHead(o.start, points[0] as Point, points[1] as Point);
  }
  return svg;
}

/** Draws every connector under `root` from its laid-out boxes. Safe to call again. */
export function drawConnectors(root: ParentNode, win: Window): void {
  for (const c of Array.from(root.querySelectorAll<HTMLElement>("x-connector"))) {
    const st = win.getComputedStyle(c);
    const width = Number.parseFloat(st.borderTopWidth) || 2;
    const dash = st.borderTopStyle;
    const { start, end } = heads(c);
    let points: Point[];
    if (c.hasAttribute("x1")) {
      const host = c.parentElement;
      const hw = host?.clientWidth ?? 0;
      const hh = host?.clientHeight ?? 0;
      const a: Point = [coord(c.getAttribute("x1"), hw), coord(c.getAttribute("y1"), hh)];
      const b: Point = [coord(c.getAttribute("x2"), hw), coord(c.getAttribute("y2"), hh)];
      if (![...a, ...b].every(Number.isFinite)) continue;
      // The connector sits at its parent's padding-box corner, so its points are the parent's.
      const left = c.offsetLeft;
      const top = c.offsetTop;
      points = routePoints(
        [a[0] - left, a[1] - top],
        [b[0] - left, b[1] - top],
        c.getAttribute("route") ?? "straight",
      );
    } else {
      const w = c.offsetWidth;
      const h = c.offsetHeight;
      const from = c.getAttribute("from") ?? "tl";
      const corners: Record<string, [Point, Point]> = {
        tl: [
          [0, 0],
          [w, h],
        ],
        tr: [
          [w, 0],
          [0, h],
        ],
        bl: [
          [0, h],
          [w, 0],
        ],
        br: [
          [w, h],
          [0, 0],
        ],
      };
      points = [
        ...(corners[from] ??
          corners.tl ?? [
            [0, 0],
            [w, h],
          ]),
      ];
    }
    const svg = connectorSvg(c.ownerDocument, points, { width, dash, start, end });
    // The drawing's 0,0 is the connector's border-box corner; its own border is only the width.
    svg.style.left = `${-(Number.parseFloat(st.borderLeftWidth) || 0)}px`;
    svg.style.top = `${-(Number.parseFloat(st.borderTopWidth) || 0)}px`;
    c.replaceChildren(svg);
  }
}
