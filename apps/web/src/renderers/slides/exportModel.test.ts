// The .pptx export model, measured from a real deck's DOM with stubbed layout: boxes in inches from
// the canvas scale, runs with bold, italic, code and links (only safe ones, #N as slide links),
// list levels, a table, an image, the footer and number, notes as plain text, and the file name.
import { parseDeck } from "@plinth/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeck, type SlideView } from "./deck.ts";
import {
  buildExportModel,
  type Geometry,
  hexColor,
  imageSources,
  notesText,
  pptxFileName,
  type Rect,
} from "./exportModel.ts";
import type { Item, Para } from "./pptxModel.ts";

const DECK = [
  "---",
  "footer: Q4 <b>review</b>",
  "---",
  "# Title **bold** *it* `code`",
  "",
  "Sub [web](https://example.com/a) and [bad](javascript:alert(1)) and [two](#2) and [far](#99)",
  "",
  "Note: Say **hi**.",
  "",
  "- first",
  "- second",
  "  1. inner",
  "",
  "---",
  "## Lists",
  "",
  "- a",
  "  - b",
  "- c",
  "  1. inner",
  "",
  "| A | B |",
  "|---|--:|",
  "| 1 | 2 |",
  "",
  "![A chart](img/chart.png)",
  "",
  "```js",
  "let x = 1;",
  "  y()",
  "```",
  "",
  "> quoted",
].join("\n");

/** The slide canvas is drawn at half size (scale 0.5) at (100, 50). */
const SLIDE: Rect = { left: 100, top: 50, width: 640, height: 360 };

function geometry(views: SlideView[]): Geometry {
  const slides = new Set<Element>(views.map((v) => v.el));
  let i = 0;
  const rects = new WeakMap<Element, Rect>();
  return {
    rect(el) {
      if (slides.has(el)) return SLIDE;
      let r = rects.get(el);
      if (!r) {
        // Every other element: 40 px right of the slide's left, stacked 10 px apart, in screen px.
        r = { left: 120, top: 60 + 10 * i++, width: 200, height: 8 };
        rects.set(el, r);
      }
      return r;
    },
    style(el) {
      const tag = el.localName;
      const heading = /^h\d$/.test(tag);
      return {
        fontSize: tag === "h1" ? "72px" : heading ? "52px" : "30px",
        fontWeight: heading || tag === "th" ? "650" : "400",
        textAlign: tag === "td" && el.textContent === "2" ? "right" : "start",
        color: tag === "a" ? "rgb(10, 88, 202)" : "rgb(31, 35, 40)",
        lineHeight: "40.5px",
        marginTop: tag === "li" ? "9px" : "0px",
        backgroundColor: el.localName === "section" ? "rgb(21, 24, 28)" : "rgba(0, 0, 0, 0)",
        objectFit: tag === "img" ? "contain" : "fill",
        borderBottomColor: "rgb(216, 222, 228)",
      } as ReturnType<Geometry["style"]>;
    },
  };
}

function model(text = DECK) {
  const parsed = parseDeck(text);
  const views = buildDeck(document, parsed);
  for (const v of views) document.body.append(v.frame);
  return buildExportModel(views, {
    aspect: parsed.settings.aspect,
    theme: "dark",
    title: "Q4 review",
    geometry: geometry(views),
  });
}

const texts = (items: Item[]) =>
  items.flatMap((i) =>
    i.kind === "text" ? i.paras.map((p) => p.runs.map((r) => r.text).join("")) : [],
  );
