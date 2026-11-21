// The board's DOM: the toolbar, the notices, and the viewport with a transformed world layer that
// holds the arrows (one <svg>), the blocks and peers' cursors. Text from documents and peers only
// ever goes in through textContent or an inert text attribute (aria-label, title); inline marks
// become spans built here from parseMarks' runs, and a link's href is only ever an address the URL
// parser read as http(s). Every other attribute and style takes only numbers, fixed values and
// colours checked against #rrggbb: no innerHTML, and no id or name is ever set from data, so
// nothing a collaborator writes can clobber a global or inject markup.
import {
  arrowHeads,
  arrowRoute,
  type BlockKind,
  BOARD_COLORS,
  type BoardBackground,
  type BoardBlock,
  type BoardColor,
  type BoardInk,
  type BoardPaint,
  HEX_COLOR_RE,
  hasMarks,
  heatOf,
  isDarkHex,
  isShapeKind,
  lineHeightOf,
  parseMarks,
  routeHeads,
  routeLabelAt,
  routePath,
  SHAPE_KINDS,
  type ShapeKind,
  shapePath,
  TEXT_SIZES,
  type TextSize,
  tableLayout,
  textInset,
  textPx,
  trimRoute,
} from "@plinth/shared";
import type { Camera } from "./camera.ts";
import type { BoardModel } from "./model.ts";
import type { RuntimePeer } from "./runtime.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** What the add buttons make. */
export const ADD_LABELS = { note: "Note", text: "Text", rect: "Box", ellipse: "Ellipse" } as const;
export type ToolKind = keyof typeof ADD_LABELS;

/** A shape's name in the Shape list. */
export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "Box",
  rounded: "Rounded",
  ellipse: "Ellipse",
  diamond: "Diamond",
  pill: "Pill",
  hexagon: "Hexagon",
  parallelogram: "Parallelogram",
  database: "Database",
  queue: "Queue",
  document: "Document",
  cloud: "Cloud",
  person: "Person",
};

/** A block's kind as screen readers hear it. */
export const KIND_LABELS: Record<BlockKind, string> = {
  ...SHAPE_LABELS,
  note: "Note",
  text: "Text",
  rounded: "Rounded box",
  container: "Section",
  table: "Table",
};

export const SIZE_LABELS: Record<TextSize, string> = {
  small: "Small",
  body: "Body",
  large: "Large",
  title: "Title",
  huge: "Huge",
};

/**
 * The toolbar's controls, kept to show, enable and label them. The add buttons show only to
 * people who may edit, and the selection's controls (shape or text size, colour, connect, delete)
 * only while something they apply to is selected. Zoom is the wheel, a pinch or the keys; export
 * is in the app's menu.
 */
export interface Toolbar {
  el: HTMLElement;
  /** The add buttons' group. */
  adds: HTMLElement;
  add: Record<ToolKind, HTMLButtonElement>;
  /** A selected shape's kind, or a selected text's size: one list, shown only for those. */
  style: HTMLSelectElement;
  /** The colour control: the swatches, and at phone width the one swatch that opens them. */
  colour: HTMLElement;
  /** The swatches' group. */
  palette: HTMLElement;
  colors: Record<BoardColor, HTMLButtonElement>;
  /** At phone width, one swatch in the current colour, which opens the others. */
  pick: HTMLButtonElement;
  connect: HTMLButtonElement;
  remove: HTMLButtonElement;
  fit: HTMLButtonElement;
  status: HTMLElement;
  people: HTMLUListElement;
}

interface ArrowEls {
  g: SVGGElement;
  hit: SVGPathElement;
  line: SVGPathElement;
  heads: [SVGPathElement, SVGPathElement];
  label: SVGTextElement;
}

