// An HTML deck's embed loader (docs/security.md#html-decks): the fixed Plinth page each <x-embed>
// frame loads, at /__plinth/frames/slides/embed.html on the artifact's own origin. It receives the
// embed's small page from the slides renderer (its parent, the deck's shell) by postMessage and
// writes itself over with it, so the only author script a deck runs runs here, never in the shell.
//
// The page has its own CSP, stricter than any artifact's: inline script and styles, images, fonts
// and media only as data: or blob: URLs, and nothing from the network at all (no connect, no
// frames, no forms, no base). The response carries the CSP `sandbox` directive with allow-scripts
// only, in every isolation mode, and the renderer frames it with the same iframe sandbox: the
// embed has an opaque origin (no cookies, no storage, no service workers, nothing of the shell,
// the app or another embed), cannot open popups or navigate any other frame, and takes no clicks
// or keys (the renderer sets pointer-events: none on its frame). That is why the loader checks only
// `event.source === parent`: whatever a parent writes into it runs with no origin and no network.
// Like a design's board loader it is served only behind this artifact's content pass, and keeps
// frame-ancestors under origin isolation for view and capture passes (serve.ts boardLoaderFraming).
//
// Protocol: SLIDE_EMBED_* in packages/shared/src/slidesHtml.ts.
import {
  HTML_DECK_LIMITS,
  SLIDE_EMBED_MESSAGE_SOURCE,
  SLIDE_EMBED_PROTOCOL_VERSION,
} from "@plinth/shared";
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

/** The loader page, self-contained; the same bytes for every artifact on every instance. */
export function embedLoaderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Embed</title>
</head>
<body>
<script>
/* Plinth slide embed loader, protocol v${SLIDE_EMBED_PROTOCOL_VERSION}. Only active inside a frame. */
(function () {
  "use strict";
  if (window.parent === window) return;
  var SOURCE = ${JSON.stringify(SLIDE_EMBED_MESSAGE_SOURCE)};
  var VERSION = ${SLIDE_EMBED_PROTOCOL_VERSION};
  var MAX_BYTES = ${HTML_DECK_LIMITS.maxEmbedBytes};
  var parentWindow = window.parent;
  var done = false;

  function tooLarge(html) {
    if (html.length > MAX_BYTES) return true;
    return new TextEncoder().encode(html).length > MAX_BYTES;
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
  }

  window.addEventListener("message", onMessage);
  try {
    parentWindow.postMessage({ source: SOURCE, v: VERSION, type: "ready" }, "*");
  } catch (e) {
    // The parent is gone.
  }
})();
</script>
</body>
</html>
`;
}

/**
 * The embed loader's CSP: inline script and styles, data: and blob: media, and no network at all.
 * `framing` as for a design's board loader.
 */
export function embedLoaderCsp(config: Pick<Config, "appOrigin">, framing: "app" | "any"): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (framing !== "any") directives.push(`frame-ancestors 'self' ${config.appOrigin}`);
  directives.push("sandbox allow-scripts");
  return directives.join("; ");
}

/** The loader, for a request that showed this artifact's content pass on a deck. */
export function serveEmbedLoader(
  request: Request,
  config: Config,
  framing: "app" | "any",
): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  applyContentHeaders(config, headers, { framing, sandbox: true });
  headers.set("Content-Security-Policy", embedLoaderCsp(config, framing));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(embedLoaderHtml(), { status: 200, headers });
}
