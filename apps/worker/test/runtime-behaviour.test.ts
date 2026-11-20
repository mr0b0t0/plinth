// /__plinth/runtime.js, run: the real RUNTIME_SCRIPT evaluated against a fake window, document,
// clock and fetch, so what pages rely on is tested as behaviour rather than as strings: error
// mapping, update() retries, all() paging, the shared poller (interval floor, hidden tabs, stop,
// expiry) and the refetch after the page's own write.
import { describe, expect, it } from "vitest";
import { runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

const RUNTIME_SCRIPT = runtimeScript(config());

type Json = Record<string, any>;
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
type Handler = (method: string, path: string, body: Json | undefined) => Reply | Promise<Reply>;

interface Doc {
  id: string;
  data: Json;
  rev: number;
  created_at: string;
}

const SESSION = {
  available: true,
  viewer: { id: "u_0123456789abcdef01234567", email: "ann@example.com", role: "commenter" },
  can_write: true,
  capabilities: ["data", "viewer"],
  shared: [],
  limits: { max_doc_bytes: 16384, max_docs: 1000, max_bytes: 1048576 },
  usage: { docs: 0, bytes: 0 },
  seq: 0,
};

/** A tiny in-memory stand-in for the page API: one artifact, any collection. */
function fakeServer(session: Json = SESSION) {
  const docs = new Map<string, Doc>();
  let seq = 0;
  let n = 0;
  const view = (d: Doc) => ({
    id: d.id,
    data: d.data,
    rev: d.rev,
    mine: true,
    personal: false,
    created_at: d.created_at,
    updated_at: d.created_at,
  });
  const handler: Handler = (method, path, body) => {
    const url = new URL(`http://x${path}`);
    if (url.pathname === "/session") return { status: 200, body: { ...session, seq } };
    if (url.pathname === "/changes") return { status: 200, body: { seq } };
    const m = /^\/data\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return { status: 404, body: { error: { code: "not_found" } } };
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (!id && method === "GET") {
      return { status: 200, body: { docs: [...docs.values()].map(view), next_cursor: null } };
    }
    if (!id && method === "POST") {
      const d = { id: `d${++n}`, data: body?.data, rev: ++seq, created_at: `t${n}` };
      docs.set(d.id, d);
      return { status: 201, body: view(d) };
    }
    const key = id === "~me" ? "u_me" : (id as string);
    const cur = docs.get(key);
    if (method === "GET") {
      return cur
        ? { status: 200, body: view(cur) }
        : { status: 404, body: { error: { code: "not_found" } } };
    }
    if (method === "DELETE") {
      if (!cur) return { status: 404, body: { error: { code: "not_found" } } };
      docs.delete(key);
      seq++;
      return { status: 204 };
    }
    if (body?.if_rev !== undefined && (cur?.rev ?? 0) !== body.if_rev) {
      return {
        status: 409,
        body: { error: { code: "conflict", details: { current_rev: cur?.rev ?? 0 } } },
      };
    }
    const d = { id: key, data: body?.data, rev: ++seq, created_at: cur?.created_at ?? `t${++n}` };
    docs.set(key, d);
    return { status: cur ? 200 : 201, body: view(d) };
  };
  return { handler, docs, bump: () => ++seq };
}

/** Evaluate the runtime against fakes. `handler` answers every fetch it makes. */
function boot(handler: Handler, opts: { origin?: string; win?: Json } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => unknown }>();
  const docListeners = new Map<string, (() => void)[]>();
  const events: string[] = [];
  const calls: { method: string; path: string; body?: Json; headers: Record<string, string> }[] =
    [];
  const win: Json = {
    addEventListener() {},
    dispatchEvent(e: { type: string }) {
      events.push(e.type);
      return true;
    },
    ...opts.win,
  };
  const doc = {
    visibilityState: "visible",
    addEventListener(type: string, fn: () => void) {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
  };
  class FakeEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  const fakeFetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    expect(url.startsWith("/__plinth/api/v1/")).toBe(true);
    const path = url.slice("/__plinth/api/v1".length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers as Record<string, string> });
    const r = await handler(method, path, body);
    const headers = new Headers(r.headers ?? {});
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("no body");
        return JSON.parse(JSON.stringify(r.body));
      },
    };
  };
  const setT = (fn: () => unknown, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return id;
  };
  const clearT = (id: number) => {
    timers.delete(id);
  };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    RUNTIME_SCRIPT,
  )(win, { origin: opts.origin ?? "https://a.example" }, doc, fakeFetch, setT, clearT, FakeEvent);

  /** Let every pending promise chain settle (the fakes never touch real I/O). */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Move the fake clock forward, running due timers in order, settling after each. */
  const advance = async (ms: number) => {
    const end = now + ms;
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => unknown }] | undefined;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await settle();
    }
    now = end;
  };
  const setVisible = async (visible: boolean) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    await settle();
  };
  const count = (path: string) => calls.filter((c) => c.path === path).length;
  return { plinth: win.plinth, calls, events, advance, settle, setVisible, count, timers };
}

