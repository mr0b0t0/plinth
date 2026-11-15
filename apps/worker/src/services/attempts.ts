// Staging attempts (docs/spec.md, commit last): every attempt at writing a version records its R2
// prefix in staging_attempts before its first put, so what a killed invocation leaves is bounded
// and found without listing the bucket. The commit batch deletes the row and cannot commit
// without a row younger than the threshold. Whoever deletes an attempt's objects (an abort, the
// hourly scheduled sweep, a takedown) first claims the row: an UPDATE that moves started_at to a
// parked value below every cutoff, so a commit that comes after the claim is refused, and one that
// came before leaves nothing to claim. The row is deleted only once the objects are gone, so
// whatever fails in between (a D1 error, an R2 error, an evicted invocation), the next sweep run
// still finds the prefix.
//
// `wrangler dev` (local, tunnel and Docker instances) fires no cron, so minting an upload ticket
// and posting a bundle also start a smaller sweep through waitUntil (sweepSoon), at most once per
// isolate per minute, on every runtime. A sweep takes a claimed row again only once its claim is
// STAGING_SWEEP_CLAIM_MS old, so runs that overlap (two isolates, or one and the cron) never work
// on the same row, and a run that died after its claim leaves the row to a later one.
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
/**
 * A claimed row's lease: a sweep takes it again only once the claim is this old (the run that
 * claimed it, or an abort or takedown, is done with it or died).
 */
export const STAGING_SWEEP_CLAIM_MS = 10 * 60 * 1000;
/** Prefixes an opportunistic sweep (sweepSoon, from a request) claims at most. */
export const OPPORTUNISTIC_SWEEP_BATCH = 20;
/** One isolate starts at most one opportunistic sweep in this long. */
export const OPPORTUNISTIC_SWEEP_EVERY_MS = 60 * 1000;

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

/**
 * started_at of a claimed row: "0" and the claim time. It sorts below every ISO time, so
 * ATTEMPT_GUARD refuses the row's commit, and every sweep run once the claim is
 * STAGING_SWEEP_CLAIM_MS old picks it up again until its objects are gone; among claimed rows the
 * sweep takes the longest-claimed first.
 */
export function parkedAt(now: number): string {
  return `0${new Date(now).toISOString()}`;
}

/** Sweep order: an unclaimed row by its start, a claimed one by its claim time. */
const SWEEP_ORDER = "CASE WHEN started_at < '1' THEN substr(started_at, 2) ELSE started_at END";

/**
 * Claim one attempt's row before deleting its objects (an abort of an attempt that recorded one).
 * False only when a version names the prefix: its commit took the row, and the objects are the
 * version's. A row can also be gone without a commit: a delete, a takedown or an admin erase
 * removes the rows of attempts that are still running, and those keep putting. ATTEMPT_GUARD
 * refuses every commit once the row is gone, so such an attempt never commits; the claim parks a
 * fresh row for it (a failed delete then leaves the prefix to the sweep) and its objects go.
 */
export async function claimAttempt(
  DB: D1Database,
  prefix: string,
  artifactId: string,
  now: number,
): Promise<boolean> {
  const { results } = await DB.prepare(
    "UPDATE staging_attempts SET started_at = ? WHERE prefix = ? RETURNING prefix",
  )
    .bind(parkedAt(now), prefix)
    .all();
  if (results.length > 0) return true;
  if (!ownPrefix(prefix, artifactId) || (await referenced(DB, artifactId, prefix))) return false;
  await DB.prepare(
    "INSERT OR IGNORE INTO staging_attempts (prefix, artifact_id, started_at) VALUES (?, ?, ?)",
  )
    .bind(prefix, artifactId, parkedAt(now))
    .run();
  return true;
}

/** The statement that removes an artifact's rows (its files go with the artifact's root). */
export function dropArtifactAttempts(DB: D1Database, artifactId: string): D1PreparedStatement {
  return DB.prepare("DELETE FROM staging_attempts WHERE artifact_id = ? RETURNING prefix").bind(
    artifactId,
  );
}

/**
 * The statement that claims every row of an artifact whose versions stay (takedown): its attempts
 * can no longer commit. Pass its result to clearClaimedAttempts.
 */
export function claimArtifactAttempts(
  DB: D1Database,
  artifactId: string,
  now: number,
): D1PreparedStatement {
  return DB.prepare(
    "UPDATE staging_attempts SET started_at = ? WHERE artifact_id = ? RETURNING prefix, artifact_id",
  ).bind(parkedAt(now), artifactId);
}

