// The renderer protocol (version 1) as the sheet frame speaks it. The app may ask the frame to
// print or to download the sheet; neither message carries any data, and the frame answers nothing.
// On-page editing (#36) adds the doc renderer's two messages, with the same meaning:
//
//   app -> frame: print                          the frame calls its own window.print()
//   app -> frame: export { format }              "csv" or "xlsx": the frame builds the file and
//                                                downloads it from a blob: URL
//   app -> frame: edit { on, base? }             edit mode on or off (room, or solo without one)
//   app -> frame: collect { nonce }              solo: the frame answers draft { nonce, text }
//   app -> frame: review, reviewed               the whole-draft review (common/editSession.ts)
//   frame -> app: live { ...status }, save, draft { nonce, text }, resolved, leave
//                                                as the doc renderer sends them, with the frame key
//
// The frame acts on a message only when it comes from its parent window at the app origin.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  SHEET_EXPORT_FORMATS,
  type SheetExportFormat,
} from "@plinth/shared";
import { type EditAppMessage, readEditMessage } from "../common/editSession.ts";

export type SheetAppMessage =
  | { type: "print" }
  | { type: "export"; format: SheetExportFormat }
  | EditAppMessage;

/** A message from the app page, validated, or null. The caller checks source and origin. */
export function readSheetAppMessage(data: unknown): SheetAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "print") return { type: "print" };
  if (m.type === "export" && SHEET_EXPORT_FORMATS.some((f) => f === m.format)) {
    return { type: "export", format: m.format as SheetExportFormat };
  }
  return readEditMessage(data);
}

/** Whether a message event comes from the app page that frames this sheet. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
): boolean {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}
