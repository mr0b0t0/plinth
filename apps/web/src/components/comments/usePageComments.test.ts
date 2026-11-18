import { type CommentInfo, PAGE_COMMENTS_SOURCE } from "@plinth/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UsePageCommentsOptions, usePageComments } from "./usePageComments.ts";

const ORIGIN = "http://art1.content.localhost:8787";
const REQ = (n: number) => `request-${String(n).padStart(12, "0")}`;

let n = 0;
function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "art1",
    version_number: 1,
    parent_id: null,
    author: { email: "secret@example.com", connection_id: null, label: "Secret Person" },
    body: "Secret body @claude",
    anchor: null,
    status: "open",
    created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    mentions: [{ task_id: "t", target: "@claude", state: "pending", result_version: null }],
    ...over,
  };
}

function kit(over: Partial<UsePageCommentsOptions> = {}) {
  const frameWin = { postMessage: vi.fn() };
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: frameWin });
  let clock = 10_000;
  const onCompose = vi.fn();
  const onOpenThread = vi.fn();
  const initial: UsePageCommentsOptions = {
    frame,
    contentOrigin: ORIGIN,
    opaque: false,
    enabled: true,
    items: [],
    blocked: false,
    onCompose,
    onOpenThread,
    now: () => clock,
    ...over,
  };
  const hook = renderHook((p: UsePageCommentsOptions) => usePageComments(p), {
    initialProps: initial,
  });
  const send = (data: Record<string, unknown>, source: unknown = frameWin) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: PAGE_COMMENTS_SOURCE, v: 1, ...data },
          origin: ORIGIN,
          source: source as MessageEventSource,
        }),
      );
    });
  const sent = (type?: string) =>
    frameWin.postMessage.mock.calls
      .map(([m]) => m as Record<string, unknown>)
      .filter((m) => type === undefined || m.type === type);
  return {
    ...hook,
    frame,
    frameWin,
    send,
    sent,
    onCompose,
    onOpenThread,
    tick: (ms: number) => {
      clock += ms;
    },
    rerenderWith: (p: Partial<UsePageCommentsOptions>) => hook.rerender({ ...initial, ...p }),
  };
}

afterEach(() => {
  cleanup();
});

