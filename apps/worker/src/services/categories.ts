// Artifact categories (docs/spec.md "Categories"): the owner's own grouping of their artifacts, one
// free-text name per artifact, shown to the owner only (policy.ts seesOwnerMetadata). Names are
// derived from the artifacts that use them (and from the owner's category shares); there is no
// categories table. Every write normalises the name and snaps it onto the owner's existing spelling
// (shared categories.ts), so agents that spell a project slightly differently still file it in one
// place, and writes the match key beside it (migration 0013), which category sharing matches on.
// Personal categories (issue #42) are a collaborator's own names for artifacts shared with them,
// one per person and artifact, seen and set by that person in the app only. Names are never logged.
import {
  type ArtifactSummary,
  type CategoryCount,
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  snapCategory,
} from "@plinth/shared";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import {
  boundArtifactOf,
  mayBulkEditCategories,
  principalUserId,
  seesPersonalCategory,
} from "../policy.ts";
import { notifyRoom } from "../rooms/notify.ts";
import { decideFor, findArtifact, requireArtifact, summaryFor } from "./artifacts.ts";
import { ownerShareIdsByKey, ownerShareNames, refuseBoundToken } from "./categoryShares.ts";
import type { Ctx } from "./context.ts";

// ---------- the category columns (migration 0013) ----------

/**
 * The SET list of every statement that writes artifacts.category (?1 the name or NULL, ?2 its key
 * or NULL). SQLite evaluates each expression against the old row, so it is one atomic step: on a
 * key change it bumps category_rev, resets the owner's review (filing never shares) and, when the
 * review was `shared`, bumps the access epoch so the share's people lose their passes at once. The
 * same key keeps everything: a respelling stays in the same share.
 */
export const CATEGORY_SET = `category = ?1, category_key = ?2,
  category_rev = category_rev + (CASE WHEN category_key IS ?2 THEN 0 ELSE 1 END),
  access_epoch = access_epoch + (CASE WHEN category_review = 'shared' AND category_key IS NOT ?2 THEN 1 ELSE 0 END),
  category_review = CASE WHEN category_key IS ?2 THEN category_review ELSE NULL END,
  category_review_share = CASE WHEN category_key IS ?2 THEN category_review_share ELSE NULL END`;

/** The stored key of a stored name (null for no category). */
export const keyOf = (category: string | null | undefined): string | null =>
  category ? categoryKey(category) : null;

/** Did a filing of `a` under `key` take a shared artifact out of its share (its people lose it)? */
export const leavesShare = (a: ArtifactRow, key: string | null): boolean =>
  a.categoryReview === "shared" && a.categoryKey !== key;

// ---------- the owner's names ----------

/**
 * The owner's stored spellings with their counts, as rows hold them (live artifacts only, owner's
 * rows only; the partial index artifacts_owner_category covers it). `excludeArtifactId` leaves one
 * artifact out: the one being changed, so it does not snap onto its own current spelling.
 */
async function ownerSpellings(
  ctx: Ctx,
  ownerId: string,
  excludeArtifactId?: string,
): Promise<CategoryCount[]> {
  const exclude = excludeArtifactId ? " AND id != ?2" : "";
  const stmt = ctx.env.DB.prepare(
    `SELECT category AS name, count(*) AS n FROM artifacts
      WHERE owner_id = ?1 AND deleted_at IS NULL AND category IS NOT NULL${exclude}
      GROUP BY category`,
  );
  const bound = excludeArtifactId ? stmt.bind(ownerId, excludeArtifactId) : stmt.bind(ownerId);
  const { results } = await bound.all<{ name: string; n: number }>();
  return results.map((r) => ({ name: r.name, count: r.n }));
}

/** Most-used first, then by name. */
const byUse = (a: CategoryCount, b: CategoryCount) =>
  b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Spellings with one key merged: counts summed, the most-used spelling kept. */
function mergeByKey(rows: CategoryCount[]): CategoryCount[] {
  const groups = new Map<string, CategoryCount[]>();
  for (const r of rows) {
    const k = categoryKey(r.name);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    const [top] = [...g].sort(byUse);
    return { name: (top as CategoryCount).name, count: g.reduce((n, r) => n + r.count, 0) };
  });
}

