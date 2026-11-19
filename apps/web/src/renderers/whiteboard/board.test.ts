// A peer's drag is only drawn: it never enters the model's copy of the block, which is the
// server's and what a save starts from. So a viewer who edits a block's text while someone else
// drags it writes only the text, and the drop that follows keeps the move. The mirror case: a
// block this viewer is dragging or resizing is not read again when a peer saves it (it is read
// once the gesture ends), so the drop puts the gesture on top of the peer's change.
import { type BoardBlock, parseBoardSettings } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./board.ts";
import type { RuntimeCollection, RuntimeDoc } from "./runtime.ts";
import { BoardSync } from "./sync.ts";

const blk = (x: number, text = ""): BoardBlock => ({
  kind: "note",
  x,
  y: 0,
  w: 100,
  h: 80,
  text,
});

/** One collection both viewers write to, with the server's rev check. */
class Coll implements RuntimeCollection {
  docs = new Map<string, RuntimeDoc>();
  rev = 10;
  sets: { data: unknown; ifRev?: number }[] = [];
  async list() {
    return { docs: [...this.docs.values()] };
  }
  async all() {
    return [...this.docs.values()];
  }
  async get(id: string) {
    return this.docs.get(id) ?? null;
  }
  async add(data: unknown): Promise<RuntimeDoc> {
    const d = { id: `n${++this.rev}`, data, rev: this.rev };
    this.docs.set(d.id, d);
    return d;
  }
  async set(id: string, data: unknown, opts?: { ifRev?: number }) {
    this.sets.push({ data, ifRev: opts?.ifRev });
    const cur = this.docs.get(id);
    if (opts?.ifRev !== undefined && (cur?.rev ?? 0) !== opts.ifRev) {
      throw Object.assign(new Error("conflict"), { code: "conflict", currentRev: cur?.rev ?? 0 });
    }
    const d = { id, data, rev: ++this.rev };
    this.docs.set(id, d);
    return d;
  }
  async update(): Promise<RuntimeDoc> {
    throw new Error("unused");
  }
  async delete(id: string) {
    this.docs.delete(id);
  }
  onSnapshot() {
    return () => {};
  }
}

function viewer(blocks: Coll) {
  const root = document.createElement("main");
  document.body.append(root);
  const board = new Board({
    win: window,
    root,
    title: "Board",
    settings: parseBoardSettings('{"v":1}'),
  });
  const say = vi.fn();
  board.sync = new BoardSync({
    blocks,
    arrows: new Coll(),
    model: board.model,
    changed: () => board.redraw(),
    readOnly: () => board.setReadOnly(true),
    say,
    emit: () => {},
    busy: (id) => board.gesturing(id),
    wait: async () => {},
  });
  board.setReadOnly(false);
  return { board, say, root };
}

/** A pointer event on an element of the board, bubbling to the viewport's handlers. */
function pointer(el: Element, type: string, x: number, y = 0) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }),
  );
}

/** Two viewers of block "a" at x 0, rev 3. */
function pair() {
  const blocks = new Coll();
  blocks.docs.set("a", { id: "a", data: blk(0, "A1"), rev: 3 });
  const a = viewer(blocks);
  const b = viewer(blocks);
  for (const v of [a, b]) {
    v.board.model.upsertBlock("a", blk(0, "A1"), 3);
    v.board.redraw();
  }
  const el = (v: { root: HTMLElement }, sel = ".wb-block") => {
    const found = v.root.querySelector(sel);
    if (!found) throw new Error(`no ${sel}`);
    return found;
  };
  return { blocks, a, b, el };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Board and a peer's drag", () => {
  it("draws a peer's drag without changing the stored copy", () => {
    const blocks = new Coll();
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0, "A1"), 3);
    board.redraw();
    board.peerMoved("a", 40, 0);
    const el = root.querySelector<HTMLElement>(".wb-block");
    expect(el?.style.left).toBe("40px");
    expect(el?.classList.contains("moving")).toBe(true);
    expect(board.model.blocks.get("a")).toEqual({ data: blk(0, "A1"), rev: 3 });
  });

  it("a text save during a peer's drag writes only the text, and their drop keeps the move", async () => {
    const blocks = new Coll();
    blocks.docs.set("a", { id: "a", data: blk(0, "A1"), rev: 3 });
    const a = viewer(blocks);
    const b = viewer(blocks);
    for (const v of [a, b]) {
      v.board.model.upsertBlock("a", blk(0, "A1"), 3);
      v.board.redraw();
    }
    // B drags the block; A's board follows it live, then A finishes editing its text.
    a.board.peerMoved("a", 40, 0);
    a.board.startEditing("a");
    const ta = a.root.querySelector("textarea");
    if (!ta) throw new Error("no editor");
    ta.value = "hello";
    a.board.finishEditing(true);
    await vi.waitFor(() => expect(a.board.sync?.saving("a")).toBe(false));
    expect(blocks.sets[0]).toEqual({ data: blk(0, "hello"), ifRev: 3 });
    // B drops at 100: a conflict, and the move is put on top of A's text.
    expect(await b.board.sync?.saveBlock("a", { x: 100, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(blocks.docs.get("a")?.data).toEqual(blk(100, "hello"));
    expect(b.say).not.toHaveBeenCalled();
  });

  it("nudges a block from where it is drawn, and stops drawing the peer's drag", async () => {
    const blocks = new Coll();
    blocks.docs.set("a", { id: "a", data: blk(0), rev: 3 });
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0), 3);
    board.peerMoved("a", 40, 0);
    const el = root.querySelector<HTMLElement>(".wb-block");
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(blocks.sets).toHaveLength(1));
    expect(blocks.sets[0]).toEqual({ data: blk(50), ifRev: 3 });
    expect(el?.classList.contains("moving")).toBe(false);
  });

  it("drops a peer's drag once the block's stored copy changes", async () => {
    const blocks = new Coll();
    const { board, root } = viewer(blocks);
    board.model.upsertBlock("a", blk(0), 3);
    board.peerMoved("a", 40, 0);
    // The peer saved its drop: the board reads it again at the next rev.
    board.model.upsertBlock("a", blk(100), 4);
    board.redraw();
    const el = root.querySelector<HTMLElement>(".wb-block");
    expect(el?.style.left).toBe("100px");
    expect(el?.classList.contains("moving")).toBe(false);
  });
});

