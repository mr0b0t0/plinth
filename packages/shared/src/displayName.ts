// Display names (docs/spec.md "Who is viewing: names and the people list"): the one free-text name
// a person may set on their account (users.name). It labels their comments and versions, and pages
// that declare `viewer` see it wherever they see the person's email. It is display text, never
// authority: role always comes from the server. Pure code, used by the Worker, the web app and
// tests. The character check lives here, not in a zod regex, so the JSON Schema MCP clients and
// OpenAPI consumers see stays a plain length-limited string.
import { LIMITS } from "./constants.ts";
import { REFUSED_CHARS } from "./text.ts";

const REFUSED_ALL = new RegExp(REFUSED_CHARS.source, "gu");

/** Stored form: NFC, every whitespace run (line breaks and separators included) -> one space, trimmed. */
export function normalizeDisplayName(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Why a (normalised) name is refused on write, or null: longer than LIMITS.maxDisplayNameLength,
 * containing "@" (it must not look like an email address or an agent mention), or containing
 * control or format (invisible, bidi) characters. Empty is allowed: it clears the name.
 */
export function displayNameProblem(s: string): string | null {
  if (s.length > LIMITS.maxDisplayNameLength) {
    return `A name is at most ${LIMITS.maxDisplayNameLength} characters`;
  }
  if (s.includes("@")) return "A name cannot contain @";
  if (REFUSED_CHARS.test(s)) return "A name cannot contain control or invisible characters";
  return null;
}

/**
 * The name as a page, a room or an agent sees it: normalised, refused characters and "@" dropped,
 * cut to LIMITS.maxPageDisplayNameLength code points (never inside a surrogate pair); null when
 * nothing is left. Applied on every read, so names stored before these rules are cleaned too.
 */
export function pageDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Whitespace first (line breaks and tabs become spaces), then the rest is dropped.
  const cleaned = normalizeDisplayName(
    normalizeDisplayName(raw).replace(REFUSED_ALL, "").replaceAll("@", ""),
  );
  const cut = Array.from(cleaned).slice(0, LIMITS.maxPageDisplayNameLength).join("").trim();
  return cut === "" ? null : cut;
}