export interface ViewEls {
  root: HTMLElement;
  toolbar: Toolbar;
  /** A short standing line in the toolbar ("View only", or why the board is unavailable). */
  banner: HTMLElement;
  msg: HTMLElement;
  viewport: HTMLElement;
  world: HTMLElement;
  arrows: SVGSVGElement;
  /** The block elements by id. */
  blocks: Map<string, HTMLElement>;
  arrowEls: Map<string, ArrowEls>;
  cursors: Map<string, HTMLElement>;
  /** A table's cell elements, for finding which cell was clicked: [row id, column id]. */
  cells: WeakMap<Element, [string, string]>;
}

function button(doc: Document, text: string, label?: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

function group(doc: Document, label: string, ...items: HTMLElement[]): HTMLElement {
  const g = doc.createElement("div");
  g.className = "wb-group";
  g.setAttribute("role", "group");
  g.setAttribute("aria-label", label);
  g.append(...items);
  return g;
}

function buildToolbar(doc: Document, banner: HTMLElement): Toolbar {
  const el = doc.createElement("div");
  el.className = "wb-toolbar";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Board tools");
  const add = {} as Record<ToolKind, HTMLButtonElement>;
  for (const [k, label] of Object.entries(ADD_LABELS) as [ToolKind, string][]) {
    add[k] = button(doc, label, `Add ${label.toLowerCase()}`);
    add[k].dataset.add = k;
  }
  const colors = {} as Record<BoardColor, HTMLButtonElement>;
  for (const c of BOARD_COLORS) {
    const b = button(doc, "", `${c[0]?.toUpperCase()}${c.slice(1)}`);
    b.className = "wb-swatch";
    b.dataset.color = c;
    b.setAttribute("aria-pressed", "false");
    colors[c] = b;
  }
  const style = doc.createElement("select");
  style.className = "wb-style";
  const connect = button(doc, "Connect");
  connect.setAttribute("aria-pressed", "false");
  const remove = button(doc, "Delete");
  const fit = button(doc, "Fit", "Fit the board");
  const status = doc.createElement("span");
  status.className = "wb-status";
  status.setAttribute("role", "status");
  const people = doc.createElement("ul");
  people.className = "wb-people";
  people.setAttribute("aria-label", "People here");
  const adds = group(doc, "Add", ...Object.values(add));
  adds.classList.add("wb-adds");
  const palette = group(doc, "Colour", ...Object.values(colors));
  palette.classList.add("wb-palette");
  const pick = button(doc, "", "Colour");
  pick.className = "wb-swatch wb-pick";
  pick.dataset.color = "yellow";
  pick.setAttribute("aria-expanded", "false");
  const colour = doc.createElement("div");
  colour.className = "wb-colour";
  colour.append(pick, palette);
  // One row: the tools (which scroll sideways at phone width), then who is here and Fit.
  const tools = doc.createElement("div");
  tools.className = "wb-tools";
  tools.append(banner, adds, connect, remove, style, colour);
  const end = doc.createElement("div");
  end.className = "wb-end";
  end.append(people, status, fit);
  el.append(tools, end);
  return {
    el,
    adds,
    add,
    style,
    colour,
    palette,
    colors,
    pick,
    connect,
    remove,
    fit,
    status,
    people,
  };
}

/** What the style list holds now: a shape's kinds, a text's sizes, or nothing. */
export type StyleList = "shape" | "size" | null;

/** Fill the style list for a selected shape or text block, or empty it. */
export function setStyleList(
  doc: Document,
  sel: HTMLSelectElement,
  b: BoardBlock | null,
): StyleList {
  const list: StyleList = b && isShapeKind(b.kind) ? "shape" : b?.kind === "text" ? "size" : null;
  if (sel.dataset.list !== (list ?? "")) {
    sel.dataset.list = list ?? "";
    const options =
      list === "shape"
        ? SHAPE_KINDS.map((k) => [k, SHAPE_LABELS[k]] as const)
        : list === "size"
          ? TEXT_SIZES.map((k) => [k, SIZE_LABELS[k]] as const)
          : [];
    sel.replaceChildren(
      ...options.map(([value, label]) => {
        const o = doc.createElement("option");
        o.value = value;
        o.textContent = label;
        return o;
      }),
    );
    sel.setAttribute("aria-label", list === "size" ? "Text size" : "Shape");
  }
  if (b && list === "shape") sel.value = b.kind;
  // A text that names no size is drawn at 14, as Small is.
  if (b && list === "size") sel.value = b.size ?? "small";
  return list;
}

/** Build the board's DOM into `root`, replacing what it held. */
export function buildView(doc: Document, root: HTMLElement, background: BoardBackground): ViewEls {
  const banner = doc.createElement("p");
  banner.className = "wb-banner";
  banner.setAttribute("role", "status");
  const toolbar = buildToolbar(doc, banner);
  const msg = doc.createElement("p");
  msg.className = "wb-msg";
  msg.setAttribute("role", "alert");
  const viewport = doc.createElement("div");
  viewport.className = "wb-viewport";
  viewport.dataset.bg = background;
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "application");
  viewport.setAttribute(
    "aria-label",
    "Board. Drag to pan, scroll or pinch to zoom; Tab moves between blocks, arrow keys move one, Enter edits it.",
  );
  const world = doc.createElement("div");
  world.className = "wb-world";
  const arrows = doc.createElementNS(SVG_NS, "svg");
  arrows.setAttribute("class", "wb-arrows");
  arrows.setAttribute("aria-hidden", "true");
  world.append(arrows);
  viewport.append(world);
  // Named, so the frame's main landmark differs from the app's around it.
  root.setAttribute("aria-label", "Whiteboard");
  root.replaceChildren(toolbar.el, msg, viewport);
  return {
    root,
    toolbar,
    banner,
    msg,
    viewport,
    world,
    arrows,
    blocks: new Map(),
    arrowEls: new Map(),
    cursors: new Map(),
    cells: new WeakMap(),
  };
}

