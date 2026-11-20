// Category sharing (docs/spec.md "Category sharing and personal categories"; issue #42). An owner
// shares one of their category keys with people, who then see every artifact of that category the
// owner reviewed into the share. Filing an artifact under a shared category never shares it: the
// artifact waits as `pending` until the signed-in owner reviews it, and only the owner's review,
// bound to this share's id, the artifact's version and its category_rev, makes the category's
// grants count (policy.ts categoryRoleOf). Every write here is the signed-in owner's alone
// (mayManageCategoryShares) and runs as one D1 batch, so one transaction. Category names and share
// titles are never logged.
import {
  type CategoryPerson,
  type CategoryReviewResult,
  type CategoryRole,
  type CategoryShareArtifact,
  type CategoryShareDetail,
  type CategorySharePreview,
  type CategoryShareResult,
  type CategoryShareSummary,
  type CategoryShareWriteResult,
  categoryKey,
  LIMITS,
  normalizeCategory,
  type ReviewSkipReason,
  type SharingCategoryShare,
} from "@plinth/shared";
import { appUrl, type Config } from "../config.ts";
import type { ArtifactRow, CategoryShareRow } from "../db/schema.ts";
import { newId } from "../lib/crypto.ts";
import { ApiError, isUniqueViolation, notFound, unauthorized } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import {
  type CategoryGrantFacts,
  mayManageCategoryShares,
  type Principal,
  seesCategorySharing,
} from "../policy.ts";
import { notifyRoom } from "../rooms/notify.ts";
import { matchingSpellings, prunePersonalCategories } from "./categories.ts";
import type { Ctx } from "./context.ts";
import { artifactLimitFor, getUserById } from "./users.ts";

export interface ReviewItem {
  id: string;
  version: number;
  category_rev: number;
  decision: "shared" | "private";
}

// ---------- reads used by policy facts, summaries and results ----------

/**
 * The principal's grant on the current share of this artifact's owner and key: the strongest role
 * among `emails`, with the email holding it (the principal's own on a tie). Null while sharing is
 * off or the artifact has no key. Whether it counts is policy.ts categoryRoleOf's decision.
 */
export async function categoryGrantFor(
  ctx: Ctx,
  a: Pick<ArtifactRow, "ownerId" | "categoryKey">,
  emails: readonly string[],
  own: string | null,
): Promise<(CategoryGrantFacts & { email: string }) | null> {
  if (!ctx.config.allowCategorySharing || a.categoryKey === null || emails.length === 0)
    return null;
  const marks = emails.map((_, i) => `?${i + 3}`).join(", ");
  const { results } = await ctx.env.DB.prepare(
    `SELECT s.id AS share_id, s.category_key AS share_key, g.role AS role, g.email AS email
       FROM category_shares s JOIN category_grants g ON g.share_id = s.id
      WHERE s.owner_id = ?1 AND s.category_key = ?2 AND g.email IN (${marks})`,
  )
    .bind(a.ownerId, a.categoryKey, ...emails)
    .all<{ share_id: string; share_key: string; role: CategoryRole; email: string }>();
  let best: (CategoryGrantFacts & { email: string }) | null = null;
  for (const r of results) {
    const stronger = !best || (r.role === "commenter" && best.role === "viewer");
    const tie = best && r.role === best.role && r.email === own;
    if (stronger || tie) {
      best = { shareId: r.share_id, shareKey: r.share_key, role: r.role, email: r.email };
    }
  }
  return best;
}

/**
 * Every category grant an email holds, keyed by `<owner id>\n<category key>` (the bulk list's
 * lookup). Empty while sharing is off.
 */
