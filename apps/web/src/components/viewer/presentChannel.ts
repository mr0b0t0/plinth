// Pairs a presenter's window with an audience window in the same browser: the presenter page opens
// /a/<slug>/v/<n>#present=audience&pair=<id> (the version it shows), and both pages join
// BroadcastChannel "plinth-present:<artifact id>:<pair>" on the app origin. The presenter posts the
// slide and the version it is on; the audience page says hello when it opens and shows exactly
// that slide of that version. Only slide and version numbers cross.
//
// The pair id is not a secret: the channel is same-origin and same-browser, and the most another
// app page could do with it is move a slide, or open another version of the same artifact.
import { isSlideNumber } from "@plinth/shared";

export type PresentMessage =
  | { v: 1; type: "slide"; slide: number; version: number }
  | { v: 1; type: "hello" };

/** A version number a channel message may carry. */
function isVersion(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
}

const PAIR_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Whether a pair id from a URL is well formed. */
export function isPairId(s: string | null | undefined): s is string {
  return typeof s === "string" && PAIR_RE.test(s);
}

/** A channel message, validated, or null. */
export function readPresentMessage(data: unknown): PresentMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (m.type === "hello") return { v: 1, type: "hello" };
  if (m.type === "slide" && isSlideNumber(m.slide) && isVersion(m.version)) {
    return { v: 1, type: "slide", slide: m.slide, version: m.version };
  }
  return null;
}

export function channelName(artifactId: string, pair: string): string {
  return `plinth-present:${artifactId}:${pair}`;
}

export interface PresentChannel {
  post(m: PresentMessage): void;
  close(): void;
}

/** Joins the pair's channel, or returns null where BroadcastChannel is missing. */
export function openPresentChannel(
  artifactId: string,
  pair: string,
  onMessage: (m: PresentMessage) => void,
  Channel: typeof BroadcastChannel | null = globalThis.BroadcastChannel ?? null,
): PresentChannel | null {
  if (!Channel || !isPairId(pair)) return null;
  const ch = new Channel(channelName(artifactId, pair));
  ch.onmessage = (e: MessageEvent) => {
    const m = readPresentMessage(e.data);
    if (m) onMessage(m);
  };
  return {
    post: (m) => ch.postMessage(m),
    close: () => ch.close(),
  };
}

/** The app URL fragment's parameters: #slide=4, #present=audience&pair=<id>. */
export function readFragment(hash: string): { slide: number | null; pair: string | null } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = p.get("slide");
  const n = raw !== null && /^\d{1,4}$/.test(raw) ? Number(raw) : null;
  const pair = p.get("present") === "audience" ? p.get("pair") : null;
  return { slide: isSlideNumber(n) ? n : null, pair: isPairId(pair) ? pair : null };
}

/** The fragment with `slide` set, keeping an audience pairing. */
export function writeFragment(hash: string, slide: number): string {
  const { pair } = readFragment(hash);
  return pair ? `#present=audience&pair=${pair}&slide=${slide}` : `#slide=${slide}`;
}
