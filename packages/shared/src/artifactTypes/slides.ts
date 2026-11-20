// The slides type: Markdown in slides.md (a line --- between slides, packages/shared/src/slides.ts)
// plus image assets, shown as a deck by Plinth's slides renderer (apps/web/src/renderers/slides/),
// with paging, Present, a presenter view and print to PDF. Edited only in the source editor.
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
  renderer: { script: "slides.js", style: "slides.css" },
  editor: { language: "markdown", wordWrap: "on" },
  liveEdit: false,
  present: true,
};
