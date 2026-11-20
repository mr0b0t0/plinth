// /__plinth/runtime.js, run against a fake window and fetch: display names on the viewer and on
// document authors, canListPeople, and plinth.people (list, get, and the errors a page handles).
import { describe, expect, it } from "vitest";
import { runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

type Json = Record<string, any>;
type Reply = { status: number; body?: unknown };
type Handler = (method: string, path: string) => Reply;

const ME = "u_0123456789abcdef01234567";
const SESSION = {
  available: true,
  viewer: { id: ME, email: "ann@example.com", name: "Ann", role: "owner" },
  can_write: true,
  can_list_people: true,
  capabilities: ["data", "viewer", "people"],
  shared: [],
  limits: { max_doc_bytes: 16384, max_docs: 1000, max_bytes: 1048576 },
  usage: { docs: 0, bytes: 0 },
  seq: 0,
};
const PEOPLE = [
  { id: ME, email: "ann@example.com", name: "Ann", role: "owner", you: true },
  {
    id: "u_aaaaaaaaaaaaaaaaaaaaaaaa",
    email: "bo@example.com",
    name: null,
    role: "viewer",
    you: false,
  },
];

function boot(handler: Handler, origin = "https://a.example") {
  const calls: { method: string; path: string }[] = [];
  const events: string[] = [];
  const win: Json = {
    addEventListener() {},
    dispatchEvent(e: { type: string }) {
      events.push(e.type);
      return true;
    },
  };
  const doc = { visibilityState: "visible", addEventListener() {} };
  const fakeFetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = url.slice("/__plinth/api/v1".length);
    calls.push({ method, path });
    const r = handler(method, path);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: new Headers(),
      json: async () => JSON.parse(JSON.stringify(r.body ?? null)),
    };
  };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    runtimeScript(config()),
  )(
    win,
    { origin },
    doc,
    fakeFetch,
    setTimeout,
    clearTimeout,
    class {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    },
  );
  return { plinth: win.plinth, calls, events };
}

const server =
  (over: Partial<Record<string, Reply>> = {}, session: Json = SESSION): Handler =>
  (_method, path) => {
    const url = new URL(`http://x${path}`);
    if (over[url.pathname]) return over[url.pathname] as Reply;
    if (url.pathname === "/session") return { status: 200, body: session };
    if (url.pathname === "/people") return { status: 200, body: { people: PEOPLE, total: 2 } };
    const one = /^\/people\/(.+)$/.exec(url.pathname);
    if (one) {
      const p = PEOPLE.find((x) => x.id === one[1]);
      return p ? { status: 200, body: p } : { status: 404, body: { error: { code: "not_found" } } };
    }
    if (url.pathname === "/data/notes") {
      return {
        status: 200,
        body: {
          docs: [
            {
              id: "n1",
              data: {},
              rev: 1,
              mine: true,
              personal: false,
              created_at: "t",
              updated_at: "t",
              created_by: { email: "ann@example.com", name: "Ann", role: "owner", via: "page" },
              updated_by: { email: "bo@example.com", role: "viewer", via: "page" },
            },
          ],
          next_cursor: null,
        },
      };
    }
    return { status: 404, body: { error: { code: "not_found" } } };
  };

describe("runtime: names and the people list", () => {
  it("viewer.name and canListPeople come from the session", async () => {
    const { plinth } = boot(server());
    const s = await plinth.ready;
    expect(s.viewer).toEqual({ id: ME, email: "ann@example.com", name: "Ann", role: "owner" });
    expect(s.canListPeople).toBe(true);
    expect(plinth.canListPeople).toBe(true);
    expect(plinth.viewer.name).toBe("Ann");
  });

  it("authors carry name, null when the server sends none", async () => {
    const { plinth } = boot(server());
    await plinth.ready;
    const { docs } = await plinth.db.collection("notes").list();
    expect(docs[0].createdBy).toEqual({
      email: "ann@example.com",
      name: "Ann",
      role: "owner",
      via: "page",
    });
    expect(docs[0].updatedBy.name).toBeNull();
  });

  it("people.list passes q and limit, and people.get returns a person or null", async () => {
    const { plinth, calls } = boot(server());
    await plinth.ready;
    expect(await plinth.people.list({ q: "an n", limit: 5 })).toEqual(PEOPLE);
    expect(calls.at(-1)).toEqual({ method: "GET", path: "/people?q=an%20n&limit=5" });
    expect(await plinth.people.get(PEOPLE[1]?.id)).toEqual(PEOPLE[1]);
    expect(await plinth.people.get("u_bbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    // A malformed id never reaches the server.
    const before = calls.length;
    expect(await plinth.people.get("../session")).toBeNull();
    expect(calls.length).toBe(before);
  });

  it("refusals become PlinthErrors: forbidden, unavailable, expired", async () => {
    const forbidden = boot(
      server(
        { "/people": { status: 403, body: { error: { code: "forbidden" } } } },
        { ...SESSION, can_list_people: false },
      ),
    );
    expect((await forbidden.plinth.ready).canListPeople).toBe(false);
    await expect(forbidden.plinth.people.list()).rejects.toMatchObject({ code: "forbidden" });
    const off = boot(
      server({
        "/people": {
          status: 403,
          body: { error: { code: "feature_disabled", details: { reason: "not_declared" } } },
        },
      }),
    );
    await expect(off.plinth.people.list()).rejects.toMatchObject({ code: "unavailable" });
    const gone = boot(
      server({ "/people": { status: 401, body: { error: { code: "unauthorized" } } } }),
    );
    await expect(gone.plinth.people.list()).rejects.toMatchObject({ code: "expired" });
    expect(gone.events).toEqual(["plinth:expired"]);
    // A page without shared data: the session says so, and people calls make no request.
    const none = boot(
      server({ "/session": { status: 200, body: { available: false, reason: "not_declared" } } }),
    );
    expect(await none.plinth.ready).toMatchObject({ available: false, canListPeople: false });
    await expect(none.plinth.people.list()).rejects.toMatchObject({ code: "unavailable" });
    expect(none.calls.map((c) => c.path)).toEqual(["/session"]);
  });

  it("under opaque isolation people calls reject without any request", async () => {
    const { plinth, calls } = boot(server(), "null");
    await expect(plinth.people.list()).rejects.toMatchObject({ code: "unavailable" });
    await expect(plinth.people.get(ME)).rejects.toMatchObject({ code: "unavailable" });
    expect(plinth.canListPeople).toBe(false);
    expect(calls).toEqual([]);
  });
});
