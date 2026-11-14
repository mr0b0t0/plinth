// Live detection for the Connect panel: while it is open (and the tab is visible), fetch the
// connections list every few seconds so a newly approved agent shows up without a reload.
import { API, type ConnectionInfo, type Paged } from "@plinth/shared";
import { useEffect, useRef } from "react";
import { api } from "../../lib/api.ts";

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_INTERVAL_MS = 30_000;

/**
 * Calls `onItems` with each fresh list. Stops when `enabled` turns false or the component
 * unmounts, pauses while the document is hidden, and doubles the wait after each failure (up to
 * 30 s), returning to the normal pace after a success.
 */
export function useConnectionPoll(
  enabled: boolean,
  onItems: (items: ConnectionInfo[]) => void,
  intervalMs: number = POLL_INTERVAL_MS,
): void {
  const latest = useRef(onItems);
  latest.current = onItems;

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let ctrl: AbortController | null = null;
    let delay = intervalMs;
    let stopped = false;

    const schedule = () => {
      if (stopped || document.visibilityState === "hidden") return;
      timer = window.setTimeout(tick, delay);
    };
    const tick = async () => {
      timer = undefined;
      ctrl = new AbortController();
      try {
        const res = await api<Paged<ConnectionInfo>>(API.connections, { signal: ctrl.signal });
        if (stopped) return;
        delay = intervalMs;
        latest.current(res.items);
      } catch {
        if (stopped) return;
        delay = Math.min(delay * 2, POLL_MAX_INTERVAL_MS);
      } finally {
        ctrl = null;
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && ctrl === null) {
        // Coming back: check soon rather than waiting out a long back-off.
        delay = intervalMs;
        schedule();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}
