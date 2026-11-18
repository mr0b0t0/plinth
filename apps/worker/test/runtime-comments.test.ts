// plinth.comments in /__plinth/runtime.js, run: the real script evaluated against a fake window,
// parent, document and clock, so the page side of comments from the page is tested as behaviour.
// The app side is apps/web/src/components/comments/pageChannel.ts and usePageComments.ts.
import { describe, expect, it } from "vitest";
import { PAGE_ANCHOR_VECTORS } from "../../../packages/shared/test/pageAnchorVectors.ts";
import { assembleRuntime } from "../src/content/runtime.ts";

const APP = "https://app.example";
const SCRIPT = assembleRuntime({ appOrigin: APP });

type Json = Record<string, any>;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function boot(opts: { framed?: boolean } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const frames: (() => void)[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const posted: [Json, string][] = [];
  const elements = new Map<string, Rect>();
  const parent = {
    postMessage(msg: Json, target: string) {
      posted.push([JSON.parse(JSON.stringify(msg)), target]);
    },
  };
  const win: Json = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent: () => true,
    requestAnimationFrame(fn: () => void) {
      frames.push(fn);
      return frames.length;
    },
  };
  win.parent = opts.framed === false ? win : parent;
  const doc = {
    visibilityState: "visible",
    addEventListener() {},
    querySelector(sel: string) {
      if (sel === "[bad") throw new Error("SyntaxError");
      const r = elements.get(sel);
      return r ? { getBoundingClientRect: () => r } : null;
    },
  };
  const setT = (fn: () => void, ms = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
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
    "Date",
    SCRIPT,
  )(
    win,
    // An opaque origin: the core never fetches its session, which this test does not need.
    { origin: "null" },
    doc,
    () => Promise.reject(new Error("no fetch")),
    setT,
    clearT,
    class {},
    { now: () => now },
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      if (!first) break;
      timers.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = end;
  };
  const message = (e: unknown) => {
    for (const fn of listeners.get("message") ?? []) fn(e);
  };
  const fromApp = (data: Json, o: { source?: unknown; origin?: string } = {}) =>
    message({
      source: o.source ?? parent,
      origin: o.origin ?? APP,
      data: { source: "plinth-comments", v: 1, ...data },
    });
  const fire = (type: string) => {
    for (const fn of listeners.get(type) ?? []) fn({});
  };
  const runFrames = () => {
    for (const fn of frames.splice(0)) fn();
  };
  const sent = (type?: string) =>
    posted.filter(([m]) => type === undefined || m.type === type).map(([m]) => m);
  return {
    win,
    plinth: win.plinth as Json,
    comments: win.plinth.comments as Json,
    posted,
    sent,
    elements,
    advance,
    fromApp,
    fire,
    runFrames,
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A page that the app welcomed. */
async function welcomed() {
  const t = boot();
  const ready = t.comments.ready;
  t.fromApp({ type: "welcome", available: true });
  expect(await ready).toEqual({ available: true, reason: null });
  return t;
}

const PAGE_THREAD = {
  id: "c1",
  pin: 1,
  status: "open",
  anchor: { kind: "page", key: "canvas", x: 10, y: 20, data: { zoom: 2 } },
};
const ELEMENT_THREAD = {
  id: "c2",
  pin: 2,
  status: "open",
  anchor: { kind: "element", selector: "h1" },
};
const RESOLVED = {
  id: "c3",
  pin: 3,
  status: "resolved",
  anchor: { kind: "page", key: "slide-2" },
};

describe("plinth.comments", () => {
  it("posts nothing until first use, then hello to the app origin only", () => {
    const t = boot();
    expect(t.posted).toEqual([]);
    void t.comments.ready;
    expect(t.posted).toEqual([[{ type: "hello", source: "plinth-comments", v: 1 }, APP]]);
    // Asking again does not say hello again.
    void t.comments.ready;
    expect(t.posted.length).toBe(1);
    for (const [, target] of t.posted) expect(target).not.toBe("*");
  });

  it("is not_framed at the top level, without a post", async () => {
    const t = boot({ framed: false });
    expect(await t.comments.ready).toEqual({ available: false, reason: "not_framed" });
    await expect(t.comments.compose({ key: "a" })).rejects.toMatchObject({ code: "unavailable" });
    expect(t.posted).toEqual([]);
  });

  it("ignores a welcome from another origin or window, and times out as no_app", async () => {
    const t = boot();
    let result: unknown = null;
    t.comments.ready.then((r: unknown) => {
      result = r;
    });
    t.fromApp({ type: "welcome", available: true }, { origin: "https://evil.example" });
    t.fromApp({ type: "welcome", available: true }, { source: {} });
    t.fromApp({ type: "welcome", available: true }, { source: t.win });
    t.fromApp({ type: "welcome", available: true, v: 2 });
    await flush();
    expect(result).toBeNull();
    // Said again while unanswered, then given up on after 3 seconds.
    t.advance(1000);
    expect(t.sent("hello").length).toBe(2);
    t.advance(2000);
    await flush();
    expect(t.sent("hello").length).toBe(3);
    expect(result).toEqual({ available: false, reason: "no_app" });
  });

  it("is not_declared when the app says so", async () => {
    const t = boot();
    const ready = t.comments.ready;
    t.fromApp({ type: "welcome", available: false });
    expect(await ready).toEqual({ available: false, reason: "not_declared" });
    await expect(t.comments.compose()).rejects.toMatchObject({ code: "unavailable" });
    expect(t.sent("compose")).toEqual([]);
  });

  it("checks anchors against the shared rules before posting", async () => {
    const t = await welcomed();
    for (const v of PAGE_ANCHOR_VECTORS) {
      const p = t.comments.compose(v.anchor);
      if (v.ok) {
        await flush();
        const last = t.sent("compose").at(-1);
        expect(last?.anchor, v.name).toEqual(v.anchor);
        void p;
      } else {
        await expect(p, v.name).rejects.toMatchObject({ code: "invalid" });
      }
    }
  });

  it("settles a compose on its own request id, and a second one closes the first", async () => {
    const t = await welcomed();
    const first = t.comments.compose({ key: "canvas", x: 1, y: 2 });
    await flush();
    const req1 = t.sent("compose")[0]?.req;
    expect(req1).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(t.sent("compose")[0]).toEqual({
      type: "compose",
      req: req1,
      anchor: { key: "canvas", x: 1, y: 2 },
      source: "plinth-comments",
      v: 1,
    });
    const second = t.comments.compose();
    await flush();
    expect(await first).toEqual({ status: "closed" });
    const req2 = t.sent("compose")[1]?.req;
    expect(req2).not.toBe(req1);
    expect(t.sent("compose")[1]).not.toHaveProperty("anchor");
    // Another request id, or a malformed answer, settles nothing.
    let settled: unknown = null;
    second.then((r: unknown) => {
      settled = r;
    });
    t.fromApp({ type: "composed", req: req1, status: "posted", id: "x" });
    t.fromApp({ type: "composed", req: req2, status: "posted" });
    t.fromApp({ type: "composed", req: req2, status: "maybe" });
    await flush();
    expect(settled).toBeNull();
    t.fromApp({ type: "composed", req: req2, status: "posted", id: "c9" });
    await flush();
    expect(settled).toEqual({ status: "posted", id: "c9" });
    const busy = t.comments.compose({ key: "a" });
    await flush();
    t.fromApp({ type: "composed", req: t.sent("compose")[2]?.req, status: "busy" });
    expect(await busy).toEqual({ status: "busy" });
  });

  it("tells onThreads about page anchors only, as frozen copies, latest first to late subscribers", async () => {
    const t = await welcomed();
    const seen: Json[][] = [];
    t.comments.onThreads((list: Json[]) => seen.push(list));
    expect(seen).toEqual([[]]);
    t.fromApp({ type: "threads", items: [PAGE_THREAD, ELEMENT_THREAD, RESOLVED, { id: 7 }] });
    const pageOnly = [
      {
        id: "c1",
        pin: 1,
        status: "open",
        anchor: { key: "canvas", x: 10, y: 20, data: { zoom: 2 } },
      },
      { id: "c3", pin: 3, status: "resolved", anchor: { key: "slide-2" } },
    ];
    expect(seen[1]).toEqual(pageOnly);
    const list = seen[1] as Json[];
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list[0]?.anchor.data)).toBe(true);
    expect(() => {
      (list[0] as Json).id = "x";
    }).toThrow();
    const late: Json[][] = [];
    const off = t.comments.onThreads((l: Json[]) => late.push(l));
    expect(late).toEqual([pageOnly]);
    off();
    // A throwing subscriber never breaks the others.
    t.comments.onThreads(() => {
      throw new Error("page bug");
    });
    t.fromApp({ type: "threads", items: [RESOLVED] });
    expect(seen.at(-1)).toEqual([pageOnly[1]]);
    expect(late.length).toBe(1);
    // Over the cap: ignored.
    t.fromApp({ type: "threads", items: Array.from({ length: 501 }, () => RESOLVED) });
    expect(seen.length).toBe(3);
  });

  it("positions page anchors with the locator and element anchors by selector", async () => {
    const t = await welcomed();
    t.elements.set("h1", { left: 5, top: 6, width: 100, height: 20 });
    const bad = { id: "c4", pin: 4, status: "open", anchor: { kind: "page", key: "boom" } };
    const nan = { id: "c5", pin: 5, status: "open", anchor: { kind: "page", key: "nan" } };
    const box = { id: "c6", pin: 6, status: "open", anchor: { kind: "page", key: "box" } };
    const off = { id: "c7", pin: 7, status: "open", anchor: { kind: "element", selector: "[bad" } };
    t.comments.locate((a: Json) => {
      if (a.key === "boom") throw new Error("page bug");
      if (a.key === "nan") return { x: Number.NaN, y: 1 };
      if (a.key === "box") return { left: 1, top: 2, width: 30, height: 40 };
      return { x: a.x * 2, y: a.y * 2 };
    });
    t.fromApp({
      type: "threads",
      items: [PAGE_THREAD, ELEMENT_THREAD, RESOLVED, bad, nan, box, off],
    });
    t.runFrames();
    const items = t.sent("positions").at(-1)?.items;
    const hidden = { left: 0, top: 0, width: 0, height: 0, visible: false };
    expect(items).toEqual([
      { id: "c1", left: 20, top: 40, width: 0, height: 0, visible: true },
      { id: "c2", left: 5, top: 6, width: 100, height: 20, visible: true },
      { id: "c4", ...hidden },
      { id: "c5", ...hidden },
      { id: "c6", left: 1, top: 2, width: 30, height: 40, visible: true },
      { id: "c7", ...hidden },
    ]);
  });

  it("coalesces refresh, caps it at 20 posts a second, and posts only on change", async () => {
    const t = await welcomed();
    let x = 10;
    t.comments.locate(() => ({ x, y: 0 }));
    t.fromApp({ type: "threads", items: [PAGE_THREAD] });
    t.runFrames();
    expect(t.sent("positions").length).toBe(1);
    // Nothing moved: no post.
    t.advance(100);
    t.comments.refresh();
    t.runFrames();
    expect(t.sent("positions").length).toBe(1);
    // Many refreshes in one frame: one run.
    x = 11;
    t.advance(100);
    for (let i = 0; i < 10; i++) t.comments.refresh();
    t.runFrames();
    expect(t.sent("positions").length).toBe(2);
    // Right after a post, the next waits for the 50 ms slot.
    x = 12;
    t.comments.refresh();
    t.runFrames();
    expect(t.sent("positions").length).toBe(2);
    t.advance(50);
    t.runFrames();
    expect(t.sent("positions").length).toBe(3);
    expect(t.sent("positions").at(-1)?.items[0].left).toBe(12);
    // Scrolling and resizing re-measure too (100 ms throttle).
    x = 13;
    t.advance(100);
    t.fire("scroll");
    t.fire("resize");
    t.advance(100);
    t.runFrames();
    expect(t.sent("positions").length).toBe(4);
  });

  it("sends focus to onFocus, and open(id) only for a thread the app listed", async () => {
    const t = await welcomed();
    const focused: Json[] = [];
    t.comments.onFocus((f: Json) => focused.push(f));
    t.fromApp({ type: "threads", items: [PAGE_THREAD, ELEMENT_THREAD] });
    t.fromApp({ type: "focus", id: "c1" });
    t.fromApp({ type: "focus", id: "c2" });
    t.fromApp({ type: "focus", id: "nope" });
    expect(focused).toEqual([
      { id: "c1", anchor: { key: "canvas", x: 10, y: 20, data: { zoom: 2 } } },
    ]);
    expect(Object.isFrozen(focused[0])).toBe(true);
    expect(t.comments.open("c1")).toBe(true);
    expect(t.comments.open("nope")).toBe(false);
    expect(t.comments.open(7)).toBe(false);
    expect(t.sent("open")).toEqual([{ type: "open", id: "c1", source: "plinth-comments", v: 1 }]);
  });

  it("sits next to the other APIs on window.plinth, which stays in place", () => {
    const t = boot();
    expect(Object.keys(t.plinth)).toEqual(
      expect.arrayContaining(["ready", "db", "room", "comments"]),
    );
    expect(() => {
      t.win.plinth = {};
    }).toThrow(TypeError);
    expect(t.win.plinth.comments).toBe(t.comments);
  });
});