/** Place the world layer and the background pattern for a camera. */
export function applyCamera(v: ViewEls, c: Camera): void {
  v.world.style.transform = `translate(${-c.x * c.zoom}px, ${-c.y * c.zoom}px) scale(${c.zoom})`;
  const step = 24 * c.zoom;
  v.viewport.style.backgroundSize = `${step}px ${step}px`;
  v.viewport.style.backgroundPosition = `${-c.x * c.zoom}px ${-c.y * c.zoom}px`;
  for (const el of v.cursors.values()) el.style.setProperty("--wb-unzoom", String(1 / c.zoom));
  placeCursorTags(v, c);
}

/** What the view needs to know about the board's state to draw it. */
export interface DrawState {
  selected: string | null;
  connectFrom: string | null;
  editing: string | null;
  readOnly: boolean;
  /** Block ids peers have selected, with the peer's colour hue. */
  peerSelections: Map<string, number>;
  /**
   * Where peers are dragging blocks right now: drawn there (and their arrows with them), never
   * part of the model, whose copy of a block stays the server's.
   */
  peerMoves: ReadonlyMap<string, { x: number; y: number }>;
}

const blockLabel = (kind: BlockKind, text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t
    ? `${KIND_LABELS[kind]}: ${[...t].slice(0, 80).join("")}`
    : `${KIND_LABELS[kind]}, empty`;
};

const isHex = (v: unknown): v is string => typeof v === "string" && HEX_COLOR_RE.test(v);

/** A colour as a CSS value: a board colour's token, the board's text colour, or #rrggbb. */
function inkCss(ink: BoardInk): string {
  if (isHex(ink)) return ink;
  return ink === "ink" ? "var(--wb-block-fg)" : `var(--wb-ink-${ink})`;
}

function paintCss(paint: BoardPaint): string {
  return isHex(paint) ? paint : `var(--wb-fill-${paint})`;
}

/** The source each text element was last drawn from, so unchanged text is not rebuilt. */
const drawnText = new WeakMap<Element, string>();

