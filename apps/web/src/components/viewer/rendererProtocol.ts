// The typed-renderer protocol (version 1), app side. A typed artifact (a doc) is a fixed Plinth
// renderer page on the artifact's content origin (apps/web/src/renderers/doc/boot.ts). Every
// message is { source: "plinth-renderer", v: 1, type, ... }.
//
//   app -> frame: print                    the renderer calls its own window.print()
//   app -> frame: edit { on, base?, focus? }
//                                          on-page editing on or off (#36); `base` (solo only) is
//                                          the version shown, whose files the draft is drawn with;
//                                          `focus: "first"` (from ?edit) focuses the first block
//                                          or cell
//   app -> frame: collect { nonce }        solo mode only: send me the edited text
//   app -> frame: review { nonce, n?, base?, files?, text? }
//                                          open the whole-draft review; n, base and files (the
//                                          app's fileChanges of the two versions) in solo only;
//                                          text (solo only) is the copy this tab kept from before
//                                          a reload, reviewed instead of the frame's own
//   app -> frame: reviewed { nonce, result }
//                                          what came of the review's choice: busy, resolved,
//                                          conflict, failed or done
//   app -> frame: goto { slide }           a deck shows slide N (slidesProtocol.ts)
//   app -> frame: view { mode }            a deck switches view: deck, presenter or overview
//   app -> frame: export { format, nonce } a deck builds its .pptx and downloads it in the frame
//   app -> frame: export { format }        a sheet downloads itself as "csv" or "xlsx"
//   app -> frame: export { format }        a whiteboard downloads itself as "png" or "svg"
//   app -> frame: version { n, nonce }     a doc shows version n in place (live views), keeping the
//                                          reader's place; exact origin only
//   app -> frame: paired                   a deck is an audience window: it follows its presenter
//                                          window, never the presenter in the room
//   app -> frame: lead                     a deck's earlier frame was leading viewers: lead again
//   frame -> app: live { ...status }       numbers, booleans and co-editor emails; never text
//   frame -> app: save                     Cmd/Ctrl+S inside the frame
//   frame -> app: draft { nonce, text }    the answer to collect, solo mode only
//   frame -> app: resolved { nonce, outcome, version?, rev?, text?, note? }
//                                          the review's choice: publish, discard or cancelled;
//                                          version and rev in room mode, text in solo mode
//   frame -> app: ask { anchor }           "Ask an agent" about a place on the page (a structural
//                                          key and a short label)
//   frame -> app: leave                    Esc at the top level of edit mode: focus the strip
//   frame -> app: shown { n, nonce, ok }   the answer to version: shown in place, or not (the app
//                                          then loads a fresh frame)
//
// The renderer acts on a message only when event.source is its parent and event.origin is the app
// origin. Print carries no data, so under opaque isolation and in the path fallback (frames whose
// origin is "null", which postMessage cannot name) it goes to "*". The editing messages exist only
// under origin isolation: they go to the window of the frame the app holds at the artifact's exact
// content origin, and the app accepts the frame's answers only from that window and that origin.
// Only Plinth's renderer runs on a doc origin (script-src 'self'), so a message that passes both
// checks comes from it. Draft text crosses only in solo mode: frame -> app to publish it, and
// app -> frame only as the copy the same frame origin handed this tab before a reload, in `review`.
//
// The frame key: for an owner or editor who may edit on the page, the app opens each frame at
// enter_url + "#plinth-k=<key>" with a fresh random key (withFrameKey). The renderer takes the key
// out of its address at boot and sends it with every editing message (live, save, draft, resolved,
// ask in edit mode, leave); the app drops any that does not carry its frame's key.
//
// Every kind is a row in a table: APP_MESSAGE_KINDS for app -> frame, FRAME_READERS for
// frame -> app (each kind's validator). A new kind is additive and keeps version 1: a row, its
// builder or reader, and its handler in matchFrameMessage, which the compiler asks for. Bridge
// messages (highlight, pick:*) are a different protocol and never become renderer messages.
import {
  type AppConfig,
  type FileChangeSummary,
  LIMITS,
  PAGE_ANCHOR_KEY_RE,
  PAGE_COMMENT_LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  type SheetExportFormat,
} from "@plinth/shared";

