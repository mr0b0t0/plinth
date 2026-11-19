// plinth.requests in /__plinth/runtime.js (docs/spec.md "Page requests"), run: the real script
// against a fake window, clock and fetch. The fragment is served only where page requests are in
// effect; nothing is fetched before first use; opaque isolation answers without a request; errors
// map to PlinthError codes and a 401 fires plinth:expired; onChange polls only while a request is
// open and the tab is visible; requests carry no author fields.
import { describe, expect, it } from "vitest";
import { RUNTIME_FRAGMENTS, runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

const ON = { ...config(), allowPageRequests: true, contentIsolation: "origin" as const };
const SCRIPT = runtimeScript(ON);

type Json = Record<string, any>;
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
type Handler = (method: string, path: string, body: Json | undefined) => Reply | Promise<Reply>;

const INFO = (requests: Json[] = []) => ({
  available: true,
  reason: null,
  can_file: true,
  to: "claude",
  limits: { max_body_chars: 4000, max_data_bytes: 8192, per_hour: 10, max_open: 3 },
  requests,
});
const REQ = (id: string, state = "pending", answers: Json[] = []) => ({
  id,
  state,
  resolved: false,
  to: "@claude",
  body: "Add Q3",
  data: null,
  version: 1,
  result_version: null,
  created_at: "2026-11-19T00:00:00.000Z",
  completed_at: null,
  answers,
});

function boot(handler: Handler, opts: { origin?: string; script?: string } = {}) {
  const calls: { method: string; path: string; body?: Json }[] = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => unknown }>();
  const events: string[] = [];
  const docListeners: (() => void)[] = [];
  const win: Json = {
    addEventListener() {},
    dispatchEvent: (e: { type?: string }) => {
      events.push(e.type ?? "");
      return true;
    },
  };
  const doc: Json = {
    visibilityState: "visible",
    addEventListener(type: string, fn: () => void) {
      if (type === "visibilitychange") docListeners.push(fn);
    },
  };
  const fakeFetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    if (!url.startsWith("/__plinth/api/v1/requests")) {
      return { status: 404, ok: false, headers: new Headers(), json: async () => ({}) };
    }
    expect((init.headers as Record<string, string>)["x-plinth-data"]).toBe("1");
    const path = url.slice("/__plinth/api/v1/requests".length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const r = await handler(method, path, body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: new Headers(r.headers ?? {}),
      json: async () => JSON.parse(JSON.stringify(r.body ?? null)),
    };
  };
  const setT = (fn: () => unknown, ms?: number) => {
    const id = nextId++;
    timers.set(id, { at: now + (ms ?? 0), fn });
    return id;
  };
  const clearT = (id: number) => timers.delete(id);
  class CustomEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    opts.script ?? SCRIPT,
  )(win, { origin: opts.origin ?? "https://a.example" }, doc, fakeFetch, setT, clearT, CustomEvent);
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
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
  const hide = (hidden: boolean) => {
    doc.visibilityState = hidden ? "hidden" : "visible";
    for (const fn of docListeners) fn();
  };
  return { win, requests: win.plinth.requests, calls, advance, settle, events, hide };
}

