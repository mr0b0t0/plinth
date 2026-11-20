// A whiteboard's ⋯ menu item for an editor, "Settings", and the dialog it opens
// (BoardSettingsDialog). The owner's menu already has Settings (the settings page, whose Board
// section holds the same two choices), so the menu never shows two settings items. A commenter or
// viewer gets nothing: only owners and editors may publish a version, which the API checks again
// on the save.
import { GearSixIcon } from "@phosphor-icons/react";
import { BoardSettingsDialog } from "./BoardSettingsDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const BOARD_SETTINGS_DIALOG = "board-settings";

export const boardSettings: MenuItem = (c) =>
  c.gate.role === "editor"
    ? [
        {
          label: "Settings",
          icon: GearSixIcon,
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
      // A newer version refused the save: show it behind the dialog, which now holds its settings.
      onNewer={() => c.actions.reload()}
    />
  ),
};
