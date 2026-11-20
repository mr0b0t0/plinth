// Artifact categories (docs/spec.md "Categories"): the owner's own grouping, one free-text name per
// artifact. Pure helpers used by the Worker (validation and snapping on every write), the web app
// (the snap hint) and tests. The character check lives here, not in a zod regex, so the JSON Schema
// MCP clients and OpenAPI consumers see stays a plain length-limited string.
import { LIMITS } from "./constants.ts";
import { REFUSED_CHARS } from "./text.ts";

/** Stored form: NFC, every whitespace run (line breaks and separators included) -> one space, trimmed. */
export function normalizeCategory(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Why a (normalised) name is refused, or null: empty, longer than LIMITS.maxCategoryLength,
 * containing control or format (invisible) characters, or made only of spaces, "-" and "_" (its
 * key would be empty, so it could never be filtered, renamed or merged).
 */
export function categoryProblem(s: string): string | null {
  if (s.length === 0) return "A category needs at least one character";
  if (s.length > LIMITS.maxCategoryLength) {
    return `A category is at most ${LIMITS.maxCategoryLength} characters`;
  }
  if (REFUSED_CHARS.test(s)) {
    return "A category cannot contain control or invisible characters";
  }
  if (categoryKey(s) === "") {
    return "A category needs a character other than spaces, '-' and '_'";
  }
  return null;
}

/**
 * Match key: NFKC, lower case, runs of whitespace, "-" and "_" -> one space, trimmed. "." and "/"
 * are kept, so "a.b" and "a b" stay distinct. Stored since migration 0013 as
 * artifacts.category_key and category_shares.category_key, which a category share matches on: a
 * change to this function needs a migration that recomputes both columns.
 */
export function categoryKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_]+/gu, " ")
    .trim();
}

/** The existing spelling whose key equals categoryKey(name), else name. */
export function snapCategory(name: string, existing: readonly string[]): string {
  const key = categoryKey(name);
  return existing.find((e) => categoryKey(e) === key) ?? name;
}

// ---------- category sharing (docs/spec.md "Category sharing and personal categories") ----------

/** The roles a category grant may give: never editor. */
export const CATEGORY_ROLES = ["viewer", "commenter"] as const;
export type CategoryRole = (typeof CATEGORY_ROLES)[number];

/**
 * Where an artifact stands in its category's share, as its owner sees it: `shared` and `private`
 * once the owner reviewed it into this share, `pending` until then (every artifact filed under a
 * shared category starts pending, whoever filed it).
 */
export const CATEGORY_SHARE_STATES = ["shared", "pending", "private"] as const;
export type CategoryShareState = (typeof CATEGORY_SHARE_STATES)[number];

/** Why a review item was not applied: the artifact changed since the owner was shown it. */
export const REVIEW_SKIP_REASONS = ["moved", "changed", "gone"] as const;
export type ReviewSkipReason = (typeof REVIEW_SKIP_REASONS)[number];
