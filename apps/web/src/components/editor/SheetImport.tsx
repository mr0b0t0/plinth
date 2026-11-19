// "Import CSV or .xlsx" in a sheet's source editor: the person picks a file, the browser turns it
// into the sheet's JSON lines with the same converter the Worker uses for content_format (the
// first row names the columns, types are inferred, CSV never makes a formula, an .xlsx keeps only
// formulas sheets support), and the result replaces the draft. Nothing is sent until the person
// saves, which publishes a new version as any edit does. The file never leaves this page.
import { FileArrowUpIcon } from "@phosphor-icons/react";
import {
  LIMITS,
  SheetImportError,
  serializeSheet,
  sheetFromCsv,
  sheetFromXlsx,
} from "@plinth/shared";
import { useRef } from "react";
import { Button, useToast } from "../ui/index.ts";

/** The draft text a picked file becomes. Throws SheetImportError. */
export async function importFile(file: File): Promise<string> {
  if (file.size > LIMITS.maxSheetImportBytes) {
    throw new SheetImportError(
      `A file to import is at most ${Math.round(LIMITS.maxSheetImportBytes / (1024 * 1024))} MB`,
    );
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    return serializeSheet(sheetFromXlsx(new Uint8Array(await file.arrayBuffer())));
  }
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) {
    return serializeSheet(sheetFromCsv(await file.text()));
  }
  throw new SheetImportError("Pick a .csv or .xlsx file");
}

export function SheetImport({ onImport }: { onImport: (text: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".csv,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          importFile(file).then(
            (text) => {
              onImport(text);
              toast.success("Imported", `${file.name} replaced the draft. Save to publish it.`);
            },
            (err: unknown) => {
              toast.error(
                "The file could not be imported",
                err instanceof SheetImportError
                  ? err.message
                  : "It is not a CSV or .xlsx file this page can read.",
              );
            },
          );
        }}
      />
      <Button variant="ghost" icon={FileArrowUpIcon} onClick={() => input.current?.click()}>
        Import CSV or .xlsx
      </Button>
    </>
  );
}