/**
 * Put a block's text into `el`: as one text node when it has no marks, otherwise as spans for
 * bold, italic and code and an <a> for each http(s) link (opened in a new tab, with no opener or
 * referrer). Never parsed as HTML.
 */
export function renderText(doc: Document, el: Element, text: string): void {
  if (drawnText.get(el) === text && el.childNodes.length > 0 === text.length > 0) return;
  drawnText.set(el, text);
  if (!hasMarks(text)) {
    el.textContent = text;
    return;
  }
  const nodes: Node[] = [];
  for (const [i, line] of parseMarks(text).entries()) {
    if (i > 0) nodes.push(doc.createTextNode("\n"));
    for (const run of line) {
      if (!run.bold && !run.italic && !run.code && !run.href) {
        nodes.push(doc.createTextNode(run.text));
        continue;
      }
      let node: HTMLElement;
      if (run.href) {
        const a = doc.createElement("a");
        a.className = "wb-link";
        a.href = run.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        node = a;
      } else {
        node = doc.createElement("span");
        node.className = run.code
          ? "wb-code"
          : run.bold && run.italic
            ? "wb-bi"
            : run.bold
              ? "wb-b"
              : "wb-i";
      }
      node.textContent = run.text;
      nodes.push(node);
    }
  }
  el.replaceChildren(...nodes);
}

/** The colours, outline and text style of one block's element. */
function styleBlock(el: HTMLElement, text: HTMLElement, b: BoardBlock): void {
  const custom = isHex(b.color);
  el.dataset.color = b.color === undefined ? "" : custom ? "custom" : b.color;
  if (custom) {
    el.style.setProperty("--wb-fill", b.color as string);
    el.style.setProperty("--wb-on", isDarkHex(b.color as string) ? "#ffffff" : "#1d1c1a");
  } else {
    el.style.removeProperty("--wb-fill");
    el.style.removeProperty("--wb-on");
  }
  if (b.stroke === undefined) {
    delete el.dataset.stroke;
    el.style.removeProperty("--wb-stroke");
  } else {
    el.dataset.stroke = "";
    el.style.setProperty("--wb-stroke", inkCss(b.stroke));
  }
  if (b.hollow) el.dataset.hollow = "";
  else delete el.dataset.hollow;
  const px = b.size ? textPx(b.size) : null;
  text.style.fontSize = px ? `${px}px` : "";
  text.style.lineHeight = px ? `${lineHeightOf(px)}px` : "";
  text.style.textAlign = b.textAlign ?? "";
  text.style.whiteSpace = b.wrap === false ? "pre" : "";
  text.style.overflow = b.wrap === false && b.kind === "text" ? "visible" : "";
  // A shape whose outline curves in keeps its words inside it.
  const [t, r, bt, l] = textInset(b.kind, b.w, b.h);
  text.style.padding = t || r || bt || l ? `${8 + t}px ${10 + r}px ${8 + bt}px ${10 + l}px` : "";
}

/** A shape other than the box and the ellipse (which CSS draws) is an <svg> path behind its text. */
function drawShape(doc: Document, el: HTMLElement, b: BoardBlock): void {
  let svg = el.querySelector<SVGSVGElement>(":scope > .wb-shape");
  const wants = isShapeKind(b.kind) && b.kind !== "rect" && b.kind !== "ellipse";
  el.toggleAttribute("data-shape", wants);
  if (!wants) {
    svg?.remove();
    return;
  }
  if (!svg) {
    svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "wb-shape");
    svg.setAttribute("aria-hidden", "true");
    svg.append(doc.createElementNS(SVG_NS, "path"));
    el.prepend(svg);
  }
  svg.setAttribute("viewBox", `0 0 ${b.w} ${b.h}`);
  svg.querySelector("path")?.setAttribute("d", shapePath(b.kind as ShapeKind, b.w, b.h));
}

