// The whiteboard format (whiteboard.ts) and its registry row: board.json with a starting board,
// the stored settings, the fixed capabilities with the server-only `writers` field, the document
// checks every whiteboard write goes through, the renderer's lenient readers, and the shell.
import { describe, expect, it } from "vitest";
import {
  ARROW_LABEL_OFFSET,
  arrowEndpoints,
  arrowLabelAt,
  BOARD_LIMITS,
  BOARD_TOPICS,
  BoardContentError,
  boardCapabilities,
  boardDocError,
  boardSettingsText,
  cleanArrow,
  cleanBlock,
  hasPageCapabilities,
  pageDataOf,
  parseBoardContent,
  parseBoardSettings,
  parseCapabilities,
  readStoredCapabilities,
  serializeCapabilities,
  TYPE_REGISTRY,
  typeDef,
  typedShellHtml,
} from "../src/index.ts";

const block = (over: Record<string, unknown> = {}) => ({
  id: "a",
  kind: "note",
  x: 0,
  y: 0,
  w: 200,
  h: 140,
  text: "Ship v2",
  ...over,
});

function problem(text: string): { path: string; message: string } {
  try {
    parseBoardContent(text);
  } catch (e) {
    if (e instanceof BoardContentError) return { path: e.path, message: e.message };
    throw e;
  }
  throw new Error("accepted");
}

