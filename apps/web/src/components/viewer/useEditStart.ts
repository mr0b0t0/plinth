// `?edit` where this person can edit on the page (docs/spec.md "New and Import"): the page drops
// `edit` from the address, and the frame, which is in edit mode from the start (always-on
// editing), puts the focus on its first block or cell once loaded (`edit { on: true, focus:
// "first" }`). New and Import open a new artifact
// this way. Every other case of `?edit` (editing off here, a commenter, an editor who must sign in
// first, a viewer) is editArrival.ts's, which reads the same parameter.
import { useEffect, useRef } from "react";
import type { LiveEdit } from "./useLiveEdit.ts";

/** Remove `edit` from the address, keeping the rest and the history entry. */
function dropEdit(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("edit")) return;
  url.searchParams.delete("edit");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useEditStart(
  live: Pick<LiveEdit, "available" | "signIn" | "editing" | "focusFirst">,
): void {
  // Read once, when the page opens: a later address change is not an arrival.
  const want = useRef<boolean | null>(null);
  if (want.current === null) want.current = new URLSearchParams(window.location.search).has("edit");
  const focus = useRef(live.focusFirst);
  focus.current = live.focusFirst;
  useEffect(() => {
    if (!want.current || !live.available || live.signIn || !live.editing) return;
    want.current = false;
    dropEdit();
    focus.current();
  }, [live.available, live.signIn, live.editing]);
}
