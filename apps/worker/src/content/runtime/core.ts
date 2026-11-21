// The runtime's core fragment: the opening of the script (errors, the API call, the session that
// plinth.ready resolves to, the plinth object) and its closing (window.plinth, frozen in place).
// Every other fragment is inserted between the two, inside the same function scope.

/** From the script's first line to the first fragment. */
export const CORE_HEAD = `/* Plinth page runtime v1: shared data and live rooms. */
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

  async function call(method, path, body, format) {
    if (opaque) throw new PlinthError("unavailable", "Shared data is not available on this server.");
    var res;
    try {
      res = await fetch(API + path, {
        method: method,
        credentials: "same-origin",
        cache: "no-store",
        headers: Object.assign({ "x-plinth-data": "1", "content-type": "application/json" }, format && { "x-plinth-format": format }),
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
    return a
      ? { email: a.email, name: typeof a.name === "string" ? a.name : null, role: a.role, via: a.via }
      : undefined;
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
    canListPeople: false,
    capabilities: [],
    shared: [],
    limits: null,
    usage: null,
  };
  var lastSeq = null;

  function unavailable(reason) {
    var s = Object.assign({}, state, {
      available: false,
      reason: reason,
      viewer: null,
      canWrite: false,
      canListPeople: false,
    });
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
        viewer: s.viewer
          ? {
              id: s.viewer.id,
              email: s.viewer.email,
              name: typeof s.viewer.name === "string" ? s.viewer.name : null,
              role: s.viewer.role,
            }
          : null,
        canWrite: !!s.can_write,
        canListPeople: !!s.can_list_people,
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
    canListPeople: false,
    ready: null,
    db: { collection: collection },
  };
  plinth.ready = load().then(function (s) {
    state = s;
    plinth.available = s.available;
    plinth.viewer = s.viewer;
    plinth.canWrite = s.canWrite;
    plinth.canListPeople = s.canListPeople;
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

`;

/** After the last fragment, to the script's last line. */
export const CORE_TAIL = `  Object.defineProperty(window, "plinth", { value: plinth, writable: false, configurable: false });
})();
`;
