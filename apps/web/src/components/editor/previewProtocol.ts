// The editor preview protocol (version 1), app side. The loader page lives on the artifact's own
// content subdomain at /__plinth/preview (apps/worker/src/content/preview.ts):
//   frame -> app: { source: "plinth-preview", v: 1, type: "ready" }   (posted to the app origin)
//   app -> frame: { source: "plinth-preview", v: 1, type: "render", html }   (posted to that
//                 artifact's content origin, never "*")
// The loader replaces its own document with the HTML, so each render needs a fresh loader: the app
// reloads the frame, waits for "ready", then posts the latest HTML.
//
// Messages from the frame are untrusted (the rendered draft runs in the same origin and can post
// anything): the app checks origin, source window and shape, and the only thing it ever does in
// response is post the current draft back to that same frame.
import { type AppConfig, CONTENT_RESERVED_PREFIX, LIMITS } from "@plinth/shared";

export const PREVIEW_SOURCE = "plinth-preview";
export const PREVIEW_PROTOCOL_VERSION = 1;
export const PREVIEW_PATH = `${CONTENT_RESERVED_PREFIX}preview`;
/** Same cap as a published version's HTML. The loader refuses anything larger. */
export const MAX_PREVIEW_BYTES = LIMITS.maxHtmlBytes;

/** Sandbox for every artifact frame (DECISIONS.md): never allow-top-navigation. */
export const ARTIFACT_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export interface RenderMessage {
  source: typeof PREVIEW_SOURCE;
  v: typeof PREVIEW_PROTOCOL_VERSION;
  type: "render";
  html: string;
}

export function renderMessage(html: string): RenderMessage {
  return { source: PREVIEW_SOURCE, v: PREVIEW_PROTOCOL_VERSION, type: "render", html };
}

export function isReadyMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.source === PREVIEW_SOURCE && d.v === PREVIEW_PROTOCOL_VERSION && d.type === "ready";
}

/**
 * The artifact's own origin on the content host, or null when the instance serves content from the
 * app origin (STAGING_CONTENT_FALLBACK): there the CSP sandbox gives the frame an opaque origin that
 * a message cannot be addressed to without "*", so live preview is unavailable.
 */
export function previewOrigin(config: AppConfig, artifactId: string): string | null {
  if (config.content_path_fallback) return null;
  return `${config.content_protocol.replace(/:?$/, ":")}//${artifactId}.${config.content_host}`;
}

let encoder: TextEncoder | null = null;
export function utf8Bytes(s: string): number {
  // UTF-8 is never shorter than the UTF-16 length, so huge strings need no encoding to reject.
  if (s.length > MAX_PREVIEW_BYTES) return s.length;
  encoder ??= new TextEncoder();
  return encoder.encode(s).length;
}