const paras = (items: Item[]) => items.flatMap((i) => (i.kind === "text" ? i.paras : []));
const runs = (ps: Para[]) => ps.flatMap((p) => p.runs);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildExportModel", () => {
  it("sizes the deck in inches and reads each slide's background", () => {
    const m = model();
    expect(m).toMatchObject({ title: "Q4 review", width: 13.333, height: 7.5, theme: "dark" });
    expect(m.slides.map((s) => s.n)).toEqual([1, 2]);
    expect(m.slides[0]?.background).toBe("15181C");
    expect(model("---\naspect: 4:3\n---\n# x")).toMatchObject({ width: 10.667, height: 8 });
  });

  it("measures boxes relative to the canvas, undoing its scale", () => {
    const [first] = model().slides[0]?.items ?? [];
    // x: (120 - 100) / 0.5 = 40 canvas px = 0.417 in; w: 200 / 0.5 = 400 px = 4.167 in.
    // (60 - 50) / 0.5 = 20 px = 0.208 in; 8 / 0.5 = 16 px = 0.167 in.
    expect(first?.box).toEqual({ x: 0.417, y: 0.208, w: 4.167, h: 0.167 });
  });

  it("keeps runs, sizes and weights, and only safe links", () => {
    const items = model().slides[0]?.items ?? [];
    const ps = paras(items);
    const title = ps[0];
    expect(title).toMatchObject({ size: 54, bold: true, align: "left", color: "1F2328" });
    expect(title?.runs).toEqual([
      { text: "Title " },
      { text: "bold", bold: true },
      { text: " " },
      { text: "it", italic: true },
      { text: " " },
      { text: "code", code: true },
    ]);
    const all = runs(ps);
    expect(all.find((r) => r.text === "web")).toEqual({
      text: "web",
      href: "https://example.com/a",
      color: "0A58CA",
    });
    expect(all.find((r) => r.text === "two")).toEqual({ text: "two", slide: 2, color: "0A58CA" });
    // A slide that does not exist and a javascript: link keep their text and lose the link.
    expect(all.find((r) => r.text === "far")).toEqual({ text: "far" });
    expect(all.some((r) => r.href?.startsWith("javascript"))).toBe(false);
    // markdown-it leaves an unsafe link as its source text.
    expect(texts(items)).toContain("Sub web and [bad](javascript:alert(1)) and two and far");
  });

  it("reads lists as bulleted paragraphs with levels", () => {
    const ps = paras(model().slides[1]?.items ?? []).filter((p) => p.bullet !== "none");
    expect(ps.map((p) => [p.runs[0]?.text, p.bullet, p.level, p.spaceBefore])).toEqual([
      ["a", "disc", 0, 0],
      ["b", "disc", 1, 0],
      ["c", "disc", 0, 6.8],
      ["inner", "number", 1, 0],
    ]);
  });

  it("reads tables, images, code blocks, quotes, the footer and the number", () => {
    const [one, two] = model().slides;
    const items = two?.items ?? [];
    const table = items.find((i) => i.kind === "table");
    expect(table).toMatchObject({
      kind: "table",
      size: 22.5,
      rule: "D8DEE4",
      colW: [4.167, 4.167],
    });
    if (table?.kind !== "table") throw new Error("no table");
    expect(table.rows.map((r) => r.map((c) => [c.runs[0]?.text, c.header, c.align]))).toEqual([
      [
        ["A", true, "left"],
        ["B", true, "left"],
      ],
      [
        ["1", false, "left"],
        ["2", false, "right"],
      ],
    ]);
    expect(items.find((i) => i.kind === "image")).toMatchObject({
      kind: "image",
      src: "img/chart.png",
      alt: "A chart",
    });
    const code = paras(items).filter((p) => p.mono);
    expect(code.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["let x = 1;", "  y()"]);
    expect(texts(items)).toContain("quoted");
    // The footer is text, never Markdown, and the number is the slide's.
    expect(texts(one?.items ?? [])).toEqual(expect.arrayContaining(["Q4 <b>review</b>", "1"]));
    expect(texts(items)).toContain("2");
    // Both stay on one line, as on screen; the body's text wraps.
    const oneLine = (one?.items ?? []).filter((i) => i.kind === "text" && i.oneLine);
    expect(texts(oneLine).sort()).toEqual(["1", "Q4 <b>review</b>"]);
  });

  it("keeps a code block's blank lines, and draws no line for its closing newline", () => {
    const m = model(["```js", "", "function a() {}", "", "", "function b() {}", "```"].join("\n"));
    const code = paras(m.slides[0]?.items ?? []).filter((p) => p.mono);
    expect(code.map((p) => p.runs.map((r) => r.text))).toEqual([
      [""],
      ["function a() {}"],
      [""],
      [""],
      ["function b() {}"],
    ]);
  });

  it("turns the notes into plain text", () => {
    expect(model().slides.map((s) => s.notes)).toEqual([
      "Say hi.\n• first\n• second\n  1. inner",
      "",
    ]);
  });

  it("leaves out content past the slide's edge", () => {
    const parsed = parseDeck("## Far\n\nfar away");
    const views = buildDeck(document, parsed);
    const g = geometry(views);
    const off: Geometry = {
      ...g,
      rect: (el) => (views[0]?.el === el ? SLIDE : { left: 120, top: 500, width: 100, height: 10 }),
    };
    const m = buildExportModel(views, {
      aspect: "16:9",
      theme: "light",
      title: "t",
      geometry: off,
    });
    expect(m.slides[0]?.items).toEqual([]);
  });

  it("lists each image source once", () => {
    const m = model(`![a](x.png)\n\n---\n\n![b](x.png)\n\n![c](data:image/png;base64,AAAA)`);
    expect(imageSources(m)).toEqual(["x.png", "data:image/png;base64,AAAA"]);
  });
});

describe("helpers", () => {
  it("reads CSS colours as RRGGBB", () => {
    expect(hexColor("rgb(10, 88, 202)")).toBe("0A58CA");
    expect(hexColor("rgba(255, 255, 255, 0.94)")).toBe("FFFFFF");
    expect(hexColor("rgb(1 2 3 / 50%)")).toBe("010203");
    expect(hexColor("#abcdef")).toBe("ABCDEF");
    expect(hexColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(hexColor("transparent")).toBeNull();
    expect(hexColor("color(srgb 1 0 0)")).toBeNull();
  });

  it("writes notes with list marks and table rows", () => {
    const t = document.createElement("template");
    t.innerHTML =
      "<p>One  two</p><ol start='3'><li>three<ul><li>deep</li></ul></li></ol><table><tr><td>a</td><td>b</td></tr></table><pre>x\n y\n</pre>";
    expect(notesText(t.content)).toBe("One two\n3. three\n  • deep\na | b\nx\n y");
  });

  it("names the file from the title, safely", () => {
    expect(pptxFileName("Q4 review")).toBe("Q4 review.pptx");
    expect(pptxFileName("a/b\\c:d*e?<f>|g")).toBe("a b c d e f g.pptx");
    expect(pptxFileName("Été 2026 — plan")).toBe("Été 2026 plan.pptx");
    expect(pptxFileName("..hidden")).toBe("hidden.pptx");
    expect(pptxFileName("")).toBe("deck.pptx");
    expect(pptxFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.pptx`);
  });
});