describe("usePageComments", () => {
  it("answers hello from the current frame only", () => {
    const k = kit();
    k.send({ type: "hello" }, {});
    expect(k.sent()).toEqual([]);
    k.send({ type: "hello" });
    expect(k.sent("welcome")).toEqual([
      { type: "welcome", available: true, source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
    expect(k.sent("threads")).toEqual([
      { type: "threads", items: [], source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
    // A frame that went away (the stage swapped layers) is not heard any more.
    const next = document.createElement("iframe");
    const nextWin = { postMessage: vi.fn() };
    Object.defineProperty(next, "contentWindow", { configurable: true, value: nextWin });
    k.rerenderWith({ frame: next });
    k.send({ type: "hello" });
    expect(k.sent("welcome").length).toBe(1);
  });

  it("says not declared, and refuses everything else, when the page did not declare comments", () => {
    const k = kit({ enabled: false });
    k.send({ type: "hello" });
    expect(k.sent()).toEqual([
      { type: "welcome", available: false, source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
    k.send({ type: "compose", req: REQ(1) });
    expect(k.onCompose).not.toHaveBeenCalled();
    expect(k.sent("composed")).toEqual([
      { type: "composed", req: REQ(1), status: "closed", source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
  });

  it("accepts one compose a second and closes the rest", () => {
    const k = kit();
    k.send({ type: "hello" });
    k.send({ type: "compose", req: REQ(1), anchor: { key: "canvas", x: 3, y: 4 } });
    k.tick(500);
    k.send({ type: "compose", req: REQ(2) });
    expect(k.onCompose).toHaveBeenCalledTimes(1);
    expect(k.onCompose.mock.calls[0]?.[0]).toMatchObject({
      req: REQ(1),
      anchor: { kind: "page", key: "canvas", x: 3, y: 4 },
    });
    expect(k.sent("composed")).toEqual([
      { type: "composed", req: REQ(2), status: "closed", source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
    k.tick(600);
    k.send({ type: "compose", req: REQ(3) });
    expect(k.onCompose).toHaveBeenCalledTimes(2);
    // Each accepted request is answered once.
    act(() => k.result.current.settle(REQ(1), { status: "posted", id: "c9" }));
    act(() => k.result.current.settle(REQ(1), { status: "closed" }));
    act(() => k.result.current.settle("unknown-request-0", { status: "closed" }));
    expect(k.sent("composed").slice(1)).toEqual([
      {
        type: "composed",
        req: REQ(1),
        status: "posted",
        id: "c9",
        source: PAGE_COMMENTS_SOURCE,
        v: 1,
      },
    ]);
  });

  it("refuses compose before hello, while a dialog is open and while the tab is hidden", () => {
    const k = kit({ blocked: true });
    k.send({ type: "compose", req: REQ(1) });
    k.send({ type: "hello" });
    k.send({ type: "compose", req: REQ(2) });
    k.rerenderWith({ blocked: false });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    k.tick(2000);
    k.send({ type: "compose", req: REQ(3) });
    hidden.mockRestore();
    expect(k.onCompose).not.toHaveBeenCalled();
    expect(k.sent("composed").map((m) => [m.req, m.status])).toEqual([
      [REQ(1), "closed"],
      [REQ(2), "closed"],
      [REQ(3), "closed"],
    ]);
    // An invalid anchor is dropped silently.
    k.send({ type: "compose", req: REQ(4), anchor: { key: "a", data: { s: "x".repeat(4096) } } });
    expect(k.sent("composed").length).toBe(3);
    expect(k.onCompose).not.toHaveBeenCalled();
  });

  it("opens only threads it knows, at most four a second", () => {
    const known = comment({ anchor: { kind: "page", key: "a" } });
    const k = kit({ items: [known] });
    k.send({ type: "hello" });
    k.send({ type: "open", id: "nope" });
    k.send({ type: "open", id: known.id });
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread.mock.calls).toEqual([[known.id]]);
    k.tick(250);
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread).toHaveBeenCalledTimes(2);
  });

  it("tells the page ids, pins, status and anchors only: no text of any kind", () => {
    const page = comment({
      anchor: {
        kind: "page",
        key: "slide-3",
        x: 1,
        y: 2,
        text: "Label the page chose",
        data: { z: 1 },
      },
    });
    const reply = comment({ parent_id: page.id, body: "Secret reply" });
    const element = comment({
      anchor: { selector: "h1", text: "Secret heading text", x: 0.5, y: 0.5 },
    });
    const resolved = comment({ status: "resolved", anchor: { kind: "page", key: "b" } });
    const plain = comment();
    const k = kit({ items: [page, reply, element, resolved, plain] });
    k.send({ type: "hello" });
    const items = k.sent("threads")[0]?.items as Record<string, unknown>[];
    expect(items).toEqual([
      {
        id: page.id,
        pin: 1,
        status: "open",
        anchor: { kind: "page", key: "slide-3", x: 1, y: 2, data: { z: 1 } },
      },
      { id: element.id, pin: 2, status: "open", anchor: { kind: "element", selector: "h1" } },
      { id: resolved.id, pin: 3, status: "resolved", anchor: { kind: "page", key: "b" } },
    ]);
    // The keys, pinned: adding a body, an author or a label later must fail here.
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["anchor", "id", "pin", "status"]);
      expect(Object.keys(item.anchor as object)).not.toContain("text");
    }
    const all = JSON.stringify(k.frameWin.postMessage.mock.calls);
    for (const secret of [
      "Secret",
      "secret@example.com",
      "Label the page chose",
      "@claude",
      "pending",
    ]) {
      expect(all).not.toContain(secret);
    }
    // A new comment: the page hears about it.
    const later = comment({ anchor: { kind: "page", key: "c" } });
    k.rerenderWith({ items: [page, reply, element, resolved, plain, later] });
    expect(k.sent("threads").length).toBe(2);
    // The same list again: nothing new.
    k.rerenderWith({ items: [page, reply, element, resolved, plain, later] });
    expect(k.sent("threads").length).toBe(2);
  });

  it("keeps positions of open anchored threads only, and drops more than 20 a second", () => {
    const page = comment({ anchor: { kind: "page", key: "a" } });
    const resolved = comment({ status: "resolved", anchor: { kind: "page", key: "b" } });
    const k = kit({ items: [page, resolved] });
    k.send({ type: "hello" });
    const pos = (id: string, left: number) => ({
      id,
      left,
      top: 0,
      width: 0,
      height: 0,
      visible: true,
    });
    k.send({ type: "positions", items: [pos(page.id, 5), pos(resolved.id, 6), pos("forged", 7)] });
    expect([...k.result.current.positions.keys()]).toEqual([page.id]);
    for (let i = 0; i < 25; i++) k.send({ type: "positions", items: [pos(page.id, 100 + i)] });
    expect(k.result.current.positions.get(page.id)?.left).toBe(118);
    k.tick(1000);
    k.send({ type: "positions", items: [pos(page.id, 1)] });
    expect(k.result.current.positions.get(page.id)?.left).toBe(1);
  });

  it("sends focus for page-anchored threads after hello", () => {
    const page = comment({ anchor: { kind: "page", key: "a" } });
    const element = comment({ anchor: { selector: "h1" } });
    const k = kit({ items: [page, element] });
    act(() => k.result.current.focus(page.id));
    expect(k.sent("focus")).toEqual([]);
    k.send({ type: "hello" });
    act(() => k.result.current.focus(page.id));
    act(() => k.result.current.focus(element.id));
    act(() => k.result.current.focus("nope"));
    expect(k.sent("focus")).toEqual([
      { type: "focus", id: page.id, source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
  });

  it("answers open requests when the frame goes away", () => {
    const k = kit();
    k.send({ type: "hello" });
    k.send({ type: "compose", req: REQ(1) });
    k.unmount();
    expect(k.sent("composed")).toEqual([
      { type: "composed", req: REQ(1), status: "closed", source: PAGE_COMMENTS_SOURCE, v: 1 },
    ]);
  });
});
