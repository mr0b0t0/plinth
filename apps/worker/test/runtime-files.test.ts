// plinth.files in /__plinth/runtime.js, run: the real script against a fake window, clock and
// fetch. Nothing is fetched before first use, opaque isolation answers without a request, uploads
// go in ordered base64 parts with retries and progress, an abort cancels, and error codes map.
import { describe, expect, it } from "vitest";
import { runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

const RUNTIME_SCRIPT = runtimeScript(config());

type Json = Record<string, any>;
interface Reply {
  status: number;
  body?: unknown;
}
type Handler = (method: string, path: string, body: Json | undefined) => Reply | Promise<Reply>;

const SESSION = {
  available: true,
  can_upload: true,
  accept: ["image/png", "video/mp4"],
  limits: {
    max_file_bytes: 1000,
    max_files: 500,
    max_bytes: 100000,
    max_bytes_per_uploader: 10000,
    part_bytes: 4,
  },
  usage: { files: 0, bytes: 0, mine_bytes: 0 },
  seq: 0,
};

const FILE = (id: string, size: number) => ({
  id,
  name: "a.png",
  type: "image/png",
  size,
  url: `/__plinth/files/${id}`,
  mine: true,
  created_at: "2026-11-19T00:00:00.000Z",
});

function boot(handler: Handler, opts: { origin?: string } = {}) {
  const calls: { method: string; path: string; body?: Json }[] = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => unknown }>();
  const win: Json = { addEventListener() {}, dispatchEvent: () => true };
  const doc = { visibilityState: "visible", addEventListener() {} };
  const fakeFetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    expect(url.startsWith("/__plinth/api/v1/files")).toBe(true);
    expect((init.headers as Record<string, string>)["x-plinth-data"]).toBe("1");
    const path = url.slice("/__plinth/api/v1/files".length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const r = await handler(method, path, body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: new Headers(),
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
  const clearT = (id: number) => timers.delete(id);
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    RUNTIME_SCRIPT,
  )(win, { origin: opts.origin ?? "https://a.example" }, doc, fakeFetch, setT, clearT, class {});
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
  const filesCalls = () => calls;
  return { files: win.plinth.files, calls: filesCalls, advance, settle };
}

/** A fake files API: a session, creates with `part_bytes` 4, parts in order, one file list. */
function server(session: Json = SESSION) {
  const parts: { n: number; data: string }[] = [];
  let seq = 0;
  const list: Json[] = [];
  const handler: Handler = (method, path, body) => {
    if (path === "/session") return { status: 200, body: { ...session, seq } };
    if (path === "/changes") return { status: 200, body: { seq } };
    if (method === "POST" && path === "") {
      const p = Math.max(1, Math.ceil(body?.size / 4));
      return {
        status: 201,
        body: { file: { ...FILE("f1", body?.size), state: "pending" }, parts: p, part_bytes: 4 },
      };
    }
    const m = /^\/f1\/parts\/(\d+)$/.exec(path);
    if (method === "PUT" && m) {
      const n = Number(m[1]);
      parts.push({ n, data: body?.data });
      const size = parts.reduce((s, x) => s + atob(x.data).length, 0);
      const total = Math.ceil(size / 4);
      return { status: 200, body: { parts_done: n, parts: total, file: FILE("f1", size) } };
    }
    if (method === "GET" && path.startsWith("?")) {
      return { status: 200, body: { files: list, next_cursor: null } };
    }
    if (method === "DELETE") return { status: 204 };
    return { status: 404, body: { error: { code: "not_found" } } };
  };
  return { handler, parts, list, bump: () => ++seq };
}

const blob = (bytes: number[], type = "image/png", name = "a.png") =>
  Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name });

