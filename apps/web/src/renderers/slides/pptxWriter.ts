// Writes a deck's export model (pptxModel.ts) as a .pptx with PptxGenJS: one slide per slide at the
// deck's size (13.333 x 7.5 in for 16:9, 10.667 x 8 in for 4:3), editable text boxes with their
// runs, bullets and levels, tables, images, speaker notes, and the slide's background. Fonts are
// Arial and Courier New, which every copy of PowerPoint, Keynote and Google Slides has.
//
// This file is only in the lazy writer bundle (pptx.ts, served as slides-pptx.js), never in the
// main renderer script, so a deck's first view does not download PptxGenJS.
import PptxGenJS from "pptxgenjs";
import type { Cell, DeckModel, Item, Para, PptxBuilder, Run } from "./pptxModel.ts";

const SANS = "Arial";
const MONO = "Courier New";

type TextProps = PptxGenJS.TextProps;
type Slide = PptxGenJS.Slide;

/**
 * Characters XML 1.0 does not allow: C0 controls other than tab, line feed and carriage return,
 * U+FFFE and U+FFFF, and a surrogate without its pair. PptxGenJS escapes only & < > " ', so deck
 * text holding one of these (an ANSI escape pasted into a code block, a backspace in the notes)
 * would give a file PowerPoint repairs or refuses to open.
 */
const NOT_XML =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` without the characters an XML part cannot hold. */
export function xmlText(s: string): string {
  return s.replace(NOT_XML, "");
}

function runOptions(r: Run, p: Pick<Para, "size" | "color" | "bold" | "mono">) {
  return {
    fontFace: r.code || p.mono ? MONO : SANS,
    fontSize: p.size,
    color: r.color ?? p.color,
    bold: p.bold || r.bold === true,
    ...(r.italic ? { italic: true } : {}),
    ...(r.strike ? { strike: "sngStrike" as const } : {}),
    ...(r.href ? { hyperlink: { url: xmlText(r.href) } } : {}),
    ...(r.slide ? { hyperlink: { slide: r.slide } } : {}),
  };
}

/**
 * A text box's runs. PptxGenJS starts a paragraph after a run with breakLine, and reads the
 * paragraph's own settings (bullet, level, alignment, spacing) from its first run.
 */
export function textRuns(paras: readonly Para[]): TextProps[] {
  const out: TextProps[] = [];
  paras.forEach((p, pi) => {
    p.runs.forEach((r, ri) => {
      const options: PptxGenJS.TextPropsOptions = runOptions(r, p);
      if (ri === 0) {
        options.align = p.align;
        options.bullet =
          p.bullet === "disc" ? true : p.bullet === "number" ? { type: "number" } : false;
        if (p.level > 0) options.indentLevel = p.level;
        options.lineSpacingMultiple = p.lineHeight;
        if (p.spaceBefore > 0) options.paraSpaceBefore = p.spaceBefore;
      }
      if (ri === p.runs.length - 1 && pi < paras.length - 1) options.breakLine = true;
      out.push({ text: xmlText(r.text), options });
    });
  });
  return out;
}

function cellOf(cell: Cell, t: Extract<Item, { kind: "table" }>): PptxGenJS.TableCell {
  const p = {
    size: t.size,
    color: cell.header ? t.headColor : t.color,
    bold: cell.header,
    mono: false,
  };
  const runs = cell.runs.map((r) => ({ text: xmlText(r.text), options: runOptions(r, p) }));
  return {
    text: runs.length > 0 ? runs : "",
    options: {
      align: cell.align,
      bold: cell.header,
      color: p.color,
      fontFace: SANS,
      fontSize: t.size,
      valign: "middle",
      border: [
        { type: "none" },
        { type: "none" },
        { type: "solid", pt: 0.75, color: t.rule },
        { type: "none" },
      ],
    },
  };
}

function addItem(slide: Slide, item: Item, images: ReadonlyMap<string, string>): boolean {
  const { x, y, w, h } = item.box;
  if (item.kind === "text") {
    slide.addText(textRuns(item.paras), {
      x,
      y,
      w,
      h,
      margin: 0,
      valign: "top",
      wrap: true,
      fontFace: SANS,
    });
    return true;
  }
  if (item.kind === "table") {
    slide.addTable(
      item.rows.map((row) => row.map((cell) => cellOf(cell, item))),
      {
        x,
        y,
        w,
        ...(item.colW.length > 0 && item.colW.every((c) => c > 0) ? { colW: item.colW } : {}),
        fontFace: SANS,
        fontSize: item.size,
        color: item.color,
        margin: [0.04, 0.08, 0.04, 0.08],
        autoPage: false,
      },
    );
    return true;
  }
  const data = images.get(item.src);
  if (!data) return false;
  slide.addImage({ data, x, y, w, h, altText: xmlText(item.alt) });
  return true;
}

/**
 * The .pptx for `model`. An image whose src `images` lacks is left out; `imagesSkipped` counts the
 * distinct files left out (a logo on every slide is one), which is what the person can fix.
 */
export const buildPptx: PptxBuilder = async (model: DeckModel, images) => {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PLINTH", width: model.width, height: model.height });
  pptx.layout = "PLINTH";
  pptx.title = xmlText(model.title);
  pptx.theme = { headFontFace: SANS, bodyFontFace: SANS };
  const skipped = new Set<string>();
  for (const s of model.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: s.background };
    for (const item of s.items) {
      if (!addItem(slide, item, images) && item.kind === "image") skipped.add(item.src);
    }
    const notes = xmlText(s.notes);
    if (notes !== "") slide.addNotes(notes);
  }
  const blob = (await pptx.write({ outputType: "blob", compression: true })) as Blob;
  return { blob, imagesSkipped: skipped.size };
};
