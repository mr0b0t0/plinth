// `?edit` where this person cannot start editing on the page (docs/spec.md "New and Import"): the
// page opens as usual, with no notice, and `edit` is dropped from the address so a reload or a
// shared copy of it opens the page as usual too. For an editor confirmed by code it focuses "Sign in
// to edit". With `live` (and no sign-in) the page starts editing instead: useEditStart.ts.
import type { ViewGate } from "@plinth/shared";
import { useEffect, useRef } from "react";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** What `?edit` does for this gate: focus "Sign in to edit", or nothing. */
export function editArrival(gate: OkGate): "sign_in" | null {
  return !gate.live_off && gate.live?.sign_in ? "sign_in" : null;
}

/** Remove one search parameter from the address, keeping the rest and the history entry. */
function dropParam(name: string): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(name)) return;
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useEditArrival(gate: OkGate, focusSignIn: () => void): void {
  // Read once, when the page opens: a later address change is not an arrival.
  const arrival = useRef<boolean | null>(null);
  if (arrival.current === null) {
    arrival.current = new URLSearchParams(window.location.search).has("edit");
  }
  const handled = useRef(false);
  const focusRef = useRef(focusSignIn);
  focusRef.current = focusSignIn;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, with the first gate
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (!arrival.current) return;
    if (editArrival(gate) === "sign_in") requestAnimationFrame(() => focusRef.current());
    if (!gate.live || gate.live.sign_in) dropParam("edit");
  }, []);
}
