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
import { renderProblems, renderSite, sectionId } from "./render.ts";

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

/** Scroll to the section the hash names (#tokens/color), if there is one. */
function follow(doc: Document): void {
  const hash = decodeURIComponent(doc.defaultView?.location.hash.slice(1) ?? "");
  if (!hash) return;
  const target = doc.getElementById(sectionId(hash)) ?? doc.getElementById(hash);
  target?.scrollIntoView?.({ block: "start" });
}

/** Renders the site and starts listening. Returns a function that stops it. */
export function boot(win: Window): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  if (!root || !payload) {
    root?.replaceChildren(
      renderProblems(doc, [{ path: "", message: "is not a design system page" }]),
    );
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const parsed = parseDesignSystem(payload.text);
  if (!parsed.ok) {
    root.replaceChildren(renderProblems(doc, parsed.errors));
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
  root.replaceChildren(renderSite(doc, ds));
  html.setAttribute("data-ready", "ok");
  follow(doc);

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
    win.removeEventListener("hashchange", onHash);
    win.removeEventListener("keydown", onKey);
    win.removeEventListener("message", onMessage);
  };
}
