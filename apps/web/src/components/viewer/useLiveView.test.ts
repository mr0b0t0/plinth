import { LIVE_VIEW_LIMITS, type ViewGate } from "@plinth/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LiveViewConnection,
  type LiveViewHandlers,
  type LiveViewStatus,
  useLiveDataRelay,
  useLiveView,
  viewFrameMessage,
  watchUrl,
} from "./useLiveView.ts";
import { versionPollMs } from "./useVersionWatch.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** A stand-in WebSocket: records what it was opened with and sent, and lets a test drive it. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static last(): FakeSocket {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  }
  sent: string[] = [];
  closedWith: number | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocol: string,
  ) {
    FakeSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close(code: number) {
    this.closedWith = code;
  }
  frame(f: unknown) {
    this.onmessage?.({ data: typeof f === "string" ? f : JSON.stringify(f) });
  }
  drop(code: number, reason = "") {
    this.onclose?.({ code, reason });
  }
}

function fakeDoc() {
  const listeners: (() => void)[] = [];
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    set(v: DocumentVisibilityState) {
      doc.visibilityState = v;
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
  return doc;
}

function setup(current = 3) {
  const calls: string[] = [];
  const statuses: LiveViewStatus[] = [];
  const state = { current };
  const on: LiveViewHandlers = {
    onVersion: (n) => calls.push(`version:${n}`),
    onData: () => calls.push("data"),
    onAccessChanged: () => calls.push("access"),
    onGone: () => calls.push("gone"),
    onStatus: (s) => statuses.push(s),
    current: () => state.current,
  };
  const doc = fakeDoc();
  const conn = new LiveViewConnection("ws://app.test/api/v1/view/a1/watch", on, {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    doc: doc as never,
  });
  return { conn, calls, statuses, state, doc };
}

const welcome = (version = 3, data = false) => ({ t: "welcome", v: 1, version, data });

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("watchUrl", () => {
  it("is the app's own host, ws or wss by the page's scheme", () => {
    expect(watchUrl({ protocol: "https:", host: "plinth.example" }, "abc")).toBe(
      "wss://plinth.example/api/v1/view/abc/watch",
    );
    expect(watchUrl({ protocol: "http:", host: "app.localhost:8787" }, "abc")).toBe(
      "ws://app.localhost:8787/api/v1/view/abc/watch",
    );
  });
});

describe("LiveViewConnection", () => {
  it("opens with the plinth.view.v1 subprotocol and is open after the welcome", () => {
    const { conn, calls, statuses } = setup();
    conn.start();
    const s = FakeSocket.last();
    expect(s.url).toBe("ws://app.test/api/v1/view/a1/watch");
    expect(s.protocol).toBe("plinth.view.v1");
    expect(statuses).toEqual(["connecting"]);
    s.frame(welcome());
    expect(statuses).toEqual(["connecting", "open"]);
    // The frame re-reads its data once; no newer version.
    expect(calls).toEqual(["data"]);
    conn.stop();
    expect(s.closedWith).toBe(1000);
  });

  it("a welcome naming a newer version asks for it at once", () => {
    const { conn, calls } = setup(3);
    conn.start();
    FakeSocket.last().frame(welcome(5));
    expect(calls).toEqual(["version:5", "data"]);
    conn.stop();
  });

  it("waits within spread_ms before acting, and joins signals that arrive meanwhile", () => {
    const { conn, calls, state } = setup(3);
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    calls.length = 0;
    s.frame({ t: "version", version: 4, spread_ms: 1000 });
    s.frame({ t: "version", version: 5, spread_ms: 1000 });
    vi.advanceTimersByTime(499);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["version:5"]);
    state.current = 5;
    // An old version is ignored.
    s.frame({ t: "version", version: 5, spread_ms: 0 });
    vi.advanceTimersByTime(10);
    expect(calls).toEqual(["version:5"]);
    s.frame({ t: "data", spread_ms: 200 });
    s.frame({ t: "data", spread_ms: 200 });
    vi.advanceTimersByTime(100);
    expect(calls).toEqual(["version:5", "data"]);
    s.frame({ t: "data", spread_ms: 0 });
    vi.advanceTimersByTime(0);
    expect(calls).toEqual(["version:5", "data", "data"]);
    conn.stop();
  });

  it("a small audience (spread under 100 ms) acts at once", () => {
    const { conn, calls } = setup(3);
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    calls.length = 0;
    s.frame({ t: "version", version: 4, spread_ms: 90 });
    s.frame({ t: "data", spread_ms: 10 });
    expect(calls).toEqual(["version:4", "data"]);
    conn.stop();
  });

  it("ignores frames that are not the server's", () => {
    const { conn, calls } = setup();
    conn.start();
    const s = FakeSocket.last();
    for (const f of [
      "pong",
      "not json",
      { t: "peers", room: "main", peers: [] },
      { t: "version", version: "9", spread_ms: 0 },
      { t: "version", version: 9, spread_ms: 1e9 },
      { t: "welcome", v: 2, version: 9, data: true },
      { t: "access", spread_ms: 1e9 },
      { t: "access", spread_ms: 0 },
    ]) {
      s.frame(f);
    }
    vi.advanceTimersByTime(20_000);
    expect(calls).toEqual([]);
    conn.stop();
  });

  it("pings every 30 s while open", () => {
    const { conn } = setup();
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    vi.advanceTimersByTime(30_000);
    expect(s.sent).toEqual(["ping"]);
    vi.advanceTimersByTime(30_000);
    expect(s.sent).toEqual(["ping", "ping"]);
    conn.stop();
  });

  it("4401 access_changed: re-reads the gate, then reconnects; 4401 expired only reconnects", () => {
    const { conn, calls, statuses } = setup();
    conn.start();
    FakeSocket.last().frame(welcome());
    calls.length = 0;
    // A small audience: the room's `access` frame says to act at once.
    FakeSocket.last().frame({ t: "access", spread_ms: 10 });
    expect(calls).toEqual([]);
    FakeSocket.last().drop(4401, "access_changed");
    expect(calls).toEqual(["access"]);
    expect(statuses.at(-1)).toBe("fallback");
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last().frame(welcome());
    expect(statuses.at(-1)).toBe("open");
    calls.length = 0;
    FakeSocket.last().drop(4401, "expired");
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.all).toHaveLength(3);
    conn.stop();
  });

  it("4401 access_changed after a large audience's `access` frame: the re-read and the reconnect wait within spread_ms", () => {
    const { conn, calls } = setup();
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    calls.length = 0;
    s.frame({ t: "access", spread_ms: 10_000 });
    s.drop(4401, "access_changed");
    // random() is 0.5: the gate re-read waits 5 s, and the reconnect a backoff step after it.
    vi.advanceTimersByTime(4999);
    expect(calls).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["access"]);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    // The next close without an `access` frame of its own takes the widest spread.
    FakeSocket.last().frame(welcome());
    calls.length = 0;
    FakeSocket.last().drop(4401, "access_changed");
    vi.advanceTimersByTime(LIVE_VIEW_LIMITS.spreadMaxMs / 2 - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["access"]);
    conn.stop();
  });

  it("stopping while an access re-read waits cancels it", () => {
    const { conn, calls } = setup();
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    calls.length = 0;
    s.frame({ t: "access", spread_ms: 10_000 });
    s.drop(4401, "access_changed");
    conn.stop();
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("4404: the artifact is gone; it stops", () => {
    const { conn, calls, statuses } = setup();
    conn.start();
    FakeSocket.last().drop(4404, "gone");
    expect(calls).toEqual(["gone"]);
    expect(statuses.at(-1)).toBe("off");
    vi.advanceTimersByTime(600_000);
    expect(FakeSocket.all).toHaveLength(1);
    conn.stop();
  });

  it("4409 and other refusals: polls, and tries the socket again after 5 minutes", () => {
    for (const code of [4409, 4429, 4400, 4403]) {
      FakeSocket.all = [];
      const { conn, statuses } = setup();
      conn.start();
      FakeSocket.last().drop(code, "full");
      expect(statuses.at(-1)).toBe("fallback");
      vi.advanceTimersByTime(299_999);
      expect(FakeSocket.all).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(2);
      conn.stop();
    }
  });

  it("a dropped connection backs off 1, 2, 5, 10, 30 s (with jitter), polling meanwhile", () => {
    const { conn, statuses } = setup();
    conn.start();
    const delays = [1000, 2000, 5000, 10_000, 30_000];
    for (const [i, ms] of delays.entries()) {
      FakeSocket.last().drop(1006);
      expect(statuses.at(-1)).toBe("fallback");
      vi.advanceTimersByTime(ms - 1);
      expect(FakeSocket.all).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(i + 2);
    }
    // A welcome resets the back-off.
    FakeSocket.last().frame(welcome());
    FakeSocket.last().drop(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(7);
    conn.stop();
  });

  it("closes after 60 s hidden and reconnects when shown again", () => {
    const { conn, statuses, doc } = setup();
    conn.start();
    const s = FakeSocket.last();
    s.frame(welcome());
    doc.set("hidden");
    vi.advanceTimersByTime(59_999);
    expect(s.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.closedWith).toBe(1000);
    expect(statuses.at(-1)).toBe("off");
    doc.set("visible");
    expect(FakeSocket.all).toHaveLength(2);
    // Shown again within 60 s: the socket stays.
    FakeSocket.last().frame(welcome());
    doc.set("hidden");
    vi.advanceTimersByTime(30_000);
    doc.set("visible");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.last().closedWith).toBeNull();
    conn.stop();
    expect(doc.listeners).toHaveLength(0);
  });

  it("without WebSocket it falls back at once", () => {
    const statuses: LiveViewStatus[] = [];
    const conn = new LiveViewConnection(
      "ws://x/watch",
      {
        onVersion: () => undefined,
        onData: () => undefined,
        onAccessChanged: () => undefined,
        onGone: () => undefined,
        onStatus: (s) => statuses.push(s),
        current: () => 1,
      },
      { WebSocket: undefined, doc: fakeDoc() as never },
    );
    conn.start();
    expect(statuses).toEqual(["fallback"]);
  });
});

