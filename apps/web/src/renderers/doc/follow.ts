// Live views (docs/spec.md "Live views"): the doc renderer shows a newer version in place when the
// app asks ({ type: "version", n }), so the reader keeps their place, the theme and the page itself;
// nothing reloads. It fetches the version's Markdown from its own origin (/__plinth/v/<n>/, the
// same content pass, connect-src 'self'), renders it exactly as at boot (renderMarkdown, then the
// sanitizer), and scrolls so the block that was at the top of the viewport stays there.
//
// The reader's place is the first top-level block whose top is at or below the viewport's top: the
// nearest heading at or before it (by id) and how many blocks after that heading it sits, its own
// block index, plus its distance from the viewport's top. After the re-render the same heading is
// found again (or, when it is gone, the block at the same index), and the window scrolls by the
// difference.
//
// Images: at boot a relative image resolves against the frame's own path (`/`), which serves the
// current version's files. A browser reuses an image it already loaded in a document for the same
// URL without asking the server again (the HTML "list of available images", which Cache-Control
// does not reach), so in place `chart.png` would keep showing the old version's chart next to the
// new text. A version shown in place points each of its own images at that version's path,
// /__plinth/v/<n>/, whose files never change: a new version is a new URL, which the browser loads.
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

/** Where the reader is in a rendered doc. */
export interface ReadingPlace {
  /** The id of the nearest heading at or before the block, or null when none has one. */
  heading: string | null;
  /** Blocks after that heading (or from the top, without one). */
  skip: number;
  /** The block's index among the root's blocks, used when the heading is gone. */
  index: number;
  /** The block's top, relative to the viewport's top, in CSS pixels. */
  offset: number;
}

const HEADING_RE = /^H[1-6]$/;

function headingId(el: Element): string | null {
  return HEADING_RE.test(el.tagName) && el.id ? el.id : null;
}

/** The reader's place in `root`, or null at the top of the page (nothing to keep). */
export function readingPlace(win: Window, root: HTMLElement): ReadingPlace | null {
  if ((win.scrollY ?? 0) <= 0) return null;
  const blocks = Array.from(root.children);
  let heading: string | null = null;
  let headingAt = -1;
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i] as Element;
    const id = headingId(el);
    if (id) {
      heading = id;
      headingAt = i;
    }
    const top = el.getBoundingClientRect().top;
    if (top >= 0) return { heading, skip: i - (heading ? headingAt : 0), index: i, offset: top };
  }
  return null;
}

/** Scroll `win` so the block at `place` is where it was. */
export function restorePlace(win: Window, root: HTMLElement, place: ReadingPlace): void {
  const blocks = Array.from(root.children);
  if (blocks.length === 0) return;
  const at = place.heading ? blocks.findIndex((el) => headingId(el) === place.heading) : -1;
  // The heading is still there: the same distance after it. Gone (renamed or removed), or never
  // one: the same block index, so the reader is not sent back to the top.
  const target = at >= 0 ? at + place.skip : place.index;
  const el = blocks[Math.max(0, Math.min(target, blocks.length - 1))] as Element;
  const delta = el.getBoundingClientRect().top - place.offset;
  if (delta !== 0) win.scrollBy(0, delta);
}

/** A version directory at the start of a path: `/__plinth/v/<n>`, followed by a `/`. */
const VERSION_DIR_RE = /^\/__plinth\/v\/\d{1,9}(?=\/)/;

/**
 * Where image `src`, which a document at `docUrl` shows, is in version `n`: the same file under
 * /__plinth/v/<n>/ (an absolute path on this origin), or null to leave it as it is (an inline
 * data: image, another origin, or one of Plinth's own paths the author named).
 */
export function versionImageSrc(src: string, docUrl: string, n: number): string | null {
  let abs: URL;
  let here: URL;
  try {
    here = new URL(docUrl);
    abs = new URL(src, here);
  } catch {
    return null;
  }
  if (abs.origin !== here.origin || (abs.protocol !== "http:" && abs.protocol !== "https:")) {
    return null;
  }
  // A frame on a version path (/__plinth/v/<m>/) resolved the image inside that version: the
  // same file in version n. Otherwise anything under /__plinth/ is Plinth's, not the artifact's.
  const dir = VERSION_DIR_RE.exec(here.pathname)?.[0];
  let path = abs.pathname;
  if (dir && path.startsWith(`${dir}/`)) path = path.slice(dir.length);
  else if (path.startsWith("/__plinth/")) return null;
  return `/__plinth/v/${n}${path}${abs.search}`;
}

/** Point the images in `root` at version `n`'s own files (see versionImageSrc). */
export function pinImages(root: ParentNode, docUrl: string, n: number): void {
  for (const img of Array.from(root.querySelectorAll("img[src]"))) {
    const next = versionImageSrc(img.getAttribute("src") ?? "", docUrl, n);
    if (next !== null) img.setAttribute("src", next);
  }
}

const SOURCE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Fetch version `n`'s source (`file`, the type's source path) from this origin and show it in
 * `root`, keeping the reader's place. Returns the new text, or null when it could not be shown
 * (the app then loads a fresh frame): a refused or failed request, a bad file name, or `mayShow`
 * saying no once the text has arrived (someone started editing while it was fetched).
 */
export async function showVersion(
  win: Window,
  root: HTMLElement,
  n: number,
  file: string,
  mayShow: () => boolean = () => true,
): Promise<string | null> {
  if (!Number.isInteger(n) || n < 1 || !SOURCE_FILE_RE.test(file)) return null;
  let text: string;
  try {
    const res = await win.fetch(`/__plinth/v/${n}/${file}`, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }
  // Checked again here, after the await: the screen may have become someone's draft meanwhile.
  if (!mayShow()) return null;
  const place = readingPlace(win, root);
  const fragment = sanitizeHtml(renderMarkdown(text), win.document);
  pinImages(fragment, win.document.baseURI, n);
  root.replaceChildren(fragment);
  if (place) restorePlace(win, root, place);
  return text;
}
