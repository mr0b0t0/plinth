import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectMessage,
  editMessage,
  editTargetOrigin,
  type LiveFrameStatus,
  newNonce,
  postPrint,
  postToRenderer,
  printMessage,
  readFrameMessage,
  rendererTargetOrigin,
} from "./rendererProtocol.ts";
import { CONFIG } from "./test-utils.ts";

const ORIGIN = "http://art123.content.localhost:8787";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer protocol", () => {
  it("builds the print message the doc renderer accepts", () => {
    expect(printMessage()).toEqual({ source: "plinth-renderer", v: 1, type: "print" });
  });

  it("addresses the exact content origin under origin isolation", () => {
    expect(rendererTargetOrigin(CONFIG, ORIGIN)).toBe(ORIGIN);
    // Before the config has loaded the default (origin) mode applies.
    expect(rendererTargetOrigin(null, ORIGIN)).toBe(ORIGIN);
  });

  it("posts to '*' under opaque isolation and the path fallback, whose frames are 'null'", () => {
    expect(rendererTargetOrigin({ ...CONFIG, content_isolation: "opaque" }, ORIGIN)).toBe("*");
    expect(
      rendererTargetOrigin(
        { ...CONFIG, content_path_fallback: true, content_isolation: "opaque" },
        CONFIG.app_origin,
      ),
    ).toBe("*");
    expect(rendererTargetOrigin({ ...CONFIG, content_path_fallback: true }, "")).toBe("*");
  });

  it("refuses to guess an origin it does not know", () => {
    expect(rendererTargetOrigin(CONFIG, "")).toBeNull();
    expect(rendererTargetOrigin(CONFIG, "null")).toBeNull();
    expect(rendererTargetOrigin(CONFIG, "*")).toBeNull();
  });

  it("posts the print message to the frame's window only", () => {
    const frame = document.createElement("iframe");
    const toFrame = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: toFrame } });
    const toApp = vi.spyOn(window, "postMessage");
    expect(postPrint(frame, ORIGIN)).toBe(true);
    expect(toFrame).toHaveBeenCalledTimes(1);
    expect(toFrame).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "print" },
      ORIGIN,
    );
    expect(toApp).not.toHaveBeenCalled();
  });

  it("does nothing without a frame or a target", () => {
    expect(postPrint(null, ORIGIN)).toBe(false);
    const frame = document.createElement("iframe");
    const toFrame = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: toFrame } });
    expect(postPrint(frame, null)).toBe(false);
    expect(toFrame).not.toHaveBeenCalled();
  });
});

