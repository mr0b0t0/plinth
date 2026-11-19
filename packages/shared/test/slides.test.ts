// The slides type's source format (packages/shared/src/slides.ts): separators, fences, front
// matter, notes, columns, the problems a deck reports and its image references; plus the registry
// row and the shell's overview flag.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECK_SETTINGS,
  deckImagePaths,
  isSlideNumber,
  LIMITS,
  parseDeck,
  SLIDE_ASPECTS,
  SLIDE_DENSE,
  TYPE_REGISTRY,
  typeDef,
  typedShellHtml,
} from "../src/index.ts";

const heads = (text: string) => parseDeck(text).slides.map((s) => s.head.trim());

function payloadOf(shell: string): Record<string, unknown> {
  const m = /<script type="application\/json" id="__plinth-content">([^<]*)<\/script>/.exec(shell);
  if (!m?.[1]) throw new Error("no payload");
  return JSON.parse(m[1]);
}

describe("parseDeck: slides", () => {
  it("splits on lines that are exactly ---, trailing spaces allowed", () => {
    expect(heads("# A\n---\n## B\n---   \n## C")).toEqual(["# A", "## B", "## C"]);
    // Not separators: indented, longer, or with text.
    expect(heads("# A\n ---\n----\n--- x\n***\n___")).toHaveLength(1);
  });

  it("numbers slides from 1 and gives the line of each slide's first line", () => {
    const d = parseDeck("# A\n\n---\n\n## B\n---\n## C");
    expect(d.slides.map((s) => [s.n, s.line])).toEqual([
      [1, 1],
      [2, 4],
      [3, 7],
    ]);
  });

  it("does not split inside backtick or tilde fences (longer opener, shorter closer)", () => {
    const deck = "## A\n````md\n---\n```\n---\n````\n---\n## B\n~~~\n---\n~~~\n";
    expect(heads(deck)).toEqual(["## A\n````md\n---\n```\n---\n````", "## B\n~~~\n---\n~~~"]);
  });

  it("reads CRLF as LF", () => {
    expect(heads("# A\r\n---\r\n## B\r\n")).toEqual(["# A", "## B"]);
  });

  it("drops empty slides at the start and end, and reports one in the middle", () => {
    const d = parseDeck("---\n\n# A\n---\n\n---\n## B\n---\n\n");
    expect(d.slides.map((s) => s.head.trim())).toEqual(["# A", "", "## B"]);
    expect(d.problems).toEqual([
      expect.objectContaining({ code: "slide_empty", slide: 2, line: 5 }),
    ]);
  });

  it("finds no slides in an empty or blank deck", () => {
    expect(parseDeck("").slides).toEqual([]);
    expect(parseDeck("\n\n---\n\n---\n").slides).toEqual([]);
  });

  it("counts 500 and 501 slides", () => {
    const deck = (n: number) => Array.from({ length: n }, (_, i) => `## ${i + 1}`).join("\n---\n");
    expect(parseDeck(deck(LIMITS.maxSlides)).slides).toHaveLength(500);
    expect(parseDeck(deck(LIMITS.maxSlides + 1)).slides).toHaveLength(501);
  });

  it("parses 1 MB of Markdown in well under 100 ms", () => {
    const slide = `## Title\n\n${"- a bullet with some words in it\n".repeat(20)}\n---\n`;
    const text = slide.repeat(Math.floor(LIMITS.maxSlidesBytes / slide.length));
    const t0 = Date.now();
    const d = parseDeck(text);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(d.slides.length).toBeGreaterThan(1000);
  });
});

