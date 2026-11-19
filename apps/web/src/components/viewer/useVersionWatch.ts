// Notices a newer version of the artifact on view (an agent or editor published one) and hands it
// to the page. It reads the same gate the page loaded, every VERSION_POLL_MS while the tab is
// visible, once when the tab comes back, and at once when the live-view socket says a version was
// published (checkNow; useLiveView.ts). While that socket is open the poll is only a backstop,
// every LIVE_VIEW_LIMITS.gateBackstopMs. Gates are cheap: an unused enter URL is just a signed
// token that expires.
import { LIVE_VIEW_LIMITS, type ViewGate } from "@plinth/shared";
import { useEffect, useMemo, useRef } from "react";
import { api } from "../../lib/api.ts";
import type { LiveViewStatus } from "./useLiveView.ts";

/** Same pace as the comments panel. */
export const VERSION_POLL_MS = 15_000;

/** How often to poll the gate: the usual pace, or only as a backstop while signals are pushed. */
export function versionPollMs(live: LiveViewStatus): number {
  return live === "open" ? LIVE_VIEW_LIMITS.gateBackstopMs : VERSION_POLL_MS;
}

type OkGate = Extract<ViewGate, { status: "ok" }>;

/**
 * While a doc is edited on its page the frame must not be swapped (#36):
 * - "follow": the frame follows new versions itself over the doc socket (room mode), so the bar
 *   takes the new version number and the frame stays;
 * - "hold": the frame holds unsaved solo edits, so only the count of versions moves on and the
 *   page can say that a newer one was published meanwhile.
 * While a deck is presented (full screen or presenter view) the frame is not swapped either:
 * - "present": as "hold", only the count of versions moves on; the deck shows the newer version
 *   once presenting ends, or when the presenter asks for it.
 */
export type WatchPause = "follow" | "hold" | "present" | null;

/**
 * What to show when the server reports `fresh` while `shown` is on screen, or null to keep it.
 * Following the current version, the fresh gate replaces the shown one (a new frame loads). On a
 * permanent version link the frame stays; only the count of versions moves on, so the bar can
 * say a newer one exists.
 */
export function nextGate(
  shown: OkGate,
  fresh: ViewGate,
  pinned: boolean,
  paused: WatchPause = null,
): OkGate | null {
  if (fresh.status !== "ok") return null;
  if (fresh.artifact.current_version <= shown.artifact.current_version) return null;
  if (paused === "follow" && !pinned) {
    const n = fresh.artifact.current_version;
    return { ...shown, artifact: { ...shown.artifact, version: n, current_version: n } };
  }
  if (!pinned && !paused) return fresh;
  return {
    ...shown,
    artifact: { ...shown.artifact, current_version: fresh.artifact.current_version },
  };
}

/**
 * Polls `path` (the page's own gate path) while `gate` is on view and calls `onNewer` with the gate
 * to show when a newer version appears; `paused` keeps the frame (see WatchPause). Failures and
 * gates that are no longer "ok" are ignored: the page keeps what it has until the next navigation.
 * `checkNow` reads the gate at once; a check already running is followed by one more.
 */
export function useVersionWatch(
  path: string,
  gate: OkGate | null,
  pinned: boolean,
  onNewer: (gate: OkGate) => void,
  intervalMs: number = VERSION_POLL_MS,
  paused: WatchPause = null,
): { checkNow: () => void } {
  const latest = useRef({ gate, onNewer, paused });
  latest.current = { gate, onNewer, paused };
  const watching = gate !== null;
  const checkRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!watching) return;
    let ctrl: AbortController | null = null;
    let again = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      if (ctrl) {
        again = true;
        return;
      }
      ctrl = new AbortController();
      try {
        const fresh = await api<ViewGate>(path, { signal: ctrl.signal });
        const shown = latest.current.gate;
        const next = shown ? nextGate(shown, fresh, pinned, latest.current.paused) : null;
        if (next) latest.current.onNewer(next);
      } catch {
        // Offline or a hiccup: try again on the next tick.
      } finally {
        ctrl = null;
        if (again) {
          again = false;
          void check();
        }
      }
    };
    checkRef.current = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      checkRef.current = () => undefined;
      again = false;
      ctrl?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, pinned, watching]);

  // The pace on its own, so a change of pace (the live-view socket opening) never cancels a
  // check that is under way, such as the one its welcome asked for.
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => checkRef.current(), intervalMs);
    return () => window.clearInterval(id);
  }, [watching, intervalMs]);

  return useMemo(() => ({ checkNow: () => checkRef.current() }), []);
}
