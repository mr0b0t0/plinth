// The slides type's source format (docs/spec.md "Slides"): Markdown with a line `---` between
// slides, optional front matter, speaker notes after a line starting `Note:` and `|||` lines for
// columns. One parser for the Worker (validation and publish warnings) and the renderer, so both
// read a deck the same way. Pure and zod-free, so the renderer bundle can import it.
//
// The split happens before Markdown: `text` followed by `---` is never a setext heading in a deck.

import { LIMITS } from "./constants.ts";

/** The fixed slide canvases, in CSS pixels. */
export const SLIDE_ASPECTS = {
  "16:9": { width: 1280, height: 720 },
  "4:3": { width: 1024, height: 768 },
} as const;
export type SlideAspect = keyof typeof SLIDE_ASPECTS;
export type DeckTheme = "auto" | "light" | "dark";

export interface DeckSettings {
  aspect: SlideAspect;
  theme: DeckTheme;
  paginate: boolean;
  /** Plain text shown on every slide; never Markdown. "" for none. */
  footer: string;
}

export const DEFAULT_DECK_SETTINGS: DeckSettings = {
  aspect: "16:9",
  theme: "auto",
  paginate: true,
  footer: "",
};

/** The longest footer kept; the rest is cut. */
export const MAX_DECK_FOOTER = 120;

/** At most this many columns per slide; parts past the last one join it. */
export const MAX_SLIDE_COLUMNS = 3;

export interface SlideSource {
  /** 1-based. */
  n: number;
  /** 1-based line of the slide's first line in the source. */
  line: number;
  /** Markdown before the first `|||` (the whole body when there are no columns). */
  head: string;
  /** [] without `|||`, else 2 or 3 bodies. */
  columns: string[];
  /** Markdown, "" when none. */
  notes: string;
}

export type DeckProblemCode = "slides_setting" | "slide_empty" | "slide_dense";

export interface DeckProblem {
  code: DeckProblemCode;
  /** 1-based source line. */
  line: number;
  slide?: number;
  message: string;
}

export interface ParsedDeck {
  settings: DeckSettings;
  slides: SlideSource[];
  problems: DeckProblem[];
}

/** Heuristic for slide_dense: a body over this many characters or non-blank lines. */
export const SLIDE_DENSE = { chars: 900, lines: 14 } as const;

/** Front matter must close within this many lines after its opening `---`. */
const FRONT_MATTER_LINES = 20;

const SEPARATOR_RE = /^---[ \t]*$/;
const COLUMN_RE = /^\|\|\|[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const NOTE_RE = /^(?:Note|Notes):/;
const ESCAPED_NOTE_RE = /^\\(Notes?:)/;
const SETTING_RE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/;

/** Tracks fenced code blocks line by line (CommonMark: closed by the same character, as long). */
class Fences {
  private open: { ch: string; len: number } | null = null;

  /** Feeds one line; true while that line is inside (or opens or closes) a fence. */
  step(line: string): boolean {
    const m = FENCE_RE.exec(line);
    if (this.open) {
      if (m?.[1] && m[1][0] === this.open.ch && m[1].length >= this.open.len) {
        if (line.slice(line.indexOf(m[1]) + m[1].length).trim() === "") this.open = null;
      }
      return true;
    }
    if (m?.[1]) {
      // A backtick fence's info string may not contain a backtick.
      const rest = line.slice(line.indexOf(m[1]) + m[1].length);
      if (m[1][0] === "`" && rest.includes("`")) return false;
      this.open = { ch: m[1][0] as string, len: m[1].length };
      return true;
    }
    return false;
  }

  get inside(): boolean {
    return this.open !== null;
  }
}

function settingProblem(line: number, message: string): DeckProblem {
  return { code: "slides_setting", line, message };
}

/** Reads front matter lines (between the two `---`) into settings, reporting what it ignores. */
function readSettings(lines: string[], first: number, problems: DeckProblem[]): DeckSettings {
  const s: DeckSettings = { ...DEFAULT_DECK_SETTINGS };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    const line = first + i;
    const m = SETTING_RE.exec(raw.trim());
    const key = m?.[1] ?? "";
    const value = m?.[2] ?? "";
    if (key === "aspect") {
      if (value === "16:9" || value === "4:3") s.aspect = value;
      else problems.push(settingProblem(line, `aspect is 16:9 or 4:3, not "${clip(value)}"`));
    } else if (key === "theme") {
      if (value === "auto" || value === "light" || value === "dark") s.theme = value;
      else
        problems.push(settingProblem(line, `theme is auto, light or dark, not "${clip(value)}"`));
    } else if (key === "paginate") {
      if (value === "true" || value === "false") s.paginate = value === "true";
      else problems.push(settingProblem(line, `paginate is true or false, not "${clip(value)}"`));
    } else if (key === "footer") {
      if (value.length > MAX_DECK_FOOTER) {
        problems.push(
          settingProblem(line, `footer is at most ${MAX_DECK_FOOTER} characters; the rest is cut`),
        );
      }
      s.footer = value.slice(0, MAX_DECK_FOOTER);
    } else {
      problems.push(
        settingProblem(
          line,
          `Unknown deck setting "${clip(key || raw.trim())}" is ignored (aspect, theme, paginate and footer are read)`,
        ),
      );
    }
  }
  return s;
}