describe("plinth.requests", () => {
  it("is served only where page requests are in effect", () => {
    expect(RUNTIME_FRAGMENTS.map((f) => f.name)).toContain("requests");
    const off = runtimeScript(config());
    expect(config().allowPageRequests).toBe(false);
    expect(off).not.toContain("plinth.requests");
    expect(runtimeScript({ ...ON, contentIsolation: "opaque" })).toBe(off);
    expect(SCRIPT).toContain("plinth.requests");
    expect(SCRIPT.startsWith(off.slice(0, off.indexOf("  Object.defineProperty(window")))).toBe(
      true,
    );
    // Without the fragment the page has no plinth.requests at all.
    const b = boot(() => ({ status: 404 }), { script: off });
    expect(b.requests).toBeUndefined();
    // Still one small static file with every fragment in it.
    expect(SCRIPT.length).toBeLessThan(80 * 1024);
  });

  it("fetches nothing before first use; ready never rejects; opaque answers without a request", async () => {
    const b = boot(() => ({ status: 200, body: INFO() }));
    await b.settle();
    expect(b.calls).toEqual([]);
    const s = await b.requests.ready;
    expect(s).toEqual({
      available: true,
      reason: null,
      canFile: true,
      to: "claude",
      limits: { maxBodyChars: 4000, maxDataBytes: 8192, perHour: 10, maxOpen: 3 },
    });
    expect(b.calls).toHaveLength(1);

    const o = boot(() => ({ status: 200, body: INFO() }), { origin: "null" });
    expect(await o.requests.ready).toMatchObject({ available: false, reason: "opaque_isolation" });
    expect(o.calls).toEqual([]);

    const off = boot(() => ({ status: 200, body: { available: false, reason: "not_identified" } }));
    expect(await off.requests.ready).toMatchObject({ available: false, reason: "not_identified" });
    await expect(off.requests.file({ body: "x" })).rejects.toMatchObject({ code: "unavailable" });

    const down = boot(() => {
      throw new Error("offline");
    });
    expect(await down.requests.ready).toMatchObject({ available: false, reason: "network" });
  });

  it("files, maps refusals to PlinthError codes, and fires plinth:expired on a 401", async () => {
    let next: Reply = { status: 201, body: REQ("r1") };
    const b = boot((method) => (method === "GET" ? { status: 200, body: INFO() } : next));
    const r = await b.requests.file({ body: "Add Q3", data: { q: 3 } });
    expect(r).toEqual({
      id: "r1",
      state: "pending",
      resolved: false,
      to: "@claude",
      body: "Add Q3",
      data: null,
      version: 1,
      resultVersion: null,
      createdAt: "2026-11-19T00:00:00.000Z",
      completedAt: null,
      answers: [],
    });
    expect(b.calls.at(-1)).toEqual({
      method: "POST",
      path: "",
      body: { body: "Add Q3", data: { q: 3 } },
    });
    next = {
      status: 403,
      body: { error: { code: "forbidden", details: { reason: "cannot_file" } } },
    };
    await expect(b.requests.file({ body: "x" })).rejects.toMatchObject({ code: "forbidden" });
    next = {
      status: 429,
      body: { error: { code: "rate_limited", details: { reason: "per_viewer", retry_after: 60 } } },
      headers: { "retry-after": "60" },
    };
    await expect(b.requests.file({ body: "x" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfter: 60,
    });
    next = { status: 401, body: { error: { code: "unauthorized" } } };
    await expect(b.requests.file({ body: "x" })).rejects.toMatchObject({ code: "expired" });
    expect(b.events).toContain("plinth:expired");
  });

  it("get returns null for 404; answers carry no author keys", async () => {
    const b = boot((_m, path) =>
      path === ""
        ? { status: 200, body: INFO() }
        : path === "/r1"
          ? {
              status: 200,
              body: REQ("r1", "done", [{ body: "Done", created_at: "2026-11-19T01:00:00.000Z" }]),
            }
          : { status: 404, body: { error: { code: "not_found" } } },
    );
    const one = await b.requests.get("r1");
    expect(one.answers).toEqual([{ body: "Done", createdAt: "2026-11-19T01:00:00.000Z" }]);
    for (const a of one.answers) expect(Object.keys(a).sort()).toEqual(["body", "createdAt"]);
    expect(Object.keys(one).sort()).toEqual(
      [
        "answers",
        "body",
        "completedAt",
        "createdAt",
        "data",
        "id",
        "resolved",
        "resultVersion",
        "state",
        "to",
        "version",
      ].sort(),
    );
    expect(await b.requests.get("nope")).toBeNull();
  });

  it("onChange polls only while a request is open and the tab is visible", async () => {
    let list: Json[] = [REQ("r1", "pending")];
    const b = boot(() => ({ status: 200, body: INFO(list) }));
    const seen: Json[][] = [];
    const stop = b.requests.onChange((l: Json[]) => seen.push(l), undefined, { intervalMs: 1000 });
    await b.advance(0);
    expect(seen).toHaveLength(1);
    const before = b.calls.length;
    // Polls at the floor (15 s), not the 1 s asked for; nothing changed, so no new delivery.
    await b.advance(15_000);
    expect(b.calls.length).toBe(before + 1);
    expect(seen).toHaveLength(1);
    // The request is answered: one delivery, then polling stops (nothing open).
    list = [REQ("r1", "done", [{ body: "Done", created_at: "2026-11-19T01:00:00.000Z" }])];
    await b.advance(30_000);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.[0]?.answers).toEqual([
      { body: "Done", createdAt: "2026-11-19T01:00:00.000Z" },
    ]);
    const idle = b.calls.length;
    await b.advance(120_000);
    expect(b.calls.length).toBe(idle);
    // A new request wakes it at once.
    list = [REQ("r2", "pending"), ...list];
    await b.requests.file({ body: "again" }).catch(() => undefined);
    await b.advance(0);
    expect(seen.at(-1)?.[0]?.id).toBe("r2");
    // Hidden: no polling; visible again: it resumes.
    b.hide(true);
    const hiddenAt = b.calls.length;
    await b.advance(120_000);
    expect(b.calls.length).toBe(hiddenAt);
    b.hide(false);
    await b.advance(0);
    expect(b.calls.length).toBeGreaterThan(hiddenAt);
    stop();
    const stopped = b.calls.length;
    await b.advance(120_000);
    expect(b.calls.length).toBe(stopped);
  });
});
