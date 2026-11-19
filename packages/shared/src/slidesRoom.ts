// Following the presenter (docs/spec.md "Slides"): the frames of a deck's `slides` socket, Plinth's
// own channel in the artifact's room (apps/worker/src/rooms/slides.ts). Zod-free, so the slides
// renderer bundle and the room share one hand-written validator.
//
// Only slide numbers cross it. A presenter (an owner or editor) sends `start`, `goto` and `stop`;
// everyone else may send nothing but the text `ping`. The room answers with the leading
// presenter's slide, stamped with that socket's random id, never with an identity.
import { isSlideNumber } from "./slides.ts";

/** UTF-8 bytes of one client frame on a slides socket; a longer one closes it with 1009. */
export const SLIDES_FRAME_BYTES = 128;

export type SlidesClientFrame =
  /** Become the leading presenter, at this slide. */
  | { t: "start"; slide: number }
  /** The leading presenter moved. */
  | { t: "goto"; slide: number }
  /** Stop leading. */
  | { t: "stop" };

/** Where the leading presenter is: a slide, and the leading socket's random id. */
export interface SlidesPosition {
  slide: number;
  by: string;
}

export type SlidesErrorCode = "forbidden" | "invalid" | "rate_limited" | "not_leading";

export type SlidesServerFrame =
  | {
      t: "welcome";
      v: 1;
      /** This socket's random id, and whether it may present. */
      you: { id: string; present: boolean };
      /** The leading presenter's position, or null when nobody leads. */
      at: SlidesPosition | null;
    }
  /** The leading presenter is at `slide` (a new leader, or the leader moved). */
  | { t: "at"; slide: number; by: string }
  /** Nobody leads any more. */
  | { t: "stopped" }
  /** Only to the leading presenter: how many other people have the deck open on this channel. */
  | { t: "audience"; n: number }
  | { t: "error"; code: SlidesErrorCode };

const SOCKET_ID_RE = /^s_[A-Za-z0-9_-]{1,64}$/;
const ERROR_CODES: ReadonlySet<string> = new Set([
  "forbidden",
  "invalid",
  "rate_limited",
  "not_leading",
]);

function object(raw: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const ks = Object.keys(o);
  return ks.length === keys.length && ks.every((k) => keys.includes(k));
}

/**
 * A client frame, or null for anything else: exactly `{t:"start",slide}`, `{t:"goto",slide}` or
 * `{t:"stop"}`, with no other key, and a slide from 1 to LIMITS.maxSlides.
 */
export function parseSlidesClientFrame(raw: string): SlidesClientFrame | null {
  if (raw.length > SLIDES_FRAME_BYTES) return null;
  const o = object(raw);
  if (!o) return null;
  if (o.t === "stop") return onlyKeys(o, ["t"]) ? { t: "stop" } : null;
  if ((o.t === "start" || o.t === "goto") && onlyKeys(o, ["t", "slide"]) && isSlideNumber(o.slide))
    return { t: o.t, slide: o.slide };
  return null;
}

function position(v: unknown): SlidesPosition | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return isSlideNumber(p.slide) && typeof p.by === "string" && SOCKET_ID_RE.test(p.by)
    ? { slide: p.slide, by: p.by }
    : null;
}

/** A server frame as the renderer reads it, or null for anything it does not know. */
export function parseSlidesServerFrame(raw: string): SlidesServerFrame | null {
  if (raw.length > 1024) return null;
  const o = object(raw);
  if (!o) return null;
  switch (o.t) {
    case "welcome": {
      const you = o.you as Record<string, unknown> | null | undefined;
      if (o.v !== 1 || typeof you !== "object" || you === null) return null;
      if (typeof you.id !== "string" || !SOCKET_ID_RE.test(you.id)) return null;
      if (typeof you.present !== "boolean") return null;
      const at = o.at === null ? null : position(o.at);
      if (o.at !== null && !at) return null;
      return { t: "welcome", v: 1, you: { id: you.id, present: you.present }, at };
    }
    case "at": {
      const at = position(o);
      return at ? { t: "at", ...at } : null;
    }
    case "stopped":
      return { t: "stopped" };
    case "audience":
      return typeof o.n === "number" && Number.isSafeInteger(o.n) && o.n >= 0
        ? { t: "audience", n: o.n }
        : null;
    case "error":
      return typeof o.code === "string" && ERROR_CODES.has(o.code)
        ? { t: "error", code: o.code as SlidesErrorCode }
        : null;
    default:
      return null;
  }
}