export async function callerCategoryGrants(
  ctx: Ctx,
  email: string,
): Promise<Map<string, CategoryGrantFacts>> {
  const out = new Map<string, CategoryGrantFacts>();
  if (!ctx.config.allowCategorySharing) return out;
  const { results } = await ctx.env.DB.prepare(
    `SELECT s.id AS share_id, s.owner_id AS owner_id, s.category_key AS share_key, g.role AS role
       FROM category_grants g JOIN category_shares s ON s.id = g.share_id
      WHERE g.email = ?1`,
  )
    .bind(email)
    .all<{ share_id: string; owner_id: string; share_key: string; role: CategoryRole }>();
  for (const r of results) {
    out.set(`${r.owner_id}\n${r.share_key}`, {
      shareId: r.share_id,
      shareKey: r.share_key,
      role: r.role,
    });
  }
  return out;
}

/** The owner's share ids by category key. */
export async function ownerShareIdsByKey(
  d1: D1Database,
  ownerId: string,
): Promise<Map<string, string>> {
  const { results } = await d1
    .prepare("SELECT id, category_key FROM category_shares WHERE owner_id = ?1")
    .bind(ownerId)
    .all<{ id: string; category_key: string }>();
  return new Map(results.map((r) => [r.category_key, r.id]));
}

/** The id of the owner's share on `key`, or null. */
export async function shareIdForKey(
  d1: D1Database,
  ownerId: string,
  key: string | null,
): Promise<string | null> {
  if (key === null) return null;
  const r = await d1
    .prepare("SELECT id FROM category_shares WHERE owner_id = ?1 AND category_key = ?2")
    .bind(ownerId, key)
    .first<{ id: string }>();
  return r?.id ?? null;
}

