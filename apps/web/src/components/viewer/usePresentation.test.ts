// usePresentation: the slide from #slide=N is sent to the frame after it reports ready (again
// after a frame swap), each position is written to the URL fragment, presenter view and printing
// post only numbers and names to the frame, and nothing happens for an artifact that is not a deck.
import type { ViewGate } from "@plinth/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "./test-utils.ts";
import { audienceHref, usePresentation } from "./usePresentation.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const ORIGIN = "http://art123.content.localhost:8787";
const gate = (type: "slides" | "doc" = "slides"): OkGate => ({
  status: "ok",
  artifact: {
    id: "art123",
    slug: "talk",
    title: "Talk",
    type,
    current_version: 1,
    version: 1,
    visibility: "unlisted",
    owner_name: null,
  },
  enter_url: `${ORIGIN}/__plinth/enter?t=x`,
  role: "owner",
});

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
  window.history.replaceState(null, "", "/a/talk#slide=4");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("usePresentation", () => {
  it("sends #slide=N after ready, writes positions, and re-sends after a frame swap", () => {
    const one = fakeFrame();
    const { result, rerender } = renderHook(
      ({ frame }) =>
        usePresentation({
          gate: gate(),
          frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          slug: "talk",
        }),
      { initialProps: { frame: one.frame } },
    );
    expect(result.current.available).toBe(true);
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(one.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", slide: 4 },
      ORIGIN,
    );
    fromFrame(one.contentWindow, { type: "position", slide: 4, count: 6 });
    expect(result.current.slide).toBe(4);
    expect(result.current.count).toBe(6);
    fromFrame(one.contentWindow, { type: "position", slide: 5, count: 6 });
    expect(window.location.hash).toBe("#slide=5");

    // A message from anywhere else changes nothing.
    fromFrame({} as Window, { type: "position", slide: 2, count: 6 });
    fromFrame(one.contentWindow, { type: "position", slide: 2, count: 6 }, "http://evil.example");
    expect(result.current.slide).toBe(5);

    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(two.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", slide: 5 },
      ORIGIN,
    );
  });

  it("presenter view posts the view, pauses the version watch and exits", () => {
    const f = fakeFrame();
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    expect(result.current.pause).toBeNull();
    act(() => result.current.presenterView());
    expect(result.current.mode).toBe("presenter");
    expect(result.current.pause).toBe("present");
    expect(f.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "view", mode: "presenter" },
      ORIGIN,
    );
    act(() => result.current.print(true));
    expect(f.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "print", notes: true },
      ORIGIN,
    );
    act(() => result.current.exit());
    expect(result.current.mode).toBe("off");
    expect(result.current.pause).toBeNull();
    expect(f.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "view", mode: "deck" },
      ORIGIN,
    );
  });

  it("posts to * under opaque isolation and accepts the frame's null origin", () => {
    const f = fakeFrame();
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: { ...CONFIG, content_isolation: "opaque" },
        slug: "talk",
      }),
    );
    fromFrame(f.contentWindow, { type: "ready", slide: 1, count: 6 }, "null");
    expect(f.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", slide: 4 },
      "*",
    );
    fromFrame(f.contentWindow, { type: "position", slide: 4, count: 6 }, "null");
    expect(result.current.slide).toBe(4);
  });

  it("opens an audience window with a fresh pair id", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakeFrame();
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    act(() => result.current.openAudience());
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^\/a\/talk#present=audience&pair=[A-Za-z0-9_-]{16,64}$/);
    expect(target).toBe("_blank");
    expect(features).toBe("noopener");
    expect(audienceHref("talk", "p".repeat(16))).toBe(
      `/a/talk#present=audience&pair=${"p".repeat(16)}`,
    );
  });

  it("does nothing for an artifact that is not a deck", () => {
    const f = fakeFrame();
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate("doc"),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    expect(result.current.available).toBe(false);
    fromFrame(f.contentWindow, { type: "ready", slide: 1, count: 6 });
    act(() => result.current.presenterView());
    expect(f.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(result.current.pause).toBeNull();
  });
});
