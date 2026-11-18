// Artifact categories (docs/spec.md "Categories"): the owner's own grouping of their artifacts, one
// free-text name per artifact, shown to the owner only (policy.ts seesOwnerMetadata). Names are
// derived from the artifacts that use them; there is no categories table. Every write normalises
// the name and snaps it onto the owner's existing spelling (shared categories.ts), so agents that
// spell a project slightly differently still file it in one place. Names are never logged.
import {
  type CategoryCount,
  categoryKey,
  categoryProblem,
  LIMITS,
  normalizeCategory,
  snapCategory,
} from "@plinth/shared";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { decideFor } from "./artifacts.ts";
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
  throw new ApiError("forbidden", "Only the owner sets an artifact's category", {
    field: "category",
    reason: "owner_only",
    next: "Leave category out when you change an artifact you do not own",
  });
}
