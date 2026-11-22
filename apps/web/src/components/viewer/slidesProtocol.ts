// What a deck's frame tells the app (renderer protocol version 1, frame -> app), and the one check
// that a message came from it. A deck reports only numbers, booleans and view names: where it is
// (ready, position), which view it shows (view), that the person pressed f (fullscreen), how a
// .pptx export went (exported, with the app's own nonce), and whether the person leads viewers
// over the room (leading). These messages never carry deck text.
//
// The doc renderer's editing messages are accepted only at the exact content origin. A deck's are
// also accepted from an opaque frame (origin "null", under CONTENT_ISOLATION=opaque and the path
// fallback), identified by its window (frameGuard.ts acceptFrom). That is acceptable because only
// Plinth's renderer runs on a deck's origin (script-src 'self', and a deck's files run no script),
// and the worst a forged message could do is move the app's slide number, switch its presenter
// mode, ask for full screen, which the browser grants only with the person's own activation,
// show a wrong toast about an export the app itself asked for (the nonce must match), or have the
// app ask the deck's next frame to lead, which the room allows only for owners and editors.
import {
  isSlideNumber,
  LIMITS,
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  typeDef,
} from "@plinth/shared";
import { acceptFrom } from "../comments/frameGuard.ts";
import { NONCE_RE } from "./rendererProtocol.ts";

/** The views a deck's frame shows. */
export type DeckView = "deck" | "presenter" | "overview";
const DECK_VIEWS: readonly unknown[] = ["deck", "presenter", "overview"] satisfies DeckView[];

export type SlidesFrameMessage =
  | { type: "ready"; slide: number; count: number }
  | { type: "position"; slide: number; count: number }
  | { type: "view"; mode: DeckView }
  | { type: "fullscreen" }
  | {
      type: "exported";
      nonce: string;
      ok: boolean;
      /** Images left out of the file. */
      images_skipped: number;
      /** An HTML deck's live embeds left out of the file (they run code); absent for none. */
      embeds_skipped?: number;
      /** The frame's origin is opaque, so it left out every image file. */
      opaque: boolean;
    }
  /** The person leads viewers over the room (true), or stopped or lost the lead (false). */
  | { type: "leading"; on: boolean };

type Kind = SlidesFrameMessage["type"];

/** Each frame -> app kind of a deck and its validator. */
const READERS: {
  readonly [K in Kind]: (
    m: Record<string, unknown>,
  ) => Extract<SlidesFrameMessage, { type: K }> | null;
} = {
  ready: (m) =>
    isSlideNumber(m.slide) && isSlideNumber(m.count) && m.slide <= m.count
      ? { type: "ready", slide: m.slide, count: m.count }
      : null,
  position: (m) =>
    isSlideNumber(m.slide) && isSlideNumber(m.count) && m.slide <= m.count
      ? { type: "position", slide: m.slide, count: m.count }
      : null,
  view: (m) => (DECK_VIEWS.includes(m.mode) ? { type: "view", mode: m.mode as DeckView } : null),
  fullscreen: () => ({ type: "fullscreen" }),
  exported: (m) =>
    typeof m.nonce === "string" &&
    NONCE_RE.test(m.nonce) &&
    typeof m.ok === "boolean" &&
    typeof m.opaque === "boolean" &&
    typeof m.images_skipped === "number" &&
    Number.isInteger(m.images_skipped) &&
    m.images_skipped >= 0 &&
    m.images_skipped <= LIMITS.maxAssetsCeiling &&
    (m.embeds_skipped === undefined ||
      (typeof m.embeds_skipped === "number" &&
        Number.isInteger(m.embeds_skipped) &&
        m.embeds_skipped >= 1 &&
        m.embeds_skipped <= LIMITS.maxSlides * 8))
      ? {
          type: "exported",
          nonce: m.nonce,
          ok: m.ok,
          images_skipped: m.images_skipped,
          ...(m.embeds_skipped !== undefined ? { embeds_skipped: m.embeds_skipped as number } : {}),
          opaque: m.opaque,
        }
      : null,
  leading: (m) => (typeof m.on === "boolean" ? { type: "leading", on: m.on } : null),
};

export const SLIDES_FRAME_KINDS = Object.keys(READERS) as readonly Kind[];

/**
 * A message from the deck in `frame`, validated, or null. `opaque` is true under opaque content
 * isolation and the path fallback. Only for an artifact whose type presents (slides).
 */
export function readSlidesFrameMessage(
  e: Pick<MessageEvent, "source" | "origin" | "data">,
  o: { frame: HTMLIFrameElement | null; contentOrigin: string; opaque: boolean; type: string },
): SlidesFrameMessage | null {
  if (!o.frame || typeDef(o.type)?.present !== true) return null;
  if (!acceptFrom(o.frame, o.contentOrigin, o.opaque)(e)) return null;
  const m = e.data as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) return null;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (typeof m.type !== "string" || !Object.hasOwn(READERS, m.type)) return null;
  return READERS[m.type as Kind](m);
}
