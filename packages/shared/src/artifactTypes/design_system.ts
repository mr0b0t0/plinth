// The design_system type: design tokens, a dark theme, guidelines and components in one JSON file
// (system.json, format plinth.design-system/1; designSystem.ts) plus image and font assets, shown
// by Plinth's design system renderer (apps/web/src/renderers/design_system/) as a reference site.
// Agents read it with get_design_system and copy its CSS into the pages they build.
import type { TypeModule } from "../artifactTypes.ts";
import { LIMITS } from "../constants.ts";

export const designSystem: TypeModule<"design_system"> = {
  id: "design_system",
  label: "Design system",
  badge: "Design system",
  sourcePath: "system.json",
  sourceField: "content",
  sourceLabel: "design system JSON",
  contentType: "application/json; charset=utf-8",
  maxSourceBytes: LIMITS.maxDesignSystemBytes,
  reservedPaths: ["index.html", "system.json"],
  assetTypes: /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/(woff2|woff|ttf|otf))$/,
  renderer: { script: "ds.js", style: "ds.css" },
  editor: { language: "json", wordWrap: "off" },
  liveEdit: false,
};
