// The .pptx writer on a fixed model: the file unzips (fflate) to a presentation at the deck's
// size, a slide with the title text, runs, bullets, levels, links (web and slide), a table and the
// image under ppt/media/, notes in the notes slide, deck text XML-escaped, and an image whose data
// is missing left out and counted.
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { DeckModel, Para } from "./pptxModel.ts";
import { buildPptx, textRuns } from "./pptxWriter.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const para = (over: Partial<Para>): Para => ({
  runs: [],
  level: 0,
  bullet: "none",
  size: 22.5,
  bold: false,
  align: "left",
  mono: false,
  color: "1F2328",
  lineHeight: 1.35,
  spaceBefore: 0,
  ...over,
});

const MODEL: DeckModel = {
  title: "Q4 <review> & more",
  width: 13.333,
  height: 7.5,
  theme: "light",
  slides: [
    {
      n: 1,
      notes: "Welcome <everyone>.\n• Keep it short",
      background: "FFFFFF",
      items: [
        {
          kind: "text",
          box: { x: 0.833, y: 0.667, w: 11.667, h: 1 },
          paras: [
            para({
              size: 54,
              bold: true,
              runs: [{ text: "Quarterly " }, { text: "review", italic: true }],
            }),
          ],
        },
        {
          kind: "text",
          box: { x: 0.833, y: 2, w: 11.667, h: 2 },
          paras: [
            para({
              bullet: "disc",
              runs: [
                { text: "See " },
                { text: "the site", href: "https://example.com/x", color: "0A58CA" },
              ],
            }),
            para({
              bullet: "disc",
              level: 1,
              spaceBefore: 6.8,
              runs: [{ text: "<script>alert(1)</script>" }],
            }),
            para({ bullet: "number", runs: [{ text: "Go to two", slide: 2 }] }),
            para({ mono: true, runs: [{ text: "  let x = 1;" }] }),
          ],
        },
        {
          kind: "table",
          box: { x: 0.833, y: 4.5, w: 6, h: 1 },
          rows: [
            [
              { runs: [{ text: "Region" }], header: true, align: "left" },
              { runs: [{ text: "Revenue" }], header: true, align: "right" },
            ],
            [
              { runs: [{ text: "EU" }], header: false, align: "left" },
              { runs: [{ text: "1.2M" }], header: false, align: "right" },
            ],
          ],
          colW: [3, 3],
          size: 16.5,
          color: "1F2328",
          headColor: "0D1117",
          rule: "D8DEE4",
        },
        { kind: "image", box: { x: 8, y: 4.5, w: 2, h: 2 }, src: "img/chart.png", alt: "A chart" },
      ],
    },
    {
      n: 2,
      notes: "",
      background: "15181C",
      items: [
        { kind: "image", box: { x: 1, y: 1, w: 1, h: 1 }, src: "missing.png", alt: "" },
        {
          kind: "text",
          box: { x: 0.833, y: 0.667, w: 11.667, h: 1 },
          paras: [para({ runs: [{ text: "Two" }] })],
        },
      ],
    },
  ],
};

async function files(model = MODEL) {
  const { blob, imagesSkipped } = await buildPptx(model, new Map([["img/chart.png", PNG]]));
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const text = (name: string) => {
    const f = zip[name];
    if (!f) throw new Error(`no ${name} in ${Object.keys(zip).join(", ")}`);
    return strFromU8(f);
  };
  return { zip, text, imagesSkipped };
}

describe("buildPptx", () => {
  it("writes a presentation at the deck's size, one slide per slide", async () => {
    const { zip, text } = await files();
    const size = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(text("ppt/presentation.xml"));
    // 13.333 x 7.5 in, in EMU (914400 per inch).
    expect(Math.abs(Number(size?.[1]) - 12192000)).toBeLessThan(1000);
    expect(Number(size?.[2])).toBe(6858000);
    expect(Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(2);
    expect(text("docProps/core.xml")).toContain(
      "<dc:title>Q4 &lt;review&gt; &amp; more</dc:title>",
    );
  });

  it("puts the text, runs, bullets, levels and links on the slide, escaped", async () => {
    const { text } = await files();
    const slide = text("ppt/slides/slide1.xml");
    expect(slide).toContain("<a:t>Quarterly </a:t>");
    expect(slide).toMatch(/<a:rPr[^>]* i="1"[^>]*>.*?<a:t>review<\/a:t>/s);
    expect(slide).toContain('sz="5400"');
    expect(slide).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(slide).not.toContain("<script>");
    expect(slide).toContain('lvl="1"');
    expect(slide).toContain("<a:buChar");
    expect(slide).toContain("<a:buAutoNum");
    expect(slide).toContain('typeface="Courier New"');
    const rels = text("ppt/slides/_rels/slide1.xml.rels");
    expect(rels).toContain('Target="https://example.com/x"');
    expect(rels).toMatch(/Target="slide2\.xml"/);
    expect(slide).toContain("ppaction://hlinksldjump");
    // The table, with its header and alignment.
    expect(slide).toContain("<a:tbl>");
    expect(slide).toContain("<a:t>Revenue</a:t>");
    expect(slide).toContain('algn="r"');
  });

  it("adds the image, the notes and the background, and counts a missing image", async () => {
    const { zip, text, imagesSkipped } = await files();
    expect(imagesSkipped).toBe(1);
    expect(Object.keys(zip).some((n) => /^ppt\/media\/image.*\.png$/.test(n))).toBe(true);
    expect(text("ppt/slides/slide1.xml")).toContain('descr="A chart"');
    const notes = text("ppt/notesSlides/notesSlide1.xml");
    expect(notes).toContain("Welcome &lt;everyone&gt;.");
    expect(notes).toContain("• Keep it short");
    expect(text("ppt/slides/slide2.xml")).toContain('<a:srgbClr val="15181C"');
  });
});

describe("textRuns", () => {
  it("starts each paragraph with its settings and breaks between paragraphs", () => {
    const out = textRuns([
      para({ bullet: "disc", runs: [{ text: "a" }, { text: "b", bold: true }] }),
      para({ bullet: "number", level: 2, runs: [{ text: "c" }] }),
    ]);
    expect(out.map((r) => [r.text, r.options?.bullet, r.options?.breakLine])).toEqual([
      ["a", true, undefined],
      ["b", undefined, true],
      ["c", { type: "number" }, undefined],
    ]);
    expect(out[2]?.options?.indentLevel).toBe(2);
    expect(out[1]?.options?.bold).toBe(true);
  });
});
