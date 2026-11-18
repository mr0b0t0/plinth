// The doc type: Markdown in content.md plus image assets, shown by Plinth's doc renderer
// (apps/web/src/renderers/doc/) and edited on its page by owners and editors (#36).
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const doc: TypeModule<"doc"> = {
  id: "doc",
  label: "Document",
  badge: "Doc",
  sourcePath: "content.md",
  sourceField: "content",
  sourceLabel: "Markdown",
  contentType: "text/markdown; charset=utf-8",
  maxSourceBytes: LIMITS.maxDocBytes,
  reservedPaths: ["index.html", "content.md"],
  assetTypes: /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/,
  renderer: { script: "doc.js", style: "doc.css" },
  editor: { language: "markdown", wordWrap: "on" },
  liveEdit: true,
};
