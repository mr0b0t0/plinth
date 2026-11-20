// Print and save as PDF through the browser's own print: one slide per page at the deck's size, or
// a handout with each slide over its speaker notes. The frame prints itself (window.print in the
// frame), so the browser prints the deck, not the app page around it. `auto` prints light; a
// `dark` deck keeps its colours (print-color-adjust: exact in slides.css).

export const PAGE_STYLE_ID = "__plinth-slides-page";
/** How long printing waits for images to decode before it prints anyway. */
export const DECODE_TIMEOUT_MS = 5000;

/** The @page rule for a deck: its canvas size in inches with no margin, or a margined handout. */
export function pageRule(canvas: { width: number; height: number }, notes: boolean): string {
  if (notes) return "@page { margin: 16mm; }";
  const inch = (px: number) => `${Math.round((px / 96) * 1000) / 1000}in`;
  return `@page { size: ${inch(canvas.width)} ${inch(canvas.height)}; margin: 0; }`;
}

/** The deck's page style element, created on first use. Its text is Plinth's own rule only. */
export function pageStyle(doc: Document): HTMLStyleElement {
  let style = doc.getElementById(PAGE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = PAGE_STYLE_ID;
    doc.head.append(style);
  }
  return style;
}

/** Resolves once every image has decoded (or failed), or after `timeoutMs`. */
export async function imagesReady(root: ParentNode, timeoutMs = DECODE_TIMEOUT_MS): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  for (const img of imgs) img.loading = "eager";
  const all = Promise.all(
    imgs.map((img) =>
      typeof img.decode === "function" ? img.decode().catch(() => undefined) : undefined,
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([all, cap]);
  clearTimeout(timer);
}

export interface PrintOptions {
  notes: boolean;
  canvas: { width: number; height: number };
  /** Lays every slide out for print and fits it (boot.ts). */
  prepare: () => void;
  /** Puts the screen view back after printing. */
  restore: () => void;
}

/**
 * Prints the deck: images eager and decoded (5 s cap), every slide fitted, the page rule for this
 * deck (or the handout), then the frame's own print(). Cleans up on afterprint.
 */
export async function printDeck(win: Window, root: HTMLElement, o: PrintOptions): Promise<void> {
  const doc = win.document;
  const style = pageStyle(doc);
  const before = style.textContent ?? "";
  root.setAttribute("data-print", o.notes ? "handout" : "slides");
  await imagesReady(root);
  o.prepare();
  style.textContent = pageRule(o.canvas, o.notes);
  const done = () => {
    root.removeAttribute("data-print");
    style.textContent = before;
    o.restore();
  };
  win.addEventListener("afterprint", done, { once: true });
  win.print();
}
