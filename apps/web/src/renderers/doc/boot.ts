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
// text, which the app saves through its own session after asking for it with `collect`. A frozen
// draft is reviewed whole in the frame (common/review.ts) when the app sends `review`. Every
// editing message to the app carries the frame key the app put in the address
// (common/frameKey.ts), which is taken out of it before anything renders.
//
// Live views: { type: "version", n, nonce } shows version n in place (follow.ts) and answers
// { type: "shown", n, nonce, ok }. It is refused (ok: false, and the app loads a fresh frame) while
// a room client is attached or anything is being edited; otherwise the text solo editing starts
// from becomes the version on screen.
import {
  type ChangeItem,
  liveRules,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import {
  appPoster,
  type EditAppMessage,
  NONCE_RE,
  ReviewSession,
  readEditMessage,
} from "../common/editSession.ts";
import { pinFiles } from "../common/files.ts";
import { takeFrameKey } from "../common/frameKey.ts";
import { LiveDocClient } from "../common/live.ts";
import { DraftReview, markChangedChildren, type ReviewPane } from "../common/review.ts";
import { type DocBackend, DocEditor, LocalDoc, REFUSED_EDIT } from "./edit.ts";
import { pinImages, showVersion } from "./follow.ts";
import { renderMarkdown } from "./markdown.ts";
import { sanitizeHtml } from "./sanitize.ts";

const ROOT_ID = "__plinth-doc";
const DATA_ID = "__plinth-content";
const FALLBACK = "This document could not be shown.";
const RULES = liveRules("doc");

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
  | { type: "version"; n: number; nonce: string }
  | EditAppMessage;

/** A message from the app page, validated, or null. */
export function readAppMessage(data: unknown): AppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "print") return { type: "print" };
  if (m.type === "version") {
    if (
      typeof m.n === "number" &&
      Number.isInteger(m.n) &&
      m.n >= 1 &&
      m.n < 2 ** 31 &&
      typeof m.nonce === "string" &&
      NONCE_RE.test(m.nonce)
    ) {
      return { type: "version", n: m.n, nonce: m.nonce };
    }
    return null;
  }
  return readEditMessage(data);
}

const ERRORS: Record<string, string> = {
  invalid: REFUSED_EDIT,
  too_large: "That is more than a doc can hold. The change was not applied.",
  draft_limit:
    "These edits are live but not kept: the owner has too many docs with unpublished page edits. Publish a version.",
  rate_limited: "Typing too fast for the room. Your text is kept and sent again.",
  unavailable: "Live editing is unavailable right now. Your text is kept on this page.",
};

/** Where a change item points in a rendered doc: the heading it names, if any. */
function docGoto(root: HTMLElement): (item: ChangeItem) => boolean {
  return (item) => {
    const m = /“([^”]*)”/.exec(item.where);
    if (!m) return false;
    const name = (m[1] as string).replace(/…$/, "");
    for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      if ((h.textContent ?? "").trim().startsWith(name)) {
        h.scrollIntoView({ block: "start" });
        return true;
      }
    }
    return false;
  };
}

/**
 * The doc's side of the review: its blocks, drawn read-only with that version's files, with the
 * blocks that differ from the base marked.
 */
export function docPane(doc: Document): ReviewPane {
  return {
    render(el, text, version, base) {
      const wrap = doc.createElement("div");
      wrap.className = "plinth-doc plinth-review__doc";
      wrap.append(sanitizeHtml(renderMarkdown(text), doc));
      if (base !== null) {
        // Compared before the files are pinned, so a block differs only when its source does.
        const was = doc.createElement("div");
        was.append(sanitizeHtml(renderMarkdown(base), doc));
        markChangedChildren(was, wrap);
      }
      pinFiles(wrap, version);
      el.replaceChildren(wrap);
      return docGoto(wrap);
    },
  };
}