/**
 * The owner's category names with counts, most-used first, capped at LIMITS.maxCategoriesListed
 * (the most-used names survive a cut). Writes always snap, so the merge by key only catches rows
 * written another way. While category sharing is on, a shared name carries `shared: true`, and a
 * share whose category holds no artifact yet is listed with count 0, so agents reuse its spelling.
 */
export async function ownerCategories(
  ctx: Ctx,
  ownerId: string,
  excludeArtifactId?: string,
): Promise<CategoryCount[]> {
  const merged = mergeByKey(await ownerSpellings(ctx, ownerId, excludeArtifactId));
  if (ctx.config.allowCategorySharing) {
    const shared = await ownerShareIdsByKey(ctx.env.DB, ownerId);
    if (shared.size > 0) {
      const names = await ownerShareNames(ctx.env.DB, ownerId);
      for (const c of merged) if (shared.has(categoryKey(c.name))) c.shared = true;
      const have = new Set(merged.map((c) => categoryKey(c.name)));
      for (const n of names) {
        if (!have.has(categoryKey(n))) merged.push({ name: n, count: 0, shared: true });
      }
    }
  }
  return merged.sort(byUse).slice(0, LIMITS.maxCategoriesListed);
}

/** The owner's stored spellings whose key matches `name` (the list_artifacts filter). */
export async function matchingSpellings(
  ctx: Ctx,
  ownerId: string,
  name: string,
): Promise<string[]> {
  const key = categoryKey(name);
  if (!key) return [];
  return (await ownerSpellings(ctx, ownerId))
    .sort(byUse)
    .map((r) => r.name)
    .filter((n) => categoryKey(n) === key);
}

/** Refuse a name that is empty, too long or holds control, format or separator characters. */
function checkName(name: string, field: string): void {
  const problem = categoryProblem(name);
  if (problem) {
    throw new ApiError("invalid_input", problem, {
      field,
      next: `Use a short project or repo name (1 to ${LIMITS.maxCategoryLength} characters), or reuse one from list_artifacts' categories`,
    });
  }
}

/**
 * The name to store: normalised (NFC, whitespace collapsed, trimmed), refused with 400 when empty,
 * too long or holding control, format or separator characters, then snapped onto the owner's
 * existing spelling with the same key (other than `excludeArtifactId`'s own), shared names
 * included: an agent's "acme-corp" lands on a shared "Acme Corp" even while that share is empty.
 */
export async function resolveCategory(
  ctx: Ctx,
  ownerId: string,
  raw: string,
  excludeArtifactId?: string,
): Promise<string> {
  const name = normalizeCategory(raw);
  checkName(name, "category");
  const existing = (await ownerCategories(ctx, ownerId, excludeArtifactId)).map((c) => c.name);
  return snapCategory(name, existing);
}

/**
 * Setting the category of an existing artifact is the owner's `manage` right. Callers run it only
 * after the caller passed `edit` (so they hold a role, and a 403 tells them nothing new); the error
 * never echoes the stored value.
 */
export async function requireCategoryRight(ctx: Ctx, artifact: ArtifactRow): Promise<void> {
  const d = await decideFor(ctx, artifact, "manage");
  if (d.allow) return;
  if (!d.allow && d.reason === "token_bound") {
    throw new ApiError(
      "forbidden",
      "This token may only read this artifact and publish new versions of it; set the category on the artifact's Settings page",
      { field: "category", reason: "token_bound" },
    );
  }
  throw new ApiError("forbidden", "Only the owner sets an artifact's category", {
    field: "category",
    reason: "owner_only",
    next: "Leave category out when you change an artifact you do not own",
  });
}

/**
 * GET /categories: the caller's own names with counts (as list_artifacts' `categories`), for a
 * signed-in person or a bearer token with artifacts:read. Never another owner's names.
 */
export async function listCategories(ctx: Ctx): Promise<CategoryCount[]> {
  const uid = principalUserId(ctx.principal);
  if (!uid) throw unauthorized();
  if (ctx.principal.kind === "agent" && !ctx.principal.scopes.has("artifacts:read")) {
    throw new ApiError("forbidden", "This token lacks the artifacts:read scope");
  }
  // A token limited to one artifact never sees the owner's category names.
  if (boundArtifactOf(ctx.principal) !== null) return [];
  return ownerCategories(ctx, uid);
}

