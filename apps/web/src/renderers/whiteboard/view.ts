// The board's DOM: the toolbar, the notices, and the viewport with a transformed world layer that
// holds the arrows (one <svg>), the blocks and peers' cursors. Text from documents and peers only
// ever goes in through textContent, and attributes only take numbers and fixed values: no
// innerHTML, and no id or name is ever set from data, so nothing a collaborator writes can clobber
// a global or inject markup.
import {
  arrowEndpoints,
  BOARD_COLORS,
  type BoardBackground,
  type BoardColor,
} from "@plinth/shared";
import type { Camera } from "./camera.ts";
import type { BoardModel } from "./model.ts";
import type { RuntimePeer } from "./runtime.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export const KIND_LABELS = { note: "Note", text: "Text", rect: "Box", ellipse: "Ellipse" } as const;
export type ToolKind = keyof typeof KIND_LABELS;

/** The toolbar's controls, kept to enable, disable and label them. */
export interface Toolbar {
  el: HTMLElement;
  add: Record<ToolKind, HTMLButtonElement>;
  colors: Record<BoardColor, HTMLButtonElement>;
  connect: HTMLButtonElement;
  remove: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  fit: HTMLButtonElement;
  png: HTMLButtonElement;
  svg: HTMLButtonElement;
  status: HTMLElement;
  people: HTMLUListElement;
}

export interface ViewEls {
  root: HTMLElement;
  toolbar: Toolbar;
  banner: HTMLElement;
  msg: HTMLElement;
  viewport: HTMLElement;
  world: HTMLElement;
  arrows: SVGSVGElement;
  /** The block elements by id. */
  blocks: Map<string, HTMLElement>;
  arrowEls: Map<string, { hit: SVGLineElement; line: SVGLineElement; label: SVGTextElement }>;
  cursors: Map<string, HTMLElement>;
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

function buildToolbar(doc: Document): Toolbar {
  const el = doc.createElement("div");
  el.className = "wb-toolbar";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "Board tools");
  const add = {} as Record<ToolKind, HTMLButtonElement>;
  for (const [k, label] of Object.entries(KIND_LABELS) as [ToolKind, string][]) {
    add[k] = button(doc, label, `Add ${label.toLowerCase()}`);
    add[k].dataset.add = k;
  }
  const colors = {} as Record<BoardColor, HTMLButtonElement>;
  for (const c of BOARD_COLORS) {
    const b = button(doc, "", `${c[0]?.toUpperCase()}${c.slice(1)}`);
    b.className = "wb-swatch";
    b.dataset.color = c;
    b.setAttribute("aria-pressed", String(c === "yellow"));
    colors[c] = b;
  }
  const connect = button(doc, "Connect");
  connect.setAttribute("aria-pressed", "false");
  const remove = button(doc, "Delete");
  const zoomOut = button(doc, "−", "Zoom out");
  const zoomIn = button(doc, "+", "Zoom in");
  const fit = button(doc, "Fit", "Fit the board");
  const png = button(doc, "PNG", "Export as PNG");
  const svg = button(doc, "SVG", "Export as SVG");
  const status = doc.createElement("span");
  status.className = "wb-status";
  status.setAttribute("role", "status");
  const people = doc.createElement("ul");
  people.className = "wb-people";
  people.setAttribute("aria-label", "People here");
  el.append(
    group(doc, "Add", ...Object.values(add)),
    group(doc, "Colour", ...Object.values(colors)),
    group(doc, "Edit", connect, remove),
    group(doc, "Zoom", zoomOut, zoomIn, fit),
    group(doc, "Export", png, svg),
    status,
    people,
  );
  return { el, add, colors, connect, remove, zoomOut, zoomIn, fit, png, svg, status, people };
}

/** Build the board's DOM into `root`, replacing what it held. */
export function buildView(doc: Document, root: HTMLElement, background: BoardBackground): ViewEls {
  const toolbar = buildToolbar(doc);
  const banner = doc.createElement("p");
  banner.className = "wb-banner";
  banner.setAttribute("role", "status");
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
  const defs = doc.createElementNS(SVG_NS, "defs");
  const marker = doc.createElementNS(SVG_NS, "marker");
  for (const [k, v] of [
    ["id", "wb-head"],
    ["viewBox", "0 0 10 10"],
    ["refX", "9"],
    ["refY", "5"],
    ["markerWidth", "8"],
    ["markerHeight", "8"],
    ["orient", "auto-start-reverse"],
  ] as const) {
    marker.setAttribute(k, v);
  }
  const head = doc.createElementNS(SVG_NS, "path");
  head.setAttribute("d", "M0 0 10 5 0 10z");
  marker.append(head);
  defs.append(marker);
  arrows.append(defs);
  world.append(arrows);
  viewport.append(world);
  // Named, so the frame's main landmark differs from the app's around it.
  root.setAttribute("aria-label", "Whiteboard");
  root.replaceChildren(toolbar.el, banner, msg, viewport);
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
  };
}

/** Place the world layer and the background pattern for a camera. */
export function applyCamera(v: ViewEls, c: Camera): void {
  v.world.style.transform = `translate(${-c.x * c.zoom}px, ${-c.y * c.zoom}px) scale(${c.zoom})`;
  const step = 24 * c.zoom;
  v.viewport.style.backgroundSize = `${step}px ${step}px`;
  v.viewport.style.backgroundPosition = `${-c.x * c.zoom}px ${-c.y * c.zoom}px`;
  for (const el of v.cursors.values()) el.style.setProperty("--wb-unzoom", String(1 / c.zoom));
}

