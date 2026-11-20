// The renderer protocol (version 1) as the whiteboard frame speaks it. The app's artifact menu may
// ask the frame to download the board; the message carries only a format and the frame answers
// nothing.
//
//   app -> frame: export { format }   "png" or "svg": the frame draws the whole board and
//                                     downloads it from a blob: URL
//
// The frame acts on a message only when it comes from its parent window at the app origin.
import { RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";

export type BoardExportFormat = "png" | "svg";

/** An export request from the app page, validated, or null. The caller checks source and origin. */
export function readBoardAppMessage(data: unknown): { format: BoardExportFormat } | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "export" && (m.format === "png" || m.format === "svg")) {
    return { format: m.format };
  }
  return null;
}

/** Whether a message event comes from the app page that frames this board. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
): boolean {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}
