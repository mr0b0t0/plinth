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
//   parent -> loader: { type: "render", html, fluid? }
//                                                     from the parent window only, once; html a
//                                                     string of at most LIMITS.maxHtmlBytes bytes;
//                                                     fluid true for a board with height="auto"
//   loader -> parent: { type: "size", height }        a fluid board only: its content's height in
//                                                     CSS px (1 to DESIGN_LIMITS.maxAutoHeight),
//                                                     once before "loaded" and again whenever it
//                                                     changes
//   loader -> parent: { type: "loaded" }              posted to "*" when the written document has
//                                                     loaded (its images and styles included)
//   loader -> parent: { type: "goto", board }         a click on a link whose href is exactly
//                                                     #board=<id> (a prototype flow); the link is
//                                                     not followed
// Board scripts run in the same window afterwards and can post anything to the parent, a forged
// "loaded", "size" or "goto" included: the renderer only counts "loaded" for print readiness,
// keeps a size within the board's bounds, and follows a "goto" only from the board in use, from
// that frame's window. None of them reaches anything but the canvas's own view.
import {
  type ArtifactTypeDef,
  BOARD_ID_PATTERN,
  BOARD_LINK_PREFIX,
  BOARD_MESSAGE_SOURCE,
  BOARD_PROTOCOL_VERSION,
  DESIGN_LIMITS,
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
  var MAX_HEIGHT = ${DESIGN_LIMITS.maxAutoHeight};
  var LINK_PREFIX = ${JSON.stringify(BOARD_LINK_PREFIX)};
  var BOARD_ID = new RegExp(${JSON.stringify(BOARD_ID_PATTERN)});
  var parentWindow = window.parent;
  var done = false;

  function tooLarge(html) {
    // UTF-8 is never shorter than the UTF-16 length.
    if (html.length > MAX_BYTES) return true;
    return new TextEncoder().encode(html).length > MAX_BYTES;
  }

  function post(type, extra) {
    var m = { source: SOURCE, v: VERSION, type: type };
    if (extra) for (var k in extra) m[k] = extra[k];
    try {
      parentWindow.postMessage(m, "*");
    } catch (e) {
      // The parent is gone.
    }
  }

  // The board a clicked link names with an href of exactly #board=<id>, or null. Read from the
  // attribute, never the resolved URL: the board's <base> points elsewhere.
  function linkedBoard(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (!el || el.nodeType !== 1 || el.localName !== "a") continue;
      var href = el.getAttribute("href");
      if (href === null || href.indexOf(LINK_PREFIX) !== 0) return null;
      var id = href.slice(LINK_PREFIX.length);
      return BOARD_ID.test(id) ? id : null;
    }
    return null;
  }

  function followLinks() {
    window.addEventListener("click", function (event) {
      var id = linkedBoard(event);
      if (id === null) return;
      event.preventDefault();
      post("goto", { board: id });
    }, true);
  }

  // A fluid board's height: its content's, which its document leaves unsized.
  function measure() {
    var root = document.documentElement;
    var body = document.body;
    var h = Math.max(root ? root.getBoundingClientRect().height : 0, body ? body.scrollHeight : 0);
    return Math.max(1, Math.min(MAX_HEIGHT, Math.ceil(h)));
  }

  function watchHeight() {
    var last = 0;
    var queued = false;
    function report() {
      queued = false;
      var h = measure();
      if (h === last) return;
      last = h;
      post("size", { height: h });
    }
    function queue() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(report);
    }
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(queue);
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    return report;
  }

  function onMessage(event) {
    if (done || event.source !== parentWindow) return;
    var d = event.data;
    if (typeof d !== "object" || d === null) return;
    if (d.source !== SOURCE || d.v !== VERSION || d.type !== "render") return;
    if (typeof d.html !== "string" || tooLarge(d.html)) return;
    done = true;
    var fluid = d.fluid === true;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(d.html);
    document.close();
    // Listeners go on after document.open, which clears the window's.
    followLinks();
    var report = fluid ? watchHeight() : null;
    window.addEventListener("load", function () {
      if (report) report();
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
