// One describer per artifact type, keyed by the registry's ids, so a new type that does not add
// its describer here does not type-check. Internal to changes/: the package exports only
// describeChanges (index.ts), which picks the describer.
import type { ArtifactType } from "../artifactTypes.ts";
import { describeDesignSystem } from "./designSystem.ts";
import { describeMarkdown } from "./doc.ts";
import { describeDesign, describeHtml } from "./html.ts";
import { describeSheet } from "./sheet.ts";
import { describeSlides } from "./slides.ts";
import type { ChangeCollector } from "./types.ts";
import { describeWhiteboard } from "./whiteboard.ts";

/**
 * Adds the changes from one source text to another to the collector. False when either text is not
 * one this type can read, so nothing can be said in detail.
 */
export type ChangeDescriber = (
  out: ChangeCollector,
  before: string,
  after: string,
) => boolean | undefined;

// biome-ignore format: one type per line, so each type adds its own line
export const CHANGE_DESCRIBERS: { readonly [K in ArtifactType]: ChangeDescriber } = {
  html: (out, a, b) => { describeHtml(out, a, b); return true; },
  doc: (out, a, b) => { describeMarkdown(out, a, b); return true; },
  slides: (out, a, b) => { describeSlides(out, a, b); return true; },
  design_system: describeDesignSystem,
  design: describeDesign,
  sheet: describeSheet,
  whiteboard: describeWhiteboard,
};
