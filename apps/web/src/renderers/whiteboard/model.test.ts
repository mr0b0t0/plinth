// The board model: documents in, clamped and well formed; an older copy never replaces a newer
// one; a snapshot replaces what was saved; draw order is z, then id, and a new block's z stays in
// bounds. The camera has its own tests (camera.test.ts).
import { BOARD_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { BoardModel } from "./model.ts";

const b = (over: Record<string, unknown> = {}) => ({
  kind: "note",
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  text: "",
  ...over,
});

describe("BoardModel", () => {
  it("keeps the newer copy of a block and drops what is not one", () => {
    const m = new BoardModel();
    expect(m.upsertBlock("a", b({ x: 5 }), 3)).toBe(true);
    expect(m.upsertBlock("a", b({ x: 9 }), 2)).toBe(false);
    expect(m.blocks.get("a")).toEqual({ data: b({ x: 5 }), rev: 3 });
    expect(m.upsertBlock("a", b({ x: 7 }), 3)).toBe(true);
    expect(m.upsertBlock("u_0123456789abcdef01234567", b(), 1)).toBe(false);
    expect(m.upsertBlock("b", { x: "1" }, 1)).toBe(false);
    expect(m.upsertBlock("c", b({ x: 9e9, w: 1 }), 1)).toBe(true);
    expect(m.blocks.get("c")?.data).toMatchObject({ x: 1_000_000, w: 24 });
  });

  it("applies a snapshot: saved blocks it lacks are gone, unsaved ones stay", () => {
    const m = new BoardModel();
    m.upsertBlock("a", b(), 1);
    m.upsertBlock("b", b(), 2);
    m.upsertBlock("local", b(), 0);
    m.applySnapshot("blocks", [{ id: "b", data: b({ text: "x" }), rev: 4 }]);
    expect([...m.blocks.keys()].sort()).toEqual(["b", "local"]);
    expect(m.blocks.get("b")?.data.text).toBe("x");
  });

  it("orders by z then id, finds a block's arrows and the board's bounds", () => {
    const m = new BoardModel();
    m.upsertBlock("b", b({ z: 1, x: 100, y: 50 }), 1);
    m.upsertBlock("a", b({ z: 1, x: -20 }), 1);
    m.upsertBlock("c", b({ z: -1, y: 300 }), 1);
    expect(m.ordered().map(([id]) => id)).toEqual(["c", "a", "b"]);
    expect(m.topZ()).toBe(1);
    expect(m.bounds()).toEqual({ x: -20, y: 0, w: 220, h: 380 });
    m.upsertArrow("x", { from: "a", to: "b" }, 1);
    m.upsertArrow("y", { from: "c", to: "b" }, 1);
    expect(m.arrowsOf("a").map(([id]) => id)).toEqual(["x"]);
    expect(new BoardModel().bounds()).toBeNull();
  });

  it("puts a new block in front, but never past the largest z a block may have", () => {
    const m = new BoardModel();
    expect(m.nextZ()).toBe(1);
    m.upsertBlock("a", b({ z: 41 }), 1);
    expect(m.nextZ()).toBe(42);
    // An agent may write a block at the limit; a block added from the page then ties with it.
    m.upsertBlock("top", b({ z: BOARD_LIMITS.maxZ }), 2);
    expect(m.nextZ()).toBe(BOARD_LIMITS.maxZ);
  });
});
