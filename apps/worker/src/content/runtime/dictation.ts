// The runtime's dictation fragment: plinth.dictation, words the viewer speaks, recognized by the
// app that frames the page (docs/spec.md "Voice: dictation and text to speech"). The page never
// gets the microphone or any audio: it asks the app to start over the app channel (runtime/app.ts)
// and receives text. Every check that matters (the viewer's click, consent, limits, the listening
// control) is in the app; this fragment is a convenience for the page, not a boundary.
//
// Nothing is posted until the page first reads plinth.dictation.ready or calls start(), so a page
// that does not use dictation sends nothing. The protocol and its limits are
// packages/shared/src/voice.ts (VOICE_MESSAGE_SOURCE, VOICE_LIMITS, VOICE_LANG_RE).
import { VOICE_LANG_RE, VOICE_LIMITS, VOICE_MESSAGE_SOURCE } from "@plinth/shared";
import type { RuntimeFragment } from "./fragment.ts";

export const DICTATION_FRAGMENT: RuntimeFragment = {
  name: "dictation",
  usesAppChannel: true,
  source:
    () => `  // ---------- dictation: plinth.dictation (words the viewer speaks, recognized by the app) ----------

  var VOICE = ${JSON.stringify(VOICE_MESSAGE_SOURCE)};
  var VOICE_HELLO_MS = ${VOICE_LIMITS.helloTimeoutMs};
  var VOICE_STOP_MS = ${VOICE_LIMITS.stopWaitMs};
  var VOICE_LANG_RE = ${VOICE_LANG_RE.toString()};

  var dc = {
    ready: null,
    status: null,
    hello: null,
    session: null,
    seq: 0,
    partial: new Set(),
    final: new Set(),
    state: new Set(),
  };

  function voiceMsg(body) {
    return Object.assign({ source: VOICE, v: 1 }, body);
  }

  function voiceEmit(fns, value) {
    fns.forEach(function (fn) {
      try {
        fn(value);
      } catch (e) {}
    });
  }

  function voiceSubscribe(fns, fn) {
    if (typeof fn !== "function") throw new PlinthError("invalid", "Expected a function");
    fns.add(fn);
    return function () {
      fns.delete(fn);
    };
  }

  function voiceUnavailable(reason) {
    return new PlinthError("unavailable", "Dictation is not available here (" + reason + ").");
  }

  function voiceSettle(s) {
    if (dc.status) return;
    dc.status = { available: s.available === true, reason: s.available === true ? null : s.reason || "no_host" };
    if (dc.hello) clearTimeout(dc.hello);
    dc.hello = null;
    var pending = dc.session;
    if (!dc.status.available && pending && !pending.started) {
      voiceEnd(pending);
      pending.reject(voiceUnavailable(dc.status.reason));
    }
  }

  function dictationReady() {
    if (dc.ready) return dc.ready;
    dc.ready = new Promise(function (resolve) {
      dc.resolveReady = resolve;
    });
    var finish = function (s) {
      voiceSettle(s);
      dc.resolveReady({ available: dc.status.available, reason: dc.status.reason });
    };
    if (opaque) finish({ available: false, reason: "opaque_isolation" });
    else if (!toApp(voiceMsg({ type: "hello" }))) finish({ available: false, reason: "no_host" });
    else {
      dc.finish = finish;
      dc.hello = setTimeout(function () {
        finish({ available: false, reason: "no_host" });
      }, VOICE_HELLO_MS);
    }
    return dc.ready;
  }

  function voiceEnd(s) {
    if (dc.session === s) dc.session = null;
    var waiters = s.stopWaiters;
    s.stopWaiters = [];
    waiters.forEach(function (fn) {
      fn();
    });
  }

  function voiceRefuse(s, code, message) {
    voiceEnd(s);
    s.reject(new PlinthError(code, message));
  }

  onApp(VOICE, function (m) {
    if (m.v !== 1 || typeof m.type !== "string") return;
    if (m.type === "status") {
      if (dc.finish) dc.finish({ available: m.available === true, reason: m.reason });
      return;
    }
    var s = dc.session;
    if (!s || m.id !== s.id) return;
    if (m.type === "started") {
      if (s.started) return;
      s.started = true;
      s.resolve();
    } else if (m.type === "refused") {
      if (s.started) return;
      var code = typeof m.code === "string" ? m.code : "network";
      voiceRefuse(s, code, "Dictation did not start (" + code + ").");
    } else if (m.type === "partial" || m.type === "final") {
      if (typeof m.text !== "string") return;
      voiceEmit(m.type === "partial" ? dc.partial : dc.final, { text: m.text });
    } else if (m.type === "state") {
      if (m.state !== "idle" && m.state !== "starting" && m.state !== "listening") return;
      var value = { state: m.state, reason: m.state === "idle" ? m.reason || null : null };
      if (m.state === "idle") {
        if (s.started) voiceEnd(s);
        else {
          var why = m.reason === "not_granted" ? "not_granted" : m.reason === "stopped" ? "dismissed" : "network";
          voiceRefuse(s, why, "Dictation stopped before it started.");
        }
      }
      voiceEmit(dc.state, value);
    }
  });

  var dictation = {
    get ready() {
      return dictationReady();
    },
    start: function (opts) {
      opts = opts || {};
      dictationReady();
      if (dc.status && !dc.status.available) return Promise.reject(voiceUnavailable(dc.status.reason));
      if (dc.session) return Promise.reject(new PlinthError("busy", "Dictation is already on."));
      if (opts.lang !== undefined && (typeof opts.lang !== "string" || !VOICE_LANG_RE.test(opts.lang))) {
        return Promise.reject(new PlinthError("invalid", "lang must be a language tag such as en or pt-PT"));
      }
      dc.seq += 1;
      var id = "d" + dc.seq + "_" + Math.random().toString(36).slice(2, 10);
      var body = { type: "start", id: id, interim: opts.interim !== false };
      if (opts.lang !== undefined) body.lang = opts.lang;
      return new Promise(function (resolve, reject) {
        dc.session = { id: id, started: false, resolve: resolve, reject: reject, stopWaiters: [] };
        if (!toApp(voiceMsg(body))) {
          voiceEnd(dc.session);
          reject(voiceUnavailable("no_host"));
        }
      });
    },
    stop: function () {
      var s = dc.session;
      if (!s) return Promise.resolve();
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          voiceEnd(s);
        }, VOICE_STOP_MS);
        s.stopWaiters.push(function () {
          clearTimeout(timer);
          resolve();
        });
        toApp(voiceMsg({ type: "stop", id: s.id }));
      });
    },
    onPartial: function (fn) {
      return voiceSubscribe(dc.partial, fn);
    },
    onFinal: function (fn) {
      return voiceSubscribe(dc.final, fn);
    },
    onState: function (fn) {
      return voiceSubscribe(dc.state, fn);
    },
  };

  plinth.dictation = Object.freeze(dictation);

`,
};
