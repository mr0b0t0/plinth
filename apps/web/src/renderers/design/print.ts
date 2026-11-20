// Print and save as PDF through the browser's own print: one artboard per page, each page exactly
// its board's size. The shell prints itself (window.print in the frame), so the browser prints the
// design, not the app page around it. Every board is mounted and laid out in normal flow at 100%,
// printing waits for every board to load (10 s at most), and afterprint puts the canvas back.
//
// Page sizes are named @page rules, one per distinct board size, in a <style> element of Plinth's
// own text (style-src allows inline styles; only scripts are restricted on the shell).
import type { DesignBoard } from "@plinth/shared";

export const PRINT_STYLE_ID = "__plinth-design-print";
/** How long printing waits for boards to load before it prints anyway. */
export const PRINT_LOAD_TIMEOUT_MS = 10_000;

/** The page name for a board's size: s1080x1080. */
export function pageName(b: Pick<DesignBoard, "width" | "height">): string {
  return `s${Math.trunc(b.width)}x${Math.trunc(b.height)}`;
}

/** One named page per distinct size, and the rule that puts each board on its own page. */
export function printCss(boards: readonly Pick<DesignBoard, "width" | "height">[]): string {
  const sizes = new Map<string, { w: number; h: number }>();
  for (const b of boards)
    sizes.set(pageName(b), { w: Math.trunc(b.width), h: Math.trunc(b.height) });
  const out: string[] = [];
  for (const [name, { w, h }] of sizes) {
    out.push(`@page ${name} { size: ${w}px ${h}px; margin: 0; }`);
    out.push(
      `.plinth-design[data-print] .plinth-design__board[data-size="${name}"] { page: ${name}; break-after: page; }`,
    );
  }
  return out.join("\n");
}

/** The print style element, created on first use. Its text is Plinth's own rules only. */
export function printStyle(doc: Document): HTMLStyleElement {
  let style = doc.getElementById(PRINT_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = PRINT_STYLE_ID;
    doc.head.append(style);
  }
  return style;
}

export interface PrintOptions {
  root: HTMLElement;
  boards: readonly DesignBoard[];
  /** Mounts every board and lays them out for print. */
  enter: () => void;
  /** Resolves once every board has loaded, or at the cap. */
  loaded: (timeoutMs: number) => Promise<void>;
  /** Puts the canvas back. */
  leave: () => void;
  timeoutMs?: number;
}

/** idle; loading (waiting for boards); shown (the print layout is up until afterprint). */
let state: "idle" | "loading" | "shown" = "idle";

/**
 * Prints the design once its boards have loaded. A call while the print layout is still up (a
 * browser that never sent afterprint) prints it again as it is.
 */
export async function preparePrint(win: Window, o: PrintOptions): Promise<void> {
  if (state === "shown") win.print();
  if (state !== "idle") return;
  state = "loading";
  const doc = win.document;
  printStyle(doc).textContent = printCss(o.boards);
  o.root.setAttribute("data-print", "");
  o.enter();
  try {
    await o.loaded(o.timeoutMs ?? PRINT_LOAD_TIMEOUT_MS);
  } catch {
    // Print what has loaded.
  }
  state = "shown";
  const done = () => {
    state = "idle";
    o.root.removeAttribute("data-print");
    o.leave();
  };
  win.addEventListener("afterprint", done, { once: true });
  try {
    win.print();
  } catch {
    win.removeEventListener("afterprint", done);
    done();
  }
}

/** For tests: forget a print that never saw afterprint. */
export function resetPrint(): void {
  state = "idle";
}
