// Text helpers for change lists: whitespace folding, excerpts, quoted names, and the excerpts of
// two texts around where they differ.
import { CHANGE_LIMITS } from "./limits.ts";

/**
 * Bidirectional controls: embeddings and overrides (U+202A to U+202E), isolates (U+2066 to
 * U+2069) and the marks LRM, RLM and ALM. In an excerpt they could reorder what the list shows,
 * so the text of another version reads as something it does not say. This is narrower than
 * REFUSED_CHARS (text.ts at the package root): an excerpt keeps the joiners that emoji sequences
 * and scripts such as Persian need.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** `s` without bidirectional controls. */
export function withoutBidi(s: string): string {
  return s.replace(BIDI_CONTROLS, "");
}

/** Bidirectional controls dropped, runs of whitespace become one space; the ends are trimmed. */
export function foldSpace(s: string): string {
  return withoutBidi(s).replace(/\s+/g, " ").trim();
}

/**
 * At most `max` characters of `s` with its whitespace folded, cut at a word boundary with "…"
 * when it is longer.
 */
export function changeExcerpt(s: string, max: number = CHANGE_LIMITS.excerptChars): string {
  const text = foldSpace(s);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = text[max - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A name for a sentence, in typographic quotes: “Pricing”. */
export function quoted(name: string): string {
  return `“${changeExcerpt(name, CHANGE_LIMITS.nameChars)}”`;
}

/**
 * Excerpts of two texts that show where they differ: both start a little before the first
 * character that differs (at a word boundary, with a leading "…" when text was skipped), so a
 * change deep in a long paragraph is still in view.
 */
export function differenceExcerpts(
  before: string,
  after: string,
  max: number = CHANGE_LIMITS.excerptChars,
): { before: string; after: string } {
  const a = foldSpace(before);
  const b = foldSpace(after);
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a[p] === b[p]) p++;
  const lead = 40;
  if (p <= lead || (a.length <= max && b.length <= max)) {
    return { before: changeExcerpt(a, max), after: changeExcerpt(b, max) };
  }
  let start = p - lead;
  const space = a.lastIndexOf(" ", start);
  start = space > 0 ? space + 1 : start;
  return {
    before: `…${changeExcerpt(a.slice(start), max - 1)}`,
    after: `…${changeExcerpt(b.slice(start), max - 1)}`,
  };
}

/** "1 link", "3 links". */
export function count(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  times: "×",
  euro: "€",
  pound: "£",
};

/**
 * Character references in text, as a browser shows them: the common named ones and every numeric
 * one (a code point that is not a character becomes U+FFFD). Unknown names stay as written.
 */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});?/g,
    (m, ref) => {
      if (ref[0] !== "#") return Object.hasOwn(NAMED, ref) ? (NAMED[ref] as string) : m;
      const code =
        ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return "�";
      }
      return String.fromCodePoint(code);
    },
  );
}
