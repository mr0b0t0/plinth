// `?edit` where this person can edit on the page (docs/spec.md "New and Import"): the page drops
// `edit` from the address and starts editing, and the frame, once loaded, puts the focus on its
// first block or cell (`edit { on: true, focus: "first" }`). New and Import open a new artifact
// this way. Every other case of `?edit` (editing off here, a commenter, an editor who must sign in
// first, a viewer) is askAgent.tsx's, which reads the same parameter.
import { useEffect, useRef } from "react";
import type { LiveEdit } from "./useLiveEdit.ts";

/** Remove `edit` from the address, keeping the rest and the history entry. */
function dropEdit(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("edit")) return;
  url.searchParams.delete("edit");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useEditStart(live: Pick<LiveEdit, "available" | "signIn" | "start">): void {
  // Read once, when the page opens: a later address change is not an arrival.
  const want = useRef<boolean | null>(null);
  if (want.current === null) want.current = new URLSearchParams(window.location.search).has("edit");
  const start = useRef(live.start);
  start.current = live.start;
  useEffect(() => {
    if (!want.current || !live.available || live.signIn) return;
    want.current = false;
    dropEdit();
    start.current({ focus: "first" });
  }, [live.available, live.signIn]);
}
