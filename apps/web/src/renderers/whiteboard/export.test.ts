// Export: the SVG holds the board's text as text (escaped by the serializer), no script, no
// foreignObject, no link and no external reference; its viewBox frames every block; the PNG stays
// within its caps; text wraps inside its block.
import { describe, expect, it } from "vitest";
import {
  boardSvg,
  estimateMeasure,
  exportBounds,
  exportName,
  LIGHT_THEME,
  PNG_MAX_PIXELS,
  pngScale,
  svgBlob,
  wrapText,
} from "./export.ts";
import { BoardModel } from "./model.ts";

function model(): BoardModel {
  const m = new BoardModel();
  m.upsertBlock(
    "a",
    {
      kind: "note",
      x: 0,
      y: 0,
      w: 200,
      h: 140,
      text: '</text><script>alert(1)</script> & "q"',
      color: "pink",
    },
    1,
  );
  m.upsertBlock("b", { kind: "ellipse", x: 400, y: 100, w: 120, h: 80, text: "Two" }, 1);
  m.upsertBlock("c", { kind: "text", x: -100, y: 300, w: 100, h: 40, text: "" }, 1);
  m.upsertArrow(
    "x",
    { from: "a", to: "b", label: "<b>next</b>", head: "both", style: "dashed" },
    1,
  );
  m.upsertArrow("gone", { from: "a", to: "missing" }, 1);
  return m;
}

describe("boardSvg", () => {
  it("frames every block with a margin", () => {
    const svg = boardSvg(document, model(), LIGHT_THEME);
    expect(exportBounds(model())).toEqual({ x: -140, y: -40, w: 700, h: 420 });
    expect(svg.getAttribute("viewBox")).toBe("-140 -40 700 420");
    expect(svg.getAttribute("width")).toBe("700");
  });

  it("writes text as text: escaped in the file, with no script, foreignObject or link", async () => {
    const svg = boardSvg(document, model(), LIGHT_THEME);
    const xml = await svgBlob(svg).text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("&lt;script");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;b&gt;next&lt;/b&gt;");
    expect(xml).not.toMatch(/<script|foreignObject|href|<image|url\((?!#head\))/i);
    // It parses back as SVG with the same text.
    const back = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(back.querySelector("parsererror")).toBeNull();
    expect(back.documentElement.textContent).toContain("<script>alert(1)</script>");
    // One drawn arrow (the other names a missing block), dashed, with both heads.
    const lines = svg.querySelectorAll("line");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.getAttribute("marker-start")).toBe("url(#head)");
    expect(lines[0]?.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(svg.querySelectorAll("ellipse")).toHaveLength(1);
  });
});

describe("text and the PNG", () => {
  it("wraps at spaces, cuts a long word and ends cut text with an ellipsis", () => {
    const m = (s: string) => s.length * 10;
    expect(wrapText("one two three", 75, 5, m)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 40, 5, m)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\nb", 100, 5, m)).toEqual(["a", "b"]);
    expect(wrapText("one two three four", 40, 2, m)).toEqual(["one", "two…"]);
    expect(estimateMeasure("abc")).toBeGreaterThan(0);
  });

  it("draws at 2x, smaller to stay within 8192 px a side and 32 Mpx", () => {
    expect(pngScale(1000, 800)).toBe(2);
    expect(pngScale(8000, 100)).toBeCloseTo(8192 / 8000);
    const s = pngScale(5000, 5000);
    expect(5000 * s * 5000 * s).toBeLessThanOrEqual(PNG_MAX_PIXELS + 1);
    expect(5000 * s).toBeLessThanOrEqual(8192);
  });

  it("names the file from the title", () => {
    expect(exportName("Q3 planning: board!", "png")).toBe("q3-planning-board.png");
    expect(exportName("***", "svg")).toBe("whiteboard.svg");
  });
});
