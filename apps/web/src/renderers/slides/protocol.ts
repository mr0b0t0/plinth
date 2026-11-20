// The renderer protocol (version 1) as the slides frame speaks it. The app may ask for a slide, a
// view or a print; the frame tells the app where it is, which view it shows and when the person
// pressed `f`. Every message carries only a slide number, a count or a mode name, never deck text.
//
//   app -> frame: goto { slide }             show slide N (clamped to the deck)
//   app -> frame: view { mode }              "deck", "presenter" or "overview"
//   app -> frame: print                      print the deck (the handout with notes from
//                                            presenter view)
//   frame -> app: ready { slide, count }     after boot
//   frame -> app: position { slide, count }  after every change
//   frame -> app: view { mode }              the view it now shows, after every change (its own
//                                            keys and controls too), and in answer to a view it
//                                            did not take (review mode keeps the overview)
//   frame -> app: fullscreen                 the person pressed f
import { isSlideNumber, RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";
import type { DeckMode } from "./nav.ts";

export type SlidesAppMessage =
  | { type: "goto"; slide: number }
  | { type: "view"; mode: DeckMode }
  | { type: "print" };

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
  if (m.type === "print") return { type: "print" };
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
  | { type: "fullscreen" };

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
