// The slides type: Markdown in slides.md (a line --- between slides, packages/shared/src/slides.ts)
// plus image assets, shown as a deck by Plinth's slides renderer (apps/web/src/renderers/slides/),
// with paging, Present, a presenter view, print to PDF, a .pptx download and, where live rooms
// run, following the presenter. Edited only in the source editor.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const slides: TypeModule<"slides"> = {
  id: "slides",
  label: "Slides",
  badge: "Slides",
  sourcePath: "slides.md",
  sourceField: "content",
  sourceLabel: "Markdown",
  contentType: "text/markdown; charset=utf-8",
  maxSourceBytes: LIMITS.maxSlidesBytes,
  reservedPaths: ["index.html", "slides.md"],
  assetTypes: /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/,
  renderer: {
    script: "slides.js",
    style: "slides.css",
    // The .pptx writer (PptxGenJS), loaded only when someone downloads the deck as .pptx.
    lazy: [{ file: "slides-pptx.js", entry: "pptx.ts" }],
  },
  editor: { language: "markdown", wordWrap: "on" },
  liveEdit: false,
  present: true,
  // Owners and editors lead identified viewers over the room's `slides` channel (rooms/slides.ts).
  follow: true,
  fileExports: ["pptx"],
};
