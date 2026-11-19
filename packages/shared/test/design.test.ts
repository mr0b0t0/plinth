// The design format (design.html): the parser the Worker and the renderer share, and the document
// one artboard frame renders.
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_IFRAME_SANDBOX_OPAQUE,
  ARTIFACT_TYPES,
  BOARD_IFRAME_SANDBOX,
  BOARD_LOADER_FILE,
  boardDocument,
  DESIGN_LIMITS,
  DESIGN_MESSAGES,
  DESIGN_PRESETS,
  type DesignBoard,
  designIssueSummary,
  LIMITS,
  parseDesign,
  rendererFiles,
  slugBoardId,
  TYPE_REGISTRY,
  typeDef,
} from "../src/index.ts";

const marker = (attrs: string) => `<!-- artboard ${attrs} -->`;

function ok(text: string) {
  const r = parseDesign(text);
  if (!r.ok) throw new Error(`expected a design: ${JSON.stringify(r.issues)}`);
  return r.design;
}

function issues(text: string) {
  const r = parseDesign(text);
  if (r.ok) throw new Error("expected issues");
  return r.issues;
}

const SAMPLE = [
  "<!-- Shared: copied into every artboard's <head>. -->",
  '<link rel="stylesheet" href="brand.css">',
  "",
  marker('id="home" name="Home" size="iphone" section="Mobile"'),
  '<main class="h-full">',
  "  <h1>Ship faster</h1>",
  "</main>",
  "",
  marker(
    'id="post" name="Launch post" size="instagram-post" section="Social" background="#0b0b0f"',
  ),
  "<div>Now live</div>",
  "",
  marker('id="mrec" name="Ad 300x250" width="300" height="250" section="Ads"'),
  '<a href="https://example.com" target="_blank">Try it</a>',
].join("\n");