/** A promise with its resolver, for holding a request open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const err = (status: number, body?: unknown, headers?: Record<string, string>): Reply => ({
  status,
  body,
  headers,
});

describe("runtime: ready", () => {
  it("resolves the session, with camelCase fields, and every request carries the header", async () => {
    const { plinth, calls } = boot(fakeServer().handler);
    const s = await plinth.ready;
    expect(s).toEqual({
      available: true,
      reason: null,
      viewer: { id: SESSION.viewer.id, email: "ann@example.com", role: "commenter" },
      canWrite: true,
      capabilities: ["data", "viewer"],
      shared: [],
      limits: { maxDocBytes: 16384, maxDocs: 1000, maxBytes: 1048576 },
      usage: { docs: 0, bytes: 0 },
    });
    expect(plinth.available).toBe(true);
    expect(plinth.viewer).toEqual(s.viewer);
    expect(plinth.canWrite).toBe(true);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/session" });
    expect(calls[0]?.headers["x-plinth-data"]).toBe("1");
  });

  it("never rejects: unavailable, expired and network failures become a reason", async () => {
    const off = boot(() => ({ status: 200, body: { available: false, reason: "not_declared" } }));
    expect(await off.plinth.ready).toMatchObject({ available: false, reason: "not_declared" });
    await expect(off.plinth.db.collection("votes").list()).rejects.toMatchObject({
      code: "unavailable",
    });

    const expired = boot(() => err(401, { error: { code: "unauthorized" } }));
    expect(await expired.plinth.ready).toMatchObject({ available: false, reason: "expired" });
    expect(expired.events).toEqual(["plinth:expired"]);
    await expect(expired.plinth.db.collection("votes").get("a")).rejects.toMatchObject({
      code: "expired",
    });

    const down = boot(() => {
      throw new TypeError("offline");
    });
    expect(await down.plinth.ready).toMatchObject({
      available: false,
      reason: "network",
      viewer: null,
      canWrite: false,
    });
  });

  it("under opaque isolation resolves unavailable without any request", async () => {
    const { plinth, calls } = boot(fakeServer().handler, { origin: "null" });
    expect(await plinth.ready).toMatchObject({ available: false, reason: "opaque_isolation" });
    await expect(plinth.db.collection("votes").add({ v: 1 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("refuses bad collection names and ids before any request", async () => {
    const { plinth, calls } = boot(fakeServer().handler);
    await plinth.ready;
    expect(() => plinth.db.collection("Votes")).toThrow(/Collection/);
    await expect(plinth.db.collection("votes").get("")).rejects.toMatchObject({ code: "invalid" });
    expect(calls.map((c) => c.path)).toEqual(["/session"]);
  });
});

describe("runtime: errors", () => {
  const cases: [string, Reply, Json][] = [
    ["401", err(401, { error: { code: "unauthorized" } }), { code: "expired" }],
    [
      "403 read_only",
      err(403, { error: { code: "forbidden", details: { reason: "read_only" } } }),
      { code: "read_only" },
    ],
    [
      "403 feature_disabled",
      err(403, { error: { code: "feature_disabled" } }),
      { code: "unavailable" },
    ],
    [
      "403 quota_exceeded",
      err(403, { error: { code: "quota_exceeded", details: { limit: "docs" } } }),
      { code: "quota_exceeded", limit: "docs" },
    ],
    [
      "403 forbidden",
      err(403, { error: { code: "forbidden", message: "no" } }),
      { code: "forbidden", message: "no" },
    ],
    ["404", err(404, { error: { code: "not_found" } }), { code: "not_found" }],
    [
      "409",
      err(409, { error: { code: "conflict", details: { current_rev: 7 } } }),
      { code: "conflict", currentRev: 7 },
    ],
    ["413", err(413, { error: { code: "payload_too_large" } }), { code: "too_large" }],
    [
      "429 header",
      err(
        429,
        { error: { code: "rate_limited", details: { retry_after: 12 } } },
        { "retry-after": "30" },
      ),
      { code: "rate_limited", retryAfter: 30 },
    ],
    [
      "429 body",
      err(429, { error: { code: "rate_limited", details: { retry_after: 12 } } }),
      { code: "rate_limited", retryAfter: 12 },
    ],
    ["400", err(400, { error: { code: "invalid_input" } }), { code: "invalid" }],
    ["500", err(500, "not json"), { code: "network" }],
  ];
  for (const [label, reply, want] of cases) {
    it(`maps ${label}`, async () => {
      const server = fakeServer();
      const { plinth } = boot((m, p, b) => (p === "/session" ? server.handler(m, p, b) : reply));
      await plinth.ready;
      const e = await plinth.db
        .collection("votes")
        .set("a", { v: 1 })
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(plinth.PlinthError);
      expect(e).toMatchObject({ name: "PlinthError", ...want });
    });
  }

  it("a failed fetch is a network error; get() turns not_found into null", async () => {
    const server = fakeServer();
    let fail = true;
    const { plinth } = boot((m, p, b) => {
      if (p !== "/session" && fail) throw new TypeError("offline");
      return server.handler(m, p, b);
    });
    await plinth.ready;
    await expect(plinth.db.collection("votes").add({ v: 1 })).rejects.toMatchObject({
      code: "network",
    });
    fail = false;
    expect(await plinth.db.collection("votes").get("missing")).toBeNull();
  });

  it("fires plinth:expired once however many requests expire", async () => {
    const server = fakeServer();
    const { plinth, events } = boot((m, p, b) =>
      p === "/session" ? server.handler(m, p, b) : err(401),
    );
    await plinth.ready;
    const c = plinth.db.collection("votes");
    await Promise.allSettled([c.set("a", {}), c.list(), c.delete("a")]);
    expect(events).toEqual(["plinth:expired"]);
  });
});

describe("runtime: documents", () => {
  it("maps documents and the personal-document helpers", async () => {
    const { plinth, calls } = boot(fakeServer().handler);
    const c = plinth.db.collection("votes");
    const d = await c.setMine({ choice: "x" });
    expect(d).toEqual({
      id: "u_me",
      data: { choice: "x" },
      rev: 1,
      mine: true,
      personal: false,
      createdAt: "t1",
      updatedAt: "t1",
    });
    expect((await c.mine())?.data).toEqual({ choice: "x" });
    await c.deleteMine();
    expect(await c.mine()).toBeNull();
    expect(calls.filter((x) => x.path.includes("~me")).map((x) => x.method)).toEqual([
      "PUT",
      "GET",
      "DELETE",
      "GET",
    ]);
    // ifRev travels as if_rev, on set and on delete.
    await c.set("a", { v: 1 }, { ifRev: 0 });
    await c.delete("a", { ifRev: 4 }).catch(() => undefined);
    expect(calls.find((x) => x.path === "/data/votes/a" && x.method === "PUT")?.body).toEqual({
      data: { v: 1 },
      if_rev: 0,
    });
    expect(calls.some((x) => x.path === "/data/votes/a?if_rev=4")).toBe(true);
  });

  it("update(fn) re-reads and retries on conflict, then gives up", async () => {
    const server = fakeServer();
    let conflicts = 0;
    const { plinth } = boot((m, p, b) => {
      if (m === "PUT" && conflicts > 0) {
        conflicts--;
        // Someone else wrote in between: the doc moves on.
        server.handler("PUT", p, { data: { n: 100 + conflicts } });
        return err(409, { error: { code: "conflict", details: { current_rev: 0 } } });
      }
      return server.handler(m, p, b);
    });
    const c = plinth.db.collection("votes");
    await c.set("a", { n: 1 });
    conflicts = 2;
    const seen: unknown[] = [];
    const out = await c.update("a", (data: Json | null) => {
      seen.push(data);
      return { n: (data?.n ?? 0) + 1 };
    });
    expect(seen).toEqual([{ n: 1 }, { n: 101 }, { n: 100 }]);
    expect(out.data).toEqual({ n: 101 });

    // Always in conflict: one try plus three retries, then the conflict surfaces.
    conflicts = 99;
    let tries = 0;
    await expect(
      c.update("a", () => {
        tries++;
        return { n: 0 };
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(tries).toBe(4);

    // A missing doc is created with if_rev 0.
    conflicts = 0;
    const made = await c.update("new", (data: unknown) => ({ was: data }));
    expect(made.data).toEqual({ was: null });
  });

  it("update(fn) does not retry other errors", async () => {
    const server = fakeServer();
    const { plinth } = boot((m, p, b) =>
      m === "PUT" ? err(403, { error: { code: "forbidden" } }) : server.handler(m, p, b),
    );
    let tries = 0;
    await expect(
      plinth.db.collection("votes").update("a", () => {
        tries++;
        return {};
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(tries).toBe(1);
  });

  it("all() follows cursors and stops at the artifact's document cap", async () => {
    const page = (from: number, count: number, next: string | null): Reply => ({
      status: 200,
      body: {
        docs: Array.from({ length: count }, (_, i) => ({
          id: `d${from + i}`,
          data: {},
          rev: 1,
          mine: false,
          personal: false,
          created_at: "t",
          updated_at: "t",
        })),
        next_cursor: next,
      },
    });
    const pages: Record<string, Reply> = {
      "": page(0, 2, "c1"),
      c1: page(2, 2, "c2"),
      c2: page(4, 1, null),
    };
    const handler = (session: Json) => (_m: string, p: string) => {
      if (p === "/session") return { status: 200, body: session };
      const u = new URL(`http://x${p}`);
      expect(u.searchParams.get("limit")).toBe("200");
      return pages[u.searchParams.get("cursor") ?? ""] ?? err(400);
    };
    const all = boot(handler(SESSION));
    expect((await all.plinth.db.collection("votes").all()).map((d: Doc) => d.id)).toEqual([
      "d0",
      "d1",
      "d2",
      "d3",
      "d4",
    ]);
    expect(all.calls.filter((c) => c.path.startsWith("/data/")).length).toBe(3);

    // The cap applies even when all() is called before ready resolves.
    const capped = boot(handler({ ...SESSION, limits: { ...SESSION.limits, max_docs: 3 } }));
    expect(await capped.plinth.db.collection("votes").all()).toHaveLength(4);
    expect(capped.calls.filter((c) => c.path.startsWith("/data/")).length).toBe(2);
  });
});

describe("runtime: onSnapshot", () => {
  it("delivers at once, then polls /changes every 15 s and refetches only when seq moves", async () => {
    const server = fakeServer();
    const rt = boot(server.handler);
    const got: Doc[][] = [];
    rt.plinth.db.collection("votes").onSnapshot((docs: Doc[]) => got.push(docs));
    await rt.advance(0);
    expect(got).toHaveLength(1);
    await rt.advance(14_999);
    expect(rt.count("/changes")).toBe(0);
    await rt.advance(1);
    expect(rt.count("/changes")).toBe(1);
    expect(got).toHaveLength(1);
    // Someone else writes: the next poll refetches.
    server.handler("PUT", "/data/votes/x", { data: { v: 1 } });
    await rt.advance(15_000);
    expect(got).toHaveLength(2);
    expect(got[1]?.map((d) => d.id)).toEqual(["x"]);
  });

  it("never polls faster than every 10 s", async () => {
    const rt = boot(fakeServer().handler);
    rt.plinth.db.collection("votes").onSnapshot(() => undefined, undefined, { intervalMs: 1000 });
    await rt.advance(9_999);
    expect(rt.count("/changes")).toBe(0);
    await rt.advance(1);
    expect(rt.count("/changes")).toBe(1);
    await rt.advance(10_000);
    expect(rt.count("/changes")).toBe(2);
  });

  it("pauses while the tab is hidden and polls at once when it is shown", async () => {
    const rt = boot(fakeServer().handler);
    rt.plinth.db.collection("votes").onSnapshot(() => undefined);
    await rt.advance(0);
    await rt.setVisible(false);
    await rt.advance(60_000);
    expect(rt.count("/changes")).toBe(0);
    await rt.setVisible(true);
    await rt.advance(0);
    expect(rt.count("/changes")).toBe(1);
    await rt.advance(15_000);
    expect(rt.count("/changes")).toBe(2);
  });

  it("stop() ends the subscription and the polling", async () => {
    const server = fakeServer();
    const rt = boot(server.handler);
    let calls = 0;
    const stop = rt.plinth.db.collection("votes").onSnapshot(() => {
      calls++;
    });
    await rt.advance(0);
    stop();
    server.handler("PUT", "/data/votes/x", { data: {} });
    await rt.advance(60_000);
    expect(rt.count("/changes")).toBe(0);
    expect(calls).toBe(1);
  });

  it("an expired pass is terminal: onError gets expired, polling stops, the event fires", async () => {
    const server = fakeServer();
    let expired = false;
    const rt = boot((m, p, b) =>
      expired && p === "/changes" ? err(401) : server.handler(m, p, b),
    );
    const errors: Json[] = [];
    rt.plinth.db.collection("votes").onSnapshot(
      () => undefined,
      (e: Json) => errors.push(e),
    );
    await rt.advance(0);
    expired = true;
    await rt.advance(15_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "expired" });
    expect(rt.events).toEqual(["plinth:expired"]);
    await rt.advance(60_000);
    expect(rt.count("/changes")).toBe(1);
  });

  it("an unavailable page reports through onError and never polls", async () => {
    const rt = boot(() => ({ status: 200, body: { available: false, reason: "disabled" } }));
    const errors: Json[] = [];
    rt.plinth.db.collection("votes").onSnapshot(
      () => undefined,
      (e: Json) => errors.push(e),
    );
    await rt.advance(60_000);
    expect(errors).toMatchObject([{ code: "unavailable" }]);
    expect(rt.count("/changes")).toBe(0);
  });

  it("a transient failure keeps polling", async () => {
    const server = fakeServer();
    let down = false;
    const rt = boot((m, p, b) => {
      if (down && p === "/changes") throw new TypeError("offline");
      return server.handler(m, p, b);
    });
    const errors: unknown[] = [];
    rt.plinth.db.collection("votes").onSnapshot(
      () => undefined,
      (e: unknown) => errors.push(e),
    );
    await rt.advance(0);
    down = true;
    await rt.advance(15_000);
    down = false;
    await rt.advance(15_000);
    expect(rt.count("/changes")).toBe(2);
    expect(errors).toEqual([]);
  });

  it("refetches at once after the page's own write", async () => {
    const server = fakeServer();
    const rt = boot(server.handler);
    const got: Doc[][] = [];
    const c = rt.plinth.db.collection("votes");
    c.onSnapshot((docs: Doc[]) => got.push(docs));
    await rt.advance(0);
    await c.set("x", { v: 1 });
    await rt.advance(0);
    expect(got.at(-1)?.map((d) => d.id)).toEqual(["x"]);
  });

  it("refetches at once after a write made while a poll is in flight", async () => {
    const server = fakeServer();
    let hold: ReturnType<typeof deferred<Reply>> | null = null;
    const rt = boot((m, p, b) => {
      if (p === "/changes" && hold) {
        // The poll read seq before the write lands, and answers after it.
        const stale = server.handler(m, p, b);
        const h = hold;
        hold = null;
        return h.promise.then(() => stale);
      }
      return server.handler(m, p, b);
    });
    const got: Doc[][] = [];
    const c = rt.plinth.db.collection("votes");
    c.onSnapshot((docs: Doc[]) => got.push(docs));
    await rt.advance(0);
    const gate = deferred<Reply>();
    hold = gate;
    await rt.advance(15_000); // the poll starts and waits
    expect(rt.count("/changes")).toBe(1);
    await c.set("x", { v: 1 }); // the page's own write, while the poll is in flight
    gate.resolve({ status: 200 });
    await rt.advance(0);
    // The poll that was in flight saw the old seq; the queued one sees the write at once.
    expect(rt.count("/changes")).toBe(2);
    expect(got.at(-1)?.map((d) => d.id)).toEqual(["x"]);
  });
});

// ---------- plinth.room ----------

const ROOM_INFO = {
  available: true,
  reason: null,
  you: { viewer: "u_0123456789abcdef01234567", role: "commenter", email: "ann@example.com" },
  can_emit: "open",
  open_topics: ["cursor"],
  limits: {
    max_message_bytes: 8192,
    messages_per_second: 20,
    presence_bytes: 400,
    rooms_per_connection: 3,
  },
};
const YOU = {
  id: "s_me",
  viewer: ROOM_INFO.you.viewer,
  role: "commenter",
  email: "ann@example.com",
};

/** A stand-in for the browser WebSocket: the test plays the server. */
function sockets() {
  const all: FakeSocket[] = [];
  class FakeSocket {
    url: string;
    protocol: string;
    readyState = 0;
    sent: (Json | string)[] = [];
    closedWith: { code: number; reason: string } | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string, protocol: string) {
      this.url = url;
      this.protocol = protocol;
      all.push(this);
    }
    send(s: string) {
      this.sent.push(s === "ping" ? s : JSON.parse(s));
    }
    close(code: number, reason: string) {
      this.readyState = 3;
      this.closedWith = { code, reason };
    }
    /** The handshake succeeds and the room says welcome. */
    welcome(you = YOU) {
      this.readyState = 1;
      this.push({ t: "welcome", v: 1, you, limits: ROOM_INFO.limits });
    }
    push(frame: Json | string) {
      this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
    }
    /** The server (or the network) closes the socket. */
    drop(code: number) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  return { all, FakeSocket, last: () => all[all.length - 1] as FakeSocket };
}

