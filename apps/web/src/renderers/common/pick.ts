// Picking a place on the page for a comment while it is edited on its page: the comments panel's
// "Pin to an element" (the app's `pick { on: true }`). Edit mode is always on for owners and
// editors, so the review-mode bridge (which reloads the frame) is never used for them; the
// renderer picks instead, and names the place as its own Ask/Comment controls do (a structural
// key such as "block-3" or "slide-2:notes" and a short label), never with draft text the person
// did not see. While picking, a press on the page edits nothing: pointer events are taken before
// the editor sees them. The person presses a place (`picked` with it), or Esc (`picked` with
// null). The app accepts `picked` only with the frame key, and only for a pick it asked for.
import type { AskWhat } from "../../components/viewer/rendererProtocol.ts";

/** A place a renderer names: the element to outline, and the anchor the comment gets. */
export interface PagePlace {
  el: HTMLElement;
  anchor: { key: string; text: string };
  what?: AskWhat;
}

export interface PagePickHost {
  /** The place at `target`, or null where nothing can be pointed at. */
  placeAt(target: Element): PagePlace | null;
  /** Post to the app (with the frame key: editSession.ts appPoster). */
  post(msg: Record<string, unknown>): void;
}

/** The element an event happened on (a text node's parent), or null. */
function elementOf(t: EventTarget | null): Element | null {
  const n = t as Node | null;
  if (!n || typeof n.nodeType !== "number") return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** Pointer events a pick takes before the editor sees them. */
const SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "touchstart"];

export class PagePick {
  private active = false;
  private outlined: { el: HTMLElement; outline: string; offset: string } | null = null;
  private cursor = "";

  constructor(
    private readonly win: Window,
    private readonly host: PagePickHost,
  ) {}

  get picking(): boolean {
    return this.active;
  }

  /** The app's `pick`: start (true) or stop (false). */
  set(on: boolean): void {
    if (on) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.active) return;
    this.active = true;
    const w = this.win;
    for (const t of SWALLOWED) w.addEventListener(t, this.swallow, true);
    w.addEventListener("click", this.onClick, true);
    w.addEventListener("pointerover", this.onOver, true);
    w.addEventListener("keydown", this.onKey, true);
    const html = w.document.documentElement;
    html.setAttribute("data-plinth-picking", "");
    this.cursor = html.style.cursor;
    html.style.cursor = "crosshair";
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const w = this.win;
    for (const t of SWALLOWED) w.removeEventListener(t, this.swallow, true);
    w.removeEventListener("click", this.onClick, true);
    w.removeEventListener("pointerover", this.onOver, true);
    w.removeEventListener("keydown", this.onKey, true);
    const html = w.document.documentElement;
    html.removeAttribute("data-plinth-picking");
    html.style.cursor = this.cursor;
    this.outline(null);
  }

  private readonly swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private readonly onOver = (e: Event) => {
    const t = elementOf(e.target);
    this.outline(t ? (this.host.placeAt(t)?.el ?? null) : null);
  };

  private readonly onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = elementOf(e.target);
    const place = t ? this.host.placeAt(t) : null;
    // Nothing to point at here: the pick goes on.
    if (!place) return;
    this.stop();
    this.host.post({
      type: "picked",
      anchor: { key: place.anchor.key, text: place.anchor.text },
      ...(place.what ? { what: place.what } : {}),
    });
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.stop();
    this.host.post({ type: "picked", anchor: null });
  };

  /** Outline the place under the pointer (CSSOM, which the content CSP allows). */
  private outline(el: HTMLElement | null): void {
    const was = this.outlined;
    if (was?.el === el) return;
    if (was) {
      was.el.style.outline = was.outline;
      was.el.style.outlineOffset = was.offset;
    }
    this.outlined = null;
    if (!el) return;
    this.outlined = { el, outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = "2px solid #b7793a";
    el.style.outlineOffset = "2px";
  }
}
