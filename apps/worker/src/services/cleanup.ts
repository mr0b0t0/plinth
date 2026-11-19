// What goes with an artifact when its owner deletes it (deleteArtifact) or an admin takes it down
// (decideReport): one step per table, run in the same batch as the artifact's own update. The
// artifact row stays in both cases (deleted_at or taken_down_at, a new access epoch), so rows that
// only it reaches stay too, listed in ARTIFACT_KEPT, until an erase removes the row and they
// cascade. A schema test fails when a table with an artifact column is in neither list.
import { claimArtifactAttempts } from "./attempts.ts";
import { wipeArtifactData } from "./data.ts";

export interface ArtifactWipeStep {
  /** The tables the step clears. */
  tables: readonly string[];
  statements: (d1: D1Database, artifactId: string, now: number) => D1PreparedStatement[];
  /**
   * Its one statement claims the artifact's staging attempts and returns them, so their objects
   * are cleared after the batch (clearClaimedAttempts).
   */
  claimsAttempts?: true;
}

/** The steps, one per line of tables, in batch order. A feature with an artifact table adds one. */
export const ARTIFACT_WIPE: readonly ArtifactWipeStep[] = [
  // Shared data is not versioned and never outlives the page it belongs to.
  {
    tables: ["artifact_docs", "artifact_data_usage"],
    statements: (d1, id) => wipeArtifactData(d1, id),
  },
  // Unsaved page edits go with it; the room's guarded flush can never bring them back.
  {
    tables: ["live_drafts"],
    statements: (d1, id) => [d1.prepare("DELETE FROM live_drafts WHERE artifact_id = ?1").bind(id)],
  },
  // Its attempt rows become tombstones: their objects are under the artifact's root, and the sweep
  // deletes what a still-running attempt puts after that.
  {
    tables: ["staging_attempts"],
    claimsAttempts: true,
    statements: (d1, id, now) => [claimArtifactAttempts(d1, id, now)],
  },
];

/**
 * Tables with an artifact column that a delete or takedown keeps, and why, one per line. Erasing
 * the artifact (admin erase-artifact, or erasing its owner) removes their rows: each references
 * artifacts with ON DELETE CASCADE, or has its own erase statement (scripts/admin-lib.mjs).
 */
export const ARTIFACT_KEPT: Readonly<Record<string, string>> = {
  versions: "immutable; kept for review of a takedown and gone with the artifact's erase",
  access_grants: "the share list of a row nobody can open any more (the gate refuses it)",
  comments: "the feedback record, kept with the versions it is about",
  mention_tasks: "tied to the comments; agents can no longer act on a deleted artifact",
  reports: "the moderation record; a takedown closes the open ones",
  login_codes: "short-lived viewer codes that expire on their own",
  upload_tickets: "single-use and short-lived; a commit to a deleted artifact is refused",
  artifact_opens: "who opened it, for its stats; folded after the retention, gone with the erase",
  artifact_view_totals: "the folded number of opens, gone with the erase",
};

/** One artifact's wipe statements, and the index of the attempts claim among them. */
export function artifactWipe(
  d1: D1Database,
  artifactId: string,
  now: number,
): { statements: D1PreparedStatement[]; claimAt: number } {
  const statements: D1PreparedStatement[] = [];
  let claimAt = -1;
  for (const step of ARTIFACT_WIPE) {
    if (step.claimsAttempts) claimAt = statements.length;
    statements.push(...step.statements(d1, artifactId, now));
  }
  return { statements, claimAt };
}
