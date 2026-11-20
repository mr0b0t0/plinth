// /__plinth/runtime.js, live views: a page keeps its state across versions (runtime/version.ts).
// The real runtime runs against a fake window: the hello to the app, `update` answered with a hold
// or a carry record, the record read back once as plinth.carried in the next version, its limits
// (16 KiB of state, 30 s, only in the frame the app loaded the record's version in), the scroll
// restored after load, and messages from anywhere but the parent at the app origin ignored.
import {
  LIVE_VIEW_LIMITS,
  VIEW_CARRY_KEY,
  VIEW_FRAME_NAME_PREFIX,
  viewFrameName,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { runtimeScript } from "../src/content/runtime.ts";
import { config } from "./helpers.ts";

const APP = config().appOrigin;
const SCRIPT = runtimeScript(config());
const NONCE = "n".repeat(16);
const KEY = "__plinth_carry";

type Json = Record<string, any>;

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** Evaluate the runtime as a framed page on its content origin. */
function boot(
  opts: {
    framed?: boolean;
    origin?: string;
    storage?: ReturnType<typeof memoryStorage>;
    readyState?: string;
    path?: string;
    scroll?: { x: number; y: number };
    /**
     * The frame's name (window.name), which the app sets to the version it loads there. By
     * default the frame of version 2, which update() moves to.
     */
    name?: string;
  } = {},
) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const posted: [Json, string][] = [];
  const scrolled: [number, number][] = [];
  const storage = opts.storage ?? memoryStorage();
  const parent = {
    postMessage(msg: Json, target: string) {
      posted.push([msg, target]);
    },
  };
  const url = new URL(opts.path ?? "/", "http://art.content.localhost:8787");
  const location = { pathname: url.pathname, search: url.search, hash: url.hash };
  const replaced: string[] = [];
  const win: Json = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent: () => true,
    sessionStorage: storage,
    name: opts.name ?? "plinth-v2",
    location,
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, to: string) {
        replaced.push(to);
        location.hash = to;
      },
    },
    scrollX: opts.scroll?.x ?? 0,
    scrollY: opts.scroll?.y ?? 0,
    scrollTo(x: number, y: number) {
      scrolled.push([x, y]);
    },
    requestAnimationFrame(fn: () => void) {
      fn();
      return 1;
    },
  };
  win.parent = opts.framed === false ? win : parent;
  const doc = {
    visibilityState: "visible",
    readyState: opts.readyState ?? "loading",
    addEventListener() {},
  };
  new Function(
    "window",
    "self",
    "document",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "CustomEvent",
    SCRIPT,
  )(
    win,
    { origin: opts.origin ?? "http://art.content.localhost:8787" },
    doc,
    () => Promise.reject(new Error("no fetch")),
    setTimeout,
    clearTimeout,
    class {},
  );
  const fire = (type: string, e: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  const fromApp = (data: Json) =>
    fire("message", {
      source: parent,
      origin: APP,
      data: { source: "plinth-view", v: 1, ...data },
    });
  const view = () => posted.filter(([m]) => m.source === "plinth-view");
  const answer = async () => {
    for (let i = 0; i < 20 && !view().some(([m]) => m.type !== "hello"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return view().find(([m]) => m.type !== "hello");
  };
  return { win, parent, posted, view, fire, fromApp, answer, storage, scrolled, replaced };
}

const update = (over: Json = {}) => ({
  type: "update",
  from: 1,
  to: 2,
  nonce: NONCE,
  force: false,
  ...over,
});

describe("runtime: new versions", () => {
  it("says hello to the app origin only when framed, and not under opaque isolation", () => {
    const framed = boot();
    expect(framed.view()).toEqual([[{ source: "plinth-view", v: 1, type: "hello" }, APP]]);
    expect(framed.win.plinth.carried).toBeNull();
    expect(typeof framed.win.plinth.onVersion).toBe("function");
    expect(boot({ framed: false }).posted).toEqual([]);
    const opaque = boot({ origin: "null" });
    expect(opaque.view()).toEqual([]);
    // The API is there either way, and does nothing.
    expect(opaque.win.plinth.carried).toBeNull();
    expect(typeof opaque.win.plinth.onVersion(() => undefined)).toBe("function");
  });

  it("records scroll and place, and answers update:ok with the path but never the hash", async () => {
    const p = boot({ path: "/guide.html?tab=2#q=salary%20of%20Jane", scroll: { x: 0, y: 640 } });
    p.fromApp(update());
    const [msg, target] = (await p.answer()) ?? [];
    expect(target).toBe(APP);
    // The path becomes the gate's `next` in request URLs: the fragment stays in this browser.
    expect(msg).toEqual({
      source: "plinth-view",
      v: 1,
      type: "update:ok",
      nonce: NONCE,
      path: "/guide.html?tab=2",
    });
    const rec = JSON.parse(p.storage.getItem(KEY) as string);
    expect(rec).toMatchObject({
      from: 1,
      to: 2,
      scroll: { x: 0, y: 640 },
      path: "/guide.html?tab=2",
      hash: "#q=salary%20of%20Jane",
      state: null,
    });
    expect(Math.abs(Date.now() - rec.at)).toBeLessThan(5000);
  });

  it("puts the hash back on the next version, before the page's scripts, on the same page only", async () => {
    const p = boot({ path: "/#/route/7" });
    p.fromApp(update());
    expect((await p.answer())?.[0]).toMatchObject({ type: "update:ok", path: "/" });
    const rec = p.storage.getItem(KEY) as string;

    // The next version lands on the root: the hash route is restored without a navigation.
    const next = boot({ storage: memoryStorage({ [KEY]: rec }), path: "/index.html" });
    expect(next.replaced).toEqual(["#/route/7"]);
    expect(next.win.location.hash).toBe("#/route/7");

    // Landed somewhere else, or already has a hash of its own: left alone.
    expect(boot({ storage: memoryStorage({ [KEY]: rec }), path: "/other.html" }).replaced).toEqual(
      [],
    );
    expect(boot({ storage: memoryStorage({ [KEY]: rec }), path: "/#mine" }).replaced).toEqual([]);
    // Not a fragment: never handed to replaceState.
    const odd = JSON.stringify({ ...JSON.parse(rec), hash: "//evil.example/" });
    expect(boot({ storage: memoryStorage({ [KEY]: odd }) }).replaced).toEqual([]);
  });

  it("holds when a handler returns false, unless the viewer forced it", async () => {
    const p = boot();
    const seen: Json[] = [];
    p.win.plinth.onVersion((info: Json) => {
      seen.push(info);
      return false;
    });
    p.fromApp(update());
    expect((await p.answer())?.[0]).toEqual({
      source: "plinth-view",
      v: 1,
      type: "update:hold",
      nonce: NONCE,
    });
    expect(p.storage.getItem(KEY)).toBeNull();
    expect(seen).toEqual([{ from: 1, to: 2, force: false }]);

    const q = boot();
    q.win.plinth.onVersion(() => false);
    q.fromApp(update({ force: true }));
    expect((await q.answer())?.[0].type).toBe("update:ok");
    expect(q.storage.getItem(KEY)).not.toBeNull();
  });

  it("hands a page's state to the next version once, as plinth.carried", async () => {
    const p = boot({ scroll: { x: 0, y: 300 } });
    const off = p.win.plinth.onVersion(async () => ({ state: { draft: "half a sentence" } }));
    expect(typeof off).toBe("function");
    p.fromApp(update());
    expect((await p.answer())?.[0].type).toBe("update:ok");

    // The next version, in the same tab and on the same origin, reads it before its own scripts.
    const next = boot({ storage: p.storage, readyState: "loading" });
    expect(next.win.plinth.carried).toEqual({
      from: 1,
      to: 2,
      state: { draft: "half a sentence" },
    });
    expect(next.storage.getItem(KEY)).toBeNull();
    // The scroll comes back after load (and one animation frame).
    expect(next.scrolled).toEqual([]);
    next.fire("load", {});
    expect(next.scrolled).toEqual([[0, 300]]);
    // Read once: a third load gets nothing.
    expect(boot({ storage: p.storage }).win.plinth.carried).toBeNull();
  });

  it("restores the scroll only on the same page; state crosses either way", async () => {
    const p = boot({ path: "/about.html?tab=2", scroll: { x: 0, y: 900 } });
    p.win.plinth.onVersion(() => ({ state: { draft: "kept" } }));
    p.fromApp(update());
    expect((await p.answer())?.[0]).toMatchObject({ type: "update:ok", path: "/about.html?tab=2" });
    const rec = p.storage.getItem(KEY) as string;
    // The new version lacks about.html, so the gate landed it on the root: at the top.
    const root = boot({
      storage: memoryStorage({ [KEY]: rec }),
      path: "/",
      readyState: "complete",
    });
    expect(root.win.plinth.carried).toEqual({ from: 1, to: 2, state: { draft: "kept" } });
    expect(root.scrolled).toEqual([]);
    // Back on the same page, the scroll comes back.
    const same = boot({
      storage: memoryStorage({ [KEY]: rec }),
      path: "/about.html?tab=2",
      readyState: "complete",
    });
    expect(same.scrolled).toEqual([[0, 900]]);
  });

  it("drops state over 16 KiB or not JSON, and keeps the rest of the record", async () => {
    const p = boot();
    p.win.plinth.onVersion(() => ({ state: "x".repeat(16 * 1024 + 1) }));
    p.fromApp(update());
    expect((await p.answer())?.[0].type).toBe("update:ok");
    expect(JSON.parse(p.storage.getItem(KEY) as string).state).toBeNull();

    const q = boot();
    const loop: Json = {};
    loop.self = loop;
    q.win.plinth.onVersion(() => ({ state: loop }));
    q.fromApp(update());
    expect((await q.answer())?.[0].type).toBe("update:ok");
    expect(JSON.parse(q.storage.getItem(KEY) as string).state).toBeNull();
  });

  it("ignores a record older than 30 s, or malformed, and removes it", () => {
    const old = memoryStorage({
      [KEY]: JSON.stringify({ from: 1, to: 2, at: Date.now() - 31_000, scroll: { x: 0, y: 9 } }),
    });
    const p = boot({ storage: old, readyState: "complete" });
    expect(p.win.plinth.carried).toBeNull();
    expect(p.scrolled).toEqual([]);
    expect(old.getItem(KEY)).toBeNull();
    for (const raw of [
      "{",
      '{"from":0,"to":2,"at":1}',
      "null",
      JSON.stringify({ from: 1, to: 2 }),
    ]) {
      const s = memoryStorage({ [KEY]: raw });
      expect(boot({ storage: s }).win.plinth.carried).toBeNull();
      expect(s.getItem(KEY)).toBeNull();
    }
    // A fresh one, after load: the scroll is restored at once.
    const fresh = memoryStorage({
      [KEY]: JSON.stringify({ from: 3, to: 4, at: Date.now(), scroll: { x: 5, y: 7 }, path: "/" }),
    });
    const q = boot({ storage: fresh, readyState: "complete", name: "plinth-v4" });
    expect(q.win.plinth.carried).toEqual({ from: 3, to: 4, state: null });
    expect(q.scrolled).toEqual([[5, 7]]);
  });

  it("reads a record only in the frame the app loaded its version in, and removes it anyway", async () => {
    const p = boot({ name: "plinth-v1", path: "/guide.html#step-2", scroll: { x: 0, y: 400 } });
    p.win.plinth.onVersion(() => ({ state: { draft: "stale" } }));
    p.fromApp(update());
    expect((await p.answer())?.[0].type).toBe("update:ok");
    const rec = p.storage.getItem(KEY) as string;
    // The app held the update or kept the frame: a reload or sub-page of the old frame still has
    // the old frame's name, so it is not that update.
    for (const name of [
      "plinth-v1",
      "plinth-v3",
      "",
      "plinth-v",
      "plinth-v02",
      "plinth-v2x",
      "x",
    ]) {
      const s = memoryStorage({ [KEY]: rec });
      const old = boot({ storage: s, name, path: "/guide.html", readyState: "complete" });
      expect(old.win.plinth.carried, name).toBeNull();
      expect(old.scrolled).toEqual([]);
      expect(old.replaced).toEqual([]);
      expect(s.getItem(KEY)).toBeNull();
    }
    // The frame the app loaded version 2 in takes it.
    const next = boot({ storage: memoryStorage({ [KEY]: rec }), path: "/guide.html" });
    expect(next.win.plinth.carried).toEqual({ from: 1, to: 2, state: { draft: "stale" } });
    expect(next.replaced).toEqual(["#step-2"]);
  });

  it("uses the live-view limits and key from the shared constants", () => {
    // The literals are LIVE_VIEW_LIMITS and VIEW_CARRY_KEY: one place to change them.
    expect(SCRIPT).toContain(`var CARRY_KEY = ${JSON.stringify(VIEW_CARRY_KEY)};`);
    expect(SCRIPT).toContain(`var CARRY_MAX_BYTES = ${LIVE_VIEW_LIMITS.carryMaxBytes};`);
    expect(SCRIPT).toContain(`var CARRY_MAX_AGE_MS = ${LIVE_VIEW_LIMITS.carryMaxAgeS * 1000};`);
    expect(SCRIPT).toContain(`var VERSION_BUDGET_MS = ${LIVE_VIEW_LIMITS.versionBudgetMs};`);
    expect(SCRIPT).toContain(`var FRAME_NAME_PREFIX = ${JSON.stringify(VIEW_FRAME_NAME_PREFIX)};`);
    expect(KEY).toBe(VIEW_CARRY_KEY);
    expect(viewFrameName(2)).toBe("plinth-v2");
  });

  it("answers within the budget when a handler never settles", async () => {
    const p = boot();
    p.win.plinth.onVersion(() => new Promise(() => undefined));
    p.fromApp(update());
    let got: [Json, string] | undefined;
    for (let i = 0; i < 40 && !got; i++) {
      await new Promise((r) => setTimeout(r, 50));
      got = p.view().find(([m]) => m.type !== "hello");
    }
    expect(got?.[0].type).toBe("update:ok");
  });

  it("listens only to the parent at the app origin, and only to well-formed updates", async () => {
    const p = boot();
    const calls: Json[] = [];
    p.win.plinth.onVersion((i: Json) => void calls.push(i));
    const data = { source: "plinth-view", v: 1, ...update() };
    p.fire("message", { source: p.parent, origin: "https://evil.example", data });
    p.fire("message", { source: {}, origin: APP, data });
    p.fire("message", { source: p.win, origin: APP, data });
    for (const bad of [
      update({ nonce: "short" }),
      update({ from: 0 }),
      update({ to: 1.5 }),
      update({ v: 2 }),
      { ...update(), type: "updates" },
    ]) {
      p.fromApp(bad);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    expect(p.view().map(([m]) => m.type)).toEqual(["hello"]);
    expect(() => p.win.plinth.onVersion("nope")).toThrow();
  });
});
