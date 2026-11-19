// Download a deck as .pptx, inside the frame, on the artifact's own origin. The app only asks (an
// `export` message with a nonce) and hears back booleans and a count (`exported`); the deck's text
// never leaves this document except in the file the viewer saves.
//
// 1. The writer (PptxGenJS, about 370 kB) is a lazy renderer file: slides-pptx.js is added to this
//    page from 'self' only now, and hands its writer over with one document event (pptx.ts).
// 2. Every slide is laid out and fitted (as for print) and measured (exportModel.ts).
// 3. Images: under origin isolation the frame reads its own files (connect-src 'self', the
//    content cookie) and SVG, WebP and AVIF are drawn to PNG at twice their size (a same-origin
//    image does not taint the canvas). Under opaque isolation and the path fallback this document
//    has no origin of its own: it cannot read its files (the content host sends no CORS, by rule)
//    and a canvas would be tainted, so file images are left out and the app says so. Inline
//    data: images are part of the deck's text and always go in.
// 4. The file is saved with an <a download> click in the frame (both frame sandboxes allow
//    downloads). A browser may refuse a download the frame did not start from a click of its own,
//    so the frame also shows a "ready" notice whose Download button starts it from such a click.
import { LIMITS, TYPE_REGISTRY } from "@plinth/shared";
import { imageSources } from "./exportModel.ts";
import { type DeckModel, PPTX_READY_EVENT, type PptxBuilder } from "./pptxModel.ts";

/** How long the writer may take to load before the export fails. */
export const WRITER_TIMEOUT_MS = 30_000;
/** How long the ready notice stays (its blob URL is released when it goes). */
export const READY_NOTICE_MS = 30_000;
/** The largest side of an image drawn to PNG, in pixels. */
const MAX_RASTER = 4096;

const RASTER_PASS = /^image\/(png|jpeg|gif)$/;
const DATA_PASS = /^data:image\/(png|jpeg|gif);base64,/i;

/**
 * The URL of the lazy writer, next to this renderer's own script: the shell loads the renderer from
 * <base>/__plinth/types/slides/slides.js, whatever the base (the artifact root, a version path, the
 * path fallback or the editor preview). Null when the renderer script is not found.
 */
export function writerUrl(doc: Document): string | null {
  const renderer = TYPE_REGISTRY.slides.renderer;
  const lazy = renderer?.lazy?.[0]?.file;
  if (!renderer || !lazy) return null;
  const tail = `/__plinth/types/slides/${renderer.script}`;
  for (const s of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = s.getAttribute("src") ?? "";
    if (src.endsWith(tail)) return `${src.slice(0, -renderer.script.length)}${lazy}`;
  }
  return null;
}

/**
 * Loads the writer once: listens for its event, then adds its script (`mount`, the document's
 * head by default). Fails on a load error or after `timeoutMs`; a later call tries again.
 */
export function writerLoader(
  doc: Document,
  timeoutMs = WRITER_TIMEOUT_MS,
  mount: (script: HTMLScriptElement) => void = (s) => doc.head.append(s),
): () => Promise<PptxBuilder> {
  let pending: Promise<PptxBuilder> | null = null;
  return () => {
    if (pending) return pending;
    const src = writerUrl(doc);
    if (!src) return Promise.reject(new Error("The .pptx writer was not found"));
    pending = new Promise<PptxBuilder>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const script = doc.createElement("script");
      const done = () => {
        clearTimeout(timer);
        doc.removeEventListener(PPTX_READY_EVENT, onReady);
      };
      const fail = (message: string) => {
        done();
        script.remove();
        pending = null;
        reject(new Error(message));
      };
      const onReady = (e: Event) => {
        const build = (e as CustomEvent<{ build?: unknown }>).detail?.build;
        if (typeof build !== "function") return;
        done();
        resolve(build as PptxBuilder);
      };
      doc.addEventListener(PPTX_READY_EVENT, onReady);
      script.addEventListener("error", () => fail("The .pptx writer did not load"));
      timer = setTimeout(() => fail("The .pptx writer took too long to load"), timeoutMs);
      script.src = src;
      mount(script);
    });
    return pending;
  };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("read")));
    r.onerror = () => reject(r.error ?? new Error("read"));
    r.readAsDataURL(blob);
  });
}

