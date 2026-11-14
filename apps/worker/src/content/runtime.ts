// /__plinth/runtime.js: the script a page loads to use its artifact's shared data
// (docs/spec.md "Shared data and viewer identity"). It is static: no secrets, no configuration and
// no artifact data, so it is served without a content cookie and is the same for every artifact.
// It talks only to its own origin's /__plinth/api/v1/ (connect-src 'self').
//
// window.plinth:
//   ready      Promise<Session>, never rejects: { available, reason, viewer, canWrite,
//              capabilities, shared, limits, usage }; reason null | "opaque_isolation" | "disabled"
//              | "not_declared" | "expired" | "network"
//   available, viewer ({ id, email | null, role } | null), canWrite: set once ready resolves
//   db.collection(name): list({ limit, cursor }) -> { docs, nextCursor }, all(), get(id) -> Doc |
//              null, add(data), set(id, data, { ifRev }), update(id, fn), delete(id, { ifRev }),
//              mine(), setMine(data), deleteMine(), onSnapshot(onDocs, onError, { intervalMs })
//   PlinthError: .code unavailable | read_only | forbidden | not_found | conflict |
//              quota_exceeded | too_large | rate_limited | expired | invalid | network;
//              .retryAfter, .currentRev, .limit
//
// Under opaque isolation the page's origin is "null": ready resolves unavailable without any
// request, and db calls reject with "unavailable". A 401 means the content pass expired: listeners
// get "expired" as their terminal error and a "plinth:expired" event fires on window.
import type { Config } from "../config.ts";
import { applyContentHeaders } from "./csp.ts";

export const RUNTIME_SCRIPT = `/* Plinth shared-data runtime v1. */
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
    if (ticking || !subs.size) return;
    ticking = true;
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
      schedule();
    }
  }
  function kick() {
    if (subs.size) schedule(0);
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

  Object.defineProperty(window, "plinth", { value: plinth, writable: false, configurable: false });
})();
`;

export function serveRuntimeScript(config: Config): Response {
  const headers = new Headers({ "Content-Type": "text/javascript; charset=utf-8" });
  applyContentHeaders(config, headers);
  return new Response(RUNTIME_SCRIPT, { status: 200, headers });
}
