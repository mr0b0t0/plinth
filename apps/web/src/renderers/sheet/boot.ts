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
// them with `collect`. Downloads always give what the page shows. A frozen draft is reviewed whole
// in the frame (common/review.ts) when the app sends `review`: the two grids side by side, with
// what each side changed. Every editing message to the app carries the frame key the app put in
// the address (common/frameKey.ts), which is taken out of it before anything renders.
import {
  applySheetStruct,
  type ChangeItem,
  colIndex,
  evaluateSheet,
  joinLines,
  LIMITS,
  liveRules,
  parseSheet,
  type Sheet,
  type SheetEvaluation,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import { appPoster, ReviewSession } from "../common/editSession.ts";
import { takeFrameKey } from "../common/frameKey.ts";
import { type ClientLease, LiveDocClient } from "../common/live.ts";
import { DraftReview, type ReviewPane } from "../common/review.ts";
import { LocalSheet, type SheetBackend, SheetEditor } from "./edit.ts";
import { exportSheet } from "./export.ts";
import { buildGrid, type Grid } from "./grid.ts";
import { fromApp, readSheetAppMessage, type SheetAppMessage } from "./protocol.ts";

const ROOT_ID = "__plinth-sheet";
const DATA_ID = "__plinth-content";
const FALLBACK = "This sheet could not be shown.";
const RULES = liveRules("sheet");

/** Where a change item points in a grid: its cell, its row, or its column. */
function gridGoto(grid: Grid): (item: ChangeItem) => boolean {
  return (item) => {
    const cell = /^([A-Z]{1,3})(\d+)\b/.exec(item.what);
    const row = /^Row (\d+)/.exec(item.where) ?? /^Rows? (\d+)/.exec(item.what);
    const col = /^Column ([A-Z]{1,3})$/.exec(item.where);
    const td = cell
      ? grid.cell(Number(cell[2]), colIndex(cell[1] as string))
      : row
        ? grid.cell(Number(row[1]), 0)
        : col
          ? grid.cell(1, colIndex(col[1] as string))
          : null;
    if (!td) return false;
    td.scrollIntoView({ block: "center", inline: "center" });
    return true;
  };
}

/** The sheet's side of the review: its grid, read-only (no editing is attached to it). */
function sheetPane(doc: Document, evaluate: (s: Sheet) => SheetEvaluation): ReviewPane {
  return {
    render(el, text) {
      const p = parseSheet(text);
      if (!p.ok) {
        const msg = doc.createElement("p");
        msg.textContent = "This sheet could not be shown.";
        el.replaceChildren(msg);
        return null;
      }
      const ev = evaluate(p.sheet);
      const grid = buildGrid(doc, p.sheet, ev, {
        title: "",
        onDownload: () => undefined,
        exhausted: ev.exhausted,
      });
      el.replaceChildren(grid.el);
      return gridGoto(grid);
    },
  };
}

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
  /** For tests: dock an open cell's field at the bottom (phone width), or never. */
  dock?: boolean;
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
  // The frame key leaves the address before anything renders (common/frameKey.ts).
  const key = takeFrameKey(win);
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
  const build = () =>
    buildGrid(doc, sheet, ev, { title, onDownload: download, exhausted: ev.exhausted });
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
      // A rebuild (new columns, a width, a row count) keeps the focus on the selected cell.
      const focused = grid.el.contains(doc.activeElement);
      grid = build();
      grid.el.classList.toggle("plinth-sheet__page--editing", editing);
      root.replaceChildren(grid.el);
      grid.restore(view);
      editor?.attach(grid);
      const now = doc.activeElement;
      if (focused && (now === null || now === doc.body)) grid.focusSelected();
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
    const backend = (): SheetBackend | null => local ?? (client as SheetBackend | null);
    const poster = appPoster(win, appOrigin, key);
    const post = poster.post;
    const statusNow = () => {
      queued = false;
      const c = local ? null : client;
      const b = backend();
      const you = c?.you?.email;
      // Where each other editor is: the row (or the header) of their lease, never its content.
      const where = new Map<string, string>();
      for (const l of c?.leases.values() ?? []) {
        if (l.end > l.start) where.set(l.by, l.start === 0 ? "the header" : `row ${l.start + 1}`);
      }
      const editors = (c?.editors ?? [])
        .filter((e) => e !== you)
        .slice(0, 50)
        .map((email) => {
          const w = where.get(email);
          return { email: email.slice(0, 254), block: w !== undefined, ...(w ? { where: w } : {}) };
        });
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
        publishable: RULES?.unpublishable(local ? local.text : (c?.text ?? "")) === null,
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
    const hooks = {
      save: () => post({ type: "save" }),
      status,
      refresh: renderNow,
      leave: () => {
        if (!session.isOpen) post({ type: "leave" });
      },
    };
    const review = new DraftReview({
      win,
      type: "sheet",
      sourcePath: payload?.path ?? "sheet.jsonl",
      rules: RULES as NonNullable<typeof RULES>,
      pane: sheetPane(doc, evaluate),
      choose: (outcome, note) => session.choose(outcome, note),
    });
    const session = new ReviewSession(review, {
      post,
      rules: RULES as NonNullable<typeof RULES>,
      room: () => (local ? null : client),
      soloText: () => local?.text ?? null,
    });
    const events = {
      granted: (l: ClientLease) => editor?.granted(l),
      changed: () => {
        renderNow();
        editor?.changed();
        status();
      },
    };
    const makeEditor = (b: SheetBackend) => {
      const e = new SheetEditor(win, b, hooks, {
        ...(opts.locale ? { locale: opts.locale } : {}),
        ...(opts.dock !== undefined ? { dock: opts.dock } : {}),
      });
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
          version: (kind, n, info) => {
            if (!local) session.version(kind, n, info);
            status();
          },
          error: (code) => {
            // A refused change: the grid shows the room's lines again, and says why.
            if (code === "invalid") renderNow();
            editor?.notify(ERRORS[code] ?? "Something went wrong with live editing.");
          },
          structDenied: (r, by) => {
            if (!local) editor?.structDenied(r, by);
          },
        },
      });
      editor = makeEditor(client as SheetBackend);
      client.start();
    }

    const onMessage = (m: Exclude<SheetAppMessage, { type: "print" | "export" }>) => {
      if (m.type === "edit") {
        if (m.on && (!client || client.failed)) goSolo();
        editor?.setEditing(m.on);
        status();
      } else if (m.type === "collect" && local) {
        editor?.flush();
        post({ type: "draft", nonce: m.nonce, text: local.text });
      } else if (m.type === "review") {
        editor?.flush();
        void session.open(m);
      } else if (m.type === "reviewed") {
        session.answer(m);
      }
    };
    return {
      onMessage,
      stop: () => {
        client?.stop();
        editor?.setEditing(false);
        review.close();
        poster.stop();
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
