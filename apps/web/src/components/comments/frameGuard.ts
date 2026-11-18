// "This message came from my frame": the one check every app-side channel to an artifact frame
// uses (the comments bridge today; page comments, dictation and live viewers next).
//
// The frame runs the artifact's own scripts, and other windows can post look-alike messages. So a
// message counts only when it comes from the artifact's content origin AND from this exact frame's
// window, checked at delivery time (the window stays the same object across reloads). Under opaque
// content isolation the frame's documents have no origin ("null"): there the window is the check,
// and posts to the frame use "*", which is safe only for messages that carry nothing the framed
// document may not see. Under origin isolation posts go to the exact content origin, never "*".
// Every field of an accepted message is still untrusted data for the channel to validate.

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

/** Whether a channel to the frame can work: an exact origin, or any known origin when opaque. */
function usable(contentOrigin: string, opaque: boolean): boolean {
  return opaque ? contentOrigin !== "" : isExactOrigin(contentOrigin);
}

/**
 * A check for messages from `frame`: the event's origin is the content origin ("null" when
 * opaque) and its source is the frame's current window. Always false when the origin is unusable.
 */
export function acceptFrom(
  frame: HTMLIFrameElement,
  contentOrigin: string,
  opaque: boolean,
): (event: Pick<MessageEvent, "origin" | "source">) => boolean {
  const ok = usable(contentOrigin, opaque);
  const expectedOrigin = opaque ? "null" : contentOrigin;
  return (event) => {
    if (!ok) return false;
    if (event.origin !== expectedOrigin) return false;
    return !!frame.contentWindow && event.source === frame.contentWindow;
  };
}

/**
 * The targetOrigin for posts to the frame: the exact content origin, "*" when opaque, or null when
 * nothing may be sent.
 */
export function targetOriginFor(contentOrigin: string, opaque: boolean): string | null {
  if (!usable(contentOrigin, opaque)) return null;
  return opaque ? "*" : contentOrigin;
}
