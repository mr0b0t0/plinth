// Booting a whiteboard from a real shell's payload: a page that is not a board says so; without
// the runtime, or with shared data unavailable, the board is empty, read-only and says why; live,
// it draws the snapshots and follows the room's answer. The toolbar shows only what applies, and
// only the app page that frames the board may ask it for a download. The runtime is captured
// before anything else, so an element the page adds later cannot stand in for it.
import { BOARD_LIMITS, boardDocError, TYPE_REGISTRY, typedShellHtml } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot } from "./boot.ts";
import { READ_ONLY_TEXT } from "./sync.ts";

const APP = "https://plinth.example";

function mount(text: string) {
  const html = typedShellHtml(TYPE_REGISTRY.whiteboard, {
    title: "Board",
    text,
    base: "",
    appOrigin: APP,
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

/** Whether a toolbar control is shown: neither it nor its group is hidden. */
const shown = (label: string) => {
  const b = button(label);
  return !!b && !b.hidden && !b.closest<HTMLElement>("[hidden]");
};

const NOTE = {
  id: "goal",
  data: { kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Ship v2", color: "green" },
  rev: 3,
};
const LABEL = {
  id: "head",
  data: { kind: "text", x: 0, y: 240, w: 240, h: 60, text: "Hi" },
  rev: 1,
};

describe("whiteboard boot", () => {
  it("shows the selection's controls only while something is selected", async () => {
    stubRuntime(
      { available: true, reason: null, canWrite: true },
      { blocks: [NOTE, LABEL], arrows: [] },
    );
    mount('{"v":1}');
    boot(window);
    await flush();
    await flush();
    expect(shown("Add note")).toBe(true);
    expect(shown("Fit the board")).toBe(true);
    for (const label of ["Green", "Connect", "Delete"]) expect(shown(label), label).toBe(false);
    // Alone on the board: no status and no people list to show.
    expect(document.querySelector(".wb-status")?.textContent).toBe("");
    expect(document.querySelector(".wb-people")?.children).toHaveLength(0);

    const note = document.querySelector<HTMLElement>('[aria-label="Note: Ship v2"]');
    note?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    for (const label of ["Green", "Connect", "Delete"]) expect(shown(label), label).toBe(true);
    expect(button("Green")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Yellow")?.getAttribute("aria-pressed")).toBe("false");

    // A text block takes no colour.
    const text = document.querySelector<HTMLElement>('[aria-label="Text: Hi"]');
    text?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(shown("Green")).toBe(false);
    expect(shown("Delete")).toBe(true);

    // Connect starts from the selected block: one more block finishes the arrow.
    const connect = button("Connect");
    connect?.click();
    expect(connect?.textContent).toBe("Pick a block…");
    expect(connect?.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the edit tools from a viewer, who sees a short read-only line", async () => {
    stubRuntime({ available: true, reason: null, canWrite: false }, { blocks: [NOTE], arrows: [] });
    mount('{"v":1}');
    boot(window);
    await flush();
    await flush();
    expect(banner()).toBe(READ_ONLY_TEXT);
    expect(shown("Add note")).toBe(false);
    document
      .querySelector('[aria-label="Note: Ship v2"]')
      ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    for (const label of ["Green", "Connect", "Delete"]) expect(shown(label), label).toBe(false);
    expect(shown("Fit the board")).toBe(true);
  });

  it("downloads only when the app page that frames it asks", () => {
    mount('{"v":1}');
    const board = boot(window);
    if (!board) throw new Error("no board");
    const exportAs = vi.spyOn(board, "exportAs").mockResolvedValue();
    const send = (data: unknown, origin: string, source: unknown = window.parent) =>
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
    const msg = (format: string) => ({ source: "plinth-renderer", v: 1, type: "export", format });
    send(msg("svg"), "https://elsewhere.example");
    send(msg("svg"), APP, null);
    send(msg("pdf"), APP);
    send({ ...msg("png"), v: 2 }, APP);
    expect(exportAs).not.toHaveBeenCalled();
    send(msg("png"), APP);
    send(msg("svg"), APP);
    expect(exportAs.mock.calls).toEqual([["png"], ["svg"]]);
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
