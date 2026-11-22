// usePresentation: the slide from #slide=N is sent to the frame after it reports ready (again
// after a frame swap), each position is written to the URL fragment, presenter view posts only
// numbers and names to the frame, and nothing happens for an artifact that is not a deck.
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
    expect(window.location.hash).toBe("#slide=4");
    fromFrame(one.contentWindow, { type: "position", slide: 5, count: 6 });
    expect(window.location.hash).toBe("#slide=5");

    // A message from anywhere else changes nothing.
    fromFrame({} as Window, { type: "position", slide: 2, count: 6 });
    fromFrame(one.contentWindow, { type: "position", slide: 2, count: 6 }, "http://evil.example");
    expect(window.location.hash).toBe("#slide=5");

    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(two.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "goto", slide: 5 },
      ORIGIN,
    );
  });

  it("presenter view posts the view and pauses the version watch until the frame leaves it", () => {
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
    fromFrame(f.contentWindow, { type: "view", mode: "deck" });
    expect(result.current.mode).toBe("off");
    expect(result.current.pause).toBeNull();
  });

  it("follows the view the frame reports: its s key in, its Escape or Exit out", () => {
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
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    // The presenter pressed s in the frame.
    fromFrame(one.contentWindow, { type: "view", mode: "presenter" });
    expect(result.current.mode).toBe("presenter");
    expect(result.current.pause).toBe("present");
    // A newer version's frame comes back in presenter view.
    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(two.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "view", mode: "presenter" },
      ORIGIN,
    );
    // Escape in the frame leaves presenter view.
    fromFrame(two.contentWindow, { type: "view", mode: "deck" });
    expect(result.current.mode).toBe("off");
    expect(result.current.pause).toBeNull();
    // A forged view from another window changes nothing.
    fromFrame({} as Window, { type: "view", mode: "presenter" });
    fromFrame(two.contentWindow, { type: "view", mode: "presenter" }, "http://evil.example");
    expect(result.current.mode).toBe("off");
  });

  it("leaves presenter view when the frame refuses it or exits it, and keeps the audience until it closes", () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const closed = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage = null;
        postMessage() {}
        close() {
          closed();
        }
      },
    );
    const f = fakeFrame();
    const { result, unmount } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    act(() => result.current.presenterView());
    act(() => result.current.openAudience());
    // The frame's own Exit presenter view button: the audience window still follows this one.
    fromFrame(f.contentWindow, { type: "view", mode: "deck" });
    expect(result.current.mode).toBe("off");
    expect(closed).not.toHaveBeenCalled();
    // Review mode keeps the overview and says so.
    act(() => result.current.presenterView());
    fromFrame(f.contentWindow, { type: "view", mode: "overview" });
    expect(result.current.mode).toBe("off");
    unmount();
    expect(closed).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("Present keeps presenter view when presenter view is on", async () => {
    const f = fakeFrame();
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.assign(f.frame, { requestFullscreen, focus: vi.fn() });
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    await act(async () => result.current.present());
    expect(f.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "view", mode: "deck" },
      ORIGIN,
    );
    act(() => result.current.presenterView());
    f.contentWindow.postMessage.mockClear();
    await act(async () => result.current.present());
    expect(requestFullscreen).toHaveBeenCalledTimes(2);
    expect(f.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("presenter");
  });

  it("an audience window ignores its own frame's view", () => {
    window.history.replaceState(null, "", `/a/talk#present=audience&pair=${"p".repeat(16)}`);
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
    expect(result.current.mode).toBe("audience");
    fromFrame(f.contentWindow, { type: "view", mode: "presenter" });
    expect(result.current.mode).toBe("audience");
  });

  it("an audience window is paired only once its presenter window has sent a slide", async () => {
    const pair = "q".repeat(16);
    window.history.replaceState(null, "", `/a/talk#present=audience&pair=${pair}`);
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
    expect(result.current.mode).toBe("audience");
    // A link with a pair id and no presenter: the whole page stays.
    expect(result.current.paired).toBe(false);
    const presenter = new BroadcastChannel(`plinth-present:art123:${pair}`);
    try {
      presenter.postMessage({ v: 1, type: "slide", slide: 2, version: 1 });
      await vi.waitFor(() => expect(result.current.paired).toBe(true));
    } finally {
      presenter.close();
    }
  });

  it("an audience window tells its frame it is paired before any goto; others never do", () => {
    window.history.replaceState(null, "", `/a/talk#present=audience&pair=${"p".repeat(16)}`);
    const f = fakeFrame();
    renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    fromFrame(f.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(f.contentWindow.postMessage).toHaveBeenCalledWith(
      { source: "plinth-renderer", v: 1, type: "paired" },
      ORIGIN,
    );
    const types = f.contentWindow.postMessage.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types[0]).toBe("paired");

    window.history.replaceState(null, "", "/a/talk#slide=4");
    const g = fakeFrame();
    renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: g.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    fromFrame(g.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(
      g.contentWindow.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).toEqual(["goto"]);
  });

  it("a frame that replaces one that was leading is asked to lead again, after its slide", () => {
    const one = fakeFrame();
    const { rerender } = renderHook(
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
    const types = (w: { postMessage: ReturnType<typeof vi.fn> }) =>
      w.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    // Nobody led yet: no lead.
    expect(types(one.contentWindow)).toEqual(["goto"]);
    fromFrame(one.contentWindow, { type: "position", slide: 4, count: 6 });
    fromFrame(one.contentWindow, { type: "leading", on: true });

    // A newer version or a sharing change replaces the frame: it goes to slide 4, then leads.
    const two = fakeFrame();
    rerender({ frame: two.frame });
    // The old frame's word no longer counts.
    fromFrame(one.contentWindow, { type: "leading", on: false });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(two.contentWindow.postMessage.mock.calls).toEqual([
      [{ source: "plinth-renderer", v: 1, type: "goto", slide: 4 }, ORIGIN],
      [{ source: "plinth-renderer", v: 1, type: "lead" }, ORIGIN],
    ]);

    // The person stopped leading (or another presenter took over): the next frame does not lead.
    fromFrame(two.contentWindow, { type: "leading", on: false });
    const three = fakeFrame();
    rerender({ frame: three.frame });
    fromFrame(three.contentWindow, { type: "ready", slide: 4, count: 6 });
    expect(types(three.contentWindow)).not.toContain("lead");
    // A malformed one is ignored.
    fromFrame(three.contentWindow, { type: "leading", on: "yes" });
    const four = fakeFrame();
    rerender({ frame: four.frame });
    fromFrame(four.contentWindow, { type: "ready", slide: 4, count: 6 });
    expect(types(four.contentWindow)).not.toContain("lead");
  });

  it("a lead belongs to one deck: moving to another artifact does not lead there", () => {
    const one = fakeFrame();
    const other: OkGate = {
      ...gate(),
      artifact: { ...gate().artifact, id: "art456", slug: "other-talk", title: "Other talk" },
    };
    const { rerender } = renderHook(
      ({ frame, g }) =>
        usePresentation({
          gate: g,
          frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          slug: g.artifact.slug,
        }),
      { initialProps: { frame: one.frame, g: gate() } },
    );
    const types = (w: { postMessage: ReturnType<typeof vi.fn> }) =>
      w.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    fromFrame(one.contentWindow, { type: "leading", on: true });
    // The same page shows another deck: its frame is never asked to lead.
    const two = fakeFrame();
    rerender({ frame: two.frame, g: other });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(types(two.contentWindow)).not.toContain("lead");
    // Back on the first deck, the lead it had is gone too: the person turns it on again.
    const three = fakeFrame();
    rerender({ frame: three.frame, g: gate() });
    fromFrame(three.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(types(three.contentWindow)).not.toContain("lead");
  });

  it("an audience window never records or sends a lead", () => {
    window.history.replaceState(null, "", `/a/talk#present=audience&pair=${"p".repeat(16)}`);
    const one = fakeFrame();
    const { rerender } = renderHook(
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
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    fromFrame(one.contentWindow, { type: "leading", on: true });
    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(
      two.contentWindow.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).not.toContain("lead");
  });

  it("posts to * under opaque isolation and accepts the frame's null origin", () => {
    const f = fakeFrame();
    renderHook(() =>
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
    expect(window.location.hash).toBe("#slide=4");
  });

  it("an audience window shows the presenter's slide in deck view, whatever its own frame does", async () => {
    const pair = "r".repeat(16);
    window.history.replaceState(null, "", `/a/talk/v/1#present=audience&pair=${pair}`);
    const navigate = vi.fn();
    const f = fakeFrame();
    const { result } = renderHook(() =>
      usePresentation({
        gate: gate(),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
        navigate,
      }),
    );
    const presenter = new BroadcastChannel(`plinth-present:art123:${pair}`);
    const deckView = { source: "plinth-renderer", v: 1, type: "view", mode: "deck" };
    const goto = (slide: number) => ({ source: "plinth-renderer", v: 1, type: "goto", slide });
    const paired = { source: "plinth-renderer", v: 1, type: "paired" };
    try {
      presenter.postMessage({ v: 1, type: "slide", slide: 3, version: 1 });
      await vi.waitFor(() => expect(result.current.paired).toBe(true));
      // Deck view at any size (a phone in portrait would otherwise show the overview), slide 3.
      expect(f.contentWindow.postMessage).toHaveBeenCalledWith(deckView, ORIGIN);
      expect(f.contentWindow.postMessage).toHaveBeenLastCalledWith(goto(3), ORIGIN);
      // A frame that loads later gets the same, after it is told it is paired.
      f.contentWindow.postMessage.mockClear();
      fromFrame(f.contentWindow, { type: "ready", slide: 1, count: 5 });
      expect(f.contentWindow.postMessage.mock.calls).toEqual([
        [paired, ORIGIN],
        [deckView, ORIGIN],
        [goto(3), ORIGIN],
      ]);
      // Its own keys or taps neither change the view nor page away from the presenter's slide.
      f.contentWindow.postMessage.mockClear();
      fromFrame(f.contentWindow, { type: "view", mode: "overview" });
      fromFrame(f.contentWindow, { type: "position", slide: 4, count: 5 });
      expect(f.contentWindow.postMessage.mock.calls).toEqual([
        [deckView, ORIGIN],
        [goto(3), ORIGIN],
      ]);
      expect(result.current.mode).toBe("audience");
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      presenter.close();
    }
  });

  it("an audience window moves to another version only when its presenter window shows it", async () => {
    const pair = "s".repeat(16);
    window.history.replaceState(null, "", `/a/talk/v/1#present=audience&pair=${pair}`);
    const navigate = vi.fn();
    const f = fakeFrame();
    const g = gate();
    // Version 2 was published; the audience shows the presenter's version 1 and stays on it.
    g.artifact = { ...g.artifact, version: 1, current_version: 2 };
    const { result } = renderHook(() =>
      usePresentation({
        gate: g,
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
        navigate,
      }),
    );
    expect(result.current.pause).toBeNull();
    const presenter = new BroadcastChannel(`plinth-present:art123:${pair}`);
    try {
      presenter.postMessage({ v: 1, type: "slide", slide: 2, version: 1 });
      await vi.waitFor(() => expect(result.current.paired).toBe(true));
      expect(navigate).not.toHaveBeenCalled();
      // The presenter's window now shows version 2: the audience loads it, on the same slide.
      presenter.postMessage({ v: 1, type: "slide", slide: 2, version: 2 });
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
      expect(navigate).toHaveBeenCalledWith(`/a/talk/v/2#present=audience&pair=${pair}&slide=2`);
      // While that load runs the presenter keeps paging: the window does not start it again. A
      // second listener on the pair shows when every message has been delivered.
      const seen = new BroadcastChannel(`plinth-present:art123:${pair}`);
      const heard = vi.fn();
      seen.onmessage = heard;
      try {
        presenter.postMessage({ v: 1, type: "slide", slide: 3, version: 2 });
        presenter.postMessage({ v: 1, type: "slide", slide: 4, version: 3 });
        await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        seen.close();
      }
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      presenter.close();
    }
  });

  it("tells its audience the slide and the version it shows", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const one = fakeFrame();
    const behind = gate();
    // Presenting held version 1 while version 2 was published.
    behind.artifact = { ...behind.artifact, version: 1, current_version: 2 };
    const { result, rerender } = renderHook(
      ({ g, frame }) =>
        usePresentation({
          gate: g,
          frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          slug: "talk",
        }),
      { initialProps: { g: behind, frame: one.frame } },
    );
    fromFrame(one.contentWindow, { type: "ready", slide: 4, count: 6 });
    act(() => result.current.presenterView());
    act(() => result.current.openAudience());
    const url = String(open.mock.calls[0]?.[0]);
    // The audience opens on the version the presenter shows, not the current one.
    expect(url).toMatch(/^\/a\/talk\/v\/1#present=audience&pair=[A-Za-z0-9_-]{16,64}$/);
    const pair = new URLSearchParams(url.split("#")[1]).get("pair");
    const heard: unknown[] = [];
    const audience = new BroadcastChannel(`plinth-present:art123:${pair}`);
    audience.onmessage = (e) => heard.push(e.data);
    try {
      audience.postMessage({ v: 1, type: "hello" });
      await vi.waitFor(() =>
        expect(heard).toEqual([{ v: 1, type: "slide", slide: 4, version: 1 }]),
      );
      fromFrame(one.contentWindow, { type: "position", slide: 5, count: 6 });
      await vi.waitFor(() => expect(heard).toHaveLength(2));
      expect(heard[1]).toEqual({ v: 1, type: "slide", slide: 5, version: 1 });
      // A second audience window joins the same pair.
      act(() => result.current.openAudience());
      expect(String(open.mock.calls[1]?.[0])).toBe(url);
      // Presenting ended and the presenter's window caught up with version 2: the audience follows.
      fromFrame(one.contentWindow, { type: "view", mode: "deck" });
      const two = fakeFrame();
      rerender({
        g: { ...behind, artifact: { ...behind.artifact, version: 2 } },
        frame: two.frame,
      });
      fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
      fromFrame(two.contentWindow, { type: "position", slide: 5, count: 6 });
      await vi.waitFor(() => expect(heard).toHaveLength(3));
      expect(heard[2]).toEqual({ v: 1, type: "slide", slide: 5, version: 2 });
    } finally {
      audience.close();
    }
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
    // On the version on view, so a version published later never reaches the audience by itself.
    expect(String(url)).toMatch(/^\/a\/talk\/v\/1#present=audience&pair=[A-Za-z0-9_-]{16,64}$/);
    expect(target).toBe("_blank");
    expect(features).toBe("noopener");
    expect(audienceHref("talk", "p".repeat(16))).toBe(
      `/a/talk#present=audience&pair=${"p".repeat(16)}`,
    );
  });

  it("opens the audience window on the same version from a permanent version link", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakeFrame();
    const g = gate();
    g.artifact = { ...g.artifact, version: 2, current_version: 5 };
    const { result } = renderHook(() =>
      usePresentation({
        gate: g,
        frame: f.frame,
        contentOrigin: ORIGIN,
        config: CONFIG,
        slug: "talk",
      }),
    );
    act(() => result.current.openAudience());
    const [url] = open.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^\/a\/talk\/v\/2#present=audience&pair=[A-Za-z0-9_-]{16,64}$/);
    expect(audienceHref("talk", "p".repeat(16), 2)).toBe(
      `/a/talk/v/2#present=audience&pair=${"p".repeat(16)}`,
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

  it("tells the frame when it goes full screen and back, and a new frame that it is", () => {
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
    const presenting = (w: { postMessage: ReturnType<typeof vi.fn> }) =>
      w.postMessage.mock.calls
        .map((c) => c[0] as { type: string; on?: boolean })
        .filter((m) => m.type === "presenting")
        .map((m) => m.on);
    // Nothing is said while the deck is not full screen.
    fromFrame(one.contentWindow, { type: "ready", slide: 4, count: 6 });
    expect(presenting(one.contentWindow)).toEqual([]);
    let element: Element | null = one.frame;
    // jsdom has no full screen: the document's fullscreenElement is modelled.
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => element,
    });
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(result.current.pause).toBe("present");
    expect(one.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "presenting", on: true },
      ORIGIN,
    );
    const two = fakeFrame();
    rerender({ frame: two.frame });
    fromFrame(two.contentWindow, { type: "ready", slide: 4, count: 6 });
    expect(presenting(two.contentWindow)).toEqual([true]);
    element = null;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(presenting(two.contentWindow)).toEqual([true, false]);
    Reflect.deleteProperty(document, "fullscreenElement");
  });
});

describe("usePresentation in review mode", () => {
  /** A deck shown in review mode (its stacked overview) in `one`, which `two` will replace. */
  function reviewing() {
    const one = fakeFrame();
    const two = fakeFrame();
    const requestFullscreen = vi.fn(() => Promise.resolve());
    for (const f of [one, two]) {
      Object.assign(f.frame, { requestFullscreen, focus: vi.fn() });
    }
    const leaveReview = vi.fn();
    const hook = renderHook(
      ({ frame, review }) =>
        usePresentation({
          gate: gate(),
          frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          slug: "talk",
          review,
          leaveReview,
        }),
      { initialProps: { frame: one.frame, review: true } },
    );
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    one.contentWindow.postMessage.mockClear();
    /** The page left review mode and the deck's new frame loaded. */
    const swap = () => {
      hook.rerender({ frame: two.frame, review: false });
      fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    };
    return { one, two, requestFullscreen, leaveReview, swap, ...hook };
  }

  const presenterViewMessage = { source: "plinth-renderer", v: 1, type: "view", mode: "presenter" };

  it("Presenter view leaves review mode, then opens presenter view in the new frame", () => {
    const { one, two, leaveReview, swap, result } = reviewing();
    act(() => result.current.presenterView());
    expect(leaveReview).toHaveBeenCalledTimes(1);
    // Nothing is asked of the stacked overview, which would refuse it.
    expect(one.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("off");
    // The review frame's own ready does not count.
    fromFrame(one.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(result.current.mode).toBe("off");
    swap();
    expect(result.current.mode).toBe("presenter");
    expect(result.current.pause).toBe("present");
    expect(two.contentWindow.postMessage).toHaveBeenCalledWith(presenterViewMessage, ORIGIN);
    // Once only: a later ready (a newer version) follows the mode as usual.
    fromFrame(two.contentWindow, { type: "view", mode: "deck" });
    fromFrame(two.contentWindow, { type: "ready", slide: 1, count: 6 });
    expect(result.current.mode).toBe("off");
  });

  it("Full screen and the f key leave review mode, then put the new frame full screen", async () => {
    const { one, two, requestFullscreen, leaveReview, swap, result } = reviewing();
    act(() => result.current.present());
    expect(leaveReview).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).not.toHaveBeenCalled();
    swap();
    await act(async () => {});
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen.mock.contexts[0]).toBe(two.frame);
    expect(two.contentWindow.postMessage).toHaveBeenLastCalledWith(
      { source: "plinth-renderer", v: 1, type: "view", mode: "deck" },
      ORIGIN,
    );
    expect(one.contentWindow.postMessage).not.toHaveBeenCalled();

    const again = reviewing();
    fromFrame(again.one.contentWindow, { type: "fullscreen" });
    expect(again.leaveReview).toHaveBeenCalledTimes(1);
    expect(again.requestFullscreen).not.toHaveBeenCalled();
    again.swap();
    await act(async () => {});
    expect(again.requestFullscreen).toHaveBeenCalledTimes(1);
    again.unmount();
  });

  it("presents at once outside review mode", () => {
    const { two, leaveReview, rerender, result } = reviewing();
    rerender({ frame: two.frame, review: false });
    act(() => result.current.presenterView());
    expect(leaveReview).not.toHaveBeenCalled();
    expect(result.current.mode).toBe("presenter");
    expect(two.contentWindow.postMessage).toHaveBeenLastCalledWith(presenterViewMessage, ORIGIN);
  });
});
