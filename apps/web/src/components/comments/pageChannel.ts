// App side of comments from the page (the frame side is the runtime's comments fragment,
// apps/worker/src/content/runtime/comments.ts; protocol v1 in packages/shared/src/pageComments.ts).
//
//   frame -> app: hello | compose { req, anchor? } | open { id }
//                 | positions { items: [{ id, left, top, width, height, visible }] }
//   app -> frame: welcome { available } | threads { items: [{ id, pin, status, anchor }] }
//                 | composed { req, status, id? } | focus { id }
//
// The page's own scripts write every frame -> app message, so a message counts only when it comes
// from the artifact's content origin and this exact frame's window (frameGuard.ts), and every
// field is then validated as untrusted data. Posts to the frame go to the content origin, or "*"
// under opaque isolation, and so carry only what the framed document may see anyway: thread ids,
// pin numbers, status, anchors (the page's own data, or selectors) and request ids. Never comment
// text, authors, emails, roles or mention state (pageThreadItems in model.ts builds the list).
import {
  PAGE_COMMENT_LIMITS,
  PAGE_COMMENTS_SOURCE,
  PAGE_COMMENTS_VERSION,
  PAGE_REQ_RE,
  type PageAnchor,
  pageAnchorSchema,
} from "@plinth/shared";
import { type PinPosition, parseItem } from "./bridge.ts";
import { acceptFrom, targetOriginFor } from "./frameGuard.ts";

/** A thread as the page is told about it. */
export interface PageThreadItem {
  id: string;
  pin: number;
  status: "open" | "resolved";
  anchor:
    | { kind: "page"; key: string; x?: number; y?: number; data?: PageAnchor["data"] }
    | { kind: "element"; selector: string };
}

export type PageFrameMessage =
  | { type: "hello" }
  | { type: "compose"; req: string; anchor: PageAnchor | null }
  | { type: "open"; id: string }
  | { type: "positions"; items: PinPosition[] };

export type PageAppMessage =
  | { type: "welcome"; available: boolean }
  | { type: "threads"; items: PageThreadItem[] }
  | { type: "composed"; req: string; status: "posted" | "closed" | "busy"; id?: string }
  | { type: "focus"; id: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A page anchor as the page passed it (without `kind`), checked by the shared schema. Null for
 * anything else, including a `kind` of its own. Never throws.
 */
export function parsePageAnchor(raw: unknown): PageAnchor | null {
  if (!isObject(raw) || "kind" in raw) return null;
  try {
    const parsed = pageAnchorSchema.safeParse({ kind: "page", ...raw });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const isId = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && v.length <= PAGE_COMMENT_LIMITS.maxId;

/**
 * Validate a message from the frame. Returns null for anything that is not a well-formed v1
 * message: a wrong source or version, a bad request id, an invalid anchor (the whole compose is
 * dropped), more positions than threads. Unknown extra fields are dropped. Never throws.
 */
export function parsePageMessage(data: unknown): PageFrameMessage | null {
  try {
    if (!isObject(data)) return null;
    if (data.source !== PAGE_COMMENTS_SOURCE || data.v !== PAGE_COMMENTS_VERSION) return null;
    switch (data.type) {
      case "hello":
        return { type: "hello" };
      case "compose": {
        if (typeof data.req !== "string" || !PAGE_REQ_RE.test(data.req)) return null;
        if (data.anchor === undefined) return { type: "compose", req: data.req, anchor: null };
        const anchor = parsePageAnchor(data.anchor);
        return anchor ? { type: "compose", req: data.req, anchor } : null;
      }
      case "open":
        return isId(data.id) ? { type: "open", id: data.id } : null;
      case "positions": {
        const raw = data.items;
        if (!Array.isArray(raw) || raw.length > PAGE_COMMENT_LIMITS.maxThreads) return null;
        const items: PinPosition[] = [];
        for (const r of raw) {
          const item = parseItem(r);
          if (item) items.push(item);
        }
        return { type: "positions", items };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface PageChannel {
  /** Post to the frame. Dropped when the frame or the origin is not usable. */
  post: (msg: PageAppMessage) => boolean;
  destroy: () => void;
}

export interface PageChannelOptions {
  /** Opaque content isolation: the frame is identified by its window and posts use "*". */
  opaque?: boolean;
  /** The app window (injectable for tests). */
  win?: Window;
}

/** Connect to the page inside `frame`. */
export function connectPageChannel(
  frame: HTMLIFrameElement,
  contentOrigin: string,
  onMessage: (msg: PageFrameMessage) => void,
  opts: PageChannelOptions = {},
): PageChannel {
  const win = opts.win ?? window;
  const opaque = opts.opaque === true;
  const fromFrame = acceptFrom(frame, contentOrigin, opaque);
  const targetOrigin = targetOriginFor(contentOrigin, opaque);
  const listener = (event: MessageEvent) => {
    if (!fromFrame(event)) return;
    const msg = parsePageMessage(event.data);
    if (msg) onMessage(msg);
  };
  win.addEventListener("message", listener);
  return {
    post(msg) {
      const target = frame.contentWindow;
      if (targetOrigin === null || !target) return false;
      target.postMessage(
        { ...msg, source: PAGE_COMMENTS_SOURCE, v: PAGE_COMMENTS_VERSION },
        targetOrigin,
      );
      return true;
    },
    destroy() {
      win.removeEventListener("message", listener);
    },
  };
}
