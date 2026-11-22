// The widened whiteboard elements (whiteboard.ts, whiteboardDraw.ts): Claude's shape kinds,
// sections, tables, text size and alignment, any #rrggbb, outlines, arrow sides, routes and heads,
// and inline marks parsed as text. Boards written before all this read exactly as they did.
import { describe, expect, it } from "vitest";
import {
  arrowEndpoints,
  arrowHeads,
  arrowRoute,
  BOARD_LIMITS,
  boardDocError,
  cellNumber,
  cleanArrow,
  cleanBlock,
  hasMarks,
  heatOf,
  isDarkHex,
  legacyBoardLoss,
  parseBoardContent,
  parseMarks,
  routeHeads,
  routeLabelAt,
  SHAPE_KINDS,
  safeHref,
  shapePath,
  tableLayout,
  textInset,
  trimRoute,
} from "../src/index.ts";

const block = (over: Record<string, unknown> = {}) => ({
  kind: "rect",
  x: 0,
  y: 0,
  w: 200,
  h: 100,
  text: "One idea",
  ...over,
});

const table = (over: Record<string, unknown> = {}) => ({
  kind: "table",
  x: 0,
  y: 0,
  w: 280,
  h: 72,
  cols: { c1: { at: 1, w: 160 }, c2: { at: 2, w: 120 } },
  rows: { r1: { at: 1, c1: "Plan", c2: "Price" }, r2: { at: 2, c1: "Pro", c2: "$20" } },
  ...over,
});

describe("blocks", () => {
  it.each<[string, unknown]>([
    ...SHAPE_KINDS.map((kind) => [kind, block({ kind })] as [string, unknown]),
    ["a section", block({ kind: "container", text: "Now", color: "blue", stroke: "ink" })],
    [
      "a styled shape",
      block({
        kind: "cloud",
        color: "#1A2b3c",
        stroke: "#ffffff",
        hollow: true,
        size: "large",
        textAlign: "left",
        wrap: false,
      }),
    ],
    ["sized text", block({ kind: "text", size: "title", textAlign: "right", color: "purple" })],
    ["a table", table()],
    [
      "a table with fills and heat",
      table({
        size: "small",
        fills: { r2: { c2: "green", c1: "" } },
        heat: { cols: { c2: "#336699" } },
      }),
    ],
    ["text of 4,000 characters", block({ text: "x".repeat(4000) })],
  ])("accepts %s", (_name, data) => {
    expect(boardDocError("blocks", data)).toBeNull();
  });

  it.each<[string, unknown, RegExp]>([
    ["an unknown kind", block({ kind: "star" }), /kind must be one of/],
    ["a colour that is not #rrggbb", block({ color: "#fff" }), /color must be/],
    ["a css colour", block({ color: "red" }), /color must be/],
    ["an unknown stroke", block({ stroke: "url(x)" }), /stroke must be/],
    ["hollow that is not a boolean", block({ hollow: "yes" }), /hollow must be/],
    ["an unknown size", block({ size: "giant" }), /size must be/],
    ["an unknown alignment", block({ textAlign: "justify" }), /textAlign must be/],
    ["a stroke on text", block({ kind: "text", stroke: "ink" }), /stroke must be unknown key/],
    ["table fields on a shape", block({ cols: {} }), /cols must be unknown key/],
    ["a stroke on a table", table({ stroke: "ink" }), /stroke must be unknown key/],
    ["a table with no columns", table({ cols: {} }), /cols must be 1 to 40/],
    ["a table with no rows", table({ rows: {} }), /rows must be 1 to 500/],
    ["a column id 'at'", table({ cols: { at: { at: 1 } } }), /cols\.at must be ids/],
    ["a column with no place", table({ cols: { c1: { w: 10 } } }), /cols\.c1\.at/],
    ["a column too narrow", table({ cols: { c1: { at: 1, w: 9 } } }), /cols\.c1\.w/],
    ["a cell in no column", table({ rows: { r1: { at: 1, c9: "x" } } }), /rows\.r1\.c9/],
    ["a cell that is a number", table({ rows: { r1: { at: 1, c1: 5 } } }), /rows\.r1\.c1/],
    [
      "a cell over 1,000 characters",
      table({ rows: { r1: { at: 1, c1: "x".repeat(1001) } } }),
      /rows\.r1\.c1 must be at most 1000/,
    ],
    ["a fill on no row", table({ fills: { r9: { c1: "green" } } }), /fills\.r9/],
    ["a fill that is no colour", table({ fills: { r1: { c1: "red" } } }), /fills\.r1\.c1/],
    ["heat on both", table({ heat: { cols: {}, rows: {} } }), /heat must be one of cols or rows/],
    ["heat on no column", table({ heat: { cols: { c9: "blue" } } }), /heat\.cols\.c9/],
  ])("refuses %s", (_name, data, why) => {
    expect(boardDocError("blocks", data)).toMatch(why);
  });

  it("lets a table leave out text, and no other block", () => {
    const { text: _t, ...noText } = block();
    expect(boardDocError("blocks", table())).toBeNull();
    expect(boardDocError("blocks", noText)).toMatch(/text must be/);
  });

  it("takes the new kinds in a starting board", () => {
    const { seed } = parseBoardContent(
      JSON.stringify({
        v: 1,
        blocks: [
          { id: "s", ...block({ kind: "container", w: 600, h: 400 }) },
          { id: "t", ...table() },
          { id: "d", ...block({ kind: "diamond", x: 300 }) },
        ],
        arrows: [{ id: "a", from: "t", to: "d", fromSide: "right", toSide: "left" }],
      }),
    );
    expect(seed.map((s) => s.id)).toEqual(["s", "t", "d", "a"]);
  });

  it("keeps every valid field through the lenient reader, so a page's save writes them back", () => {
    const styled = block({
      kind: "hexagon",
      color: "#abcdef",
      stroke: "green",
      hollow: true,
      size: "huge",
      textAlign: "right",
      wrap: false,
      z: 3,
    });
    expect(cleanBlock(styled)).toEqual(styled);
    const t = table({ fills: { r2: { c2: "green" } }, heat: { rows: { r2: "blue" } } });
    expect(cleanBlock(t)).toEqual({ ...t, text: "" });
    // Unknown values are dropped, not guessed.
    expect(cleanBlock(block({ color: "red", size: "giant", hollow: 1 }))).toEqual(block());
  });
});

