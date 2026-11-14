// The editor preview protocol (version 2), app side. The loader page lives on the artifact's own
// content subdomain at /__plinth/preview (apps/worker/src/content/preview.ts):
//   app: loads the loader in a NEW iframe element whose URL ends in #plinth-preview=<nonce>, a
//        fresh random value per frame
//   frame -> app: { source: "plinth-preview", v: 2, type: "ready", nonce }   (posted to the app
//                 origin)
//   app -> frame: { source: "plinth-preview", v: 2, type: "render", html }   (posted to that
//                 artifact's content origin; "*" under opaque isolation, see below)
// The loader replaces its own document with the HTML, so each render needs a fresh loader: the app
// mounts a new frame with a new nonce, waits for its "ready", then posts the latest HTML once.
//
// Messages from the frame are untrusted (the rendered draft runs in the same origin and can post
// anything): the app checks origin, source window, nonce and shape, and the only thing it ever does
// in response is post the current draft back to that same frame.
//
// Opaque isolation (AppConfig.content_isolation "opaque", always with the path fallback): the loader
// has an opaque origin, so its messages arrive with origin "null" and the draft can only be posted
// with targetOrigin "*". The draft is private, so the app makes sure the frame still holds the
// loader it created: a new iframe element per render (a browsing context nobody else has a
// reference to, so nobody else can navigate it, unlike a reused frame whose earlier draft may have
// opened a popup that keeps `opener`), a "ready" that must come from that element's window and carry
// that element's nonce (only the document loaded at the app's URL knows it), and one render per
// nonce.
import {
  type AppConfig,
  ARTIFACT_IFRAME_SANDBOX,
  CONTENT_RESERVED_PREFIX,
  LIMITS,
} from "@plinth/shared";

export const PREVIEW_SOURCE = "plinth-preview";
export const PREVIEW_PROTOCOL_VERSION = 2;
export const PREVIEW_PATH = `${CONTENT_RESERVED_PREFIX}preview`;
/** Fragment key that carries the frame's nonce to the loader (never sent to the server). */
export const PREVIEW_NONCE_KEY = "plinth-preview";
/** Same cap as a published version's HTML. The loader refuses anything larger. */
export const MAX_PREVIEW_BYTES = LIMITS.maxHtmlBytes;

/** The sandbox artifact frames use under origin isolation (never allow-top-navigation). */
export const ARTIFACT_FRAME_SANDBOX = ARTIFACT_IFRAME_SANDBOX;

export interface RenderMessage {
  source: typeof PREVIEW_SOURCE;
  v: typeof PREVIEW_PROTOCOL_VERSION;
  type: "render";
  html: string;
}

export function renderMessage(html: string): RenderMessage {
  return { source: PREVIEW_SOURCE, v: PREVIEW_PROTOCOL_VERSION, type: "render", html };
}

/** A "ready" from the loader that was given `nonce`. An empty expected nonce never matches. */
export function isReadyMessage(data: unknown, nonce: string): boolean {
  if (typeof data !== "object" || data === null || nonce === "") return false;
  const d = data as Record<string, unknown>;
  return (
    d.source === PREVIEW_SOURCE &&
    d.v === PREVIEW_PROTOCOL_VERSION &&
    d.type === "ready" &&
    d.nonce === nonce
  );
}

export interface PreviewTarget {
  /** Where the loader lives, without the trailing path: e.g. https://<id>.<content host>. */
  base: string;
  /** event.origin of the loader's messages: the artifact's origin, or "null" when opaque. */
  messageOrigin: string;
  /** targetOrigin for the render message: the artifact's origin, or "*" when opaque. */
  postOrigin: string;
}

/**
 * Where the preview loader for an artifact lives and how to address it. Under origin isolation:
 * the artifact's own origin on the content host, both ways. Under opaque isolation the loader
 * has an opaque origin, so messages from it say "null" and the render goes to "*" (safe only with
 * the fresh-frame and nonce checks above). The path fallback is opaque, on the app host.
 */
export function previewTarget(config: AppConfig, artifactId: string): PreviewTarget {
  const protocol = config.content_protocol.replace(/:?$/, ":");
  const base = config.content_path_fallback
    ? `${config.app_origin}/__content/${artifactId}`
    : `${protocol}//${artifactId}.${config.content_host}`;
  const opaque = config.content_path_fallback || config.content_isolation === "opaque";
  if (opaque) return { base, messageOrigin: "null", postOrigin: "*" };
  return { base, messageOrigin: base, postOrigin: base };
}

/** A fresh, unguessable nonce for one preview frame. */
export function newPreviewNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `url` with the frame's nonce as its fragment (replacing any fragment it had). */
export function withPreviewNonce(url: string, nonce: string): string {
  const hashAt = url.indexOf("#");
  return `${hashAt < 0 ? url : url.slice(0, hashAt)}#${PREVIEW_NONCE_KEY}=${nonce}`;
}

let encoder: TextEncoder | null = null;
export function utf8Bytes(s: string): number {
  // UTF-8 is never shorter than the UTF-16 length, so huge strings need no encoding to reject.
  if (s.length > MAX_PREVIEW_BYTES) return s.length;
  encoder ??= new TextEncoder();
  return encoder.encode(s).length;
}
