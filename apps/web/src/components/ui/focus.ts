// Focus helpers shared by Dialog and Menu.

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

/** Elements inside `root` that Tab can reach, in DOM order. */
export function getFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute("inert") &&
      !el.closest("[inert]") &&
      el.getAttribute("aria-hidden") !== "true",
  );
}

/** Focus without scrolling the page when the browser supports it. */
export function focusElement(el: HTMLElement | null | undefined): void {
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}
