// Staging attempts (docs/spec.md, commit last): every attempt at writing a version records its R2
// prefix in staging_attempts before its first put, so what a killed invocation leaves is bounded
// and found without listing the bucket. The commit batch deletes the row and cannot commit
// without it; an abort deletes the prefix and then the row; the hourly scheduled sweep claims rows
// past the threshold and deletes their objects. The claim is a DELETE ... RETURNING, so a sweep
// and a commit never both proceed on one prefix: whichever removes the row first wins.
//
// The admin command sweep-orphans (scripts/admin-lib.mjs) stays the full-bucket tool for objects
// written before this table existed, which no row names.
import { TTL } from "@plinth/shared";
import { nowIso } from "../lib/time.ts";
import { artifactRoot, deletePrefix } from "./storage.ts";

/** The Worker's cron trigger (wrangler.jsonc `triggers.crons`): hourly, on the hour. */
export const STAGING_SWEEP_CRON = "0 * * * *";
/** Added to the upload ticket's lifetime, past which no attempt can still commit. */
export const STAGING_SWEEP_MARGIN_MS = 15 * 60 * 1000;
/** An attempt row older than this belongs to the sweep (and its commit is refused). */
export const STAGING_SWEEP_AFTER_MS = TTL.uploadTicketMs + STAGING_SWEEP_MARGIN_MS;
/** Prefixes one sweep run claims at most; the rest wait for the next run. */
export const STAGING_SWEEP_BATCH = 50;

/** `artifacts/<20 id chars>/v<n>.<12 nonce chars>/`: the only prefixes the sweep deletes. */
const ATTEMPT_PREFIX_RE = /^artifacts\/([a-z0-9]{20})\/v[1-9][0-9]{0,8}\.[a-z0-9]{12}\/$/;

/** The oldest started_at a commit still accepts, at `now` (ms). */
export function attemptCutoff(now: number): string {
  return new Date(now - STAGING_SWEEP_AFTER_MS).toISOString();
}

/**
 * Commit guard: the attempt's row exists and is younger than the sweep threshold. Binds the
 * prefix, then attemptCutoff(now).
 */
export const ATTEMPT_GUARD =
  "EXISTS (SELECT 1 FROM staging_attempts s WHERE s.prefix = ? AND s.started_at > ?)";

export async function recordAttempt(
  DB: D1Database,
  prefix: string,
  artifactId: string,
): Promise<void> {
  await DB.prepare(
    "INSERT INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
  )
    .bind(prefix, artifactId, nowIso())
    .run();
}

export async function forgetAttempt(DB: D1Database, prefix: string): Promise<void> {
  await DB.prepare("DELETE FROM staging_attempts WHERE prefix = ?").bind(prefix).run();
}

/** The statement that removes an artifact's rows (its files go with the artifact's root). */
export function dropArtifactAttempts(DB: D1Database, artifactId: string): D1PreparedStatement {
  return DB.prepare("DELETE FROM staging_attempts WHERE artifact_id = ? RETURNING prefix").bind(
    artifactId,
  );
}

/**
 * Delete the objects of attempt rows a dropArtifactAttempts statement removed (its result), for an
 * artifact whose versions stay (takedown). Only prefixes no version names.
 */
export async function deleteClaimedAttempts(
  env: { DB: D1Database; FILES: R2Bucket },
  artifactId: string,
  result: D1Result,
): Promise<void> {
  for (const row of (result.results ?? []) as { prefix?: unknown }[]) {
    const prefix = typeof row.prefix === "string" ? row.prefix : "";
    if (!ownPrefix(prefix, artifactId)) continue;
    if (await referenced(env.DB, artifactId, prefix)) continue;
    await deletePrefix(env.FILES, prefix);
  }
}

function ownPrefix(prefix: string, artifactId: string): boolean {
  const m = ATTEMPT_PREFIX_RE.exec(prefix);
  return !!m && m[1] === artifactId;
}

/** Whether a version names `prefix`: as its r2_prefix, or through a stored_at pointing into it. */
async function referenced(DB: D1Database, artifactId: string, prefix: string): Promise<boolean> {
  const rel = prefix.slice(artifactRoot(artifactId).length);
  const hit = await DB.prepare(
    `SELECT 1 AS one FROM versions WHERE artifact_id = ? AND (r2_prefix = ? OR instr(manifest, ?) > 0)
      LIMIT 1`,
  )
    .bind(artifactId, prefix, `"stored_at":"${rel}`)
    .first();
  return hit !== null;
}

export interface SweepCounts {
  claimed: number;
  deleted: number;
  /** Rows a version referenced (an anomaly): only the row went. */
  referenced: number;
  /** Rows whose prefix is not an attempt prefix: only the row went. */
  skipped: number;
  /** Prefixes whose delete failed: their rows are back for the next run. */
  failed: number;
}

/**
 * One sweep run at `now` (ms): claim up to STAGING_SWEEP_BATCH rows older than the threshold, then
 * delete the objects of each claimed prefix no version references. Logs counts only.
 */
export async function sweepStagingAttempts(
  env: { DB: D1Database; FILES: R2Bucket },
  now: number,
): Promise<SweepCounts> {
  const cutoff = attemptCutoff(now);
  const { results } = await env.DB.prepare(
    `DELETE FROM staging_attempts
      WHERE started_at < ?1
        AND prefix IN (SELECT prefix FROM staging_attempts WHERE started_at < ?1
                        ORDER BY started_at LIMIT ?2)
      RETURNING prefix, artifact_id, started_at`,
  )
    .bind(cutoff, STAGING_SWEEP_BATCH)
    .all<{ prefix: string; artifact_id: string; started_at: string }>();
  const counts: SweepCounts = {
    claimed: results.length,
    deleted: 0,
    referenced: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of results) {
    if (!ownPrefix(row.prefix, row.artifact_id)) {
      counts.skipped++;
      continue;
    }
    if (await referenced(env.DB, row.artifact_id, row.prefix)) {
      // The commit batch deletes its row, so a version naming a row's prefix should not happen.
      counts.referenced++;
      console.warn(`staging sweep: a version references the attempt prefix ${row.prefix}`);
      continue;
    }
    try {
      await deletePrefix(env.FILES, row.prefix);
      counts.deleted++;
    } catch {
      // Put the row back with its own time, so the next run tries again. Its commit stays refused:
      // the row is past the threshold the commit guard checks.
      counts.failed++;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
      )
        .bind(row.prefix, row.artifact_id, row.started_at)
        .run()
        .catch(() => undefined);
    }
  }
  if (counts.claimed > 0) console.log(`staging sweep: ${JSON.stringify(counts)}`);
  return counts;
}