/** At most 40 characters of text from the deck, for a message. */
function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Where front matter ends (the closing `---` line index), or -1 when line 0 does not open it. */
function frontMatterEnd(lines: string[]): number {
  if (!SEPARATOR_RE.test(lines[0] ?? "")) return -1;
  const last = Math.min(lines.length - 1, FRONT_MATTER_LINES + 1);
  for (let i = 1; i <= last; i++) {
    const l = lines[i] ?? "";
    if (SEPARATOR_RE.test(l)) return i > 1 ? i : -1;
    if (l.trim() !== "" && !SETTING_RE.test(l.trim())) return -1;
  }
  return -1;
}

interface RawSlide {
  /** 0-based index of the slide's first line. */
  start: number;
  lines: string[];
}

/** Turns one slide's lines into head, columns and notes. */
function splitSlide(raw: RawSlide, n: number, problems: DeckProblem[]): SlideSource {
  const fences = new Fences();
  const parts: string[][] = [[]];
  const notes: string[] = [];
  let inNotes = false;
  let extraColumns = false;
  for (let i = 0; i < raw.lines.length; i++) {
    let line = raw.lines[i] ?? "";
    if (inNotes) {
      notes.push(line);
      continue;
    }
    const wasInside = fences.inside;
    const fenced = fences.step(line);
    if (!wasInside && !fenced) {
      if (NOTE_RE.test(line)) {
        inNotes = true;
        notes.push(line.slice(line.indexOf(":") + 1).replace(/^[ \t]+/, ""));
        continue;
      }
      if (COLUMN_RE.test(line)) {
        if (parts.length > MAX_SLIDE_COLUMNS) extraColumns = true;
        else parts.push([]);
        continue;
      }
      if (ESCAPED_NOTE_RE.test(line)) line = line.slice(1);
    }
    (parts[parts.length - 1] as string[]).push(line);
  }
  const line = raw.start + 1;
  if (extraColumns) {
    problems.push({
      code: "slides_setting",
      line,
      slide: n,
      message: `Slide ${n} (line ${line}) has more than ${MAX_SLIDE_COLUMNS} columns; the rest join the last one`,
    });
  }
  const texts = parts.map((p) => p.join("\n"));
  let head = texts[0] ?? "";
  let columns = texts.slice(1);
  if (columns.length === 1) {
    problems.push({
      code: "slides_setting",
      line,
      slide: n,
      message: `Slide ${n} (line ${line}) has one column: put a ||| line before each column (2 or 3)`,
    });
    head = `${head}\n\n${columns[0]}`;
    columns = [];
  }
  return { n, line, head, columns, notes: notes.join("\n").trim() };
}

