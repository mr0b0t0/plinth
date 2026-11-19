// Booting a whiteboard from a real shell's payload: the editor preview never touches shared data
// or the room (only the draft's own blocks are drawn, read-only); a page that is not a board says
// so; without the runtime, or with shared data unavailable, the board is empty, read-only and says
// why; live, it draws the snapshots and follows the room's answer. The runtime is captured before
// anything else, so an element the page adds later cannot stand in for it.
import { BOARD_LIMITS, boardDocError, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, PREVIEW_TEXT } from "./boot.ts";

const DRAFT = JSON.stringify({
  v: 1,
  blocks: [
    { id: "goal", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Ship v2" },
    { id: "risk", kind: "rect", x: 320, y: 0, w: 200, h: 100, text: "Risks" },
  ],
  arrows: [{ id: "a1", from: "goal", to: "risk" }],
});

function mount(text: string, preview = false) {
  const html = typedShellHtml(TYPE_REGISTRY.whiteboard, {
    title: "Board",
    text,
    base: "",
    appOrigin: "https://plinth.example",
    ...(preview ? { preview: true as const } : {}),
  });
  const main = /<main [^>]*><\/main>/.exec(html)?.[0];
  const data = /<script type="application\/json"[^>]*>[^<]*<\/script>/.exec(html)?.[0];
  if (!main || !data) throw new Error("unexpected shell");
  document.body.innerHTML = main + data;
  document.documentElement.removeAttribute("data-ready");
}

interface Stub {
  runtime: Record<string, unknown>;
  calls: string[];
  collection: ReturnType<typeof vi.fn>;
  roomTouched: () => boolean;
}

/** A window.plinth whose every data and room method records that it was called. */
function stubRuntime(
  session: Record<string, unknown> = { available: true, reason: null, canWrite: true },
  docs: Record<string, unknown[]> = {},
): Stub {
  const calls: string[] = [];
  let touched = false;
  const coll = (name: string) => {
    const m = (op: string, ret: unknown = undefined) =>
      vi.fn(async () => {
        calls.push(`${name}.${op}`);
        return ret;
      });
    return {
      list: m("list", { docs: [] }),
      all: m("all", []),
      get: m("get", null),
      add: m("add"),
      set: m("set"),
      update: m("update"),
      delete: m("delete"),
      onSnapshot: vi.fn((onDocs: (d: unknown[]) => void) => {
        calls.push(`${name}.onSnapshot`);
        queueMicrotask(() => onDocs(docs[name] ?? []));
        return () => {};
      }),
    };
  };
  const collection = vi.fn((name: string) => coll(name));
  const roomFn = (op: string) =>
    vi.fn(() => {
      calls.push(`room.${op}`);
      return () => {};
    });
  const room = {
    get ready() {
      touched = true;
      calls.push("room.ready");
      return Promise.resolve({ available: true, reason: null, canEmit: () => true });
    },
    presence: roomFn("presence"),
    emit: roomFn("emit"),
    join: roomFn("join"),
    on: roomFn("on"),
    onPeers: roomFn("onPeers"),
    onStatus: vi.fn((fn: (s: string) => void) => {
      calls.push("room.onStatus");
      fn("open");
      return () => {};
    }),
  };
  const runtime = { ready: Promise.resolve(session), db: { collection }, room };
  Object.defineProperty(window, "plinth", { value: runtime, configurable: true, writable: true });
  return { runtime, calls, collection, roomTouched: () => touched };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const ready = () => document.documentElement.getAttribute("data-ready");
const banner = () => document.querySelector(".wb-banner")?.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".wb-toolbar button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );

afterEach(() => {
  delete (window as unknown as { plinth?: unknown }).plinth;
  document.body.innerHTML = "";
});

describe("whiteboard boot", () => {
  it("in the editor preview, calls nothing on the runtime and draws only the draft", async () => {
    const stub = stubRuntime();
    mount(DRAFT, true);
    const board = boot(window);
    expect(board).not.toBeNull();
    // A drag and some keys on a block, as an author trying the preview would.
    const el = document.querySelector<HTMLElement>(".wb-block");
    el?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 5, clientY: 5 }),
    );
    document
      .querySelector(".wb-viewport")
      ?.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 60, clientY: 60 }),
      );
    document
      .querySelector(".wb-viewport")
      ?.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 60, clientY: 60 }),
      );
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    button("Add note")?.click();
    await flush();
    expect(stub.calls).toEqual([]);
    expect(stub.collection).not.toHaveBeenCalled();
    expect(stub.roomTouched()).toBe(false);
    expect(banner()).toBe(PREVIEW_TEXT);
    expect(document.querySelectorAll(".wb-block")).toHaveLength(2);
    expect(document.querySelectorAll(".wb-arrow")).toHaveLength(1);
    for (const label of ["Add note", "Add box", "Delete", "Connect"]) {
      expect(button(label)?.disabled, label).toBe(true);
    }
    expect(button("Export as SVG")?.disabled).toBe(false);
    expect(ready()).toBe("ok");
  });

  it("in the preview, a draft that does not parse yet shows an empty board", () => {
    stubRuntime();
    mount("{not json", true);
    boot(window);
    expect(document.querySelectorAll(".wb-block")).toHaveLength(0);
    expect(banner()).toBe(PREVIEW_TEXT);
  });

  it("says so for a page that is not a board", () => {
    document.body.innerHTML = '<main id="__plinth-whiteboard"></main>';
    expect(boot(window)).toBeNull();
    expect(ready()).toBe("error");
    expect(document.body.textContent).toContain("not a whiteboard");
  });

  it("without the runtime: empty, read-only, and says why", () => {
    mount('{"v":1}');
    boot(window);
    expect(banner()).toMatch(/runtime did not load/);
    expect(button("Add note")?.disabled).toBe(true);
    expect(document.documentElement.dataset.readonly).toBe("true");
    expect(ready()).toBe("ok");
  });

  it("with shared data unavailable: says why, and never opens the room", async () => {
    const stub = stubRuntime({ available: false, reason: "disabled", canWrite: false });
    mount('{"v":1}');
    boot(window);
    await flush();
    expect(banner()).toMatch(/page data is turned off on this server/);
    expect(stub.roomTouched()).toBe(false);
    expect(stub.collection).not.toHaveBeenCalled();
    expect(ready()).toBe("ok");
  });

  it("live: draws the snapshots, then follows the room's answer", async () => {
    const stub = stubRuntime(
      { available: true, reason: null, canWrite: true },
      {
        blocks: [
          {
            id: "goal",
            data: { kind: "note", x: 0, y: 0, w: 200, h: 140, text: "<b>x</b>" },
            rev: 3,
          },
        ],
        arrows: [],
      },
    );
    mount('{"v":1,"background":"grid"}');
    boot(window);
    await flush();
    await flush();
    expect(stub.collection.mock.calls.map((c) => c[0])).toEqual(["blocks", "arrows"]);
    const el = document.querySelector(".wb-block");
    expect(el?.textContent).toBe("<b>x</b>");
    expect(el?.querySelector("b")).toBeNull();
    expect(document.querySelector(".wb-viewport")?.getAttribute("data-bg")).toBe("grid");
    expect(button("Add note")?.disabled).toBe(false);
    expect(document.documentElement.dataset.room).toBe("open");
    expect(ready()).toBe("ok");
  });

  it("adds a block in front, at most at the largest z, when a block is already there", async () => {
    const stub = stubRuntime(
      { available: true, reason: null, canWrite: true },
      {
        blocks: [
          {
            id: "top",
            data: { kind: "note", x: 0, y: 0, w: 200, h: 140, text: "", z: BOARD_LIMITS.maxZ },
            rev: 3,
          },
        ],
        arrows: [],
      },
    );
    mount('{"v":1}');
    boot(window);
    await flush();
    await flush();
    button("Add note")?.click();
    await flush();
    const blocks = stub.collection.mock.results[0]?.value as { add: ReturnType<typeof vi.fn> };
    expect(blocks.add).toHaveBeenCalledOnce();
    const data = blocks.add.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(data.z).toBe(BOARD_LIMITS.maxZ);
    expect(boardDocError("blocks", data)).toBeNull();
  });

  it("keeps the runtime it captured, whatever the page adds afterwards", async () => {
    let resolve!: (s: unknown) => void;
    const stub = stubRuntime();
    (stub.runtime as { ready: Promise<unknown> }).ready = new Promise((r) => {
      resolve = r;
    });
    mount('{"v":1}');
    boot(window);
    const decoy = document.createElement("div");
    decoy.id = "plinth";
    document.body.append(decoy);
    Object.defineProperty(window, "plinth", { value: decoy, configurable: true, writable: true });
    resolve({ available: true, reason: null, canWrite: true });
    await flush();
    await flush();
    expect(stub.collection).toHaveBeenCalledWith("blocks");
  });
});