/** The source a table was last drawn from. */
const drawnTable = new WeakMap<Element, string>();

/** Forget how a block's table was drawn, so the next draw builds its cells afresh. */
export function forgetTable(el: HTMLElement): void {
  const grid = el.querySelector(":scope > .wb-table");
  if (grid) drawnTable.delete(grid);
}

/** A table: a grid of cells, columns by their weights and equal rows, the first row the header. */
function drawTable(doc: Document, v: ViewEls, el: HTMLElement, b: BoardBlock): void {
  let grid = el.querySelector<HTMLElement>(":scope > .wb-table");
  if (b.kind !== "table") {
    grid?.remove();
    return;
  }
  if (!grid) {
    grid = doc.createElement("div");
    grid.className = "wb-table";
    el.append(grid);
  }
  const key = JSON.stringify([b.w, b.h, b.cols, b.rows, b.fills, b.heat, b.size, b.textAlign]);
  if (drawnTable.get(grid) === key) return;
  drawnTable.set(grid, key);
  const layout = tableLayout(b);
  const heat = heatOf(b);
  grid.style.gridTemplateColumns = layout.cols.map((c) => `${Math.max(1, c.w)}fr`).join(" ");
  grid.style.gridTemplateRows = `repeat(${Math.max(1, layout.rows.length)}, 1fr)`;
  const px = b.size ? textPx(b.size) : null;
  grid.style.fontSize = px ? `${px}px` : "";
  const cells: HTMLElement[] = [];
  for (const [ri, row] of layout.rows.entries()) {
    for (const col of layout.cols) {
      const cell = doc.createElement("div");
      cell.className = ri === 0 ? "wb-cell wb-head" : "wb-cell";
      const value = b.rows?.[row.id]?.[col.id];
      const span = doc.createElement("span");
      span.textContent = typeof value === "string" ? value : "";
      cell.append(span);
      if (b.textAlign) cell.style.textAlign = b.textAlign;
      const fill = b.fills?.[row.id]?.[col.id];
      const shade = heat.get(`${row.id}\u0000${col.id}`);
      if (fill) {
        cell.style.background = paintCss(fill);
        if (isHex(fill)) cell.style.color = isDarkHex(fill) ? "#ffffff" : "#1d1c1a";
      } else if (shade) {
        const c = isHex(shade.paint) ? shade.paint : `var(--wb-ink-${shade.paint})`;
        const pct = Math.round((0.12 + shade.level * 0.5) * 100);
        cell.dataset.heat = "";
        cell.style.setProperty("--wb-heat", c);
        cell.style.setProperty("--wb-heat-pct", `${pct}%`);
      }
      v.cells.set(cell, [row.id, col.id]);
      cells.push(cell);
    }
  }
  grid.replaceChildren(...cells);
}

