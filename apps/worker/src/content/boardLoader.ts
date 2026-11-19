// A design's board loader (docs/security.md#designs): the fixed Plinth page each artboard frame
// loads, at /__plinth/frames/design/board.html on the artifact's own origin. It receives the
// board's whole document from the design renderer (its parent, the shell) by postMessage and
// writes itself over with it, so author HTML runs under the default content CSP (inline script,
// eval, the CDN allowlist) at the board's exact size, never in the shell.
//
// The response carries the CSP `sandbox` directive without allow-same-origin in every isolation
// mode, and the renderer frames it with the same iframe sandbox: the board document always has an
// opaque origin (no cookies, no storage, no service workers, nothing of the shell or of a sibling
// board). That is why the loader checks only `event.source === parent`, not an origin: whatever a
// parent writes into it runs with no origin, as it would in an opaque frame of the parent's own
// making. It is served only behind this artifact's content pass (serve.ts, the "pass" reserved
// row), so a site that frames it without one gets the 401 text. Under origin isolation, for a view
// or capture pass, it keeps frame-ancestors ('self' and the app: the shell has the artifact's real
// origin there). Only under opaque isolation and for a preview pass does it go without, since an
// opaque shell and an MCP host's sandbox cannot be named by any source.
//
// Protocol (version 1). Every message is { source: BOARD_MESSAGE_SOURCE, v: 1, type }.
//   loader -> parent: { type: "ready" }               posted to "*" once, on load
//   parent -> loader: { type: "render", html }        from the parent window only, once; html a
//                                                     string of at most LIMITS.maxHtmlBytes bytes
//   loader -> parent: { type: "loaded" }              posted to "*" when the written document has
//                                                     loaded (its images and styles included)
// Board scripts run in the same window afterwards and can post anything to the parent, a forged
// "loaded" included: the renderer only counts it for print readiness, from that frame's window.
import {
  type ArtifactTypeDef,
  BOARD_MESSAGE_SOURCE,
  BOARD_PROTOCOL_VERSION,
  LIMITS,
} from "@plinth/shared";
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

/** The loader page, self-contained; the same bytes for every artifact on every instance. */
export function boardLoaderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Artboard</title>
</head>
<body>
<script>
/* Plinth board loader, protocol v${BOARD_PROTOCOL_VERSION}. Only active inside a frame. */
(function () {
  "use strict";
  if (window.parent === window) return;
  var SOURCE = ${JSON.stringify(BOARD_MESSAGE_SOURCE)};
  var VERSION = ${BOARD_PROTOCOL_VERSION};
  var MAX_BYTES = ${LIMITS.maxHtmlBytes};
  var parentWindow = window.parent;
  var done = false;

  function tooLarge(html) {
    // UTF-8 is never shorter than the UTF-16 length.
    if (html.length > MAX_BYTES) return true;
    return new TextEncoder().encode(html).length > MAX_BYTES;
  }

  function post(type) {
    try {
      parentWindow.postMessage({ source: SOURCE, v: VERSION, type: type }, "*");
    } catch (e) {
      // The parent is gone.
    }
  }

  function onMessage(event) {
    if (done || event.source !== parentWindow) return;
    var d = event.data;
    if (typeof d !== "object" || d === null) return;
    if (d.source !== SOURCE || d.v !== VERSION || d.type !== "render") return;
    if (typeof d.html !== "string" || tooLarge(d.html)) return;
    done = true;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(d.html);
    document.close();
    window.addEventListener("load", function () {
      post("loaded");
    }, { once: true });
  }

  window.addEventListener("message", onMessage);
  post("ready");
})();
</script>
</body>
</html>
`;
}

/**
 * The loader for a request that showed this artifact's content pass, only for an artifact whose
 * type frames it (renderer.frame with opaqueFrames). Default content script policy, the opaque
 * sandbox whatever the isolation mode, CORP cross-origin, and frame-ancestors as `framing` says
 * (serve.ts boardLoaderFraming: kept under origin isolation for view and capture passes).
 */
export function serveBoardLoader(
  request: Request,
  config: Config,
  def: ArtifactTypeDef,
  framing: "app" | "any",
): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyContentHeaders(config, headers, { framing, sandbox: true, opaqueReaders: true });
  if (!def.opaqueFrames) throw new Error(`Type ${def.id} has no opaque frames`);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(boardLoaderHtml(), { status: 200, headers });
}