export interface PrintMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "print";
}

export function printMessage(): PrintMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "print" };
}

/**
 * targetOrigin for messages to an artifact's renderer frame: the content origin under origin
 * isolation (null when it is unknown, so nothing is sent), "*" when the frame's origin is opaque.
 */
export function rendererTargetOrigin(
  config: Pick<AppConfig, "content_isolation" | "content_path_fallback"> | null | undefined,
  contentOrigin: string,
): string | null {
  if (config?.content_path_fallback || config?.content_isolation === "opaque") return "*";
  return /^https?:\/\/[^/]+$/.test(contentOrigin) ? contentOrigin : null;
}

/** Ask the renderer in `frame` to print. False when there is no frame window or target. */
export function postPrint(frame: HTMLIFrameElement | null, targetOrigin: string | null): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin) return false;
  win.postMessage(printMessage(), targetOrigin);
  return true;
}

// ---------- decks (the slides type) ----------

/** A deck's views, as the app asks for them. */
export type DeckView = "deck" | "presenter" | "overview";

export interface GotoMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "goto";
  slide: number;
}

export interface ViewMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "view";
  mode: DeckView;
}

export function gotoMessage(slide: number): GotoMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "goto", slide };
}

export function viewMessage(mode: DeckView): ViewMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "view", mode };
}

export interface DeckExportMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "export";
  format: "pptx";
  /** The app's own random nonce, echoed in the frame's `exported` answer. */
  nonce: string;
}

export function exportMessage(nonce: string): DeckExportMessage {
  return {
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "export",
    format: "pptx",
    nonce,
  };
}

/**
 * A deck's frame is an audience window, kept in step by its presenter window (`goto` over the
 * pair's BroadcastChannel): it stops following the presenter over the room and shows no note or
 * Lead viewers toggle. It carries no data.
 */
export interface PairedMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "paired";
}

export function pairedMessage(): PairedMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "paired" };
}

/**
 * The deck's frame this one replaced (a newer version, a sharing change) was leading viewers over
 * the room, and the person never stopped: lead again. It carries no data; the room still allows
 * only owners and editors to lead.
 */
export interface LeadMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "lead";
}

export function leadMessage(): LeadMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "lead" };
}

/**
 * Post a deck message (a slide number, a view name, or an export request with the app's own
 * nonce: nothing the frame does not already have) to the frame at `targetOrigin`, "*" included for
 * opaque frames. False when it cannot.
 */
export function postToDeck(
  frame: HTMLIFrameElement | null,
  targetOrigin: string | null,
  message: GotoMessage | ViewMessage | DeckExportMessage | PairedMessage | LeadMessage,
): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin) return false;
  win.postMessage(message, targetOrigin);
  return true;
}

// ---------- sheets (the sheet type) ----------

/** A sheet's export: the frame builds the file and downloads it, and answers nothing. */
export interface SheetExportMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "export";
  format: SheetExportFormat;
}

export function sheetExportMessage(format: SheetExportFormat): SheetExportMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "export", format };
}

/**
 * The export kind: a deck's .pptx (with the app's nonce), a sheet's .csv or .xlsx, or a
 * whiteboard's .png or .svg.
 */
export type ExportMessage = DeckExportMessage | SheetExportMessage | BoardExportMessage;

/**
 * Ask a sheet's frame to download itself. The message names only a format and carries no data,
 * so it may go to "*" for opaque frames, like print. False when it cannot be sent.
 */
export function postExport(
  frame: HTMLIFrameElement | null,
  targetOrigin: string | null,
  format: SheetExportFormat,
): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin) return false;
  win.postMessage(sheetExportMessage(format), targetOrigin);
  return true;
}

