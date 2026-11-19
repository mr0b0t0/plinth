// Comments from the page (docs/spec.md "Comments from the page"): a page that declares `comments`
// may open the app's comment composer with an anchor of its own (a point on a canvas, a slide, a
// node in a diagram). The page never posts a comment and never fills in its text: the person
// writes and posts it. The app and the frame talk over postMessage with this protocol; the frame
// side is the runtime's comments fragment (apps/worker/src/content/runtime/comments.ts), the app
// side apps/web/src/components/comments/pageChannel.ts.
//
// Protocol v1: every message is { source: "plinth-comments", v: 1, type, ... }.
//   frame -> app: hello | compose { req, anchor? } | open { id }
//                 | positions { items: [{ id, left, top, width, height, visible }] }
//   app -> frame: welcome { available } | threads { items: [{ id, pin, status, anchor }] }
//                 | composed { req, status, id? } | focus { id }
// App -> frame messages never carry comment text, authors, emails, roles or mention state: under
// opaque isolation they are posted with "*".

export const PAGE_COMMENTS_SOURCE = "plinth-comments";
export const PAGE_COMMENTS_VERSION = 1;

/** Fixed caps of the protocol and of page anchors. */
export const PAGE_COMMENT_LIMITS = {
  /** Characters in an anchor's key. */
  maxKey: 128,
  /** Characters in an anchor's label (the composer chip). */
  maxText: 120,
  /** UTF-8 bytes of an anchor's `data` as JSON. */
  maxDataBytes: 1024,
  /** Keys in an anchor's `data`. */
  maxDataKeys: 16,
  /** Characters in a string value of an anchor's `data`. */
  maxDataString: 200,
  /** Magnitude of an anchor's page coordinates. */
  maxPageCoord: 1e9,
  /** Threads the app tells the page about, and positions it accepts back. */
  maxThreads: 500,
  /** Characters in a comment id. */
  maxId: 64,
  /** Viewport coordinates beyond this are nonsense; reject them. */
  maxCoord: 1_000_000,
  /** At most one compose a second is accepted. */
  composeMinIntervalMs: 1000,
  /** At most four `open` messages a second are accepted. */
  openMinIntervalMs: 250,
  /** At most one page request a second (compose or open) may open a panel that is closed. */
  reopenMinIntervalMs: 1000,
  /** Position reports accepted (and sent) per second. */
  positionsPerSecond: 20,
  /** How long `ready` waits for the app's answer. */
  readyTimeoutMs: 3000,
} as const;

/** What a page anchor's key may be: what the page anchors to, in its own terms. */
export const PAGE_ANCHOR_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
/** Keys of a page anchor's `data`. */
export const PAGE_ANCHOR_DATA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** A compose request id: random, URL-safe. */
export const PAGE_REQ_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** UTF-8 bytes of a string (no TextEncoder: this package targets plain ES2023). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}
