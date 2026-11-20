// The renderer protocol (version 1) as the sheet frame speaks it. The app may ask the frame to
// print or to download the sheet; neither message carries any data, and the frame answers nothing.
// On-page editing (#36) adds the doc renderer's two messages, with the same meaning:
//
//   app -> frame: print                          the frame calls its own window.print()
//   app -> frame: export { format }              "csv" or "xlsx": the frame builds the file and
//                                                downloads it from a blob: URL
//   app -> frame: edit { on }                    edit mode on or off (room, or solo without one)
//   app -> frame: collect { nonce }              solo: the frame answers draft { nonce, text }
//   frame -> app: live { ...status }, save, draft { nonce, text }   as the doc renderer sends them
//
// The frame acts on a message only when it comes from its parent window at the app origin.
import {
  RENDERER_MESSAGE_SOURCE,
  RENDERER_PROTOCOL_VERSION,
  SHEET_EXPORT_FORMATS,
  type SheetExportFormat,
} from "@plinth/shared";

export type SheetAppMessage =
  | { type: "print" }
  | { type: "export"; format: SheetExportFormat }
  | { type: "edit"; on: boolean }
  | { type: "collect"; nonce: string };

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** A message from the app page, validated, or null. The caller checks source and origin. */
export function readSheetAppMessage(data: unknown): SheetAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  if (m.type === "print") return { type: "print" };
  if (m.type === "export" && SHEET_EXPORT_FORMATS.some((f) => f === m.format)) {
    return { type: "export", format: m.format as SheetExportFormat };
  }
  if (m.type === "edit" && typeof m.on === "boolean") return { type: "edit", on: m.on };
  if (m.type === "collect" && typeof m.nonce === "string" && NONCE_RE.test(m.nonce)) {
    return { type: "collect", nonce: m.nonce };
  }
  return null;
}

/** Whether a message event comes from the app page that frames this sheet. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
): boolean {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}