/**
 * PATCH /artifacts/:ref (owner only, the `manage` action): a new title, a category, or both.
 * `category: null` clears it. A title change bumps updated_at; a category change does not, so
 * filing artifacts never reorders the dashboard. Neither creates a version. A category change is
 * one CATEGORY_SET statement: a move to another key leaves the artifact unreviewed (pending in a
 * shared category), whoever filed it.
 */
export async function patchArtifact(
  ctx: Ctx,
  ref: string,
  input: { title?: string; category?: string | null },
): Promise<ArtifactSummary> {
  const { artifact, role } = await requireArtifact(ctx, ref, "manage");
  if (input.title === undefined && input.category === undefined) {
    throw new ApiError("invalid_input", "Send a title, a category, or both", {
      next: 'Send {"title": "..."} or {"category": "..."} (null clears the category)',
    });
  }
  const DB = ctx.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (input.title !== undefined) {
    stmts.push(
      DB.prepare("UPDATE artifacts SET title = ?1, updated_at = ?2 WHERE id = ?3").bind(
        input.title.trim(),
        nowIso(),
        artifact.id,
      ),
    );
  }
  let left = false;
  if (input.category !== undefined) {
    const category =
      input.category === null
        ? null
        : await resolveCategory(ctx, artifact.ownerId, input.category, artifact.id);
    const key = keyOf(category);
    left = leavesShare(artifact, key);
    stmts.push(
      DB.prepare(`UPDATE artifacts SET ${CATEGORY_SET} WHERE id = ?3 AND owner_id = ?4`).bind(
        category,
        key,
        artifact.id,
        artifact.ownerId,
      ),
    );
    if (left) stmts.push(prunePersonalCategories(DB, { artifactId: artifact.id }));
  }
  await DB.batch(stmts);
  if (left) notifyRoom(ctx, artifact.id, "revoke");
  const fresh = (await findArtifact(ctx, artifact.id)) ?? artifact;
  return summaryFor(ctx, fresh, role);
}

/**
 * POST /categories/rename: move every live artifact of the caller's in `from` (matched by key) to
 * `to`, which snaps onto one of the caller's other spellings (a merge); `to: null` clears it. The
 * signed-in owner only, never an agent or bearer token. Scoped to the caller's own rows; updated_at
 * is left alone and no version is created. The caller's open upload tickets with that name move
 * too. An inline update_artifact or PUT that resolved its name just before the rename and commits
 * just after it can still store the old name (a window of one request); the owner renames again.
 *
 * With category shares (docs/spec.md "Category sharing and personal categories"): a shared `from`
 * cannot merge into another existing category (409 category_shared); renaming it to a new name
 * moves the share, which keeps its people, link and reviews; clearing it leaves the share empty; a
 * rename into a shared `to` brings the artifacts in pending. The decision is re-checked inside the
 * batch: every statement is guarded on the owner's category_share_rev, so a share created, deleted
 * or moved meanwhile makes the whole rename a no-op (409 sharing_changed).
 */