// ---------- whiteboards (the whiteboard type) ----------

export type BoardExportFormat = "png" | "svg";

/** A whiteboard's export: the frame draws the whole board and downloads it, and answers nothing. */
export interface BoardExportMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "export";
  format: BoardExportFormat;
}

export function boardExportMessage(format: BoardExportFormat): BoardExportMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "export", format };
}

/**
 * Ask a whiteboard's frame to download itself as a PNG or an SVG. Like a sheet's export, the
 * message names only a format and carries no data. False when it cannot be sent.
 */
export function postBoardExport(
  frame: HTMLIFrameElement | null,
  targetOrigin: string | null,
  format: BoardExportFormat,
): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin) return false;
  win.postMessage(boardExportMessage(format), targetOrigin);
  return true;
}

// ---------- on-page editing (#36) ----------

export interface EditMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "edit";
  on: boolean;
  /** Solo only: the version the frame shows, whose files the draft is drawn with. */
  base?: number;
  /**
   * Turning editing on from `?edit` (New and Import): put the focus on the first block or cell, a
   * doc's first block opened for typing. Absent: focus stays where it is.
   */
  focus?: "first";
}

/** Open the whole-draft review in the frame. */
export interface ReviewMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "review";
  nonce: string;
  /** Solo only: the version published meanwhile (from the 409), and the draft's base. */
  n?: number;
  base?: number;
  /** Solo only: what n changed in the files since base (the app's fileChanges of the two). */
  files?: FileChangeSummary;
  /**
   * Solo only: the copy this tab kept from before a reload (the frame's own draft then, from
   * sessionStorage), which the frame reviews instead of a copy of its own.
   */
  text?: string;
}

/** What came of the review's choice, for the frame: its buttons and whether it closes. */
export type ReviewResult = "busy" | "resolved" | "conflict" | "failed" | "done";

export interface ReviewedMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "reviewed";
  nonce: string;
  result: ReviewResult;
}

export interface CollectMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "collect";
  nonce: string;
}

/** What the frame reports about the live draft. Never any of its text. */
export interface LiveFrameStatus {
  /** The doc socket is open and the draft has arrived (room mode). */
  connected: boolean;
  /** The doc socket never opened: the app edits alone (solo). */
  failed: boolean;
  editing: boolean;
  /** This frame holds a block. */
  holding: boolean;
  /** The draft differs from its base version. */
  dirty: boolean;
  /** This frame sent text the room has not written to D1 yet. */
  unflushed: boolean;
  rev: number;
  /** The version the draft is based on (0 in solo mode: the app knows it). */
  base_version: number;
  conflict_version: number | null;
  last_by_you: boolean;
  last_edit_at: string | null;
  /**
   * Other people on the doc socket, whether each holds a block, and where (a structural place the
   * renderer names, "row 12", never content).
   */
  editors: { email: string; block: boolean; where?: string }[];
  /** False when the draft cannot be a version yet (LiveTypeRules.unpublishable). */
  publishable: boolean;
  /** The frame cannot edit this artifact on its page (it is too large to). */
  unavailable?: "too_large";
}

/** The review's choice, as the frame sends it. */
export type ReviewChoice =
  | { outcome: "publish"; version?: number; rev?: number; text?: string; note?: string }
  | { outcome: "discard"; version?: number; rev?: number }
  | { outcome: "cancelled" };

export type FrameMessage =
  | { type: "live"; status: LiveFrameStatus }
  | { type: "save" }
  | { type: "draft"; nonce: string; text: string }
  | ({ type: "resolved"; nonce: string } & ReviewChoice)
  | { type: "ask"; anchor: { key: string; text: string } | null }
  | { type: "leave" }
  | { type: "shown"; n: number; nonce: string; ok: boolean };

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_EDITORS = 50;
const MAX_EMAIL = 254;
const MAX_INT = 2 ** 31;

