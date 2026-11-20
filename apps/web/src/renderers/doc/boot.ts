// Boots a doc page: reads the payload the shell embeds (typedShellHtml in @plinth/shared), renders
// it into the shell's root, and wires printing. It runs synchronously at the end of <body>, so the
// comments bridge (which waits for DOMContentLoaded) sees the finished DOM.
//
// It finds the root and data by id and reads only window properties the platform defines, never a
// global by name, so heading ids cannot clobber anything it uses.
//
// On-page editing (#36): view mode renders exactly as before. With `live: "room"` in the payload
// (an owner or editor on the current version, rooms on) it also opens the doc socket, follows the
// live draft and reports its status to the app; edit code runs only once the app sends
// { type: "edit", on: true }. Without `live` that message turns on solo editing of the version's
// text, which the app saves through its own session after asking for it with `collect`.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import { LiveDocClient } from "../common/live.ts";
import { type DocBackend, DocEditor, LocalDoc } from "./edit.ts";
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

type AppMessage =
  | { type: "print" }
  | { type: "edit"; on: boolean }
  | { type: "collect"; nonce: string };

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** A message from the app page, validated, or null. */
export function readAppMessage(data: unknown): AppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "print") return { type: "print" };
  if (m.type === "edit" && typeof m.on === "boolean") return { type: "edit", on: m.on };
  if (m.type === "collect" && typeof m.nonce === "string" && NONCE_RE.test(m.nonce)) {
    return { type: "collect", nonce: m.nonce };
  }
  return null;
}

const ERRORS: Record<string, string> = {
  too_large: "That is more than a doc can hold. The change was not applied.",
  draft_limit:
    "These edits are live but not kept: the owner has too many docs with unsaved page edits. Save a version.",
  rate_limited: "Typing too fast for the room. Your text is kept and sent again.",
  unavailable: "Live editing is unavailable right now. Your text is kept on this page.",
};

/** Wires on-page editing. Returns a function that stops it. */
function live(win: Window, root: HTMLElement, payload: TypedPayload, appOrigin: string) {
  let client: LiveDocClient | null = null;
  let local: LocalDoc | null = null;
  let editor: DocEditor | null = null;
  let queued = false;

  let stopped = false;
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
    const backend: DocBackend | null = local ?? client;
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
      holding: (editor?.editing ?? false) && backend?.mine != null,
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
  const hooks = { save: () => post({ type: "save" }), status };
  const events = {
    granted: (l: Parameters<DocEditor["granted"]>[0]) => editor?.granted(l),
    changed: () => {
      editor?.changed();
      status();
    },
  };

  const goSolo = () => {
    local ??= new LocalDoc(payload.text, events);
    if (editor) editor.setBackend(local);
    else editor = new DocEditor(root, win, local, hooks);
  };

  if (payload.live === "room") {
    client = new LiveDocClient({
      win,
      listener: {
        changed: () => {
          if (!local) editor?.changed();
        },
        status: () => {
          if (client?.failed && !local && editor?.editing) {
            // The room never answered: keep editing alone.
            goSolo();
            editor.render();
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
        error: (code) => editor?.notify(ERRORS[code] ?? "Something went wrong with live editing."),
      },
    });
    editor = new DocEditor(root, win, client, hooks);
    client.start();
  }

  const onMessage = (m: AppMessage) => {
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
  // The artifact page's "Print or save as PDF" item, and on-page editing. Only the app page that
  // frames this doc may ask.
  const appOrigin = payload.app_origin;
  let editing: ReturnType<typeof live> | null =
    payload.live === "room" && appOrigin !== "" ? live(win, root, payload, appOrigin) : null;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || appOrigin === "" || e.origin !== appOrigin) return;
    const m = readAppMessage(e.data);
    if (!m) return;
    if (m.type === "print") return win.print();
    editing ??= live(win, root, payload, appOrigin);
    editing.onMessage(m);
  };
  win.addEventListener("keydown", onKey);
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("keydown", onKey);
    win.removeEventListener("message", onMessage);
    editing?.stop();
  };
}
