// Artifact categories (docs/spec.md "Categories"): the owner's own grouping, one free-text name per
// artifact. Pure helpers used by the Worker (validation and snapping on every write), the web app
// (the snap hint) and tests. The character check lives here, not in a zod regex, so the JSON Schema
// MCP clients and OpenAPI consumers see stays a plain length-limited string.
import { LIMITS } from "./constants.ts";

/**
 * Control (Cc) and format (Cf: bidi overrides, zero-width) characters. Line breaks, tabs and the
 * line (Zl) and paragraph (Zp) separators are whitespace, so normalizeCategory has already turned
 * them into a space; Zl and Zp stay here only for a caller that skips normalising.
 */
const REFUSED_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
 * Match key, never stored: NFKC, lower case, runs of whitespace, "-" and "_" -> one space, trimmed.
 * "." and "/" are kept, so "a.b" and "a b" stay distinct.
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
