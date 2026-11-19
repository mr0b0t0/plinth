// A whiteboard's ⋯ menu item, "Board settings", and the dialog it opens (BoardSettingsDialog).
// Owners and editors only: they are the roles that may publish a version, which the API checks
// again on the save.
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { BoardSettingsDialog } from "./BoardSettingsDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const BOARD_SETTINGS_DIALOG = "board-settings";

export const boardSettings: MenuItem = (c) =>
  c.gate.role === "owner" || c.gate.role === "editor"
    ? [
        {
          label: "Board settings",
          icon: SlidersHorizontalIcon,
          onSelect: () => c.actions.openDialog(BOARD_SETTINGS_DIALOG),
        },
      ]
    : [];

export const boardSettingsDialog: StageDialog = {
  id: BOARD_SETTINGS_DIALOG,
  render: (c, close) => (
    <BoardSettingsDialog
      artifactId={c.gate.artifact.id}
      onClose={close}
      onSaved={() => {
        close();
        // Show the new version now; other open pages follow it on their own.
        c.actions.reload();
      }}
    />
  ),
};
