// New and Import (docs/spec.md "New and Import"), the parts both the dashboard's New menu and a
// sheet's "Replace with a file…" share. Pure helpers, so the components and their tests agree.
//
// - New publishes a registry `create` row (artifactTypes.ts) as a placeholder v1 with the note
//   "Created in the app", then opens the page in edit mode (`?edit`). It is offered only where the
//   page can be edited (AppConfig.inline_editing not null) and the type is available here.
// - Import and Replace send the file as it is: CSV and TSV as text, an .xlsx as base64, with
//   `content_format`. The Worker converts and checks it as it does for agents, and a refusal names
//   cells ("B7: …"), never code. A CSV is read as UTF-8, or as Windows-1252 when it is not.
// - What the import would leave out or change (other sheets, formulas kept as values, long column
//   names, a CSV that is not UTF-8) is found in the app before the file is sent, by the shared
//   importer the Worker runs (importCheck.ts, loaded on demand), and said in
//   plain words: in Replace's confirmation, in Import's toast. The Worker's answer stays the one
//   that counts: a file the check cannot read is sent anyway, and the Worker says why it refuses it.
import {
  APP_ROUTES,
  type AppConfig,
  type ArtifactType,
  type CreateRow,
  creatableTypes,
  LIMITS,
  route,
  type SheetImportWarning,
} from "@plinth/shared";
import { ApiRequestError } from "../../lib/api.ts";

/** v1's note for a blank artifact made with New. */
export const CREATED_NOTE = "Created in the app";

/** The file input's accept list for Import and Replace. */
export const SPREADSHEET_ACCEPT =
  ".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface BlankItem {
  type: ArtifactType;
  create: CreateRow;
}

/**
 * The blank artifacts New offers here, in registry order: none while editing on the page is off
 * (ALLOW_LIVE_EDITING=false, or opaque isolation), and only types this instance publishes now.
 */
export function blankItems(config: AppConfig | null | undefined): BlankItem[] {
  if (!config?.inline_editing) return [];
  const available = (t: ArtifactType) =>
    config.artifact_types?.find((a) => a.id === t)?.available ?? true;
  return creatableTypes()
    .filter((d) => available(d.id))
    .map((d) => ({ type: d.id, create: d.create }));
}

/** Whether this instance takes new sheets (Import), whatever its inline editing. */
export function sheetsAvailable(config: AppConfig | null | undefined): boolean {
  return config?.artifact_types?.find((a) => a.id === "sheet")?.available ?? true;
}

/**
 * Where a new artifact opens: in edit mode when the page can be edited here, else on its page.
 * `?edit` with `live` starts editing with the focus on its first block or cell.
 */
export function openHref(slug: string, config: AppConfig | null | undefined): string {
  const page = route(APP_ROUTES.artifact, { slug });
  return config?.inline_editing ? `${page}?edit` : page;
}

/** The body that publishes a blank artifact from its create row. */
export function blankBody(item: BlankItem): {
  title: string;
  type: ArtifactType;
  content: string;
  note: string;
} {
  return {
    title: item.create.title,
    type: item.type,
    content: item.create.content,
    note: CREATED_NOTE,
  };
}

export type SpreadsheetFormat = "csv" | "xlsx";

/** The data attribute of the short-lived input pickSpreadsheetFile opens. */
export const PICKER_ATTR = "data-plinth-spreadsheet-picker";

/**
 * Open the browser's file picker for a spreadsheet, straight from a menu item: a hidden input
 * added to the page for this one pick, clicked inside the person's click (so the browser lets it
 * open), and removed once a file is chosen or the picker is cancelled. Nothing happens on cancel.
 */
export function pickSpreadsheetFile(onPick: (file: File) => void): void {
  for (const old of document.querySelectorAll(`input[${PICKER_ATTR}]`)) old.remove();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = SPREADSHEET_ACCEPT;
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.setAttribute(PICKER_ATTR, "");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onPick(file);
  });
  input.addEventListener("cancel", () => input.remove());
  document.body.append(input);
  input.click();
}