describe("parseDeck: front matter", () => {
  it("reads the four settings, and defaults without front matter", () => {
    expect(parseDeck("# A").settings).toEqual(DEFAULT_DECK_SETTINGS);
    const d = parseDeck(
      "---\naspect: 4:3\ntheme: dark\npaginate: false\nfooter: Q4 · Aconite\n---\n# A",
    );
    expect(d.settings).toEqual({
      aspect: "4:3",
      theme: "dark",
      paginate: false,
      footer: "Q4 · Aconite",
    });
    expect(d.slides).toHaveLength(1);
    expect(d.slides[0]?.line).toBe(7);
    expect(d.problems).toEqual([]);
  });

  it("is front matter only on line 1 with key: value lines; --- / # Title / --- is two slides", () => {
    expect(parseDeck("---\n# Title\n---\n## Next").slides.map((s) => s.head.trim())).toEqual([
      "# Title",
      "## Next",
    ]);
    const later = parseDeck("# A\n---\naspect: 4:3\n---\n## B");
    expect(later.settings).toEqual(DEFAULT_DECK_SETTINGS);
    expect(later.slides).toHaveLength(3);
  });

  it("reports unknown keys and bad values with their line, and ignores them", () => {
    const d = parseDeck(
      `---\naspect: 21:9\ntheme: neon\npaginate: yes\ncolor: red\nfooter: ${"x".repeat(130)}\n---\n# A`,
    );
    expect(d.settings).toEqual({ ...DEFAULT_DECK_SETTINGS, footer: "x".repeat(120) });
    expect(d.problems.map((p) => [p.code, p.line])).toEqual([
      ["slides_setting", 2],
      ["slides_setting", 3],
      ["slides_setting", 4],
      ["slides_setting", 5],
      ["slides_setting", 6],
    ]);
    expect(d.problems[3]?.message).toContain('"color"');
  });

  it("writes control characters in the text it quotes as \\uXXXX, never raw", () => {
    const d = parseDeck(
      "---\naspect: \u001b]8;;https://x.example\u0007a\ntheme: \u007fdark\npaginate: y\u0000s\n---\n# A",
    );
    const messages = d.problems.map((p) => p.message);
    expect(messages).toEqual([
      'aspect is 16:9 or 4:3, not "\\u001b]8;;https://x.example\\u0007a"',
      'theme is auto, light or dark, not "\\u007fdark"',
      'paginate is true or false, not "y\\u0000s"',
    ]);
    const raw = (s: string) =>
      [...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f);
    for (const m of messages) expect(raw(m)).toBe(false);
    // Still at most 40 characters of the deck, counted by code point.
    const long = parseDeck(`---\ntheme: ${"😀".repeat(50)}\n---\n# A`).problems[0]?.message;
    expect(long).toBe(`theme is auto, light or dark, not "${"😀".repeat(40)}…"`);
  });

  it("trims values and reads a long settings line in linear time", () => {
    expect(parseDeck("---\naspect: \t4:3 \t\nfooter:   Hi  there\n---\n# A").settings).toEqual({
      ...DEFAULT_DECK_SETTINGS,
      aspect: "4:3",
      footer: "Hi  there",
    });
    // Spaces inside a value made the old pattern backtrack: 160 KB took 20 s.
    const t = Date.now();
    const d = parseDeck(`---\naspect: x${" ".repeat(500_000)}y\n---\n# A`);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(d.problems.map((p) => p.code)).toEqual(["slides_setting"]);
  });

  it("keeps the aspect canvases fixed", () => {
    expect(SLIDE_ASPECTS).toEqual({
      "16:9": { width: 1280, height: 720 },
      "4:3": { width: 1024, height: 768 },
    });
  });
});

describe("parseDeck: notes and columns", () => {
  it("splits notes at the first Note: or Notes: line outside fences", () => {
    const d = parseDeck("# A\n\nNote: Say hi.\nMore.\n---\n## B\nNotes:\n- one\n---\n## C\n");
    expect(d.slides.map((s) => s.notes)).toEqual(["Say hi.\nMore.", "- one", ""]);
    expect(d.slides[0]?.head.trim()).toBe("# A");
  });

  it("keeps \\Note: as a paragraph and ignores Note: inside a fence", () => {
    const d = parseDeck("## A\n\\Note: this is text\n```\nNote: code\n```\n");
    expect(d.slides[0]?.notes).toBe("");
    expect(d.slides[0]?.head).toContain("Note: this is text");
    expect(d.slides[0]?.head).not.toContain("\\Note:");
    expect(d.slides[0]?.head).toContain("Note: code");
  });

  it("splits ||| into 2 or 3 columns, with the heading spanning", () => {
    const two = parseDeck("## H\n|||\nleft\n|||\nright\n").slides[0];
    expect(two?.head.trim()).toBe("## H");
    expect(two?.columns.map((c) => c.trim())).toEqual(["left", "right"]);
    const three = parseDeck("## H\n|||\na\n|||\nb\n|||\nc").slides[0];
    expect(three?.columns).toHaveLength(3);
    expect(parseDeck("## H\n```\n|||\n```").slides[0]?.columns).toEqual([]);
  });

  it("reports a fourth column (it joins the third) and a single column", () => {
    const four = parseDeck("## H\n|||\na\n|||\nb\n|||\nc\n|||\nd");
    expect(four.slides[0]?.columns.map((c) => c.trim())).toEqual(["a", "b", "c\nd"]);
    expect(four.problems).toEqual([expect.objectContaining({ code: "slides_setting", slide: 1 })]);
    const one = parseDeck("## H\n|||\nonly");
    expect(one.slides[0]?.columns).toEqual([]);
    expect(one.slides[0]?.head).toContain("only");
    expect(one.problems[0]?.message).toContain("one column");
  });
});

