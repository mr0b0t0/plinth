// The app's side of a deck's .pptx download: the export request carries only the app's own nonce,
// the frame's answer is accepted only from the deck's frame (exact origin, or "null" plus its
// window under opaque isolation) with the nonce the app is waiting for and well-formed fields, and
// each outcome has its toast. Nothing happens for an artifact that is not a deck.
import type { ViewGate } from "@plinth/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ui from "../ui/index.ts";
import { exportMessage, NONCE_RE } from "./rendererProtocol.ts";
import { readSlidesFrameMessage } from "./slidesProtocol.ts";
import { CONFIG } from "./test-utils.ts";
import {
  EXPORT_INTERRUPTED_TOAST,
  EXPORT_TIMEOUT_MS,
  exportedToast,
  usePresentation,
} from "./usePresentation.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const ORIGIN = "http://art123.content.localhost:8787";
const NONCE = "abcdefghijklmnop";
const win = {} as Window;
const frame = { contentWindow: win } as HTMLIFrameElement;
const data = (m: Record<string, unknown>) => ({ source: "plinth-renderer", v: 1, ...m });
const exported = (over: Record<string, unknown> = {}) =>
  data({ type: "exported", nonce: NONCE, ok: true, images_skipped: 0, opaque: false, ...over });

const read = (
  e: { source: unknown; origin: string; data: unknown },
  opaque = false,
  type = "slides",
) => readSlidesFrameMessage(e as MessageEvent, { frame, contentOrigin: ORIGIN, opaque, type });

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
  role: "viewer",
});

function fakeFrame() {
  const contentWindow = { postMessage: vi.fn() } as unknown as Window & {
    postMessage: ReturnType<typeof vi.fn>;
  };
  return { frame: { contentWindow } as unknown as HTMLIFrameElement, contentWindow };
}

const fromFrame = (source: Window, m: Record<string, unknown>, origin = ORIGIN) =>
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: m, origin, source }));
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the export messages", () => {
  it("asks for a .pptx with only the app's nonce", () => {
    expect(exportMessage(NONCE)).toEqual({
      source: "plinth-renderer",
      v: 1,
      type: "export",
      format: "pptx",
      nonce: NONCE,
    });
  });

  it("accepts a well-formed answer from the deck's frame", () => {
    expect(read({ source: win, origin: ORIGIN, data: exported({ images_skipped: 2 }) })).toEqual({
      type: "exported",
      nonce: NONCE,
      ok: true,
      images_skipped: 2,
      opaque: false,
    });
    const opaque = { source: win, origin: "null", data: exported({ opaque: true }) };
    expect(read(opaque, true)).toMatchObject({ type: "exported", opaque: true });
    expect(read(opaque)).toBeNull();
  });

  it("refuses other windows, non-deck artifacts and malformed fields", () => {
    const ok = { source: win, origin: ORIGIN, data: exported() };
    expect(read({ ...ok, source: {} })).toBeNull();
    expect(read({ ...ok, origin: "http://evil.example" })).toBeNull();
    expect(read(ok, false, "doc")).toBeNull();
    for (const bad of [
      { nonce: "short" },
      { nonce: `${NONCE}!` },
      { nonce: 7 },
      { ok: "yes" },
      { ok: undefined },
      { opaque: 1 },
      { opaque: undefined },
      { images_skipped: -1 },
      { images_skipped: 1.5 },
      { images_skipped: "2" },
      { images_skipped: 100_000 },
    ]) {
      expect(read({ ...ok, data: exported(bad) }), JSON.stringify(bad)).toBeNull();
    }
  });

  it("has a toast for each outcome", () => {
    expect(exportedToast({ ok: true, images_skipped: 0, opaque: false })).toEqual({
      title: "Downloaded the .pptx",
      tone: "success",
    });
    expect(exportedToast({ ok: true, images_skipped: 3, opaque: true }).description).toBe(
      "Images were left out.",
    );
    expect(exportedToast({ ok: true, images_skipped: 1, opaque: false }).description).toBe(
      "1 image could not be added.",
    );
    expect(exportedToast({ ok: true, images_skipped: 2, opaque: false }).description).toBe(
      "2 images could not be added.",
    );
    expect(exportedToast({ ok: false, images_skipped: 0, opaque: false })).toMatchObject({
      title: "The .pptx could not be made",
      tone: "danger",
    });
  });
});

