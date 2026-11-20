// The runtime's version fragment (docs/spec.md "Live views", keeping state across versions): a page
// that loads /__plinth/runtime.js keeps its scroll position, its place inside the artifact (sub-page,
// query and hash) and any state it hands over when the app replaces it with a newer version.
// It needs no declaration and uses no server API.
//
//   plinth.onVersion(fn) -> off   fn({ from, to, force }) before a newer version replaces the page;
//                                 return false to keep the page until the viewer chooses Update
//                                 (ignored when force), { state } to hand JSON to the next version,
//                                 or nothing; a promise of either. 800 ms for all handlers together.
//   plinth.carried                { from, to, state } in the version that replaced the one before
//                                 (state null when none was handed over), read once; else null
//
// Messages, on the app channel (runtime/app.ts), source "plinth-view", v 1:
//   page -> app  { type: "hello" }                       once, when framed: this frame can answer
//   app -> page  { type: "update", from, to, nonce, force }
//   page -> app  { type: "update:ok", nonce, path }      carry recorded; path = where the page is,
//                                                        without the hash (it stays in the record)
//   page -> app  { type: "update:hold", nonce }          a handler returned false (never when force)
//
// The carry record lives in this content origin's sessionStorage (`__plinth_carry`): one tab, one
// artifact, never the app, another artifact or another viewer. It holds { from, to, at, scroll,
// path, hash, state }, state only when its JSON is at most 16 KiB. The next version's runtime reads
// and removes it at start, before the page's own scripts after the runtime tag run, ignores it when
// older than 30 s or when its frame is not the one the app loaded version `to` in (the app names
// each frame `plinth-v<n>`, VIEW_FRAME_NAME_PREFIX; a reload or sub-page of the old frame keeps the
// old frame's name), puts the hash back (history.replaceState, no navigation) when it landed on the
// same path and has no hash of its own, and, on the same path, scrolls to the recorded place after
// `load` and one animation frame. The gate lands a path the new version lacks on its root
// (`carried=1`); state still crosses, the scroll does not. The hash never goes to the app: it becomes part of no request URL, so state a
// page keeps in its fragment stays in the viewer's browser.
// Page script can forge an `update` on its own window: the worst it does is make the page record
// its own state. Under opaque isolation (origin "null") there is no storage and none of this runs.
import { LIVE_VIEW_LIMITS, VIEW_CARRY_KEY, VIEW_FRAME_NAME_PREFIX } from "@plinth/shared";
import type { RuntimeFragment } from "./fragment.ts";

