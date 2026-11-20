// The runtime's page-comments fragment: plinth.comments (docs/spec.md "Comments from the page").
// A page that declares `comments` may open the app's comment composer with an anchor of its own
// and learn which threads are anchored where, so it can draw its own markers and say where an
// anchor is on screen. The page never posts a comment and never sees comment text: the app sends
// ids, pin numbers, status and anchors only, and the person writes and posts the comment.
//
// It talks to the app over the app channel (runtime/app.ts) with protocol v1 of
// packages/shared/src/pageComments.ts, and makes no request of its own. A page whose own
// <meta name="plinth-capabilities"> lists `comments` starts the channel as the runtime loads, so
// Plinth's pins for its threads (element anchors, and page anchors once it registers `locate`)
// work however late the page first calls plinth.comments, or if it never does. On any other page
// nothing is posted until the page first uses plinth.comments. Starting twice does nothing.
// Positions are measured again on scroll, resize, load and any change to the document's size
// (ResizeObserver), so pins follow the layout.
//
//   ready      Promise<{ available, reason }>, never rejects; reason null | "not_framed" |
//              "no_app" | "not_declared"
//   compose(anchor?) -> Promise<{ status: "posted", id } | { status: "closed" | "busy" }>;
//              rejects PlinthError "unavailable" or "invalid" (the anchor breaks the limits);
//              each request settles when the app answers it, a later one does not end it
//   onThreads(fn) -> off   fn([{ id, pin, status, anchor: { key, x?, y?, data? } }]), page
//              anchors only, oldest first; called at once with the latest list
//   locate(fn | null)      fn(anchor) -> { x, y } | { left, top, width, height } | null, in the
//              frame's viewport CSS pixels; without it Plinth draws no pin for page anchors
//   refresh()              things moved: run locate again (coalesced, at most 20 a second)
//   open(id) -> bool       show this thread in the app's panel
//   onFocus(fn) -> off     fn({ id, anchor }) when the person picks a page-anchored thread
import {
  CAPABILITIES_META,
  PAGE_COMMENT_LIMITS as L,
  PAGE_ANCHOR_DATA_KEY_RE,
  PAGE_ANCHOR_KEY_RE,
  PAGE_ANCHOR_UNSAFE_RE,
  PAGE_COMMENTS_SOURCE,
  PAGE_COMMENTS_VERSION,
} from "@plinth/shared";
import type { RuntimeFragment } from "./fragment.ts";

