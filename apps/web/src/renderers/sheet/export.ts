// Downloads, built inside the frame: CSV (toCsv in @plinth/shared) or .xlsx (xlsx.ts), handed to
// the browser from a blob: URL by a temporary <a download>. Nothing is fetched and no data leaves
// the frame except as the file the viewer saves; both frame sandboxes allow downloads.
import { type Sheet, type SheetEvaluation, toCsv } from "@plinth/shared";
import type { SheetExportFormat } from "./protocol.ts";
import { buildXlsx } from "./xlsx.ts";

const MIME: Record<SheetExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The download's name: the title without \ / : * ? " < > |, control or format characters. */
export function fileName(title: string, format: SheetExportFormat): string {
  const base = title
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
  return `${base || "sheet"}.${format}`;
}

/** The file's bytes. */
export function exportBytes(
  sheet: Sheet,
  ev: SheetEvaluation,
  title: string,
  format: SheetExportFormat,
): Uint8Array | string {
  return format === "csv" ? toCsv(sheet, ev) : buildXlsx(sheet, ev, title);
}

/** Build the file and start its download. */
export function exportSheet(
  win: Window,
  sheet: Sheet,
  ev: SheetEvaluation,
  title: string,
  format: SheetExportFormat,
): void {
  const doc = win.document;
  const bytes = exportBytes(sheet, ev, title, format);
  const blob = new Blob([bytes as BlobPart], { type: MIME[format] });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = fileName(title, format);
  a.hidden = true;
  doc.body.append(a);
  a.click();
  a.remove();
  win.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
