// Boots a design system page: reads the payload the shell embeds (typedShellHtml in
// @plinth/shared), parses the JSON with the same parser the Worker uses, renders the reference
// site into the shell's root, and wires hash navigation and printing. It sets
// html[data-ready="ok"|"error"], which thumbnails and end-to-end tests wait for.
//
// It finds the root and data by id and reads only window properties the platform defines.
//
// On-page editing (#36), as for docs and sheets: view mode renders exactly as before. With
// `live: "room"` in the payload (an owner or editor on the current version, rooms on) it also opens
// the room's draft socket, shows the live draft (a line projection of the JSON,
// designSystemLive.ts) as it changes and reports its status to the app; edit code runs only once
// the app sends { type: "edit", on: true }. Without `live` that message turns on solo editing of
// the version's projection, which the app saves through its own session after asking for it with
// `collect` (the frame hands over the storage form, never the projection). A system too large to
// edit on its page answers with `unavailable: "too_large"`. A frozen draft is reviewed whole in the
// frame (common/review.ts) when the app sends `review`: the two sites side by side, each with its
// own version's files. Every editing message to the app carries the frame key the app put in the
// address (common/frameKey.ts), which is taken out of it before anything renders.
import {
  applyDesignSystemStruct,
  type DesignSystem,
  type DsStructOp,
  type LiveStructOp,
  liveRules,
  parseDesignSystem,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  TYPED_PAYLOAD_VERSION,
  type TypedPayload,
} from "@plinth/shared";
import type { LiveFrameStatus } from "../../components/viewer/rendererProtocol.ts";
import {
  appPoster,
  type EditAppMessage,
  ReviewSession,
  readEditMessage,
} from "../common/editSession.ts";
import { takeFrameKey } from "../common/frameKey.ts";
import { type ClientLease, LiveDocClient, type LiveDocOptions } from "../common/live.ts";
import { DraftReview } from "../common/review.ts";
import { blockWords, type RescueReport } from "../doc/edit.ts";
import { renderMarkdown } from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { DsEditor } from "./edit.ts";
import { LocalSystem } from "./local.ts";
import { applyFonts, systemPane } from "./pane.ts";
import type { PreviewTheme } from "./preview.ts";
import { renderProblems, renderSite, sectionId, setPreviewTheme, tokenGroup } from "./render.ts";

const ROOT_ID = "__plinth-design_system";
const DATA_ID = "__plinth-content";
const RULES = liveRules("design_system");

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

const ERRORS: Record<string, string> = {
  draft_limit:
    "These edits are live but not kept: the owner has too many artifacts with unpublished page edits. Publish a version.",
  rate_limited: "Changing too fast for the room. Your change is kept and sent again.",
  unavailable: "Live editing is unavailable right now. Your changes are kept on this page.",
};

/**
 * What may cross to the app as an anchor's words: only what the published version shows (token
 * and group paths, component names, the first words of its formatted texts' blocks), so no draft
 * text reaches the app.
 */
function publishedWords(doc: Document, ds: DesignSystem | null): Set<string> {
  const out = new Set<string>(["Fonts and settings", "Problems"]);
  if (!ds) return out;
  for (const t of ds.tokens) {
    out.add(t.path);
    out.add(tokenGroup(t.path));
  }
  const texts = [ds.guidelines, ds.description];
  for (const c of ds.components) {
    out.add(c.name);
    texts.push(c.description, c.usage);
  }
  for (const md of texts) {
    if (!md) continue;
    const shown = sanitizeHtml(renderMarkdown(md), doc);
    for (const n of Array.from(shown.childNodes)) out.add(blockWords([n]));
    for (const img of Array.from(shown.querySelectorAll("img"))) {
      out.add(blockWords([doc.createTextNode(img.alt)]));
    }
  }
  return out;
}

/**
 * The anchor keys that name something the published version has (a token, a group, a component),
 * so a key naming what only the draft has (a token added on the page) never reaches the app.
 */
function publishedKeys(ds: DesignSystem | null): Set<string> {
  const out = new Set<string>();
  if (!ds) return out;
  for (const t of ds.tokens) {
    out.add(`token:${t.path}`);
    out.add(`group:${tokenGroup(t.path)}`);
  }
  for (const c of ds.components) out.add(`component:${c.id}`);
  return out;
}