/** The owner's share names (their spelling), to snap new filings onto. */
export async function ownerShareNames(d1: D1Database, ownerId: string): Promise<string[]> {
  const { results } = await d1
    .prepare("SELECT name FROM category_shares WHERE owner_id = ?1")
    .bind(ownerId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

const reviewUrl = (config: Config, shareId: string) =>
  appUrl(config, `/dashboard?review=${encodeURIComponent(shareId)}`);

/**
 * The artifact's place in its category's share, for the owner's own results: undefined unless
 * `ownerView` (seesOwnerMetadata for the caller), the feature is on, and the artifact's key has a
 * share. It reads the row after the commit, so it reports the state that holds now.
 */
export async function categoryShareResult(
  d1: D1Database,
  config: Config,
  artifactId: string,
  ownerView: boolean,
): Promise<CategoryShareResult | undefined> {
  if (!ownerView || !config.allowCategorySharing) return undefined;
  const r = await d1
    .prepare(
      `SELECT a.category_review AS review, a.category_review_share AS review_share, s.id AS share_id
         FROM artifacts a JOIN category_shares s
           ON s.owner_id = a.owner_id AND s.category_key = a.category_key
        WHERE a.id = ?1`,
    )
    .bind(artifactId)
    .first<{
      review: "shared" | "private" | null;
      review_share: string | null;
      share_id: string;
    }>();
  if (!r) return undefined;
  if (r.review_share === r.share_id && r.review) return { state: r.review };
  return { state: "pending", review_url: reviewUrl(config, r.share_id) };
}

/**
 * The state a filing will start in, for a start_upload mint by the owner: pending whenever the
 * name's key has a share, unless the artifact already sits in that key (it keeps its state).
 */
export async function filingShareResult(
  ctx: Ctx,
  ownerId: string,
  category: string,
  current: ArtifactRow | null,
): Promise<CategoryShareResult | undefined> {
  if (!ctx.config.allowCategorySharing) return undefined;
  const key = categoryKey(category);
  const shareId = await shareIdForKey(ctx.env.DB, ownerId, key);
  if (!shareId) return undefined;
  if (
    current &&
    current.categoryKey === key &&
    current.categoryReviewShare === shareId &&
    current.categoryReview
  ) {
    return { state: current.categoryReview };
  }
  return { state: "pending", review_url: reviewUrl(ctx.config, shareId) };
}

/** The share of an artifact's category for its owner's sharing settings, or null. */
export async function sharingCategoryShare(
  ctx: Ctx,
  a: ArtifactRow,
): Promise<SharingCategoryShare | null> {
  if (!ctx.config.allowCategorySharing || a.categoryKey === null) return null;
  const share = await ctx.env.DB.prepare(
    "SELECT * FROM category_shares WHERE owner_id = ?1 AND category_key = ?2",
  )
    .bind(a.ownerId, a.categoryKey)
    .first<ShareSql>();
  if (!share) return null;
  const state =
    a.categoryReviewShare === share.id && a.categoryReview ? a.categoryReview : "pending";
  return { id: share.id, title: share.title, state, people: await peopleOf(ctx.env.DB, share.id) };
}

// ---------- owner endpoints ----------

interface ShareSql {
  id: string;
  owner_id: string;
  category_key: string;
  name: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function toRow(s: ShareSql): CategoryShareRow {
  return {
    id: s.id,
    ownerId: s.owner_id,
    categoryKey: s.category_key,
    name: s.name,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/**
 * A token limited to one artifact gets 403 `token_bound` from every share, portal and
 * personal-category endpoint, first, so the answer is the same whatever the switch or the id.
 */
export function refuseBoundToken(p: Principal): void {
  if (seesCategorySharing(p)) return;
  throw new ApiError(
    "forbidden",
    "This token is limited to one artifact and has no category shares",
    {
      reason: "token_bound",
      next: "Category shares are managed in the app; use the app, or a token without that limit",
    },
  );
}

/** The signed-in owner, with the feature on. Agents and bearer tokens get 403, never a write. */
function requireShareOwner(ctx: Ctx): { userId: string; email: string } {
  refuseBoundToken(ctx.principal);
  if (!ctx.config.allowCategorySharing) {
    throw new ApiError("feature_disabled", "Sharing categories is not enabled on this instance");
  }
  const p = ctx.principal;
  if (!mayManageCategoryShares(p)) {
    if (p.kind === "anonymous") throw unauthorized();
    throw new ApiError("forbidden", "Share categories in the app", {
      reason: "app_only",
      next: "Ask the person to share the category on their dashboard",
    });
  }
  return { userId: p.userId, email: p.email };
}

async function ownShare(ctx: Ctx, ownerId: string, id: string): Promise<CategoryShareRow> {
  const s = await ctx.env.DB.prepare(
    "SELECT * FROM category_shares WHERE id = ?1 AND owner_id = ?2",
  )
    .bind(id, ownerId)
    .first<ShareSql>();
  if (!s) throw notFound("Category share");
  return toRow(s);
}

async function peopleOf(d1: D1Database, shareId: string): Promise<CategoryPerson[]> {
  const { results } = await d1
    .prepare("SELECT email, role FROM category_grants WHERE share_id = ?1 ORDER BY email")
    .bind(shareId)
    .all<CategoryPerson>();
  return results;
}

/**
 * Write the Worker's key on the owner's categorised rows from before migration 0013 (SQLite cannot
 * compute NFKC or Unicode lower case). Each update repeats the category it computed the key from,
 * so a concurrent re-file wins; a row missed here can only be pending (reviews need the key).
 */
export async function backfillCategoryKeys(ctx: Ctx, ownerId: string): Promise<void> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, category FROM artifacts
      WHERE owner_id = ?1 AND category IS NOT NULL AND category_key IS NULL`,
  )
    .bind(ownerId)
    .all<{ id: string; category: string }>();
  for (let i = 0; i < results.length; i += 50) {
    await ctx.env.DB.batch(
      results
        .slice(i, i + 50)
        .map((r) =>
          ctx.env.DB.prepare(
            "UPDATE artifacts SET category_key = ?1 WHERE id = ?2 AND category IS ?3 AND category_key IS NULL",
          ).bind(categoryKey(r.category), r.id, r.category),
        ),
    );
  }
}

/**
 * The share's counts. A taken-down artifact is never pending: no review applies to it (APPLY
 * refuses it), so counting it would leave a review banner the owner cannot clear.
 */
async function countsOf(
  d1: D1Database,
  share: CategoryShareRow,
): Promise<CategoryShareSummary["counts"]> {
  const r = await d1
    .prepare(
      `SELECT
         sum(CASE WHEN category_review = 'shared' AND category_review_share = ?3 THEN 1 ELSE 0 END) AS shared,
         sum(CASE WHEN category_review = 'private' AND category_review_share = ?3 THEN 1 ELSE 0 END) AS private,
         sum(CASE WHEN category_review_share IS NOT ?3 AND taken_down_at IS NULL THEN 1 ELSE 0 END)
           AS pending
         FROM artifacts WHERE owner_id = ?1 AND category_key = ?2 AND deleted_at IS NULL`,
    )
    .bind(share.ownerId, share.categoryKey, share.id)
    .first<{ shared: number | null; private: number | null; pending: number | null }>();
  return { shared: r?.shared ?? 0, private: r?.private ?? 0, pending: r?.pending ?? 0 };
}

async function summaryOf(ctx: Ctx, share: CategoryShareRow): Promise<CategoryShareSummary> {
  return {
    id: share.id,
    category: share.name,
    title: share.title,
    portal_url: appUrl(ctx.config, `/p/${share.id}`),
    people: await peopleOf(ctx.env.DB, share.id),
    counts: await countsOf(ctx.env.DB, share),
  };
}

/** GET /category-shares: the owner's shares. */
export async function listShares(ctx: Ctx): Promise<CategoryShareSummary[]> {
  const { userId } = requireShareOwner(ctx);
  await backfillCategoryKeys(ctx, userId);
  const { results } = await ctx.env.DB.prepare(
    "SELECT * FROM category_shares WHERE owner_id = ?1 ORDER BY name",
  )
    .bind(userId)
    .all<ShareSql>();
  const out: CategoryShareSummary[] = [];
  for (const s of results) out.push(await summaryOf(ctx, toRow(s)));
  return out;
}

/** GET /category-shares/:id: the share and every live artifact of the owner in its key. */
export async function getShare(ctx: Ctx, id: string): Promise<CategoryShareDetail> {
  const { userId } = requireShareOwner(ctx);
  await backfillCategoryKeys(ctx, userId);
  const share = await ownShare(ctx, userId, id);
  return { ...(await summaryOf(ctx, share)), artifacts: await shareArtifacts(ctx, share) };
}

/**
 * GET /category-shares/preview?category=: the artifacts a new share of this category would ask
 * the owner to review, with the version and category_rev each review item must quote. 404 for a
 * category the owner does not have; 409 when it is already shared (its own page lists them).
 */
export async function previewShare(ctx: Ctx, category: string): Promise<CategorySharePreview> {
  const { userId } = requireShareOwner(ctx);
  await backfillCategoryKeys(ctx, userId);
  const name = normalizeCategory(category);
  const key = categoryKey(name);
  const spellings = key ? await matchingSpellings(ctx, userId, name) : [];
  if (spellings.length === 0) throw notFound("Category");
  const existing = await ctx.env.DB.prepare(
    "SELECT id FROM category_shares WHERE owner_id = ?1 AND category_key = ?2",
  )
    .bind(userId, key)
    .first<{ id: string }>();
  if (existing) {
    throw new ApiError("conflict", "This category is already shared", {
      reason: "already_shared",
      share_id: existing.id,
    });
  }
  const probe: CategoryShareRow = {
    id: "",
    ownerId: userId,
    categoryKey: key,
    name: spellings[0] as string,
    title: "",
    createdAt: "",
    updatedAt: "",
  };
  return { category: probe.name, artifacts: await shareArtifacts(ctx, probe) };
}

async function shareArtifacts(ctx: Ctx, share: CategoryShareRow): Promise<CategoryShareArtifact[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT a.id, a.slug, a.title, a.current_version, a.category_rev, a.category_review,
            a.category_review_share, a.taken_down_at, a.updated_at,
            c.label AS conn_label, u.name AS user_name, u.email AS user_email
       FROM artifacts a
       LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
       LEFT JOIN agent_connections c ON c.id = v.created_by_connection
       LEFT JOIN users u ON u.id = v.created_by_user
      WHERE a.owner_id = ?1 AND a.category_key = ?2 AND a.deleted_at IS NULL
      ORDER BY a.updated_at DESC`,
  )
    .bind(share.ownerId, share.categoryKey)
    .all<{
      id: string;
      slug: string;
      title: string;
      current_version: number;
      category_rev: number;
      category_review: "shared" | "private" | null;
      category_review_share: string | null;
      taken_down_at: string | null;
      updated_at: string;
      conn_label: string | null;
      user_name: string | null;
      user_email: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    current_version: r.current_version,
    category_rev: r.category_rev,
    state:
      r.category_review_share === share.id && r.category_review ? r.category_review : "pending",
    taken_down: r.taken_down_at !== null,
    updated_at: r.updated_at,
    last_author: r.conn_label ?? r.user_name ?? r.user_email ?? null,
  }));
}

/** The people, deduplicated (a duplicate is 400) and without the owner's own address. */
function cleanPeople(people: CategoryPerson[], ownerEmail: string): CategoryPerson[] {
  const seen = new Map<string, CategoryRole>();
  for (const p of people) {
    if (p.email === ownerEmail) continue;
    if (seen.has(p.email)) {
      throw new ApiError("invalid_input", `Duplicate email: ${p.email}`, { field: "people" });
    }
    seen.set(p.email, p.role);
  }
  return [...seen].map(([email, role]) => ({ email, role }));
}

/** Review items: unique ids, at most the owner's artifact limit. */
async function checkReview(ctx: Ctx, userId: string, items: ReviewItem[]): Promise<void> {
  const user = await getUserById(ctx.db, userId);
  if (!user) throw unauthorized();
  const limit = artifactLimitFor(ctx.config, user);
  if (items.length > limit) {
    throw new ApiError("invalid_input", `A review holds at most ${limit} artifacts`, {
      field: "review",
    });
  }
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) {
      throw new ApiError("invalid_input", `Artifact ${it.id} appears twice in the review`, {
        field: "review",
      });
    }
    ids.add(it.id);
  }
}

