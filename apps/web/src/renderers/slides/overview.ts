// The overview: every slide stacked at the frame's width, each with its number. It is what review
// mode (comment pins need every slide in the DOM), the editor preview, phones and printing show,
// and what `o` toggles. Clicking a slide leaves the overview at that slide, unless the overview is
// fixed (review mode and the editor preview).

/** The slide number a click in the overview landed on, or null. */
export function slideAt(target: EventTarget | null): number | null {
  const frame = (target as Element | null)?.closest?.(".plinth-slides__frame");
  const n = Number((frame as HTMLElement | null)?.dataset.n);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Wires "click a slide to open it". Returns a function that unwires it. */
export function bindOverview(
  root: HTMLElement,
  o: { active: () => boolean; fixed: boolean; open: (n: number) => void },
): () => void {
  const onClick = (e: MouseEvent) => {
    if (o.fixed || !o.active() || e.defaultPrevented) return;
    if ((e.target as Element | null)?.closest?.("a, button")) return;
    const n = slideAt(e.target);
    if (n !== null) o.open(n);
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

/** Brings slide `n` into view in the overview. */
export function revealSlide(doc: Document, n: number): void {
  const frame = doc.querySelector(`.plinth-slides__frame[data-n="${Math.trunc(n)}"]`);
  frame?.scrollIntoView?.({ block: "nearest" });
}
