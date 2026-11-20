// Plain-language change lists: what changed between two versions of an artifact, said the way a
// person sees it, never as source. The History's Compare page shows one above the two rendered
// versions; the describers are pure and zod-free, so a renderer or the room can use them too.
//
// File changes are listed apart, by fileChanges (files.ts).
import type { ArtifactType } from "../artifactTypes.ts";
import { CHANGE_DESCRIBERS, type ChangeDescriber } from "./describers.ts";
import { ChangeCollector, type ChangeList } from "./types.ts";

export * from "./align.ts";
export type { ChangeDescriber } from "./describers.ts";
export * from "./diff.ts";
export * from "./files.ts";
export * from "./types.ts";

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
