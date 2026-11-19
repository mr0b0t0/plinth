// Plain-language change lists: what changed between two versions of an artifact, said the way a
// person sees it, never as source. The History's Compare page shows one above the two rendered
// versions; the describers are pure and zod-free, so a renderer or the room can use them too.
//
// One describer per artifact type, keyed by the registry's ids, so a new type that does not add
// its describer here does not type-check. File changes are listed apart, by fileChanges (files.ts).
import type { ArtifactType } from "../artifactTypes.ts";
import { describeDesignSystem } from "./designSystem.ts";
import { describeMarkdown } from "./doc.ts";
import { describeDesign, describeHtml } from "./html.ts";
import { describeSheet } from "./sheet.ts";
import { describeSlides } from "./slides.ts";
import { ChangeCollector, type ChangeList } from "./types.ts";
import { describeWhiteboard } from "./whiteboard.ts";

export * from "./diff.ts";
export * from "./files.ts";
export { type HtmlScan, type HtmlTextRun, scanHtml } from "./htmlScan.ts";
export { type MdBlock, type MdBlockKind, markdownBlocks } from "./markdownText.ts";
export { changeExcerpt } from "./text.ts";
export * from "./types.ts";

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
  whiteboard: (out, a, b) => { describeWhiteboard(out, a, b); return true; },
};

/** Said when a version cannot be read in detail (it fails the type's checks). */
export const CHANGES_UNREADABLE =
  "The content changed. One of the two versions cannot be read in detail, so its changes are not listed";
/** Said when the texts differ in nothing a person sees (spacing, key order, line endings). */
export const CHANGES_INVISIBLE = "Nothing visible changed, only how the content is stored";

/**
 * What changed from `before` to `after`, two source texts of one artifact `type`, in plain
 * language: at most CHANGE_LIMITS.maxItems items, in the order a person meets them. Never throws.
 */
export function describeChanges(type: ArtifactType, before: string, after: string): ChangeList {
  const out = new ChangeCollector();
  if (before === after) return out.list();
  let readable: boolean | undefined;
  try {
    const describe: ChangeDescriber = Object.hasOwn(CHANGE_DESCRIBERS, type)
      ? CHANGE_DESCRIBERS[type]
      : CHANGE_DESCRIBERS.html;
    readable = describe(out, before, after);
  } catch {
    readable = false;
  }
  if (readable === false) {
    return { items: [{ kind: "changed", where: "", what: CHANGES_UNREADABLE }], truncated: false };
  }
  if (out.items.length === 0) out.add({ kind: "changed", where: "", what: CHANGES_INVISIBLE });
  return out.list();
}
