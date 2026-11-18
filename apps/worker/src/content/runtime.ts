// /__plinth/runtime.js: the script a page loads to use its artifact's shared data and live room
// (docs/spec.md "Shared data and viewer identity", "Live rooms"). It is static: no secrets, no configuration and
// no artifact data, so it is served without a content cookie and is the same for every artifact.
// It talks only to its own origin's /__plinth/api/v1/ (connect-src 'self').
//
// window.plinth:
//   ready      Promise<Session>, never rejects: { available, reason, viewer, canWrite,
//              capabilities, shared, limits, usage }; reason null | "opaque_isolation" | "disabled"
//              | "not_declared" | "preview" | "expired" | "network"
//   available, viewer ({ id, email | null, role } | null), canWrite: set once ready resolves
//   db.collection(name): list({ limit, cursor }) -> { docs, nextCursor }, all(), get(id) -> Doc |
//              null, add(data), set(id, data, { ifRev }), update(id, fn), delete(id, { ifRev }),
//              mine(), setMine(data), deleteMine(), onSnapshot(onDocs, onError, { intervalMs })
//   PlinthError: .code unavailable | read_only | forbidden | not_found | conflict |
//              quota_exceeded | too_large | rate_limited | expired | invalid | network;
//              .retryAfter, .currentRev, .limit
//
//   room       the live room (docs/spec.md "Live rooms"); nothing connects until first use:
//              ready Promise<{ available, reason, you: { id, viewer, role, email | null } | null,
//              canEmit(topic) }>, never rejects; presence(patch | null) -> bool (coalesced to
//              10 Hz, 400 bytes); onPeers(fn) -> off; emit(topic, data) -> bool (never echoed);
//              on(topic | "*", fn(data, from, topic)) -> off; onStatus(fn) -> off ("connecting",
//              "open", "reconnecting", "closed", "unavailable"); join(name) -> a sub-room with
//              the same methods (3 at most); leave()
//
// Under opaque isolation the page's origin is "null": ready resolves unavailable without any
// request, and db calls reject with "unavailable". A 401 means the content pass expired: listeners
// get "expired" as their terminal error and a "plinth:expired" event fires on window. The room
// opens one WebSocket to its own origin's /__plinth/room/v1/page (connect-src names it) after
// GET /__plinth/api/v1/room says it may; close code 4401 re-checks and ends in "plinth:expired"
// when access is over, and reconnects back off from 1 to 30 s.
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