/** Wires on-page editing. Returns a function that stops it. */
function live(
  win: Window,
  root: HTMLElement,
  payload: TypedPayload,
  appOrigin: string,
  key: string | null,
  prepare?: (fragment: DocumentFragment) => void,
) {
  let client: LiveDocClient | null = null;
  let local: LocalDoc | null = null;
  let editor: DocEditor | null = null;
  let queued = false;
  /** Solo: the version shown, whose files the draft is drawn with. */
  let soloBase: number | null = null;

  const poster = appPoster(win, appOrigin, key);
  const post = poster.post;
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
    const text = local ? local.text : (c?.text ?? "");
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
      publishable: RULES?.unpublishable(text) === null,
    };
    post({ type: "live", ...s });
  };
  const status = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(statusNow);
  };
  const hooks = {
    save: () => post({ type: "save" }),
    status,
    leave: () => {
      if (!session.isOpen) post({ type: "leave" });
    },
    fileVersion: () => {
      if (local) return soloBase;
      return client && client.baseVersion > 0 ? client.baseVersion : null;
    },
  };
  const events = {
    granted: (l: Parameters<DocEditor["granted"]>[0]) => editor?.granted(l),
    changed: () => {
      editor?.changed();
      status();
    },
  };

  const review = new DraftReview({
    win,
    type: "doc",
    sourcePath: payload.path,
    rules: RULES as NonNullable<typeof RULES>,
    pane: docPane(win.document),
    choose: (outcome, note) => session.choose(outcome, note),
  });
  const session = new ReviewSession(review, {
    post,
    rules: RULES as NonNullable<typeof RULES>,
    room: () => (local ? null : client),
    soloText: () => local?.text ?? null,
  });

  const goSolo = () => {
    local ??= new LocalDoc(payload.text, events);
    if (editor) editor.setBackend(local);
    else editor = new DocEditor(root, win, local, hooks, prepare);
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
        version: (kind, n, info) => {
          if (!local) session.version(kind, n, info);
          status();
        },
        error: (code) => {
          if (code === "invalid") editor?.refused(REFUSED_EDIT);
          else editor?.notify(ERRORS[code] ?? "Something went wrong with live editing.");
        },
      },
    });
    editor = new DocEditor(root, win, client, hooks, prepare);
    client.start();
  }

  const onMessage = (m: EditAppMessage) => {
    if (m.type === "edit") {
      if (m.base !== undefined) soloBase = m.base;
      if (m.on && (!client || client.failed)) goSolo();
      editor?.setEditing(m.on);
      if (m.focus === "first") editor?.focusFirst();
      editor?.render();
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
    /**
     * Nothing here keeps text of its own: no room client, no editing, no solo copy with changes.
     * Only then may a newer version replace what is on screen.
     */
    idle: () => !client && !(editor?.editing ?? false) && !(local?.dirty ?? false),
    stop: () => {
      client?.stop();
      editor?.setEditing(false);
      review.close();
      poster.stop();
    },
  };
}

/** Renders the doc and starts listening for print requests. Returns a function that stops them. */
export function boot(win: Window): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  // The frame key leaves the address before anything renders (common/frameKey.ts).
  const key = takeFrameKey(win);
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
  // The version last shown in place, if any: from then on the editor renders its images from that
  // version's own files too, as showVersion does (follow.ts), not the ones loaded at boot.
  let shown: number | null = null;
  const prepare = (fragment: DocumentFragment) => {
    if (shown !== null) pinImages(fragment, doc.baseURI, shown);
  };
  let editing: ReturnType<typeof live> | null =
    payload.live === "room" && appOrigin !== ""
      ? live(win, root, payload, appOrigin, key, prepare)
      : null;
  const answer = (msg: Record<string, unknown>) => {
    try {
      win.parent.postMessage(
        { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...msg },
        appOrigin,
      );
    } catch {
      // The app page is gone: nobody to tell.
    }
  };
  // One version at a time, in the order asked.
  let following: Promise<void> = Promise.resolve();
  const follow = (n: number, nonce: string) => {
    following = following.then(async () => {
      const idle = () => !editing || editing.idle();
      if (!idle()) return answer({ type: "shown", n, nonce, ok: false });
      // Edit may be turned on while the text is fetched: showVersion asks `idle` again before it
      // replaces anything, so an editor opened meanwhile is never torn down.
      const text = await showVersion(win, root, n, payload.path, idle);
      if (text === null) return answer({ type: "shown", n, nonce, ok: false });
      // Editing starts from the version on screen: drop the idle editor, which held the old text.
      editing?.stop();
      editing = null;
      payload.text = text;
      shown = n;
      answer({ type: "shown", n, nonce, ok: true });
    });
  };
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.parent || appOrigin === "" || e.origin !== appOrigin) return;
    const m = readAppMessage(e.data);
    if (!m) return;
    if (m.type === "print") return win.print();
    if (m.type === "version") return follow(m.n, m.nonce);
    editing ??= live(win, root, payload, appOrigin, key, prepare);
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
