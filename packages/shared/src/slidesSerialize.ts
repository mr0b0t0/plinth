// Slide text as Markdown (slides-text): the formatted-text model of one block of a slide
// (markdownSerialize.ts, which holds the CommonMark and GitHub rules) written back for a deck, so
// that what a person types can never change the deck's structure. A deck splits before Markdown
// (slides.ts), so a few lines that are ordinary Markdown are structure in a deck; this file
// escapes them, part by part, exactly as slides.ts reads them:
//
// - In a slide's head or a column: a line that would read `---` (a setext heading's underline is
//   written `----`, which underlines the same), a line starting `Note:` or `Notes:` (written
//   `\Note:`, which the deck reads back as `Note:`), and a line `|||` (written `\|||`).
// - In the notes part: only `---`. Once notes have started, `Note:` and `|||` are ordinary text,
//   and escaping them would show a stray backslash.
// - In the raw slide right after a bare opening `---` (a deck whose line 0 is `---` with no front
//   matter): a line that would read as a `key: value` setting gets its first colon escaped
//   (`Date\: 3 March`, which renders as `Date: 3 March`), so the slide can never become front
//   matter. Other slides need no such escape: front matter is read only from line 0.
//
// Speaker notes are one part, marker line included. serializeNotes keeps the marker word (`Note`
// or `Notes`) and its form: text on the marker line (`Note: Welcome everyone.`), or the marker on
// its own line. Pure and zod-free, so the renderer bundle can import it.
import {
  DOC_DIALECT,
  type MarkdownDialect,
  type RichBlock,
  serializeBlock,
} from "./markdownSerialize.ts";
import { fencedLines, isNoteLine, isSeparatorLine, opensFence, readsAsSetting } from "./slides.ts";

/** Where in a deck a block's lines go. */
export interface DeckPartContext {
  /** The notes part (after the marker line), not a slide's head or a column. */
  notes: boolean;
  /** The raw slide right after a bare opening `---`: setting-like lines are escaped too. */
  settings: boolean;
}

const COLUMN_LINE_RE = /^\|\|\|[ \t]*$/;
const ESCAPED_NOTE_RE = /^\\(Notes?:)/;

/** A `---` line the Markdown layer wrote (a setext underline): one more `-` underlines the same. */
const longer = (line: string) => `-${line}`;

/**
 * Escapes deck structure in Markdown lines written for one block of a slide part (a block never
 * starts inside fenced code). Lines inside fenced code are kept: the deck reads no structure
 * there, except that a separator inside a fence still never splits. Linear in the lines.
 */
export function escapeDeckPart(lines: readonly string[], ctx: DeckPartContext): string[] {
  const fenced = fencedLines(lines);
  return lines.map((line, i) => {
    if (fenced[i]) return line;
    if (isSeparatorLine(line)) return longer(line);
    let out = line;
    if (!ctx.notes) {
      if (isNoteLine(out)) out = `\\${out}`;
      else if (COLUMN_LINE_RE.test(out)) out = `\\${out}`;
    }
    if (ctx.settings && readsAsSetting(out)) {
      const colon = out.indexOf(":");
      out = `${out.slice(0, colon)}\\${out.slice(colon)}`;
    }
    return out;
  });
}

/**
 * Lines of a head or column part as the deck hands them to Markdown: `\Note:` and `\Notes:`
 * outside fenced code lose their backslash (slides.ts partText). Notes are handed over as they are.
 */
export function deckPartShown(lines: readonly string[], notes: boolean): string[] {
  if (notes) return [...lines];
  const fenced = fencedLines(lines);
  return lines.map((line, i) => (!fenced[i] && ESCAPED_NOTE_RE.test(line) ? line.slice(1) : line));
}

/** One block of a slide part as the lines the deck stores: "" (none) for an empty block. */
export function serializeDeckBlock(
  block: RichBlock,
  ctx: DeckPartContext,
  d: MarkdownDialect = DOC_DIALECT,
): string[] {
  const md = serializeBlock(block, d);
  return md === "" ? [] : escapeDeckPart(md.split("\n"), ctx);
}

/** How a notes part is written: its marker word, and whether text follows it on its line. */
export interface NotesForm {
  word: "Note" | "Notes";
  inline: boolean;
}

/** The form of a notes part from its marker line (the default for new notes: `Note:` alone). */
export function notesFormOf(marker: string | undefined): NotesForm {
  if (marker === undefined || !isNoteLine(marker)) return { word: "Note", inline: false };
  const colon = marker.indexOf(":");
  return {
    word: marker.slice(0, colon) === "Notes" ? "Notes" : "Note",
    inline: marker.slice(colon + 1).trim() !== "",
  };
}

/**
 * A notes part as lines, marker first: the blocks' Markdown (escaped for notes), one blank line
 * between blocks. With `form.inline` the first line goes on the marker line after `Note: `, as in
 * `Note: Welcome everyone.`; otherwise the marker stands alone. A first line that starts with
 * white space (which reading the marker line would drop) or that opens fenced code (which the deck
 * would not see on the marker line) always uses the alone form. No blocks: the marker alone.
 * `settings`: the notes of the raw slide right after a bare opening `---` (escapeDeckPart).
 * Throws as serializeBlock does for what the dialect cannot hold.
 */
export function serializeNotes(
  blocks: readonly RichBlock[],
  form: NotesForm,
  settings = false,
  d: MarkdownDialect = DOC_DIALECT,
): string[] {
  const parts = blocks.map((b) => serializeBlock(b, d)).filter((md) => md !== "");
  const marker = `${form.word}:`;
  if (parts.length === 0) return [marker];
  const lines = escapeDeckPart(parts.join("\n\n").split("\n"), { notes: true, settings });
  const first = lines[0] as string;
  if (form.inline && first !== "" && !/^\s/.test(first) && !opensFence(first)) {
    return [`${marker} ${first}`, ...lines.slice(1)];
  }
  return [marker, ...lines];
}
