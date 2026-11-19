// Plinth's own elements on the design canvas, all built with createElement and textContent: the
// board labels (name, size, zoom to the board, Interact), section headings, the cover over each
// board frame (the comment anchor, `__plinth-board-<id>`), the toolbar and the Boards list.
// Author markup never reaches this document: boards exist here only as frames.
import { boardSizeLabel, type DesignBoard } from "@plinth/shared";

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(
  doc: Document,
  className: string,
  label: string,
  text: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el(doc, "button", className, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

/** The cover's id, the anchor comment pins attach to: stable while the board's id is. */
export const coverId = (id: string) => `__plinth-board-${id}`;

export interface LabelActions {
  zoomTo: (id: string) => void;
  interact: ((id: string) => void) | null;
}

export function boardLabel(doc: Document, board: DesignBoard, a: LabelActions): HTMLElement {
  const label = el(doc, "div", "plinth-design__label");
  label.dataset.board = board.id;
  const name = button(doc, "plinth-design__label-name", `Zoom to ${board.name}`, board.name, () =>
    a.zoomTo(board.id),
  );
  const size = el(doc, "span", "plinth-design__label-size", boardSizeLabel(board));
  label.append(name, size);
  if (a.interact) {
    const interact = a.interact;
    label.append(
      button(doc, "plinth-design__label-interact", `Interact with ${board.name}`, "Interact", () =>
        interact(board.id),
      ),
    );
  }
  return label;
}

export function sectionHeading(doc: Document, name: string): HTMLElement {
  const h = el(doc, "h2", "plinth-design__section", name);
  return h;
}

/** A board's place on the canvas: its frame (while mounted) under a cover. */
export function boardSlot(
  doc: Document,
  board: DesignBoard,
  pageSize: string,
): {
  slot: HTMLElement;
  cover: HTMLElement;
} {
  const slot = el(doc, "div", "plinth-design__board");
  slot.dataset.board = board.id;
  slot.dataset.size = pageSize;
  slot.style.width = `${board.width}px`;
  slot.style.height = `${board.height}px`;
  slot.style.background = board.background;
  const cover = el(doc, "div", "plinth-design__cover");
  cover.id = coverId(board.id);
  cover.dataset.board = board.id;
  cover.setAttribute("aria-hidden", "true");
  slot.append(cover);
  return { slot, cover };
}

export interface ToolbarActions {
  zoomOut: () => void;
  zoomIn: () => void;
  fit: () => void;
  actual: () => void;
  toggleList: () => void;
}

export interface Toolbar {
  el: HTMLElement;
  zoom: HTMLButtonElement;
  list: HTMLButtonElement;
}

export function toolbar(doc: Document, a: ToolbarActions): Toolbar {
  const bar = el(doc, "div", "plinth-design__toolbar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Canvas");
  const zoom = button(
    doc,
    "plinth-design__btn plinth-design__zoom",
    "Zoom to 100%",
    "100%",
    a.actual,
  );
  const list = button(doc, "plinth-design__btn", "Boards", "Boards", a.toggleList);
  list.setAttribute("aria-haspopup", "menu");
  list.setAttribute("aria-expanded", "false");
  bar.append(
    button(doc, "plinth-design__btn", "Zoom out", "−", a.zoomOut),
    zoom,
    button(doc, "plinth-design__btn", "Zoom in", "+", a.zoomIn),
    button(doc, "plinth-design__btn", "Fit all boards", "Fit", a.fit),
    list,
  );
  return { el: bar, zoom, list };
}

export interface BoardList {
  el: HTMLElement;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

export function boardList(
  doc: Document,
  boards: readonly DesignBoard[],
  anchor: HTMLButtonElement,
  pick: (id: string) => void,
): BoardList {
  const menu = el(doc, "div", "plinth-design__list");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Boards");
  menu.hidden = true;
  const items: HTMLButtonElement[] = [];
  for (const b of boards) {
    const item = el(doc, "button", "plinth-design__list-item");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.append(
      el(doc, "span", "plinth-design__list-name", b.name),
      el(doc, "span", "plinth-design__list-size", boardSizeLabel(b)),
    );
    item.addEventListener("click", () => {
      close();
      pick(b.id);
    });
    items.push(item);
    menu.append(item);
  }
  const focusAt = (i: number) => {
    const n = items.length;
    items[((i % n) + n) % n]?.focus();
  };
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(doc.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") focusAt(i + 1);
    else if (e.key === "ArrowUp") focusAt(i - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      close();
      if (e.key === "Escape") anchor.focus();
      else return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  function open() {
    menu.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    focusAt(0);
  }
  function close() {
    menu.hidden = true;
    anchor.setAttribute("aria-expanded", "false");
  }
  return { el: menu, open, close, isOpen: () => !menu.hidden };
}
