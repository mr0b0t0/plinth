// Menu items for a design (type design). "Download PNG or PDF…" opens the export dialog
// (ExportDialog.tsx, a STAGE_DIALOGS entry), only where the instance renders exports on the server
// (design_export: DESIGN_EXPORT with a Browser Rendering binding). Elsewhere a design keeps Print
// or save as PDF.
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { ExportDialog } from "./ExportDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const DESIGN_EXPORT_DIALOG = "design-export";

export const downloadDesign: MenuItem = (c) =>
  c.config?.design_export === true
    ? [
        {
          label: "Download PNG or PDF…",
          icon: DownloadSimpleIcon,
          onSelect: () => c.actions.openDialog(DESIGN_EXPORT_DIALOG),
        },
      ]
    : [];

/** The export dialog, for the version on screen. */
export const designExportDialog: StageDialog = {
  id: DESIGN_EXPORT_DIALOG,
  render: (c, close) => (
    <ExportDialog
      open
      onClose={close}
      artifactRef={c.gate.artifact.id}
      version={c.gate.artifact.version}
    />
  ),
};
