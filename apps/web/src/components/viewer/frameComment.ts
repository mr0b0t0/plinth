// "Comment" from a renderer (docs/spec.md "Asking an agent"): a place the person cannot change on
// the page (a doc block shown read-only, an image, a slide's image, a design system's token name,
// component or settings) has a "Comment" control in the frame. It posts `ask` (rendererProtocol.ts)
// with a structural anchor and the app opens the comments panel with the composer pinned to that
// place, where the person writes the comment and mentions an agent (@claude) to have it changed.
// There is no other way to ask an agent: no button, menu item or dialog of its own.
//
// The message is a hint the app may refuse, under the rules for a page's own compose
// (usePageComments.ts): accepted only while the tab is visible and no dialog is open, at most one a
// second whatever is open, and one that would open the closed panel at most once per
// PAGE_COMMENT_LIMITS.reopenMinIntervalMs. It carries no comment text: the person writes it.
import { PAGE_COMMENT_LIMITS, type PageAnchor } from "@plinth/shared";
import { useCallback, useRef } from "react";
import type { PanelPin } from "../comments/CommentsPanel.tsx";
import { type ReopenGate, reopenGate } from "../comments/reopenGate.ts";
import type { AskWhat } from "./rendererProtocol.ts";

/** The place a renderer named, as the comments API takes it. */
export function pageAnchorOf(a: { key: string; text: string } | null): PageAnchor | null {
  return a ? { kind: "page", key: a.key, ...(a.text ? { text: a.text } : {}) } : null;
}

/** A renderer's place to pin the composer to; `n` changes for every one. */
export type CommentPin = PanelPin;

export function useFrameComment({
  blocked,
  panelOpen,
  open,
}: {
  /** A dialog is open over the stage (Share, or a stage dialog). */
  blocked: boolean;
  /** The comments panel is open. */
  panelOpen: boolean;
  /** Open the comments panel (when closed) with the composer pinned to this place. */
  open: (anchor: PageAnchor | null, what: AskWhat | null) => void;
}): (anchor: PageAnchor | null, what?: AskWhat) => void {
  const latest = useRef({ blocked, panelOpen, open });
  latest.current = { blocked, panelOpen, open };
  const reopen = useRef<ReopenGate | null>(null);
  const last = useRef(Number.NEGATIVE_INFINITY);
  return useCallback((anchor: PageAnchor | null, what?: AskWhat) => {
    const l = latest.current;
    if (l.blocked || document.visibilityState !== "visible") return;
    const t = Date.now();
    // At most one a second, whatever is open: with the panel open (nothing to reopen) each one
    // would pin the composer somewhere else and take the focus again.
    if (t - last.current < PAGE_COMMENT_LIMITS.composeMinIntervalMs) return;
    const closed = !l.panelOpen;
    reopen.current ??= reopenGate();
    if (reopen.current.refused(t, closed)) return;
    reopen.current.take(t, closed);
    last.current = t;
    l.open(anchor, anchor ? (what ?? null) : null);
  }, []);
}
