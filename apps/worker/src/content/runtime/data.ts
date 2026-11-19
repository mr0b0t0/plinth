// The runtime's shared-data fragment: one shared poller of /changes, and plinth.db collections
// (docs/spec.md "Shared data and viewer identity"). It uses the core's call(), usable(), enc()
// and session state.
import type { RuntimeFragment } from "./fragment.ts";

export const DATA_FRAGMENT: RuntimeFragment = {
  name: "data",
  source: () => `  // ---------- live updates: one shared poller of /changes ----------

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

`,
};
