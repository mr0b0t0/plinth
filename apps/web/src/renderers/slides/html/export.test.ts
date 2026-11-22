// An HTML slide's .pptx model, read from the slide as rendered (layout stubbed: happy-dom lays
// nothing out): a painted box becomes a shape before its words, text keeps its runs at the content
// box, an x-shape keeps its kind, a picture keeps its cover crop, a drawing of Plinth's own becomes
// a picture in the colour on screen, and a live embed is left out and counted.
import { parseHtmlDeck } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import type { Geometry, Rect } from "../exportModel.ts";
import { buildHtmlSlide, htmlDeckContext } from "./build.ts";
import { connectorSvg } from "./connectors.ts";
import { buildHtmlExportModel, HTML_PPI } from "./export.ts";

type Style = Partial<CSSStyleDeclaration>;

/** Layout by id: each box's rect in canvas pixels (scale 1) and its computed style. */
function geometry(rects: Record<string, Rect>, styles: Record<string, Style>): Geometry {
  const blank: Style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    color: "rgb(17, 17, 17)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    fontSize: "32px",
    fontWeight: "400",
    lineHeight: "40px",
    textAlign: "left",
    fontFamily: "Inter, sans-serif",
    marginTop: "0px",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
  };
  const key = (el: Element) => el.id || el.localName;
  return {
    rect: (el) => rects[key(el)] ?? rects[el.localName] ?? { left: 0, top: 0, width: 0, height: 0 },
    style: (el) =>
      ({ ...blank, ...(styles[key(el)] ?? styles[el.localName] ?? {}) }) as CSSStyleDeclaration,
  };
}