function bodyOf(s: SlideSource): string {
  return [s.head, ...s.columns].join("\n");
}

const isBlank = (s: string) => s.trim() === "";

/** Splits a deck. Linear in the input; CRLF is read as LF; never throws. */
export function parseDeck(text: string): ParsedDeck {
  const problems: DeckProblem[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let settings: DeckSettings = { ...DEFAULT_DECK_SETTINGS };
  let from = 0;
  const end = frontMatterEnd(lines);
  if (end > 0) {
    settings = readSettings(lines.slice(1, end), 2, problems);
    from = end + 1;
  }

  const raws: RawSlide[] = [];
  let current: RawSlide = { start: from, lines: [] };
  // Notes hold Markdown too: a separator inside a fence there does not split either.
  const fences = new Fences();
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const wasInside = fences.inside;
    const fenced = fences.step(line);
    if (!wasInside && !fenced && SEPARATOR_RE.test(line)) {
      raws.push(current);
      current = { start: i + 1, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  raws.push(current);

  const split = raws.map((r, i) => splitSlide(r, i + 1, []));
  // An empty slide (no body, no notes) before the first or after the last real one is dropped:
  // a deck that opens with `---` (not front matter) or ends with a stray `---`.
  const empty = (s: SlideSource) => isBlank(bodyOf(s)) && isBlank(s.notes);
  let lo = 0;
  let hi = split.length;
  while (lo < hi && empty(split[lo] as SlideSource)) lo++;
  while (hi > lo && empty(split[hi - 1] as SlideSource)) hi--;

  const slides: SlideSource[] = [];
  for (let i = lo; i < hi; i++) {
    const raw = raws[i] as RawSlide;
    const s = splitSlide(raw, slides.length + 1, problems);
    slides.push(s);
    const body = bodyOf(s);
    if (isBlank(body)) {
      problems.push({
        code: "slide_empty",
        line: s.line,
        slide: s.n,
        message: `Slide ${s.n} (line ${s.line}) is empty; remove the extra --- or give it content`,
      });
      continue;
    }
    const chars = body.trim().length;
    let nonBlank = 0;
    for (const l of body.split("\n")) if (!isBlank(l)) nonBlank++;
    if (chars > SLIDE_DENSE.chars || nonBlank > SLIDE_DENSE.lines) {
      const what =
        chars > SLIDE_DENSE.chars
          ? `${chars.toLocaleString("en-US")} characters`
          : `${nonBlank} lines`;
      problems.push({
        code: "slide_dense",
        line: s.line,
        slide: s.n,
        message: `Slide ${s.n} (line ${s.line}) is long (${what}) and will be shrunk to fit; split it or move detail into its Note:`,
      });
    }
  }
  return { settings, slides, problems };
}

/**
 * The relative image paths a deck's Markdown references outside code (`![alt](path)`), in order,
 * once each, without a leading "./" and before any "?" or "#". Absolute URLs, data: URLs,
 * fragments and root-absolute paths are left out.
 */
export function deckImagePaths(text: string): string[] {
  const out = new Set<string>();
  const fences = new Fences();
  const re = /!\[[^\]\n]*\]\(\s*<?([^\s)>]+)/g;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const wasInside = fences.inside;
    if (fences.step(line) || wasInside) continue;
    // Inline code spans are not images.
    const plain = line.replace(/`[^`]*`/g, "");
    for (const m of plain.matchAll(re)) {
      let p = m[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/") || p.startsWith("#")) continue;
      p = p.replace(/[?#].*$/, "").replace(/^(\.\/)+/, "");
      try {
        p = decodeURIComponent(p);
      } catch {
        // Keep the path as written.
      }
      if (p) out.add(p);
    }
  }
  return [...out];
}

/** Whether `n` is a slide number a message may carry: an integer from 1 to LIMITS.maxSlides. */
export function isSlideNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= LIMITS.maxSlides;
}
