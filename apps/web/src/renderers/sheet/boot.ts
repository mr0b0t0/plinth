// Boots a sheet page: reads the payload the shell embeds (typedShellHtml in @plinth/shared),
// parses it with the shared parser, computes its formulas within the browser's step budget,
// builds the grid, and answers the app's print and download messages. It runs synchronously at
// the end of <body>, so the comments bridge (which waits for DOMContentLoaded) sees the finished
// DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name. <html> carries data-ready ("ok" or "error"), data-rows and, when the budget ran
// out, data-exhausted, for tests and thumbnails.
import {
  evaluateSheet,
  LIMITS,
  parseSheet,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import { exportSheet } from "./export.ts";
import { buildGrid } from "./grid.ts";
import { fromApp, readSheetAppMessage } from "./protocol.ts";

const ROOT_ID = "__plinth-sheet";
const DATA_ID = "__plinth-content";
const FALLBACK = "This sheet could not be shown.";

export function readPayload(doc: Document): TypedPayload | null {
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
  if (p.v !== TYPED_PAYLOAD_VERSION || p.type !== "sheet") return null;
  if (typeof p.text !== "string" || typeof p.app_origin !== "string") return null;
  return value as TypedPayload;
}

export interface BootOptions {
  /** Today as a serial, for tests. */
  today?: number;
  /** The step budget, for tests; default LIMITS.sheetEvalBrowserBudget. */
  budget?: number;
}

/** Renders the sheet and starts listening. Returns a function that stops listening. */
export function boot(win: Window, opts: BootOptions = {}): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  const parsed = payload ? parseSheet(payload.text) : null;
  if (!root || !payload || !parsed?.ok) {
    if (root) {
      const p = doc.createElement("p");
      p.className = "plinth-sheet__fallback";
      p.textContent = FALLBACK;
      root.replaceChildren(p);
    }
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const sheet = parsed.sheet;
  const ev = evaluateSheet(sheet, {
    budget: opts.budget ?? LIMITS.sheetEvalBrowserBudget,
    ...(opts.today !== undefined ? { today: opts.today } : {}),
  });
  const title = doc.title;
  const download = (format: "csv" | "xlsx") => exportSheet(win, sheet, ev, title, format);
  const grid = buildGrid(doc, sheet, ev, { title, onDownload: download, exhausted: ev.exhausted });
  root.replaceChildren(grid.el);
  html.setAttribute("data-ready", "ok");
  html.setAttribute("data-rows", String(sheet.rows.length));
  if (ev.exhausted) html.setAttribute("data-exhausted", "");

  const appOrigin = payload.app_origin;
  const onMessage = (e: MessageEvent) => {
    if (!fromApp(e, win, appOrigin)) return;
    const m = readSheetAppMessage(e.data);
    if (!m) return;
    if (m.type === "print") win.print();
    else download(m.format);
  };
  win.addEventListener("message", onMessage);
  return () => win.removeEventListener("message", onMessage);
}