describe("plinth.files", () => {
  it("fetches nothing before first use, and answers opaque isolation without a request", async () => {
    const s = server();
    const rt = boot(s.handler);
    await rt.settle();
    expect(rt.calls()).toEqual([]);
    expect(await rt.files.ready).toMatchObject({ available: true, canUpload: true });
    expect(rt.calls().map((c) => c.path)).toEqual(["/session"]);

    const opaque = boot(s.handler, { origin: "null" });
    expect(await opaque.files.ready).toEqual({
      available: false,
      reason: "opaque_isolation",
      canUpload: false,
      accept: [],
      limits: null,
      usage: null,
    });
    expect(opaque.calls()).toEqual([]);
    await expect(opaque.files.upload(blob([1]))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("uploads in ordered base64 parts, with progress, and returns the file", async () => {
    const s = server();
    const rt = boot(s.handler);
    const progress: [number, number][] = [];
    const bytes = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6];
    const f = await rt.files.upload(blob(bytes), {
      onProgress: (a: number, b: number) => progress.push([a, b]),
    });
    expect(f).toMatchObject({ id: "f1", name: "a.png", type: "image/png", size: 10, mine: true });
    expect(f.createdAt).toBe("2026-11-19T00:00:00.000Z");
    const create = rt.calls().find((c) => c.method === "POST");
    expect(create?.body).toEqual({ name: "a.png", type: "image/png", size: 10 });
    expect(s.parts.map((p) => p.n)).toEqual([1, 2, 3]);
    const joined = s.parts.flatMap((p) => [...atob(p.data)].map((c) => c.charCodeAt(0)));
    expect(joined).toEqual(bytes);
    expect(progress).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it("refuses a type the page does not accept, too large files and read-only readers before any upload", async () => {
    const s = server();
    const rt = boot(s.handler);
    await expect(rt.files.upload(blob([1], "text/html"))).rejects.toMatchObject({
      code: "unsupported_type",
    });
    await expect(rt.files.upload(blob(new Array(1001).fill(0)))).rejects.toMatchObject({
      code: "too_large",
    });
    expect(rt.calls().some((c) => c.method === "POST")).toBe(false);
    const ro = boot(server({ ...SESSION, can_upload: false }).handler);
    await expect(ro.files.upload(blob([1]))).rejects.toMatchObject({ code: "read_only" });
  });

  it("retries a part on network errors, and cancels the upload when it gives up", async () => {
    const s = server();
    let fails = 0;
    const rt = boot(async (method, path, body) => {
      if (method === "PUT" && fails < 2) {
        fails++;
        throw new Error("offline");
      }
      return s.handler(method, path, body);
    });
    expect((await rt.files.upload(blob([1, 2, 3]))).id).toBe("f1");
    expect(fails).toBe(2);

    const down = boot(async (method, path, body) => {
      if (method === "PUT") throw new Error("offline");
      return s.handler(method, path, body);
    });
    await expect(down.files.upload(blob([1, 2, 3]))).rejects.toMatchObject({ code: "network" });
    expect(down.calls().filter((c) => c.method === "PUT").length).toBe(4);
    expect(down.calls().some((c) => c.method === "DELETE" && c.path === "/f1")).toBe(true);
  });

  it("cancels the pending upload when aborted", async () => {
    const s = server();
    const ctrl = new AbortController();
    const rt = boot(async (method, path, body) => {
      if (method === "PUT") ctrl.abort();
      return s.handler(method, path, body);
    });
    await expect(
      rt.files.upload(blob([1, 2, 3, 4, 5, 6, 7, 8, 9]), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(rt.calls().filter((c) => c.method === "PUT").length).toBe(1);
    expect(rt.calls().some((c) => c.method === "DELETE" && c.path === "/f1")).toBe(true);
  });

  it("maps the server's refusals to error codes", async () => {
    const cases: [Reply, string, Json?][] = [
      [
        {
          status: 400,
          body: { error: { code: "invalid_input", details: { reason: "type_mismatch" } } },
        },
        "type_mismatch",
      ],
      [
        {
          status: 400,
          body: { error: { code: "invalid_input", details: { reason: "unsupported_type" } } },
        },
        "unsupported_type",
      ],
      [
        { status: 403, body: { error: { code: "quota_exceeded", details: { limit: "bytes" } } } },
        "quota_exceeded",
        { limit: "bytes" },
      ],
      [{ status: 413, body: { error: { code: "payload_too_large" } } }, "too_large"],
      [
        {
          status: 404,
          body: { error: { code: "not_found", details: { reason: "not_declared" } } },
        },
        "unavailable",
      ],
      [
        { status: 429, body: { error: { code: "rate_limited", details: { retry_after: 30 } } } },
        "rate_limited",
        { retryAfter: 30 },
      ],
      [{ status: 401, body: { error: { code: "unauthorized" } } }, "expired"],
    ];
    for (const [reply, code, extra] of cases) {
      const s = server();
      const rt = boot((method, path, body) =>
        method === "POST" ? reply : s.handler(method, path, body),
      );
      await expect(rt.files.upload(blob([0x89, 1])), code).rejects.toMatchObject({
        code,
        ...(extra ?? {}),
      });
    }
  });

  it("onSnapshot reads the list, then again when the change counter moves", async () => {
    const s = server();
    const rt = boot(s.handler);
    const seen: number[] = [];
    const stop = rt.files.onSnapshot((list: unknown[]) => seen.push(list.length));
    await rt.settle();
    expect(seen).toEqual([0]);
    s.list.push(FILE("f2", 5));
    await rt.advance(15000);
    expect(seen).toEqual([0]);
    s.bump();
    await rt.advance(15000);
    expect(seen).toEqual([0, 1]);
    stop();
    s.bump();
    await rt.advance(60000);
    expect(seen).toEqual([0, 1]);
    expect(rt.files.url("f2")).toBe("/__plinth/files/f2");
    expect(rt.files.url("f2", { download: true })).toBe("/__plinth/files/f2?download=1");
  });
});