/**
 * APPLY(decision): the guarded statement every review goes through. It re-states every fact the
 * owner approved: same artifact, same owner, still live and not taken down, still in the share's
 * current key (read from the share row inside the transaction) and, to share, the same version
 * and the same category_rev. Keeping an artifact private only takes access away, so it holds
 * whatever version the artifact reached meanwhile: a publish between opening the dialog and
 * saving it can never leave the artifact shared. ?1 decision, ?2 share id, ?3 owner, ?4 the
 * review items as JSON.
 */
function applyReview(
  d1: D1Database,
  decision: "shared" | "private",
  shareId: string,
  ownerId: string,
  items: string,
): D1PreparedStatement {
  const seen =
    decision === "shared"
      ? `AND json_extract(j.value, '$.version') = artifacts.current_version
                         AND json_extract(j.value, '$.category_rev') = artifacts.category_rev`
      : "";
  return d1
    .prepare(
      `UPDATE artifacts SET category_review = ?1, category_review_share = ?2
        WHERE owner_id = ?3 AND deleted_at IS NULL AND taken_down_at IS NULL
          AND category_key = (SELECT category_key FROM category_shares WHERE id = ?2 AND owner_id = ?3)
          AND EXISTS (SELECT 1 FROM json_each(?4) j
                       WHERE json_extract(j.value, '$.id') = artifacts.id
                         ${seen}
                         AND json_extract(j.value, '$.decision') = ?1)
       RETURNING id`,
    )
    .bind(decision, shareId, ownerId, items);
}

