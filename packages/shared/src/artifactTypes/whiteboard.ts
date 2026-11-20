// The whiteboard type: an infinite canvas of notes, text, shapes and arrows that people edit
// together. The board itself is shared data (collections `blocks` and `arrows`); a version holds
// only the board's settings in board.json (packages/shared/src/whiteboard.ts). Plinth's whiteboard
// renderer (apps/web/src/renderers/whiteboard/) draws it with the page runtime, so live cursors and
// drags go through the artifact's page room. Its capabilities are fixed by the server from the
// settings, never declared by a page. It has no assets and no bundle upload. People never see its
// source: they edit the board on its page and its settings from Settings in its ⋯ menu, and
// agents change the settings with update_artifact.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const whiteboard: TypeModule<"whiteboard"> = {
  id: "whiteboard",
  label: "Whiteboard",
  badge: "Board",
  sourcePath: "board.json",
  sourceField: "content",
  sourceLabel: "board JSON",
  contentType: "application/json; charset=utf-8",
  maxSourceBytes: LIMITS.maxBoardBytes,
  reservedPaths: ["index.html", "board.json"],
  assetTypes: null,
  renderer: { script: "whiteboard.js", style: "whiteboard.css", runtime: true },
  editor: null,
  liveEdit: false,
  pageData: "fixed",
  assets: false,
  upload: false,
  versions: "settings",
};