describe("usePresentation exportPptx", () => {
  const hook = (
    f: ReturnType<typeof fakeFrame>,
    type: "slides" | "doc" = "slides",
    config = CONFIG,
  ) =>
    renderHook(() =>
      usePresentation({
        gate: gate(type),
        frame: f.frame,
        contentOrigin: ORIGIN,
        config,
        slug: "talk",
      }),
    );

  it("posts the request to the exact content origin and shows the frame's answer once", () => {
    const toast = vi.spyOn(ui, "showToast");
    const f = fakeFrame();
    const { result } = hook(f);
    act(() => result.current.exportPptx());
    expect(result.current.exporting).toBe(true);
    const [message, target] = f.contentWindow.postMessage.mock.calls.at(-1) ?? [];
    expect(target).toBe(ORIGIN);
    expect(message).toMatchObject({ type: "export", format: "pptx" });
    const nonce = (message as { nonce: string }).nonce;
    expect(nonce).toMatch(NONCE_RE);

    // A second request while one runs sends nothing.
    act(() => result.current.exportPptx());
    expect(f.contentWindow.postMessage).toHaveBeenCalledTimes(1);

    // An answer with another nonce, or from another window, changes nothing.
    fromFrame(f.contentWindow, exported());
    fromFrame({} as Window, exported({ nonce }));
    expect(result.current.exporting).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    fromFrame(f.contentWindow, exported({ nonce, images_skipped: 1 }));
    expect(result.current.exporting).toBe(false);
    expect(toast).toHaveBeenCalledWith({
      title: "Downloaded the .pptx",
      description: "1 image could not be added.",
      tone: "warning",
    });
    // The same answer again is not shown twice.
    fromFrame(f.contentWindow, exported({ nonce }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("posts to * under opaque isolation", () => {
    const f = fakeFrame();
    const { result } = hook(f, "slides", { ...CONFIG, content_isolation: "opaque" });
    act(() => result.current.exportPptx());
    expect(f.contentWindow.postMessage.mock.calls.at(-1)?.[1]).toBe("*");
  });

  it("gives up when the frame never answers", () => {
    vi.useFakeTimers();
    const toast = vi.spyOn(ui, "showToast");
    const f = fakeFrame();
    const { result } = hook(f);
    act(() => result.current.exportPptx());
    act(() => {
      vi.advanceTimersByTime(EXPORT_TIMEOUT_MS);
    });
    expect(result.current.exporting).toBe(false);
    expect(toast).toHaveBeenCalledWith({ title: "The .pptx could not be made", tone: "danger" });
  });

  it("stops waiting at once when a new frame replaces the one making the file", () => {
    vi.useFakeTimers();
    const toast = vi.spyOn(ui, "showToast");
    const first = fakeFrame();
    const second = fakeFrame();
    const { result, rerender } = renderHook(
      ({ f }) =>
        usePresentation({
          gate: gate(),
          frame: f.frame,
          contentOrigin: ORIGIN,
          config: CONFIG,
          slug: "talk",
        }),
      { initialProps: { f: first } },
    );
    act(() => result.current.exportPptx());
    expect(result.current.exporting).toBe(true);
    // The same frame re-rendering changes nothing.
    rerender({ f: first });
    expect(result.current.exporting).toBe(true);
    expect(toast).not.toHaveBeenCalled();

    rerender({ f: second });
    expect(result.current.exporting).toBe(false);
    expect(toast).toHaveBeenCalledExactlyOnceWith(EXPORT_INTERRUPTED_TOAST);
    // The old timeout does not fire a second toast, and the menu item works again.
    act(() => {
      vi.advanceTimersByTime(EXPORT_TIMEOUT_MS);
    });
    expect(toast).toHaveBeenCalledTimes(1);
    act(() => result.current.exportPptx());
    expect(second.contentWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(result.current.exporting).toBe(true);
  });

  it("does nothing for an artifact that is not a deck", () => {
    const f = fakeFrame();
    const { result } = hook(f, "doc");
    act(() => result.current.exportPptx());
    expect(f.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(result.current.exporting).toBe(false);
  });
});