describe("Board and a peer's save during this viewer's gesture", () => {
  it("a peer's text save while this viewer drags keeps the drag, and the drop keeps both", async () => {
    const { blocks, a, b, el } = pair();
    // B presses on the block and drags it 100 to the right, then holds still.
    pointer(el(b), "pointerdown", 10);
    pointer(el(b), "pointermove", 110);
    expect(b.board.model.blocks.get("a")?.data.x).toBe(100);
    // A saves new text and says so: B's board is told to read the block again.
    expect(await a.board.sync?.saveBlock("a", { text: "hello" })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect((el(b) as HTMLElement).style.left).toBe("100px");
    // B lets go without moving again: the move goes on top of A's text.
    pointer(el(b), "pointerup", 110);
    await vi.waitFor(() => expect(b.board.sync?.saving("a")).toBe(false));
    expect(blocks.docs.get("a")?.data).toEqual(blk(100, "hello"));
    expect(b.say).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(b.board.model.blocks.get("a")?.data).toEqual(blk(100, "hello")));
  });

  it("a peer's move while this viewer resizes keeps the new size and their position", async () => {
    const { blocks, a, b, el } = pair();
    // Select the block so its resize handle shows, then drag the handle 50 right and 20 down.
    pointer(el(b), "pointerdown", 10);
    pointer(el(b), "pointerup", 10);
    const handle = el(b, ".wb-resize");
    pointer(handle, "pointerdown", 100, 80);
    pointer(handle, "pointermove", 150, 100);
    expect(b.board.model.blocks.get("a")?.data).toMatchObject({ w: 150, h: 100 });
    expect(await a.board.sync?.saveBlock("a", { x: 40, y: 0 }, { x: 0, y: 0 })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect(b.board.model.blocks.get("a")?.data).toMatchObject({ w: 150, h: 100 });
    pointer(handle, "pointerup", 150, 100);
    await vi.waitFor(() => expect(b.board.sync?.saving("a")).toBe(false));
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(40, "A1"), w: 150, h: 100 });
    expect(b.say).not.toHaveBeenCalled();
  });

  it("reads a block it skipped during a gesture again once the gesture ends without a save", async () => {
    const { a, b, el } = pair();
    pointer(el(b), "pointerdown", 10);
    expect(await a.board.sync?.saveBlock("a", { text: "hello" })).toBe(true);
    await b.board.sync?.refetch("blocks", "a");
    expect(b.board.model.blocks.get("a")?.rev).toBe(3);
    // A press and release with no move saves nothing, and catches up with A's save.
    pointer(el(b), "pointerup", 10);
    await vi.waitFor(() =>
      expect(b.board.model.blocks.get("a")).toEqual({ data: blk(0, "hello"), rev: 11 }),
    );
    expect(el(b).querySelector(".wb-text")?.textContent).toBe("hello");
  });

  it("reads a block it skipped during its own save again once that save settles", async () => {
    const { blocks, b } = pair();
    // B's write lands, but its answer is held until a peer has saved on top of it.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const set = blocks.set.bind(blocks);
    blocks.set = async (id, data, opts) => {
      const d = await set(id, data, opts);
      await gate;
      return d;
    };
    const saving = b.board.sync?.saveBlock("a", { text: "B" });
    await vi.waitFor(() => expect(blocks.sets).toHaveLength(1));
    blocks.docs.set("a", { id: "a", data: blk(40, "B"), rev: 20 });
    await b.board.sync?.refetch("blocks", "a");
    release();
    expect(await saving).toBe(true);
    await vi.waitFor(() =>
      expect(b.board.model.blocks.get("a")).toEqual({ data: blk(40, "B"), rev: 20 }),
    );
  });
});