describe("parseBoardContent", () => {
  it("accepts the minimal board and fills the default settings: only editors change it", () => {
    expect(parseBoardContent('{"v":1}')).toEqual({
      settings: { v: 1, background: "dots", edit: "editors" },
      seed: [],
    });
    expect(boardCapabilities(parseBoardContent('{"v":1}').settings).writers).toBe("editor");
  });

  it("keeps a board that opens itself to commenters", () => {
    const { settings } = parseBoardContent('{"v":1,"edit":"commenters"}');
    expect(settings.edit).toBe("commenters");
    expect(boardCapabilities(settings).writers).toBe("commenter");
    expect(parseBoardSettings(boardSettingsText(settings)).edit).toBe("commenters");
  });

  it("accepts a full starting board, blocks then arrows", () => {
    const r = parseBoardContent(
      JSON.stringify({
        v: 1,
        background: "grid",
        edit: "editors",
        blocks: [
          block({ color: "yellow", z: 2 }),
          block({ id: "risk", kind: "rect", x: 320, w: 200, h: 100 }),
        ],
        arrows: [
          { id: "a1", from: "a", to: "risk", label: "blocks", style: "dashed", head: "both" },
        ],
      }),
    );
    expect(r.settings).toEqual({ v: 1, background: "grid", edit: "editors" });
    expect(r.seed.map((s) => [s.collection, s.id])).toEqual([
      ["blocks", "a"],
      ["blocks", "risk"],
      ["arrows", "a1"],
    ]);
    // The id is the document's id, never part of its data.
    expect(r.seed[0]?.data).toEqual({
      kind: "note",
      x: 0,
      y: 0,
      w: 200,
      h: 140,
      text: "Ship v2",
      color: "yellow",
      z: 2,
    });
  });

  it.each([
    ["bad JSON", "{v:1", ""],
    ["not an object", "[1]", ""],
    ["an unknown key", '{"v":1,"title":"x"}', "title"],
    ["another format version", '{"v":2}', "v"],
    ["no format version", "{}", "v"],
    ["an unknown background", '{"v":1,"background":"stars"}', "background"],
    ["an unknown edit mode", '{"v":1,"edit":"viewers"}', "edit"],
    ["blocks that are not a list", '{"v":1,"blocks":{}}', "blocks"],
  ])("refuses %s, with its path", (_name, text, path) => {
    expect(problem(text).path).toBe(path);
  });

  const withBlocks = (blocks: unknown[], arrows: unknown[] = []) =>
    JSON.stringify({ v: 1, blocks, arrows });

  it.each([
    ["a duplicate id", withBlocks([block(), block()]), "blocks[1].id"],
    [
      "an id shared by a block and an arrow",
      withBlocks([block(), block({ id: "b" })], [{ id: "a", from: "a", to: "b" }]),
      "arrows[0].id",
    ],
    ["a personal id", withBlocks([block({ id: "u_0123456789abcdef01234567" })]), "blocks[0].id"],
    ["an id that is not a document id", withBlocks([block({ id: "a b" })]), "blocks[0].id"],
    ["a missing id", withBlocks([{ ...block(), id: undefined }]), "blocks[0].id"],
    [
      "an arrow to an unknown block",
      withBlocks([block()], [{ id: "x", from: "a", to: "zz" }]),
      "arrows[0].to",
    ],
    [
      "an arrow from an unknown block",
      withBlocks([block()], [{ id: "x", from: "zz", to: "a" }]),
      "arrows[0].from",
    ],
    [
      "an arrow from a block to itself",
      withBlocks([block()], [{ id: "x", from: "a", to: "a" }]),
      "arrows[0].to",
    ],
    ["an unknown block key", withBlocks([block({ href: "x" })]), "blocks[0].href"],
    ["an unknown kind", withBlocks([block({ kind: "image" })]), "blocks[0].kind"],
    ["a fractional position", withBlocks([block({ x: 1.5 })]), "blocks[0].x"],
    ["a position out of bounds", withBlocks([block({ y: 1_000_001 })]), "blocks[0].y"],
    ["a block too small", withBlocks([block({ w: 23 })]), "blocks[0].w"],
    ["a block too big", withBlocks([block({ h: 4001 })]), "blocks[0].h"],
    ["a z out of bounds", withBlocks([block({ z: -1_000_001 })]), "blocks[0].z"],
    ["an unknown colour", withBlocks([block({ color: "red" })]), "blocks[0].color"],
    ["text that is not a string", withBlocks([block({ text: 3 })]), "blocks[0].text"],
    [
      "text over 4,000 characters",
      withBlocks([block({ text: "x".repeat(4001) })]),
      "blocks[0].text",
    ],
    [
      "a label over 120 characters",
      withBlocks(
        [block(), block({ id: "b" })],
        [{ id: "x", from: "a", to: "b", label: "l".repeat(121) }],
      ),
      "arrows[0].label",
    ],
    [
      "an unknown arrow style",
      withBlocks([block(), block({ id: "b" })], [{ id: "x", from: "a", to: "b", style: "wavy" }]),
      "arrows[0].style",
    ],
  ])("refuses %s", (_name, text, path) => {
    expect(problem(text).path).toBe(path);
  });

  it("counts characters, not UTF-16 units, against the text limit", () => {
    const emoji = "😀".repeat(4000);
    expect(() => parseBoardContent(withBlocks([block({ text: emoji })]))).not.toThrow();
  });

  it(`refuses more than ${BOARD_LIMITS.seedDocs} blocks and arrows together`, () => {
    const blocks = Array.from({ length: BOARD_LIMITS.seedDocs + 1 }, (_, i) =>
      block({ id: `b${i}`, x: i }),
    );
    expect(problem(withBlocks(blocks)).message).toMatch(/at most 500/);
    const exactly = blocks.slice(0, BOARD_LIMITS.seedDocs);
    expect(parseBoardContent(withBlocks(exactly)).seed).toHaveLength(500);
  });

  it("refuses input over 512 KiB", () => {
    const text = `{"v":1,"pad":"${"x".repeat(BOARD_LIMITS.maxBoardBytes)}"}`;
    expect(problem(text)).toEqual({
      path: "",
      message: expect.stringMatching(/over 524288 bytes/),
    });
  });
});

describe("settings", () => {
  it("stores the canonical settings and never a starting board", () => {
    const { settings } = parseBoardContent(
      JSON.stringify({ edit: "editors", blocks: [block()], v: 1 }),
    );
    const text = boardSettingsText(settings);
    expect(text).toBe('{\n  "v": 1,\n  "background": "dots",\n  "edit": "editors"\n}\n');
    expect(text).not.toContain("blocks");
    expect(parseBoardSettings(text)).toEqual(settings);
  });

  it("reads a malformed stored file, or one with no edit, as the defaults", () => {
    for (const t of ["", "nope", "[]", '{"v":1,"edit":"everyone","background":7}', '{"v":1}']) {
      expect(parseBoardSettings(t)).toEqual({ v: 1, background: "dots", edit: "editors" });
    }
  });
});

