// The renderer protocol (version 1) as the design frame speaks it: the app may ask it to print.
// The frame posts nothing to the app.
//
//   app -> frame: print          print or save as PDF, one artboard per page
import { RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";

export type DesignAppMessage = { type: "print" };

/** A message from the app page, validated, or null. The caller checks source and origin. */
export function readDesignAppMessage(data: unknown): DesignAppMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== RENDERER_MESSAGE_SOURCE || m.v !== RENDERER_PROTOCOL_VERSION) return null;
  return m.type === "print" ? { type: "print" } : null;
}

/** Whether a message event comes from the app page that frames this design. */
export function fromApp(
  e: Pick<MessageEvent, "source" | "origin">,
  win: Window,
  appOrigin: string,
): boolean {
  return appOrigin !== "" && e.source === win.parent && e.origin === appOrigin;
}
