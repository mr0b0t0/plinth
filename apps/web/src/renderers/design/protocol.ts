// The renderer protocol (version 1) as the design frame speaks it.
//
//   app -> frame: print            print or save as PDF, one artboard per page
//   app -> frame: goto { board }   show that board (the app address's #board=<id>)
//   frame -> app: ready { board }  the canvas is up; board is the one it shows, or null
//   frame -> app: board { board }  the board the canvas shows changed (zoomed to one, a flow, or
//                                  null after Fit)
//
// The frame tells the app only board ids ([a-z0-9-], from the parser), never author text, and
// posts only to the exact app origin.
import { isArtboardId, RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";

export type DesignAppMessage = { type: "print" } | { type: "goto"; board: string };

/** A message from the app page, validated, or null. The caller checks source and origin. */
export function readDesignAppMessage(data: unknown): DesignAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "print") return { type: "print" };
  if (m.type === "goto" && isArtboardId(m.board)) return { type: "goto", board: m.board };
  return null;
}

/** Whether a message event comes from the app page that frames this design. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
): boolean {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}

export type DesignFrameMessage =
  | { type: "ready"; board: string | null }
  | { type: "board"; board: string | null };

/** Posts to the app page, at the exact app origin only. Nothing when the shell is top-level. */
export function postToApp(win: Window, appOrigin: string, msg: DesignFrameMessage): void {
  if (appOrigin === "" || win.parent === win) return;
  try {
    win.parent.postMessage(
      { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, ...msg },
      appOrigin,
    );
  } catch {
    // The app page is gone: nobody to tell.
  }
}