describe("fixed capabilities and writers", () => {
  it("opens the board's topics to commenters, or to nobody but editors", () => {
    expect(boardCapabilities({ v: 1, background: "dots", edit: "commenters" })).toEqual({
      data: true,
      viewer: true,
      shared: ["blocks", "arrows"],
      room: true,
      roomOpen: [...BOARD_TOPICS],
      people: false,
      comments: false,
      hold: false,
      writers: "commenter",
    });
    expect(boardCapabilities({ v: 1, background: "plain", edit: "editors" })).toMatchObject({
      roomOpen: [],
      writers: "editor",
    });
  });

  it("serializes writers only when set, after the room fields, and reads it back", () => {
    for (const edit of ["commenters", "editors"] as const) {
      const caps = boardCapabilities({ v: 1, background: "dots", edit });
      const json = serializeCapabilities(caps);
      expect(json.endsWith(`"writers":"${edit === "editors" ? "editor" : "commenter"}"}`)).toBe(
        true,
      );
      expect(readStoredCapabilities(json)).toEqual(caps);
    }
  });

  it("keeps an HTML declaration's bytes, with no writers key", () => {
    const html =
      '<meta name="plinth-capabilities" content="data viewer room"><meta name="plinth-data-shared" content="notes">';
    const caps = parseCapabilities(html);
    expect(caps).not.toHaveProperty("writers");
    const json = serializeCapabilities(caps as NonNullable<typeof caps>);
    expect(json).toBe('{"data":true,"viewer":true,"shared":["notes"],"room":true,"roomOpen":[]}');
    expect(readStoredCapabilities(json)).not.toHaveProperty("writers");
  });

  it("never reads writers from a page", () => {
    const caps = parseCapabilities(
      '<meta name="plinth-capabilities" content="data writers editor">',
    );
    expect(caps).not.toHaveProperty("writers");
  });

  it.each([["viewer"], ["owner"], [1], [null], [["editor"]], [{}]])(
    "drops a stored writers of %j on read",
    (w) => {
      const json = JSON.stringify({ data: true, viewer: true, shared: [], writers: w });
      const caps = readStoredCapabilities(json);
      expect(caps).not.toBeNull();
      expect(caps).not.toHaveProperty("writers");
      expect(caps?.data).toBe(true);
    },
  );
});

describe("boardDocError", () => {
  const ok = { kind: "note", x: 0, y: 0, w: 24, h: 4000, text: "" };
  it.each([
    ["blocks", ok],
    ["blocks", { ...ok, kind: "ellipse", color: "gray", z: -5, x: -1_000_000 }],
    ["arrows", { from: "a", to: "b" }],
    ["arrows", { from: "a", to: "b", label: "", style: "solid", head: "none" }],
  ])("accepts a %s document %j", (c, d) => {
    expect(boardDocError(c, d)).toBeNull();
  });

  it.each([
    ["tasks", ok, /only blocks and arrows/],
    ["blocks", { ...ok, id: "a" }, /id/],
    ["blocks", { ...ok, w: 0 }, /w must be/],
    ["blocks", { ...ok, text: undefined }, /text must be/],
    ["blocks", "note", /JSON object/],
    ["arrows", { from: "a", to: "a" }, /two different blocks/],
    ["arrows", { from: "a" }, /to must be/],
    ["arrows", { from: "u_0123456789abcdef01234567", to: "b" }, /from must be/],
    ["arrows", { from: "a", to: "b", head: "start" }, /head must be/],
  ])("refuses a %s document %j", (c, d, why) => {
    expect(boardDocError(c, d)).toMatch(why);
  });
});

