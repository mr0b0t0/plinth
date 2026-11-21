// A request from the artifact frame that would open something the person closed (the comments
// panel, or the Ask dialog) is accepted at most once per PAGE_COMMENT_LIMITS.reopenMinIntervalMs,
// so a page cannot keep reopening it. Shared by comments from the page (usePageComments.ts) and
// Ask an agent from a renderer (askAgent.tsx).
import { PAGE_COMMENT_LIMITS } from "@plinth/shared";

export interface ReopenGate {
  /** Whether a request at time `t` that would open something closed (`closed`) is refused. */
  refused(t: number, closed: boolean): boolean;
  /** An accepted request at time `t`: it takes the slot when it opened something closed. */
  take(t: number, closed: boolean): void;
}

export function reopenGate(): ReopenGate {
  let last = Number.NEGATIVE_INFINITY;
  return {
    refused: (t, closed) => closed && t - last < PAGE_COMMENT_LIMITS.reopenMinIntervalMs,
    take(t, closed) {
      if (closed) last = t;
    },
  };
}
