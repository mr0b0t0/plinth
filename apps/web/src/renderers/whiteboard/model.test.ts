// The board model: documents in, clamped and well formed; an older copy never replaces a newer
// one; a snapshot replaces what was saved; draw order is z, then id.
import { describe, expect, it } from "vitest";
import {
  fitCamera,
  loadCamera,
  panBy,
  saveCamera,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "./camera.ts";
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
});

describe("camera", () => {
  it("maps screen and board points both ways", () => {
    const c = { x: 100, y: 50, zoom: 2 };
    expect(screenToWorld(c, 20, 10)).toEqual({ x: 110, y: 55 });
    expect(worldToScreen(c, 110, 55)).toEqual({ x: 20, y: 10 });
  });

  it("zooms about a point, within 0.1 and 4", () => {
    const c = zoomAt({ x: 0, y: 0, zoom: 1 }, 200, 100, 2);
    expect(c.zoom).toBe(2);
    expect(screenToWorld(c, 200, 100)).toEqual({ x: 200, y: 100 });
    expect(zoomAt(c, 0, 0, 100).zoom).toBe(4);
    expect(zoomAt(c, 0, 0, 0.0001).zoom).toBe(0.1);
    expect(panBy({ x: 0, y: 0, zoom: 2 }, 10, -20)).toEqual({ x: -5, y: 10, zoom: 2 });
  });

  it("fits the board in the viewport, never above 100%", () => {
    expect(fitCamera({ x: 0, y: 0, w: 100, h: 100 }, 800, 600).zoom).toBe(1);
    const big = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, 848, 600);
    expect(big.zoom).toBeCloseTo(0.188, 3);
    expect(fitCamera(null, 800, 600)).toEqual({ x: -48, y: -48, zoom: 1 });
  });

  it("keeps the camera per viewer, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const win = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    } as unknown as Window;
    saveCamera(win, { x: 1, y: 2, zoom: 3 });
    expect(loadCamera(win)).toEqual({ x: 1, y: 2, zoom: 3 });
    store.set("plinth-whiteboard-camera", '{"x":"1","y":0,"zoom":1}');
    expect(loadCamera(win)).toBeNull();
    const broken = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadCamera(broken)).toBeNull();
    expect(() => saveCamera(broken, { x: 0, y: 0, zoom: 1 })).not.toThrow();
  });
});
