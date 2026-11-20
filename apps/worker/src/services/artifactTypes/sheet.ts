// The sheet type's Worker hooks: JSON lines in sheet.jsonl (packages/shared/src/sheet/), refused
// with every problem (up to 20, each naming its line and cell) when they do not parse; never a
// whole HTML document, and never CSV without content_format. What a version stores is the
// canonical form (serializeSheet), so each row has one spelling and diffs show only real changes.
// Publish parses formulas but never evaluates them (CPU). A sheet has no title of its own (the
// publish call names it), declares no capabilities and takes no assets. content_format "csv" or
// "xlsx" imports a file into JSON lines first (shared import.ts).
import {
  importSheet,
  parseSheet,
  type Sheet,
  type SheetContentFormat,
  SheetImportError,
  serializeSheet,
} from "@plinth/shared";
import { ApiError } from "../../lib/errors.ts";
import type { TypeHooks } from "../artifactTypes.ts";
import { HTML_DOCUMENT_RE } from "./doc.ts";

const SKILL = 'See the plinth-artifacts skill, "Sheets".';
const FORMAT_HINT =
  'content for type sheet is JSON lines: a header line {"plinth":"sheet","v":1,"columns":[...]} ' +
  `then one JSON array per row. To send CSV or an .xlsx file, pass content_format "csv" or "xlsx". ${SKILL}`;

// The last source parsed, and its canonical text once known: validate and canonical run on the
// same text in one publish, and edit_sheet hands over the sheet it has already checked.
let last: { text: string; sheet: Sheet; canonical: string | null } | null = null;

/**
 * A sheet edit_sheet built and checked, as the canonical text it sends to update_artifact: the
 * publish then neither parses nor serializes it again. `text` must be serializeSheet's output for
 * `sheet`, parsed back by parseSheet.
 */
export function rememberCheckedSheet(text: string, sheet: Sheet): void {
  last = { text, sheet, canonical: text };
}

function parsed(text: string): Sheet {
  if (last?.text === text) return last.sheet;
  if (HTML_DOCUMENT_RE.test(text)) {
    throw new ApiError(
      "invalid_input",
      'content for type sheet is JSON lines, not HTML. To publish HTML, use type "html" and the html field.',
      { type: "sheet", field: "content" },
    );
  }
  const r = parseSheet(text);
  if (!r.ok) {
    const firstLine = (text.split("\n", 1)[0] ?? "").trimStart();
    const notJson = r.errors[0]?.line === 1 && !firstLine.startsWith("{");
    throw new ApiError(
      "invalid_input",
      notJson
        ? FORMAT_HINT
        : `This sheet has ${r.count} problem${r.count === 1 ? "" : "s"}; the first ones are listed in details.issues`,
      {
        type: "sheet",
        field: "content",
        issues: r.errors,
        count: r.count,
        next: `Fix each line and cell in issues and send the whole sheet again, or use edit_sheet for cell changes. ${SKILL}`,
      },
    );
  }
  last = { text, sheet: r.sheet, canonical: null };
  return r.sheet;
}

export const sheetHooks: TypeHooks = {
  title: () => null,
  capabilities: () => null,
  validate(_def, text) {
    parsed(text);
  },
  canonical(_def, text) {
    const sheet = parsed(text);
    if (last?.text === text && last.canonical !== null) return last.canonical;
    const canonical = serializeSheet(sheet);
    if (last?.text === text) last.canonical = canonical;
    return canonical;
  },
  importSource(_def, text, format) {
    if (format === "jsonl") return text;
    try {
      return importSheet(text, format as Exclude<SheetContentFormat, "jsonl">);
    } catch (e) {
      if (!(e instanceof SheetImportError)) throw e;
      throw new ApiError(
        "invalid_input",
        `The ${format} file could not be imported: ${e.message}`,
        {
          type: "sheet",
          field: "content",
          content_format: format,
        },
      );
    }
  },
  assetRule: "A sheet has no assets: images and files are not part of a sheet",
};
