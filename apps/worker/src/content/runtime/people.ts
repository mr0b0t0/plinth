// The runtime's people fragment: plinth.people, who has access to the artifact (docs/spec.md "Who
// is viewing: names and the people list"). Only owners and editors on a page that declares
// `data viewer people` get the list; everyone else gets a PlinthError. It uses the core's call(),
// usable() and the session's canListPeople.
import type { RuntimeFragment } from "./fragment.ts";

export const PEOPLE_FRAGMENT: RuntimeFragment = {
  name: "people",
  source:
    () => `  // ---------- people: who has access (owners and editors, pages that declare people) ----------

  var PERSON_ID_RE = /^u_[0-9a-f]{24}$/;
  function toPerson(p) {
    return {
      id: String(p.id),
      email: String(p.email),
      name: typeof p.name === "string" ? p.name : null,
      role: p.role,
      you: !!p.you,
    };
  }
  plinth.people = {
    list: async function (opts) {
      await usable();
      opts = opts || {};
      var q = [];
      if (opts.q) q.push("q=" + encodeURIComponent(opts.q));
      if (opts.limit) q.push("limit=" + encodeURIComponent(opts.limit));
      var r = await call("GET", "/people" + (q.length ? "?" + q.join("&") : ""));
      // An array, with how many matched in all (before limit) as its total.
      var list = (r.people || []).map(toPerson);
      list.total = typeof r.total === "number" ? r.total : list.length;
      return list;
    },
    get: async function (id) {
      await usable();
      if (typeof id !== "string" || !PERSON_ID_RE.test(id)) return null;
      try {
        return toPerson(await call("GET", "/people/" + id));
      } catch (e) {
        if (e.code === "not_found") return null;
        throw e;
      }
    },
  };

`,
};