export const VERSION_FRAGMENT: RuntimeFragment = {
  name: "version",
  usesAppChannel: true,
  source:
    () => `  // ---------- live views: new versions, and the state a page carries to the next ----------

  var CARRY_KEY = ${JSON.stringify(VIEW_CARRY_KEY)};
  var CARRY_MAX_BYTES = ${LIVE_VIEW_LIMITS.carryMaxBytes};
  var CARRY_MAX_AGE_MS = ${LIVE_VIEW_LIMITS.carryMaxAgeS * 1000};
  var VERSION_BUDGET_MS = ${LIVE_VIEW_LIMITS.versionBudgetMs};
  var FRAME_NAME_PREFIX = ${JSON.stringify(VIEW_FRAME_NAME_PREFIX)};
  var VIEW_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
  var versionHandlers = new Set();
  var carryStore = null;
  if (!opaque && framed) {
    try {
      carryStore = window.sessionStorage || null;
    } catch (e) {
      carryStore = null;
    }
  }

  function versionInt(n) {
    return typeof n === "number" && Number.isInteger(n) && n >= 1 && n < 2147483648;
  }

  // The version the app loaded this frame for (it names the frame), or null.
  function frameVersion() {
    var name = null;
    try {
      name = window.name;
    } catch (e) {
      return null;
    }
    if (typeof name !== "string" || name.indexOf(FRAME_NAME_PREFIX) !== 0) return null;
    var digits = name.slice(FRAME_NAME_PREFIX.length);
    if (!/^[1-9][0-9]{0,9}$/.test(digits)) return null;
    var n = Number(digits);
    return versionInt(n) ? n : null;
  }

  function finiteOr0(n) {
    return typeof n === "number" && isFinite(n) ? n : 0;
  }

  // Where the page is, without the hash: this is what the app is told and puts in request URLs.
  function pagePath() {
    try {
      var l = window.location;
      return l.pathname + l.search;
    } catch (e) {
      return null;
    }
  }

  function pageHash() {
    try {
      var h = window.location.hash;
      return typeof h === "string" && h.length > 1 ? h : null;
    } catch (e) {
      return null;
    }
  }

  function samePath(a, b) {
    var root = function (p) {
      return p === "/index.html" ? "/" : p;
    };
    return typeof a === "string" && typeof b === "string" && root(a) === root(b);
  }

  // The fragment the page had, back on the same page (before the page's own scripts read it).
  function restoreHash(rec) {
    var h = rec.hash;
    if (typeof h !== "string" || h.length < 2 || h.length > 2048 || h.charAt(0) !== "#") return;
    if (pageHash() !== null || !samePath(rec.path, pagePath())) return;
    try {
      var hist = window.history;
      if (hist && typeof hist.replaceState === "function") hist.replaceState(hist.state, "", h);
    } catch (e) {}
  }

  function restoreScroll(x, y) {
    var go = function () {
      var run = function () {
        try {
          window.scrollTo(x, y);
        } catch (e) {}
      };
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
      else run();
    };
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
  }

  function takeCarried() {
    if (!carryStore) return null;
    var raw = null;
    try {
      raw = carryStore.getItem(CARRY_KEY);
      if (raw !== null) carryStore.removeItem(CARRY_KEY);
    } catch (e) {
      return null;
    }
    if (raw === null) return null;
    var rec = null;
    try {
      rec = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!rec || typeof rec !== "object" || typeof rec.at !== "number") return null;
    var age = Date.now() - rec.at;
    if (!(age >= 0 && age <= CARRY_MAX_AGE_MS)) return null;
    if (!versionInt(rec.from) || !versionInt(rec.to)) return null;
    // Only in the update it was written for: the frame the app loaded version "to" in.
    if (rec.to !== frameVersion()) return null;
    restoreHash(rec);
    // Only on the same page: a place the new version lacks lands on its root, at the top.
    if (rec.scroll && typeof rec.scroll === "object" && samePath(rec.path, pagePath())) {
      var x = finiteOr0(rec.scroll.x);
      var y = finiteOr0(rec.scroll.y);
      if (x !== 0 || y !== 0) restoreScroll(x, y);
    }
    return { from: rec.from, to: rec.to, state: rec.state === undefined ? null : rec.state };
  }

  function carryState(state) {
    if (state === undefined) return null;
    try {
      var json = JSON.stringify(state);
      if (json === undefined) return null;
      var bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(json).length : json.length * 3;
      return bytes <= CARRY_MAX_BYTES ? JSON.parse(json) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCarry(info, state) {
    if (!carryStore) return;
    var rec = {
      from: info.from,
      to: info.to,
      at: Date.now(),
      scroll: { x: finiteOr0(window.scrollX), y: finiteOr0(window.scrollY) },
      path: pagePath(),
      hash: pageHash(),
      state: carryState(state),
    };
    try {
      carryStore.setItem(CARRY_KEY, JSON.stringify(rec));
    } catch (e) {}
  }

  function askVersionHandlers(info) {
    var answers = [];
    versionHandlers.forEach(function (fn) {
      var r;
      try {
        r = fn(info);
      } catch (e) {
        r = undefined;
      }
      answers.push(
        Promise.resolve(r).then(
          function (v) {
            return v;
          },
          function () {
            return undefined;
          },
        ),
      );
    });
    var timer = null;
    var late = new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve(null);
      }, VERSION_BUDGET_MS);
    });
    return Promise.race([Promise.all(answers), late]).then(function (vals) {
      clearTimeout(timer);
      var out = { hold: false, state: undefined };
      (vals || []).forEach(function (v) {
        if (v === false) out.hold = true;
        else if (v && typeof v === "object" && "state" in v && out.state === undefined) out.state = v.state;
      });
      return out;
    });
  }

  plinth.carried = takeCarried();
  plinth.onVersion = function (fn) {
    if (typeof fn !== "function") throw new PlinthError("invalid", "onVersion needs a function");
    versionHandlers.add(fn);
    return function () {
      versionHandlers.delete(fn);
    };
  };

  if (carryStore) {
    onApp("plinth-view", function (m) {
      if (m.v !== 1 || m.type !== "update") return;
      if (typeof m.nonce !== "string" || !VIEW_NONCE_RE.test(m.nonce)) return;
      if (!versionInt(m.from) || !versionInt(m.to)) return;
      var info = { from: m.from, to: m.to, force: m.force === true };
      var nonce = m.nonce;
      askVersionHandlers(info).then(function (r) {
        if (r.hold && !info.force) {
          toApp({ source: "plinth-view", v: 1, type: "update:hold", nonce: nonce });
          return;
        }
        writeCarry(info, r.state);
        toApp({ source: "plinth-view", v: 1, type: "update:ok", nonce: nonce, path: pagePath() });
      });
    });
    toApp({ source: "plinth-view", v: 1, type: "hello" });
  }

`,
};