/** Draws an image (a blob or a data: URL) to a PNG data URL at twice its size, or null. */
async function rasterize(win: Window, from: Blob | string): Promise<string | null> {
  const url = typeof from === "string" ? from : URL.createObjectURL(from);
  try {
    const img = win.document.createElement("img");
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    const s = Math.min(2, MAX_RASTER / w, MAX_RASTER / h);
    const canvas = win.document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    if (typeof from !== "string") URL.revokeObjectURL(url);
  }
}

/**
 * One image of the deck as a data: URL the writer takes (PNG, JPEG or GIF), or null when it is left
 * out. `opaque`: this document has no origin of its own, so it reads none of its files.
 */
export async function imageData(win: Window, src: string, opaque: boolean): Promise<string | null> {
  if (DATA_PASS.test(src)) return src;
  if (/^data:image\//i.test(src)) return rasterize(win, src);
  if (opaque) return null;
  let url: URL;
  try {
    url = new URL(src, win.document.baseURI);
  } catch {
    return null;
  }
  // Only the artifact's own files; the CSP (connect-src 'self') says the same.
  if (url.origin !== win.location.origin) return null;
  try {
    const res = await win.fetch(url.href, { credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = (blob.type.split(";")[0] ?? "").trim().toLowerCase();
    if (RASTER_PASS.test(type)) return await readAsDataUrl(blob);
    if (type.startsWith("image/")) return await rasterize(win, blob);
    return null;
  } catch {
    return null;
  }
}

/** Every image of the model that can go in, keyed by its src (at most the version's file cap). */
export async function collectImages(
  win: Window,
  model: DeckModel,
  opaque: boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const srcs = imageSources(model).slice(0, LIMITS.maxAssetsCeiling);
  const got = await Promise.all(srcs.map((src) => imageData(win, src, opaque)));
  srcs.forEach((src, i) => {
    const data = got[i];
    if (data) out.set(src, data);
  });
  return out;
}

/** Starts a download of `url` as `name` from this document. */
export function clickDownload(doc: Document, url: string, name: string): void {
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
}

const closers = new WeakMap<Element, () => void>();

/**
 * The "ready" notice: the file name and a Download button that starts the download from a click
 * in the frame, for browsers that refuse the first one. Plinth's own UI, made with textContent.
 * It goes after READY_NOTICE_MS or on Dismiss, and releases the blob URL then.
 */
export function showReadyNotice(
  doc: Document,
  root: HTMLElement,
  url: string,
  name: string,
  ms = READY_NOTICE_MS,
): () => void {
  for (const old of Array.from(root.querySelectorAll(".plinth-slides__ready"))) {
    closers.get(old)?.();
  }
  const bar = doc.createElement("div");
  bar.className = "plinth-slides__ready";
  bar.dataset.plinthControl = "";
  bar.setAttribute("role", "status");
  const text = doc.createElement("span");
  text.className = "plinth-slides__ready-text";
  text.textContent = `${name} is ready`;
  const download = doc.createElement("button");
  download.type = "button";
  download.className = "plinth-slides__btn";
  download.textContent = "Download";
  download.addEventListener("click", () => clickDownload(doc, url, name));
  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "plinth-slides__btn";
  dismiss.textContent = "Dismiss";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    bar.remove();
    URL.revokeObjectURL(url);
  };
  dismiss.addEventListener("click", close);
  closers.set(bar, close);
  bar.append(text, download, dismiss);
  root.append(bar);
  timer = setTimeout(close, ms);
  return close;
}
