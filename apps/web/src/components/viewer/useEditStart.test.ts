// `?edit` where the person can edit on the page (New and Import): the page drops the parameter,
// starts editing, and the edit message asks the frame to focus its first block or cell until the
// frame says it is editing; a plain Edit never asks for it. Every other `?edit` case is
// editArrival.ts's (ArtifactPage.frameComment.test.tsx).
import type { ViewGate } from "@plinth/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMessage } from "./rendererProtocol.ts";
import { CONFIG, json, stubApi } from "./test-utils.ts";
import { useEditStart } from "./useEditStart.ts";
import { useLiveEdit } from "./useLiveEdit.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;
const ORIGIN = "http://art1.content.localhost:8787";
const KEY = "K".repeat(43);

const gate = (over: Partial<OkGate> = {}): OkGate => ({
  status: "ok",
  artifact: {
    id: "art1",
    slug: "untitled-document",
    title: "Untitled document",
    type: "doc",
    current_version: 1,
    version: 1,
    visibility: "allowlist",
    owner_name: null,
  },
  enter_url: `${ORIGIN}/__plinth/enter?t=x`,
  role: "owner",
  live: { mode: "room", draft: null },
  ...over,
});

let frame: HTMLIFrameElement;
let toFrame: ReturnType<typeof vi.fn>;
let frameWin: { postMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  frame = document.createElement("iframe");
  toFrame = vi.fn();
  frameWin = { postMessage: toFrame };
  Object.defineProperty(frame, "contentWindow", { value: frameWin });
  stubApi({
    handle: (c) =>
      c.path.endsWith("/live")
        ? json({
            mode: "room",
            draft: null,
            editors_online: 0,
            idle_checkpoint_s: 120,
            auto_checkpoint_min_s: 600,
          })
        : undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const edits = () => toFrame.mock.calls.filter((c) => c[0]?.type === "edit").map((c) => c[0]);

function frameSays(data: Record<string, unknown>) {
  act(() => {
    const e = new MessageEvent("message", {
      data: { source: "plinth-renderer", v: 1, key: KEY, ...data },
      origin: ORIGIN,
    });
    Object.defineProperty(e, "source", { value: frameWin });
    window.dispatchEvent(e);
  });
}

const STATUS = {
  connected: true,
  failed: false,
  editing: true,
  holding: false,
  dirty: false,
  unflushed: false,
  rev: 1,
  base_version: 1,
  conflict_version: null,
  last_by_you: false,
  last_edit_at: null,
  editors: [],
  publishable: true,
};

function page(g: OkGate) {
  return renderHook(() => {
    const live = useLiveEdit({
      gate: g,
      frame,
      contentOrigin: ORIGIN,
      config: CONFIG,
      frameKey: KEY,
      onReload: () => undefined,
    });
    useEditStart(live);
    return live;
  });
}

describe("?edit with editing on the page", () => {
  it("drops the parameter, starts editing and asks the frame to focus its first place", () => {
    window.history.replaceState(null, "", "/a/untitled-document?edit&x=1#top");
    const focus = vi.spyOn(frame, "focus");
    const { result } = page(gate());
    expect(result.current.editing).toBe(true);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/a/untitled-document?x=1#top",
    );
    expect(edits().at(-1)).toEqual({
      source: "plinth-renderer",
      v: 1,
      type: "edit",
      on: true,
      focus: "first",
    });
    // The frame's window gets the focus first, so its own focus() moves the keyboard.
    expect(focus).toHaveBeenCalled();
    // Until the frame reports editing, a reload of it asks again.
    act(() => frame.dispatchEvent(new Event("load")));
    expect(edits().at(-1)?.focus).toBe("first");
    frameSays({ type: "live", ...STATUS });
    act(() => frame.dispatchEvent(new Event("load")));
    expect(edits().at(-1)).toEqual({ source: "plinth-renderer", v: 1, type: "edit", on: true });
  });

  it("does nothing without ?edit, and a plain Edit never asks for the focus", () => {
    window.history.replaceState(null, "", "/a/untitled-document");
    const { result } = page(gate());
    expect(result.current.editing).toBe(false);
    expect(edits()).toHaveLength(0);
    act(() => result.current.start());
    expect(edits().at(-1)).toEqual({ source: "plinth-renderer", v: 1, type: "edit", on: true });
  });

  it("leaves ?edit to the notices where this person cannot edit here", () => {
    window.history.replaceState(null, "", "/a/untitled-document?edit");
    const signIn = page(gate({ live: { mode: "room", draft: null, sign_in: true } }));
    expect(signIn.result.current.editing).toBe(false);
    signIn.unmount();
    const off = page(gate({ live: undefined, live_off: { reason: "disabled" } }));
    expect(off.result.current.editing).toBe(false);
    expect(edits()).toHaveLength(0);
    // editArrival.ts drops it for these; this hook leaves it alone.
    expect(window.location.search).toBe("?edit");
  });
});

describe("editMessage", () => {
  it("carries focus only when turning editing on", () => {
    expect(editMessage(true, undefined, "first")).toMatchObject({ on: true, focus: "first" });
    expect(editMessage(false, undefined, "first")).not.toHaveProperty("focus");
    expect(editMessage(true, 4)).toEqual({
      source: "plinth-renderer",
      v: 1,
      type: "edit",
      on: true,
      base: 4,
    });
  });
});