describe("arrows", () => {
  it.each<[Record<string, unknown>]>([
    [{ from: "a", to: "b", heads: ["circle", "arrow"] }],
    [{ from: "a", to: "b", fromSide: "bottom", toSide: "top", color: "#ff0000" }],
    [{ from: "a", to: "b", bends: ["v", 65, -160, -75] }],
    [{ from: "a", to: "b", bends: ["h"] }],
  ])("accepts %j", (data) => {
    expect(boardDocError("arrows", data)).toBeNull();
    expect(cleanArrow(data)).toEqual(data);
  });

  it.each<[Record<string, unknown>, RegExp]>([
    [{ from: "a", to: "b", heads: ["arrow"] }, /heads must be/],
    [{ from: "a", to: "b", heads: ["arrow", "star"] }, /heads must be/],
    [{ from: "a", to: "b", fromSide: "middle" }, /fromSide must be/],
    [{ from: "a", to: "b", bends: [65] }, /bends must be/],
    [{ from: "a", to: "b", bends: ["v", 1.5] }, /bends\[1\] must be/],
    [{ from: "a", to: "b", bends: ["v", ...Array(13).fill(1)] }, /at most 12/],
    [{ from: "a", to: "b", color: "teal" }, /color must be/],
    [{ from: "a", to: "b", dash: true }, /dash must be unknown key/],
  ])("refuses %j", (data, why) => {
    expect(boardDocError("arrows", data)).toMatch(why);
  });

  it("resolves heads: heads wins, head says end, both or none", () => {
    expect(arrowHeads({})).toEqual(["none", "arrow"]);
    expect(arrowHeads({ head: "both" })).toEqual(["arrow", "arrow"]);
    expect(arrowHeads({ head: "none" })).toEqual(["none", "none"]);
    expect(arrowHeads({ head: "none", heads: ["circle", "none"] })).toEqual(["circle", "none"]);
  });
});

