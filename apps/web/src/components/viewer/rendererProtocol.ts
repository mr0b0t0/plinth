// The typed-renderer protocol (version 1), app side. A typed artifact (a doc) is a fixed Plinth
// renderer page on the artifact's content origin (apps/web/src/renderers/doc/boot.ts). Every
// message is { source: "plinth-renderer", v: 1, type, ... }.
//
//   app -> frame: print                    the renderer calls its own window.print()
//   app -> frame: edit { on }              on-page editing on or off (#36)
//   app -> frame: collect { nonce }        solo mode only: send me the edited text
//   frame -> app: live { ...status }       numbers, booleans and co-editor emails; never text
//   frame -> app: save                     Cmd/Ctrl+S inside the frame
//   frame -> app: draft { nonce, text }    the answer to collect, solo mode only
//
// The renderer acts on a message only when event.source is its parent and event.origin is the app
// origin. Print carries no data, so under opaque isolation and in the path fallback (frames whose
// origin is "null", which postMessage cannot name) it goes to "*". The editing messages exist only
// under origin isolation: they go to the window of the frame the app holds at the artifact's exact
// content origin, and the app accepts the frame's answers only from that window and that origin.
// Only Plinth's renderer runs on a doc origin (script-src 'self'), so a message that passes both
// checks comes from it. Draft text crosses only frame -> app, and only in solo mode.
//
// Every kind is a row in a table: APP_MESSAGE_KINDS for app -> frame, FRAME_READERS for
// frame -> app (each kind's validator). A new kind is additive and keeps version 1: a row, its
// builder or reader, and its handler in matchFrameMessage, which the compiler asks for. Bridge
// messages (highlight, pick:*) are a different protocol and never become renderer messages.
import {
  type AppConfig,
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
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

// ---------- on-page editing (#36) ----------

export interface EditMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "edit";
  on: boolean;
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
  /** Other people on the doc socket, and whether each holds a block. */
  editors: { email: string; block: boolean }[];
}

export type FrameMessage =
  | { type: "live"; status: LiveFrameStatus }
  | { type: "save" }
  | { type: "draft"; nonce: string; text: string };

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_EDITORS = 50;
const MAX_EMAIL = 254;
const MAX_INT = 2 ** 31;

export function editMessage(on: boolean): EditMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "edit", on };
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

/** Every app -> frame message kind, in the order they were added. */
// biome-ignore format: one kind per line, so each feature adds its own line
export const APP_MESSAGE_KINDS = [
  "print",
  "edit",
  "collect",
] as const;
export type AppMessageKind = (typeof APP_MESSAGE_KINDS)[number];

/** Every app -> frame message. Each kind has one interface and one builder above. */
export type AppToFrameMessage = PrintMessage | EditMessage | CollectMessage;

/** Post an editing message to the frame's window at the exact origin. False when it cannot. */
export function postToRenderer(
  frame: HTMLIFrameElement | null,
  targetOrigin: string | null,
  message: EditMessage | CollectMessage,
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
    const { email, block } = e as Record<string, unknown>;
    if (typeof email !== "string" || email.length > MAX_EMAIL || !isBool(block)) return null;
    list.push({ email, block });
  }
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
  };
}

export type FrameMessageKind = FrameMessage["type"];

interface ReadOptions {
  solo: boolean;
  nonce: string | null;
  maxDocBytes?: number;
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
 * `contentOrigin`; draft text is accepted only in solo mode, only for the nonce the app is waiting
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
  return FRAME_READERS[m.type as FrameMessageKind](m, opts);
}