describe("parseDeck: dense slides", () => {
  it("warns past the character and line thresholds, not at them", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `- ${i}`).join("\n");
    expect(parseDeck(lines(SLIDE_DENSE.lines)).problems).toEqual([]);
    const many = parseDeck(lines(SLIDE_DENSE.lines + 1));
    expect(many.problems).toEqual([expect.objectContaining({ code: "slide_dense", slide: 1 })]);
    expect(many.problems[0]?.message).toContain("15 lines");
    expect(parseDeck("x".repeat(SLIDE_DENSE.chars)).problems).toEqual([]);
    const long = parseDeck(`## A\n---\n${"y".repeat(1240)}`);
    expect(long.problems[0]?.message).toBe(
      "Slide 2 (line 3) is long (1,240 characters) and will be shrunk to fit; split it or move detail into its Note:",
    );
  });

  it("does not count notes", () => {
    expect(parseDeck(`## A\nNote: ${"z".repeat(5000)}`).problems).toEqual([]);
  });
});

describe("deckImagePaths", () => {
  it("lists relative images outside code, once each, without ./ or a query", () => {
    const text = [
      "![a](chart.png) ![b](./img/x.png?v=2) ![c](chart.png)",
      "![d](https://example.com/y.png) ![e](data:image/png;base64,AA) ![f](/root.png) ![g](#x)",
      "`![h](code.png)`",
      "```",
      "![i](fenced.png)",
      "```",
      "![j](<spaced%20name.png>)",
    ].join("\n");
    expect(deckImagePaths(text)).toEqual(["chart.png", "img/x.png", "spaced name.png"]);
  });

  it("reads an angle-bracket destination to its > and resolves . and .. segments", () => {
    const text = [
      '![chart](<my chart.png>) ![t](<x y.png> "Title") ![c](img/../c.png)',
      "![d](./a/./b/../d.png) ![e](a//e.png) ![up](../above.png) ![bad](<no-close.png",
    ].join("\n");
    expect(deckImagePaths(text)).toEqual([
      "my chart.png",
      "x y.png",
      "c.png",
      "a/d.png",
      "a/e.png",
      "../above.png",
    ]);
  });

  it("stays linear on one long line of image openers", () => {
    // Each was quadratic before: a few hundred KB took minutes.
    const lines = [
      "![".repeat(400_000),
      `${"![".repeat(200_000)}](${" ".repeat(200_000)}<`,
      "![a](<".repeat(130_000),
      "![](".repeat(200_000),
      "![a]".repeat(160_000),
    ];
    for (const line of lines) {
      const t = Date.now();
      deckImagePaths(`# x\n${line}`);
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });
});

describe("slide numbers", () => {
  it("are integers from 1 to the slide limit", () => {
    for (const ok of [1, 2, 500]) expect(isSlideNumber(ok)).toBe(true);
    for (const bad of [0, -1, 501, 1.5, Number.NaN, "2", null])
      expect(isSlideNumber(bad)).toBe(false);
  });
});

describe("the slides registry row and shell", () => {
  it("is Markdown in slides.md with an image-only renderer type that presents", () => {
    const d = TYPE_REGISTRY.slides;
    expect(typeDef("slides")).toBe(d);
    expect(d).toMatchObject({
      sourcePath: "slides.md",
      sourceField: "content",
      maxSourceBytes: LIMITS.maxSlidesBytes,
      reservedPaths: ["index.html", "slides.md"],
      renderer: { script: "slides.js", style: "slides.css" },
      liveEdit: false,
      present: true,
    });
    expect(d.assetTypes?.test("image/svg+xml")).toBe(true);
    expect(d.assetTypes?.test("text/html")).toBe(false);
    expect(TYPE_REGISTRY.doc.present).toBeUndefined();
    expect(TYPE_REGISTRY.html.present).toBeUndefined();
    expect(LIMITS.maxSlidesBytes).toBe(1024 * 1024);
    expect(LIMITS.maxSlides).toBe(500);
  });

  it("carries view: overview only when asked, and the doc shell keeps its bytes without it", () => {
    const o = { title: "T", text: "# A", base: "", appOrigin: "https://app.example" };
    const deck = typedShellHtml(TYPE_REGISTRY.slides, o);
    expect(deck).toContain(
      '<main id="__plinth-slides" class="plinth-slides" tabindex="-1"></main>',
    );
    expect(deck).toContain('<script src="/__plinth/types/slides/slides.js"></script>');
    expect(payloadOf(deck)).not.toHaveProperty("view");
    expect(payloadOf(typedShellHtml(TYPE_REGISTRY.slides, { ...o, view: "overview" }))).toEqual({
      v: 1,
      type: "slides",
      path: "slides.md",
      app_origin: "https://app.example",
      text: "# A",
      view: "overview",
    });
    expect(typedShellHtml(TYPE_REGISTRY.doc, { ...o, view: undefined })).toBe(
      typedShellHtml(TYPE_REGISTRY.doc, o),
    );
  });
});
