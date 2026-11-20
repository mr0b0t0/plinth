// Plinth's own elements on the design canvas, all built with createElement and textContent: the
// board labels (the name, which zooms to the board, and Interact), the cover over each board frame
// (the comment anchor, `__plinth-board-<id>`) and the toolbar (zoom and Fit, or Done while a board
// is in use).
// Author markup never reaches this document: boards exist here only as frames.
import type { DesignBoard } from "@plinth/shared";

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

/**
 * A board's label: its name, a button that zooms to the board, then Interact, which shows only on
 * the board last zoomed to and while the label is hovered or holds focus, and never on the board
 * in use (design.css).
 */
export function boardLabel(doc: Document, board: DesignBoard, a: LabelActions): HTMLElement {
  const label = el(doc, "div", "plinth-design__label");
  label.dataset.board = board.id;
  label.append(
    button(doc, "plinth-design__label-name", `Zoom to ${board.name}`, board.name, () =>
      a.zoomTo(board.id),
    ),
  );
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
  done: () => void;
}

export interface Toolbar {
  el: HTMLElement;
  zoom: HTMLButtonElement;
  done: HTMLButtonElement;
  /** While a board is in use, the toolbar holds only Done in place of the zoom controls. */
  setInteracting: (on: boolean) => void;
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
  const controls = [
    button(doc, "plinth-design__btn", "Zoom out", "−", a.zoomOut),
    zoom,
    button(doc, "plinth-design__btn", "Zoom in", "+", a.zoomIn),
    button(doc, "plinth-design__btn", "Fit all boards", "Fit", a.fit),
  ];
  const done = button(
    doc,
    "plinth-design__btn plinth-design__done",
    "Done interacting",
    "Done",
    a.done,
  );
  done.hidden = true;
  bar.append(...controls, done);
  return {
    el: bar,
    zoom,
    done,
    setInteracting: (on) => {
      for (const c of controls) c.hidden = on;
      done.hidden = !on;
    },
  };
}
