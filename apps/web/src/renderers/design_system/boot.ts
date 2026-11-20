// Boots a design system page: reads the payload the shell embeds (typedShellHtml in
// @plinth/shared), parses the JSON with the same parser the Worker uses, renders the reference
// site into the shell's root, and wires hash navigation and printing. It sets
// html[data-ready="ok"|"error"], which thumbnails and end-to-end tests wait for.
//
// It finds the root and data by id and reads only window properties the platform defines.
import {
  designSystemFontFaces,
  designSystemFontLinks,
  parseDesignSystem,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { PreviewTheme } from "./preview.ts";
import { renderProblems, renderSite, sectionId, setPreviewTheme } from "./render.ts";

const ROOT_ID = "__plinth-design_system";
const DATA_ID = "__plinth-content";

function readPayload(doc: Document): TypedPayload | null {
  const raw = doc.getElementById(DATA_ID)?.textContent;
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "design_system") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  return value as TypedPayload;
}

/** The hash without its "#", percent-decoded when it decodes (a malformed one is used as is). */
function hashOf(doc: Document): string {
  const raw = doc.defaultView?.location.hash.slice(1) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Scroll to the section the hash names (#tokens/color), if there is one. */
function follow(doc: Document): void {
  const hash = hashOf(doc);
  if (!hash) return;
  const target = doc.getElementById(sectionId(hash)) ?? doc.getElementById(hash);
  target?.scrollIntoView?.({ block: "start" });
}

/**
 * Marks the navigation link of the section in view (aria-current) as the reader scrolls. On a
 * phone, where the navigation is one row that scrolls sideways, the row brings that link into
 * view; the page itself never moves. Returns a function that stops it.
 */
function trackSection(win: Window, root: HTMLElement): () => void {
  const Observer = (win as Window & typeof globalThis).IntersectionObserver as
    | typeof IntersectionObserver
    | undefined;
  const nav = root.querySelector<HTMLElement>(".ds-nav");
  if (!Observer || !nav) return () => {};
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of Array.from(nav.querySelectorAll<HTMLAnchorElement>("a[href^='#']"))) {
    links.set(a.getAttribute("href")?.slice(1) ?? "", a);
  }
  const sections = Array.from(root.querySelectorAll<HTMLElement>(".ds-content > [data-hash]"));
  const inView = new Set<Element>();
  const update = () => {
    const hash = sections.find((s) => inView.has(s))?.dataset.hash;
    for (const [h, a] of links) {
      if (h !== hash) {
        a.removeAttribute("aria-current");
        continue;
      }
      if (a.hasAttribute("aria-current")) continue;
      a.setAttribute("aria-current", "true");
      if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: Math.max(0, a.offsetLeft - 16) });
    }
  };
  // A section counts while it crosses the top 40% of the viewport; the first such one is current.
  const observer = new Observer(
    (entries: IntersectionObserverEntry[]) => {
      for (const e of entries) {
        if (e.isIntersecting) inView.add(e.target);
        else inView.delete(e.target);
      }
      update();
    },
    { rootMargin: "0px 0px -60% 0px" },
  );
  for (const s of sections) observer.observe(s);
  return () => observer.disconnect();
}

/** Renders the site and starts listening. Returns a function that stops it. */
export function boot(win: Window): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  if (!root || !payload) {
    root?.replaceChildren(renderProblems(doc));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const parsed = parseDesignSystem(payload.text);
  if (!parsed.ok) {
    root.replaceChildren(renderProblems(doc));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const ds = parsed.value;
  // The design system's fonts, for the type specimens: Google Fonts stylesheets (validated by the
  // parser, allowed by the content CSP) and @font-face rules for its own font files.
  for (const href of designSystemFontLinks(ds)) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.referrerPolicy = "no-referrer";
    doc.head.append(link);
  }
  const faces = designSystemFontFaces(ds);
  if (faces) {
    const style = doc.createElement("style");
    style.textContent = faces;
    doc.head.append(style);
  }
  // Previews follow the reader's color scheme, as the site's own chrome does.
  const scheme = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const theme = (): PreviewTheme => (scheme?.matches ? "dark" : "light");
  root.replaceChildren(renderSite(doc, ds, theme()));
  html.setAttribute("data-ready", "ok");
  follow(doc);
  const stopTracking = trackSection(win, root);

  const onScheme = () => setPreviewTheme(root, theme());
  scheme?.addEventListener?.("change", onScheme);
  const onHash = () => follow(doc);
  // Ctrl/Cmd+P inside the frame prints the frame, not the app page around it.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      win.print();
    }
  };
  // A print request, only from the app page that frames this one.
  const appOrigin = payload.app_origin;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || appOrigin === "" || e.origin !== appOrigin) return;
    const m = e.data as Record<string, unknown> | null;
    if (
      m &&
      m.source === RENDERER_MESSAGE_SOURCE &&
      m.v === RENDERER_PROTOCOL_VERSION &&
      m.type === "print"
    ) {
      win.print();
    }
  };
  win.addEventListener("hashchange", onHash);
  win.addEventListener("keydown", onKey);
  win.addEventListener("message", onMessage);
  return () => {
    stopTracking();
    scheme?.removeEventListener?.("change", onScheme);
    win.removeEventListener("hashchange", onHash);
    win.removeEventListener("keydown", onKey);
    win.removeEventListener("message", onMessage);
  };
}
