// Notices a newer version of the artifact on view (an agent or editor published one) and hands it
// to the page. It reads the same gate the page loaded, every VERSION_POLL_MS while the tab is
// visible and once when the tab comes back. Gates are cheap: an unused enter URL is just a signed
// token that expires.
import type { ViewGate } from "@plinth/shared";
import { useEffect, useRef } from "react";
import { api } from "../../lib/api.ts";

/** Same pace as the comments panel. */
export const VERSION_POLL_MS = 15_000;

type OkGate = Extract<ViewGate, { status: "ok" }>;

/**
 * What to show when the server reports `fresh` while `shown` is on screen, or null to keep it.
 * Following the current version, the fresh gate replaces the shown one (a new frame loads). On a
 * permanent version link the frame stays; only the count of versions moves on, so the bar can
 * say a newer one exists.
 */
export function nextGate(shown: OkGate, fresh: ViewGate, pinned: boolean): OkGate | null {
  if (fresh.status !== "ok") return null;
  if (fresh.artifact.current_version <= shown.artifact.current_version) return null;
  if (!pinned) return fresh;
  return {
    ...shown,
    artifact: { ...shown.artifact, current_version: fresh.artifact.current_version },
  };
}

/**
 * Polls `path` (the page's own gate path) while `gate` is on view and calls `onNewer` with the gate
 * to show when a newer version appears. Failures and gates that are no longer "ok" are ignored:
 * the page keeps what it has until the next navigation.
 */
export function useVersionWatch(
  path: string,
  gate: OkGate | null,
  pinned: boolean,
  onNewer: (gate: OkGate) => void,
  intervalMs: number = VERSION_POLL_MS,
): void {
  const latest = useRef({ gate, onNewer });
  latest.current = { gate, onNewer };
  const watching = gate !== null;

  useEffect(() => {
    if (!watching) return;
    let ctrl: AbortController | null = null;
    const check = async () => {
      if (document.visibilityState !== "visible" || ctrl) return;
      ctrl = new AbortController();
      try {
        const fresh = await api<ViewGate>(path, { signal: ctrl.signal });
        const shown = latest.current.gate;
        const next = shown ? nextGate(shown, fresh, pinned) : null;
        if (next) latest.current.onNewer(next);
      } catch {
        // Offline or a hiccup: try again on the next tick.
      } finally {
        ctrl = null;
      }
    };
    const id = window.setInterval(check, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      ctrl?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, pinned, watching, intervalMs]);
}