export function editMessage(on: boolean, base?: number, focus?: "first"): EditMessage {
  return {
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "edit",
    on,
    ...(base !== undefined ? { base } : {}),
    ...(on && focus ? { focus } : {}),
  };
}

export function reviewMessage(
  nonce: string,
  solo?: { n: number; base: number; files: FileChangeSummary; text?: string },
): ReviewMessage {
  return {
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "review",
    nonce,
    ...(solo ?? {}),
  };
}

export function reviewedMessage(nonce: string, result: ReviewResult): ReviewedMessage {
  return {
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "reviewed",
    nonce,
    result,
  };
}

/** 32 random bytes as base64url: the key of one frame load. */
export function newFrameKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const FRAME_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** The frame's address with its key in the fragment (any fragment it had goes after `&h=`). */
export function withFrameKey(url: string, key: string): string {
  const at = url.indexOf("#");
  if (at < 0) return `${url}#plinth-k=${key}`;
  return `${url.slice(0, at)}#plinth-k=${key}&h=${url.slice(at + 1)}`;
}

export function collectMessage(nonce: string): CollectMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "collect", nonce };
}

/** A random nonce for one collect request. */
export function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * The exact content origin the editing messages may use, or null when there is none: never "*"
 * (opaque isolation and the path fallback have no on-page editing).
 */
export function editTargetOrigin(
  config: Pick<AppConfig, "content_isolation" | "content_path_fallback"> | null | undefined,
  contentOrigin: string,
): string | null {
  const t = rendererTargetOrigin(config, contentOrigin);
  return t === "*" ? null : t;
}

// ---------- live views: a doc shows a newer version in place ----------

export interface VersionMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "version";
  /** The version to show: the renderer fetches its source from /__plinth/v/<n>/. */
  n: number;
  /** The app's own random nonce, echoed in the frame's `shown` answer. */
  nonce: string;
}

export function versionMessage(n: number, nonce: string): VersionMessage {
  return {
    source: RENDERER_MESSAGE_SOURCE,
    v: RENDERER_PROTOCOL_VERSION,
    type: "version",
    n,
    nonce,
  };
}

/** Every app -> frame message kind, in the order they were added. */
// biome-ignore format: one kind per line, so each feature adds its own line
export const APP_MESSAGE_KINDS = [
  "print",
  "edit",
  "collect",
  "goto",
  "view",
  "export",
  "version",
  "paired",
  "lead",
  "review",
  "reviewed",
] as const;
export type AppMessageKind = (typeof APP_MESSAGE_KINDS)[number];

/** Every app -> frame message. Each kind has one interface and one builder above. */
export type AppToFrameMessage =
  | PrintMessage
  | EditMessage
  | CollectMessage
  | GotoMessage
  | ViewMessage
  | ExportMessage
  | VersionMessage
  | PairedMessage
  | LeadMessage
  | ReviewMessage
  | ReviewedMessage;

/**
 * Post an editing or version message to the frame's window at the exact origin, never "*". False
 * when it cannot.
 */
export function postToRenderer(
  frame: HTMLIFrameElement | null,
  targetOrigin: string | null,
  message: EditMessage | CollectMessage | VersionMessage | ReviewMessage | ReviewedMessage,
): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin || targetOrigin === "*") return false;
  win.postMessage(message, targetOrigin);
  return true;
}

