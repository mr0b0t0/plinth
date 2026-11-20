import { PAGE_COMMENTS_SOURCE } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { PAGE_ANCHOR_VECTORS } from "../../../../../packages/shared/test/pageAnchorVectors.ts";
import { connectPageChannel, parsePageAnchor, parsePageMessage } from "./pageChannel.ts";

const ORIGIN = "http://art1.content.localhost:8787";
const REQ = "abcdefghijklmnop0123";
const msg = (data: Record<string, unknown>) => ({ source: PAGE_COMMENTS_SOURCE, v: 1, ...data });

describe("parsePageAnchor", () => {
  it("follows the shared vectors", () => {
    for (const v of PAGE_ANCHOR_VECTORS) {
      expect(parsePageAnchor(v.anchor) !== null, v.name).toBe(v.ok);
    }
    expect(parsePageAnchor({ key: "canvas", x: 3 })).toEqual({ kind: "page", key: "canvas", x: 3 });
  });
});

describe("parsePageMessage", () => {
  it("reads the four frame messages and drops unknown fields", () => {
    expect(parsePageMessage(msg({ type: "hello", extra: 1 }))).toEqual({ type: "hello" });
    expect(parsePageMessage(msg({ type: "compose", req: REQ }))).toEqual({
      type: "compose",
      req: REQ,
      anchor: null,
    });
    expect(
      parsePageMessage(msg({ type: "compose", req: REQ, anchor: { key: "a", y: 2 } })),
    ).toEqual({ type: "compose", req: REQ, anchor: { kind: "page", key: "a", y: 2 } });
    expect(parsePageMessage(msg({ type: "open", id: "c1" }))).toEqual({ type: "open", id: "c1" });
    const item = { id: "c1", left: 1, top: 2, width: 0, height: 0, visible: true };
    expect(parsePageMessage(msg({ type: "positions", items: [item, { id: 5 }] }))).toEqual({
      type: "positions",
      items: [item],
    });
  });

  it("drops a wrong source or version, bad ids and request ids, and invalid anchors", () => {
    const bad = [
      { type: "hello", source: "plinth-bridge", v: 1 },
      { type: "hello", source: PAGE_COMMENTS_SOURCE, v: 2 },
      { type: "hello", source: PAGE_COMMENTS_SOURCE },
      msg({ type: "welcome", available: true }),
      msg({ type: "nope" }),
      msg({ type: "compose" }),
      msg({ type: "compose", req: "short" }),
      msg({ type: "compose", req: `${REQ}!` }),
      msg({ type: "compose", req: "x".repeat(65) }),
      msg({ type: "compose", req: REQ, anchor: { key: "a b" } }),
      msg({ type: "compose", req: REQ, anchor: { key: "a", data: { s: "x".repeat(4096) } } }),
      msg({ type: "compose", req: REQ, anchor: null }),
      msg({ type: "open", id: "" }),
      msg({ type: "open", id: "x".repeat(65) }),
      msg({ type: "open", id: 7 }),
      msg({ type: "positions", items: "x" }),
      msg({ type: "positions", items: Array.from({ length: 501 }, () => ({})) }),
      null,
      "hello",
      [msg({ type: "hello" })],
    ];
    for (const b of bad) expect(parsePageMessage(b), JSON.stringify(b)).toBeNull();
  });

  it("never throws on cyclic or exotic data", () => {
    const cyclic: Record<string, unknown> = { key: "a" };
    cyclic.data = cyclic;
    const getter = Object.defineProperty({}, "type", {
      get() {
        throw new Error("boom");
      },
    });
    const exotic = [
      msg({ type: "compose", req: REQ, anchor: cyclic }),
      Object.assign(Object.create(null), msg({ type: "hello" })),
      { ...msg({}), ...getter },
      getter,
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
      msg({ type: "compose", req: REQ, anchor: { key: "a", x: 10n } }),
    ];
    for (const e of exotic) expect(() => parsePageMessage(e)).not.toThrow();
    expect(parsePageMessage(exotic[0])).toBeNull();
  });
});

describe("connectPageChannel", () => {
  function frameWith(win: object) {
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => win });
    return frame;
  }

  it("hears only its frame at the content origin and posts there, never to *", () => {
    const frameWin = { postMessage: vi.fn() };
    const got: unknown[] = [];
    const ch = connectPageChannel(frameWith(frameWin), ORIGIN, (m) => got.push(m));
    const fire = (origin: string, source: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: msg({ type: "hello" }),
          origin,
          source: source as MessageEventSource,
        }),
      );
    fire(ORIGIN, frameWin);
    fire(ORIGIN, {});
    fire("null", frameWin);
    fire("http://other.content.localhost:8787", frameWin);
    expect(got).toEqual([{ type: "hello" }]);
    ch.post({ type: "welcome", available: true });
    expect(frameWin.postMessage).toHaveBeenCalledWith(
      { type: "welcome", available: true, source: PAGE_COMMENTS_SOURCE, v: 1 },
      ORIGIN,
    );
    ch.destroy();
    fire(ORIGIN, frameWin);
    expect(got.length).toBe(1);
  });

  it("under opaque isolation, hears origin null from its frame's window and posts with *", () => {
    const frameWin = { postMessage: vi.fn() };
    const got: unknown[] = [];
    const ch = connectPageChannel(frameWith(frameWin), ORIGIN, (m) => got.push(m), {
      opaque: true,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: msg({ type: "hello" }),
        origin: "null",
        source: frameWin as unknown as MessageEventSource,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: msg({ type: "hello" }),
        origin: ORIGIN,
        source: frameWin as unknown as MessageEventSource,
      }),
    );
    expect(got).toEqual([{ type: "hello" }]);
    ch.post({ type: "focus", id: "c1" });
    expect(frameWin.postMessage.mock.calls[0]?.[1]).toBe("*");
    ch.destroy();
  });

  it("posts nothing without a usable origin", () => {
    const frameWin = { postMessage: vi.fn() };
    const ch = connectPageChannel(frameWith(frameWin), "*", () => undefined);
    expect(ch.post({ type: "welcome", available: true })).toBe(false);
    expect(frameWin.postMessage).not.toHaveBeenCalled();
    ch.destroy();
  });
});