/** Draw every block and arrow of the model, reusing elements by id. */
export function draw(doc: Document, v: ViewEls, model: BoardModel, s: DrawState): void {
  const shown = (id: string, b: BoardBlock): BoardBlock => {
    const m = s.peerMoves.get(id);
    return m ? { ...b, x: m.x, y: m.y } : b;
  };
  const seen = new Set<string>();
  let order = 1;
  let sections = 0;
  for (const [id, { data }] of model.ordered()) {
    const b = shown(id, data);
    seen.add(id);
    let el = v.blocks.get(id);
    if (!el) {
      el = doc.createElement("div");
      el.className = "wb-block";
      el.tabIndex = 0;
      el.setAttribute("role", "group");
      const text = doc.createElement("div");
      text.className = "wb-text";
      el.append(text);
      v.world.append(el);
      v.blocks.set(id, el);
    }
    const text = el.querySelector<HTMLElement>(":scope > .wb-text");
    el.dataset.kind = b.kind;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    if (b.kind === "container") sections = order;
    el.style.zIndex = String(b.kind === "container" ? order++ : 1 + order++);
    el.setAttribute("aria-label", blockLabel(b.kind, b.kind === "table" ? "" : b.text));
    el.classList.toggle("selected", s.selected === id || s.connectFrom === id);
    el.classList.toggle("moving", s.peerMoves.has(id));
    const hue = s.peerSelections.get(id);
    if (hue === undefined) el.style.removeProperty("--wb-peer");
    else el.style.setProperty("--wb-peer", `hsl(${hue} 65% 45%)`);
    el.classList.toggle("peer-selected", hue !== undefined);
    if (text) {
      styleBlock(el, text, b);
      if (s.editing !== id) renderText(doc, text, b.kind === "table" ? "" : b.text);
    }
    drawShape(doc, el, b);
    drawTable(doc, v, el, b);
    const handle = el.querySelector(".wb-resize");
    const wantHandle = s.selected === id && !s.readOnly && s.editing !== id;
    if (wantHandle && !handle) {
      const h = doc.createElement("span");
      h.className = "wb-resize";
      h.setAttribute("aria-hidden", "true");
      el.append(h);
    } else if (!wantHandle && handle) handle.remove();
  }
  // Arrows lie over every section and under every other block.
  v.arrows.style.zIndex = String(sections + 1);
  for (const [id, el] of [...v.blocks]) {
    if (!seen.has(id)) {
      el.remove();
      v.blocks.delete(id);
    }
  }

  const seenArrows = new Set<string>();
  for (const [id, { data: a }] of model.arrows) {
    const fromData = model.blocks.get(a.from)?.data;
    const toData = model.blocks.get(a.to)?.data;
    if (!fromData || !toData) continue;
    const from = shown(a.from, fromData);
    const to = shown(a.to, toData);
    seenArrows.add(id);
    let els = v.arrowEls.get(id);
    if (!els) {
      const g = doc.createElementNS(SVG_NS, "g");
      const hit = doc.createElementNS(SVG_NS, "path");
      hit.setAttribute("class", "wb-arrow-hit");
      const line = doc.createElementNS(SVG_NS, "path");
      line.setAttribute("class", "wb-arrow");
      const head0 = doc.createElementNS(SVG_NS, "path");
      const head1 = doc.createElementNS(SVG_NS, "path");
      head0.setAttribute("class", "wb-arrow-head");
      head1.setAttribute("class", "wb-arrow-head");
      const label = doc.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "wb-arrow-label");
      label.setAttribute("dominant-baseline", "central");
      g.append(hit, line, head0, head1, label);
      v.arrows.append(g);
      els = { g, hit, line, heads: [head0, head1], label };
      v.arrowEls.set(id, els);
    }
    els.hit.dataset.arrow = id;
    const route = arrowRoute(from, to, a);
    const heads = arrowHeads(a);
    els.hit.setAttribute("d", routePath(route));
    els.line.setAttribute("d", routePath(trimRoute(route, heads)));
    const [h0, h1] = routeHeads(route, heads);
    for (const [i, d] of [h0, h1].entries()) {
      const head = els.heads[i] as SVGPathElement;
      if (d) head.setAttribute("d", d);
      else head.removeAttribute("d");
    }
    if (a.color) els.g.style.setProperty("--wb-arrow-c", inkCss(a.color));
    else els.g.style.removeProperty("--wb-arrow-c");
    els.line.classList.toggle("dashed", a.style === "dashed");
    els.g.classList.toggle("selected", s.selected === id);
    els.line.classList.toggle("selected", s.selected === id);
    const at = routeLabelAt(route);
    els.label.setAttribute("x", String(at.x));
    els.label.setAttribute("y", String(at.y));
    els.label.setAttribute("text-anchor", at.anchor);
    if (els.label.textContent !== (a.label ?? "")) els.label.textContent = a.label ?? "";
  }
  for (const [id, els] of [...v.arrowEls]) {
    if (!seenArrows.has(id)) {
      els.g.remove();
      v.arrowEls.delete(id);
    }
  }
}

