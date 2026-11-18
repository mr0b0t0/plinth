// The runtime's live-room fragment: plinth.room, presence and broadcast over one WebSocket to the
// page's own origin (docs/spec.md "Live rooms"). Nothing persists.
import type { RuntimeFragment } from "./fragment.ts";

export const ROOM_FRAGMENT: RuntimeFragment = {
  name: "room",
  source:
    () => `  // ---------- live room: plinth.room (presence and broadcast, nothing persists) ----------

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
            you: {
              id: y.id,
              viewer: y.viewer,
              role: y.role,
              email: y.email || null,
              name: typeof y.name === "string" ? y.name : null,
            },
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
    if (typeof p.email === "string") {
      out.email = p.email;
      out.name = typeof p.name === "string" ? p.name : null;
    }
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

`,
};
