// Artifact categories (docs/spec.md "Categories"): the owner's own grouping of their artifacts, one
// free-text name per artifact, shown to the owner only (policy.ts seesOwnerMetadata). Names are
// derived from the artifacts that use them; there is no categories table. Every write normalises
// the name and snaps it onto the owner's existing spelling (shared categories.ts), so agents that
// spell a project slightly differently still file it in one place. Names are never logged.
import {
  type ArtifactSummary,
  type CategoryCount,
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  snapCategory,
} from "@plinth/shared";
import { eq } from "drizzle-orm";
import { type ArtifactRow, artifacts } from "../db/schema.ts";
import { ApiError, unauthorized } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { boundArtifactOf, mayBulkEditCategories, principalUserId } from "../policy.ts";
import { decideFor, requireArtifact, summaryFor } from "./artifacts.ts";
import type { Ctx } from "./context.ts";

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
 * written another way.
 */
export async function ownerCategories(
  ctx: Ctx,
  ownerId: string,
  excludeArtifactId?: string,
): Promise<CategoryCount[]> {
  const merged = mergeByKey(await ownerSpellings(ctx, ownerId, excludeArtifactId));
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
    .map((r) => r.name)
    .filter((n) => categoryKey(n) === key);
}

/**
 * The name to store: normalised (NFC, whitespace collapsed, trimmed), refused with 400 when empty,
 * too long or holding control, format or separator characters, then snapped onto the owner's
 * existing spelling with the same key (other than `excludeArtifactId`'s own).
 */
export async function resolveCategory(
  ctx: Ctx,
  ownerId: string,
  raw: string,
  excludeArtifactId?: string,
): Promise<string> {
  const name = normalizeCategory(raw);
  const problem = categoryProblem(name);
  if (problem) {
    throw new ApiError("invalid_input", problem, {
      field: "category",
      next: `Use a short project or repo name (1 to ${LIMITS.maxCategoryLength} characters), or reuse one from list_artifacts' categories`,
    });
  }
  const existing = mergeByKey(await ownerSpellings(ctx, ownerId, excludeArtifactId))
    .sort(byUse)
    .map((c) => c.name);
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
 * filing artifacts never reorders the dashboard. Neither creates a version.
 */
export async function patchArtifact(
  ctx: Ctx,
  ref: string,
  input: { title?: string; category?: string | null },
): Promise<ArtifactSummary> {
  const { artifact, role } = await requireArtifact(ctx, ref, "manage");
  const set: Partial<Pick<ArtifactRow, "title" | "updatedAt" | "category">> = {};
  if (input.title !== undefined) {
    set.title = input.title.trim();
    set.updatedAt = nowIso();
  }
  if (input.category !== undefined) {
    set.category =
      input.category === null
        ? null
        : await resolveCategory(ctx, artifact.ownerId, input.category, artifact.id);
  }
  if (Object.keys(set).length === 0) {
    throw new ApiError("invalid_input", "Send a title, a category, or both", {
      next: 'Send {"title": "..."} or {"category": "..."} (null clears the category)',
    });
  }
  await ctx.db.update(artifacts).set(set).where(eq(artifacts.id, artifact.id)).run();
  return summaryFor(ctx, { ...artifact, ...set }, role);
}

/**
 * POST /categories/rename: move every live artifact of the caller's in `from` (matched by key) to
 * `to`, which snaps onto one of the caller's other spellings (a merge); `to: null` clears it. The
 * signed-in owner only, never an agent or bearer token. Scoped to the caller's own rows; updated_at
 * is left alone and no version is created. The caller's open upload tickets with that name move
 * too. An inline update_artifact or PUT that resolved its name just before the rename and commits
 * just after it can still store the old name (a window of one request); the owner renames again.
 */
export async function renameCategory(
  ctx: Ctx,
  input: { from: string; to: string | null },
): Promise<{ updated: number; category: string | null }> {
  if (!mayBulkEditCategories(ctx.principal)) {
    if (ctx.principal.kind === "anonymous") throw unauthorized();
    throw new ApiError("forbidden", "Rename categories in the app", {
      next: "Ask the person to rename or merge the category on their dashboard",
    });
  }
  const uid = principalUserId(ctx.principal);
  if (!uid) throw unauthorized();
  const spellings = await matchingSpellings(ctx, uid, input.from);
  let category: string | null = null;
  if (input.to !== null) {
    const name = normalizeCategory(input.to);
    const problem = categoryProblem(name);
    if (problem) throw new ApiError("invalid_input", problem, { field: "to" });
    // Snap onto the owner's other names only: the ones being renamed must not pull it back.
    const others = (await ownerCategories(ctx, uid))
      .map((c) => c.name)
      .filter((n) => !spellings.includes(n));
    category = snapCategory(name, others);
  }
  // The caller's open start_upload tickets that carry this name follow it: a ticket stores the
  // spelling it snapped to at mint, and a bundle that commits after the rename would otherwise
  // bring the old name back (its key no longer matches anything to snap onto).
  const key = categoryKey(input.from);
  const { results: open } = await ctx.env.DB.prepare(
    "SELECT id, category FROM upload_tickets WHERE user_id = ?1 AND state = 'open' AND category IS NOT NULL",
  )
    .bind(uid)
    .all<{ id: string; category: string }>();
  const tickets = open
    .filter((t) => key !== "" && categoryKey(t.category) === key)
    .map((t) => t.id);
  const stmts: D1PreparedStatement[] = [];
  if (spellings.length > 0) {
    const marks = spellings.map((_, i) => `?${i + 3}`).join(", ");
    stmts.push(
      ctx.env.DB.prepare(
        `UPDATE artifacts SET category = ?1
          WHERE owner_id = ?2 AND deleted_at IS NULL AND category IN (${marks})`,
      ).bind(category, uid, ...spellings),
    );
  }
  if (tickets.length > 0) {
    const marks = tickets.map((_, i) => `?${i + 3}`).join(", ");
    stmts.push(
      ctx.env.DB.prepare(
        `UPDATE upload_tickets SET category = ?1
          WHERE user_id = ?2 AND state = 'open' AND id IN (${marks})`,
      ).bind(category, uid, ...tickets),
    );
  }
  if (stmts.length === 0) return { updated: 0, category };
  const results = await ctx.env.DB.batch(stmts);
  const updated = spellings.length > 0 ? (results[0]?.meta.changes ?? 0) : 0;
  return { updated, category };
}