/**
 * RESET: no earlier review value survives into a new share or a new set of people. Every live
 * artifact of the owner bound to this share or in its current key becomes unreviewed (pending).
 */
function resetReviews(d1: D1Database, shareId: string, ownerId: string): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE artifacts SET category_review = NULL, category_review_share = NULL
        WHERE owner_id = ?2 AND deleted_at IS NULL
          AND (category_review_share = ?1
               OR category_key = (SELECT category_key FROM category_shares WHERE id = ?1 AND owner_id = ?2))`,
    )
    .bind(shareId, ownerId);
}

/** End every content pass on the artifacts the share's people could open (access epoch). */
function bumpSharedEpochs(d1: D1Database, shareId: string, ownerId: string): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE artifacts SET access_epoch = access_epoch + 1
        WHERE category_review_share = ?1 AND category_review = 'shared' AND owner_id = ?2
          AND deleted_at IS NULL
       RETURNING id`,
    )
    .bind(shareId, ownerId);
}

const bumpShareRev = (d1: D1Database, ownerId: string) =>
  d1
    .prepare("UPDATE users SET category_share_rev = category_share_rev + 1 WHERE id = ?1")
    .bind(ownerId);

/** Live room sockets of these artifacts re-check their pass (rooms/notify.ts). */
function revokeRooms(ctx: Ctx, results: D1Result | undefined): void {
  for (const r of (results?.results ?? []) as { id: string }[]) notifyRoom(ctx, r.id, "revoke");
}

