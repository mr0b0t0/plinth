// The typed-renderer protocol (version 1), app side. A typed artifact (a doc) is a fixed Plinth
// renderer page on the artifact's content origin (apps/web/src/renderers/doc/boot.ts). The app
// sends it one message:
//   app -> frame: { source: "plinth-renderer", v: 1, type: "print" }
// and the renderer calls its own window.print(), so the browser prints the doc, not the app page.
// The renderer acts on it only when event.source is its parent and event.origin is the app origin.
//
// The message carries no data, so nothing leaks whoever receives it. It still goes only to the
// window of the frame the app holds, addressed to the artifact's exact content origin under origin
// isolation. Under opaque isolation and in the path fallback the frame's origin is "null", which
// postMessage cannot name, so the target is "*".
import { type AppConfig, RENDERER_MESSAGE_SOURCE, RENDERER_PROTOCOL_VERSION } from "@plinth/shared";

export interface PrintMessage {
  source: typeof RENDERER_MESSAGE_SOURCE;
  v: typeof RENDERER_PROTOCOL_VERSION;
  type: "print";
}

export function printMessage(): PrintMessage {
  return { source: RENDERER_MESSAGE_SOURCE, v: RENDERER_PROTOCOL_VERSION, type: "print" };
}

/**
 * targetOrigin for messages to an artifact's renderer frame: the content origin under origin
 * isolation (null when it is unknown, so nothing is sent), "*" when the frame's origin is opaque.
 */
export function rendererTargetOrigin(
  config: Pick<AppConfig, "content_isolation" | "content_path_fallback"> | null | undefined,
  contentOrigin: string,
): string | null {
  if (config?.content_path_fallback || config?.content_isolation === "opaque") return "*";
  return /^https?:\/\/[^/]+$/.test(contentOrigin) ? contentOrigin : null;
}

/** Ask the renderer in `frame` to print. False when there is no frame window or target. */
export function postPrint(frame: HTMLIFrameElement | null, targetOrigin: string | null): boolean {
  const win = frame?.contentWindow;
  if (!win || !targetOrigin) return false;
  win.postMessage(printMessage(), targetOrigin);
  return true;
}
