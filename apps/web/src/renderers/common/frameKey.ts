// The frame key (docs/security.md "Inline editing"): for an owner or editor who may edit on the
// page, the app opens the frame at `enter_url#plinth-k=<key>` with a fresh random key per frame
// load. The fragment is never sent to a server, survives the enter redirect (a Location without a
// fragment keeps it) and appears in no Referer. The renderer reads it once at boot, puts back any
// original fragment (`&h=`) and removes the key from the address before it renders, then sends
// the key with every editing message, so the app drops any editing message from a document that
// does not hold its frame's key (one the frame navigated to has none). Defence in depth: only
// Plinth's renderer runs on a typed origin.

export const FRAME_KEY_HASH_RE = /^#plinth-k=([A-Za-z0-9_-]{43})(?:&h=(.*))?$/;

/**
 * The key in the frame's address, or null. When there is one, the address loses it (any original
 * fragment comes back), so nothing on the page can read it from `location` afterwards.
 */
export function takeFrameKey(win: Pick<Window, "location" | "history">): string | null {
  const hash = win.location?.hash;
  const m = typeof hash === "string" ? FRAME_KEY_HASH_RE.exec(hash) : null;
  if (!m) return null;
  const rest = m[2] ?? "";
  const { pathname, search } = win.location;
  try {
    win.history.replaceState(
      win.history.state,
      "",
      `${pathname}${search}${rest ? `#${rest}` : ""}`,
    );
  } catch {
    // An address that cannot be replaced keeps the key; the app still checks it.
  }
  return m[1] as string;
}
