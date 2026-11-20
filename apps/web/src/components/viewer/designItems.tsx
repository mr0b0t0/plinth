// Menu items for a design (type design), where the instance renders exports on the server
// (design_export: DESIGN_EXPORT with a Browser Rendering binding): "Download .png" opens the
// board picker (ExportDialog.tsx, a STAGE_DIALOGS entry) and "Download .pdf" downloads every board,
// labelled like a deck's Download .pptx. They replace Print or save as PDF, so the menu has one way
// to a PDF; Ctrl or Cmd+P in the frame still prints. Elsewhere a design keeps Print.
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { downloadDesignPdf, ExportDialog } from "./ExportDialog.tsx";
// Types only: stageItems.tsx imports this file, so a value import back would be a cycle.
import type { MenuItem, StageContext, StageDialog } from "./stageItems.tsx";

/** The dialog's id in STAGE_DIALOGS. */
export const DESIGN_EXPORT_DIALOG = "design-export";

const exports = (c: StageContext) => c.config?.design_export === true;

/** A design's Print item, only where the server does not export it. */
export const unlessExports =
  (print: MenuItem): MenuItem =>
  (c) =>
    exports(c) ? [] : print(c);

export const downloadDesign: MenuItem = (c) =>
  exports(c)
    ? [
        {
          label: "Download .png",
          icon: DownloadSimpleIcon,
          onSelect: () => c.actions.openDialog(DESIGN_EXPORT_DIALOG),
        },
        {
          label: "Download .pdf",
          icon: DownloadSimpleIcon,
          onSelect: () => void downloadDesignPdf(c.gate.artifact.id, c.gate.artifact.version),
        },
      ]
    : [];

/** The board picker for a PNG, for the version on screen. */
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
