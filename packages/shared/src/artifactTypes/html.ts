// The html type: a hand-written HTML page, served as-is. It has no renderer, so its page runs the
// author's own scripts under the content CSP, and it is edited only in the source editor.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const html: TypeModule<"html"> = {
  id: "html",
  label: "HTML page",
  badge: null,
  sourcePath: "index.html",
  sourceField: "html",
  sourceLabel: "HTML",
  contentType: "text/html; charset=utf-8",
  maxSourceBytes: LIMITS.maxHtmlBytes,
  reservedPaths: ["index.html"],
  assetTypes: null,
  renderer: null,
  editor: { language: "html", wordWrap: "on" },
  edit: "ask",
};