const isInt = (v: unknown, min = 0): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v < MAX_INT;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function readStatus(m: Record<string, unknown>): LiveFrameStatus | null {
  const { connected, failed, editing, holding, dirty, unflushed, rev, base_version } = m;
  const { conflict_version, last_by_you, last_edit_at, editors } = m;
  if (![connected, failed, editing, holding, dirty, unflushed, last_by_you].every(isBool)) {
    return null;
  }
  if (!isInt(rev) || !isInt(base_version)) return null;
  if (conflict_version !== null && !isInt(conflict_version, 1)) return null;
  if (last_edit_at !== null && (typeof last_edit_at !== "string" || last_edit_at.length > 40)) {
    return null;
  }
  if (!Array.isArray(editors) || editors.length > MAX_EDITORS) return null;
  const list: LiveFrameStatus["editors"] = [];
  for (const e of editors) {
    if (typeof e !== "object" || e === null) return null;
    const { email, block, where } = e as Record<string, unknown>;
    if (typeof email !== "string" || email.length > MAX_EMAIL || !isBool(block)) return null;
    if (where !== undefined && (typeof where !== "string" || where.length > MAX_WHERE)) return null;
    list.push({ email, block, ...(typeof where === "string" ? { where } : {}) });
  }
  const publishable = m.publishable === undefined ? true : m.publishable;
  if (!isBool(publishable)) return null;
  if (m.unavailable !== undefined && m.unavailable !== "too_large") return null;
  return {
    connected: connected as boolean,
    failed: failed as boolean,
    editing: editing as boolean,
    holding: holding as boolean,
    dirty: dirty as boolean,
    unflushed: unflushed as boolean,
    rev,
    base_version,
    conflict_version: conflict_version as number | null,
    last_by_you: last_by_you as boolean,
    last_edit_at: last_edit_at as string | null,
    editors: list,
    publishable,
    ...(m.unavailable === "too_large" ? { unavailable: "too_large" as const } : {}),
  };
}

export type FrameMessageKind = FrameMessage["type"];

interface ReadOptions {
  solo: boolean;
  nonce: string | null;
  maxDocBytes?: number;
  /** The nonce of the `version` message the app is waiting on; `shown` is read only for it. */
  shown?: string | null;
  /** The key of the frame the app holds; editing messages without it are dropped. */
  key?: string | null;
  /** The nonce of the `review` message the app is waiting on; `resolved` is read only for it. */
  review?: string | null;
  /** The app is in edit mode: `ask` is then an editing message and must carry the frame key. */
  editing?: boolean;
}

/** The kinds that carry the frame key. `shown` (live views) and `ask` outside edit mode do not. */
const KEYED: ReadonlySet<FrameMessageKind> = new Set([
  "live",
  "save",
  "draft",
  "resolved",
  "leave",
]);
const MAX_WHERE = 80;
/** Whether `s` holds a control character (U+0000 to U+001F, or U+007F). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Each frame -> app kind's validator: the message, or null when any field is wrong. */
const FRAME_READERS: {
  readonly [K in FrameMessageKind]: (
    m: Record<string, unknown>,
    opts: ReadOptions,
  ) => Extract<FrameMessage, { type: K }> | null;
} = {
  live(m) {
    const status = readStatus(m);
    return status ? { type: "live", status } : null;
  },
  save: () => ({ type: "save" }),
  draft(m, opts) {
    if (!opts.solo || !opts.nonce || m.nonce !== opts.nonce || typeof m.text !== "string") {
      return null;
    }
    const max = opts.maxDocBytes ?? LIMITS.maxDocBytes;
    if (m.text.length > max || new TextEncoder().encode(m.text).byteLength > max) return null;
    return { type: "draft", nonce: m.nonce, text: m.text };
  },
  resolved(m, opts) {
    if (!opts.review || m.nonce !== opts.review) return null;
    const nonce = m.nonce;
    if (m.outcome === "cancelled") return { type: "resolved", nonce, outcome: "cancelled" };
    if (m.outcome !== "publish" && m.outcome !== "discard") return null;
    // Room mode names the frozen version and the draft revision the person reviewed.
    const room = m.version !== undefined || m.rev !== undefined;
    if (room && (!isInt(m.version, 1) || !isInt(m.rev))) return null;
    if (room && opts.solo) return null;
    if (m.outcome === "discard") {
      if (m.text !== undefined || m.note !== undefined) return null;
      return room
        ? {
            type: "resolved",
            nonce,
            outcome: "discard",
            version: m.version as number,
            rev: m.rev as number,
          }
        : { type: "resolved", nonce, outcome: "discard" };
    }
    let note: string | undefined;
    if (m.note !== undefined) {
      if (typeof m.note !== "string" || m.note.length > LIMITS.maxNoteLength) return null;
      note = m.note;
    }
    if (room) {
      if (m.text !== undefined) return null;
      return {
        type: "resolved",
        nonce,
        outcome: "publish",
        version: m.version as number,
        rev: m.rev as number,
        ...(note !== undefined ? { note } : {}),
      };
    }
    // Solo: the frame's own draft, published as it is with its base's files.
    if (!opts.solo || typeof m.text !== "string") return null;
    const max = opts.maxDocBytes ?? LIMITS.maxDocBytes;
    if (m.text.length > max || new TextEncoder().encode(m.text).byteLength > max) return null;
    return {
      type: "resolved",
      nonce,
      outcome: "publish",
      text: m.text,
      ...(note !== undefined ? { note } : {}),
    };
  },
  ask(m) {
    if (m.anchor === undefined) return { type: "ask", anchor: null };
    const a = m.anchor as Record<string, unknown> | null;
    if (typeof a !== "object" || a === null) return null;
    const { key, text } = a;
    if (typeof key !== "string" || !PAGE_ANCHOR_KEY_RE.test(key)) return null;
    if (typeof text !== "string" || text.length > PAGE_COMMENT_LIMITS.maxText || hasControl(text)) {
      return null;
    }
    return { type: "ask", anchor: { key, text } };
  },
  leave: () => ({ type: "leave" }),
  shown(m, opts) {
    if (!opts.shown || m.nonce !== opts.shown || !isInt(m.n, 1) || !isBool(m.ok)) return null;
    return { type: "shown", n: m.n, nonce: m.nonce, ok: m.ok };
  },
};