export async function renameCategory(
  ctx: Ctx,
  input: { from: string; to: string | null; personal?: boolean },
): Promise<{ updated: number; category: string | null; pending?: number }> {
  if (!mayBulkEditCategories(ctx.principal)) {
    if (ctx.principal.kind === "anonymous") throw unauthorized();
    throw new ApiError("forbidden", "Rename categories in the app", {
      next: "Ask the person to rename or merge the category on their dashboard",
    });
  }
  const uid = principalUserId(ctx.principal);
  if (!uid) throw unauthorized();
  if (input.personal === true) return renamePersonalCategory(ctx, uid, input);
  const DB = ctx.env.DB;
  const spellings = await matchingSpellings(ctx, uid, input.from);
  const fromKey = categoryKey(input.from);
  let category: string | null = null;
  if (input.to !== null) {
    const name = normalizeCategory(input.to);
    const problem = categoryProblem(name);
    if (problem) throw new ApiError("invalid_input", problem, { field: "to" });
    // Snap onto the owner's other names only: the ones being renamed must not pull it back.
    const others = (await ownerCategories(ctx, uid))
      .map((c) => c.name)
      .filter((n) => !spellings.includes(n) && categoryKey(n) !== fromKey);
    category = snapCategory(name, others);
  }
  const toKey = keyOf(category);
  // The read phase of the share decision: the counter first, so a share change after it is seen.
  const rev =
    (
      await DB.prepare("SELECT category_share_rev AS rev FROM users WHERE id = ?1")
        .bind(uid)
        .first<{ rev: number }>()
    )?.rev ?? 0;
  const shares = ctx.config.allowCategorySharing
    ? await ownerShareIdsByKey(DB, uid)
    : new Map<string, string>();
  const sFrom = fromKey ? (shares.get(fromKey) ?? null) : null;
  const sTo = toKey !== null && toKey !== fromKey ? (shares.get(toKey) ?? null) : null;
  if (sFrom && toKey !== null && toKey !== fromKey) {
    const toHasArtifacts = (await ownerSpellings(ctx, uid)).some(
      (c) => categoryKey(c.name) === toKey,
    );
    if (sTo || toHasArtifacts) {
      throw new ApiError("conflict", "A shared category cannot be merged into another one", {
        reason: "category_shared",
        next: `Stop sharing ${input.from} first, or rename it to a new name`,
      });
    }
  }
  // The caller's open start_upload tickets that carry this name follow it: a ticket stores the
  // spelling it snapped to at mint, and a bundle that commits after the rename would otherwise
  // bring the old name back (its key no longer matches anything to snap onto).
  const { results: open } = await DB.prepare(
    "SELECT id, category FROM upload_tickets WHERE user_id = ?1 AND state = 'open' AND category IS NOT NULL",
  )
    .bind(uid)
    .all<{ id: string; category: string }>();
  const tickets = open
    .filter((t) => fromKey !== "" && categoryKey(t.category) === fromKey)
    .map((t) => t.id);
  // G: the owner's share counter is still what the read saw. Nothing before the last statement
  // changes it, so G has one value for the whole batch (a D1 batch is one transaction).
  const G = "(SELECT category_share_rev FROM users WHERE id = ?2) = ?3";
  const moveShare = sFrom !== null && toKey !== null && category !== null;
  const stmts: D1PreparedStatement[] = [
    DB.prepare("SELECT category_share_rev AS rev FROM users WHERE id = ?1").bind(uid),
  ];
  if (moveShare) {
    stmts.push(
      DB.prepare(
        `UPDATE category_shares SET category_key = ?1, name = ?4, updated_at = ?5
          WHERE id = ?6 AND owner_id = ?2 AND category_key = ?7 AND ${G}`,
      ).bind(toKey, uid, rev, category, nowIso(), sFrom, fromKey),
    );
  }
  let epochIndex = -1;
  let moveIndex = -1;
  if (spellings.length > 0) {
    const marks = spellings.map((_, i) => `?${i + 4}`).join(", ");
    // Reviews kept are exactly those bound to the share that is on the new key once this batch's
    // own move has run; every other `shared` row ends its passes.
    epochIndex = stmts.length;
    stmts.push(
      DB.prepare(
        `UPDATE artifacts SET access_epoch = access_epoch + 1
          WHERE owner_id = ?2 AND deleted_at IS NULL AND category IN (${marks})
            AND category_review = 'shared'
            AND category_review_share IS NOT (SELECT id FROM category_shares
                                               WHERE owner_id = ?2 AND category_key = ?1)
            AND ${G}
         RETURNING id`,
      ).bind(toKey, uid, rev, ...spellings),
    );
    const at = spellings.length + 4;
    moveIndex = stmts.length;
    stmts.push(
      DB.prepare(
        `UPDATE artifacts SET
           category = ?${at}, category_key = ?1,
           category_rev = category_rev + (CASE WHEN category_key IS ?1 THEN 0 ELSE 1 END),
           category_review = CASE WHEN category_review_share =
               (SELECT id FROM category_shares WHERE owner_id = ?2 AND category_key = ?1)
             THEN category_review ELSE NULL END,
           category_review_share = CASE WHEN category_review_share =
               (SELECT id FROM category_shares WHERE owner_id = ?2 AND category_key = ?1)
             THEN category_review_share ELSE NULL END
          WHERE owner_id = ?2 AND deleted_at IS NULL AND category IN (${marks}) AND ${G}`,
      ).bind(toKey, uid, rev, ...spellings, category),
    );
  }
  if (tickets.length > 0) {
    const marks = tickets.map((_, i) => `?${i + 4}`).join(", ");
    stmts.push(
      DB.prepare(
        `UPDATE upload_tickets SET category = ?1
          WHERE user_id = ?2 AND state = 'open' AND id IN (${marks}) AND ${G}`,
      ).bind(category, uid, rev, ...tickets),
    );
  }
  if (moveShare) {
    stmts.push(
      DB.prepare(
        "UPDATE users SET category_share_rev = category_share_rev + 1 WHERE id = ?1 AND category_share_rev = ?2",
      ).bind(uid, rev),
    );
  }
  if (stmts.length === 1) return { updated: 0, category };
  if (epochIndex >= 0) stmts.push(prunePersonalCategories(DB, { ownerId: uid }));
  const results = await DB.batch(stmts);
  const probe = (results[0]?.results?.[0] as { rev: number } | undefined)?.rev;
  if (probe !== rev) {
    throw new ApiError("conflict", "Sharing changed while you renamed; try again", {
      reason: "sharing_changed",
      next: "Sharing changed while you renamed; try again",
    });
  }
  if (epochIndex >= 0) {
    for (const r of (results[epochIndex]?.results ?? []) as { id: string }[]) {
      notifyRoom(ctx, r.id, "revoke");
    }
  }
  const updated = moveIndex >= 0 ? (results[moveIndex]?.meta.changes ?? 0) : 0;
  // Artifacts arriving in someone else's share start unreviewed.
  return sTo && !sFrom && updated > 0
    ? { updated, category, pending: updated }
    : { updated, category };
}