const returnedIds = (r: D1Result | undefined) =>
  new Set(((r?.results ?? []) as { id: string }[]).map((x) => x.id));

/**
 * The review's answer: what was applied, and why the rest was skipped. Read once, after the batch:
 * gone (missing, deleted, not the owner's, taken down), moved (another key than the share's) or
 * changed (another version or category_rev than the owner was shown).
 */
async function reviewOutcome(
  ctx: Ctx,
  share: CategoryShareRow,
  items: ReviewItem[],
  shared: Set<string>,
  priv: Set<string>,
): Promise<CategoryReviewResult> {
  const missed = items.filter((i) => !shared.has(i.id) && !priv.has(i.id));
  const skipped: CategoryReviewResult["skipped"] = [];
  if (missed.length > 0) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, owner_id, deleted_at, taken_down_at, category_key, current_version, category_rev
         FROM artifacts WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
    )
      .bind(JSON.stringify(missed))
      .all<{
        id: string;
        owner_id: string;
        deleted_at: string | null;
        taken_down_at: string | null;
        category_key: string | null;
        current_version: number;
        category_rev: number;
      }>();
    const byId = new Map(results.map((r) => [r.id, r]));
    const key = await ctx.env.DB.prepare("SELECT category_key FROM category_shares WHERE id = ?1")
      .bind(share.id)
      .first<{ category_key: string }>();
    for (const it of missed) {
      const r = byId.get(it.id);
      let reason: ReviewSkipReason;
      if (!r || r.owner_id !== share.ownerId || r.deleted_at || r.taken_down_at) reason = "gone";
      else if (!key || r.category_key !== key.category_key) reason = "moved";
      else reason = "changed";
      skipped.push({ id: it.id, reason });
    }
  }
  return { shared: shared.size, private: priv.size, skipped };
}

const tooManyShares = () =>
  new ApiError(
    "quota_exceeded",
    `You can share at most ${LIMITS.maxCategorySharesPerOwner} categories`,
    { next: "Stop sharing a category you no longer need first" },
  );

/**
 * POST /category-shares: share one of the owner's categories with people, with the owner's review
 * of every artifact the dialog showed, in one batch: insert the share and its grants, reset every
 * artifact of the key, apply the review, bump the owner's share counter.
 */
