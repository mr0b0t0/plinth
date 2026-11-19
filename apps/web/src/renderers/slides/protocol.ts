// The renderer protocol (version 1) as the slides frame speaks it. The app may ask for a slide, a
// view, a print or a .pptx; the frame tells the app where it is, which view it shows, when the
// person pressed `f` and how an export went. Every message carries only a slide number, a count, a
// mode name, a boolean or the app's own nonce, never deck text.
//
//   app -> frame: goto { slide }             show slide N (clamped to the deck)
//   app -> frame: view { mode }              "deck", "presenter" or "overview"
//   app -> frame: print { notes? }           print the deck, or the handout with notes
//   app -> frame: export { format, nonce }   build the deck as .pptx and download it in the frame
//   frame -> app: ready { slide, count }     after boot
//   frame -> app: position { slide, count }  after every change
//   frame -> app: view { mode }              the view it now shows, after every change (its own
//                                            keys and controls too), and in answer to a view it
//                                            did not take (review mode keeps the overview)
//   frame -> app: fullscreen                 the person pressed f
//   frame -> app: exported { nonce, ok, images_skipped, opaque }
//                                            the export's outcome: whether the file was made, how
//                                            many images were left out, and whether that was
//                                            because the frame's origin is opaque
import { isSlideNumber, RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";
import type { DeckMode } from "./nav.ts";

export type SlidesAppMessage =
  | { type: "goto"; slide: number }
  | { type: "view"; mode: DeckMode }
  | { type: "print"; notes: boolean }
  | { type: "export"; format: "pptx"; nonce: string };

/** The app's nonce for one export request. */
export const EXPORT_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const MODES: readonly DeckMode[] = ["deck", "presenter", "overview"];

/** A message from the app page, validated, or null. The caller checks source and origin. */
export function readSlidesAppMessage(data: unknown): SlidesAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "goto") return isSlideNumber(m.slide) ? { type: "goto", slide: m.slide } : null;
  if (m.type === "view") {
    return MODES.includes(m.mode as DeckMode) ? { type: "view", mode: m.mode as DeckMode } : null;
  }
  if (m.type === "print") {
    if (m.notes !== undefined && typeof m.notes !== "boolean") return null;
    return { type: "print", notes: m.notes === true };
  }
  if (m.type === "export") {
    if (m.format !== "pptx" || typeof m.nonce !== "string" || !EXPORT_NONCE_RE.test(m.nonce)) {
      return null;
    }
    return { type: "export", format: "pptx", nonce: m.nonce };
  }
  return null;
}

/** Whether a message event comes from the app page that frames this deck. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
) {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}

export type SlidesFrameMessage =
  | { type: "ready"; slide: number; count: number }
  | { type: "position"; slide: number; count: number }
  | { type: "view"; mode: DeckMode }
  | { type: "fullscreen" }
  | { type: "exported"; nonce: string; ok: boolean; images_skipped: number; opaque: boolean };

/** Posts to the app page, at the exact app origin only. */
export function postToApp(win: Window, appOrigin: string, msg: SlidesFrameMessage): void {
  if (appOrigin === "" || win.parent === win) return;
  try {
    win.parent.postMessage(
      { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...msg },
      appOrigin,
    );
  } catch {
    // The app page is gone or navigated away: nobody to tell.
  }
}
