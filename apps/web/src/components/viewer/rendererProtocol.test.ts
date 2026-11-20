import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectMessage,
  editMessage,
  editTargetOrigin,
  FRAME_KEY_RE,
  type LiveFrameStatus,
  newFrameKey,
  newNonce,
  postPrint,
  postToRenderer,
  printMessage,
  readFrameMessage,
  rendererTargetOrigin,
  reviewedMessage,
  reviewMessage,
  versionMessage,
  withFrameKey,
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
    publishable: true,
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

describe("renderer protocol: a doc shows a newer version in place (live views)", () => {
  const nonce = "v".repeat(16);

  it("sends version only to the frame's window at the exact content origin", () => {
    const post = vi.fn();
    const frame = { contentWindow: { postMessage: post } } as unknown as HTMLIFrameElement;
    expect(versionMessage(4, nonce)).toEqual({
      source: "plinth-renderer",
      v: 1,
      type: "version",
      n: 4,
      nonce,
    });
    expect(postToRenderer(frame, editTargetOrigin(CONFIG, ORIGIN), versionMessage(4, nonce))).toBe(
      true,
    );
    expect(post).toHaveBeenCalledWith(versionMessage(4, nonce), ORIGIN);
    // Never "*": opaque isolation and the path fallback get no in-place update.
    const opaque = { ...CONFIG, content_isolation: "opaque" as const };
    const fallback = { ...CONFIG, content_path_fallback: true };
    expect(editTargetOrigin(opaque, ORIGIN)).toBeNull();
    expect(editTargetOrigin(fallback, ORIGIN)).toBeNull();
    expect(postToRenderer(frame, "*", versionMessage(4, nonce))).toBe(false);
    expect(postToRenderer(frame, null, versionMessage(4, nonce))).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reads shown only from the frame at its origin, for the nonce it waits on", () => {
    const src = {} as Window;
    const frame = { contentWindow: src } as HTMLIFrameElement;
    const data = { source: "plinth-renderer", v: 1, type: "shown", n: 4, nonce, ok: true };
    const base = { frame, contentOrigin: ORIGIN, solo: false, nonce: null, shown: nonce };
    expect(readFrameMessage({ source: src, origin: ORIGIN, data }, base)).toEqual({
      type: "shown",
      n: 4,
      nonce,
      ok: true,
    });
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data: { ...data, ok: false } }, base),
    ).toEqual({ type: "shown", n: 4, nonce, ok: false });
    // Not waiting, another nonce, another window or origin, or a malformed answer: nothing.
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data }, { ...base, shown: null }),
    ).toBeNull();
    expect(
      readFrameMessage({ source: src, origin: ORIGIN, data }, { ...base, shown: "w".repeat(16) }),
    ).toBeNull();
    expect(readFrameMessage({ source: {} as Window, origin: ORIGIN, data }, base)).toBeNull();
    expect(readFrameMessage({ source: src, origin: "null", data }, base)).toBeNull();
    expect(
      readFrameMessage({ source: src, origin: "*", data }, { ...base, contentOrigin: "*" }),
    ).toBeNull();
    for (const bad of [{ n: 0 }, { n: 1.5 }, { n: "4" }, { ok: "yes" }]) {
      expect(
        readFrameMessage({ source: src, origin: ORIGIN, data: { ...data, ...bad } }, base),
      ).toBeNull();
    }
  });
});

