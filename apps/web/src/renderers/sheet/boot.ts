// Boots a sheet page: reads the payload the shell embeds (typedShellHtml in @plinth/shared),
// parses it with the shared parser, computes its formulas within the browser's step budget,
// builds the grid, and answers the app's print and download messages. It runs synchronously at
// the end of <body>, so the comments bridge (which waits for DOMContentLoaded) sees the finished
// DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name. <html> carries data-ready ("ok" or "error"), data-rows and, when the budget ran
// out, data-exhausted, for tests and thumbnails.
//
// On-page editing (#36), as for docs: view mode renders exactly as before. With `live: "room"` in
// the payload (an owner or editor on the current version, rooms on) it also opens the room's draft
// socket, shows the live draft as it changes and reports its status to the app; edit code runs
// only once the app sends { type: "edit", on: true }. Without `live` that message turns on solo
// editing of the version's lines, which the app saves through its own session after asking for
// them with `collect`. Downloads always give what the page shows.
import {
  applySheetStruct,
  evaluateSheet,
  joinLines,
  LIMITS,
  parseSheet,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  type Sheet,
  type SheetEvaluation,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import { type ClientLease, LiveDocClient } from "../common/live.ts";
import { LocalSheet, type SheetBackend, SheetEditor } from "./edit.ts";
import { exportSheet } from "./export.ts";
import { buildGrid, type Grid } from "./grid.ts";
import { fromApp, readSheetAppMessage, type SheetAppMessage } from "./protocol.ts";

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
  /** For tests: makes the room socket (LiveDocClient's `connect`). */
  connect?: ConstructorParameters<typeof LiveDocClient>[0]["connect"];
  /** For tests: the locale numbers are typed in. */
  locale?: string;
}