describe("renderer protocol: on-page editing (#36)", () => {
  const base = { source: "plinth-renderer", v: 1 };
  const STATUS: LiveFrameStatus = {
    connected: true,
    failed: false,
    editing: true,
    holding: false,
    dirty: true,
    unflushed: false,
    rev: 4,
    base_version: 2,
    conflict_version: null,
    last_by_you: true,
    last_edit_at: "2026-11-18T10:00:00.000Z",
    editors: [{ email: "bo@example.org", block: true }],
  };

  function framed() {
    const frame = document.createElement("iframe");
    const win = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: win });
    return { frame, win };
  }

  const opts = (
    frame: HTMLIFrameElement,
    over: Partial<Parameters<typeof readFrameMessage>[1]> = {},
  ) => ({
    frame,
    contentOrigin: ORIGIN,
    solo: false,
    nonce: null,
    ...over,
  });

  it("builds edit and collect, and posts them only to the frame at its exact origin", () => {
    expect(editMessage(true)).toEqual({ ...base, type: "edit", on: true });
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(collectMessage(nonce)).toEqual({ ...base, type: "collect", nonce });
    const { frame, win } = framed();
    expect(postToRenderer(frame, ORIGIN, editMessage(true))).toBe(true);
    expect(win.postMessage).toHaveBeenCalledWith(editMessage(true), ORIGIN);
    // Never "*": opaque isolation and the path fallback have no on-page editing.
    expect(postToRenderer(frame, "*", editMessage(true))).toBe(false);
    expect(editTargetOrigin({ ...CONFIG, content_isolation: "opaque" }, ORIGIN)).toBeNull();
    expect(editTargetOrigin({ ...CONFIG, content_path_fallback: true }, ORIGIN)).toBeNull();
    expect(editTargetOrigin(CONFIG, ORIGIN)).toBe(ORIGIN);
  });

  it("accepts a live status from the frame's window at its origin", () => {
    const { frame, win } = framed();
    const m = readFrameMessage(
      {
        source: win as unknown as Window,
        origin: ORIGIN,
        data: { ...base, type: "live", ...STATUS },
      },
      opts(frame),
    );
    expect(m).toEqual({ type: "live", status: STATUS });
    expect(
      readFrameMessage(
        { source: win as unknown as Window, origin: ORIGIN, data: { ...base, type: "save" } },
        opts(frame),
      ),
    ).toEqual({ type: "save" });
  });

  it("refuses another window, another origin, a sibling artifact and 'null'", () => {
    const { frame, win } = framed();
    const data = { ...base, type: "live", ...STATUS };
    const other = framed().win as unknown as Window;
    expect(readFrameMessage({ source: other, origin: ORIGIN, data }, opts(frame))).toBeNull();
    expect(readFrameMessage({ source: window, origin: ORIGIN, data }, opts(frame))).toBeNull();
    for (const origin of ["null", "http://other.content.localhost:8787", CONFIG.app_origin]) {
      expect(
        readFrameMessage({ source: win as unknown as Window, origin, data }, opts(frame)),
      ).toBeNull();
    }
    expect(
      readFrameMessage(
        { source: win as unknown as Window, origin: ORIGIN, data },
        opts(frame, { contentOrigin: "*" }),
      ),
    ).toBeNull();
    expect(readFrameMessage({ source: null, origin: ORIGIN, data }, opts(frame))).toBeNull();
  });

  it("refuses malformed and out-of-range status fields", () => {
    const { frame, win } = framed();
    const send = (over: Record<string, unknown>) =>
      readFrameMessage(
        {
          source: win as unknown as Window,
          origin: ORIGIN,
          data: { ...base, type: "live", ...STATUS, ...over },
        },
        opts(frame),
      );
    for (const over of [
      { rev: -1 },
      { rev: 1.5 },
      { rev: "4" },
      { base_version: 2 ** 31 },
      { conflict_version: 0 },
      { dirty: "yes" },
      { last_edit_at: "x".repeat(41) },
      { editors: "bo" },
      { editors: [{ email: "x".repeat(255), block: true }] },
      { editors: [{ email: "a@b.c" }] },
      { editors: Array.from({ length: 51 }, () => ({ email: "a@b.c", block: false })) },
      { v: 2 },
      { source: "plinth-bridge" },
      { type: "Live" },
    ]) {
      expect(send(over), JSON.stringify(over).slice(0, 60)).toBeNull();
    }
    for (const data of [null, "live", 5, []]) {
      expect(
        readFrameMessage({ source: win as unknown as Window, origin: ORIGIN, data }, opts(frame)),
      ).toBeNull();
    }
  });

  it("takes draft text only in solo mode, for the awaited nonce, within the doc size", () => {
    const { frame, win } = framed();
    const nonce = newNonce();
    const data = { ...base, type: "draft", nonce, text: "# Mine" };
    const src = win as unknown as Window;
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data }, opts(frame, { nonce })),
    ).toBeNull();
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data }, opts(frame, { solo: true })),
    ).toBeNull();
    expect(
      readFrameMessage(
        { source: src, origin: ORIGIN, data },
        opts(frame, { solo: true, nonce: newNonce() }),
      ),
    ).toBeNull();
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data }, opts(frame, { solo: true, nonce })),
    ).toEqual({
      type: "draft",
      nonce,
      text: "# Mine",
    });
    const big = { ...data, text: "é".repeat(600) };
    expect(
      readFrameMessage(
        { source: src, origin: ORIGIN, data: big },
        opts(frame, { solo: true, nonce, maxDocBytes: 1000 }),
      ),
    ).toBeNull();
  });
});
