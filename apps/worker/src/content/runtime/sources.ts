// The runtime's sources fragment: plinth.freshness and plinth.cite (docs/spec.md "Live data from
// the owner's agents"), a helper that shows next to a figure where it came from and how old it is,
// from the stamp the server put on its document (doc.source, mapped by the core's toDoc). It makes
// no request, so it works under opaque isolation too, on objects the page carries inline
// ({ source: { label, connector, fetched_at } }). Page code can draw any badge it likes, so a badge
// is never proof: the viewer bar's line, computed by the server, is. Text only, never markup.
import type { RuntimeFragment } from "./fragment.ts";

export const SOURCES_FRAGMENT: RuntimeFragment = {
  name: "sources",
  source: () => `  // ---------- citations: where each figure came from ----------

  var CITE_CLASS = "plinth-cite";
  var CITE_ATTR = "data-plinth-cite-badge";
  var CITE_STYLE =
    ".plinth-cite{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;" +
    "white-space:nowrap;vertical-align:super;margin-inline-start:.35em;padding:0 .45em;" +
    "border-radius:.7em;font:500 .68em/1.6 system-ui,-apple-system,sans-serif;color:inherit;" +
    "background:color-mix(in srgb,currentColor 9%,transparent);" +
    "border:1px solid color-mix(in srgb,currentColor 28%,transparent);cursor:help}" +
    ".plinth-cite:focus-visible{outline:2px solid currentColor;outline-offset:1px}" +
    ".plinth-cite--none{font-style:italic;opacity:.8}" +
    ".plinth-cite--stale{border-style:dashed}" +
    "@media (prefers-color-scheme:dark){.plinth-cite{background:color-mix(in srgb,currentColor 15%,transparent)}}";

  function sourceOf(doc) {
    var s = doc && typeof doc === "object" ? doc.source : null;
    return s && typeof s === "object" ? s : null;
  }
  function fetchedMs(s) {
    var v = s.fetchedAt !== undefined ? s.fetchedAt : s.fetched_at;
    var t = typeof v === "string" ? Date.parse(v) : NaN;
    return isFinite(t) ? t : null;
  }
  function ago(ms) {
    if (ms < 45000) return "just now";
    var m = Math.round(ms / 60000);
    if (m < 60) return m + " min ago";
    var h = Math.round(ms / 3600000);
    if (h < 24) return h + " h ago";
    var d = Math.round(ms / 86400000);
    return d <= 1 ? "yesterday" : d + " days ago";
  }
  function text(v) {
    return typeof v === "string" ? v : "";
  }
  function freshness(doc, opts) {
    var s = sourceOf(doc);
    var t = s ? fetchedMs(s) : null;
    if (t === null) return null;
    var age = Math.max(0, Date.now() - t);
    var after = opts && Number(opts.staleAfterMinutes) > 0 ? Number(opts.staleAfterMinutes) : 0;
    return {
      fetchedAt: new Date(t).toISOString(),
      ageMs: age,
      text: ago(age),
      stale: after > 0 && age > after * 60000,
    };
  }
  plinth.freshness = freshness;

  function citeStyle() {
    if (document.getElementById("plinth-cite-style")) return;
    var st = document.createElement("style");
    st.id = "plinth-cite-style";
    st.textContent = CITE_STYLE;
    (document.head || document.documentElement).appendChild(st);
  }
  function ownBadge(el) {
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute(CITE_ATTR) === "1") return kids[i];
    }
    return null;
  }
  function cite(el, doc, opts) {
    if (!el || typeof el.appendChild !== "function") {
      throw new PlinthError("invalid", "cite needs an element");
    }
    opts = opts || {};
    citeStyle();
    var badge = ownBadge(el);
    if (!badge) {
      badge = document.createElement("sup");
      badge.setAttribute(CITE_ATTR, "1");
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("role", "note");
      el.appendChild(badge);
    }
    var s = sourceOf(doc);
    var f = s ? freshness(doc, opts) : null;
    var field = typeof opts.field === "string" && opts.field ? " (" + opts.field + ")" : "";
    var label;
    if (s && f) {
      var connector = text(s.connector) || "a data source";
      var when = f.fetchedAt.slice(0, 16).replace("T", " ") + " UTC";
      badge.textContent = connector + " \\u00b7 " + f.text;
      label =
        (text(s.label) || "Figure") + field + ", from " + connector + ", fetched " + when +
        " by an agent of the owner" + (f.stale ? ", older than " + opts.staleAfterMinutes + " min" : "");
      badge.setAttribute("class", CITE_CLASS + (f.stale ? " " + CITE_CLASS + "--stale" : ""));
    } else {
      badge.textContent = "not fetched";
      label = "Figure" + field + " not fetched from a data source: someone typed or changed it";
      badge.setAttribute("class", CITE_CLASS + " " + CITE_CLASS + "--none");
    }
    badge.setAttribute("aria-label", label);
    badge.setAttribute("title", label);
    return badge;
  }
  /** Every [data-plinth-cite="collection/docId#field"] under root, from { collection: docs }. */
  cite.scan = function (root, docs) {
    root = root || document;
    docs = docs || {};
    var els = root.querySelectorAll ? root.querySelectorAll("[data-plinth-cite]") : [];
    var n = 0;
    for (var i = 0; i < els.length; i++) {
      var spec = String(els[i].getAttribute("data-plinth-cite") || "");
      var hash = spec.indexOf("#");
      var field = hash < 0 ? undefined : spec.slice(hash + 1);
      var path = hash < 0 ? spec : spec.slice(0, hash);
      var slash = path.indexOf("/");
      var list = slash > 0 ? docs[path.slice(0, slash)] : null;
      var id = slash > 0 ? path.slice(slash + 1) : "";
      var doc = null;
      if (list && typeof list.length === "number") {
        for (var j = 0; j < list.length; j++) if (list[j] && list[j].id === id) doc = list[j];
      }
      cite(els[i], doc, { field: field });
      n++;
    }
    return n;
  };
  /** Development aid: elements with a digit in their own text and no badge. */
  cite.missing = function (root) {
    root = root || document;
    var out = [];
    var els = root.querySelectorAll ? root.querySelectorAll("body *") : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tag = String(el.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "sup") continue;
      var own = "";
      var nodes = el.childNodes || [];
      for (var j = 0; j < nodes.length; j++) if (nodes[j].nodeType === 3) own += nodes[j].nodeValue;
      if (/[0-9]/.test(own) && !ownBadge(el)) out.push(el);
    }
    return out;
  };
  plinth.cite = cite;

`,
};
