// The deck as the .pptx writer takes it: every slide's text, tables and images with their boxes in
// inches, measured from the rendered slides (exportModel.ts), so the file matches the screen. Types
// and one event name only: the lazy writer (pptx.ts) imports this file and nothing else from the
// main renderer bundle.

/** Fired on the document by the lazy writer when it has loaded; `detail.build` writes the file. */
export const PPTX_READY_EVENT = "plinth-slides-pptx";

/** A box on the slide, in inches from its top left corner (canvas pixels / 96). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** Inline code: a monospace font. */
  code?: boolean;
  /** A web or mail link (only what the doc's URL rules accept). */
  href?: string;
  /** A link to another slide (a #N link in the Markdown). */
  slide?: number;
  /** The run's own colour (a link, or an HTML slide's coloured phrase), as RRGGBB. */
  color?: string;
  /** An HTML slide's underlined phrase. */
  underline?: boolean;
}

export interface Para {
  runs: Run[];
  /** List nesting, 0 for the top level and for anything that is not a list item. */
  level: number;
  bullet: "none" | "disc" | "number";
  /** Font size in points (canvas pixels * 0.75). */
  size: number;
  bold: boolean;
  align: "left" | "center" | "right";
  /** A code block's lines. */
  mono: boolean;
  /** Text colour, RRGGBB. */
  color: string;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Space above the paragraph in points (list items after the first). */
  spaceBefore: number;
  /** The face the screen uses (an HTML deck's), else the file's Arial. */
  font?: string;
}

export interface Cell {
  runs: Run[];
  header: boolean;
  align: "left" | "center" | "right";
}

export type Item =
  | {
      kind: "text";
      box: Box;
      paras: Para[];
      /** One line that never wraps, as on screen (the footer and the slide number). */
      oneLine?: true;
    }
  | {
      kind: "table";
      box: Box;
      rows: Cell[][];
      /** Column widths in inches, from the first row. */
      colW: number[];
      /** The cells' top and bottom margin in inches, from the screen's cell padding. */
      padY?: number;
      size: number;
      color: string;
      headColor: string;
      /** The rule under each row, RRGGBB. */
      rule: string;
    }
  /** `src` is the image's own src: a path to one of the artifact's files, or a data: URL. */
  | {
      kind: "image";
      box: Box;
      src: string;
      alt: string;
      /**
       * The picture fills its box and is cropped (CSS object-fit: cover), not stretched; `ratio`
       * is its own height over its width.
       */
      cover?: { ratio: number };
    }
  /** A painted box of an HTML slide, or one of its shapes: an editable PowerPoint shape. */
  | {
      kind: "shape";
      box: Box;
      shape: ShapeKind;
      /** RRGGBB and 0 to 100 percent transparent, or null for no fill. */
      fill: { color: string; transparency: number } | null;
      line: { color: string; width: number; dash: "solid" | "dash" | "sysDot" } | null;
      /** A rounded rectangle's corner, 0 to 1 of half its shorter side. */
      radius?: number;
    };

export type ShapeKind =
  | "rect"
  | "roundRect"
  | "ellipse"
  | "diamond"
  | "rightArrow"
  | "leftArrow"
  | "upArrow"
  | "downArrow"
  | "line";

export interface SlideModel {
  n: number;
  /** The speaker notes as plain text: line breaks, "• " bullets and "1. " numbers. */
  notes: string;
  /** The slide's background colour, RRGGBB. */
  background: string;
  items: Item[];
}

export interface DeckModel {
  /** The deck's title (the artifact's title), for the file's properties. */
  title: string;
  /** Slide size in inches: 13.333 x 7.5 for 16:9, 10.667 x 8 for 4:3. */
  width: number;
  height: number;
  /** The colours the deck was exported in. */
  theme: "light" | "dark";
  slides: SlideModel[];
}

/** Writes the .pptx. `images` maps an image item's src to a data: URL, or lacks it (left out). */
export type PptxBuilder = (
  model: DeckModel,
  images: ReadonlyMap<string, string>,
) => Promise<{ blob: Blob; imagesSkipped: number }>;