// ---------- personal categories (issue #42) ----------

/**
 * Remove personal categories whose person no longer holds a grant on the artifact: no direct
 * grant, and no category grant that counts (the review shared into the current share of its key,
 * which holds the person's email). Scoped to one artifact or one owner's artifacts. Category grants
 * count here whatever ALLOW_CATEGORY_SHARING says, so switching it off and on loses nothing; reads
 * show a personal category only where the person holds a role now.
 */
export function prunePersonalCategories(
  d1: D1Database,
  scope: { artifactId: string } | { ownerId: string },
): D1PreparedStatement {
  const where =
    "artifactId" in scope
      ? "p.artifact_id = ?1"
      : "p.artifact_id IN (SELECT id FROM artifacts WHERE owner_id = ?1)";
  return d1
    .prepare(
      `DELETE FROM personal_categories AS p WHERE ${where}
         AND NOT EXISTS (SELECT 1 FROM users u JOIN access_grants g ON g.email = u.email
                          WHERE u.id = p.user_id AND g.artifact_id = p.artifact_id)
         AND NOT EXISTS (SELECT 1 FROM users u
                           JOIN artifacts a ON a.id = p.artifact_id
                           JOIN category_shares s ON s.id = a.category_review_share
                            AND s.owner_id = a.owner_id AND s.category_key = a.category_key
                           JOIN category_grants cg ON cg.share_id = s.id AND cg.email = u.email
                          WHERE u.id = p.user_id AND a.category_review = 'shared')`,
    )
    .bind("artifactId" in scope ? scope.artifactId : scope.ownerId);
}

/** The person's own categories with counts, most-used first (live artifacts only). */
export async function personalCategoriesOf(ctx: Ctx, userId: string): Promise<CategoryCount[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT p.category AS name, count(*) AS n FROM personal_categories p
       JOIN artifacts a ON a.id = p.artifact_id
      WHERE p.user_id = ?1 AND a.deleted_at IS NULL
      GROUP BY p.category`,
  )
    .bind(userId)
    .all<{ name: string; n: number }>();
  return mergeByKey(results.map((r) => ({ name: r.name, count: r.n })))
    .sort(byUse)
    .slice(0, LIMITS.maxCategoriesListed);
}

/** The person's own category per artifact, for these artifacts. */
export async function personalCategoryMap(
  ctx: Ctx,
  userId: string,
  artifactIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (artifactIds.length === 0) return out;
  const { results } = await ctx.env.DB.prepare(
    `SELECT artifact_id, category FROM personal_categories
      WHERE user_id = ?1 AND artifact_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(userId, JSON.stringify(artifactIds))
    .all<{ artifact_id: string; category: string }>();
  for (const r of results) out.set(r.artifact_id, r.category);
  return out;
}

/** Every name the person files under: their own artifacts' categories and their personal ones. */
async function personalVocabulary(ctx: Ctx, userId: string): Promise<string[]> {
  const [own, personal] = await Promise.all([
    ownerSpellings(ctx, userId),
    personalCategoriesOf(ctx, userId),
  ]);
  return [...personal, ...mergeByKey(own)].sort(byUse).map((c) => c.name);
}

