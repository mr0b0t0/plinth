// Editor preview loader. A static page on the artifact's own subdomain that receives the editor's
// draft HTML from the app by postMessage and renders it under the content CSP, so the preview runs
// exactly like the published artifact: same origin, same CSP, same sandboxed frame.
//
// It holds no artifact data, so it is served before the content cookie check (serve.ts). The
// draft's own asset requests still need the cookie: the editor opens the frame through a one-time
// enter link whose `next` is this page.
//
// Protocol (version 2). Every message is an object { source: PREVIEW_MESSAGE_SOURCE, v: 2, type }.
//   The app opens the loader at a URL ending in #plinth-preview=<nonce>, a fresh value per frame.
//   loader -> app: { type: "ready", nonce }, posted to the app origin only
//   app -> loader: { type: "render", html }, accepted only from the app origin and the parent
//                  window, html a string of at most LIMITS.maxHtmlBytes bytes (UTF-8)
// The nonce lets the app tell this loader from any other document in the frame. That matters
// under opaque isolation, where the loader's origin is "null" and the app must post the draft to
// "*" (apps/web/src/components/editor/previewProtocol.ts). The app's own origin is a real origin
// in every mode, so the loader's checks stay exact.
// On "render" the loader points its URL at the artifact root (so relative URLs in the draft resolve
// as they do on the published page, and the nonce leaves the URL), then replaces itself with the
// HTML (document.open/write/close). That removes the loader and its listener: the app opens a new
// frame for each new render.
import { CONTENT_RESERVED_PREFIX, LIMITS } from "@plinth/shared";
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

export const PREVIEW_MESSAGE_SOURCE = "plinth-preview";
export const PREVIEW_PROTOCOL_VERSION = 2;
export const PREVIEW_LOADER_PATH = `${CONTENT_RESERVED_PREFIX}preview`;
/** Fragment key for the frame's nonce: #plinth-preview=<nonce>. */
export const PREVIEW_NONCE_KEY = "plinth-preview";

/** The loader page, self-contained, with the app origin embedded as a JSON string. */
export function previewLoaderHtml(config: Config): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview</title>
</head>
<body>
<script>
/* Plinth editor preview loader, protocol v${PREVIEW_PROTOCOL_VERSION}. Only active inside a frame. */
(function () {
  "use strict";
  if (window.parent === window) return;
  var APP_ORIGIN = ${JSON.stringify(config.appOrigin)};
  var SOURCE = ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)};
  var VERSION = ${PREVIEW_PROTOCOL_VERSION};
  var MAX_BYTES = ${LIMITS.maxHtmlBytes};
  var LOADER_PATH = ${JSON.stringify(PREVIEW_LOADER_PATH.slice(1))};
  var NONCE_PREFIX = ${JSON.stringify(`#${PREVIEW_NONCE_KEY}=`)};
  var parentWindow = window.parent;
  var rendered = false;
  var hash = String(window.location.hash || "");
  var nonce = hash.indexOf(NONCE_PREFIX) === 0 ? hash.slice(NONCE_PREFIX.length) : "";
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return;

  function tooLarge(html) {
    // UTF-8 is never shorter than the UTF-16 length.
    if (html.length > MAX_BYTES) return true;
    return new TextEncoder().encode(html).length > MAX_BYTES;
  }

  function onMessage(event) {
    if (rendered) return;
    if (event.origin !== APP_ORIGIN || event.source !== parentWindow) return;
    var d = event.data;
    if (typeof d !== "object" || d === null) return;
    if (d.source !== SOURCE || d.v !== VERSION || d.type !== "render") return;
    if (typeof d.html !== "string" || tooLarge(d.html)) return;
    rendered = true;
    window.removeEventListener("message", onMessage);
    // The artifact root: "/" on its own subdomain, "/__content/<id>/" in the path fallback.
    var path = window.location.pathname;
    var root =
      path.slice(-LOADER_PATH.length) === LOADER_PATH
        ? path.slice(0, path.length - LOADER_PATH.length)
        : "/";
    try {
      window.history.replaceState(null, "", root);
    } catch (e) {
      // Relative URLs then resolve against the loader's path; the draft still renders.
    }
    document.open();
    document.write(d.html);
    document.close();
  }

  window.addEventListener("message", onMessage);
  parentWindow.postMessage({ source: SOURCE, v: VERSION, type: "ready", nonce: nonce }, APP_ORIGIN);
})();
</script>
</body>
</html>
`;
}

export function servePreviewLoader(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyContentHeaders(config, headers);
  return new Response(previewLoaderHtml(config), { status: 200, headers });
}