// C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates (U+061C, U+200E/F,
// U+202A to U+202E, U+2066 to U+2069), which could make a name read as something else.
const UNSAFE_NAME_CHARS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;

/**
 * A picked file's name as the app shows it and writes it in a version note ("Imported from …",
 * "Replaced from …"): without control and bidi characters, never empty.
 */
export function cleanFileName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARS, "").trim() || "the file";
}

/** v1's note for a sheet imported from a file. */
export const importedNote = (file: string) => `Imported from ${cleanFileName(file)}`;

/** The format a file name says, or null for a file Import does not take. */
export function formatOf(name: string): SpreadsheetFormat | null {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx")) return "xlsx";
  if (n.endsWith(".csv") || n.endsWith(".tsv")) return "csv";
  return null;
}

/** A new sheet's title from its file: the name without its extension, tidied, never empty. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]*$/, "");
  const clean = base
    .replace(/[_]+/g, " ")
    // Control and format characters never reach a title.
    .replace(/[\p{Cc}\p{Cf}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...clean].slice(0, LIMITS.maxTitleLength).join("").trim();
  return cut || "Imported sheet";
}

/** Why a picked file cannot be sent, in words for the person. */
export class SpreadsheetFileError extends Error {}

const MB = 1024 * 1024;

/** What a picked file sends: `content_format` and `content`, as the Worker takes them. */
export interface SpreadsheetBody {
  content_format: SpreadsheetFormat;
  content: string;
}

/** A picked file, read: what it sends, and what the import would leave out or change. */
export interface ReadSpreadsheet {
  sent: SpreadsheetBody;
  warnings: SheetImportWarning[];
}

// Windows-1252's 0x80 to 0x9F (WHATWG Encoding); every other byte is the code point it names. Kept
// here rather than left to TextDecoder("windows-1252"), which some runtimes read as Latin-1.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/** Bytes as Windows-1252 text (every byte reads as one character). */
export function decodeCp1252(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    units[i] = b >= 0x80 && b < 0xa0 ? (CP1252_HIGH[b - 0x80] as number) : b;
  }
  let text = "";
  for (let i = 0; i < units.length; i += 0x8000) {
    text += String.fromCharCode(...units.subarray(i, i + 0x8000));
  }
  return text;
}

/**
 * A CSV or TSV file's text: UTF-8 (its BOM dropped, as File.text() does), UTF-16 when it starts
 * with that BOM, and otherwise, when the bytes are not UTF-8, Windows-1252, the encoding Excel
 * writes a "CSV" in on Windows, with the warning `not_utf8`. Windows-1252 reads every byte, so a
 * file is never refused for its encoding.
 */
export function decodeCsv(bytes: Uint8Array): { text: string; warnings: SheetImportWarning[] } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes), warnings: [] };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes), warnings: [] };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), warnings: [] };
  } catch {
    return {
      text: decodeCp1252(bytes),
      warnings: [{ code: "not_utf8", encoding: "windows-1252" }],
    };
  }
}

/**
 * What the shared importer says the import of this file would leave out or change, or nothing
 * when it cannot tell (the check failed to load, or the file is one the Worker will refuse and
 * explain). Loaded on demand, so a sheet's page loads the importer only once a file is picked.
 */
async function importWarnings(
  content: string | Uint8Array,
  format: SpreadsheetFormat,
): Promise<SheetImportWarning[]> {
  try {
    const { sheetImportWarnings } = await import("./importCheck.ts");
    return sheetImportWarnings(content, format);
  } catch {
    return [];
  }
}

/**
 * A picked file as `content_format` and `content` for the Worker: CSV and TSV as text (the
 * Worker finds the delimiter), an .xlsx as base64, with the import's warnings. Throws
 * SpreadsheetFileError.
 */