describe("parseDesign", () => {
  it("reads the shared section and every board, verbatim", () => {
    const d = ok(SAMPLE);
    expect(d.shared).toBe(
      "<!-- Shared: copied into every artboard's <head>. -->\n" +
        '<link rel="stylesheet" href="brand.css">\n',
    );
    expect(d.boards.map((b) => [b.id, b.name, b.width, b.height, b.preset, b.section])).toEqual([
      ["home", "Home", 393, 852, "iphone", "Mobile"],
      ["post", "Launch post", 1080, 1080, "instagram-post", "Social"],
      ["mrec", "Ad 300x250", 300, 250, null, "Ads"],
    ]);
    expect(d.boards[0]?.html).toBe('<main class="h-full">\n  <h1>Ship faster</h1>\n</main>\n');
    expect(d.boards[0]?.line).toBe(4);
    expect(d.boards[1]?.background).toBe("#0b0b0f");
    expect(d.boards[0]?.background).toBe("#ffffff");
    expect(d.boards[2]?.html).toBe('<a href="https://example.com" target="_blank">Try it</a>');
  });

  it("allows an empty shared section and an empty fragment", () => {
    const d = ok(`${marker('name="Blank" size="a4"')}\n${marker('name="Two" size="a5"')}`);
    expect(d.shared).toBe("");
    expect(d.boards.map((b) => b.html)).toEqual(["", ""]);
  });

  it("takes every size form and every preset", () => {
    expect(ok(marker('name="A" size="1080x1350"')).boards[0]).toMatchObject({
      width: 1080,
      height: 1350,
      preset: null,
    });
    expect(ok(marker('name="A" width="16" height="4096"')).boards[0]).toMatchObject({
      width: 16,
      height: 4096,
    });
    for (const [key, p] of Object.entries(DESIGN_PRESETS)) {
      const b = ok(marker(`name="${key}" size="${key}"`)).boards[0];
      expect(b).toMatchObject({ width: p.width, height: p.height, preset: key });
      expect(p.width).toBeGreaterThanOrEqual(DESIGN_LIMITS.minSide);
      expect(p.height).toBeLessThanOrEqual(DESIGN_LIMITS.maxSide);
    }
  });

  it("derives ids from names, dedupes them and keeps explicit ones free", () => {
    const d = ok(
      [
        marker('name="Home Screen!" size="iphone"'),
        marker('name="home screen" size="iphone"'),
        marker('name="***" size="iphone"'),
        marker('id="home-screen-3" name="Explicit" size="iphone"'),
        marker('name="Home screen" size="iphone"'),
      ].join("\n"),
    );
    expect(d.boards.map((b) => b.id)).toEqual([
      "home-screen",
      "home-screen-2",
      "board-3",
      "home-screen-3",
      "home-screen-4",
    ]);
    expect(slugBoardId("x".repeat(60))).toHaveLength(40);
    expect(slugBoardId("  Ünïcode -- names  ")).toBe("n-code-names");
    const long = ok(
      [
        marker(`name="${"a".repeat(60)}" size="a4"`),
        marker(`name="${"a".repeat(60)}" size="a4"`),
      ].join("\n"),
    );
    expect(long.boards.map((b) => b.id)).toEqual(["a".repeat(40), `${"a".repeat(38)}-2`]);
  });

  it("groups by section in order, absent counting as its own value", () => {
    const d = ok(
      [
        marker('name="A" size="a4" section="Print"'),
        marker('name="B" size="a4" section="Print"'),
        marker('name="C" size="a4"'),
        marker('name="D" size="a4" section="Print"'),
      ].join("\n"),
    );
    expect(d.boards.map((b) => b.section)).toEqual(["Print", "Print", null, "Print"]);
  });

  it("reads CRLF and a leading BOM", () => {
    const d = ok(`﻿<meta x>\r\n${marker('name="A" size="a4"')}\r\n<p>x</p>\r\n`);
    expect(d.shared).toBe("<meta x>\r");
    expect(d.boards[0]?.html).toBe("<p>x</p>\r\n");
  });

  it("keeps marker-like text inside a line in the fragment", () => {
    const d = ok(`${marker('name="A" size="a4"')}\n<p>x ${marker('name="B" size="a4"')}</p>\n`);
    expect(d.boards).toHaveLength(1);
    expect(d.boards[0]?.html).toContain("artboard name=");
    // "artboards" is not the word artboard.
    expect(ok(`<!-- artboards below -->\n${marker('name="A" size="a4"')}`).shared).toBe(
      "<!-- artboards below -->",
    );
  });

  it("splits at a marker line even inside a <script> (whole lines only)", () => {
    const d = ok(
      [
        marker('name="A" size="a4"'),
        "<script>",
        `  ${marker('name="B" size="a4"')}`,
        "</script>",
      ].join("\n"),
    );
    expect(d.boards.map((b) => b.name)).toEqual(["A", "B"]);
    expect(d.boards[0]?.html).toBe("<script>");
  });

  it("decodes entities in names and sections", () => {
    const b = ok(marker('name="Tom &amp; Jerry &#39;s &lt;b&gt;" size="a4" section="Q&amp;A"'))
      .boards[0];
    expect(b?.name).toBe("Tom & Jerry 's <b>");
    expect(b?.section).toBe("Q&A");
  });

  it("names every problem with its line, in line order", () => {
    const cases: [string, string][] = [
      [
        marker('name="A" size="a4" x="1"'),
        'Line 1: artboard attribute "x" is not one of id, name, size, width, height, background, section.',
      ],
      [marker("name=A size=a4"), 'Line 1: write artboard attributes as name="value".'],
      [marker('name="A"size="a4"'), 'Line 1: write artboard attributes as name="value".'],
      [marker('name="A size="a4"'), 'Line 1: write artboard attributes as name="value".'],
      [marker('size="a4"'), 'Line 1: the artboard needs a name="...".'],
      [marker('name="  " size="a4"'), 'Line 1: the artboard needs a name="...".'],
      [
        marker('name="A"'),
        'Line 1: give the artboard size="iphone" (a preset), size="1080x1080", or width and height, only one of them.',
      ],
      [
        marker('name="A" size="a4" width="10"'),
        'Line 1: give the artboard size="iphone" (a preset), size="1080x1080", or width and height, only one of them.',
      ],
      [
        marker('name="A" width="100"'),
        'Line 1: give the artboard size="iphone" (a preset), size="1080x1080", or width and height, only one of them.',
      ],
      [
        marker('name="A" width="1.5" height="100"'),
        'Line 1: give the artboard size="iphone" (a preset), size="1080x1080", or width and height, only one of them.',
      ],
      [
        marker('name="A" size="5000x200"'),
        'Line 1: artboard sides are 16 to 4096 px; "5000x200" is not.',
      ],
      [
        marker('name="A" width="15" height="200"'),
        'Line 1: artboard sides are 16 to 4096 px; "15x200" is not.',
      ],
      [
        marker('id="Home!" name="A" size="a4"'),
        'Line 1: id "Home!" may use a-z, 0-9 and -, up to 40.',
      ],
      [marker('id="-a" name="A" size="a4"'), 'Line 1: id "-a" may use a-z, 0-9 and -, up to 40.'],
      [
        marker('name="A" size="a4" background="red;x:y"'),
        "Line 1: background is a hex color, transparent or a color name.",
      ],
      [
        marker('name="A" size="a4" background="#12345"'),
        "Line 1: background is a hex color, transparent or a color name.",
      ],
      [marker('name="A" size="a4" name="B"'), 'Line 1: artboard attribute "name" is given twice.'],
      [
        marker('name="a<b" size="a4"'),
        "Line 1: the value of name may not contain <, > or control characters.",
      ],
      [
        marker(`name="${"n".repeat(81)}" size="a4"`),
        "Line 1: the artboard name is longer than 80 characters.",
      ],
      [
        marker(`name="A" size="a4" section="${"s".repeat(61)}"`),
        "Line 1: section is 1 to 60 characters.",
      ],
      [
        marker(`name="${"n".repeat(121)}" size="a4"`),
        "Line 1: the value of name is longer than 120 characters.",
      ],
    ];
    for (const [text, message] of cases)
      expect(issues(text), text).toEqual([expect.objectContaining({ line: 1, message })]);

    const unknown = issues(marker('name="A" size="iphon"'))[0]?.message;
    expect(unknown).toMatch(
      /^Line 1: "iphon" is not a size preset\. Presets: iphone, iphone-pro-max, /,
    );
    expect(unknown).toMatch(/slide-4x3 \(or use size="WxH"\)\.$/);

    const dup = issues(
      [
        marker('id="home" name="A" size="a4"'),
        "<p>x</p>",
        marker('id="home" name="B" size="a4"'),
      ].join("\n"),
    );
    expect(dup).toEqual([
      expect.objectContaining({ line: 3, message: 'Line 3: id "home" is already used on line 1.' }),
    ]);

    const several = issues(
      [marker('name="A" size="nope"'), marker('name="B"'), marker('name="C" q="1"')].join("\n"),
    );
    expect(several.map((i) => i.line)).toEqual([1, 2, 3]);
    expect(several[0]).toMatchObject({ board: "A" });
    expect(designIssueSummary(several)).toMatch(/\(and 2 more problems\)$/);
    expect(designIssueSummary(several.slice(0, 1))).toBe(several[0]?.message);
  });

  it("needs a marker, refuses whole documents, and caps the issues", () => {
    expect(issues("<p>just html</p>")).toEqual([{ line: 0, message: DESIGN_MESSAGES.noBoards }]);
    expect(issues("")).toEqual([{ line: 0, message: DESIGN_MESSAGES.noBoards }]);
    for (const doc of ["<!doctype html><p>x</p>", "  <HTML lang=en>", "﻿<!DOCTYPE html>"]) {
      expect(issues(`${doc}\n${marker('name="A" size="a4"')}`)).toEqual([
        { line: 1, message: DESIGN_MESSAGES.wholeDocument },
      ]);
    }
    const bad = Array.from({ length: 50 }, (_, i) => marker(`name="B${i}" size="x"`)).join("\n");
    expect(issues(bad)).toHaveLength(DESIGN_LIMITS.maxIssues);
  });

  it("holds 60 artboards and refuses 61", () => {
    const boards = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${marker(`name="B${i}" size="ad-mobile-banner"`)}\n<p>${i}</p>`,
      ).join("\n");
    expect(ok(boards(60)).boards).toHaveLength(60);
    expect(issues(boards(61))).toEqual([
      {
        line: 0,
        message: "A design has at most 60 artboards; this one has 61. Split it into two designs.",
      },
    ]);
  });

  it("parses a 2 MB, 100,000-line source in linear time", () => {
    const line = '<div class="p-4 text-sm">row</div>';
    const body = Array.from({ length: 100_000 }, () => line).join("\n");
    const text = `${marker('name="Big" size="a4"')}\n${body}`.slice(0, LIMITS.maxDesignBytes);
    const hostile = `${marker('name="A" size="a4"')}\n${"<!-- artboard ".repeat(60_000)}`;
    const start = Date.now();
    expect(ok(text).boards).toHaveLength(1);
    expect(ok(hostile).boards).toHaveLength(1);
    // Generous for slow CI machines; a backtracking scan takes far longer.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("boardDocument", () => {
  const board: DesignBoard = {
    id: "post",
    name: 'Launch <post> & "more"',
    width: 1080,
    height: 1080,
    preset: "instagram-post",
    background: "#0b0b0f",
    section: null,
    line: 1,
    html: "<div>Now live</div>",
  };

  it("puts Plinth's base, viewport and reset before the shared section and the fragment", () => {
    const html = boardDocument({
      board,
      shared: '<base href="https://evil.example/"><link rel="stylesheet" href="brand.css">',
      baseHref: 'https://abc.content.example/__plinth/v/2/"><script>x</script>',
    });
    expect(html).toBe(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">\n' +
        '<base href="https://abc.content.example/__plinth/v/2/&quot;&gt;&lt;script&gt;x&lt;/script&gt;">\n' +
        '<meta name="viewport" content="width=1080, initial-scale=1">\n' +
        "<title>Launch &lt;post&gt; &amp; &quot;more&quot;</title>\n" +
        "<style>html{width:1080px;height:1080px;overflow:hidden;background:#0b0b0f}body{margin:0;min-height:100%}</style>\n" +
        '<base href="https://evil.example/"><link rel="stylesheet" href="brand.css">\n' +
        "</head><body>\n" +
        "<div>Now live</div>\n" +
        "</body></html>",
    );
    expect(html.indexOf('<base href="https://abc')).toBeLessThan(html.indexOf("evil.example"));
  });

  it("never writes a background the parser would refuse", () => {
    const html = boardDocument({
      board: { ...board, background: "red}html{display:none" },
      shared: "",
      baseHref: "/",
    });
    expect(html).toContain("background:#ffffff}");
  });
});

describe("the design registry row", () => {
  it("is consistent and served through its renderer and board loader", () => {
    const d = TYPE_REGISTRY.design;
    expect(typeDef("design")).toBe(d);
    expect(ARTIFACT_TYPES.indexOf("design")).toBe(ARTIFACT_TYPES.indexOf("design_system") + 1);
    expect(d.reservedPaths).toContain(d.sourcePath);
    expect(d.sourcePath).toBe("design.html");
    expect(d.sourceField).toBe("content");
    expect(d.maxSourceBytes).toBe(2 * 1024 * 1024);
    expect(d.opaqueFrames).toBe(true);
    expect(d.renderer?.frame).toBe(BOARD_LOADER_FILE);
    // The loader is the Worker's own page, never a build output.
    expect(rendererFiles(d).map((f) => f.name)).toEqual(["design.js", "design.css"]);
    expect(BOARD_IFRAME_SANDBOX).toBe(ARTIFACT_IFRAME_SANDBOX_OPAQUE);
    expect(BOARD_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    for (const ct of ["image/png", "image/svg+xml", "text/css", "text/javascript", "video/mp4"]) {
      expect(d.assetTypes?.test(ct), ct).toBe(true);
    }
    for (const ct of ["font/woff2", "application/json", "text/html", "text/plain"]) {
      expect(d.assetTypes?.test(ct), ct).toBe(false);
    }
  });

  it("gives a frame only to types with opaque frames", () => {
    for (const t of ARTIFACT_TYPES) {
      const def = TYPE_REGISTRY[t];
      if (def.renderer?.frame) expect(def.opaqueFrames, t).toBe(true);
      if (t !== "design") expect(def.opaqueFrames, t).toBeUndefined();
    }
  });
});