describe("drawing", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 300, y: 200, w: 100, h: 100 };

  it("draws every shape as path data of plain numbers inside its box", () => {
    for (const kind of SHAPE_KINDS) {
      const p = shapePath(kind, 200, 120);
      expect(p, kind).toMatch(/^M[0-9MLHVACQTZ .-]+$/);
      const nums = (p.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      expect(
        nums.every((n) => Number.isFinite(n) && n >= -0.01 && n <= 200.01),
        kind,
      ).toBe(true);
    }
    expect(textInset("rect", 200, 100)).toEqual([0, 0, 0, 0]);
    expect(textInset("diamond", 200, 100)).toEqual([25, 50, 25, 50]);
  });

  it("draws an arrow without sides or bends as the straight line it always was", () => {
    const p = arrowEndpoints(a, b);
    expect(arrowRoute(a, b, {})).toEqual([
      { x: p.x1, y: p.y1 },
      { x: p.x2, y: p.y2 },
    ]);
  });

  it("runs an arrow with sides in right angles from the middle of each side", () => {
    const r = arrowRoute(a, b, { fromSide: "right", toSide: "left" }, 0);
    expect(r[0]).toEqual({ x: 100, y: 50 });
    expect(r[r.length - 1]).toEqual({ x: 300, y: 250 });
    for (let i = 0; i + 1 < r.length; i++) {
      const p = r[i] as { x: number; y: number };
      const q = r[i + 1] as { x: number; y: number };
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
    // Facing sides in line: one straight leg.
    const c = { x: 300, y: 0, w: 100, h: 100 };
    expect(arrowRoute(a, c, { fromSide: "right", toSide: "left" }, 0)).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it("joins facing sides that are close with one straight leg, never a detour", () => {
    const below = { x: 0, y: 127, w: 100, h: 60 };
    expect(arrowRoute(a, below, { fromSide: "bottom", toSide: "top" })).toEqual([
      { x: 50, y: 104 },
      { x: 50, y: 123 },
    ]);
  });

  it("follows planned bends as Claude's whiteboard reads them", () => {
    const to = { x: 600, y: 0, w: 100, h: 100 };
    // Leave downward, level 65 below from's centre, upright 160 left of it, level 75 above to's
    // centre, then drop into to from above.
    expect(arrowRoute(a, to, { bends: ["v", 65, -160, -75] }, 0)).toEqual([
      { x: 50, y: 100 },
      { x: 50, y: 115 },
      { x: -110, y: 115 },
      { x: -110, y: -25 },
      { x: 650, y: -25 },
      { x: 650, y: 0 },
    ]);
    // A plan whose first corner falls inside its block gives way to a right-angle route.
    const fallback = arrowRoute(a, to, { bends: ["v", 10] }, 0);
    expect(fallback[0]).toEqual({ x: 100, y: 50 });
  });

  it("puts a route's label by its longest leg and its heads at its ends", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 200, y: 10 },
    ];
    expect(routeLabelAt(pts).x).toBe(100);
    const [h0, h1] = routeHeads(pts, ["circle", "arrow"]);
    expect(h0).toMatch(/^M-4.5 0A/);
    expect(h1).toMatch(/^M200 10L/);
    expect(routeHeads(pts, ["none", "none"])).toEqual(["", ""]);
    const trimmed = trimRoute(pts, ["none", "arrow"]);
    expect(trimmed[2]).toEqual({ x: 194, y: 10 });
    expect(trimmed[0]).toEqual({ x: 0, y: 0 });
  });

  it("lays a table out by column weight and equal rows, and shades numbers by value", () => {
    const t = cleanBlock({
      ...table({ heat: { cols: { c2: "blue" } } }),
      rows: {
        r1: { at: 1, c1: "Plan", c2: "Price" },
        r2: { at: 2, c1: "Pro", c2: "$20" },
        r3: { at: 3, c1: "Team", c2: "$1,040" },
        r0: { at: 4, c1: "Free", c2: "n/a" },
      },
      h: 120,
    });
    if (!t) throw new Error("no table");
    const l = tableLayout(t);
    expect(l.cols).toEqual([
      { id: "c1", x: 0, w: 160 },
      { id: "c2", x: 160, w: 120 },
    ]);
    expect(l.rows.map((r) => [r.id, r.y])).toEqual([
      ["r1", 0],
      ["r2", 30],
      ["r3", 60],
      ["r0", 90],
    ]);
    const heat = heatOf(t);
    expect(heat.get("r2\u0000c2")).toEqual({ paint: "blue", level: 0 });
    expect(heat.get("r3\u0000c2")).toEqual({ paint: "blue", level: 1 });
    expect(heat.has("r1\u0000c2")).toBe(false);
    expect(heat.has("r0\u0000c2")).toBe(false);
    expect(cellNumber("35%")).toBe(35);
    expect(cellNumber("1.2.3")).toBeNull();
    expect(isDarkHex("#1d1c1a")).toBe(true);
    expect(isDarkHex("#fcefa8")).toBe(false);
  });
});

