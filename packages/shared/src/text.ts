// Character rules shared by the free-text names people choose (categories, display names). Pure
// code, used by the Worker, the web app and tests.

/**
 * Control (Cc) and format (Cf: bidi overrides, zero-width) characters. Line breaks, tabs and the
 * line (Zl) and paragraph (Zp) separators are whitespace, so a normaliser that collapses
 * whitespace has already turned them into a space; Zl and Zp stay here only for a caller that
 * skips normalising.
 */
export const REFUSED_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
