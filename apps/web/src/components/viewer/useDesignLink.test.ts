// useDesignLink: the board from #board=<id> is sent to a design's frame after it reports ready
// (again after a frame swap), the board it shows is written to the URL fragment (and taken out
// after Fit), only from that frame's window and origin, and nothing happens for another type.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "./test-utils.ts";
import { readBoardFragment, useDesignLink, writeBoardFragment } from "./useDesignLink.ts";

const ORIGIN = "http://art123.content.localhost:8787";

function fakeFrame() {
  const contentWindow = { postMessage: vi.fn() } as unknown as Window & {
    postMessage: ReturnType<typeof vi.fn>;
  };
  return { frame: { contentWindow } as unknown as HTMLIFrameElement, contentWindow };
}

const fromFrame = (source: Window, data: Record<string, unknown>, origin = ORIGIN) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "plinth-renderer", v: 1, ...data },
        origin,
        source,
      }),
    );
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/a/kit#board=checkout");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("useDesignLink", () => {
  it("reads and writes the fragment", () => {
    expect(readBoardFragment("#board=home-2")).toBe("home-2");
    expect(readBoardFragment("#board=Home")).toBeNull();
    expect(readBoardFragment("#slide=3")).toBeNull();
    expect(writeBoardFragment("home")).toBe("#board=home");
    expect(writeBoardFragment(null)).toBe("");
  });

  it("sends #board= after ready, writes the board shown, and re-sends after a frame swap", () => {
    const one = fakeFrame();
    const { rerender } = renderHook(
      ({ frame }) =>
        useDesignLink({ available: true, frame, contentOrigin: ORIGIN, config: CONFIG }),
      { initialProps: { frame: one.frame } },
    );
    fromFrame(one.contentWindow, { type: "ready", board: null });
    expect(one.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", board: "checkout" },
      ORIGIN,
    );
    fromFrame(one.contentWindow, { type: "board", board: "home" });
    expect(window.location.hash).toBe("#board=home");

    // Anything else changes nothing: another window, another origin, a bad id.
    fromFrame({} as Window, { type: "board", board: "post" });
    fromFrame(one.contentWindow, { type: "board", board: "post" }, "http://evil.example");
    fromFrame(one.contentWindow, { type: "board", board: "Not an id" });
    expect(window.location.hash).toBe("#board=home");

    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", board: null });
    expect(two.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", board: "home" },
      ORIGIN,
    );
    // Fit: no board, no fragment.
    fromFrame(two.contentWindow, { type: "board", board: null });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/a/kit");
    const three = fakeFrame();
    rerender({ frame: three.frame });
    fromFrame(three.contentWindow, { type: "ready", board: null });
    expect(three.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("does nothing for an artifact that is not a design", () => {
    const f = fakeFrame();
    renderHook(() =>
      useDesignLink({ available: false, frame: f.frame, contentOrigin: ORIGIN, config: CONFIG }),
    );
    fromFrame(f.contentWindow, { type: "ready", board: null });
    fromFrame(f.contentWindow, { type: "board", board: "home" });
    expect(f.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#board=checkout");
  });
});