/** Wires on-page editing. Returns its message handler and how to stop it. */
function live(
  win: Window,
  root: HTMLElement,
  payload: TypedPayload,
  appOrigin: string,
  key: string | null,
  theme: () => PreviewTheme,
  published: DesignSystem | null,
  connect?: LiveDocOptions["connect"],
  /** The site was drawn again (from the draft): the navigation follows the new sections. */
  redrawn: () => void = () => undefined,
) {
  const rules = RULES as NonNullable<typeof RULES>;
  let client: LiveDocClient | null = null;
  let local: LocalSystem | null = null;
  let editor: DsEditor | null = null;
  let queued = false;
  let unavailable = false;
  /**
   * Edit mode was asked for before the room's text arrived: its size is checked when the text
   * comes (an empty draft is not a projection, so checking it then would refuse every page).
   * `focus` is the focus asked for with it.
   */
  let sizeDue: { focus: boolean } | null = null;
  /** Solo: the version shown, whose files the draft is drawn with. */
  let soloBase: number | null = null;
  let words: Set<string> | null = null;
  let keys: Set<string> | null = null;

  const poster = appPoster(win, appOrigin, key);
  const post = poster.post;
  const statusNow = () => {
    queued = false;
    const c = local ? null : client;
    const backend = local ?? client;
    const you = c?.you?.email;
    const where = new Map<string, string>();
    for (const l of c?.leases.values() ?? []) {
      const w = editor?.whereOf(l.start);
      if (w) where.set(l.by, w);
    }
    const holders = new Set([...(c?.leases.values() ?? [])].map((l) => l.by));
    const editors = (c?.editors ?? [])
      .filter((e) => e !== you)
      .slice(0, 50)
      .map((email) => ({
        email: email.slice(0, 254),
        block: holders.has(email),
        ...(where.has(email) ? { where: where.get(email) as string } : {}),
      }));
    const s: LiveFrameStatus = {
      connected: c?.connected ?? false,
      failed: client?.failed ?? false,
      editing: editor?.editing ?? false,
      holding: (editor?.editing ?? false) && backend?.mine != null,
      dirty: local ? local.dirty : (c?.dirty ?? false),
      unflushed: c ? c.unflushed || (editor?.pending ?? false) : (editor?.unsavable ?? false),
      rev: c?.rev ?? 0,
      base_version: c?.baseVersion ?? 0,
      conflict_version: c?.conflictVersion ?? null,
      last_by_you: c?.lastByYou ?? false,
      last_edit_at: c?.lastEditAt ?? null,
      editors,
      publishable: editor?.parsed != null && !(editor?.unsavable ?? false),
      ...(unavailable ? { unavailable: "too_large" as const } : {}),
      ...(editor?.unsavable ? { unsavable: true as const } : {}),
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
    // The texts' rescue stores: the app keeps a copy in its own storage (never this origin's).
    rescue: (r: RescueReport) => post({ type: "rescue", ...r }),
    leave: () => {
      if (!session.isOpen) post({ type: "leave" });
    },
    fileVersion: () => {
      if (local) return soloBase;
      return client && client.baseVersion > 0 ? client.baseVersion : null;
    },
    // A place the person wants an agent to change: the app opens its Ask dialog. The anchor is a
    // structural key, by name only when the published version has that name (else by place),
    // with words only the published version has.
    ask: (anchor: { key: string; text: string; fallback?: string }) => {
      words ??= publishedWords(win.document, published);
      keys ??= publishedKeys(published);
      const key =
        anchor.fallback === undefined || keys.has(anchor.key) ? anchor.key : anchor.fallback;
      post({
        type: "ask",
        anchor: { key, text: words.has(anchor.text) ? anchor.text : "" },
      });
    },
    theme,
    drawn: (ds: DesignSystem) => {
      applyFonts(win.document, ds, hooks.fileVersion(), "site");
      redrawn();
    },
  };
  const events = {
    granted: (l: ClientLease) => editor?.granted(l),
    changed: () => {
      editor?.changed();
      status();
    },
    structLanded: (op: LiveStructOp) => editor?.structLanded(op),
  };

  const review = new DraftReview({
    win,
    type: "design_system",
    sourcePath: payload.path,
    rules,
    pane: systemPane(win.document, theme),
    choose: (outcome, note) => session.choose(outcome, note),
  });
  const session = new ReviewSession(review, {
    post,
    rules,
    room: () => (local ? null : client),
    soloText: () => local?.text ?? null,
  });

  const goSolo = () => {
    local ??= new LocalSystem(rules.toLive(payload.text), events);
    if (editor) editor.setBackend(local);
    else editor = new DsEditor(root, win, local, hooks);
  };

  /** The draft is here: the room's text has arrived, or the frame edits on its own. */
  const draftHere = () => local !== null || (client?.ready ?? false);
  /** Too large to edit on the page: say so, and stay as it is. */
  const refuseIfTooLarge = (): boolean => {
    const text = local ? local.text : (client?.text ?? "");
    unavailable = rules.tooLarge(text) || (editor?.tooLarge ?? false);
    if (unavailable) {
      editor?.setEditing(false);
      editor?.say(
        "This design system is too large to edit on the page. Ask an agent to change it.",
      );
    }
    return unavailable;
  };
  /** The draft arrived after edit mode was asked for: check its size now. */
  const checkDueSize = () => {
    if (!sizeDue || !draftHere()) return;
    const { focus } = sizeDue;
    sizeDue = null;
    if (!refuseIfTooLarge() && focus) editor?.focusFirst();
    status();
  };

  if (payload.live === "room") {
    client = new LiveDocClient({
      win,
      ...(connect ? { connect } : {}),
      // Typed text not in the draft yet keeps a hidden tab's socket, as unflushed text does.
      keepOpen: () => editor?.pending ?? false,
      listener: {
        changed: () => {
          if (!local) editor?.changed();
          checkDueSize();
        },
        status: () => {
          if (client && !client.connected && !local) editor?.disconnected();
          if (!local) editor?.roomStatus();
          if (client?.failed && !local && editor?.editing) goSolo();
          checkDueSize();
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
          // The unpublished changes were discarded: so is everything kept to rescue.
          if (kind === "reset" && info.why === "discarded") editor?.clearRescues();
          if (!local) session.version(kind, n, info);
          status();
        },
        error: (code) => {
          if (code === "invalid" || code === "too_large") editor?.error(code);
          // A lease that went before its last frame was answered (a takeover, a `keep` after
          // it): the editor says what happened already.
          else if (code === "not_held") return;
          else editor?.say(ERRORS[code] ?? "Something went wrong with live editing.");
        },
        structDenied: (r, by) => {
          if (!local) editor?.structDenied(r, by);
        },
        structLanded: (op) => {
          if (!local) editor?.structLanded(op);
        },
      },
      applyStruct: (lines, op) => {
        const r = applyDesignSystemStruct(lines, op as DsStructOp);
        return typeof r === "string" ? null : { lines: r.lines, map: r.map };
      },
    });
    editor = new DsEditor(root, win, client, hooks);
    client.start();
  }

  const onMessage = (m: EditAppMessage) => {
    if (m.type === "edit") {
      if (m.base !== undefined) soloBase = m.base;
      if (m.on && (!client || client.failed)) goSolo();
      sizeDue = null;
      unavailable = false;
      if (!m.on) {
        editor?.setEditing(false);
      } else if (!draftHere()) {
        // The room's text is still on its way: edit mode starts (nothing is leased before the text
        // is here), and the size is checked when it comes.
        editor?.setEditing(true);
        sizeDue = { focus: m.focus === "first" };
      } else if (!refuseIfTooLarge()) {
        editor?.setEditing(true);
        if (m.focus === "first") editor?.focusFirst();
      }
      status();
    } else if (m.type === "rescue") {
      if (m.items.length > 0) editor?.offerRescue(m.items);
      if (m.stored) editor?.rescueStored(m.stored.ids, m.stored.n);
    } else if (m.type === "collect" && local) {
      editor?.flush();
      // What a version stores: the storage form, never the projection. Typing that cannot be
      // written as typed is not in the draft: the app publishes nothing, and keeps a copy with
      // it, without its formatting.
      if (editor?.unsavable) {
        const kept = editor.textWithTyping() ?? local.text;
        post({ type: "draft", nonce: m.nonce, text: rules.fromLive(kept), unsavable: true });
      } else post({ type: "draft", nonce: m.nonce, text: rules.fromLive(local.text) });
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

/** Renders the site and starts listening. Returns a function that stops it. */
/** `connect`, for tests: makes the room's socket. */
export function boot(win: Window, opts: { connect?: LiveDocOptions["connect"] } = {}): () => void {
  const doc = win.document;
  const html = doc.documentElement;
  // The frame key leaves the address before anything renders (common/frameKey.ts).
  const key = takeFrameKey(win);
  const root = doc.getElementById(ROOT_ID);
  const payload = readPayload(doc);
  if (!root || !payload) {
    root?.replaceChildren(renderProblems(doc));
    html.setAttribute("data-ready", "error");
    return () => {};
  }
  const appOrigin = payload.app_origin;
  // Previews follow the reader's color scheme, as the site's own chrome does.
  const scheme = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const theme = (): PreviewTheme => (scheme?.matches ? "dark" : "light");
  let editing: ReturnType<typeof live> | null = null;
  const parsed = parseDesignSystem(payload.text);
  const published = parsed.ok ? parsed.value : null;
  const start = () => {
    editing ??= live(win, root, payload, appOrigin, key, theme, published, opts.connect, () => {
      stopTracking();
      stopTracking = trackSection(win, root);
    });
    return editing;
  };
  if (!parsed.ok) {
    // The owner and editors (here with the room's draft) may ask an agent to fix it.
    const ask =
      payload.live === "room" && appOrigin !== ""
        ? () =>
            appPoster(win, appOrigin, key).post({
              type: "ask",
              anchor: { key: "system:problems", text: "Problems" },
            })
        : undefined;
    root.replaceChildren(renderProblems(doc, parsed.errors, ask));
    html.setAttribute("data-ready", "error");
  } else {
    // The design system's fonts, for the type specimens: Google Fonts stylesheets (validated by
    // the parser, allowed by the content CSP) and @font-face rules for its own font files.
    applyFonts(doc, parsed.value, null, "site");
    root.replaceChildren(renderSite(doc, parsed.value, theme()));
    html.setAttribute("data-ready", "ok");
    follow(doc);
  }
  let stopTracking = trackSection(win, root);
  if (payload.live === "room" && appOrigin !== "") start();

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
  // Printing and on-page editing, only from the app page that frames this one.
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
      return;
    }
    const edit = readEditMessage(e.data);
    if (edit) start().onMessage(edit);
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
    editing?.stop();
  };
}