export async function readSpreadsheet(file: File): Promise<ReadSpreadsheet> {
  const format = formatOf(file.name);
  const name = cleanFileName(file.name);
  if (!format) throw new SpreadsheetFileError("Pick a .xlsx, .csv or .tsv file.");
  if (file.size > LIMITS.maxSheetImportBytes) {
    throw new SpreadsheetFileError(
      `${name} is larger than ${Math.round(LIMITS.maxSheetImportBytes / MB)} MB, the most a spreadsheet import takes.`,
    );
  }
  if (file.size === 0) throw new SpreadsheetFileError(`${name} is empty.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (format === "csv") {
    const { text, warnings } = decodeCsv(bytes);
    return {
      sent: { content_format: "csv", content: text },
      warnings: [...warnings, ...(await importWarnings(text, "csv"))],
    };
  }
  return {
    sent: { content_format: "xlsx", content: base64Of(bytes) },
    warnings: await importWarnings(bytes, "xlsx"),
  };
}

/** Sheet names a warning quotes, at most; the rest are counted ("and 4 more"). */
const NAMES_SHOWN = 3;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "“Q3”", "“Q3” and “Notes”", "“A”, “B”, “C” and 4 more". */
function quotedList(names: string[], total: number): string {
  const shown = names.slice(0, NAMES_SHOWN).map((n) => `“${n}”`);
  const more = total - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length === 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * One import warning in plain words, the same before the file is sent (Replace's confirmation)
 * and after (Import's toast).
 */
export function warningText(w: SheetImportWarning): string {
  switch (w.code) {
    case "not_utf8":
      return "The file is not UTF-8, so it is read as Windows-1252. Check accented letters.";
    case "other_sheets": {
      const names = w.names.filter((n) => n !== "");
      if (names.length === 0) {
        return `Only the first sheet is used; ${w.count} other ${plural(w.count, "sheet is", "sheets are")} left out.`;
      }
      return `Only the first sheet is used; ${quotedList(names, w.count)} ${w.count === 1 ? "is" : "are"} left out.`;
    }
    case "formulas_as_values":
      return w.count === 1
        ? "1 formula becomes a plain value."
        : `${w.count} formulas become plain values.`;
    case "headers_truncated":
      return `${w.count} column ${plural(w.count, "name is", "names are")} cut to ${w.max} characters.`;
  }
}

/** Every warning in plain words, in the order the import gave them. */
export const warningTexts = (warnings: readonly SheetImportWarning[]): string[] =>
  warnings.map(warningText);

/** Base64 of bytes, in chunks (a 2 MB file would overflow String.fromCharCode's arguments). */
export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The primary button of a refused file's dialog, on the dashboard and on a sheet's page alike. */
export const CHOOSE_ANOTHER_LABEL = "Choose another file…";

/** A refusal as the person reads it: the server's sentence, and the cells it names. */
export interface ImportProblem {
  message: string;
  /** "B7: …" lines from details.issues, at most 20. */
  issues: string[];
  /** How many problems there were in all (details.count), when more than listed. */
  count: number;
}

export function importProblem(e: unknown): ImportProblem {
  if (e instanceof SpreadsheetFileError) return { message: e.message, issues: [], count: 0 };
  if (!(e instanceof ApiRequestError)) {
    return {
      message: "Could not reach Plinth. Check your connection and try again.",
      issues: [],
      count: 0,
    };
  }
  const d = (e.details ?? {}) as { issues?: unknown; count?: unknown };
  const issues = Array.isArray(d.issues)
    ? d.issues
        .map((i) =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as { message?: unknown }).message === "string"
            ? (i as { message: string }).message
            : null,
        )
        .filter((m): m is string => m !== null)
        .slice(0, 20)
    : [];
  const count = typeof d.count === "number" ? d.count : issues.length;
  return { message: plainCause(e.message), issues, count };
}

/**
 * The Worker's refusal as a plain cause: without its "The xlsx file could not be imported:" lead
 * (the dialog's title already says so) and without a closing parenthetical, which names parser
 * internals ("(no ZIP directory)"), ending as a sentence. Other messages pass as they are.
 * Agents still get the whole sentence from the API.
 */
export function plainCause(message: string): string {
  const cause = message
    .replace(/^The \w+ file could not be imported:\s*/i, "")
    .replace(/\s*\([^()]*\)\s*\.?\s*$/, "")
    .trim();
  if (!cause || cause === message) return message;
  const first = (cause[0] ?? "").toUpperCase() + cause.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
