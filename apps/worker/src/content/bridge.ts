// Review-mode bridge for anchoring comments to elements.
//
// Injected only when an HTML file on a content host is requested with ?plinth-review=1. The script
// talks to the app by postMessage with strict origin checks on both sides: it accepts messages only
// from the app origin and from its parent window, and posts only to the app origin.
//
// The script runs in the artifact's own origin, next to the artifact's scripts. Those scripts can
// also post messages to the parent that look exactly like the bridge's, and can tamper with the
// bridge itself. The app must therefore treat every message from the frame as untrusted data:
// validate shapes and sizes, never render it as HTML, and never act on it beyond positioning pins
// and prefilling an anchor the person then confirms.
//
// Protocol (version 1). Every message is an object { source: BRIDGE_MESSAGE_SOURCE, v: 1, type, ... }.
//   app -> frame: { type: "pick:start" } | { type: "pick:stop" }
//                 | { type: "highlight", anchors: [{ id, selector }] }
//   frame -> app: { type: "ready" }
//                 | { type: "pick", anchor: { selector, text, x, y } }
//                 | { type: "positions", items: [{ id, top, left, width, height, visible }] }
import { BRIDGE_MESSAGE_SOURCE, CONTENT_RESERVED_PREFIX } from "@plinth/shared";
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

export const BRIDGE_PROTOCOL_VERSION = 1;