/** A stable colour hue for a person, from their per-artifact viewer id. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function personName(p: RuntimePeer): string {
  if (p.you) return "You";
  const name = typeof p.name === "string" ? p.name : "";
  return name || (typeof p.email === "string" ? p.email : "") || "Someone";
}

/** The short form shown on a cursor and in the people list: the name, or the email's local part. */
export function shortName(p: RuntimePeer): string {
  const full = personName(p);
  return typeof p.name === "string" && p.name ? full : full.replace(/@.*$/, "") || full;
}

/** How close to the viewport's right edge a cursor's name tag moves to the pointer's left. */
const TAG_ROOM = 140;

/** Flip each cursor's name tag to the pointer's left near the viewport's right edge. */
export function placeCursorTags(v: ViewEls, c: Camera): void {
  const right = v.viewport.clientWidth || 0;
  for (const el of v.cursors.values()) {
    const x = Number.parseFloat(el.style.left);
    const sx = Number.isFinite(x) ? (x - c.x) * c.zoom : 0;
    el.classList.toggle("flip", right > 0 && sx > right - TAG_ROOM);
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The people list (everyone else here; empty, and so hidden, when the viewer is alone) and peers'
 * cursors (presence { x, y } in board units).
 */
export function drawPeers(doc: Document, v: ViewEls, peers: readonly RuntimePeer[], cam: Camera) {
  // One person with two tabs is two peers with the same viewer id: list them once, and never list
  // the viewer, whose other tabs share their id.
  const mine = new Set(peers.filter((p) => p.you).map((p) => p.viewer));
  const byViewer = new Map<string, RuntimePeer>();
  for (const p of peers)
    if (!mine.has(p.viewer) && !byViewer.has(p.viewer)) byViewer.set(p.viewer, p);
  v.toolbar.people.replaceChildren(
    ...[...byViewer.values()].map((p) => {
      // The short name beside a dot (only the dot at phone width); the full name on hover.
      const li = doc.createElement("li");
      li.title = personName(p);
      const dot = doc.createElement("i");
      dot.style.background = `hsl(${hueOf(p.viewer)} 65% 45%)`;
      const name = doc.createElement("span");
      name.textContent = shortName(p);
      li.append(dot, name);
      return li;
    }),
  );
  const live = new Set<string>();
  for (const p of peers) {
    const pr = p.presence ?? {};
    if (p.you || !finite(pr.x) || !finite(pr.y)) continue;
    live.add(p.id);
    let el = v.cursors.get(p.id);
    if (!el) {
      el = doc.createElement("div");
      el.className = "wb-cursor";
      const arrow = doc.createElementNS(SVG_NS, "svg");
      arrow.setAttribute("width", "16");
      arrow.setAttribute("height", "16");
      arrow.setAttribute("viewBox", "0 0 16 16");
      arrow.setAttribute("aria-hidden", "true");
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M1 1 1 14 5 10 8 15 10 14 7 9 13 9z");
      path.setAttribute("stroke", "#fff");
      arrow.append(path);
      const label = doc.createElement("span");
      el.append(arrow, label);
      v.world.append(el);
      v.cursors.set(p.id, el);
    }
    const color = `hsl(${hueOf(p.viewer)} 65% 45%)`;
    el.querySelector("path")?.setAttribute("fill", color);
    const label = el.querySelector("span");
    if (label) {
      label.style.background = color;
      label.textContent = shortName(p);
    }
    const clampC = (n: number) => Math.min(1_000_000, Math.max(-1_000_000, n));
    el.style.left = `${clampC(pr.x)}px`;
    el.style.top = `${clampC(pr.y)}px`;
    el.style.setProperty("--wb-unzoom", String(1 / cam.zoom));
  }
  for (const [id, el] of [...v.cursors]) {
    if (!live.has(id)) {
      el.remove();
      v.cursors.delete(id);
    }
  }
  placeCursorTags(v, cam);
}