export const COMMENTS_FRAGMENT: RuntimeFragment = {
  name: "comments",
  usesAppChannel: true,
  source:
    () => `  // ---------- comments from the page: plinth.comments (the person writes every comment) ----------

  var CM_SOURCE = ${JSON.stringify(PAGE_COMMENTS_SOURCE)};
  var CM_V = ${PAGE_COMMENTS_VERSION};
  var CM_KEY_RE = /${PAGE_ANCHOR_KEY_RE.source}/;
  var CM_DATA_KEY_RE = /${PAGE_ANCHOR_DATA_KEY_RE.source}/;
  var CM_UNSAFE_RE = /${PAGE_ANCHOR_UNSAFE_RE.source}/${PAGE_ANCHOR_UNSAFE_RE.flags};
  var CM_MAX_TEXT = ${L.maxText};
  var CM_MAX_DATA_BYTES = ${L.maxDataBytes};
  var CM_MAX_DATA_KEYS = ${L.maxDataKeys};
  var CM_MAX_DATA_STRING = ${L.maxDataString};
  var CM_MAX_PAGE_COORD = ${L.maxPageCoord};
  var CM_MAX_THREADS = ${L.maxThreads};
  var CM_MAX_ID = ${L.maxId};
  var CM_MAX_COORD = ${L.maxCoord};
  var CM_READY_MS = ${L.readyTimeoutMs};
  var CM_MAX_PENDING = 16;
  var CM_POSITIONS_MS = ${Math.ceil(1000 / L.positionsPerSecond)};

  var cm = {
    started: false,
    available: false,
    readyDone: false,
    readyResolve: null,
    ready: null,
    threads: [],
    threadSubs: new Set(),
    focusSubs: new Set(),
    locator: null,
    // Compose requests the app has not answered yet, by request id, oldest first. The app answers
    // each one exactly once, and a later request does not end an earlier one: the app may refuse
    // the later one and keep the earlier anchor in the composer.
    pending: new Map(),
    lastPositions: null,
    lastPostAt: 0,
    posTimer: null,
    posFrame: false,
  };
  cm.ready = new Promise(function (r) {
    cm.readyResolve = r;
  });

  function cmFinish(reason) {
    if (cm.readyDone) return;
    cm.readyDone = true;
    cm.available = reason === null;
    cm.readyResolve({ available: cm.available, reason: reason });
  }
  function cmPost(msg) {
    msg.source = CM_SOURCE;
    msg.v = CM_V;
    return toApp(msg);
  }
  function cmIsObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function cmCoord(v) {
    return typeof v === "number" && isFinite(v) && v >= -CM_MAX_PAGE_COORD && v <= CM_MAX_PAGE_COORD;
  }
  function cmBytes(s) {
    return new TextEncoder().encode(s).length;
  }
  function cmFreeze(v) {
    if (typeof v === "object" && v !== null) {
      Object.keys(v).forEach(function (k) {
        cmFreeze(v[k]);
      });
      Object.freeze(v);
    }
    return v;
  }
  function cmCopy(v) {
    return cmFreeze(JSON.parse(JSON.stringify(v)));
  }

  // The same rules as pageAnchorSchema (packages/shared/src/schemas.ts), without kind. Returns a
  // clean copy, or null when the anchor breaks them.
  function cmAnchor(a) {
    if (!cmIsObject(a)) return null;
    var out = {};
    var keys = Object.keys(a);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = a[k];
      // An optional field set to undefined is an absent one, as for the schema.
      if (v === undefined && (k === "x" || k === "y" || k === "text" || k === "data")) continue;
      if (k === "key") {
        if (typeof v !== "string" || !CM_KEY_RE.test(v)) return null;
      } else if (k === "x" || k === "y") {
        if (!cmCoord(v)) return null;
      } else if (k === "text") {
        if (typeof v !== "string" || v.length > CM_MAX_TEXT || CM_UNSAFE_RE.test(v)) return null;
      } else if (k === "data") {
        if (!cmIsObject(v)) return null;
        var dk = Object.keys(v);
        if (dk.length > CM_MAX_DATA_KEYS) return null;
        var data = {};
        for (var j = 0; j < dk.length; j++) {
          var d = v[dk[j]];
          if (!CM_DATA_KEY_RE.test(dk[j])) return null;
          var ok =
            d === null ||
            typeof d === "boolean" ||
            (typeof d === "number" && isFinite(d)) ||
            (typeof d === "string" && d.length <= CM_MAX_DATA_STRING && !CM_UNSAFE_RE.test(d));
          if (!ok) return null;
          data[dk[j]] = d;
        }
        if (cmBytes(JSON.stringify(data)) > CM_MAX_DATA_BYTES) return null;
        v = data;
      } else return null;
      out[k] = v;
    }
    return typeof out.key === "string" ? out : null;
  }

  // A thread as the app sent it: { id, pin, status, anchor }, the anchor a page anchor
  // ({ kind: "page", key, x?, y?, data? }) or an element ({ kind: "element", selector }).
  function cmThread(t) {
    if (!cmIsObject(t) || !cmIsObject(t.anchor)) return null;
    if (typeof t.id !== "string" || !t.id || t.id.length > CM_MAX_ID) return null;
    if (typeof t.pin !== "number" || !(t.pin >= 1) || Math.floor(t.pin) !== t.pin) return null;
    if (t.status !== "open" && t.status !== "resolved") return null;
    var a = t.anchor;
    if (a.kind === "element") {
      if (typeof a.selector !== "string" || !a.selector || a.selector.length > 1000) return null;
      return { id: t.id, pin: t.pin, status: t.status, element: a.selector };
    }
    if (a.kind !== "page") return null;
    var anchor = {};
    if (typeof a.key !== "string" || !CM_KEY_RE.test(a.key)) return null;
    anchor.key = a.key;
    if (cmCoord(a.x)) anchor.x = a.x;
    if (cmCoord(a.y)) anchor.y = a.y;
    if (cmIsObject(a.data)) anchor.data = a.data;
    return { id: t.id, pin: t.pin, status: t.status, anchor: cmCopy(anchor) };
  }

  function cmPageThreads() {
    var out = [];
    cm.threads.forEach(function (t) {
      if (t.anchor) out.push({ id: t.id, pin: t.pin, status: t.status, anchor: t.anchor });
    });
    return cmCopy(out);
  }
  function cmTellThreads(fn) {
    try {
      fn(cmPageThreads());
    } catch (e) {}
  }

  // ---------- positions: where each open anchored thread is, for the app's pins ----------

  function cmBox(r, vw, vh) {
    var n = [r.left, r.top, r.width, r.height];
    for (var i = 0; i < 4; i++) {
      if (typeof n[i] !== "number" || !isFinite(n[i]) || Math.abs(n[i]) > CM_MAX_COORD) return null;
    }
    if (r.width < 0 || r.height < 0) return null;
    var visible = r.left <= vw && r.top <= vh && r.left + r.width >= 0 && r.top + r.height >= 0;
    return { left: r.left, top: r.top, width: r.width, height: r.height, visible: visible };
  }
  function cmLocate(t) {
    if (t.element) {
      var el = null;
      try {
        el = document.querySelector(t.element);
      } catch (e) {
        el = null;
      }
      if (!el) return null;
      var b = el.getBoundingClientRect();
      if (!(b.width > 0 && b.height > 0)) return null;
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    }
    if (typeof cm.locator !== "function") return null;
    var r;
    try {
      r = cm.locator(t.anchor);
    } catch (e) {
      return null;
    }
    if (!cmIsObject(r)) return null;
    if (r.left === undefined && r.top === undefined) return { left: r.x, top: r.y, width: 0, height: 0 };
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function cmPositions() {
    cm.posTimer = null;
    cm.posFrame = false;
    if (!cm.available) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var items = [];
    cm.threads.forEach(function (t) {
      if (t.status !== "open") return;
      var r = cmLocate(t);
      var box = r && cmBox(r, vw, vh);
      items.push(box ? Object.assign({ id: t.id }, box) : { id: t.id, left: 0, top: 0, width: 0, height: 0, visible: false });
    });
    var json = JSON.stringify(items);
    if (json === cm.lastPositions) return;
    cm.lastPositions = json;
    cm.lastPostAt = Date.now();
    cmPost({ type: "positions", items: items });
  }
  // Coalesced to one run per animation frame, and at most 20 posts a second.
  function cmSchedule() {
    if (!cm.available || cm.posTimer !== null || cm.posFrame) return;
    var wait = Math.max(0, cm.lastPostAt + CM_POSITIONS_MS - Date.now());
    var run = function () {
      cm.posTimer = null;
      if (typeof window.requestAnimationFrame === "function") {
        cm.posFrame = true;
        window.requestAnimationFrame(cmPositions);
      } else cmPositions();
    };
    if (wait > 0) cm.posTimer = setTimeout(run, wait);
    else run();
  }
  var cmScrollPending = false;
  function cmOnScroll() {
    if (cmScrollPending) return;
    cmScrollPending = true;
    setTimeout(function () {
      cmScrollPending = false;
      cmSchedule();
    }, 100);
  }

  // ---------- messages from the app ----------

  function cmFromApp(m) {
    if (m.v !== CM_V) return;
    if (m.type === "welcome") {
      if (typeof m.available !== "boolean") return;
      cmFinish(m.available ? null : "not_declared");
    } else if (m.type === "threads") {
      if (!cm.available || !Array.isArray(m.items) || m.items.length > CM_MAX_THREADS) return;
      var list = [];
      for (var i = 0; i < m.items.length; i++) {
        var t = cmThread(m.items[i]);
        if (t) list.push(t);
      }
      cm.threads = list;
      cm.threadSubs.forEach(cmTellThreads);
      cm.lastPositions = null;
      cmSchedule();
    } else if (m.type === "composed") {
      if (typeof m.req !== "string") return;
      var resolve = cm.pending.get(m.req);
      if (!resolve) return;
      if (m.status === "posted" && typeof m.id === "string" && m.id && m.id.length <= CM_MAX_ID) {
        cm.pending.delete(m.req);
        resolve({ status: "posted", id: m.id });
      } else if (m.status === "closed" || m.status === "busy") {
        cm.pending.delete(m.req);
        resolve({ status: m.status });
      }
    } else if (m.type === "focus") {
      var found = null;
      cm.threads.forEach(function (t) {
        if (t.id === m.id && t.anchor) found = t;
      });
      if (!found) return;
      var info = cmCopy({ id: found.id, anchor: found.anchor });
      cm.focusSubs.forEach(function (fn) {
        try {
          fn(info);
        } catch (e) {}
      });
    }
  }

  function cmStart() {
    if (cm.started) return;
    cm.started = true;
    if (!framed) {
      cmFinish("not_framed");
      return;
    }
    onApp(CM_SOURCE, cmFromApp);
    window.addEventListener("scroll", cmOnScroll, true);
    window.addEventListener("resize", cmOnScroll);
    // Images, fonts and late scripts move things after the first measure, and so does any layout
    // change that resizes the document: measure again (posted only when something moved).
    window.addEventListener("load", cmOnScroll);
    if (typeof window.ResizeObserver === "function") {
      try {
        new window.ResizeObserver(cmOnScroll).observe(document.documentElement);
      } catch (e) {}
    }
    // Said again while unanswered, in case the app was not listening yet.
    var hellos = 0;
    var hello = function () {
      if (cm.readyDone) return;
      if (hellos++ >= 3) return cmFinish("no_app");
      cmPost({ type: "hello" });
      setTimeout(hello, CM_READY_MS / 3);
    };
    hello();
  }

  function cmReqId() {
    var abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var bytes = new Uint8Array(22);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += abc[bytes[i] & 63];
    return s;
  }

  plinth.comments = {
    get ready() {
      cmStart();
      return cm.ready;
    },
    compose: function (anchor) {
      cmStart();
      var clean = null;
      if (anchor !== undefined) {
        clean = cmAnchor(anchor);
        if (!clean) return Promise.reject(new PlinthError("invalid", "The anchor breaks the page anchor rules"));
      }
      return cm.ready.then(function (s) {
        if (!s.available) throw new PlinthError("unavailable", "Comments from the page are not available (" + s.reason + ").");
        // Bounded, should an app never answer: the oldest unanswered request ends closed.
        if (cm.pending.size >= CM_MAX_PENDING) {
          var oldest = cm.pending.keys().next().value;
          var end = cm.pending.get(oldest);
          cm.pending.delete(oldest);
          end({ status: "closed" });
        }
        return new Promise(function (resolve) {
          var req = cmReqId();
          cm.pending.set(req, resolve);
          var msg = { type: "compose", req: req };
          if (clean) msg.anchor = clean;
          cmPost(msg);
        });
      });
    },
    onThreads: function (fn) {
      if (typeof fn !== "function") throw new PlinthError("invalid", "onThreads takes a function");
      cmStart();
      cm.threadSubs.add(fn);
      cmTellThreads(fn);
      return function () {
        cm.threadSubs.delete(fn);
      };
    },
    locate: function (fn) {
      if (fn !== null && typeof fn !== "function") throw new PlinthError("invalid", "locate takes a function or null");
      cmStart();
      cm.locator = fn;
      cm.lastPositions = null;
      cmSchedule();
    },
    refresh: function () {
      cmStart();
      cmSchedule();
    },
    open: function (id) {
      cmStart();
      if (!cm.available || typeof id !== "string") return false;
      var known = cm.threads.some(function (t) {
        return t.id === id;
      });
      return known && cmPost({ type: "open", id: id });
    },
    onFocus: function (fn) {
      if (typeof fn !== "function") throw new PlinthError("invalid", "onFocus takes a function");
      cmStart();
      cm.focusSubs.add(fn);
      return function () {
        cm.focusSubs.delete(fn);
      };
    },
  };

  // A page that declares comments starts at once: Plinth hides "Pin to an element" and skips
  // review mode for it, so its threads' pins depend on this channel. The first meta with the name
  // counts, as on the server; the app's answer still decides whether anything is available.
  function cmDeclared() {
    try {
      var metas = document.getElementsByTagName("meta");
      for (var i = 0; i < metas.length; i++) {
        var name = String(metas[i].getAttribute("name") || "").trim().toLowerCase();
        if (name !== ${JSON.stringify(CAPABILITIES_META)}) continue;
        var tokens = String(metas[i].getAttribute("content") || "").toLowerCase().split(/[\\s,]+/);
        return tokens.indexOf("comments") >= 0;
      }
    } catch (e) {}
    return false;
  }
  function cmAutoStart() {
    if (!cm.started && cmDeclared()) cmStart();
  }
  cmAutoStart();
  // The script may run in <head> before the meta is parsed.
  if (!cm.started && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", cmAutoStart);
  }

`,
};