describe("renderer protocol: the frame key and the review", () => {
  const base = { source: "plinth-renderer", v: 1 };
  const KEY = "k".repeat(43);
  function framed() {
    const frame = document.createElement("iframe");
    const win = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: win });
    return { frame, win, src: win as unknown as Window };
  }
  const read = (
    src: Window,
    frame: HTMLIFrameElement,
    data: Record<string, unknown>,
    over: Partial<Parameters<typeof readFrameMessage>[1]> = {},
  ) =>
    readFrameMessage(
      { source: src, origin: ORIGIN, data },
      { frame, contentOrigin: ORIGIN, solo: false, nonce: null, key: KEY, ...over },
    );

  it("makes a fresh 43-character key per frame load and puts it in the fragment", () => {
    const a = newFrameKey();
    expect(a).toMatch(FRAME_KEY_RE);
    expect(newFrameKey()).not.toBe(a);
    expect(withFrameKey("https://x.example/__plinth/enter?t=1", a)).toBe(
      `https://x.example/__plinth/enter?t=1#plinth-k=${a}`,
    );
    expect(withFrameKey("https://x.example/#intro", a)).toBe(
      `https://x.example/#plinth-k=${a}&h=intro`,
    );
  });

  it("drops an editing message without the frame's key, and keeps shown keyless", () => {
    const { frame, src } = framed();
    const save = { ...base, type: "save" };
    expect(read(src, frame, save)).toBeNull();
    expect(read(src, frame, { ...save, key: "x".repeat(43) })).toBeNull();
    expect(read(src, frame, { ...save, key: KEY })).toEqual({ type: "save" });
    // A frame the app gave no key (key null) sends no editing message the app accepts.
    expect(read(src, frame, { ...save, key: KEY }, { key: null })).toBeNull();
    expect(read(src, frame, { ...base, type: "leave", key: KEY })).toEqual({ type: "leave" });
    expect(read(src, frame, { ...base, type: "leave" })).toBeNull();
    // Live views' answer carries no key.
    const nonce = "v".repeat(16);
    expect(
      read(src, frame, { ...base, type: "shown", n: 2, nonce, ok: true }, { shown: nonce }),
    ).toEqual({ type: "shown", n: 2, nonce, ok: true });
  });

  it("reads the review's choice only for the pending review nonce", () => {
    const { frame, src } = framed();
    const nonce = newNonce();
    const room = { ...base, type: "resolved", nonce, key: KEY, version: 6, rev: 9 };
    expect(read(src, frame, { ...room, outcome: "publish" })).toBeNull();
    expect(read(src, frame, { ...room, outcome: "publish" }, { review: newNonce() })).toBeNull();
    expect(read(src, frame, { ...room, outcome: "publish", note: "N" }, { review: nonce })).toEqual(
      { type: "resolved", nonce, outcome: "publish", version: 6, rev: 9, note: "N" },
    );
    expect(read(src, frame, { ...room, outcome: "discard" }, { review: nonce })).toEqual({
      type: "resolved",
      nonce,
      outcome: "discard",
      version: 6,
      rev: 9,
    });
    // Room mode never carries text; a version without a rev, or a bad outcome, is refused.
    for (const bad of [
      { ...room, outcome: "publish", text: "# x" },
      { ...room, outcome: "publish", rev: undefined },
      { ...room, outcome: "publish", version: 0 },
      { ...room, outcome: "merge" },
      { ...room, outcome: "discard", note: "x" },
      { ...room, outcome: "publish", note: "x".repeat(501) },
    ]) {
      expect(read(src, frame, bad, { review: nonce }), JSON.stringify(bad)).toBeNull();
    }
    // Solo: the frame's own text, within the type's size, and never a version.
    const solo = { ...base, type: "resolved", nonce, key: KEY, outcome: "publish", text: "# Mine" };
    expect(read(src, frame, solo, { review: nonce })).toBeNull();
    expect(read(src, frame, solo, { review: nonce, solo: true })).toEqual({
      type: "resolved",
      nonce,
      outcome: "publish",
      text: "# Mine",
    });
    expect(
      read(src, frame, { ...solo, version: 6, rev: 1 }, { review: nonce, solo: true }),
    ).toBeNull();
    expect(
      read(
        src,
        frame,
        { ...solo, text: "x".repeat(20) },
        { review: nonce, solo: true, maxDocBytes: 10 },
      ),
    ).toBeNull();
    expect(
      read(
        src,
        frame,
        { ...base, type: "resolved", nonce, key: KEY, outcome: "cancelled" },
        {
          review: nonce,
        },
      ),
    ).toEqual({ type: "resolved", nonce, outcome: "cancelled" });
  });

  it("reads ask with a structural key and a short label, refusing anything else", () => {
    const { frame, src } = framed();
    const ask = (anchor: unknown, key: string | undefined = KEY) =>
      read(src, frame, { ...base, type: "ask", anchor, ...(key ? { key } : {}) });
    expect(ask({ key: "slide-3:block-4", text: "Intro" })).toEqual({
      type: "ask",
      anchor: { key: "slide-3:block-4", text: "Intro" },
    });
    // Outside edit mode there is no key to carry: it only opens a composer to confirm.
    expect(ask({ key: "component:button", text: "Button" }, undefined)).toEqual({
      type: "ask",
      anchor: { key: "component:button", text: "Button" },
    });
    for (const bad of [
      { key: "-x", text: "a" },
      { key: "x y", text: "a" },
      { key: "x", text: "a".repeat(121) },
      { key: "x", text: "line\nbreak" },
      { key: "x" },
      "x",
    ]) {
      expect(ask(bad), JSON.stringify(bad)).toBeNull();
    }
    // In edit mode a wrong key is dropped like any editing message.
    expect(ask({ key: "x", text: "a" }, "z".repeat(43))).toBeNull();
  });

  it("reads the kind of block an ask is about only from its fixed list", () => {
    const { frame, src } = framed();
    const ask = (what: unknown) =>
      read(src, frame, {
        ...base,
        type: "ask",
        anchor: { key: "block-2", text: "" },
        what,
        key: KEY,
      });
    expect(ask("list")).toEqual({
      type: "ask",
      anchor: { key: "block-2", text: "" },
      what: "list",
    });
    expect(ask("code block")).toMatchObject({ what: "code block" });
    for (const bad of ["List", "secret text", "", 3, null]) {
      expect(ask(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("drops an ask without the frame key while the app is editing", () => {
    const { frame, src } = framed();
    const anchor = { key: "block-1", text: "Intro" };
    const msg = { ...base, type: "ask", anchor };
    expect(read(src, frame, msg, { editing: true })).toBeNull();
    expect(read(src, frame, { ...msg, key: "z".repeat(43) }, { editing: true })).toBeNull();
    // With no key to check against, nothing in edit mode passes either.
    expect(read(src, frame, { ...msg, key: KEY }, { editing: true, key: null })).toBeNull();
    expect(read(src, frame, { ...msg, key: KEY }, { editing: true })).toEqual({
      type: "ask",
      anchor,
    });
    // Not editing, the keyless form still opens a composer the person confirms.
    expect(read(src, frame, msg, { editing: false })).toEqual({ type: "ask", anchor });
  });

  it("reads the new live status fields and refuses bad ones", () => {
    const { frame, src } = framed();
    const status = {
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
      last_edit_at: null,
      editors: [{ email: "bo@example.org", block: true, where: "row 12" }],
    };
    const m = read(src, frame, { ...base, type: "live", key: KEY, ...status });
    expect(m).toEqual({ type: "live", status: { ...status, publishable: true } });
    expect(
      read(src, frame, { ...base, type: "live", key: KEY, ...status, publishable: false }),
    ).toMatchObject({ status: { publishable: false } });
    for (const over of [
      { publishable: "no" },
      { unavailable: "big" },
      { editors: [{ email: "a@b.c", block: true, where: "x".repeat(81) }] },
    ]) {
      expect(read(src, frame, { ...base, type: "live", key: KEY, ...status, ...over })).toBeNull();
    }
  });

  it("builds review and reviewed, and edit with the solo base", () => {
    const nonce = newNonce();
    expect(reviewMessage(nonce)).toEqual({ ...base, type: "review", nonce });
    const files = { added: [], removed: [], replaced: [], more: 0, same: 0 };
    expect(reviewMessage(nonce, { n: 6, base: 4, files })).toEqual({
      ...base,
      type: "review",
      nonce,
      n: 6,
      base: 4,
      files,
    });
    expect(reviewedMessage(nonce, "busy")).toEqual({
      ...base,
      type: "reviewed",
      nonce,
      result: "busy",
    });
    expect(editMessage(true, 4)).toEqual({ ...base, type: "edit", on: true, base: 4 });
  });
});