const gate = (over: Partial<OkGate> = {}): OkGate => ({
  status: "ok",
  artifact: {
    id: "a1",
    slug: "s",
    title: "T",
    type: "html",
    current_version: 3,
    version: 3,
    visibility: "unlisted",
    owner_name: null,
  },
  enter_url: "http://a1.content.test/__plinth/enter?t=x",
  role: null,
  ...over,
});

describe("useLiveView", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const handlers = () => ({
    onVersion: vi.fn(),
    onData: vi.fn(),
    onAccessChanged: vi.fn(),
    onGone: vi.fn(),
  });

  it("opens no socket without gate.watch", () => {
    const { result } = renderHook(() => useLiveView({ gate: gate(), ...handlers() }));
    expect(result.current).toBe("off");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("opens one socket for the artifact, reports open, and closes on unmount", () => {
    const h = handlers();
    const { result, unmount, rerender } = renderHook(({ g }) => useLiveView({ gate: g, ...h }), {
      initialProps: { g: gate({ watch: true }) },
    });
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.last().url).toBe(`ws://${window.location.host}/api/v1/view/a1/watch`);
    act(() => FakeSocket.last().frame(welcome(4)));
    expect(result.current).toBe("open");
    expect(h.onVersion).toHaveBeenCalledWith(4);
    expect(h.onData).toHaveBeenCalledTimes(1);
    // A new gate for the same artifact (a new version) keeps the socket...
    rerender({ g: gate({ watch: true, enter_url: "http://other" }) });
    expect(FakeSocket.all).toHaveLength(1);
    // ...one that now shows shared data reconnects, so the room grants the data right.
    rerender({
      g: gate({
        watch: true,
        data: { available: true, capabilities: ["data"], identified: false, can_write: false },
      }),
    });
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]?.closedWith).toBe(1000);
    unmount();
    expect(FakeSocket.last().closedWith).toBe(1000);
  });

  it("polls the gate every 15 s, or every 5 minutes as a backstop while open", () => {
    expect(versionPollMs("off")).toBe(15_000);
    expect(versionPollMs("connecting")).toBe(15_000);
    expect(versionPollMs("fallback")).toBe(15_000);
    expect(versionPollMs("open")).toBe(300_000);
  });
});