export const RUNTIME_SCRIPT = `/* Plinth page runtime v1: shared data and live rooms. */
(function () {
  "use strict";
  if (window.plinth) return;
  var API = "/__plinth/api/v1";
  var POLL_MS = 15000;
  var MIN_POLL_MS = 10000;
  var RETRIES = 3;
  var opaque = self.origin === "null";

  class PlinthError extends Error {
    constructor(code, message, info) {
      super(message || code);
      this.name = "PlinthError";
      this.code = code;
      info = info || {};
      if (info.retryAfter !== undefined) this.retryAfter = info.retryAfter;
      if (info.currentRev !== undefined) this.currentRev = info.currentRev;
      if (info.limit !== undefined) this.limit = info.limit;
    }
  }

  var expiredFired = false;
  function fireExpired() {
    if (expiredFired) return;
    expiredFired = true;
    try {
      window.dispatchEvent(new CustomEvent("plinth:expired"));
    } catch (e) {}
  }

  function toError(status, body, headers) {
    var err = (body && body.error) || {};
    var d = err.details || {};
    var msg = err.message;
    if (status === 401) {
      fireExpired();
      return new PlinthError("expired", msg || "Your access changed. Reload the page.");
    }
    if (status === 403) {
      if (d.reason === "read_only") return new PlinthError("read_only", msg);
      if (err.code === "feature_disabled") return new PlinthError("unavailable", msg);
      if (err.code === "quota_exceeded") return new PlinthError("quota_exceeded", msg, { limit: d.limit });
      return new PlinthError("forbidden", msg);
    }
    if (status === 404) return new PlinthError("not_found", msg);
    if (status === 409) return new PlinthError("conflict", msg, { currentRev: d.current_rev });
    if (status === 413) return new PlinthError("too_large", msg);
    if (status === 429) {
      var ra = Number(headers.get("retry-after")) || d.retry_after;
      return new PlinthError("rate_limited", msg, { retryAfter: ra });
    }
    if (status === 400) return new PlinthError("invalid", msg);
    return new PlinthError("network", msg || "Request failed (" + status + ")");
  }

  async function call(method, path, body) {
    if (opaque) throw new PlinthError("unavailable", "Shared data is not available on this server.");
    var res;
    try {
      res = await fetch(API + path, {
        method: method,
        credentials: "same-origin",
        cache: "no-store",
        headers: { "x-plinth-data": "1", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PlinthError("network", "Could not reach the server.");
    }
    var json = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch (e) {}
    }
    if (!res.ok) throw toError(res.status, json, res.headers);
    return json;
  }

  function author(a) {
    return a ? { email: a.email, role: a.role, via: a.via } : undefined;
  }
  function toDoc(d) {
    var out = {
      id: d.id,
      data: d.data,
      rev: d.rev,
      mine: d.mine,
      personal: d.personal,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
    if (d.created_by) out.createdBy = author(d.created_by);
    if (d.updated_by) out.updatedBy = author(d.updated_by);
    return out;
  }

  var state = {
    available: false,
    reason: null,
    viewer: null,
    canWrite: false,
    capabilities: [],
    shared: [],
    limits: null,
    usage: null,
  };
  var lastSeq = null;

  function unavailable(reason) {
    var s = Object.assign({}, state, { available: false, reason: reason, viewer: null, canWrite: false });
    return s;
  }

  async function load() {
    if (opaque) return unavailable("opaque_isolation");
    try {
      var s = await call("GET", "/session");
      if (!s.available) return unavailable(s.reason);
      lastSeq = s.seq;
      return {
        available: true,
        reason: null,
        viewer: s.viewer ? { id: s.viewer.id, email: s.viewer.email, role: s.viewer.role } : null,
        canWrite: !!s.can_write,
        capabilities: s.capabilities || [],
        shared: s.shared || [],
        limits: s.limits
          ? { maxDocBytes: s.limits.max_doc_bytes, maxDocs: s.limits.max_docs, maxBytes: s.limits.max_bytes }
          : null,
        usage: s.usage ? { docs: s.usage.docs, bytes: s.usage.bytes } : null,
      };
    } catch (e) {
      return unavailable(e && e.code === "expired" ? "expired" : "network");
    }
  }

  var plinth = {
    PlinthError: PlinthError,
    available: false,
    viewer: null,
    canWrite: false,
    ready: null,
    db: { collection: collection },
  };
  plinth.ready = load().then(function (s) {
    state = s;
    plinth.available = s.available;
    plinth.viewer = s.viewer;
    plinth.canWrite = s.canWrite;
    return s;
  });

  async function usable() {
    var s = await plinth.ready;
    if (!s.available) {
      if (s.reason === "expired") throw new PlinthError("expired", "Your access changed. Reload the page.");
      throw new PlinthError("unavailable", "Shared data is not available (" + s.reason + ").");
    }
  }

  function enc(s) {
    if (typeof s !== "string" || !s) throw new PlinthError("invalid", "Expected a non-empty string id");
    return encodeURIComponent(s);
  }

  // ---------- live updates: one shared poller of /changes ----------

  var subs = new Set();
  var timer = null;
  var ticking = false;
  // A refresh asked for while a poll runs (the page's own write): poll again as soon as it ends,
  // since the running one may have read /changes before the write landed.
  var again = false;

  function pollInterval() {
    var ms = POLL_MS;
    subs.forEach(function (s) {
      if (s.intervalMs < ms) ms = s.intervalMs;
    });
    return Math.max(MIN_POLL_MS, ms);
  }
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!subs.size || document.visibilityState !== "visible") return;
    timer = setTimeout(tick, ms === undefined ? pollInterval() : ms);
  }
  function fail(sub, err) {
    if (sub.done) return;
    sub.done = true;
    subs.delete(sub);
    if (sub.onError) {
      try {
        sub.onError(err);
      } catch (e) {}
    }
  }
  async function refresh(sub) {
    var docs = await collection(sub.name).all();
    if (!sub.done) sub.onDocs(docs);
  }
  async function tick() {
    timer = null;
    if (!subs.size) return;
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    again = false;
    try {
      var r = await call("GET", "/changes");
      if (r.seq !== lastSeq) {
        var all = Array.from(subs);
        for (var i = 0; i < all.length; i++) await refresh(all[i]);
        lastSeq = r.seq;
      }
    } catch (e) {
      if (e && (e.code === "expired" || e.code === "unavailable")) {
        Array.from(subs).forEach(function (s) {
          fail(s, e);
        });
      }
    } finally {
      ticking = false;
      schedule(again ? 0 : undefined);
      again = false;
    }
  }
  function kick() {
    if (!subs.size) return;
    if (ticking) again = true;
    else schedule(0);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") schedule(0);
    else schedule();
  });

  // ---------- collections ----------

  function collection(name) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(name)) {
      throw new PlinthError("invalid", "Collection: a lowercase letter, then up to 39 of a-z 0-9 _ -");
    }
    var base = "/data/" + name;
    async function write(method, path, body) {
      await usable();
      var r = await call(method, path, body);
      kick();
      return r;
    }
    var c = {
      list: async function (opts) {
        await usable();
        opts = opts || {};
        var q = [];
        if (opts.limit) q.push("limit=" + encodeURIComponent(opts.limit));
        if (opts.cursor) q.push("cursor=" + encodeURIComponent(opts.cursor));
        var r = await call("GET", base + (q.length ? "?" + q.join("&") : ""));
        return { docs: r.docs.map(toDoc), nextCursor: r.next_cursor };
      },
      all: async function () {
        await usable();
        var out = [];
        var cursor = null;
        var max = (state.limits && state.limits.maxDocs) || 1000;
        do {
          var page = await c.list({ limit: 200, cursor: cursor });
          out = out.concat(page.docs);
          cursor = page.nextCursor;
        } while (cursor && out.length < max);
        return out;
      },
      get: async function (id) {
        await usable();
        try {
          return toDoc(await call("GET", base + "/" + enc(id)));
        } catch (e) {
          if (e.code === "not_found") return null;
          throw e;
        }
      },
      add: async function (data) {
        return toDoc(await write("POST", base, { data: data }));
      },
      set: async function (id, data, opts) {
        var body = { data: data };
        if (opts && opts.ifRev !== undefined) body.if_rev = opts.ifRev;
        return toDoc(await write("PUT", base + "/" + enc(id), body));
      },
      update: async function (id, fn) {
        for (var attempt = 0; ; attempt++) {
          var doc = await c.get(id);
          var next = await fn(doc ? doc.data : null, doc);
          try {
            return await c.set(id, next, { ifRev: doc ? doc.rev : 0 });
          } catch (e) {
            if (e.code !== "conflict" || attempt >= RETRIES) throw e;
          }
        }
      },
      delete: async function (id, opts) {
        var q = opts && opts.ifRev !== undefined ? "?if_rev=" + encodeURIComponent(opts.ifRev) : "";
        await write("DELETE", base + "/" + enc(id) + q);
      },
      mine: function () {
        return c.get("~me");
      },
      setMine: function (data) {
        return c.set("~me", data);
      },
      deleteMine: function () {
        return c.delete("~me");
      },
      onSnapshot: function (onDocs, onError, opts) {
        if (typeof onDocs !== "function") throw new PlinthError("invalid", "onSnapshot needs a callback");
        var ms = Number((opts && opts.intervalMs) || POLL_MS);
        var sub = { name: name, onDocs: onDocs, onError: onError, intervalMs: Math.max(MIN_POLL_MS, ms), done: false };
        (async function () {
          try {
            await usable();
            await refresh(sub);
          } catch (e) {
            fail(sub, e);
            return;
          }
          if (sub.done) return;
          subs.add(sub);
          schedule();
        })();
        return function stop() {
          sub.done = true;
          subs.delete(sub);
          schedule();
        };
      },
    };
    return c;
  }

  // ---------- live room: plinth.room (presence and broadcast, nothing persists) ----------

  var ROOM_PATH = "/__plinth/room/v1/page";
  var ROOM_PROTOCOL = "plinth.room.v1";
  var ROOM_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
  var ROOM_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
  var TOPIC_RE = /^[a-z][a-z0-9_.:-]{0,39}$/;
  var MAX_ROOMS = 3;
  var PRESENCE_BYTES = 400;
  var PRESENCE_MS = 100;
  var PING_MS = 30000;
  var HIDDEN_MS = 60000;

  var rm = {
    started: false,
    terminal: false,
    info: null,
    ws: null,
    welcomed: false,
    opened: false,
    you: null,
    status: "closed",
    statusSubs: new Set(),
    rooms: new Map(),
    attempt: 0,
    retry: null,
    ping: null,
    hidden: null,
    paused: false,
    tokens: 0,
    tokensAt: 0,
    readyDone: false,
    readyResolve: null,
    ready: null,
  };
  rm.ready = new Promise(function (r) {
    rm.readyResolve = r;
  });

  function bytes(s) {
    return new TextEncoder().encode(s).length;
  }
  function setStatus(s) {
    if (rm.status === s) return;
    rm.status = s;
    rm.statusSubs.forEach(function (fn) {
      try {
        fn(s);
      } catch (e) {}
    });
  }
  function canEmit(topic) {
    var i = rm.info;
    if (!i || typeof topic !== "string" || !TOPIC_RE.test(topic)) return false;
    // all: owners and editors; open: commenters, the page's open topics; none: viewers.
    if (i.can_emit === "all") return true;
    if (i.can_emit !== "open") return false;
    var open = i.open_topics || [];
    return open.indexOf("*") >= 0 || open.indexOf(topic) >= 0;
  }
  function finishReady(reason) {
    if (rm.readyDone) return;
    rm.readyDone = true;
    var y = rm.you;
    rm.readyResolve(
      reason
        ? { available: false, reason: reason, you: null, canEmit: function () { return false; } }
        : {
            available: true,
            reason: null,
            you: { id: y.id, viewer: y.viewer, role: y.role, email: y.email || null },
            canEmit: canEmit,
          },
    );
  }
  function clearTimers() {
    [rm.retry, rm.ping, rm.hidden].forEach(function (t) {
      if (t) clearTimeout(t);
    });
    rm.retry = rm.ping = rm.hidden = null;
  }
  function stopRoom(reason) {
    rm.terminal = true;
    clearTimers();
    detach();
    finishReady(reason);
    setStatus(rm.opened ? "closed" : "unavailable");
  }

  async function roomInfo() {
    if (opaque) return { available: false, reason: "opaque_isolation" };
    try {
      return await call("GET", "/room");
    } catch (e) {
      return { available: false, reason: e && e.code === "expired" ? "expired" : "network" };
    }
  }
  async function check() {
    var info = await roomInfo();
    if (rm.terminal) return;
    if (!info || !info.available) return stopRoom((info && info.reason) || "network");
    rm.info = info;
    connect();
  }
  function startRoom() {
    if (rm.started) return;
    rm.started = true;
    setStatus("connecting");
    check();
  }

  function sendRaw(frame) {
    var ws = rm.ws;
    if (!ws || !rm.welcomed || ws.readyState !== 1) return false;
    var s;
    try {
      s = JSON.stringify(frame);
    } catch (e) {
      return false;
    }
    var lim = rm.info.limits || {};
    if (bytes(s) > (lim.max_message_bytes || 8192)) return false;
    var rate = lim.messages_per_second || 20;
    var now = Date.now();
    rm.tokens = Math.min(rate * 2, rm.tokens + ((now - rm.tokensAt) * rate) / 1000);
    rm.tokensAt = now;
    if (rm.tokens < 1) return false;
    rm.tokens -= 1;
    try {
      ws.send(s);
    } catch (e) {
      return false;
    }
    return true;
  }

  function detach() {
    var ws = rm.ws;
    rm.ws = null;
    rm.welcomed = false;
    if (rm.ping) clearTimeout(rm.ping);
    rm.ping = null;
    rm.rooms.forEach(function (r) {
      r.joined = false;
      if (r.peers.size) {
        r.peers = new Map();
        notifyPeers(r);
      }
    });
    return ws;
  }

  function connect() {
    if (rm.terminal || rm.ws || rm.paused) return;
    var WS = window.WebSocket;
    var loc = window.location;
    if (!WS || !loc) return stopRoom("network");
    var ws;
    try {
      ws = new WS((loc.protocol === "https:" ? "wss:" : "ws:") + "//" + loc.host + ROOM_PATH, ROOM_PROTOCOL);
    } catch (e) {
      return retryLater(false);
    }
    rm.ws = ws;
    rm.welcomed = false;
    ws.onmessage = function (e) {
      if (rm.ws !== ws || typeof e.data !== "string" || e.data === "pong") return;
      var m;
      try {
        m = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (m && typeof m === "object") onFrame(m);
    };
    ws.onclose = function (e) {
      if (rm.ws !== ws) return;
      var welcomed = rm.welcomed;
      detach();
      onClose(e.code, welcomed);
    };
    ws.onerror = function () {};
  }

  function onClose(code, welcomed) {
    if (rm.terminal) return;
    if (code === 4401 || code === 4410) {
      setStatus("reconnecting");
      check();
    } else if (code === 4409) stopRoom("full");
    else if (code === 4429) stopRoom("rate_limited");
    else if (code === 4404) {
      fireExpired();
      stopRoom("expired");
    } else if (code === 4403 || code === 4400) stopRoom("not_identified");
    else retryLater(welcomed);
  }

  function retryLater(welcomed) {
    // A first socket that never opened: say so now, and keep trying.
    if (!rm.opened) finishReady("network");
    var base = ROOM_BACKOFF_MS[Math.min(rm.attempt, ROOM_BACKOFF_MS.length - 1)];
    rm.attempt++;
    setStatus("reconnecting");
    rm.retry = setTimeout(function () {
      rm.retry = null;
      // A handshake the server refused looks like a network failure here: ask /room first.
      if (welcomed) connect();
      else check();
    }, base * (0.8 + Math.random() * 0.4));
  }

  function schedulePing() {
    rm.ping = setTimeout(function () {
      rm.ping = null;
      if (rm.ws && rm.ws.readyState === 1) {
        try {
          rm.ws.send("ping");
        } catch (e) {}
      }
      if (rm.ws) schedulePing();
    }, PING_MS);
  }

  function onFrame(m) {
    if (m.t === "welcome") {
      if (!m.you || typeof m.you.id !== "string") return;
      rm.you = m.you;
      rm.welcomed = true;
      rm.opened = true;
      rm.attempt = 0;
      var rate = (rm.info.limits && rm.info.limits.messages_per_second) || 20;
      rm.tokens = rate * 2;
      rm.tokensAt = Date.now();
      setStatus("open");
      finishReady(null);
      rm.rooms.forEach(function (r) {
        r.pending = null;
        r.pendingClear = false;
        joinNow(r);
        if (Object.keys(r.mine).length) sendRaw({ t: "presence", room: r.name, state: r.mine });
      });
      schedulePing();
      return;
    }
    if (m.t === "error") {
      if (m.code === "rate_limited") rm.tokens = 0;
      return;
    }
    var r = rm.rooms.get(m.room);
    if (!r) return;
    if (m.t === "peers" && Array.isArray(m.peers)) {
      r.peers = new Map();
      m.peers.forEach(function (p) {
        if (p && typeof p.id === "string") r.peers.set(p.id, p);
      });
      var me = rm.you && r.peers.get(rm.you.id);
      if (me) me.presence = r.mine;
      notifyPeers(r);
    } else if (m.t === "peer" && m.peer && typeof m.peer.id === "string") {
      r.peers.set(m.peer.id, m.peer);
      notifyPeers(r);
    } else if (m.t === "gone") {
      if (r.peers.delete(m.id)) notifyPeers(r);
    } else if (m.t === "event" && typeof m.topic === "string" && m.from) {
      var from = peerOut(m.from);
      [m.topic, "*"].forEach(function (t) {
        (r.topics.get(t) || new Set()).forEach(function (fn) {
          try {
            fn(m.data, from, m.topic);
          } catch (e) {}
        });
      });
    }
  }

  function peerOut(p) {
    var out = { id: String(p.id), viewer: String(p.viewer), you: !!rm.you && p.id === rm.you.id };
    if (typeof p.role === "string") out.role = p.role;
    if (typeof p.email === "string") out.email = p.email;
    return out;
  }
  function notifyPeers(r) {
    var list = Array.from(r.peers.values()).map(function (p) {
      var out = peerOut(p);
      out.presence = p.presence && typeof p.presence === "object" ? p.presence : {};
      return out;
    });
    r.peerSubs.forEach(function (fn) {
      try {
        fn(list.slice());
      } catch (e) {}
    });
  }

  function joinNow(r) {
    if (!r.joined && sendRaw({ t: "join", room: r.name })) r.joined = true;
  }
  function use(r) {
    if (!rm.rooms.has(r.name)) {
      if (rm.rooms.size >= MAX_ROOMS) throw new PlinthError("invalid", "A page joins at most " + MAX_ROOMS + " rooms");
      rm.rooms.set(r.name, r);
      joinNow(r);
    }
    startRoom();
  }
  function flushPresence(r) {
    r.pTimer = null;
    if (!r.joined) return;
    if (r.pendingClear && !sendRaw({ t: "presence", room: r.name, state: null })) return later();
    r.pendingClear = false;
    if (r.pending && !sendRaw({ t: "presence", room: r.name, state: r.pending })) return later();
    r.pending = null;
    function later() {
      r.pTimer = setTimeout(function () {
        flushPresence(r);
      }, PRESENCE_MS * 5);
    }
  }

  function makeRoom(name) {
    var r = {
      name: name,
      peers: new Map(),
      peerSubs: new Set(),
      topics: new Map(),
      mine: {},
      pending: null,
      pendingClear: false,
      pTimer: null,
      joined: false,
    };
    var h = {
      get ready() {
        use(r);
        return rm.ready;
      },
      presence: function (patch) {
        if (patch !== null && (typeof patch !== "object" || Array.isArray(patch))) {
          throw new PlinthError("invalid", "presence() takes an object or null");
        }
        use(r);
        var next = {};
        if (patch !== null) {
          next = Object.assign({}, r.mine);
          Object.keys(patch).forEach(function (k) {
            if (patch[k] === null) delete next[k];
            else next[k] = patch[k];
          });
        }
        var json;
        try {
          json = JSON.stringify(next);
        } catch (e) {
          return false;
        }
        if (bytes(json) > PRESENCE_BYTES) return false;
        r.mine = next;
        if (patch === null) {
          r.pendingClear = true;
          r.pending = null;
        } else r.pending = Object.assign(r.pending || {}, patch);
        var me = rm.you && r.peers.get(rm.you.id);
        if (me) {
          me.presence = next;
          notifyPeers(r);
        }
        if (!r.pTimer) {
          r.pTimer = setTimeout(function () {
            flushPresence(r);
          }, PRESENCE_MS);
        }
        return true;
      },
      onPeers: function (fn) {
        if (typeof fn !== "function") throw new PlinthError("invalid", "onPeers needs a callback");
        use(r);
        r.peerSubs.add(fn);
        notifyPeers({ peers: r.peers, peerSubs: new Set([fn]) });
        return function off() {
          r.peerSubs.delete(fn);
        };
      },
      emit: function (topic, data) {
        if (typeof topic !== "string" || !TOPIC_RE.test(topic)) {
          throw new PlinthError("invalid", "Topic: a lowercase letter, then up to 39 of a-z 0-9 _ . : -");
        }
        use(r);
        if (!r.joined || !canEmit(topic)) return false;
        return sendRaw({ t: "emit", room: r.name, topic: topic, data: data === undefined ? null : data });
      },
      on: function (topic, fn) {
        if (topic !== "*" && (typeof topic !== "string" || !TOPIC_RE.test(topic))) {
          throw new PlinthError("invalid", "Topic: a lowercase letter, then up to 39 of a-z 0-9 _ . : -");
        }
        if (typeof fn !== "function") throw new PlinthError("invalid", "on() needs a callback");
        use(r);
        if (!r.topics.has(topic)) r.topics.set(topic, new Set());
        r.topics.get(topic).add(fn);
        return function off() {
          r.topics.get(topic).delete(fn);
        };
      },
      onStatus: function (fn) {
        if (typeof fn !== "function") throw new PlinthError("invalid", "onStatus needs a callback");
        rm.statusSubs.add(fn);
        try {
          fn(rm.status);
        } catch (e) {}
        return function off() {
          rm.statusSubs.delete(fn);
        };
      },
      leave: function () {
        if (!rm.rooms.has(r.name)) return;
        rm.rooms.delete(r.name);
        if (r.joined) sendRaw({ t: "leave", room: r.name });
        r.joined = false;
        if (r.pTimer) clearTimeout(r.pTimer);
        r.pTimer = null;
        r.pending = null;
        r.pendingClear = false;
        r.mine = {};
        r.peers = new Map();
        notifyPeers(r);
      },
    };
    return h;
  }

  var handles = new Map();
  var room = makeRoom("main");
  handles.set("main", room);
  room.join = function (name) {
    if (typeof name !== "string" || !ROOM_NAME_RE.test(name)) {
      throw new PlinthError("invalid", "Room: a lowercase letter, then up to 39 of a-z 0-9 _ -");
    }
    if (!handles.has(name)) handles.set(name, makeRoom(name));
    var h = handles.get(name);
    h.ready;
    return h;
  };

  // A tab hidden for a minute closes its socket (its presence goes with it); shown, it reconnects.
  document.addEventListener("visibilitychange", function () {
    if (!rm.started || rm.terminal) return;
    if (document.visibilityState === "hidden") {
      if (!rm.hidden) {
        rm.hidden = setTimeout(function () {
          rm.hidden = null;
          rm.paused = true;
          if (rm.retry) clearTimeout(rm.retry);
          rm.retry = null;
          var ws = detach();
          if (ws) {
            try {
              ws.close(1000, "hidden");
            } catch (e) {}
          }
          setStatus("closed");
        }, HIDDEN_MS);
      }
    } else {
      if (rm.hidden) clearTimeout(rm.hidden);
      rm.hidden = null;
      if (rm.paused) {
        rm.paused = false;
        rm.attempt = 0;
        setStatus("reconnecting");
        check();
      }
    }
  });

  plinth.room = room;

  Object.defineProperty(window, "plinth", { value: plinth, writable: false, configurable: false });
})();
`;

export function serveRuntimeScript(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/javascript; charset=utf-8" });
  applyContentHeaders(config, headers, { publicFile: true });
  return new Response(RUNTIME_SCRIPT, { status: 200, headers });
}
