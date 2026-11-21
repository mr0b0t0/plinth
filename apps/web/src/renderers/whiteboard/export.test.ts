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
    expect(xml).not.toMatch(/<script|foreignObject|href|<image|url\(/i);
    // It parses back as SVG with the same text.
    const back = new DOMParser().parseFromString(xml, "image/svg+xml");
    expect(back.querySelector("parsererror")).toBeNull();
    expect(back.documentElement.textContent).toContain("<script>alert(1)</script>");
    // One drawn arrow (the other names a missing block), dashed, with a head at each end.
    const dashed = svg.querySelectorAll('path[stroke-dasharray="6 4"]');
    expect(dashed).toHaveLength(1);
    const heads = [...svg.querySelectorAll("path")].filter(
      (p) => p.getAttribute("fill") === LIGHT_THEME.arrow,
    );
    expect(heads).toHaveLength(2);
  });

  it("draws the new kinds: a section behind, shapes, a table, marks as styled text, no link", async () => {
    const m = new BoardModel();
    m.upsertBlock(
      "s",
      { kind: "container", x: -40, y: -60, w: 600, h: 400, text: "Now", color: "blue" },
      1,
    );
    m.upsertBlock(
      "d",
      {
        kind: "diamond",
        x: 0,
        y: 0,
        w: 200,
        h: 120,
        text: "**Ship** [it](https://example.com/x)",
        color: "#123456",
        stroke: "pink",
      },
      1,
    );
    m.upsertBlock(
      "t",
      {
        kind: "table",
        x: 240,
        y: 0,
        w: 240,
        h: 72,
        text: "",
        cols: { c1: { at: 1 }, c2: { at: 2 } },
        rows: { r1: { at: 1, c1: "Plan", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$20" } },
        fills: { r2: { c2: "green" } },
      },
      1,
    );
    m.upsertArrow(
      "a",
      { from: "d", to: "t", fromSide: "right", toSide: "left", heads: ["circle", "arrow"] },
      1,
    );
    const svg = boardSvg(document, m, LIGHT_THEME);
    const xml = await svgBlob(svg).text();
    expect(xml).not.toMatch(/href|<a[\s>]|<image|foreignObject/i);
    // The section's tint is the first thing drawn after the background, its title above it.
    const paths = [...svg.querySelectorAll("path")];
    expect(paths[0]?.getAttribute("fill")).toBe(LIGHT_THEME.fills.blue);
    expect(paths[0]?.getAttribute("fill-opacity")).toBe("0.45");
    const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts[0]).toBe("Now");
    // The diamond: its outline in pink's ink, white words on a dark custom fill, bold and a link.
    const diamond = paths.find((p) => p.getAttribute("fill") === "#123456");
    expect(diamond?.getAttribute("stroke")).toBe(LIGHT_THEME.inks.pink);
    const words = [...svg.querySelectorAll("text")].find((t) => t.textContent?.includes("Ship"));
    expect(words?.getAttribute("fill")).toBe("#ffffff");
    expect(words?.querySelector('tspan[font-weight="700"]')?.textContent).toBe("Ship");
    expect(words?.querySelector('tspan[text-decoration="underline"]')?.textContent).toBe("it");
    // The table's cells as text, its filled cell in green, the header bold.
    expect(texts).toEqual(expect.arrayContaining(["Plan", "Price", "Pro", "$20"]));
    expect(paths.some((p) => p.getAttribute("fill") === LIGHT_THEME.fills.green)).toBe(true);
    const plan = [...svg.querySelectorAll("text")].find((t) => t.textContent === "Plan");
    expect(plan?.getAttribute("font-weight")).toBe("700");
    // The arrow runs in right angles, with a dot at its start and a head at its end.
    const route = paths.find((p) => p.getAttribute("stroke") === LIGHT_THEME.arrow);
    expect(route?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/);
    const heads = paths.filter((p) => p.getAttribute("fill") === LIGHT_THEME.arrow);
    expect(heads.map((h) => h.getAttribute("d")?.includes("A"))).toEqual([true, false]);
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