describe("useLiveDataRelay", () => {
  function frameWith(post: (m: unknown, target: string) => void) {
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    return frame;
  }

  it("posts push on mount and on load, and data when the tick moves, at the exact origin", () => {
    const posts: [unknown, string][] = [];
    const frame = frameWith((m, t) => posts.push([m, t]));
    const origin = "http://a1.content.test";
    const { rerender } = renderHook(
      ({ tick, pushed }) =>
        useLiveDataRelay({ frame, contentOrigin: origin, enabled: true, pushed, dataTick: tick }),
      { initialProps: { tick: 0, pushed: false } },
    );
    expect(posts).toEqual([[viewFrameMessage({ type: "push", on: false }), origin]]);
    rerender({ tick: 0, pushed: true });
    expect(posts.at(-1)).toEqual([{ source: "plinth-view", v: 1, type: "push", on: true }, origin]);
    frame.dispatchEvent(new Event("load"));
    expect(posts.at(-1)).toEqual([viewFrameMessage({ type: "push", on: true }), origin]);
    const before = posts.length;
    rerender({ tick: 1, pushed: true });
    expect(posts.slice(before)).toEqual([[{ source: "plinth-view", v: 1, type: "data" }, origin]]);
    expect(posts.every(([, t]) => t === origin)).toBe(true);
  });

  it("posts nothing when disabled (opaque isolation, no shared data) or without an exact origin", () => {
    const posts: unknown[] = [];
    const frame = frameWith((m) => posts.push(m));
    for (const [enabled, origin] of [
      [false, "http://a1.content.test"],
      [true, "null"],
      [true, "*"],
      [true, ""],
    ] as const) {
      const { rerender, unmount } = renderHook(
        ({ tick }) =>
          useLiveDataRelay({ frame, contentOrigin: origin, enabled, pushed: true, dataTick: tick }),
        { initialProps: { tick: 0 } },
      );
      rerender({ tick: 1 });
      frame.dispatchEvent(new Event("load"));
      unmount();
    }
    expect(posts).toEqual([]);
  });
});
