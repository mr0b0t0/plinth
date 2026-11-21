// Canvas geometry: rows packed for the screen, fitting with room for the toolbar, zooming at a point, the zoom clamp, zooming to one
// board, which boards are on screen, and where a board's files and the board loader come from.
import { DESIGN_LIMITS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { boardBaseUrl, boardLoaderUrl, contentBase, isVersionNumber } from "./base.ts";
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

/** The scale at which a layout fits an area of `aspect` (width / height) and height 1. */
const fitScale = (l: { bounds: { w: number; h: number } }, aspect: number) =>
  Math.min(aspect / l.bounds.w, 1 / l.bounds.h);

/** A launch kit: two phone screens, a desktop page, a square post and a leaderboard ad. */
const KIT = [
  b("home", 393, 852, "App"),
  b("checkout", 393, 852, "App"),
  b("landing", 1440, 900, "Web"),
  b("post", 1080, 1080, "Social"),
  b("banner", 728, 90, "Ads"),
];

describe("layoutBoards", () => {
  it("lets consecutive sections share a row, a section's boards side by side", () => {
    const l = layoutBoards(KIT, 1184 / 698);
    const [home, checkout, landing, post, banner] = l.items;
    // The tallest board is 1080 px, so every gap is 1.8 times its base size.
    const u = l.unit;
    expect(u).toBeCloseTo(1.8);
    expect(home).toMatchObject({ x: 0, y: LAYOUT.label * u, row: 0 });
    expect(checkout).toMatchObject({ x: 393 + LAYOUT.gap * u, y: home?.y, row: 0 });
    // The next section follows on the same row, after the wider gap between sections.
    expect(landing).toMatchObject({ row: 0, y: home?.y });
    expect(landing?.x).toBeCloseTo(2 * 393 + (LAYOUT.gap + LAYOUT.sectionGap) * u);
    expect(l.rows.length).toBe(2);
    // A row starts at the left, under the tallest board of the row above and its gap.
    expect(post).toMatchObject({ x: 0, row: 1 });
    expect(post?.y).toBeCloseTo((l.rows[1]?.y ?? 0) + LAYOUT.label * u);
    expect(l.rows[1]?.y).toBeCloseTo(LAYOUT.label * u + 900 + LAYOUT.rowGap * u);
    expect(banner).toMatchObject({ row: 1, y: post?.y });
    expect(l.bounds.h).toBeCloseTo((post?.y ?? 0) + 1080);
  });

  it("fits a wide screen far better than one row per section", () => {
    const aspect = 1184 / 698;
    const l = layoutBoards(KIT, aspect);
    // One row per section: the boards in a narrow column.
    const column = { bounds: { w: 1440, h: 852 + 900 + 1080 + 90 + 4 * 28 * 1.8 + 3 * 96 * 1.8 } };
    expect(fitScale(l, aspect)).toBeGreaterThan(1.5 * fitScale(column, aspect));
    // The layout uses the width: its own aspect is close to the screen's.
    expect(l.bounds.w / l.bounds.h).toBeGreaterThan(aspect / 2);
  });

  it("stacks more rows for a tall screen than for a wide one", () => {
    const slides = Array.from({ length: 6 }, (_, i) => b(`s${i}`, 1920, 1080, "Slides"));
    const wide = layoutBoards(slides, 16 / 9);
    const tall = layoutBoards(slides, 9 / 16);
    expect(wide.rows.length).toBeGreaterThan(1);
    expect(tall.rows.length).toBeGreaterThan(wide.rows.length);
    // Each beats one row of every board and one board per row on its own screen.
    for (const [l, aspect] of [
      [wide, 16 / 9],
      [tall, 9 / 16],
    ] as const) {
      expect(fitScale(l, aspect)).toBeGreaterThanOrEqual(
        fitScale(layoutBoards(slides, 1e3), aspect),
      );
      expect(fitScale(l, aspect)).toBeGreaterThanOrEqual(
        fitScale(layoutBoards(slides, 1e-3), aspect),
      );
    }
  });

  it("moves a section that does not fit to the next row whole, and wraps one wider than a row", () => {
    const l = layoutBoards(
      [
        b("a", 1000, 500, "One"),
        b("p", 400, 500, "Two"),
        b("q", 400, 500, "Two"),
        b("r", 400, 500, "Two"),
      ],
      1,
    );
    const rowOf = (id: string) => l.items.find((it) => it.id === id)?.row;
    expect(new Set(["p", "q", "r"].map(rowOf)).size).toBeLessThanOrEqual(2);
    // Boards of a section that starts a row stay in order, left to right then down.
    const two = l.items.filter((it) => it.id !== "a");
    for (let i = 1; i < two.length; i++) {
      const [prev, cur] = [two[i - 1], two[i]];
      if (prev && cur && prev.row === cur.row) expect(cur.x).toBeGreaterThan(prev.x);
    }
    expect(rowOf("p")).toBeGreaterThan(rowOf("a") ?? 0);
  });

  it("falls back to a 16:10 screen for an unknown size", () => {
    expect(layoutBoards(KIT, Number.NaN)).toEqual(layoutBoards(KIT, LAYOUT.aspect));
    expect(layoutBoards(KIT, -1)).toEqual(layoutBoards(KIT));
  });

  it("keeps the base gaps for small boards and caps the multiplier", () => {
    expect(layoutBoards([b("a", 300, 250)]).unit).toBe(1);
    expect(layoutUnit(4096)).toBeLessThanOrEqual(LAYOUT.maxUnit);
    expect(layoutUnit(1200)).toBe(2);
  });
});

describe("placement and notes", () => {
  const at = (id: string, width: number, height: number, x: number, y: number) => ({
    ...b(id, width, height),
    x,
    y,
  });
  const note = (
    key: string,
    kind: "title" | "sticky",
    after: number,
    w = 300,
    h = 64,
    x: number | null = null,
    y: number | null = null,
  ) => ({ key, kind, w, h, x, y, after });

  it("lays out a design without notes or places exactly as before", () => {
    const plain = layoutBoards(KIT, 1.6);
    const withNulls = layoutBoards(
      KIT.map((k) => ({ ...k, x: null, y: null })),
      1.6,
      [],
    );
    expect(withNulls).toEqual(plain);
    expect(plain.notes).toEqual([]);
  });

  it("puts placed boards exactly where they say, their label band in the bounds", () => {
    const l = layoutBoards([at("a", 400, 300, 100, 50), at("b", 200, 200, 600, 50)]);
    expect(l.items.map((i) => [i.id, i.x, i.y])).toEqual([
      ["a", 100, 50],
      ["b", 600, 50],
    ]);
    expect(l.bounds).toEqual({ x: 100, y: 50 - LAYOUT.label, w: 700, h: 300 + LAYOUT.label });
  });

  it("packs the rest under the placed boards and notes", () => {
    const l = layoutBoards([at("a", 400, 300, 0, 0), b("c", 300, 300)], 1.6, [
      note("n1", "sticky", 0, 240, 200, 500, 0),
    ]);
    const c = l.items.find((i) => i.id === "c");
    expect(c?.x).toBe(0);
    expect(c?.y).toBe(300 + LAYOUT.rowGap + LAYOUT.label);
    expect(l.notes).toEqual([{ key: "n1", x: 500, y: 0, w: 240, h: 200 }]);
    expect(l.bounds.w).toBe(740);
  });

  it("starts a row at a title note, with the boards after it under the title", () => {
    const l = layoutBoards([b("a", 400, 300), b("b", 400, 300), b("c", 400, 300)], 100, [
      note("t", "title", 2, 500, 64),
    ]);
    const [a, bb, c] = l.items;
    expect(a?.row).toBe(0);
    expect(bb?.row).toBe(0);
    expect(c?.row).toBe(1);
    const t = l.notes[0];
    expect(t?.x).toBe(0);
    expect(t?.y).toBe(LAYOUT.label + 300 + LAYOUT.rowGap);
    expect(c?.y).toBe((t?.y ?? 0) + 64 + LAYOUT.titleGap + LAYOUT.label);
  });

  it("gives a sticky a place in its row, inside its section", () => {
    const l = layoutBoards([b("a", 400, 300, "S"), b("b", 400, 300, "S")], 100, [
      note("s", "sticky", 1, 240, 120),
    ]);
    const [a, bb] = l.items;
    const s = l.notes[0];
    expect(s?.x).toBe((a?.x ?? 0) + 400 + LAYOUT.gap);
    expect(s?.y).toBe(a?.y);
    expect(bb?.x).toBe((s?.x ?? 0) + 240 + LAYOUT.gap);
  });

  it("zooms to a tall fluid board at its width, from its top", () => {
    const item = { x: 0, y: 28, w: 1000, h: 6000 };
    const whole = zoomToBoard(item, { width: 1000, height: 800 }, 0, 28);
    const top = zoomToBoard(item, { width: 1000, height: 800 }, 0, 28, true);
    expect(top.scale).toBe(1);
    expect(top.scale).toBeGreaterThan(whole.scale);
    // The board's top sits one label band under the room's top, whatever the zoom.
    expect(top.y + 28 * top.scale).toBe(LAYOUT.label);
    // A board that fits whole is shown whole either way.
    const small = { x: 0, y: 28, w: 400, h: 300 };
    expect(zoomToBoard(small, { width: 1000, height: 800 }, 0, 28, true)).toEqual(
      zoomToBoard(small, { width: 1000, height: 800 }, 0, 28),
    );
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

  it("keeps the room each side asks for clear, so fitted boards end above the toolbar", () => {
    const room = { top: 48, right: 48, bottom: 48 + 66, left: 48 };
    const view = { width: 1000, height: 600 };
    const rect = { x: 0, y: 0, w: 1000, h: 500 };
    const t = fitTransform(rect, view, room);
    const r = screenRect(rect, t);
    expect(r.y).toBeGreaterThanOrEqual(room.top - 1e-9);
    expect(r.y + r.h).toBeCloseTo(view.height - room.bottom);
    expect(r.x).toBeCloseTo((view.width - r.w) / 2);
    // One board, zoomed to, keeps the same room.
    const z = screenRect(rect, zoomToBoard(rect, view, room, 0));
    expect(z.y + z.h).toBeLessThanOrEqual(view.height - room.bottom + 1e-9);
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
  it("resolves a board's files against the shown version's path, never the root", () => {
    // At the root the content host serves the current version: v1's boards stay on v1.
    expect(boardBaseUrl({ href: "https://abc.c.example/" }, 1)).toBe(
      "https://abc.c.example/__plinth/v/1/",
    );
    expect(boardBaseUrl({ href: "https://abc.c.example/?plinth-review=1#x" }, 4)).toBe(
      "https://abc.c.example/__plinth/v/4/",
    );
    expect(boardBaseUrl({ href: "https://abc.c.example/__plinth/v/3/" }, 3)).toBe(
      "https://abc.c.example/__plinth/v/3/",
    );
    // The payload's number wins over the path, which only the content host resolves.
    expect(boardBaseUrl({ href: "https://abc.c.example/__plinth/v/3/" }, 2)).toBe(
      "https://abc.c.example/__plinth/v/2/",
    );
    const id = "abcdefghij0123456789";
    expect(boardBaseUrl({ href: `https://app.example/__content/${id}/` }, 2)).toBe(
      `https://app.example/__content/${id}/__plinth/v/2/`,
    );
    expect(boardBaseUrl({ href: `https://app.example/__content/${id}/__plinth/v/2/` }, 2)).toBe(
      `https://app.example/__content/${id}/__plinth/v/2/`,
    );
    expect(boardBaseUrl({ href: "https://abc.c.example/" }, 999_999_999)).toBe(
      "https://abc.c.example/__plinth/v/999999999/",
    );
  });

  it("gives no base without a valid version number, so no board falls back to the root", () => {
    const loc = { href: "https://abc.c.example/" };
    for (const v of [undefined, null, 0, -1, 1.5, Number.NaN, Infinity, 1_000_000_000, "1", [1]]) {
      expect(boardBaseUrl(loc, v), String(v)).toBeNull();
      expect(isVersionNumber(v), String(v)).toBe(false);
    }
    expect(isVersionNumber(1)).toBe(true);
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
