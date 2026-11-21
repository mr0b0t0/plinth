// Writing the board: a conflict re-reads and puts only the fields this change set on top (a field
// the other writer changed too keeps theirs, and the viewer is told), a block has one write in
// flight with later changes folded into the next, a delete can be undone (as new documents, ifRev
// 0), a rate limit waits once, and a refusal the viewer cannot fix turns the board read-only.
import type { BoardBlock } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { BoardModel } from "./model.ts";
import type { RuntimeCollection, RuntimeDoc } from "./runtime.ts";
import {
  BoardSync,
  DELETED_AS_NOTE_TEXT,
  KEPT_AS_NOTE_TEXT,
  KEPT_CHANGING_NOTE_TEXT,
  KEPT_THEIRS_TEXT,
  noteTexts,
  READ_ONLY_TEXT,
  SAVE_FAILED_NOTE_TEXT,
  USE_MINE_LABEL,
} from "./sync.ts";

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
    held: vi.fn(),
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
    // Their text was kept over the viewer's, which is a note beside it and offered back.
    await vi.waitFor(() =>
      expect(deps.say).toHaveBeenCalledWith(
        KEPT_AS_NOTE_TEXT,
        expect.objectContaining({ label: USE_MINE_LABEL }),
      ),
    );
    const note = blocks.calls.find((c) => c.op === "add");
    expect(note?.data).toMatchObject({ kind: "note", x: 174, y: 0, text: "mine" });
    deps.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() => expect(blocks.docs.get("a")?.data).toMatchObject({ text: "mine" }));
    expect(blocks.docs.get("a")?.data).toEqual({ ...blk(50), text: "mine", color: "blue" });
    // Mine is in place: the note goes again.
    await vi.waitFor(() => expect(blocks.docs.size).toBe(1));
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
    await vi.waitFor(() =>
      expect(deps.say).toHaveBeenCalledWith(
        KEPT_AS_NOTE_TEXT,
        expect.objectContaining({ label: USE_MINE_LABEL }),
      ),
    );
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text)).toEqual([
      "theirs",
      "mine",
    ]);
  });

  it("keeps a note the viewer changed when Use mine puts the text back", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "theirs" }, rev: 7 });
    model.upsertBlock("a", { ...blk(0), text: "theirs" }, 7);
    await sync.saveBlock("a", { text: "mine" }, { text: "A1" }, 3);
    await vi.waitFor(() => expect(deps.say).toHaveBeenCalled());
    const id = [...blocks.docs.keys()].find((k) => k !== "a") as string;
    // The viewer edits the note before choosing Use mine: it stays.
    await sync.saveBlock(id, { text: "mine, and more" });
    deps.say.mock.calls.at(-1)?.[1]?.run();
    await vi.waitFor(() => expect(blocks.docs.get("a")?.data).toMatchObject({ text: "mine" }));
    await Promise.resolve();
    expect(blocks.docs.get(id)?.data).toMatchObject({ text: "mine, and more" });
  });

  it("keeps the viewer's cells from every attempt when a table keeps conflicting", async () => {
    const { sync, blocks, model, deps } = setup();
    const tbl = (c1: string, c2: string): BoardBlock => ({
      kind: "table",
      x: 0,
      y: 0,
      w: 200,
      h: 60,
      text: "",
      cols: { c1: { at: 1 }, c2: { at: 2 } },
      rows: { r1: { at: 1, c1, c2 } },
    });
    blocks.docs.set("t", { id: "t", data: tbl("a", "b"), rev: 3 });
    model.upsertBlock("t", tbl("a", "b"), 3);
    // Each write finds a peer's newer copy: first with the same cell changed (hers is lost to
    // theirs), then with other changes, until the four attempts are spent.
    let n = 0;
    const set = blocks.set.bind(blocks);
    blocks.set = async (id, data, opts) => {
      n++;
      const cur = blocks.docs.get(id);
      blocks.docs.set(id, {
        id,
        data: n === 1 ? tbl("theirs", "b") : { ...(cur?.data as BoardBlock), x: n },
        rev: 100 + n,
      });
      return set(id, data, opts);
    };
    const rows = { r1: { at: 1, c1: "mine", c2: "mine too" } };
    expect(await sync.saveBlock("t", { rows }, undefined, 3)).toBe(false);
    await vi.waitFor(() =>
      expect(deps.say).toHaveBeenCalledWith(
        KEPT_CHANGING_NOTE_TEXT,
        expect.objectContaining({ label: USE_MINE_LABEL }),
      ),
    );
    // One message, after the attempts: nothing earlier replaced it. The cell lost to theirs on
    // the first attempt and the one never written are both in the note.
    expect(deps.say).toHaveBeenCalledTimes(1);
    expect(
      blocks.calls.filter((c) => c.op === "add").map((c) => (c.data as BoardBlock).text),
    ).toEqual(["mine\nmine too"]);
    // Use mine puts both back in their cells.
    blocks.set = set;
    deps.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() =>
      expect((blocks.docs.get("t")?.data as BoardBlock | undefined)?.rows?.r1).toEqual({
        at: 1,
        c1: "mine",
        c2: "mine too",
      }),
    );
  });

  it("holds the text when no note can take it, until a later write lets it become one", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    blocks.docs.delete("a");
    // The block was deleted meanwhile, and the board is full: no note fits.
    blocks.fail = (op) =>
      op === "add" ? Object.assign(new Error("full"), { code: "quota_exceeded" }) : null;
    expect(await sync.saveBlock("a", { text: "mine" })).toBe(false);
    await vi.waitFor(() => expect(deps.held).toHaveBeenLastCalledWith(["mine"]));
    expect(sync.heldTexts()).toEqual(["mine"]);
    // Messages come and go; what is held stays.
    deps.say("Block deleted.");
    expect(sync.heldTexts()).toEqual(["mine"]);
    // Room is made: the next write that goes through writes it as a note.
    blocks.fail = null;
    put("b", blk(300), 4);
    expect(await sync.saveBlock("b", { x: 310 })).toBe(true);
    await vi.waitFor(() => expect(deps.held).toHaveBeenLastCalledWith([]));
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text)).toContain("mine");
    expect(deps.say).toHaveBeenLastCalledWith("What you wrote is saved in a new note.");
  });

  it("waits once on a rate limit before writing a note", async () => {
    const { sync, blocks, deps } = setup();
    let limited = true;
    blocks.fail = (op) => {
      if (op !== "add" || !limited) return null;
      limited = false;
      return Object.assign(new Error("slow"), { code: "rate_limited", retryAfter: 3 });
    };
    await sync.keepTyped({ x: 0, y: 0, w: 100, h: 80 }, ["mine"], DELETED_AS_NOTE_TEXT);
    expect(deps.wait).toHaveBeenCalledWith(3000);
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text)).toEqual(["mine"]);
    expect(deps.held).not.toHaveBeenCalled();
  });

  it("keeps what the viewer wrote when a save fails for another reason: as a note, or held", async () => {
    const { sync, blocks, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    blocks.fail = (op) =>
      op === "set" ? Object.assign(new Error("off"), { code: "network" }) : null;
    expect(await sync.saveBlock("a", { text: "mine" })).toBe(false);
    await vi.waitFor(() =>
      expect(deps.say).toHaveBeenLastCalledWith(SAVE_FAILED_NOTE_TEXT, undefined),
    );
    expect([...blocks.docs.values()].map((d) => (d.data as BoardBlock).text).sort()).toEqual([
      "A1",
      "mine",
    ]);
    // Offline for the note too: held instead.
    blocks.fail = () => Object.assign(new Error("off"), { code: "network" });
    expect(await sync.saveBlock("a", { text: "mine again" })).toBe(false);
    await vi.waitFor(() => expect(sync.heldTexts()).toEqual(["mine again"]));
  });

  it("leaves the note when Use mine did not put the text in place", async () => {
    const { sync, blocks, model, put, deps } = setup();
    put("a", { ...blk(0), text: "A1" }, 3);
    blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "theirs" }, rev: 7 });
    model.upsertBlock("a", { ...blk(0), text: "theirs" }, 7);
    await sync.saveBlock("a", { text: "mine" }, { text: "A1" }, 3);
    await vi.waitFor(() =>
      expect(deps.say).toHaveBeenCalledWith(KEPT_AS_NOTE_TEXT, expect.anything()),
    );
    const note = [...blocks.docs.keys()].find((k) => k !== "a") as string;
    // Before she presses Use mine, someone writes again: her save keeps theirs once more.
    const set = blocks.set.bind(blocks);
    let once = true;
    blocks.set = async (id, data, opts) => {
      if (id === "a" && once) {
        once = false;
        blocks.docs.set("a", { id: "a", data: { ...blk(0), text: "theirs 2" }, rev: 50 });
      }
      return set(id, data, opts);
    };
    deps.say.mock.calls[0]?.[1]?.run();
    await vi.waitFor(() => expect(deps.say).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(blocks.docs.get("a")?.data).toMatchObject({ text: "theirs 2" });
    // The first note stays (and the second save kept hers in a note of its own).
    expect(blocks.docs.get(note)?.data).toMatchObject({ text: "mine" });
  });

  it("joins what is kept into as few notes as the text limit allows", () => {
    expect(noteTexts(["a", "", "b"])).toEqual(["a\nb"]);
    const big = "x".repeat(4000);
    expect(noteTexts([big, "y"])).toEqual([big, "y"]);
    expect(noteTexts([`${big}z`])).toEqual([big, "z"]);
    expect(noteTexts([""])).toEqual([]);
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
