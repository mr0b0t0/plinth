// App side of the review-mode bridge (apps/worker/src/content/bridge.ts has the frame side).
//
// Protocol v1: every message is { source: "plinth-bridge", v: 1, type, ... }.
//   app -> frame: pick:start | pick:stop | highlight { anchors: [{ id, selector }] }
//   frame -> app: ready | pick { anchor: { selector, text, x, y } }
//                 | positions { items: [{ id, top, left, width, height, visible }] }
//
// The frame runs the artifact's own scripts next to the bridge, and they can post look-alike
// messages. So a message is accepted only from the artifact's content origin AND from this exact
// frame's window, and then every field is validated as untrusted data. Messages to the frame go to
// the content origin only, never "*". Under opaque content isolation the frame has no origin to
// check or address ("null"): there the frame's window is the check and posts use "*", which is safe
// only because no app -> frame message carries anything the framed document may not see (see
// BridgeOptions.opaque).
import { BRIDGE_MESSAGE_SOURCE } from "@plinth/shared";

export const BRIDGE_VERSION = 1;

export const BRIDGE_LIMITS = {
  maxSelector: 1000,
  maxText: 500,
  maxItems: 500,
  maxId: 64,
  /** Coordinates beyond this are nonsense for a viewport; reject them. */
  maxCoord: 1_000_000,
} as const;

export interface PickedAnchor {
  selector: string;
  text: string;
  x: number;
  y: number;
}

export interface PinPosition {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
  visible: boolean;
}

export type FrameMessage =
  | { type: "ready" }
  | { type: "pick"; anchor: PickedAnchor }
  | { type: "positions"; items: PinPosition[] };

export type AppMessage =
  | { type: "pick:start" }
  | { type: "pick:stop" }
  | { type: "highlight"; anchors: { id: string; selector: string }[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function parseAnchor(raw: unknown): PickedAnchor | null {
  if (!isObject(raw)) return null;
  const { selector, text, x, y } = raw;
  if (typeof selector !== "string" || selector.trim() === "") return null;
  if (selector.length > BRIDGE_LIMITS.maxSelector) return null;
  if (text !== undefined && typeof text !== "string") return null;
  if (typeof text === "string" && text.length > BRIDGE_LIMITS.maxText) return null;
  if (!finite(x, 0, 1) || !finite(y, 0, 1)) return null;
  return { selector, text: text ?? "", x, y };
}

function parseItem(raw: unknown): PinPosition | null {
  if (!isObject(raw)) return null;
  const { id, top, left, width, height, visible } = raw;
  if (typeof id !== "string" || id === "" || id.length > BRIDGE_LIMITS.maxId) return null;
  const m = BRIDGE_LIMITS.maxCoord;
  if (!finite(top, -m, m) || !finite(left, -m, m)) return null;
  if (!finite(width, 0, m) || !finite(height, 0, m)) return null;
  if (typeof visible !== "boolean") return null;
  return { id, top, left, width, height, visible };
}

/**
 * Validate a message from the frame. Returns null for anything that is not a well-formed bridge
 * v1 message. Never throws. Unknown extra fields are dropped.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isObject(data)) return null;
  if (data.source !== BRIDGE_MESSAGE_SOURCE || data.v !== BRIDGE_VERSION) return null;
  switch (data.type) {
    case "ready":
      return { type: "ready" };
    case "pick": {
      const anchor = parseAnchor(data.anchor);
      return anchor ? { type: "pick", anchor } : null;
    }
    case "positions": {
      if (!Array.isArray(data.items) || data.items.length > BRIDGE_LIMITS.maxItems) return null;
      const items: PinPosition[] = [];
      for (const raw of data.items) {
        const item = parseItem(raw);
        if (item) items.push(item);
      }
      return { type: "positions", items };
    }
    default:
      return null;
  }
}

/** An exact origin ("http://x.content.localhost:8787"), never "*", "null" or a URL with a path. */
export function isExactOrigin(origin: string): boolean {
  if (!origin || origin === "*" || origin === "null") return false;
  try {
    const u = new URL(origin);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === origin;
  } catch {
    return false;
  }
}

export interface BridgeHandlers {
  onMessage: (msg: FrameMessage) => void;
}

export interface BridgeClient {
  /** Post to the frame. Dropped when the frame or the origin is not usable. */
  post: (msg: AppMessage) => boolean;
  destroy: () => void;
}

export interface BridgeOptions {
  /**
   * Opaque content isolation (AppConfig.content_isolation): the frame's documents have an opaque
   * origin, so their messages arrive with origin "null" and a message to them cannot name an
   * origin. The frame is then identified by its window alone, and posts use "*". That is safe
   * because nothing the app posts is secret from the framed document: pick:start, pick:stop, and
   * comment ids with element selectors, all of which the artifact's own scripts can already see in
   * origin mode (they share the bridge's origin there).
   */
  opaque?: boolean;
  /** The app window (injectable for tests). */
  win?: Window;
}

/** Connect to the bridge inside `frame`. */
export function connectBridge(
  frame: HTMLIFrameElement,
  contentOrigin: string,
  handlers: BridgeHandlers,
  opts: BridgeOptions = {},
): BridgeClient {
  const win = opts.win ?? window;
  const opaque = opts.opaque === true;
  // Origin mode: an exact content origin or nothing. Opaque mode: the frame's window is the check.
  const usable = opaque ? contentOrigin !== "" : isExactOrigin(contentOrigin);
  const expectedOrigin = opaque ? "null" : contentOrigin;
  const targetOrigin = opaque ? "*" : contentOrigin;
  const listener = (event: MessageEvent) => {
    if (!usable) return;
    if (event.origin !== expectedOrigin) return;
    // The frame's window, checked at delivery time: it stays the same object across reloads.
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    const msg = parseFrameMessage(event.data);
    if (msg) handlers.onMessage(msg);
  };
  win.addEventListener("message", listener);
  return {
    post(msg) {
      const target = frame.contentWindow;
      if (!usable || !target) return false;
      target.postMessage(
        { ...msg, source: BRIDGE_MESSAGE_SOURCE, v: BRIDGE_VERSION },
        targetOrigin,
      );
      return true;
    },
    destroy() {
      win.removeEventListener("message", listener);
    },
  };
}
