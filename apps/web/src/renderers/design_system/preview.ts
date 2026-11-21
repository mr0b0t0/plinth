// Component previews: each example renders in its own srcdoc frame, with the design system's
// compiled tokens, fonts and CSS, in light or dark.
//
// The layers that keep author markup inert:
// 1. sandbox="allow-same-origin" and nothing else: no script runs in the frame, and no forms,
//    popups, top navigation, modals or downloads. Same-origin only so the frame can load the
//    design system's own images and fonts; under opaque isolation the shell's sandbox is inherited
//    and the frame is opaque too.
// 2. The shell's CSP is inherited by srcdoc documents (script-src 'self', the content host's
//    connect-src, img-src and font-src).
// 3. sanitizeComponent.ts strips scripts, handlers, frames, forms, links and outside URLs.
// 4. CSS cannot hold `<` (the format refuses it), so no block can end its <style> early, and the
//    srcdoc is set through the DOM property, never written into attribute text.
//
// A draft (edit mode, and each side of the review) is drawn with its own version's files: the
// frame then gets <base href="/__plinth/v/<n>/">, so the example's images and the CSS's fonts and
// url() load from that version (base-uri 'self' allows it; author markup never keeps a <base>).
import {
  type DesignSystem,
  type DsComponent,
  type DsExample,
  designSystemCss,
  designSystemFontFaces,
  designSystemFontLinks,
  escapeHtml,
} from "@plinth/shared";
import { sanitizeComponentHtml } from "./sanitizeComponent.ts";

export type PreviewTheme = "light" | "dark";

/** The exact sandbox every preview frame gets. */
export const PREVIEW_SANDBOX = "allow-same-origin";

/** The tallest a preview grows to fit its content. */
export const MAX_PREVIEW_HEIGHT = 1200;

/** The document one preview frame shows. */
export function previewSrcdoc(
  ds: DesignSystem,
  component: DsComponent,
  example: DsExample,
  theme: PreviewTheme,
  doc: Document,
  version: number | null = null,
): string {
  const v = (name: string, fallback: string) => `var(--${ds.prefix}-${name}, ${fallback})`;
  const links = designSystemFontLinks(ds)
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("");
  const base =
    `html{color-scheme:${theme}}` +
    `body{margin:16px;background:${v("color-bg", "Canvas")};color:${v("color-fg", "CanvasText")};` +
    `font-family:${v("font-body-font-family", "system-ui, sans-serif")}}`;
  return (
    `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">` +
    `<meta name="color-scheme" content="${theme}">` +
    `<meta name="referrer" content="no-referrer">` +
    (version !== null ? `<base href="/__plinth/v/${version}/">` : "") +
    links +
    `<style>${designSystemFontFaces(ds)}\n${designSystemCss(ds)}\n${base}</style>` +
    `<style>${ds.css ?? ""}\n${component.css ?? ""}</style>` +
    `</head><body>${sanitizeComponentHtml(example.html, doc)}</body></html>`
  );
}

/** A preview frame for one example in one theme. Grows to fit under origin isolation. */
export function mountPreview(
  doc: Document,
  ds: DesignSystem,
  component: DsComponent,
  example: DsExample,
  theme: PreviewTheme,
  version: number | null = null,
): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", PREVIEW_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  frame.title = `${component.name}: ${example.name} (${theme})`;
  frame.className = "ds-preview__frame";
  frame.dataset.theme = theme;
  frame.style.height = `${example.height}px`;
  frame.srcdoc = previewSrcdoc(ds, component, example, theme, doc, version);
  frame.addEventListener("load", () => {
    // Same origin only under origin isolation; an opaque frame keeps its height and scrolls.
    try {
      const h = frame.contentDocument?.documentElement.scrollHeight ?? 0;
      if (h > example.height) frame.style.height = `${Math.min(h, MAX_PREVIEW_HEIGHT)}px`;
    } catch {
      // Opaque: not readable.
    }
  });
  return frame;
}
