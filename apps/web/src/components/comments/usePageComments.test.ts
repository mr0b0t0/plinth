import { type CommentInfo, PAGE_COMMENTS_SOURCE } from "@plinth/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type StagePageCommentsOptions,
  type UsePageCommentsOptions,
  usePageComments,
  useStagePageComments,
} from "./usePageComments.ts";

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
    mentions: [
      {
        task_id: "t",
        target: "@claude",
        state: "pending",
        delivery: "waiting" as const,
        result_version: null,
      },
    ],
    ...over,
  };
}

function kit(over: Partial<UsePageCommentsOptions> = {}) {
  const frameWin = { postMessage: vi.fn() };
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: frameWin });
  let clock = 10_000;
  const panel = { open: true };
  const onCompose = vi.fn();
  const onOpenThread = vi.fn();
  const initial: UsePageCommentsOptions = {
    frame,
    contentOrigin: ORIGIN,
    opaque: false,
    enabled: true,
    items: [],
    blocked: false,
    panelOpen: () => panel.open,
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
    panel,
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

  it("refuses open while a dialog is open and while the tab is hidden", () => {
    const known = comment({ anchor: { kind: "page", key: "a" } });
    const k = kit({ items: [known], blocked: true });
    k.send({ type: "hello" });
    k.send({ type: "open", id: known.id });
    k.rerenderWith({ items: [known], blocked: false });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    k.tick(2000);
    k.send({ type: "open", id: known.id });
    hidden.mockRestore();
    expect(k.onOpenThread).not.toHaveBeenCalled();
    k.tick(2000);
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread.mock.calls).toEqual([[known.id]]);
  });

  it("reopens a closed panel at most once a second, for compose and open together", () => {
    const known = comment({ anchor: { kind: "page", key: "a" } });
    const k = kit({ items: [known] });
    k.panel.open = false;
    k.send({ type: "hello" });
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread).toHaveBeenCalledTimes(1);
    // The person closes the panel at once; the page keeps asking, four times a second.
    for (let i = 0; i < 3; i++) {
      k.tick(250);
      k.send({ type: "open", id: known.id });
    }
    expect(k.onOpenThread).toHaveBeenCalledTimes(1);
    // A compose in the same second would reopen it too: refused, and answered.
    k.send({ type: "compose", req: REQ(1) });
    expect(k.onCompose).not.toHaveBeenCalled();
    expect(k.sent("composed").map((m) => [m.req, m.status])).toEqual([[REQ(1), "closed"]]);
    k.tick(250);
    k.send({ type: "compose", req: REQ(2) });
    expect(k.onCompose).toHaveBeenCalledTimes(1);
    k.tick(250);
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread).toHaveBeenCalledTimes(1);
    // While the panel is open, showing a thread does not reopen anything: four a second.
    k.panel.open = true;
    k.send({ type: "open", id: known.id });
    k.tick(250);
    k.send({ type: "open", id: known.id });
    expect(k.onOpenThread).toHaveBeenCalledTimes(3);
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
      "waiting",
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

  const pos = (id: string, left: number) => ({
    id,
    left,
    top: 0,
    width: 0,
    height: 0,
    visible: true,
  });

  it("keeps positions of open anchored threads only, and coalesces more than 20 a second", () => {
    vi.useFakeTimers();
    try {
      const page = comment({ anchor: { kind: "page", key: "a" } });
      const resolved = comment({ status: "resolved", anchor: { kind: "page", key: "b" } });
      const k = kit({ items: [page, resolved] });
      k.send({ type: "hello" });
      k.send({
        type: "positions",
        items: [pos(page.id, 5), pos(resolved.id, 6), pos("forged", 7)],
      });
      expect([...k.result.current.positions.keys()]).toEqual([page.id]);
      for (let i = 0; i < 25; i++) k.send({ type: "positions", items: [pos(page.id, 100 + i)] });
      // 20 in the window; the rest wait, and the page never sends its last position again.
      expect(k.result.current.positions.get(page.id)?.left).toBe(118);
      act(() => {
        k.tick(999);
        vi.advanceTimersByTime(999);
      });
      expect(k.result.current.positions.get(page.id)?.left).toBe(118);
      act(() => {
        k.tick(1);
        vi.advanceTimersByTime(1);
      });
      // The window ended: the latest report is applied, and only that one.
      expect(k.result.current.positions.get(page.id)?.left).toBe(124);
      act(() => {
        k.tick(1000);
        vi.advanceTimersByTime(1000);
      });
      k.send({ type: "positions", items: [pos(page.id, 1)] });
      expect(k.result.current.positions.get(page.id)?.left).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not parse reports over the rate until their turn", () => {
    vi.useFakeTimers();
    try {
      const page = comment({ anchor: { kind: "page", key: "a" } });
      const k = kit({ items: [page] });
      k.send({ type: "hello" });
      for (let i = 0; i < 20; i++) k.send({ type: "positions", items: [pos(page.id, i)] });
      let reads = 0;
      const items = new Proxy([pos(page.id, 50)], {
        get(target, key, receiver) {
          if (key === "length") reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      k.send({ type: "positions", items });
      expect(reads).toBe(0);
      act(() => {
        k.tick(1000);
        vi.advanceTimersByTime(1000);
      });
      expect(reads).toBeGreaterThan(0);
      expect(k.result.current.positions.get(page.id)?.left).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps positions aside while the pins are hidden, and shows the latest when they show", () => {
    const page = comment({ anchor: { kind: "page", key: "a" } });
    const k = kit({ items: [page], showPins: false });
    k.send({ type: "hello" });
    const before = k.result.current.positions;
    k.send({ type: "positions", items: [pos(page.id, 7)] });
    k.send({ type: "positions", items: [pos(page.id, 8)] });
    // No state change, so the stage does not re-render for pins nobody sees.
    expect(k.result.current.positions).toBe(before);
    expect(k.result.current.positions.size).toBe(0);
    k.rerenderWith({ items: [page], showPins: true });
    expect(k.result.current.positions.get(page.id)?.left).toBe(8);
    k.send({ type: "positions", items: [pos(page.id, 9)] });
    expect(k.result.current.positions.get(page.id)?.left).toBe(9);
  });

  it("answers hello at most once a second", () => {
    const page = comment({ anchor: { kind: "page", key: "a" } });
    const k = kit({ items: [page] });
    for (let i = 0; i < 200; i++) k.send({ type: "hello" });
    expect(k.sent("welcome").length).toBe(1);
    expect(k.sent("threads").length).toBe(1);
    k.tick(999);
    k.send({ type: "hello" });
    expect(k.sent("welcome").length).toBe(1);
    k.tick(1);
    // The runtime's own retry comes a second after an unanswered hello: it is answered.
    k.send({ type: "hello" });
    expect(k.sent("welcome").length).toBe(2);
    expect(k.sent("threads").length).toBe(2);
    // A new frame starts afresh.
    const next = document.createElement("iframe");
    const nextWin = { postMessage: vi.fn() };
    Object.defineProperty(next, "contentWindow", { configurable: true, value: nextWin });
    k.rerenderWith({ items: [page], frame: next });
    k.send({ type: "hello" }, nextWin);
    expect(nextWin.postMessage.mock.calls.filter(([m]) => m.type === "welcome").length).toBe(1);
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

describe("useStagePageComments", () => {
  function stage() {
    const frameWin = { postMessage: vi.fn() };
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: frameWin });
    const openComments = vi.fn();
    const initial: StagePageCommentsOptions = {
      gate: { page_comments: true, artifact: { type: "html" } } as StagePageCommentsOptions["gate"],
      frame,
      contentOrigin: ORIGIN,
      opaque: false,
      items: [],
      blocked: false,
      commentsOpen: false,
      openComments,
    };
    const hook = renderHook((p: StagePageCommentsOptions) => useStagePageComments(p), {
      initialProps: initial,
    });
    const send = (data: Record<string, unknown>) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { source: PAGE_COMMENTS_SOURCE, v: 1, ...data },
            origin: ORIGIN,
            source: frameWin as unknown as MessageEventSource,
          }),
        );
      });
    return {
      ...hook,
      send,
      openComments,
      rerenderWith: (p: Partial<StagePageCommentsOptions>) => hook.rerender({ ...initial, ...p }),
    };
  }

  it("says when a page request opened the panel, so the panel does not take focus", () => {
    const k = stage();
    expect(k.result.current.openedByPage).toBe(false);
    k.send({ type: "hello" });
    k.send({ type: "compose", req: REQ(1) });
    expect(k.openComments).toHaveBeenCalledTimes(1);
    expect(k.result.current.openedByPage).toBe(true);
    expect(k.result.current.pageCompose).toEqual({ req: REQ(1), anchor: null });
    k.rerenderWith({ commentsOpen: true });
    expect(k.result.current.openedByPage).toBe(true);
    // The person closes it, and later opens it again themselves.
    k.rerenderWith({ commentsOpen: false });
    expect(k.result.current.openedByPage).toBe(false);
    k.rerenderWith({ commentsOpen: true });
    expect(k.result.current.openedByPage).toBe(false);
  });
});