export async function createShare(
  ctx: Ctx,
  input: {
    category: string;
    title?: string;
    people: CategoryPerson[];
    review: ReviewItem[];
  },
): Promise<CategoryShareWriteResult> {
  const { userId, email } = requireShareOwner(ctx);
  await backfillCategoryKeys(ctx, userId);
  const name = normalizeCategory(input.category);
  const key = categoryKey(name);
  const spellings = key ? await matchingSpellings(ctx, userId, name) : [];
  if (spellings.length === 0) {
    throw new ApiError("not_found", "You have no category with that name", {
      field: "category",
      next: "Pick one of your categories (GET /api/v1/categories)",
    });
  }
  const shares = await ctx.env.DB.prepare(
    "SELECT count(*) AS n FROM category_shares WHERE owner_id = ?1",
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((shares?.n ?? 0) >= LIMITS.maxCategorySharesPerOwner) throw tooManyShares();
  const people = cleanPeople(input.people, email);
  await checkReview(ctx, userId, input.review);
  // The owner's most-used spelling of the key is the share's name.
  const shareName = spellings[0] as string;
  const title = input.title?.trim() || shareName;
  const id = newId();
  const now = nowIso();
  const DB = ctx.env.DB;
  const items = JSON.stringify(input.review);
  let results: D1Result[];
  // The cap is checked again inside the INSERT, so parallel creates cannot pass it together. When
  // the INSERT adds nothing, every later statement finds no share row and changes nothing.
  const made = "EXISTS (SELECT 1 FROM category_shares WHERE id = ?1 AND owner_id = ?2)";
  try {
    results = await DB.batch([
      DB.prepare(
        `INSERT INTO category_shares (id, owner_id, category_key, name, title, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
          WHERE (SELECT count(*) FROM category_shares WHERE owner_id = ?2) < ?7`,
      ).bind(id, userId, key, shareName, title, now, LIMITS.maxCategorySharesPerOwner),
      DB.prepare(
        `INSERT INTO category_grants (share_id, email, role, created_at)
         SELECT ?1, json_extract(value, '$.email'), json_extract(value, '$.role'), ?3
           FROM json_each(?4) WHERE ${made}`,
      ).bind(id, userId, now, JSON.stringify(people)),
      resetReviews(DB, id, userId),
      applyReview(DB, "shared", id, userId, items),
      applyReview(DB, "private", id, userId, items),
      DB.prepare(
        `UPDATE users SET category_share_rev = category_share_rev + 1 WHERE id = ?2 AND ${made}`,
      ).bind(id, userId),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ApiError("conflict", "This category is already shared", {
        reason: "already_shared",
        next: "Change the people of its share instead",
      });
    }
    throw e;
  }
  if ((results[0]?.meta.changes ?? 0) === 0) throw tooManyShares();
  const share = await ownShare(ctx, userId, id);
  const review = await reviewOutcome(
    ctx,
    share,
    input.review,
    returnedIds(results[3]),
    returnedIds(results[4]),
  );
  return { share: await summaryOf(ctx, share), review };
}

/**
 * PATCH /category-shares/:id: a new title, new people, or both. New people always come with a
 * review: changing who sees a category re-confirms what they see. With people, one batch: end the
 * passes of everything shared so far, replace the grants, reset every artifact of the key, apply
 * the review, then drop personal categories of people who lost access.
 */
export async function updateShare(
  ctx: Ctx,
  id: string,
  input: { title?: string; people?: CategoryPerson[]; review?: ReviewItem[] },
): Promise<CategoryShareWriteResult> {
  const { userId, email } = requireShareOwner(ctx);
  if (input.people !== undefined && input.review === undefined) {
    throw new ApiError("invalid_input", "Send the review with the people", {
      reason: "review_required",
      field: "review",
      next: "Send review: every artifact of the category with shared or private",
    });
  }
  if (input.people === undefined && input.review !== undefined) {
    throw new ApiError("invalid_input", "A review without people goes to the review endpoint", {
      field: "review",
      next: "POST /api/v1/category-shares/:id/review with items",
    });
  }
  if (input.title === undefined && input.people === undefined) {
    throw new ApiError("invalid_input", "Send a title, people, or both", {
      next: 'Send {"title": "..."} or {"people": [...], "review": [...]}',
    });
  }
  await backfillCategoryKeys(ctx, userId);
  const share = await ownShare(ctx, userId, id);
  const DB = ctx.env.DB;
  const now = nowIso();
  const title = input.title?.trim();
  const setTitle = title
    ? DB.prepare(
        "UPDATE category_shares SET title = ?1, updated_at = ?2 WHERE id = ?3 AND owner_id = ?4",
      ).bind(title, now, id, userId)
    : null;
  if (input.people === undefined) {
    if (setTitle) await setTitle.run();
    return { share: await summaryOf(ctx, await ownShare(ctx, userId, id)), review: null };
  }
  const people = cleanPeople(input.people, email);
  const review = input.review ?? [];
  await checkReview(ctx, userId, review);
  const items = JSON.stringify(review);
  const owned = "EXISTS (SELECT 1 FROM category_shares WHERE id = ?1 AND owner_id = ?2)";
  const results = await DB.batch([
    bumpSharedEpochs(DB, id, userId),
    DB.prepare(
      `DELETE FROM category_grants WHERE share_id = ?1 AND ${owned}
          AND email NOT IN (SELECT json_extract(value, '$.email') FROM json_each(?3))`,
    ).bind(id, userId, JSON.stringify(people)),
    DB.prepare(
      `INSERT INTO category_grants (share_id, email, role, created_at)
       SELECT ?1, json_extract(value, '$.email'), json_extract(value, '$.role'), ?4
         FROM json_each(?3) WHERE ${owned}
       ON CONFLICT (share_id, email) DO UPDATE SET role = excluded.role`,
    ).bind(id, userId, JSON.stringify(people), now),
    resetReviews(DB, id, userId),
    applyReview(DB, "shared", id, userId, items),
    applyReview(DB, "private", id, userId, items),
    DB.prepare("UPDATE category_shares SET updated_at = ?1 WHERE id = ?2 AND owner_id = ?3").bind(
      now,
      id,
      userId,
    ),
    ...(setTitle ? [setTitle] : []),
    prunePersonalCategories(DB, { ownerId: userId }),
  ]);
  revokeRooms(ctx, results[0]);
  const outcome = await reviewOutcome(
    ctx,
    share,
    review,
    returnedIds(results[4]),
    returnedIds(results[5]),
  );
  return { share: await summaryOf(ctx, await ownShare(ctx, userId, id)), review: outcome };
}

/**
 * POST /category-shares/:id/review: share or keep private, per artifact. Never resets other rows.
 * Passes on artifacts that go from shared to private end first, in the same batch.
 */
export async function reviewShare(
  ctx: Ctx,
  id: string,
  items: ReviewItem[],
): Promise<CategoryReviewResult> {
  const { userId } = requireShareOwner(ctx);
  await backfillCategoryKeys(ctx, userId);
  const share = await ownShare(ctx, userId, id);
  await checkReview(ctx, userId, items);
  const DB = ctx.env.DB;
  const json = JSON.stringify(items);
  const results = await DB.batch([
    DB.prepare(
      `UPDATE artifacts SET access_epoch = access_epoch + 1
        WHERE owner_id = ?2 AND category_review_share = ?1 AND category_review = 'shared'
          AND deleted_at IS NULL
          AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3)
                      WHERE json_extract(value, '$.decision') = 'private')
       RETURNING id`,
    ).bind(id, userId, json),
    applyReview(DB, "shared", id, userId, json),
    applyReview(DB, "private", id, userId, json),
    prunePersonalCategories(DB, { ownerId: userId }),
  ]);
  revokeRooms(ctx, results[0]);
  return reviewOutcome(ctx, share, items, returnedIds(results[1]), returnedIds(results[2]));
}

/**
 * DELETE /category-shares/:id: stop sharing. Passes on what was shared end, the reviews bound to
 * the share are reset, the share goes (its grants and portal codes cascade), and the people lose
 * their personal categories on artifacts they can no longer open.
 */
export async function deleteShare(ctx: Ctx, id: string): Promise<void> {
  const { userId } = requireShareOwner(ctx);
  await ownShare(ctx, userId, id);
  const DB = ctx.env.DB;
  const results = await DB.batch([
    bumpSharedEpochs(DB, id, userId),
    DB.prepare(
      `UPDATE artifacts SET category_review = NULL, category_review_share = NULL
        WHERE category_review_share = ?1 AND owner_id = ?2`,
    ).bind(id, userId),
    DB.prepare("DELETE FROM category_shares WHERE id = ?1 AND owner_id = ?2").bind(id, userId),
    bumpShareRev(DB, userId),
    prunePersonalCategories(DB, { ownerId: userId }),
  ]);
  revokeRooms(ctx, results[0]);
}