/** The bridge script, self-contained, with the app origin embedded as a JSON string. */
export function bridgeScriptSource(config: Config): string {
  return `/* Plinth review bridge, protocol v${BRIDGE_PROTOCOL_VERSION}. Only active inside a frame. */
(function () {
  "use strict";
  if (window.parent === window) return;
  // Artifact scripts share this origin and can post to the parent too, so the app treats every
  // message from this frame as untrusted data.
  var APP_ORIGIN = ${JSON.stringify(config.appOrigin)};
  var SOURCE = ${JSON.stringify(BRIDGE_MESSAGE_SOURCE)};
  var VERSION = ${BRIDGE_PROTOCOL_VERSION};
  var MAX_SELECTOR = 1000;
  var MAX_TEXT = 120;
  var MAX_ANCHORS = 500;
  var parentWindow = window.parent;

  function send(msg) {
    msg.source = SOURCE;
    msg.v = VERSION;
    parentWindow.postMessage(msg, APP_ORIGIN);
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\\\" + c;
    });
  }

  function uniqueId(el) {
    if (!el.id) return null;
    var sel = "#" + cssEscape(el.id);
    try {
      return document.querySelectorAll(sel).length === 1 ? sel : null;
    } catch (e) {
      return null;
    }
  }

  // A robust CSS path: the nearest ancestor (or the element) with a unique id, then tag and
  // :nth-of-type steps down to the element.
  function selectorFor(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var idSel = uniqueId(node);
      if (idSel) {
        parts.unshift(idSel);
        break;
      }
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      var index = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) index++;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = parent;
    }
    // Too long for an anchor: drop leading steps. The rest is still a valid, if looser, selector.
    while (parts.length > 1 && parts.join(" > ").length > MAX_SELECTOR) parts.shift();
    return parts.join(" > ").slice(0, MAX_SELECTOR);
  }

  function textOf(el) {
    var t = el.innerText || el.textContent || "";
    return String(t).replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  function clamp01(n) {
    if (!(n >= 0)) return 0;
    return n > 1 ? 1 : Math.round(n * 10000) / 10000;
  }

  // ---------- pick mode ----------

  var picking = false;
  var outline = null;

  function showOutline(el) {
    if (!document.body) return;
    if (!outline) {
      outline = document.createElement("div");
      outline.setAttribute("data-plinth-bridge", "outline");
      var s = outline.style;
      s.position = "fixed";
      s.pointerEvents = "none";
      s.zIndex = "2147483647";
      s.border = "2px solid #2f7d6d";
      s.background = "rgba(47, 125, 109, 0.08)";
      s.borderRadius = "2px";
      s.boxSizing = "border-box";
      s.margin = "0";
      s.padding = "0";
    }
    if (outline.parentNode !== document.body) document.body.appendChild(outline);
    var r = el.getBoundingClientRect();
    outline.style.top = r.top + "px";
    outline.style.left = r.left + "px";
    outline.style.width = r.width + "px";
    outline.style.height = r.height + "px";
    outline.style.display = "block";
  }

  function hideOutline() {
    if (outline) outline.style.display = "none";
  }

  function targetOf(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === outline) return null;
    return el;
  }

  function onMove(e) {
    if (!picking) return;
    var el = targetOf(e);
    if (el) showOutline(el);
  }

  function swallow(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!picking) return;
    swallow(e);
    var el = targetOf(e);
    if (!el) return;
    var r = el.getBoundingClientRect();
    var x = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
    var y = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
    stopPicking();
    send({
      type: "pick",
      anchor: { selector: selectorFor(el), text: textOf(el), x: clamp01(x), y: clamp01(y) },
    });
  }

  function startPicking() {
    picking = true;
    if (document.documentElement) document.documentElement.style.cursor = "crosshair";
  }

  function stopPicking() {
    picking = false;
    hideOutline();
    if (document.documentElement) document.documentElement.style.cursor = "";
  }

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu"].forEach(
    function (type) {
      window.addEventListener(type, swallow, true);
    },
  );

  // ---------- highlight and positions ----------

  var anchors = [];

  function positions() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var items = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var el = null;
      try {
        el = document.querySelector(a.selector);
      } catch (e) {
        el = null;
      }
      if (!el) {
        items.push({ id: a.id, top: 0, left: 0, width: 0, height: 0, visible: false });
        continue;
      }
      var r = el.getBoundingClientRect();
      var visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      items.push({ id: a.id, top: r.top, left: r.left, width: r.width, height: r.height, visible: visible });
    }
    send({ type: "positions", items: items });
  }

  var pending = false;
  function schedulePositions() {
    if (pending || anchors.length === 0) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      positions();
    }, 100);
  }

  window.addEventListener("scroll", schedulePositions, true);
  window.addEventListener("resize", schedulePositions);
  window.addEventListener("load", schedulePositions);

  // ---------- messages from the app ----------

  window.addEventListener("message", function (e) {
    if (e.origin !== APP_ORIGIN || e.source !== parentWindow) return;
    var d = e.data;
    if (!d || typeof d !== "object" || d.source !== SOURCE || d.v !== VERSION) return;
    if (d.type === "pick:start") startPicking();
    else if (d.type === "pick:stop") stopPicking();
    else if (d.type === "highlight") {
      var list = Array.isArray(d.anchors) ? d.anchors.slice(0, MAX_ANCHORS) : [];
      anchors = [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || typeof a.selector !== "string" || a.selector.length > MAX_SELECTOR) continue;
        if (typeof a.id !== "string" && typeof a.id !== "number") continue;
        anchors.push({ id: a.id, selector: a.selector });
      }
      positions();
    }
  });

  function ready() {
    send({ type: "ready" });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
`;
}

export function serveBridgeScript(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/javascript; charset=utf-8" });
  applyContentHeaders(config, headers);
  headers.set("Cache-Control", "no-cache");
  return new Response(bridgeScriptSource(config), { status: 200, headers });
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Add the bridge <script> to an HTML response: at the end of <head>, or at the end of the document
 * when there is no <head> tag. `base` is "" on an artifact subdomain, or the path prefix in the
 * staging path fallback.
 */
export function injectBridge(_config: Config, res: Response, base: string): Response {
  const src = escapeAttr(`${base}${CONTENT_RESERVED_PREFIX}bridge.js`);
  const tag = `<script src="${src}" data-plinth-bridge></script>`;
  let injected = false;
  let sawHead = false;
  const out = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (sawHead) return;
        sawHead = true;
        // Before </head> if it is written out; otherwise the document end below adds the tag.
        el.onEndTag((endTag) => {
          if (injected) return;
          injected = true;
          endTag.before(tag, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (!injected) {
          injected = true;
          end.append(tag, { html: true });
        }
      },
    })
    .transform(res);
  // The body differs from the plain file, so the stored file's ETag no longer describes it.
  const headers = new Headers(out.headers);
  headers.delete("ETag");
  headers.delete("Content-Length");
  return new Response(out.body, { status: out.status, headers });
}
