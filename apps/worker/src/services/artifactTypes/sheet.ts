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

const HTML_DOCUMENT_RE = /^\s*(<!doctype html|<html[\s>])/i;
const SKILL = 'See the plinth-artifacts skill, "Sheets".';
const FORMAT_HINT =
  'content for type sheet is JSON lines: a header line {"plinth":"sheet","v":1,"columns":[...]} ' +
  `then one JSON array per row. To send CSV or an .xlsx file, pass content_format "csv" or "xlsx". ${SKILL}`;

// The last source parsed: validate and canonical run on the same text in one publish.
let last: { text: string; sheet: Sheet } | null = null;

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
  last = { text, sheet: r.sheet };
  return r.sheet;
}

export const sheetHooks: TypeHooks = {
  title: () => null,
  capabilities: () => null,
  validate(_def, text) {
    parsed(text);
  },
  canonical(_def, text) {
    return serializeSheet(parsed(text));
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
