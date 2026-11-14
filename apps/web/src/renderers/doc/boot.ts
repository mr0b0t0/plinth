// Boots a doc page: reads the payload the shell embeds (typedShellHtml in @plinth/shared), renders
// it into the shell's root, and wires printing. It runs synchronously at the end of <body>, so the
// comments bridge (which waits for DOMContentLoaded) sees the finished DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name, so heading ids cannot clobber anything it uses.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

const ROOT_ID = "__plinth-doc";
const DATA_ID = "__plinth-content";
const FALLBACK = "This document could not be shown.";

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
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "doc") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  return value as TypedPayload;
}

function isPrintRequest(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.source === RENDERER_MESSAGE_SOURCE && m.v === RENDERER_PROTOCOL_VERSION && m.type === "print"
  );
}

/** Renders the doc and starts listening for print requests. Returns a function that stops them. */
export function boot(win: Window): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  if (!root || !payload) {
    if (root) {
      const p = doc.createElement("p");
      p.className = "plinth-doc__error";
      p.textContent = FALLBACK;
      root.replaceChildren(p);
    }
    html.setAttribute("data-ready", "error");
    return () => {};
  }

  root.replaceChildren(sanitizeHtml(renderMarkdown(payload.text), doc));
  html.setAttribute("data-ready", "ok");

  // Ctrl/Cmd+P inside the frame prints the frame (the doc), not the app page around it.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      win.print();
    }
  };
  // The artifact page's "Print or save as PDF" item. Only the app page that frames this doc may ask.
  const appOrigin = payload.app_origin;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || appOrigin === "" || e.origin !== appOrigin) return;
    if (isPrintRequest(e.data)) win.print();
  };
  win.addEventListener("keydown", onKey);
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("keydown", onKey);
    win.removeEventListener("message", onMessage);
  };
}