/** What the view needs to know about the board's state to draw it. */
export interface DrawState {
  selected: string | null;
  connectFrom: string | null;
  editing: string | null;
  readOnly: boolean;
  /** Block ids peers have selected, with the peer's colour hue. */
  peerSelections: Map<string, number>;
}

const blockLabel = (kind: ToolKind, text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t
    ? `${KIND_LABELS[kind]}: ${[...t].slice(0, 80).join("")}`
    : `${KIND_LABELS[kind]}, empty`;
};

/** Draw every block and arrow of the model, reusing elements by id. */
export function draw(doc: Document, v: ViewEls, model: BoardModel, s: DrawState): void {
  const seen = new Set<string>();
  let order = 1;
  for (const [id, { data: b }] of model.ordered()) {
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
    el.dataset.kind = b.kind;
    el.dataset.color = b.color ?? "";
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    el.style.zIndex = String(order++);
    el.setAttribute("aria-label", blockLabel(b.kind, b.text));
    el.classList.toggle("selected", s.selected === id || s.connectFrom === id);
    const hue = s.peerSelections.get(id);
    if (hue === undefined) el.style.removeProperty("--wb-peer");
    else el.style.setProperty("--wb-peer", `hsl(${hue} 65% 45%)`);
    el.classList.toggle("peer-selected", hue !== undefined);
    if (s.editing !== id) {
      const text = el.querySelector(".wb-text");
      if (text && text.textContent !== b.text) text.textContent = b.text;
    }
    const handle = el.querySelector(".wb-resize");
    const wantHandle = s.selected === id && !s.readOnly && s.editing !== id;
    if (wantHandle && !handle) {
      const h = doc.createElement("span");
      h.className = "wb-resize";
      h.setAttribute("aria-hidden", "true");
      el.append(h);
    } else if (!wantHandle && handle) handle.remove();
  }
  for (const [id, el] of [...v.blocks]) {
    if (!seen.has(id)) {
      el.remove();
      v.blocks.delete(id);
    }
  }

  const seenArrows = new Set<string>();
  for (const [id, { data: a }] of model.arrows) {
    const from = model.blocks.get(a.from)?.data;
    const to = model.blocks.get(a.to)?.data;
    if (!from || !to) continue;
    seenArrows.add(id);
    let els = v.arrowEls.get(id);
    if (!els) {
      const hit = doc.createElementNS(SVG_NS, "line");
      hit.setAttribute("class", "wb-arrow-hit");
      const line = doc.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "wb-arrow");
      const label = doc.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "wb-arrow-label");
      label.setAttribute("text-anchor", "middle");
      v.arrows.append(hit, line, label);
      els = { hit, line, label };
      v.arrowEls.set(id, els);
    }
    els.hit.dataset.arrow = id;
    const p = arrowEndpoints(from, to);
    for (const l of [els.hit, els.line]) {
      l.setAttribute("x1", String(p.x1));
      l.setAttribute("y1", String(p.y1));
      l.setAttribute("x2", String(p.x2));
      l.setAttribute("y2", String(p.y2));
    }
    const head = a.head ?? "end";
    if (head === "none") els.line.removeAttribute("marker-end");
    else els.line.setAttribute("marker-end", "url(#wb-head)");
    if (head === "both") els.line.setAttribute("marker-start", "url(#wb-head)");
    else els.line.removeAttribute("marker-start");
    els.line.classList.toggle("dashed", a.style === "dashed");
    els.line.classList.toggle("selected", s.selected === id);
    els.label.setAttribute("x", String((p.x1 + p.x2) / 2));
    els.label.setAttribute("y", String((p.y1 + p.y2) / 2 - 6));
    if (els.label.textContent !== (a.label ?? "")) els.label.textContent = a.label ?? "";
  }
  for (const [id, els] of [...v.arrowEls]) {
    if (!seenArrows.has(id)) {
      els.hit.remove();
      els.line.remove();
      els.label.remove();
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

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The people list and peers' cursors (presence { x, y } in board units). */
export function drawPeers(doc: Document, v: ViewEls, peers: readonly RuntimePeer[], zoom: number) {
  // One person with two tabs is two peers with the same viewer id: list them once.
  const byViewer = new Map<string, RuntimePeer>();
  for (const p of peers) if (!byViewer.has(p.viewer) || p.you) byViewer.set(p.viewer, p);
  v.toolbar.people.replaceChildren(
    ...[...byViewer.values()].map((p) => {
      const li = doc.createElement("li");
      const dot = doc.createElement("i");
      dot.style.background = `hsl(${hueOf(p.viewer)} 65% 45%)`;
      li.append(dot, doc.createTextNode(personName(p)));
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
      label.textContent = personName(p);
    }
    const clampC = (n: number) => Math.min(1_000_000, Math.max(-1_000_000, n));
    el.style.left = `${clampC(pr.x)}px`;
    el.style.top = `${clampC(pr.y)}px`;
    el.style.setProperty("--wb-unzoom", String(1 / zoom));
  }
  for (const [id, el] of [...v.cursors]) {
    if (!live.has(id)) {
      el.remove();
      v.cursors.delete(id);
    }
  }
}
