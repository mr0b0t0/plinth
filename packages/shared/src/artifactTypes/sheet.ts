// The sheet type: a table people sort, filter, calculate with and download, as JSON lines in
// sheet.jsonl (a header line, then one row per line; packages/shared/src/sheet/), shown by Plinth's
// sheet renderer (apps/web/src/renderers/sheet/) with formulas, a formula bar, sort, filter, print
// and CSV and .xlsx downloads. A sheet has no assets. Agents read cells with read_sheet and change
// them with edit_sheet; people edit the source in the editor.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const sheet: TypeModule<"sheet"> = {
  id: "sheet",
  label: "Sheet",
  badge: "Sheet",
  sourcePath: "sheet.jsonl",
  sourceField: "content",
  sourceLabel: "sheet JSON lines",
  contentType: "text/plain; charset=utf-8",
  maxSourceBytes: LIMITS.maxSheetBytes,
  reservedPaths: ["index.html", "sheet.jsonl"],
  // Matches no content type, the empty one included: a sheet takes no assets.
  assetTypes: /(?!)/,
  renderer: { script: "sheet.js", style: "sheet.css" },
  editor: { language: "plaintext", wordWrap: "off" },
  liveEdit: false,
};
