// Display names (docs/spec.md "Who is viewing: names and the people list"): the one free-text name
// a person may set on their account (users.name). It labels their comments and versions, and pages
// that declare `viewer` see it wherever they see the person's email. It is display text, never
// authority: role always comes from the server. Pure code, used by the Worker, the web app and
// tests. The character check lives here, not in a zod regex, so the JSON Schema MCP clients and
// OpenAPI consumers see stays a plain length-limited string.
import { LIMITS } from "./constants.ts";
import { REFUSED_CHARS } from "./text.ts";

const REFUSED_ALL = new RegExp(REFUSED_CHARS.source, "gu");

/**
 * Every character whose compatibility form (NFKC) is "@": the ASCII sign, SMALL COMMERCIAL AT
 * (U+FE6B) and FULLWIDTH COMMERCIAL AT (U+FF20). NFC keeps the last two, and they render as "@",
 * so a name holding one could pass for an email address. Names are not NFKC-normalised instead,
 * because that would rewrite other characters people choose (ligatures, superscripts, fullwidth
 * letters).
 */
const AT_SIGN = /[@\uFE6B\uFF20]/u;
const AT_SIGN_ALL = new RegExp(AT_SIGN.source, "gu");

/**
 * Characters that are letters but render as nothing: the Hangul fillers (U+115F, U+1160, U+3164,
 * U+FFA0). With the blank Braille pattern (U+2800, a symbol) they never count as visible.
 */
const BLANK_CHARS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * Does the name show anything: at least one letter, number, symbol or punctuation mark that is
 * not a blank one (BLANK_CHARS)? A name made only of fillers, blank Braille, spaces or combining
 * marks would show as nothing beside a comment, and hide who wrote it.
 */
function visible(s: string): boolean {
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(s.replace(BLANK_CHARS, ""));
}

/** Stored form: NFC, every whitespace run (line breaks and separators included) -> one space, trimmed. */
export function normalizeDisplayName(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Why a (normalised) name is refused on write, or null: longer than LIMITS.maxDisplayNameLength,
 * containing "@" or a character that renders as one (it must not look like an email address or an
 * agent mention), containing control or format (invisible, bidi) characters, or showing nothing
 * (no visible character: only fillers, blank Braille or combining marks). Empty is allowed: it
 * clears the name. The message is a full sentence, shown as it is by the app and the API.
 */
export function displayNameProblem(s: string): string | null {
  if (s.length > LIMITS.maxDisplayNameLength) {
    return `A name is at most ${LIMITS.maxDisplayNameLength} characters.`;
  }
  if (AT_SIGN.test(s)) return "A name cannot contain @.";
  if (REFUSED_CHARS.test(s)) return "A name cannot contain control or invisible characters.";
  if (s !== "" && !visible(s)) return "A name needs a letter, number or symbol you can see.";
  return null;
}

/**
 * The name as a page, a room, an agent or the app sees it: normalised, refused characters and every
 * "@" (AT_SIGN) dropped, cut to LIMITS.maxPageDisplayNameLength code points (never inside a
 * surrogate pair); null when nothing visible is left (see displayNameProblem). Applied on every
 * read, so names stored before these rules are cleaned too.
 */
export function pageDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Whitespace first (line breaks and tabs become spaces), then the rest is dropped.
  const cleaned = normalizeDisplayName(
    normalizeDisplayName(raw).replace(REFUSED_ALL, "").replace(AT_SIGN_ALL, ""),
  );
  const cut = Array.from(cleaned).slice(0, LIMITS.maxPageDisplayNameLength).join("").trim();
  return cut === "" || !visible(cut) ? null : cut;
}
