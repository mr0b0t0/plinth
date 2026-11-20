// New and Import (docs/spec.md "New and Import"), the parts both the dashboard's New menu and a
// sheet's "Replace with a file…" share. Pure helpers, so the components and their tests agree.
//
// - New publishes a registry `create` row (artifactTypes.ts) as a placeholder v1 with the note
//   "Created in the app", then opens the page in edit mode (`?edit`). It is offered only where the
//   page can be edited (AppConfig.inline_editing not null) and the type is available here.
// - Import and Replace send the file as it is: CSV and TSV as text, an .xlsx as base64, with
//   `content_format`. The Worker converts and checks it as it does for agents, so the app carries
//   no spreadsheet reader of its own, and a refusal names cells ("B7: …"), never code.
import {
  APP_ROUTES,
  type AppConfig,
  type ArtifactType,
  type CreateRow,
  creatableTypes,
  LIMITS,
  route,
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

/**
 * A picked file as `content_format` and `content` for the Worker: CSV and TSV as text (the
 * Worker finds the delimiter), an .xlsx as base64. Throws SpreadsheetFileError.
 */
export async function readSpreadsheet(
  file: File,
): Promise<{ content_format: SpreadsheetFormat; content: string }> {
  const format = formatOf(file.name);
  if (!format) throw new SpreadsheetFileError("Pick a .xlsx, .csv or .tsv file.");
  if (file.size > LIMITS.maxSheetImportBytes) {
    throw new SpreadsheetFileError(
      `${file.name} is larger than ${Math.round(LIMITS.maxSheetImportBytes / MB)} MB, the most a spreadsheet import takes.`,
    );
  }
  if (file.size === 0) throw new SpreadsheetFileError(`${file.name} is empty.`);
  if (format === "csv") return { content_format: "csv", content: await file.text() };
  return { content_format: "xlsx", content: base64Of(new Uint8Array(await file.arrayBuffer())) };
}

/** Base64 of bytes, in chunks (a 2 MB file would overflow String.fromCharCode's arguments). */
export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

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