function roomBoot(info: Reply | (() => Reply) = { status: 200, body: ROOM_INFO }, origin?: string) {
  const ws = sockets();
  const data = fakeServer().handler;
  const handler: Handler = (method, path, body) =>
    path === "/room" ? (typeof info === "function" ? info() : info) : data(method, path, body);
  const b = boot(handler, {
    origin,
    win: {
      WebSocket: ws.FakeSocket,
      location: { protocol: "https:", host: "abcdefghij0123456789.content.example" },
    },
  });
  return { ...b, ws, room: b.plinth.room };
}

describe("runtime: plinth.room", () => {
  it("nothing connects until first use; then /room, then one socket to its own origin", async () => {
    const { room, calls, ws, settle } = roomBoot();
    await settle();
    // (The shared-data half reads /session on load; the room asks nothing yet.)
    expect(calls.map((c) => c.path)).toEqual(["/session"]);
    expect(ws.all).toEqual([]);
    const ready = room.ready;
    await settle();
    expect(calls.map((c) => c.path)).toEqual(["/session", "/room"]);
    expect(calls[1]?.headers["x-plinth-data"]).toBe("1");
    expect(ws.all.length).toBe(1);
    expect(ws.last().url).toBe("wss://abcdefghij0123456789.content.example/__plinth/room/v1/page");
    expect(ws.last().protocol).toBe("plinth.room.v1");
    ws.last().welcome();
    const r = await ready;
    expect(r).toMatchObject({ available: true, reason: null, you: YOU });
    expect(r.canEmit("cursor")).toBe(true);
    expect(r.canEmit("note.move")).toBe(false);
    // The main room is joined on first use.
    expect(ws.last().sent).toEqual([{ t: "join", room: "main" }]);
  });

  it("under opaque isolation resolves unavailable without any request or socket", async () => {
    const { room, calls, ws } = roomBoot(undefined, "null");
    expect(await room.ready).toMatchObject({
      available: false,
      reason: "opaque_isolation",
      you: null,
    });
    expect(calls).toEqual([]);
    expect(ws.all).toEqual([]);
  });

  it("unavailable reasons pass through; an expired pass fires plinth:expired; never rejects", async () => {
    const off = roomBoot({ status: 200, body: { available: false, reason: "not_declared" } });
    const r = await off.room.ready;
    expect(r).toMatchObject({ available: false, reason: "not_declared" });
    expect(r.canEmit("cursor")).toBe(false);
    expect(off.ws.all).toEqual([]);
    const statuses: string[] = [];
    off.room.onStatus((s: string) => statuses.push(s));
    expect(statuses).toEqual(["unavailable"]);
    // Calls on an unavailable room are quiet no-ops.
    expect(off.room.emit("cursor", { x: 1 })).toBe(false);

    const expired = roomBoot({ status: 401, body: { error: { code: "unauthorized" } } });
    expect(await expired.room.ready).toMatchObject({ available: false, reason: "expired" });
    expect(expired.events).toEqual(["plinth:expired"]);
  });

  it("presence is merged locally, coalesced to one frame per 100 ms and capped at 400 bytes", async () => {
    const { room, ws, advance, settle } = roomBoot();
    room.ready;
    await settle();
    ws.last().welcome();
    await settle();
    const s = ws.last();
    s.sent = [];
    expect(room.presence({ x: 1, name: "a" })).toBe(true);
    expect(room.presence({ x: 2 })).toBe(true);
    expect(room.presence({ name: null })).toBe(true);
    expect(s.sent).toEqual([]);
    await advance(100);
    expect(s.sent).toEqual([{ t: "presence", room: "main", state: { x: 2, name: null } }]);
    expect(room.presence({ big: "x".repeat(500) })).toBe(false);
    room.presence(null);
    room.presence({ y: 1 });
    await advance(100);
    expect(s.sent.slice(1)).toEqual([
      { t: "presence", room: "main", state: null },
      { t: "presence", room: "main", state: { y: 1 } },
    ]);
    expect(() => room.presence("x")).toThrow(/object or null/);
  });

  it("onPeers gets the list now and on every change, with you marked; untrusted fields stay data", async () => {
    const { room, ws, settle } = roomBoot();
    const seen: Json[][] = [];
    room.onPeers((p: Json[]) => seen.push(p));
    expect(seen).toEqual([[]]);
    await settle();
    const s = ws.last();
    s.welcome();
    s.push({
      t: "peers",
      room: "main",
      peers: [
        { id: "s_me", viewer: YOU.viewer, role: "commenter", email: YOU.email, presence: {} },
        { id: "s_bo", viewer: "u_bo", presence: { x: 1 }, extra: "<img onerror=x>" },
      ],
    });
    expect(seen.at(-1)).toEqual([
      {
        id: "s_me",
        viewer: YOU.viewer,
        you: true,
        role: "commenter",
        email: YOU.email,
        presence: {},
      },
      { id: "s_bo", viewer: "u_bo", you: false, presence: { x: 1 } },
    ]);
    room.presence({ x: 9 });
    expect(seen.at(-1)?.[0]?.presence).toEqual({ x: 9 });
    s.push({ t: "peer", room: "main", peer: { id: "s_bo", viewer: "u_bo", presence: { x: 2 } } });
    expect(seen.at(-1)?.[1]?.presence).toEqual({ x: 2 });
    s.push({ t: "gone", room: "main", id: "s_bo" });
    expect(seen.at(-1)?.map((p) => p.id)).toEqual(["s_me"]);
  });

  it("emit sends only allowed topics while open; on() gets events with the server's from", async () => {
    const { room, ws, settle } = roomBoot();
    const got: unknown[] = [];
    const any: unknown[] = [];
    const off = room.on("cursor", (data: unknown, from: Json) => got.push([data, from]));
    room.on("*", (_d: unknown, _f: unknown, topic: string) => any.push(topic));
    expect(room.emit("cursor", { x: 1 })).toBe(false);
    await settle();
    const s = ws.last();
    s.welcome();
    s.sent = [];
    expect(room.emit("cursor", { x: 1 })).toBe(true);
    expect(room.emit("note.move", { x: 1 })).toBe(false);
    expect(() => room.emit("Bad Topic", 1)).toThrow(/Topic/);
    expect(s.sent).toEqual([{ t: "emit", room: "main", topic: "cursor", data: { x: 1 } }]);
    s.push({
      t: "event",
      room: "main",
      topic: "cursor",
      data: { x: 5 },
      from: { id: "s_bo", viewer: "u_bo" },
    });
    s.push({
      t: "event",
      room: "main",
      topic: "note.saved",
      data: 1,
      from: { id: "s_bo", viewer: "u_bo" },
    });
    expect(got).toEqual([[{ x: 5 }, { id: "s_bo", viewer: "u_bo", you: false }]]);
    expect(any).toEqual(["cursor", "note.saved"]);
    off();
    s.push({
      t: "event",
      room: "main",
      topic: "cursor",
      data: 6,
      from: { id: "s_bo", viewer: "u_bo" },
    });
    expect(got.length).toBe(1);
    // An oversized frame is dropped here, not sent.
    expect(room.emit("cursor", "x".repeat(9000))).toBe(false);
  });

  it("canEmit follows the room's answer: all for editors, open for commenters, none for viewers", async () => {
    const as = async (role: string, canEmit: string, open: string[]) => {
      const body = { ...ROOM_INFO, you: { ...ROOM_INFO.you, role }, can_emit: canEmit };
      const b = roomBoot({ status: 200, body: { ...body, open_topics: open } });
      const ready = b.room.ready;
      await b.settle();
      b.ws.last().welcome({ ...YOU, role });
      return { ...b, r: await ready };
    };
    const owner = await as("owner", "all", []);
    expect(owner.r.canEmit("note.move")).toBe(true);
    expect(owner.r.canEmit("Bad Topic")).toBe(false);
    const editor = await as("editor", "all", ["cursor"]);
    expect(editor.r.canEmit("note.move")).toBe(true);
    const commenter = await as("commenter", "open", ["*"]);
    expect(commenter.r.canEmit("note.move")).toBe(true);
    // A viewer never emits, even when the page opens every topic; presence still goes out.
    const viewer = await as("viewer", "none", ["*"]);
    expect(viewer.r).toMatchObject({ available: true, you: { role: "viewer" } });
    expect(viewer.r.canEmit("cursor")).toBe(false);
    expect(viewer.r.canEmit("note.move")).toBe(false);
    const s = viewer.ws.last();
    s.sent = [];
    expect(viewer.room.emit("cursor", { x: 1 })).toBe(false);
    expect(viewer.room.presence({ x: 1 })).toBe(true);
    await viewer.advance(100);
    expect(s.sent).toEqual([{ t: "presence", room: "main", state: { x: 1 } }]);
  });

  it("reconnects with backoff after a drop, and rejoins with its presence", async () => {
    const { room, ws, advance, settle, count } = roomBoot();
    const statuses: string[] = [];
    room.onStatus((s: string) => statuses.push(s));
    room.ready;
    await settle();
    ws.last().welcome();
    room.presence({ x: 3 });
    await advance(100);
    ws.last().drop(1006);
    expect(statuses).toEqual(["closed", "connecting", "open", "reconnecting"]);
    await advance(700);
    expect(ws.all.length).toBe(1);
    await advance(600);
    expect(ws.all.length).toBe(2);
    // A socket that had opened reconnects without asking /room again.
    expect(count("/room")).toBe(1);
    ws.last().welcome();
    expect(ws.last().sent).toEqual([
      { t: "join", room: "main" },
      { t: "presence", room: "main", state: { x: 3 } },
    ]);
    expect(statuses.at(-1)).toBe("open");
  });

  it("a first socket that never opens resolves ready as network, then keeps trying via /room", async () => {
    const { room, ws, advance, settle, count } = roomBoot();
    const ready = room.ready;
    await settle();
    ws.last().drop(1006);
    expect(await ready).toMatchObject({ available: false, reason: "network" });
    await advance(1300);
    expect(count("/room")).toBe(2);
    expect(ws.all.length).toBe(2);
  });

  it("4401 re-checks /room: still allowed reconnects, expired fires plinth:expired and stops", async () => {
    let answer: Reply = { status: 200, body: ROOM_INFO };
    const { room, ws, settle, events, count } = roomBoot(() => answer);
    room.ready;
    await settle();
    ws.last().welcome();
    ws.last().drop(4401);
    await settle();
    expect(count("/room")).toBe(2);
    expect(ws.all.length).toBe(2);
    ws.last().welcome();
    answer = { status: 401, body: { error: { code: "unauthorized" } } };
    const statuses: string[] = [];
    room.onStatus((s: string) => statuses.push(s));
    ws.last().drop(4401);
    await settle();
    expect(events).toEqual(["plinth:expired"]);
    expect(statuses.at(-1)).toBe("closed");
    expect(ws.all.length).toBe(2);
  });

  it("4409 and 4429 stop; 4410 re-checks the declaration", async () => {
    const full = roomBoot();
    const ready = full.room.ready;
    await full.settle();
    full.ws.last().drop(4409);
    expect(await ready).toMatchObject({ available: false, reason: "full" });
    await full.advance(60_000);
    expect(full.ws.all.length).toBe(1);

    let answer: Reply = { status: 200, body: ROOM_INFO };
    const re = roomBoot(() => answer);
    re.room.ready;
    await re.settle();
    re.ws.last().welcome();
    answer = { status: 200, body: { available: false, reason: "not_declared" } };
    re.ws.last().drop(4410);
    await re.settle();
    expect(re.count("/room")).toBe(2);
    expect(re.ws.all.length).toBe(1);
  });

  it("pings every 30 s; a tab hidden for 60 s closes its socket and reconnects when shown", async () => {
    const { room, ws, advance, settle, setVisible } = roomBoot();
    room.ready;
    await settle();
    ws.last().welcome();
    const first = ws.last();
    first.sent = [];
    await advance(30_000);
    expect(first.sent).toEqual(["ping"]);
    await setVisible(false);
    await advance(59_000);
    expect(first.closedWith).toBeNull();
    await advance(1_000);
    expect(first.closedWith).toEqual({ code: 1000, reason: "hidden" });
    await advance(120_000);
    expect(ws.all.length).toBe(1);
    await setVisible(true);
    expect(ws.all.length).toBe(2);
  });

  it("join(name) opens sub-rooms on the same socket, three at most; leave() leaves", async () => {
    const { room, ws, settle } = roomBoot();
    room.ready;
    const b2 = room.join("board-2");
    expect(room.join("board-2")).toBe(b2);
    room.join("board-3");
    expect(() => room.join("board-4")).toThrow(/at most 3/);
    expect(() => room.join("Board 4")).toThrow(/Room/);
    await settle();
    expect(ws.all.length).toBe(1);
    ws.last().welcome();
    expect(ws.last().sent).toEqual([
      { t: "join", room: "main" },
      { t: "join", room: "board-2" },
      { t: "join", room: "board-3" },
    ]);
    b2.leave();
    expect(ws.last().sent.at(-1)).toEqual({ t: "leave", room: "board-2" });
    // A room left frees its place.
    room.join("board-4");
    expect(ws.last().sent.at(-1)).toEqual({ t: "join", room: "board-4" });
  });
});
