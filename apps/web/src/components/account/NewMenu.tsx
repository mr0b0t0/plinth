// "New" on the dashboard (docs/spec.md "New and Import"): a blank document or sheet that opens
// straight in edit mode, or a sheet imported from a spreadsheet file. HTML pages and designs come
// only from agents, which Connect an agent (the sidebar, the empty state) is the way to.
//
// A blank artifact is the registry's `create` row published as a placeholder v1 ("Created in the
// app") over the ordinary REST publish with the signed-in session, private like every publish;
// the page then opens with `?edit`. Import sends the file as it is and the Worker converts it.
// Blank items are offered only where editing on the page works here (AppConfig.inline_editing);
// Import always, where the instance takes sheets. With neither, there is no New at all. What an
// import left out or changed (warningText) is said in one toast once the sheet is open.
import { FileArrowUpIcon, FileTextIcon, PlusIcon, TableIcon } from "@phosphor-icons/react";
import { API, type AppConfig, type ArtifactType, type PublishResult } from "@plinth/shared";
import { useId, useState } from "react";
import { api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { Button, Dialog, type Icon, Menu, type MenuEntry, useToast } from "../ui/index.ts";
import { hasIssues, ImportIssues } from "./ImportIssues.tsx";
import {
  blankBody,
  blankItems,
  CHOOSE_ANOTHER_LABEL,
  cleanFileName,
  type ImportProblem,
  importedNote,
  importProblem,
  openHref,
  pickSpreadsheetFile,
  readSpreadsheet,
  sheetsAvailable,
  titleFromFileName,
  warningTexts,
} from "./newArtifact.ts";

const TYPE_ICON: Partial<Record<ArtifactType, Icon>> = {
  doc: FileTextIcon,
  sheet: TableIcon,
};

export const IMPORT_LABEL = "Import a spreadsheet…";

/** How long the toast saying what an import left out stays: long enough to read two sentences. */
export const IMPORT_WARNING_TOAST_MS = 12_000;

export interface NewMenuProps {
  config: AppConfig | null;
  /** "primary" in the dashboard's header; "secondary" in the empty state, beside Connect an agent. */
  variant?: "primary" | "secondary";
  /** Extra class on the menu. */
  className?: string;
}

export function NewMenu({ config, variant = "primary", className }: NewMenuProps) {
  const toast = useToast();
  const statusId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<(ImportProblem & { file: string }) | null>(null);
  const blank = blankItems(config);
  const canImport = sheetsAvailable(config);

  /** Publish v1, then open it (in edit mode where that works). Throws what the API refused. */
  const create = async (body: Record<string, unknown>, what: string): Promise<void> => {
    setBusy(`Creating ${what}…`);
    try {
      const r = await api<PublishResult>(API.artifacts, { method: "POST", body });
      navigate(openHref(r.slug, config));
    } finally {
      setBusy(null);
    }
  };

  const choose = () => pickSpreadsheetFile((file) => void onFile(file));

  const newBlank = (item: (typeof blank)[number]) => {
    if (busy) return;
    create(blankBody(item), item.create.title).catch((e: unknown) => {
      toast.error(
        `Could not create the ${item.create.label.toLowerCase()}`,
        importProblem(e).message,
      );
    });
  };

  const onFile = async (file: File) => {
    if (busy) return;
    setProblem(null);
    const name = cleanFileName(file.name);
    setBusy(`Reading ${name}…`);
    try {
      const { sent, warnings } = await readSpreadsheet(file);
      await create(
        { title: titleFromFileName(file.name), type: "sheet", ...sent, note: importedNote(name) },
        name,
      );
      if (warnings.length > 0) {
        toast.toast({
          title: `Imported ${name}`,
          description: warningTexts(warnings).join(" "),
          tone: "warning",
          duration: IMPORT_WARNING_TOAST_MS,
        });
      }
    } catch (e) {
      setBusy(null);
      setProblem({ ...importProblem(e), file: name });
    }
  };

  const items: MenuEntry[] = [
    ...blank.map(
      (item): MenuEntry => ({
        label: item.create.label,
        icon: TYPE_ICON[item.type],
        disabled: busy !== null,
        onSelect: () => newBlank(item),
      }),
    ),
    ...(blank.length && canImport ? [{ type: "separator" as const }] : []),
    ...(canImport
      ? [
          {
            label: IMPORT_LABEL,
            icon: FileArrowUpIcon,
            disabled: busy !== null,
            // Called inside the click, so the browser lets the file picker open.
            onSelect: choose,
          },
        ]
      : []),
  ];
  // Nothing to offer here (no blank type, no sheets): no New, rather than an empty menu.
  if (items.length === 0) return null;

  return (
    <>
      <Menu
        label="New"
        icon={PlusIcon}
        variant={variant}
        align="end"
        className={`pl-dash-new${className ? ` ${className}` : ""}`}
        triggerContent={<span className="pl-dash-new__label">New</span>}
        items={items}
      />
      <span id={statusId} className="visually-hidden" role="status">
        {busy ?? ""}
      </span>
      <Dialog
        open={problem !== null}
        onClose={() => setProblem(null)}
        role="alertdialog"
        title={problem ? `Could not import ${problem.file}` : "Could not import the file"}
        description={problem?.message}
        footer={
          <>
            <Button variant="ghost" onClick={() => setProblem(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={FileArrowUpIcon}
              onClick={() => {
                // Inside the click, so the file picker may open.
                choose();
                setProblem(null);
              }}
            >
              {CHOOSE_ANOTHER_LABEL}
            </Button>
          </>
        }
      >
        {problem && hasIssues(problem) && <ImportIssues problem={problem} />}
      </Dialog>
    </>
  );
}