describe("an HTML slide's .pptx model", () => {
  it("maps what PowerPoint has, pictures what it does not, and counts the embed it leaves out", () => {
    const r = parseHtmlDeck({
      index: JSON.stringify({ order: ["a"] }),
      css: null,
      slides: new Map([
        [
          "slides/a.html",
          '<section id="a"><div id="card"><p id="txt">Hello <b>bold</b></p></div><x-shape id="dia" kind="diamond"></x-shape><img id="pic" src="images/p.png" alt="P"><x-embed style="position:absolute; left:0; top:0; width:10px; height:10px"></x-embed><x-icon id="ic" name="Check"></x-icon><aside>Say it</aside></section>',
        ],
      ]),
    });
    if (!r.ok) throw new Error("refused");
    const { ctx } = htmlDeckContext(document, r.deck);
    const { view, parts } = buildHtmlSlide(ctx, r.deck.slides[0] as never, 1);
    document.body.append(view.frame);
    parts.root.querySelector("x-icon svg")?.setAttribute("id", "icsvg");
    const g = geometry(
      {
        a: { left: 0, top: 0, width: 1920, height: 1080 },
        card: { left: 144, top: 144, width: 576, height: 288 },
        txt: { left: 144, top: 144, width: 576, height: 144 },
        dia: { left: 1000, top: 100, width: 144, height: 144 },
        pic: { left: 0, top: 576, width: 1440, height: 504 },
        icsvg: { left: 1500, top: 100, width: 48, height: 48 },
      },
      {
        a: { backgroundColor: "rgb(251, 251, 248)" },
        card: {
          backgroundColor: "rgb(255, 255, 255)",
          borderTopLeftRadius: "24px",
          borderTopWidth: "2px",
          borderRightWidth: "2px",
          borderBottomWidth: "2px",
          borderLeftWidth: "2px",
          borderTopStyle: "solid",
          borderRightStyle: "solid",
          borderBottomStyle: "solid",
          borderLeftStyle: "solid",
          borderTopColor: "rgb(227, 230, 228)",
          borderRightColor: "rgb(227, 230, 228)",
          borderBottomColor: "rgb(227, 230, 228)",
          borderLeftColor: "rgb(227, 230, 228)",
        },
        txt: { paddingLeft: "24px", textTransform: "uppercase" },
        dia: { backgroundColor: "rgb(255, 128, 0)" },
        pic: { objectFit: "cover" },
        ic: { color: "rgb(43, 122, 120)" },
      },
    );
    Object.defineProperty(parts.root.querySelector("img"), "naturalWidth", { value: 1600 });
    Object.defineProperty(parts.root.querySelector("img"), "naturalHeight", { value: 1000 });
    const { model, embedsSkipped } = buildHtmlExportModel([view], r.deck, {
      title: "T",
      geometry: g,
    });
    expect(embedsSkipped).toBe(1);
    expect(model.width).toBeCloseTo(1920 / HTML_PPI, 2);
    expect(model.height).toBeCloseTo(7.5, 2);
    const s = model.slides[0];
    expect(s?.background).toBe("FBFBF8");
    expect(s?.notes).toBe("Say it");
    const kinds = s?.items.map((i) => (i.kind === "shape" ? `shape:${i.shape}` : i.kind));
    expect(kinds).toEqual(["shape:roundRect", "text", "shape:diamond", "image", "image"]);
    const card = s?.items[0];
    expect(card?.kind === "shape" && card.fill).toEqual({ color: "FFFFFF", transparency: 0 });
    expect(card?.kind === "shape" && card.line?.color).toBe("E3E6E4");
    expect(card?.kind === "shape" && card.box).toEqual({ x: 1, y: 1, w: 4, h: 2 });
    const text = s?.items[1];
    if (text?.kind !== "text") throw new Error("no text");
    // At the content box, inside the 24px padding; in capitals, as the screen sets it.
    expect(text.box.x).toBeCloseTo((144 + 24) / HTML_PPI, 3);
    expect(text.paras[0]?.runs.map((r) => [r.text, r.bold === true])).toEqual([
      ["HELLO ", false],
      ["BOLD", true],
    ]);
    expect(text.paras[0]?.font).toBe("Inter");
    expect(text.paras[0]?.size).toBe(16);
    const pic = s?.items[3];
    expect(pic?.kind === "image" && pic.src).toBe("images/p.png");
    expect(pic?.kind === "image" && pic.cover).toEqual({ ratio: 0.625 });
    const icon = s?.items[4];
    expect(icon?.kind === "image" && decodeURIComponent(icon.src)).toContain('fill="#2B7A78"');
    view.frame.remove();
  });

  it("names a face only when it is a plain family name (the .pptx writes it into its XML)", () => {
    const r = parseHtmlDeck({
      index: JSON.stringify({ order: ["a"] }),
      css: null,
      slides: new Map([
        ["slides/a.html", '<section id="a"><p id="ok">Plain</p><p id="bad">Hostile</p></section>'],
      ]),
    });
    if (!r.ok) throw new Error("refused");
    const { ctx } = htmlDeckContext(document, r.deck);
    const { view } = buildHtmlSlide(ctx, r.deck.slides[0] as never, 1);
    document.body.append(view.frame);
    const g = geometry(
      {
        a: { left: 0, top: 0, width: 1920, height: 1080 },
        ok: { left: 0, top: 0, width: 600, height: 40 },
        bad: { left: 0, top: 100, width: 600, height: 40 },
      },
      {
        ok: { fontFamily: '"Inter Tight", sans-serif' },
        bad: { fontFamily: "'a\"/><a:evil x=\"', sans-serif" },
      },
    );
    const { model } = buildHtmlExportModel([view], r.deck, { title: "T", geometry: g });
    const fonts = model.slides[0]?.items.flatMap((i) =>
      i.kind === "text" ? i.paras.map((p) => p.font) : [],
    );
    expect(fonts).toEqual(["Inter Tight", undefined]);
    view.frame.remove();
  });

  it("draws a connector as a picture that bounds its line and heads", () => {
    const svg = connectorSvg(
      document,
      [
        [0, 0],
        [100, 0],
      ],
      { width: 2, dash: "solid", start: "none", end: "filled" },
    );
    expect(svg.querySelectorAll("polygon")).toHaveLength(1);
  });
});
