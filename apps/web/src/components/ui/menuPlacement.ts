// Places an open menu list next to its trigger, inside the viewport. Shared by Menu and the
// version picker.
//
// The list is fixed to the viewport (in the top layer where the browser has popovers), so opening
// it never changes the page's size: an absolutely positioned list below a row near the bottom of a
// short page used to grow the document, which added a scrollbar and shifted the whole page
// sideways by its width, and left the last items below the fold. Here a list that does not fit
// below its trigger opens above it (or the other way round for `placement: "up"`), one that does
// not fit either way scrolls inside the larger side, and one that would run past a side edge (a
// card's menu in a phone's left column) slides back inside it.
import { type RefObject, useLayoutEffect } from "react";

/** Space kept between the list and the viewport's edges. */
export const MENU_MARGIN = 8;
/** Space between the trigger and the list. */
export const MENU_GAP = 4;

export interface MenuPlacementOptions {
  align: "start" | "end";
  placement: "down" | "up";
}

/** Sets `list`'s fixed position from `trigger`'s box. Exported for tests. */
export function placeMenu(
  list: HTMLElement,
  trigger: HTMLElement,
  { align, placement }: MenuPlacementOptions,
): void {
  const root = list.ownerDocument.documentElement;
  const t = trigger.getBoundingClientRect();
  // The viewport without its scrollbars.
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  // The account menu is at least as wide as its trigger (shell.css).
  list.style.setProperty("--pl-menu-anchor-width", `${t.width}px`);
  const w = list.offsetWidth;
  // Its full height, even while a max-height from an earlier placement cuts it (measured without
  // lifting that cap, which would reset a list scrolled inside).
  let h = list.scrollHeight + list.offsetHeight - list.clientHeight;
  if (!w || !vw || !vh) return;

  const below = vh - MENU_MARGIN - (t.bottom + MENU_GAP);
  const above = t.top - MENU_GAP - MENU_MARGIN;
  const up = placement === "up" ? !(h > above && below > above) : h > below && above > below;
  const room = Math.max(up ? above : below, 0);
  if (h > room) h = room;
  list.style.maxHeight = h === room ? `${room}px` : "";
  const top = up ? t.top - MENU_GAP - h : t.bottom + MENU_GAP;
  const preferred = align === "end" ? t.right - w : t.left;
  const left = Math.max(MENU_MARGIN, Math.min(preferred, vw - MENU_MARGIN - w));
  list.style.top = `${Math.round(top)}px`;
  list.style.left = `${Math.round(left)}px`;
}

/**
 * While `open`, keeps `list` placed against `trigger`: on every render (its content may change),
 * when its size changes (a list that loads its items), and when the page scrolls or resizes.
 */
export function useMenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  options: MenuPlacementOptions,
): void {
  const { align, placement } = options;

  // Show it in the top layer (above every stacking context, clipped by no ancestor) and start
  // following the trigger.
  useLayoutEffect(() => {
    const list = listRef.current;
    const trigger = triggerRef.current;
    if (!open || !list || !trigger) return;
    if (typeof list.showPopover === "function" && !list.matches(":popover-open")) {
      try {
        list.showPopover();
      } catch {
        // Not connected or not a popover: it is still position: fixed (menu.css).
      }
    }
    const place = () => placeMenu(list, trigger, { align, placement });
    place();
    // Capture: a scroll inside any container that holds the trigger moves it too. A scroll inside
    // the list itself moves nothing.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && list.contains(e.target))) place();
    };
    const win = list.ownerDocument.defaultView ?? window;
    win.addEventListener("resize", place);
    win.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(list);
    return () => {
      win.removeEventListener("resize", place);
      win.removeEventListener("scroll", onScroll, { capture: true });
      observer?.disconnect();
    };
  }, [open, align, placement, listRef, triggerRef]);

  // Content changes before the observer reports them (and before effects move focus into the
  // list, which would otherwise scroll the page to an item below the fold).
  useLayoutEffect(() => {
    const list = listRef.current;
    const trigger = triggerRef.current;
    if (open && list && trigger) placeMenu(list, trigger, { align, placement });
  });
}
