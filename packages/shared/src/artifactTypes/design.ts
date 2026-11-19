// The design type: artboards on a canvas (app screens, posters, social posts, ads) in one file,
// design.html (shared <head> tags, then a marker line and an HTML fragment per artboard;
// packages/shared/src/design.ts), plus images, CSS, JS and video. Plinth's design renderer
// (apps/web/src/renderers/design/) lays the boards out on a pannable, zoomable canvas and shows
// each one alone at its exact size in a nested frame with an opaque origin, loaded from the fixed
// board loader (renderer.frame). Edited only in the source editor.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";
import { BOARD_LOADER_FILE } from "../design.ts";

export const design: TypeModule<"design"> = {
  id: "design",
  label: "Design",
  badge: "Design",
  sourcePath: "design.html",
  sourceField: "content",
  sourceLabel: "design HTML",
  contentType: "text/html; charset=utf-8",
  maxSourceBytes: LIMITS.maxDesignBytes,
  reservedPaths: ["index.html", "design.html"],
  assetTypes:
    /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|text\/css|text\/javascript|application\/javascript|video\/(mp4|webm))(;|$)/,
  renderer: { script: "design.js", style: "design.css", frame: BOARD_LOADER_FILE },
  editor: { language: "html", wordWrap: "on" },
  liveEdit: false,
  opaqueFrames: true,
};
