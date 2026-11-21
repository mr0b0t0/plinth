// The sheet type: a table people sort, filter, calculate with and download, as JSON lines in
// sheet.jsonl (a header line, then one row per line; packages/shared/src/sheet/), shown by Plinth's
// sheet renderer (apps/web/src/renderers/sheet/) with formulas, a formula bar, sort, filter, print
// and CSV and .xlsx downloads. A sheet has no assets. Agents read cells with read_sheet and change
// them with edit_sheet. People never see the source: there is no source editor and no source diff.
// Owners and editors edit cells, rows and columns on the page, live with each other (#36: a row is
// a line of the live draft).
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

/**
 * A new sheet's v1 ("New" on the dashboard), in canonical form: three text columns, "Column 1" to
 * "Column 3", then 20 empty rows to type into.
 */
const BLANK_SHEET = [
  JSON.stringify({
    plinth: "sheet",
    v: 1,
    columns: [1, 2, 3].map((n) => ({ name: `Column ${n}`, type: "text" })),
  }),
  ...Array.from({ length: 20 }, () => "[]"),
].join("\n");

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
  editor: null,
  edit: "live",
  create: { label: "Sheet", title: "Untitled sheet", content: BLANK_SHEET },
};
