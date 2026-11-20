// A sheet's ⋯ menu item, "Replace with a file…", and the dialog it opens (ReplaceSheetDialog).
// Owners and editors only, on the current version: they are the roles that may publish a version,
// which the API checks again on the save. The item sits next to Edit source and opens the file
// picker straight away; the dialog only confirms the chosen file. While the sheet has unpublished
// page changes or someone is editing it on the page, the item is hidden; the dialog checks the same
// again when Replace is pressed. A draft someone starts after that press meets the room's review of
// a version published meanwhile, as for an agent's version. A person confirmed by code without an
// account may not publish a version: the item opens the dialog's sign-in step, with no picker.
import { FileArrowUpIcon } from "@phosphor-icons/react";
import { currentSession } from "../../lib/session.ts";
import { pickSpreadsheetFile } from "../account/newArtifact.ts";
import { noticeKind } from "./LiveDraftNotice.tsx";
import { ReplaceSheetDialog } from "./ReplaceSheetDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageContext, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const REPLACE_SHEET_DIALOG = "replace-sheet";

export const REPLACE_LABEL = "Replace with a file…";
/** What the dialog says when a draft appeared after the item was chosen. */
export const REPLACE_BLOCKED = "Publish or discard changes first";

// The file the picker gave, held from the item's click until the dialog it opens closes. The
// stage opens a dialog by id only, and one dialog is open at a time.
let picked: File | null = null;

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
  if (artifact.type !== "sheet") return [];
  if (role !== "owner" && role !== "editor") return [];
  if (artifact.version !== artifact.current_version) return [];
  // Hidden while it cannot be used, rather than shown off with a reason.
  if (replaceBlocked(c)) return [];
  return [
    {
      label: REPLACE_LABEL,
      icon: FileArrowUpIcon,
      onSelect: () => {
        const session = currentSession();
        if (c.gate.live?.sign_in || (!session.loading && session.me === null)) {
          // No account: the dialog says to sign in, with no picker first.
          picked = null;
          c.actions.openDialog(REPLACE_SHEET_DIALOG);
          return;
        }
        // Inside the click, so the browser lets the picker open.
        pickSpreadsheetFile((file) => {
          picked = file;
          c.actions.openDialog(REPLACE_SHEET_DIALOG);
        });
      },
    },
  ];
};

export const replaceSheetDialog: StageDialog = {
  id: REPLACE_SHEET_DIALOG,
  render: (c, close) => {
    const done = () => {
      picked = null;
      close();
    };
    return (
      <ReplaceSheetDialog
        artifactId={c.gate.artifact.id}
        version={c.gate.artifact.version}
        file={picked}
        blocked={replaceBlocked(c) ? REPLACE_BLOCKED : null}
        signInHref={c.hrefs.signIn}
        mustSignIn={c.gate.live?.sign_in === true}
        onClose={done}
        onReplaced={() => {
          done();
          // The frame reloads on the new version; other open pages follow it on their own.
          c.actions.reload();
        }}
      />
    );
  },
};