const ERRORS: Record<string, string> = {
  invalid: "That change does not fit the sheet, so it was not applied.",
  too_large: "That is more than a sheet can hold. The change was not applied.",
  draft_limit:
    "These edits are live but not kept: the owner has too many pages with unsaved edits. Save a version.",
  rate_limited: "Typing too fast for the room. Your text is kept and sent again.",
  unavailable: "Live editing is unavailable right now. Your text is kept on this page.",
};

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
  const title = doc.title;
  const evaluate = (s: Sheet) =>
    evaluateSheet(s, {
      budget: opts.budget ?? LIMITS.sheetEvalBrowserBudget,
      ...(opts.today !== undefined ? { today: opts.today } : {}),
    });
  let sheet = parsed.sheet;
  let ev: SheetEvaluation = evaluate(sheet);
  let shownText = payload.text;
  const download = (format: "csv" | "xlsx") => exportSheet(win, sheet, ev, title, format);
  const build = () => buildGrid(doc, sheet, ev, { title, exhausted: ev.exhausted });
  let grid: Grid = build();
  root.replaceChildren(grid.el);
  const mark = () => {
    html.setAttribute("data-ready", "ok");
    html.setAttribute("data-rows", String(sheet.rows.length));
    if (ev.exhausted) html.setAttribute("data-exhausted", "");
    else html.removeAttribute("data-exhausted");
  };
  mark();

  let editor: SheetEditor | null = null;
  /** Show these lines (the live draft): in place when the shape is the same, rebuilt otherwise. */
  const show = (text: string) => {
    if (text === shownText) return;
    const p = parseSheet(text);
    if (!p.ok) return;
    shownText = text;
    sheet = p.sheet;
    ev = evaluate(sheet);
    if (!grid.update(sheet, ev)) {
      const view = grid.view();
      const editing = grid.el.classList.contains("plinth-sheet__page--editing");
      grid = build();
      grid.el.classList.toggle("plinth-sheet__page--editing", editing);
      root.replaceChildren(grid.el);
      grid.restore(view);
      editor?.attach(grid);
    } else editor?.render();
    mark();
  };

  const appOrigin = payload.app_origin;
  let live: ReturnType<typeof startLive> | null = null;

  function startLive() {
    let client: LiveDocClient | null = null;
    let local: LocalSheet | null = null;
    let queued = false;
    let renderQueued = false;
    let stopped = false;
    const backend = (): SheetBackend | null => local ?? (client as SheetBackend | null);
    const post = (msg: Record<string, unknown>) => {
      if (appOrigin === "" || stopped) return;
      try {
        win.parent.postMessage(
          { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...msg },
          appOrigin,
        );
      } catch {
        // The app page is gone or navigated away: nobody to tell.
      }
    };
    const statusNow = () => {
      queued = false;
      const c = local ? null : client;
      const b = backend();
      const you = c?.you?.email;
      const holders = new Set([...(c?.leases.values() ?? [])].map((l) => l.by));
      const editors = (c?.editors ?? [])
        .filter((e) => e !== you)
        .slice(0, 50)
        .map((email) => ({ email: email.slice(0, 254), block: holders.has(email) }));
      const s: LiveFrameStatus = {
        connected: c?.connected ?? false,
        failed: client?.failed ?? false,
        editing: editor?.editing ?? false,
        holding: (editor?.editing ?? false) && b?.mine != null,
        dirty: local ? local.dirty : (c?.dirty ?? false),
        unflushed: c ? c.unflushed || (editor?.pending ?? false) : false,
        rev: c?.rev ?? 0,
        base_version: c?.baseVersion ?? 0,
        conflict_version: c?.conflictVersion ?? null,
        last_by_you: c?.lastByYou ?? false,
        last_edit_at: c?.lastEditAt ?? null,
        editors,
      };
      post({ type: "live", ...s });
    };
    const status = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(statusNow);
    };
    const renderNow = () => {
      renderQueued = false;
      const b = backend();
      if (b?.ready) show(joinLines(b.lines));
    };
    const render = () => {
      if (renderQueued) return;
      renderQueued = true;
      queueMicrotask(renderNow);
    };
    const hooks = { save: () => post({ type: "save" }), status, refresh: renderNow };
    const events = {
      granted: (l: ClientLease) => editor?.granted(l),
      changed: () => {
        renderNow();
        editor?.changed();
        status();
      },
    };
    const makeEditor = (b: SheetBackend) => {
      const e = new SheetEditor(win, b, hooks, opts.locale ? { locale: opts.locale } : {});
      e.attach(grid);
      return e;
    };
    const goSolo = () => {
      local ??= new LocalSheet(payload?.text ?? "", events);
      if (editor) editor.setBackend(local);
      else editor = makeEditor(local);
      renderNow();
    };

    if (payload?.live === "room") {
      client = new LiveDocClient({
        win,
        applyStruct: applySheetStruct,
        ...(opts.connect ? { connect: opts.connect } : {}),
        listener: {
          changed: () => {
            if (local) return;
            render();
            queueMicrotask(() => editor?.changed());
          },
          status: () => {
            if (client?.failed && !local && editor?.editing) {
              // The room never answered: keep editing alone.
              goSolo();
            }
            status();
          },
          granted: (l) => {
            if (!local) editor?.granted(l);
          },
          denied: (r, by) => {
            if (!local) editor?.denied(r, by);
          },
          lost: (r) => {
            if (!local) editor?.lost(r);
          },
          version: () => status(),
          error: (code) =>
            editor?.notify(ERRORS[code] ?? "Something went wrong with live editing."),
          structDenied: (r, by) => {
            if (!local) editor?.structDenied(r, by);
          },
        },
      });
      editor = makeEditor(client as SheetBackend);
      client.start();
    }

    const onMessage = (m: Extract<SheetAppMessage, { type: "edit" | "collect" }>) => {
      if (m.type === "edit") {
        if (m.on && (!client || client.failed)) goSolo();
        editor?.setEditing(m.on);
        status();
      } else if (m.type === "collect" && local) {
        editor?.flush();
        post({ type: "draft", nonce: m.nonce, text: local.text });
      }
    };
    return {
      onMessage,
      stop: () => {
        client?.stop();
        editor?.setEditing(false);
        stopped = true;
      },
    };
  }

  if (payload.live === "room" && appOrigin !== "") live = startLive();

  const onMessage = (e: MessageEvent) => {
    if (!fromApp(e, win, appOrigin)) return;
    const m = readSheetAppMessage(e.data);
    if (!m) return;
    if (m.type === "print") win.print();
    else if (m.type === "export") download(m.format);
    else {
      live ??= startLive();
      live.onMessage(m);
    }
  };
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("message", onMessage);
    live?.stop();
  };
}
