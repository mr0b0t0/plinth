// Canvas geometry: rows by section, fitting, zooming at a point, the zoom clamp, zooming to one
// board, which boards are on screen, and where a board's files and the board loader come from.
import { DESIGN_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { boardBaseUrl, boardLoaderUrl, contentBase } from "./base.ts";
import {
  clampZoom,
  fitTransform,
  LAYOUT,
  layoutBoards,
  layoutUnit,
  screenRect,
  visibleBoards,
  zoomAt,
  zoomToBoard,
} from "./layout.ts";

const b = (id: string, width: number, height: number, section: string | null = null) => ({
  id,
  width,
  height,
  section,
});

describe("layoutBoards", () => {
  it("puts consecutive boards of one section in a row", () => {
    const l = layoutBoards([
      b("a", 393, 852, "Mobile"),
      b("b", 393, 852, "Mobile"),
      b("c", 1080, 1080, "Social"),
      b("d", 300, 250),
    ]);
    expect(l.rows.map((r) => r.section)).toEqual(["Mobile", "Social", null]);
    // The tallest board is 1080 px, so every gap is 1.8 times its base size.
    const u = l.unit;
    expect(u).toBeCloseTo(1.8);
    const [a, bb, c, d] = l.items;
    expect(a).toMatchObject({ x: 0, y: LAYOUT.label * u, row: 0 });
    expect(bb).toMatchObject({ x: 393 + LAYOUT.gap * u, y: a?.y, row: 0 });
    const row1 = (a?.y ?? 0) + 852 + LAYOUT.rowGap * u;
    expect(c?.y).toBeCloseTo(row1 + LAYOUT.label * u);
    expect(c).toMatchObject({ x: 0, row: 1 });
    expect(d?.y).toBeCloseTo((c?.y ?? 0) + 1080 + (LAYOUT.rowGap + LAYOUT.label) * u);
    expect(d).toMatchObject({ x: 0, row: 2 });
    expect(l.bounds.w).toBe(1080);
    expect(l.bounds.h).toBeCloseTo((d?.y ?? 0) + 250);
  });

  it("keeps the base gaps for small boards and caps the multiplier", () => {
    expect(layoutBoards([b("a", 300, 250)]).unit).toBe(1);
    expect(layoutUnit(4096)).toBeLessThanOrEqual(LAYOUT.maxUnit);
    expect(layoutUnit(1200)).toBe(2);
  });

  it("wraps a row that would grow too wide", () => {
    const boards = Array.from({ length: 6 }, (_, i) => b(`s${i}`, 1920, 1080, "Slides"));
    const l = layoutBoards(boards);
    expect(l.rows.length).toBeGreaterThan(1);
    expect(new Set(l.rows.map((r) => r.section))).toEqual(new Set(["Slides"]));
    for (const it of l.items) expect(it.x + it.w).toBeLessThanOrEqual(LAYOUT.rowMaxWidth);
  });
});

describe("transforms", () => {
  it("fits a rect centred, never above 100%", () => {
    const t = fitTransform({ x: 0, y: 0, w: 2000, h: 1000 }, { width: 1048, height: 600 }, 24);
    expect(t.scale).toBeCloseTo(0.5);
    expect(t.x).toBeCloseTo((1048 - 1000) / 2);
    expect(t.y).toBeCloseTo((600 - 500) / 2);
    expect(fitTransform({ x: 0, y: 0, w: 100, h: 100 }, { width: 800, height: 600 }).scale).toBe(1);
  });

  it("zooms at a point, keeping that point still", () => {
    const t = { x: 100, y: 50, scale: 1 };
    const p = { x: 300, y: 200 };
    const z = zoomAt(t, 2, p);
    expect(z.scale).toBe(2);
    // The world point under p stays under p.
    expect((p.x - t.x) / t.scale).toBeCloseTo((p.x - z.x) / z.scale);
    expect((p.y - t.y) / t.scale).toBeCloseTo((p.y - z.y) / z.scale);
  });

  it("clamps zoom at 5% and 400%", () => {
    expect(clampZoom(0.001)).toBe(DESIGN_LIMITS.minZoom);
    expect(clampZoom(99)).toBe(DESIGN_LIMITS.maxZoom);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomAt({ x: 0, y: 0, scale: 3 }, 10, { x: 0, y: 0 }).scale).toBe(4);
    expect(fitTransform({ x: 0, y: 0, w: 1e7, h: 10 }, { width: 400, height: 400 }).scale).toBe(
      0.05,
    );
  });

  it("zooms to one board with its label in view", () => {
    const item = { x: 1000, y: 500, w: 300, h: 250 };
    const t = zoomToBoard(item, { width: 800, height: 600 });
    expect(t.scale).toBe(1);
    const r = screenRect(item, t);
    expect(r.x).toBeCloseTo((800 - 300) / 2);
    expect(r.y - LAYOUT.label * t.scale).toBeCloseTo((600 - 250 - LAYOUT.label) / 2);
  });

  it("lists the boards on screen, nearest the centre first", () => {
    const items = layoutBoards([b("a", 100, 100), b("b", 100, 100), b("c", 100, 100)]).items;
    const view = { width: 300, height: 300 };
    // Board b centred.
    const t = { x: 150 - 164 - 50, y: 100, scale: 1 };
    expect(visibleBoards(items, t, view, 0)[0]).toBe("b");
    expect(visibleBoards(items, { x: 5000, y: 0, scale: 1 }, view, 0)).toEqual([]);
  });
});

describe("where boards come from", () => {
  it("resolves a board's files against the shell's own directory", () => {
    expect(boardBaseUrl({ href: "https://abc.c.example/" })).toBe("https://abc.c.example/");
    expect(boardBaseUrl({ href: "https://abc.c.example/?plinth-review=1#x" })).toBe(
      "https://abc.c.example/",
    );
    expect(boardBaseUrl({ href: "https://abc.c.example/__plinth/v/3/" })).toBe(
      "https://abc.c.example/__plinth/v/3/",
    );
    const id = "abcdefghij0123456789";
    expect(boardBaseUrl({ href: `https://app.example/__content/${id}/__plinth/v/2/` })).toBe(
      `https://app.example/__content/${id}/__plinth/v/2/`,
    );
    // The editor preview loader, if it could not move its URL to the root.
    expect(boardBaseUrl({ href: "https://abc.c.example/__plinth/preview#plinth-preview=ab" })).toBe(
      "https://abc.c.example/",
    );
    expect(boardBaseUrl({ href: `https://app.example/__content/${id}/__plinth/preview` })).toBe(
      `https://app.example/__content/${id}/`,
    );
  });

  it("opens the fixed board loader on the artifact's origin", () => {
    const id = "abcdefghij0123456789";
    expect(boardLoaderUrl({ href: "https://abc.c.example/__plinth/v/3/" })).toBe(
      "https://abc.c.example/__plinth/frames/design/board.html",
    );
    expect(boardLoaderUrl({ href: `https://app.example/__content/${id}/` })).toBe(
      `https://app.example/__content/${id}/__plinth/frames/design/board.html`,
    );
    expect(contentBase("/__content/short/")).toBe("");
  });
});