describe("the renderer's readers", () => {
  it("clamps a block into bounds and drops unknown values", () => {
    expect(
      cleanBlock({ kind: "star", x: 2e9, y: -2e9, w: 1, h: 9e9, text: 5, color: "red", z: 1.6 }),
    ).toEqual({ kind: "note", x: 1_000_000, y: -1_000_000, w: 24, h: 4000, text: "", z: 2 });
    expect(cleanBlock({ x: "1", y: 0 })).toBeNull();
    expect(cleanBlock(null)).toBeNull();
    expect(cleanBlock({ x: 0, y: 0, text: "x".repeat(5000) })?.text).toHaveLength(4000);
  });

  it("drops an arrow that does not join two blocks", () => {
    expect(cleanArrow({ from: "a", to: "a" })).toBeNull();
    expect(cleanArrow({ from: "a", to: "<b>" })).toBeNull();
    expect(cleanArrow({ from: "a", to: "b", style: "zigzag", label: 4 })).toEqual({
      from: "a",
      to: "b",
    });
  });

  it("clips an arrow at both blocks' edges", () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 300, y: 0, w: 100, h: 100 };
    expect(arrowEndpoints(a, b, 0)).toEqual({ x1: 100, y1: 50, x2: 300, y2: 50 });
    const below = { x: 0, y: 300, w: 100, h: 100 };
    expect(arrowEndpoints(a, below, 4)).toEqual({ x1: 50, y1: 104, x2: 50, y2: 296 });
  });

  it("puts an arrow's label beside its line, clear of the arrowhead", () => {
    // Horizontal, either way round: centred above the line, past the head's 8 units.
    for (const p of [
      { x1: 0, y1: 50, x2: 80, y2: 50 },
      { x1: 80, y1: 50, x2: 0, y2: 50 },
    ]) {
      const at = arrowLabelAt(p);
      expect(at.anchor).toBe("middle");
      expect(at.x).toBeCloseTo(40, 6);
      expect(50 - at.y).toBeGreaterThanOrEqual(ARROW_LABEL_OFFSET + 6);
    }
    // Vertical: to the left, growing away from the line.
    const down = arrowLabelAt({ x1: 50, y1: 0, x2: 50, y2: 200 });
    expect(down).toEqual({ x: 50 - ARROW_LABEL_OFFSET, y: 100, anchor: "end" });
  });
});

describe("the whiteboard type", () => {
  it("is in the registry, with fixed capabilities and no assets or upload", () => {
    const def = typeDef("whiteboard");
    expect(def).toBe(TYPE_REGISTRY.whiteboard);
    expect(def?.sourcePath).toBe("board.json");
    expect(def?.assets).toBe(false);
    expect(def?.upload).toBe(false);
    expect(pageDataOf(TYPE_REGISTRY.whiteboard)).toBe("fixed");
    expect(pageDataOf(TYPE_REGISTRY.html)).toBe("declared");
    expect(pageDataOf(TYPE_REGISTRY.doc)).toBe("none");
    expect(hasPageCapabilities(TYPE_REGISTRY.whiteboard)).toBe(true);
    expect(hasPageCapabilities(TYPE_REGISTRY.slides)).toBe(false);
    expect(hasPageCapabilities(null)).toBe(false);
  });

  const shell = () =>
    typedShellHtml(TYPE_REGISTRY.whiteboard, {
      title: "Board",
      text: '{"v":1}',
      base: "",
      appOrigin: "https://plinth.example",
    });
  const payload = (html: string) =>
    JSON.parse(/id="__plinth-content">([^<]*)<\/script>/.exec(html)?.[1] ?? "null");

  it("loads the runtime right before the renderer, under the shell's meta CSP", () => {
    const html = shell();
    expect(
      html.startsWith(
        '<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'">',
      ),
    ).toBe(true);
    expect(html).toContain(
      '<script src="/__plinth/runtime.js"></script>\n<script src="/__plinth/types/whiteboard/whiteboard.js"></script>',
    );
    expect(html.indexOf("runtime.js")).toBeGreaterThan(html.indexOf("__plinth-content"));
  });

  it("has no source editor, and its payload carries no preview flag", () => {
    // People change a board on its page; agents change its settings with update_artifact.
    expect(TYPE_REGISTRY.whiteboard.editor).toBeNull();
    expect(Object.keys(payload(shell())).sort()).toEqual([
      "app_origin",
      "path",
      "text",
      "type",
      "v",
    ]);
  });

  it("leaves the doc shell without the runtime", () => {
    const doc = typedShellHtml(TYPE_REGISTRY.doc, {
      title: "T",
      text: "# x",
      base: "",
      appOrigin: "",
    });
    expect(doc).not.toContain("runtime.js");
  });
});
