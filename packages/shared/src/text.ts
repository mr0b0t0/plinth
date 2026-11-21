// Character rules shared by the free-text names people choose (categories, display names). Pure
// code, used by the Worker, the web app and tests.

/**
 * Characters a short label never shows: control (Cc) and format (Cf: bidi overrides and isolates,
 * zero-width spaces and joiners, the BOM) characters, and the line and paragraph separators
 * (U+2028, U+2029). They can reorder or hide what a label says. One set for every label that comes
 * from someone else's text: Ask an agent's block words, page anchors, picked file names, titles
 * made from them and sheet names read from a file. A joiner inside an emoji sequence is Cf too and
 * goes like any other ("👨‍👩‍👧" reads as three people): one rule, with no exceptions to get wrong.
 * Global, for `replace` (stripUnsafeText); test with REFUSED_CHARS.
 */
export const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

/** `s` without the characters of UNSAFE_TEXT_RE. */
export function stripUnsafeText(s: string): string {
  return s.replace(UNSAFE_TEXT_RE, "");
}

/**
 * UNSAFE_TEXT_RE as a test of one character, for refusing a name or label that holds any. Line
 * breaks, tabs and the line (Zl) and paragraph (Zp) separators are whitespace, so a normaliser that
 * collapses whitespace has already turned them into a space; they stay here only for a caller that
 * skips normalising.
 */
export const REFUSED_CHARS = new RegExp(UNSAFE_TEXT_RE.source.slice(0, -1), "u");
