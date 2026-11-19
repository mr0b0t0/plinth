// Menu items for a design (type design). "Download PNG or PDF…" opens the export dialog
// (ExportDialog.tsx), only where the instance renders exports on the server (design_export:
// DESIGN_EXPORT with a Browser Rendering binding). Elsewhere a design keeps Print or save as PDF.
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import type { MenuItem } from "./stageItems.tsx";

export const downloadDesign: MenuItem = (c) =>
  c.config?.design_export === true
    ? [{ label: "Download PNG or PDF…", icon: DownloadSimpleIcon, onSelect: c.actions.openExport }]
    : [];