/**
 * PUT /artifacts/:ref/my-category: the signed-in person's own category for an artifact shared with
 * them (any role but owner), or null to clear it. Never an agent (403), never the owner (who sets
 * the artifact's category). The name snaps onto the person's own names, so their personal and own
 * categories share one vocabulary.
 */
export async function setMyCategory(
  ctx: Ctx,
  ref: string,
  raw: string | null,
): Promise<ArtifactSummary> {
  const p = ctx.principal;
  if (p.kind === "anonymous") throw unauthorized();
  refuseBoundToken(p);
  if (p.kind !== "user") {
    throw new ApiError("forbidden", "Set your own category in the app", {
      reason: "app_only",
      next: "Your own categories for shared artifacts are set on the dashboard",
    });
  }
  const { artifact, role } = await requireArtifact(ctx, ref, "view");
  if (role === "owner") {
    throw new ApiError("invalid_input", "This is your artifact: set its category instead", {
      reason: "owner",
      next: "PATCH /api/v1/artifacts/:ref with category",
    });
  }
  if (!seesPersonalCategory(p, role)) {
    throw new ApiError("forbidden", "Only people this artifact is shared with can file it", {
      reason: "no_grant",
    });
  }
  // The grant must be the account's own. A viewer email confirmed in this browser opens the
  // artifact here, but the dashboard lists it, and prunePersonalCategories keeps the row, only for
  // a grant the account's email holds; a row saved on the other address would vanish unseen.
  const account = await decideFor({ ...ctx, viewerEmail: null }, artifact, "view");
  if (!seesPersonalCategory(p, account.allow ? account.role : null)) {
    throw new ApiError(
      "forbidden",
      "This artifact is shared with another address, not your account's",
      {
        reason: "no_grant",
        next: "Ask the owner to share it with your account's email to file it",
      },
    );
  }
  const DB = ctx.env.DB;
  if (raw === null) {
    await DB.prepare("DELETE FROM personal_categories WHERE user_id = ?1 AND artifact_id = ?2")
      .bind(p.userId, artifact.id)
      .run();
  } else {
    const name = normalizeCategory(raw);
    checkName(name, "category");
    const stored = snapCategory(name, await personalVocabulary(ctx, p.userId));
    const now = nowIso();
    await DB.prepare(
      `INSERT INTO personal_categories (user_id, artifact_id, category, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (user_id, artifact_id) DO UPDATE SET category = excluded.category,
         updated_at = excluded.updated_at`,
    )
      .bind(p.userId, artifact.id, stored, now)
      .run();
  }
  return summaryFor(ctx, artifact, role);
}

/** The personal side of POST /categories/rename (`personal: true`): the person's own rows only. */
async function renamePersonalCategory(
  ctx: Ctx,
  userId: string,
  input: { from: string; to: string | null },
): Promise<{ updated: number; category: string | null }> {
  const key = categoryKey(input.from);
  const mine = (await personalSpellings(ctx, userId)).filter((n) => key && categoryKey(n) === key);
  let category: string | null = null;
  if (input.to !== null) {
    const name = normalizeCategory(input.to);
    const problem = categoryProblem(name);
    if (problem) throw new ApiError("invalid_input", problem, { field: "to" });
    const others = (await personalVocabulary(ctx, userId)).filter((n) => categoryKey(n) !== key);
    category = snapCategory(name, others);
  }
  if (mine.length === 0) return { updated: 0, category };
  const marks = (from: number) => mine.map((_, i) => `?${i + from}`).join(", ");
  const r =
    category === null
      ? await ctx.env.DB.prepare(
          `DELETE FROM personal_categories WHERE user_id = ?1 AND category IN (${marks(2)})`,
        )
          .bind(userId, ...mine)
          .run()
      : await ctx.env.DB.prepare(
          `UPDATE personal_categories SET category = ?2, updated_at = ?3
            WHERE user_id = ?1 AND category IN (${marks(4)})`,
        )
          .bind(userId, category, nowIso(), ...mine)
          .run();
  return { updated: r.meta.changes ?? 0, category };
}

async function personalSpellings(ctx: Ctx, userId: string): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT DISTINCT category FROM personal_categories WHERE user_id = ?1",
  )
    .bind(userId)
    .all<{ category: string }>();
  return results.map((r) => r.category);
}
