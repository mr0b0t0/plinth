// The runtime's page-requests fragment (docs/spec.md "Page requests"): plinth.requests, for a page
// that declares `requests`. It talks only to its own origin, /__plinth/api/v1/requests, through the
// core's call() (the x-plinth-data header, JSON bodies) and maps errors with toError, so a 401
// fires "plinth:expired" as for data and rooms. Nothing is fetched until the page first reads
// requests.ready or calls a method. Under opaque isolation ready resolves unavailable without any
// request. A request carries no author of anything; its texts are untrusted, for textContent.
import { pageRequestsActive } from "../../config.ts";
import type { RuntimeFragment } from "./fragment.ts";

export const REQUESTS_FRAGMENT: RuntimeFragment = {
  name: "requests",
  // Only where page requests are in effect: elsewhere plinth.requests is undefined, and the script
  // is byte for byte what it was before page requests.
  included: (s) =>
    pageRequestsActive({
      allowPageRequests: s.allowPageRequests === true,
      contentIsolation: s.contentIsolation ?? "opaque",
    }),
  source: () => `  // ---------- page requests to the owner's agent ----------

  var REQ_POLL_MS = 30000;
  var REQ_MIN_POLL_MS = 15000;

  function toRequest(r) {
    return {
      id: r.id,
      state: r.state,
      resolved: !!r.resolved,
      to: r.to,
      body: r.body,
      data: r.data === undefined ? null : r.data,
      version: r.version,
      resultVersion: r.result_version,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      answers: (r.answers || []).map(function (a) {
        return { body: a.body, createdAt: a.created_at };
      }),
    };
  }

  function requestsOff(reason) {
    return { available: false, reason: reason, canFile: false, to: null, limits: null };
  }

  var reqLoading = null;

  async function loadRequests() {
    if (opaque) return requestsOff("opaque_isolation");
    try {
      var s = await call("GET", "/requests");
      if (!s.available) return requestsOff(s.reason);
      return {
        available: true,
        reason: null,
        canFile: !!s.can_file,
        to: s.to || null,
        limits: {
          maxBodyChars: s.limits.max_body_chars,
          maxDataBytes: s.limits.max_data_bytes,
          perHour: s.limits.per_hour,
          maxOpen: s.limits.max_open,
        },
      };
    } catch (e) {
      return requestsOff(e && e.code === "expired" ? "expired" : "network");
    }
  }

  function requestsReady() {
    if (!reqLoading) reqLoading = loadRequests();
    return reqLoading;
  }

  async function requestsUsable() {
    var s = await requestsReady();
    if (!s.available) {
      if (s.reason === "expired") throw new PlinthError("expired", "Your access changed. Reload the page.");
      throw new PlinthError("unavailable", "Requests are not available (" + s.reason + ").");
    }
    return s;
  }

  async function mineNow() {
    var r = await call("GET", "/requests");
    if (!r.available) throw new PlinthError("unavailable", "Requests are not available (" + r.reason + ").");
    return r.requests.map(toRequest);
  }

  // One shared poller of GET /requests: it runs while the tab is visible, someone listens, and one
  // of the caller's requests is pending or claimed.
  var rsubs = new Set();
  var rtimer = null;
  var rticking = false;
  var rlast = null;
  var ropen = false;

  function rschedule(ms) {
    if (rtimer) clearTimeout(rtimer);
    rtimer = null;
    if (!rsubs.size || document.visibilityState !== "visible") return;
    if (ms === undefined && !ropen) return;
    var every = REQ_POLL_MS;
    rsubs.forEach(function (s) {
      if (s.intervalMs < every) every = s.intervalMs;
    });
    rtimer = setTimeout(rtick, ms === undefined ? Math.max(REQ_MIN_POLL_MS, every) : ms);
  }
  function rfail(sub, err) {
    if (sub.done) return;
    sub.done = true;
    rsubs.delete(sub);
    if (sub.onError) {
      try {
        sub.onError(err);
      } catch (e) {}
    }
  }
  function rdeliver(list, force) {
    var key = JSON.stringify(list);
    var changed = force === true || key !== rlast;
    rlast = key;
    ropen = list.some(function (r) {
      return !r.resolved && (r.state === "pending" || r.state === "claimed");
    });
    if (!changed) return;
    Array.from(rsubs).forEach(function (s) {
      if (s.done) return;
      try {
        s.fn(list);
      } catch (e) {}
    });
  }
  async function rtick(force) {
    rtimer = null;
    if (!rsubs.size || rticking) return;
    rticking = true;
    try {
      rdeliver(await mineNow(), force);
    } catch (e) {
      if (e && (e.code === "expired" || e.code === "unavailable")) {
        Array.from(rsubs).forEach(function (s) {
          rfail(s, e);
        });
      }
    } finally {
      rticking = false;
      rschedule();
    }
  }
  function rkick() {
    if (!rsubs.size) return;
    ropen = true;
    rschedule(0);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") rschedule(ropen ? 0 : undefined);
    else rschedule();
  });

  var requests = {
    file: async function (input) {
      var s = await requestsUsable();
      if (!s.canFile) {
        throw new PlinthError("forbidden", "Only people who can comment can send requests from this page.");
      }
      input = input || {};
      if (typeof input.body !== "string") throw new PlinthError("invalid", "file needs a body");
      var payload = { body: input.body };
      if (input.data !== undefined) payload.data = input.data;
      if (input.to !== undefined) payload.to = input.to;
      var r = toRequest(await call("POST", "/requests", payload));
      rkick();
      return r;
    },
    mine: async function () {
      await requestsUsable();
      return mineNow();
    },
    get: async function (id) {
      await requestsUsable();
      try {
        return toRequest(await call("GET", "/requests/" + enc(id)));
      } catch (e) {
        if (e.code === "not_found") return null;
        throw e;
      }
    },
    onChange: function (fn, onError, opts) {
      if (typeof fn !== "function") throw new PlinthError("invalid", "onChange needs a callback");
      var ms = Number((opts && opts.intervalMs) || REQ_POLL_MS);
      var sub = { fn: fn, onError: onError, intervalMs: Math.max(REQ_MIN_POLL_MS, ms), done: false };
      (async function () {
        try {
          await requestsUsable();
        } catch (e) {
          rfail(sub, e);
          return;
        }
        if (sub.done) return;
        rsubs.add(sub);
        // The first delivery goes to this listener even when nothing changed for the others.
        rlast = null;
        rschedule(0);
      })();
      return function stop() {
        sub.done = true;
        rsubs.delete(sub);
        rschedule();
      };
    },
  };
  Object.defineProperty(requests, "ready", { get: requestsReady, enumerable: true });
  plinth.requests = Object.freeze(requests);

`,
};
