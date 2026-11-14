import { BRIDGE_MESSAGE_SOURCE } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectBridge, isExactOrigin, parseFrameMessage } from "./bridge.ts";

const ORIGIN = "http://abc123.content.localhost:8787";
const msg = (m: Record<string, unknown>) => ({ source: BRIDGE_MESSAGE_SOURCE, v: 1, ...m });

describe("parseFrameMessage", () => {
  it("accepts the three frame messages", () => {
    expect(parseFrameMessage(msg({ type: "ready" }))).toEqual({ type: "ready" });
    expect(
      parseFrameMessage(
        msg({ type: "pick", anchor: { selector: "h1", text: "Hello", x: 0.25, y: 1 } }),
      ),
    ).toEqual({ type: "pick", anchor: { selector: "h1", text: "Hello", x: 0.25, y: 1 } });
    expect(
      parseFrameMessage(
        msg({
          type: "positions",
          items: [{ id: "c1", top: 10, left: -5, width: 100, height: 20, visible: true }],
        }),
      ),
    ).toEqual({
      type: "positions",
      items: [{ id: "c1", top: 10, left: -5, width: 100, height: 20, visible: true }],
    });
  });

  it("rejects the wrong tag, version or type", () => {
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage("ready")).toBeNull();
    expect(parseFrameMessage([])).toBeNull();
    expect(parseFrameMessage({ source: "other", v: 1, type: "ready" })).toBeNull();
    expect(parseFrameMessage({ source: BRIDGE_MESSAGE_SOURCE, v: 2, type: "ready" })).toBeNull();
    expect(parseFrameMessage({ source: BRIDGE_MESSAGE_SOURCE, v: "1", type: "ready" })).toBeNull();
    expect(parseFrameMessage(msg({ type: "pick:start" }))).toBeNull();
    expect(parseFrameMessage(msg({ type: "highlight", anchors: [] }))).toBeNull();
  });

  it("validates pick anchors field by field", () => {
    const pick = (anchor: unknown) => parseFrameMessage(msg({ type: "pick", anchor }));
    expect(pick(undefined)).toBeNull();
    expect(pick({ selector: "", x: 0, y: 0 })).toBeNull();
    expect(pick({ selector: 5, x: 0, y: 0 })).toBeNull();
    expect(pick({ selector: "a".repeat(1001), x: 0, y: 0 })).toBeNull();
    expect(pick({ selector: "h1", text: "t".repeat(501), x: 0, y: 0 })).toBeNull();
    expect(pick({ selector: "h1", text: {}, x: 0, y: 0 })).toBeNull();
    expect(pick({ selector: "h1", x: 1.5, y: 0 })).toBeNull();
    expect(pick({ selector: "h1", x: Number.NaN, y: 0 })).toBeNull();
    expect(pick({ selector: "h1", x: "0", y: 0 })).toBeNull();
    expect(pick({ selector: "h1", x: 0, y: 0 })).toEqual({
      type: "pick",
      anchor: { selector: "h1", text: "", x: 0, y: 0 },
    });
  });

  it("drops malformed position items and refuses oversized lists", () => {
    const good = { id: "c1", top: 1, left: 2, width: 3, height: 4, visible: false };
    const parsed = parseFrameMessage(
      msg({
        type: "positions",
        items: [
          good,
          { ...good, id: "" },
          { ...good, id: 7 },
          { ...good, id: "x".repeat(65) },
          { ...good, top: Number.POSITIVE_INFINITY },
          { ...good, width: -1 },
          { ...good, height: 2_000_000 },
          { ...good, visible: "yes" },
          "<img src=x>",
        ],
      }),
    );
    expect(parsed).toEqual({ type: "positions", items: [good] });
    expect(
      parseFrameMessage(msg({ type: "positions", items: Array.from({ length: 501 }, () => good) })),
    ).toBeNull();
    expect(parseFrameMessage(msg({ type: "positions", items: "nope" }))).toBeNull();
  });
});

