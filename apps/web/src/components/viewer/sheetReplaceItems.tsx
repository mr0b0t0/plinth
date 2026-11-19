// A sheet's ⋯ menu item, "Replace with a file…", and the dialog it opens (ReplaceSheetDialog).
// Owners and editors only, on the current version: they are the roles that may publish a version,
// which the API checks again on the save. While the sheet has unpublished page changes or someone
// is editing it on the page, the item is off with its reason, so a replacement never races a
// shared draft; Publish or discard those changes first.
import { FileArrowUpIcon } from "@phosphor-icons/react";
import { noticeKind } from "./LiveDraftNotice.tsx";
import { ReplaceSheetDialog } from "./ReplaceSheetDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageContext, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const REPLACE_SHEET_DIALOG = "replace-sheet";

export const REPLACE_LABEL = "Replace with a file…";
export const REPLACE_BLOCKED = "Publish or discard the unpublished changes first";

/** Unpublished page changes exist, or someone is on the page editing it, or this person is. */
export function replaceBlocked(c: StageContext): boolean {
  if (c.editing) return true;
  const status = c.live.status;
  if ((status?.editors.length ?? 0) > 0) return true;
  return (
    noticeKind({ draft: c.gate.live?.draft ?? null, status, restore: c.live.restore }) !== null
  );
}

export const replaceSheet: MenuItem = (c) => {
  const { role, artifact } = c.gate;
  if (role !== "owner" && role !== "editor") return [];
  if (artifact.version !== artifact.current_version) return [];
  const blocked = replaceBlocked(c);
  return [
    {
      label: REPLACE_LABEL,
      icon: FileArrowUpIcon,
      disabled: blocked,
      ...(blocked ? { description: REPLACE_BLOCKED } : {}),
      onSelect: () => c.actions.openDialog(REPLACE_SHEET_DIALOG),
    },
  ];
};

export const replaceSheetDialog: StageDialog = {
  id: REPLACE_SHEET_DIALOG,
  render: (c, close) => (
    <ReplaceSheetDialog
      artifactId={c.gate.artifact.id}
      version={c.gate.artifact.version}
      onClose={close}
      onReplaced={() => {
        close();
        // The frame reloads on the new version; other open pages follow it on their own.
        c.actions.reload();
      }}
    />
  ),
};