/** Every frame -> app message kind, in table order. */
export const FRAME_MESSAGE_KINDS = Object.keys(FRAME_READERS) as readonly FrameMessageKind[];

/** One handler per frame -> app kind: a kind without a handler is a type error. */
export type FrameMessageHandlers<R> = {
  readonly [K in FrameMessageKind]: (m: Extract<FrameMessage, { type: K }>) => R;
};

/** Run the handler for a validated frame message's kind. */
export function matchFrameMessage<R>(m: FrameMessage, handlers: FrameMessageHandlers<R>): R {
  return (handlers[m.type] as (m: FrameMessage) => R)(m);
}

/**
 * A message from the doc frame, validated, or null. It must come from `frame`'s window at exactly
 * `contentOrigin`; an editing message must carry the frame's key (`key`, when the app gave the
 * frame one), and while `editing` so must `ask`; draft text is accepted only in solo mode, only for the nonce the app is waiting
 * for, and only up to the instance's doc size.
 */
export function readFrameMessage(
  e: Pick<MessageEvent, "source" | "origin" | "data">,
  opts: {
    frame: HTMLIFrameElement | null;
    contentOrigin: string | null;
    solo: boolean;
    nonce: string | null;
    maxDocBytes?: number;
    shown?: string | null;
    key?: string | null;
    review?: string | null;
    editing?: boolean;
  },
): FrameMessage | null {
  const win = opts.frame?.contentWindow;
  if (!win || e.source !== win) return null;
  if (!opts.contentOrigin || opts.contentOrigin === "*" || e.origin !== opts.contentOrigin) {
    return null;
  }
  const m = e.data as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return null;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (typeof m.type !== "string" || !Object.hasOwn(FRAME_READERS, m.type)) return null;
  const kind = m.type as FrameMessageKind;
  // An editing message comes only from the document that holds this frame's key. `ask` is one in
  // edit mode, so a keyless `ask` is dropped then; outside it, the message only opens a composer
  // the person must confirm, and carries the key only if it has one.
  const keyed =
    KEYED.has(kind) || (kind === "ask" && (opts.editing === true || m.key !== undefined));
  if (keyed && opts.key !== undefined && (opts.key === null || m.key !== opts.key)) return null;
  return FRAME_READERS[kind](m, opts);
}
