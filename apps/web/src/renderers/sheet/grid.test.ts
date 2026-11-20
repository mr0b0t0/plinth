// The grid's frozen columns under on-page editing: a cell repainted with a new value (a live draft
// shown in place) keeps the frame's current freeze state, so a phone that scrolls frozen columns
// with the rest never gets a stale left offset back.
import { evaluateSheet, parseSheet, type Sheet } from "@plinth/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGrid } from "./grid.ts";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 200 },
    { name: "Qty", type: "number" },
  ],
  freeze: { cols: 1 },
});

function sheetOf(lines: string[]): Sheet {
  const p = parseSheet([HEADER, ...lines].join("\n"));
  if (!p.ok) throw new Error("bad sheet");
  return p.sheet;
}

function narrowFrame(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const cell = (a: string) => document.getElementById(`__plinth-cell-${a}`) as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("frozen columns while the grid repaints", () => {
  it("a repainted frozen cell stays unfrozen in a narrow frame", () => {
    narrowFrame(true);
    const before = sheetOf(['["Apples",3]']);
    const grid = buildGrid(document, before, evaluateSheet(before, { budget: 100_000 }), {
      title: "Budget",
      exhausted: false,
    });
    document.body.append(grid.el);
    expect(grid.el.classList).toContain("plinth-sheet--unfrozen");
    expect(cell("A2").style.left).toBe("");
    const after = sheetOf(['["Pears",3]']);
    expect(grid.update(after, evaluateSheet(after, { budget: 100_000 }))).toBe(true);
    expect(cell("A2").textContent).toBe("Pears");
    expect(cell("A2").classList).toContain("plinth-sheet__frozen");
    expect(cell("A2").style.left).toBe("");
  });

  it("and keeps its left offset in a wide one", () => {
    narrowFrame(false);
    const before = sheetOf(['["Apples",3]']);
    const grid = buildGrid(document, before, evaluateSheet(before, { budget: 100_000 }), {
      title: "Budget",
      exhausted: false,
    });
    document.body.append(grid.el);
    const after = sheetOf(['["Pears",3]']);
    expect(grid.update(after, evaluateSheet(after, { budget: 100_000 }))).toBe(true);
    expect(cell("A2").style.left).toBe("48px");
  });
});
