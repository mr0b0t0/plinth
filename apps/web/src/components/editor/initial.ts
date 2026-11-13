// What the editor opens with: the current version, or a draft this tab kept (see draft.ts).
// A draft keeps the version it was based on, even when a newer one has been published since, so
// saving it is checked against that base and can never silently overwrite the newer version.
import type { ArtifactDetail } from "@plinth/shared";
import { listDrafts } from "./draft.ts";

export interface VersionText {
  version: number;
  html: string;
}

export interface EditorInitial {
  html: string;
  note: string;
  /** The version being edited: saves send it as base_version. */
  base: VersionText;
  /** The current version when the editor opened. */
  latest: VersionText;
  /** A draft from this tab was restored. */
  restored: boolean;
}

/**
 * The starting state for an artifact. `fetchVersion` loads an older version's HTML when the kept
 * draft is based on one (null if that fails: the draft then counts as changed throughout).
 */
export async function initialState(
  artifact: Pick<ArtifactDetail, "id" | "version" | "html">,
  fetchVersion: (n: number) => Promise<string | null>,
): Promise<EditorInitial> {
  const latest = { version: artifact.version, html: artifact.html };
  const draft = listDrafts(artifact.id).find((d) => d.base <= artifact.version);
  if (!draft) return { html: latest.html, note: "", base: latest, latest, restored: false };
  if (draft.base === artifact.version) {
    const changed = draft.html !== latest.html || draft.note.trim() !== "";
    return {
      html: draft.html,
      note: draft.note,
      base: latest,
      latest,
      restored: changed,
    };
  }
  const old = await fetchVersion(draft.base).catch(() => null);
  return {
    html: draft.html,
    note: draft.note,
    base: { version: draft.base, html: old ?? "" },
    latest,
    restored: true,
  };
}