type ClaimedRow = { prefix: string; artifact_id: string };
type Outcome = "deleted" | "referenced" | "skipped";

/**
 * Finish one claimed row: delete its objects when its prefix is an attempt prefix of its artifact
 * that no version names, then the row. Throws, leaving the claimed row for the next sweep run,
 * when either fails.
 */
async function clearClaimed(
  env: { DB: D1Database; FILES: R2Bucket },
  row: ClaimedRow,
): Promise<Outcome> {
  let outcome: Outcome = "deleted";
  if (!ownPrefix(row.prefix, row.artifact_id)) outcome = "skipped";
  else if (await referenced(env.DB, row.artifact_id, row.prefix)) {
    // The commit batch deletes its row, so a version naming a row's prefix should not happen.
    outcome = "referenced";
    console.warn(`staging sweep: a version references the attempt prefix ${row.prefix}`);
  } else await deletePrefix(env.FILES, row.prefix);
  await forgetAttempt(env.DB, row.prefix);
  return outcome;
}

/**
 * Delete what a claimArtifactAttempts statement claimed (its result), now and best effort: a row
 * whose cleanup fails stays claimed, and the next sweep run finishes it.
 */
export async function clearClaimedAttempts(
  env: { DB: D1Database; FILES: R2Bucket },
  result: D1Result | undefined,
): Promise<void> {
  for (const row of (result?.results ?? []) as ClaimedRow[]) {
    await clearClaimed(env, row).catch(() => undefined);
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
  /** Rows whose cleanup failed: they stay claimed for the next run. */
  failed: number;
}

/**
 * One sweep run at `now` (ms): claim up to `limit` rows older than the threshold, and rows
 * claimed more than STAGING_SWEEP_CLAIM_MS earlier, then delete the objects of each claimed prefix
 * no version references, and its row. D1 runs the claim as one statement, so two runs at once
 * never claim the same row. Logs counts only.
 */
export async function sweepStagingAttempts(
  env: { DB: D1Database; FILES: R2Bucket },
  now: number,
  limit: number = STAGING_SWEEP_BATCH,
): Promise<SweepCounts> {
  const { results } = await env.DB.prepare(
    `UPDATE staging_attempts SET started_at = ?3
      WHERE prefix IN (SELECT prefix FROM staging_attempts
                        WHERE (started_at >= '1' AND started_at < ?1)
                           OR (started_at < '1' AND substr(started_at, 2) < ?4)
                        ORDER BY ${SWEEP_ORDER} LIMIT ?2)
      RETURNING prefix, artifact_id`,
  )
    .bind(
      attemptCutoff(now),
      limit,
      parkedAt(now),
      new Date(now - STAGING_SWEEP_CLAIM_MS).toISOString(),
    )
    .all<ClaimedRow>();
  const counts: SweepCounts = {
    claimed: results.length,
    deleted: 0,
    referenced: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of results) {
    try {
      counts[await clearClaimed(env, row)]++;
    } catch {
      counts.failed++;
    }
  }
  if (counts.claimed > 0) console.log(`staging sweep: ${JSON.stringify(counts)}`);
  return counts;
}

/** When this isolate last started an opportunistic sweep (ms). */
let lastSoon = Number.NEGATIVE_INFINITY;

/**
 * Start an opportunistic sweep of up to OPPORTUNISTIC_SWEEP_BATCH rows through `waitUntil`,
 * unless this isolate started one within OPPORTUNISTIC_SWEEP_EVERY_MS of `now`. Called when an
 * upload ticket is minted and when a bundle is posted, so an instance with no cron (`wrangler dev`)
 * still clears abandoned attempts. A failure is swallowed: it never fails the request. Returns
 * whether it started one.
 */
export function sweepSoon(
  env: { DB: D1Database; FILES: R2Bucket },
  waitUntil: (p: Promise<unknown>) => void,
  now: number = Date.now(),
): boolean {
  if (Math.abs(now - lastSoon) < OPPORTUNISTIC_SWEEP_EVERY_MS) return false;
  lastSoon = now;
  waitUntil(sweepStagingAttempts(env, now, OPPORTUNISTIC_SWEEP_BATCH).catch(() => undefined));
  return true;
}

/** Tests: forget the last opportunistic sweep, so the next sweepSoon starts one. */
export function resetSweepThrottle(): void {
  lastSoon = Number.NEGATIVE_INFINITY;
}
