// Applying a newer version to an open view while keeping the reader's state (docs/spec.md "Live
// views"). Pure: planUpdate picks how, and readViewMessage validates the page runtime's answers.
//
// - keep: a permanent version link, or a frame paused by live editing or presenting (the version
//   watch already moved only the count; useVersionWatch.ts).
// - in-place: a doc under origin isolation, outside review mode and outside a live-editing room:
//   the doc renderer fetches the new version's Markdown and re-renders where the reader is.
// - hold: an HTML page that declares `hold` while focus is inside its frame (the hold rule): the
//   bar offers "v5 is available · Update" instead of replacing the page. It comes before ask: a
//   runtime answering update:ok records scroll and handed-over state, not what is being typed, so
//   a page that declared `hold` is not replaced under the viewer even when it loads the runtime.
// - ask: an HTML page whose frame runtime said hello (origin isolation): it records scroll, place
//   and state in its own sessionStorage, or asks to hold.
// - swap: everything else, as before: a fresh frame loads under the old one.
// With live views off on the instance (AppConfig.live_views) every update is a swap.
import {
  type ArtifactType,
  LIVE_VIEW_LIMITS,
  REVIEW_MODE_PARAM,
  VIEW_MESSAGE_SOURCE,
  VIEW_MESSAGE_VERSION,
  type ViewFrameMessage,
  type ViewPageMessage,
} from "@plinth/shared";
import { NONCE_RE } from "./rendererProtocol.ts";
import type { WatchPause } from "./useVersionWatch.ts";

export type UpdatePlan =
  | { kind: "keep" }
  | { kind: "in-place" }
  | { kind: "ask" }
  | { kind: "swap" }
  | { kind: "hold" };

export interface UpdateSituation {
  /** Live views are on for this instance (AppConfig.live_views). */
  enabled: boolean;
  type: ArtifactType;
  pinned: boolean;
  pause: WatchPause;
  /** Review mode: the frame carries the comment-anchoring bridge. */
  review: boolean;
  isolation: "origin" | "opaque";
  pathFallback: boolean;
  /** The frame's runtime said hello (it can answer `update`). */
  runtimeHello: boolean;
  /** Focus is inside the frame: the viewer is using the page. */
  frameFocused: boolean;
  /** The doc frame follows a live-editing room (gate.live.mode "room"). */
  liveRoomFrame: boolean;
  /** The shown version declares `hold` (gate.hold). */
  holdDeclared: boolean;
}

/** How to apply a newer version to the frame on view. */
export function planUpdate(s: UpdateSituation): UpdatePlan {
  if (s.pinned || s.pause !== null) return { kind: "keep" };
  if (!s.enabled) return { kind: "swap" };
  const origin = s.isolation === "origin" && !s.pathFallback;
  if (s.type === "doc") {
    return origin && !s.review && !s.liveRoomFrame ? { kind: "in-place" } : { kind: "swap" };
  }
  if (s.type !== "html") return { kind: "swap" };
  if (s.holdDeclared && s.frameFocused) return { kind: "hold" };
  if (origin && s.runtimeHello) return { kind: "ask" };
  return { kind: "swap" };
}

/** Whether the viewer is using the page in `frame`: focus is inside it and the tab has focus. */
export function frameHasFocus(frame: HTMLIFrameElement | null): boolean {
  return frame !== null && document.activeElement === frame && document.hasFocus();
}

/** The `update` message for the frame's runtime (posted at the exact content origin only). */
export function updateMessage(o: {
  from: number;
  to: number;
  nonce: string;
  force: boolean;
}): Extract<ViewFrameMessage, { type: "update" }> {
  return { source: VIEW_MESSAGE_SOURCE, v: VIEW_MESSAGE_VERSION, type: "update", ...o };
}

/**
 * A path the frame reports, made safe to hand to the gate as `next`, or null for the artifact's
 * root. Untrusted: it must start with one "/", hold no backslash or control character and be at
 * most 2048 characters; Plinth's own paths (/__plinth/...) and the review flag are dropped. The
 * hash is dropped too: `next` goes into request URLs (the gate read, the enter URL), and a page's
 * fragment never leaves the viewer's browser (the runtime keeps it in its carry record). The
 * server passes `next` through safeNext again.
 */
export function carryPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > LIVE_VIEW_LIMITS.maxCarryPathLength) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(raw, "https://path.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://path.invalid") return null;
  if (u.pathname.startsWith("/__plinth/")) return null;
  u.searchParams.delete(REVIEW_MODE_PARAM);
  const out = `${u.pathname}${u.search}`;
  return out === "/" || out === "/index.html" ? null : out;
}

/**
 * A message from the frame's page runtime, validated, or null. It must come from `frame`'s window
 * at exactly `contentOrigin` (never "*" or "null": under opaque isolation there is no runtime
 * handshake), with the live-view source and version; `update:ok` and `update:hold` only for the
 * nonce the app is waiting on (`nonce`), and `path` only as carryPath accepts it.
 */
export function readViewMessage(
  e: Pick<MessageEvent, "source" | "origin" | "data">,
  opts: { frame: HTMLIFrameElement | null; contentOrigin: string | null; nonce: string | null },
): ViewPageMessage | null {
  const win = opts.frame?.contentWindow;
  if (!win || e.source !== win) return null;
  const origin = opts.contentOrigin;
  if (!origin || origin === "*" || origin === "null" || e.origin !== origin) return null;
  const m = e.data as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return null;
  if (m.source !== VIEW_MESSAGE_SOURCE || m.v !== VIEW_MESSAGE_VERSION) return null;
  if (m.type === "hello") return { type: "hello" };
  if (m.type !== "update:ok" && m.type !== "update:hold") return null;
  if (!opts.nonce || typeof m.nonce !== "string" || !NONCE_RE.test(m.nonce)) return null;
  if (m.nonce !== opts.nonce) return null;
  if (m.type === "update:hold") return { type: "update:hold", nonce: m.nonce };
  if (m.path !== null && m.path !== undefined && typeof m.path !== "string") return null;
  return { type: "update:ok", nonce: m.nonce, path: carryPath(m.path) };
}