describe("isExactOrigin", () => {
  it("accepts exact http(s) origins only", () => {
    expect(isExactOrigin(ORIGIN)).toBe(true);
    expect(isExactOrigin("https://x.example.net")).toBe(true);
    expect(isExactOrigin("*")).toBe(false);
    expect(isExactOrigin("")).toBe(false);
    expect(isExactOrigin("null")).toBe(false);
    expect(isExactOrigin(`${ORIGIN}/`)).toBe(false);
    expect(isExactOrigin(`${ORIGIN}/path`)).toBe(false);
    expect(isExactOrigin("javascript:alert(1)")).toBe(false);
  });
});

describe("connectBridge", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function setup(origin = ORIGIN, opts: { opaque?: boolean } = {}) {
    const frameWin = { postMessage: vi.fn() };
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { value: frameWin, configurable: true });
    const onMessage = vi.fn();
    const client = connectBridge(frame, origin, { onMessage }, opts);
    cleanups.push(() => client.destroy());
    const deliver = (data: unknown, o: { origin?: string; source?: unknown } = {}) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: o.origin ?? (opts.opaque ? "null" : origin),
          source: (o.source ?? frameWin) as MessageEventSource,
        }),
      );
    return { frameWin, client, onMessage, deliver };
  }

  describe("under opaque isolation", () => {
    it("accepts origin null, but only from the frame's own window", () => {
      const { onMessage, deliver } = setup(ORIGIN, { opaque: true });
      // An opaque document never reports the artifact origin; anything else is not the frame.
      deliver(msg({ type: "ready" }), { origin: ORIGIN });
      deliver(msg({ type: "ready" }), { origin: "http://app.localhost:8787" });
      deliver(msg({ type: "ready" }), { source: window });
      deliver(msg({ type: "ready" }), { source: { postMessage() {} } });
      deliver({ type: "ready" });
      expect(onMessage).not.toHaveBeenCalled();
      deliver(msg({ type: "ready" }));
      expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
      // Still validated as untrusted data.
      deliver(msg({ type: "pick", anchor: { selector: "", x: 0, y: 0 } }));
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it("posts to * (an opaque origin cannot be named), only the non-secret bridge messages", () => {
      const { frameWin, client } = setup(ORIGIN, { opaque: true });
      expect(client.post({ type: "highlight", anchors: [{ id: "c1", selector: "h1" }] })).toBe(
        true,
      );
      expect(frameWin.postMessage).toHaveBeenCalledWith(
        {
          type: "highlight",
          anchors: [{ id: "c1", selector: "h1" }],
          source: BRIDGE_MESSAGE_SOURCE,
          v: 1,
        },
        "*",
      );
    });

    it("does nothing without a content origin", () => {
      const { frameWin, client, onMessage, deliver } = setup("", { opaque: true });
      expect(client.post({ type: "pick:start" })).toBe(false);
      deliver(msg({ type: "ready" }));
      expect(frameWin.postMessage).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  it("posts to the content origin only, with the protocol tag", () => {
    const { frameWin, client } = setup();
    expect(client.post({ type: "pick:start" })).toBe(true);
    expect(frameWin.postMessage).toHaveBeenCalledWith(
      { type: "pick:start", source: BRIDGE_MESSAGE_SOURCE, v: 1 },
      ORIGIN,
    );
    for (const call of frameWin.postMessage.mock.calls) expect(call[1]).not.toBe("*");
  });

  it("never posts when the origin is not exact", () => {
    const { frameWin, client } = setup("*");
    expect(client.post({ type: "pick:start" })).toBe(false);
    expect(frameWin.postMessage).not.toHaveBeenCalled();
  });

  it("accepts a message only from the content origin and the frame's own window", () => {
    const { onMessage, deliver } = setup();
    deliver(msg({ type: "ready" }), { origin: "http://evil.content.localhost:8787" });
    deliver(msg({ type: "ready" }), { origin: "http://app.localhost:8787" });
    deliver(msg({ type: "ready" }), { source: window });
    deliver(msg({ type: "ready" }), { source: { postMessage() {} } });
    deliver({ type: "ready" });
    expect(onMessage).not.toHaveBeenCalled();
    deliver(msg({ type: "ready" }));
    expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
  });

  it("stops listening after destroy", () => {
    const { client, onMessage, deliver } = setup();
    client.destroy();
    deliver(msg({ type: "ready" }));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
