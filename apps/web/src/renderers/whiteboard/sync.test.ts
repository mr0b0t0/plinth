// Writing the board: a conflict re-reads and puts only the fields this change set on top (a field
// the other writer changed too keeps theirs, and the viewer is told), a block has one write in
// flight with later changes folded into the next, a delete can be undone (as new documents, ifRev
// 0), a rate limit waits once, and a refusal the viewer cannot fix turns the board read-only.
import type { BoardBlock } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { BoardModel } from "./model.ts";
import type { RuntimeCollection, RuntimeDoc } from "./runtime.ts";
import { BoardSync, KEPT_THEIRS_TEXT, READ_ONLY_TEXT, USE_MINE_LABEL } from "./sync.ts";

const blk = (x: number): BoardBlock => ({ kind: "note", x, y: 0, w: 100, h: 80, text: "" });

class Coll implements RuntimeCollection {
  docs = new Map<string, RuntimeDoc>();
  rev = 10;
  fail: ((op: string) => Error | null) | null = null;
  calls: { op: string; id?: string; data?: unknown; ifRev?: number }[] = [];
  private err(op: string) {
    const e = this.fail?.(op);
    if (e) throw e;
  }
  async list() {
    return { docs: [...this.docs.values()] };
  }
  async all() {
    return [...this.docs.values()];
  }
  async get(id: string) {
    this.calls.push({ op: "get", id });
    return this.docs.get(id) ?? null;
  }
  async add(data: unknown) {
    this.calls.push({ op: "add", data });
    this.err("add");
    const d = { id: `n${++this.rev}`, data, rev: this.rev };
    this.docs.set(d.id, d);
    return d;
  }
  async set(id: string, data: unknown, opts?: { ifRev?: number }) {
    this.calls.push({ op: "set", id, data, ifRev: opts?.ifRev });
    this.err("set");
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
  async delete(id: string, opts?: { ifRev?: number }) {
    this.calls.push({ op: "delete", id, ifRev: opts?.ifRev });
    this.err("delete");
    this.docs.delete(id);
  }
  onSnapshot() {
    return () => {};
  }
}

function setup() {
  const model = new BoardModel();
  const blocks = new Coll();
  const arrows = new Coll();
  const deps = {
    blocks,
    arrows,
    model,
    changed: vi.fn(),
    readOnly: vi.fn(),
    say: vi.fn(),
    emit: vi.fn(),
    wait: vi.fn(async () => {}),
  };
  const put = (id: string, data: BoardBlock, rev: number) => {
    blocks.docs.set(id, { id, data, rev });
    model.upsertBlock(id, data, rev);
  };
  return { sync: new BoardSync(deps), deps, blocks, arrows, model, put };
}

describe("BoardSync", () => {
  it("writes at the rev it read, and after a conflict puts its fields on the newer copy", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    // An agent changed the text in the meantime.
    blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "A2" }, rev: 7 });
    expect(await sync.saveBlock("a", { x: 10 })).toBe(true);
    const sets = blocks.calls.filter((c) => c.op === "set");
    expect(sets.map((c) => c.ifRev)).toEqual([3, 7]);
    // The move is kept and so is their text.
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(10), text: "A2" });
    expect(model.blocks.get("a")).toEqual({ data: { ...blk(10), text: "A2" }, rev: blocks.rev });
    expect(deps.emit).toHaveBeenCalledWith("block.saved", { id: "a" });
    expect(deps.say).not.toHaveBeenCalled();
  });

  it("keeps the other writer's value for a field both changed, and says so", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), color: "yellow" }, 3);
    blocks.docs.set("a", { id: "a", data: { ...blk(50), color: "yellow" }, rev: 7 });
    // This viewer moved it and coloured it; the other writer moved it too.
    expect(await sync.saveBlock("a", { x: 10, color: "blue" })).toBe(true);
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(50), color: "blue" });
    expect(model.blocks.get("a")?.data).toEqual({ ...blk(50), color: "blue" });
    expect(deps.say).toHaveBeenCalledWith(KEPT_THEIRS_TEXT);
  });

  it("writes nothing more when everything it changed was changed by someone else", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", blk(0), 3);
    blocks.docs.set("a", { id: "a", data: blk(50), rev: 7 });
    expect(await sync.saveBlock("a", { x: 10 })).toBe(true);
    expect(blocks.calls.filter((c) => c.op === "set")).toHaveLength(1);
    expect(blocks.docs.get("a")).toEqual({ id: "a", data: blk(50), rev: 7 });
    expect(model.blocks.get("a")).toEqual({ data: blk(50), rev: 7 });
    expect(deps.say).toHaveBeenCalledWith(KEPT_THEIRS_TEXT);
  });

  it("compares a drag with where the block was before it, not where it was dropped", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "A2" }, rev: 7 });
    // The board has already drawn the drag into the model when it saves.
    const e = model.blocks.get("a");
    if (e) e.data = { ...e.data, x: 10 };
    expect(await sync.saveBlock("a", { x: 10 }, { x: 0 })).toBe(true);
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(10), text: "A2" });
    expect(deps.say).not.toHaveBeenCalled();
  });

  it("drops a queued change to a field the other writer changed, and writes the rest", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", blk(0), 3);
    blocks.docs.set("a", { id: "a", data: { ...blk(50), text: "theirs" }, rev: 7 });
    const first = sync.saveBlock("a", { x: 10 });
    void sync.saveBlock("a", { x: 20, text: "mine", color: "blue" });
    expect(await first).toBe(true);
    // Their x and text stand; the colour, which they did not change, is written on top.
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(50), text: "theirs", color: "blue" });
    expect(blocks.calls.filter((c) => c.op === "set").map((c) => c.ifRev)).toEqual([3, 7]);
    // Their text was kept over the viewer's, which they are offered back.
    expect(deps.say).toHaveBeenCalledWith(
      KEPT_THEIRS_TEXT,
      expect.objectContaining({ label: USE_MINE_LABEL }),
    );
    deps.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() => expect(blocks.docs.get("a")?.data).toMatchObject({ text: "mine" }));
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(50), text: "mine", color: "blue" });
  });

  it("writes a change made over an older copy at that copy's rev", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    // The model was read again at rev 7 (their text) after the viewer began a text edit at 3.
    blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "theirs" }, rev: 7 });
    model.upsertBlock("a", { ...blk(0), text: "theirs" }, 7);
    expect(await sync.saveBlock("a", { text: "mine" }, { text: "A1" }, 3)).toBe(true);
    expect(blocks.calls.filter((c) => c.op === "set").map((c) => c.ifRev)).toEqual([3]);
    expect(blocks.docs.get("a")).toEqual({ id: "a", data: { ...blk(0), text: "theirs" }, rev: 7 });
    expect(deps.say).toHaveBeenCalledWith(
      KEPT_THEIRS_TEXT,
      expect.objectContaining({ label: USE_MINE_LABEL }),
    );
  });

  it("gives up after four conflicts", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", blk(0), 3);
    blocks.fail = (op) =>
      op === "set" ? Object.assign(new Error("c"), { code: "conflict" }) : null;
    expect(await sync.saveBlock("a", { x: 1 })).toBe(false);
    expect(blocks.calls.filter((c) => c.op === "set")).toHaveLength(4);
    expect(deps.say).toHaveBeenCalledWith("Someone else kept changing this block. Try again.");
  });

  it("keeps one write in flight per block and folds later changes into the next", async () => {
    const { sync, blocks, put, model } = setup();
    put("a", blk(0), 3);
    const first = sync.saveBlock("a", { x: 1 });
    const second = sync.saveBlock("a", { x: 2 });
    const third = sync.saveBlock("a", { x: 3 });
    expect(first).toBe(second);
    await Promise.all([first, second, third]);
    const sets = blocks.calls.filter((c) => c.op === "set");
    expect(sets.map((c) => (c.data as BoardBlock).x)).toEqual([1, 3]);
    expect(model.blocks.get("a")?.data.x).toBe(3);
  });

  it("deletes a block with its arrows, and the undo puts them back with ifRev 0", async () => {
    const { sync, blocks, arrows, model, put } = setup();
    put("a", blk(0), 3);
    put("b", blk(200), 4);
    arrows.docs.set("x", { id: "x", data: { from: "a", to: "b" }, rev: 5 });
    model.upsertArrow("x", { from: "a", to: "b" }, 5);
    const undo = await sync.deleteBlock("a");
    expect(undo).not.toBeNull();
    expect(model.blocks.has("a")).toBe(false);
    expect(model.arrows.has("x")).toBe(false);
    expect(blocks.calls.find((c) => c.op === "delete")).toMatchObject({ id: "a", ifRev: 3 });
    expect(arrows.calls.find((c) => c.op === "delete")).toMatchObject({ id: "x", ifRev: 5 });
    await undo?.undo();
    expect(blocks.calls.at(-1)).toMatchObject({ op: "set", id: "a", ifRev: 0 });
    expect(arrows.calls.at(-1)).toMatchObject({ op: "set", id: "x", ifRev: 0 });
    expect(model.blocks.has("a")).toBe(true);
    expect(model.arrows.has("x")).toBe(true);
  });

  it("waits once on rate_limited, then writes", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", blk(0), 3);
    let limited = true;
    blocks.fail = (op) => {
      if (op !== "set" || !limited) return null;
      limited = false;
      return Object.assign(new Error("slow"), { code: "rate_limited", retryAfter: 2 });
    };
    expect(await sync.saveBlock("a", { x: 1 })).toBe(true);
    expect(deps.wait).toHaveBeenCalledWith(2000);
    expect(deps.say).toHaveBeenCalledWith(expect.stringMatching(/^Slow down/));
  });

  it("turns read-only on read_only or forbidden, and stops writing", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", blk(0), 3);
    blocks.fail = () => Object.assign(new Error("ro"), { code: "read_only" });
    expect(await sync.saveBlock("a", { x: 1 })).toBe(false);
    expect(deps.readOnly).toHaveBeenCalledOnce();
    expect(deps.say).toHaveBeenCalledWith(READ_ONLY_TEXT);
    blocks.fail = null;
    expect(await sync.saveBlock("a", { x: 2 })).toBe(false);
    expect(await sync.addBlock(blk(3))).toBeNull();
    expect(blocks.calls.filter((c) => c.op === "set")).toHaveLength(1);
  });

  it("adds a block and an arrow, never the same arrow twice", async () => {
    const { sync, arrows } = setup();
    const a = await sync.addBlock(blk(0));
    const b = await sync.addBlock(blk(300));
    expect(a && b).toBeTruthy();
    expect(await sync.addArrow(a as string, b as string)).not.toBeNull();
    expect(await sync.addArrow(a as string, b as string)).toBeNull();
    expect(await sync.addArrow(a as string, a as string)).toBeNull();
    expect(arrows.calls.filter((c) => c.op === "add")).toHaveLength(1);
  });
});