describe("inline marks", () => {
  it("splits bold, italic, both, code and links, never nested, and leaves markup as text", () => {
    expect(
      parseMarks("A **bold** and *it* or ***both*** with `x<y>` and [docs](https://ex.com/a)"),
    ).toEqual([
      [
        { text: "A " },
        { text: "bold", bold: true },
        { text: " and " },
        { text: "it", italic: true },
        { text: " or " },
        { text: "both", bold: true, italic: true },
        { text: " with " },
        { text: "x<y>", code: true },
        { text: " and " },
        { text: "docs", href: "https://ex.com/a" },
      ],
    ]);
    expect(parseMarks("<b>hi</b> 2 * 3 * 4")).toEqual([[{ text: "<b>hi</b> 2 * 3 * 4" }]]);
    expect(hasMarks("<b>hi</b> # not a heading")).toBe(false);
  });

  it("keeps a link only to an http(s) address", () => {
    expect(parseMarks("[x](javascript:alert(1))")).toEqual([
      [{ text: "[x](javascript:alert(1))" }],
    ]);
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("http://example.com")).toBe("http://example.com/");
  });

  it("draws list items with a bullet or their number", () => {
    expect(parseMarks("- one\n2. two\nthree")).toEqual([
      [{ text: "• " }, { text: "one" }],
      [{ text: "2. " }, { text: "two" }],
      [{ text: "three" }],
    ]);
    expect(hasMarks("- one")).toBe(true);
  });

  it("raised the text limit to 4,000 characters", () => {
    expect(BOARD_LIMITS.maxText).toBe(4000);
  });
});

describe("the page's reader is lossless", () => {
  // A page's save writes a block back whole, so whatever its reader drops from a valid block is
  // lost for everyone. Every value the Worker accepts must come back exactly as stored.
  it.each<[string, Record<string, unknown>]>([
    ["a filled box", block({ hollow: false })],
    ["a hollow box", block({ hollow: true })],
    ["a wrapping note", block({ kind: "note", wrap: true })],
    ["a note that does not wrap", block({ kind: "note", wrap: false })],
    ["a text block", block({ kind: "text", size: "title", textAlign: "center", wrap: true })],
    [
      "a styled section",
      block({ kind: "container", color: "#123456", stroke: "ink", hollow: false, z: -3 }),
    ],
    ["a table", table({ text: "", size: "small", textAlign: "right", fills: { r1: { c1: "" } } })],
  ])("keeps %s as stored", (_name, stored) => {
    expect(boardDocError("blocks", stored)).toBeNull();
    expect(cleanBlock(stored)).toEqual(stored);
  });

  it("keeps an arrow's empty label", () => {
    const arrow = { from: "a", to: "b", label: "" };
    expect(boardDocError("arrows", arrow)).toBeNull();
    expect(cleanArrow(arrow)).toEqual(arrow);
  });
});

describe("what a page from before the wider format read whole", () => {
  it.each<[string, string, Record<string, unknown>, string | null]>([
    [
      "a plain note",
      "blocks",
      { kind: "note", x: 0, y: 0, w: 200, h: 140, text: "Hi", color: "pink", z: 2 },
      null,
    ],
    ["a box, an ellipse, a text", "blocks", block({ kind: "ellipse" }), null],
    ["a table", "blocks", table(), "cols"],
    ["a diamond", "blocks", block({ kind: "diamond" }), "kind"],
    ["a #rrggbb colour", "blocks", block({ color: "#123456" }), "color"],
    ["an outline", "blocks", block({ stroke: "green" }), "stroke"],
    ["a filled box", "blocks", block({ hollow: false }), "hollow"],
    ["a long text", "blocks", block({ text: "x".repeat(2001) }), "text"],
    ["2,000 characters", "blocks", block({ text: "x".repeat(2000) }), null],
    [
      "a plain arrow",
      "arrows",
      { from: "a", to: "b", label: "", style: "dashed", head: "both" },
      null,
    ],
    ["a routed arrow", "arrows", { from: "a", to: "b", bends: ["h", 10] }, "bends"],
  ])("%s", (_name, collection, stored, lost) => {
    expect(legacyBoardLoss(collection, stored)).toBe(lost);
  });
});

describe("table ids", () => {
  it("refuses ids an object lookup could reach through the prototype", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(boardDocError("blocks", table({ cols: { c1: { at: 1 }, [id]: { at: 2 } } }))).toMatch(
        /must be ids/,
      );
    }
    // A cell naming a column only the prototype has is refused.
    expect(boardDocError("blocks", table({ rows: { r1: { at: 1, constructor: "x" } } }))).toMatch(
      /a column id from cols/,
    );
  });
});
