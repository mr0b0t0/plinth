// The change list of two loaded versions, worked out in the browser by the shared describers. The
// source texts are only their input: nothing here renders them. The work runs after the page has
// painted (it is capped, but a large version still takes a moment), and again when either side
// changes.
import {
  type ArtifactDetail,
  type ChangeList,
  describeChanges,
  type FileChangeSummary,
  fileChanges,
  sourceOf,
  summarizeFileChanges,
} from "@plinth/shared";
import { useEffect, useState } from "react";

export interface VersionChanges {
  changes: ChangeList;
  files: FileChangeSummary;
}

/** What changed from `before` to `after`, or null until both are loaded and it is worked out. */
export function versionChanges(before: ArtifactDetail, after: ArtifactDetail): VersionChanges {
  const a = sourceOf(before);
  const b = sourceOf(after);
  return {
    changes: describeChanges(b.def.id, a.text, b.text),
    files: summarizeFileChanges(fileChanges(before.assets, after.assets)),
  };
}

export function useChanges(
  before: ArtifactDetail | undefined,
  after: ArtifactDetail | undefined,
): VersionChanges | null {
  const [state, setState] = useState<{ key: unknown[]; value: VersionChanges } | null>(null);
  useEffect(() => {
    if (!before || !after) return;
    const timer = setTimeout(() => {
      setState({ key: [before, after], value: versionChanges(before, after) });
    }, 0);
    return () => clearTimeout(timer);
  }, [before, after]);
  if (!before || !after || !state) return null;
  return state.key[0] === before && state.key[1] === after ? state.value : null;
}
