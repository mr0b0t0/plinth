// "New" on the dashboard (docs/spec.md "New and Import"): a blank document or sheet that opens
// straight in edit mode, or a sheet imported from a spreadsheet file. HTML pages and designs come
// only from agents, which the menu says, with a link to connect one.
//
// A blank artifact is the registry's `create` row published as a placeholder v1 ("Created in the
// app") over the ordinary REST publish with the signed-in session, private like every publish;
// the page then opens with `?edit`. Import sends the file as it is and the Worker converts it.
// Blank items are offered only where editing on the page works here (AppConfig.inline_editing);
// Import always, where the instance takes sheets.
import {
  FileArrowUpIcon,
  FileTextIcon,
  PlugIcon,
  PlusIcon,
  TableIcon,
} from "@phosphor-icons/react";
import { API, type AppConfig, type ArtifactType, type PublishResult } from "@plinth/shared";
import { useId, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { Button, Dialog, type Icon, Menu, type MenuEntry, useToast } from "../ui/index.ts";
import { CONNECT_AGENT_HREF } from "./nav.ts";
import {
  blankBody,
  blankItems,
  type ImportProblem,
  importProblem,
  openHref,
  readSpreadsheet,
  SPREADSHEET_ACCEPT,
  SPREADSHEET_KINDS,
  sheetsAvailable,
  titleFromFileName,
} from "./newArtifact.ts";

const TYPE_ICON: Partial<Record<ArtifactType, Icon>> = {
  doc: FileTextIcon,
  sheet: TableIcon,
};

export const IMPORT_LABEL = `Import a spreadsheet (${SPREADSHEET_KINDS})…`;
export const AGENTS_NOTE = "Pages and designs are made by your agents.";

export interface NewMenuProps {
  config: AppConfig | null;
  /** "primary" in the dashboard's header; "secondary" in the empty state, beside Connect an agent. */
  variant?: "primary" | "secondary";
  /** Extra class on the menu. */
  className?: string;
}

/** What the empty state adds under "Connect an agent…", from what New offers here. */
export function newHint(config: AppConfig | null): string | null {
  if (blankItems(config).length > 0) {
    return "Or start a document or a sheet yourself with New, or import a spreadsheet.";
  }
  return sheetsAvailable(config) ? "Or import a spreadsheet with New." : null;
}

export function NewMenu({ config, variant = "primary", className }: NewMenuProps) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
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
    try {
      const sent = await readSpreadsheet(file);
      await create(
        {
          title: titleFromFileName(file.name),
          type: "sheet",
          ...sent,
          note: `Imported from ${file.name}`,
        },
        file.name,
      );
    } catch (e) {
      setProblem({ ...importProblem(e), file: file.name });
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
            onSelect: () => input.current?.click(),
          },
        ]
      : []),
    { type: "separator" },
    {
      label: "Connect an agent",
      icon: PlugIcon,
      href: CONNECT_AGENT_HREF,
      description: AGENTS_NOTE,
    },
  ];

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
      <input
        ref={input}
        type="file"
        accept={SPREADSHEET_ACCEPT}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="new-import-file"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void onFile(file);
        }}
      />
      <span id={statusId} className="visually-hidden" role="status">
        {busy ?? ""}
      </span>
      <Dialog
        open={problem !== null}
        onClose={() => setProblem(null)}
        role="alertdialog"
        title="This file could not be imported"
        description={problem ? `${problem.file}: ${problem.message}` : undefined}
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
                input.current?.click();
                setProblem(null);
              }}
            >
              Choose another file
            </Button>
          </>
        }
      >
        {problem && problem.issues.length > 0 && (
          <>
            <ul className="pl-import-issues">
              {problem.issues.map((m, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two issues may read the same
                <li key={i}>{m}</li>
              ))}
            </ul>
            {problem.count > problem.issues.length && (
              <p className="text-muted">{`and ${problem.count - problem.issues.length} more`}</p>
            )}
          </>
        )}
      </Dialog>
    </>
  );
}
