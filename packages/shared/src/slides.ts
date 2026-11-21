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
export const FRONT_MATTER_LINES = 20;

const SEPARATOR_RE = /^---[ \t]*$/;
const COLUMN_RE = /^\|\|\|[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const NOTE_RE = /^(?:Note|Notes):/;
const ESCAPED_NOTE_RE = /^\\(Notes?:)/;
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*:/;
// Characters a value may not hold (what `.` does not match): a setting is one line.
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;

/**
 * A trimmed front matter line as `key: value`, or null. Without a regex that backtracks: front
 * matter lines can be as long as the deck, so this stays linear in the line.
 */
function readSetting(trimmed: string): { key: string; value: string } | null {
  const k = SETTING_KEY_RE.exec(trimmed);
  if (!k) return null;
  let i = k[0].length;
  while (trimmed[i] === " " || trimmed[i] === "\t") i++;
  const value = trimmed.slice(i);
  if (LINE_BREAK_RE.test(value)) return null;
  return { key: k[0].slice(0, -1), value };
}

/** Tracks fenced code blocks line by line (CommonMark: closed by the same character, as long). */
class Fences {
  private open: { ch: string; len: number } | null = null;

  /** Tracking that starts in the state `key` names (Fences.key): "" outside any fence. */
  static from(key: string): Fences {
    const f = new Fences();
    if (key !== "") f.open = { ch: key[0] as string, len: Number(key.slice(1)) };
    return f;
  }

  /** The state as a string: "" outside a fence, else the fence's character and length ("`3"). */
  get key(): string {
    return this.open ? `${this.open.ch}${this.open.len}` : "";
  }

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
    const m = readSetting(raw.trim());
    const key = m?.key ?? "";
    const value = m?.value ?? "";
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

/**
 * At most 40 characters of text from the deck, for a message. Control characters (C0 and DEL)
 * are written as \uXXXX, as the Worker's publish warnings echo a caller's text, so deck text never
 * reaches a terminal or a log as raw escape sequences through a message.
 */
function clip(s: string): string {
  const chars = [...s];
  let out = "";
  for (const ch of chars.slice(0, 40)) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
  }
  return chars.length > 40 ? `${out}…` : out;
}

/**
 * Where front matter ends (the closing `---` line index), or -1 when line 0 does not open it. It
 * reads at most FRONT_MATTER_LINES + 2 lines.
 */
export function frontMatterEnd(lines: readonly string[]): number {
  if (!SEPARATOR_RE.test(lines[0] ?? "")) return -1;
  const last = Math.min(lines.length - 1, FRONT_MATTER_LINES + 1);
  for (let i = 1; i <= last; i++) {
    const l = lines[i] ?? "";
    if (SEPARATOR_RE.test(l)) return i > 1 ? i : -1;
    if (l.trim() !== "" && !readSetting(l.trim())) return -1;
  }
  return -1;
}

// ---------- the deck's structure, line by line ----------

/**
 * What one line of a deck is: front matter (its opening `---`, a setting line, its closing
 * `---`), a slide separator, a column separator (`|||`), a notes marker (`Note:` or `Notes:`), or
 * text (everything else: Markdown, blank lines, and every line inside fenced code or after a
 * slide's notes marker).
 */
export type DeckLineKind =
  | "fm_open"
  | "setting"
  | "fm_close"
  | "separator"
  | "column"
  | "note"
  | "text";

/** Lines [start, end), 0-based. */
export interface DeckRange {
  start: number;
  end: number;
}

/** One raw slide: every run of lines between separators, empty ones at the edges included. */
export interface RawSlideLayout {
  /** 1-based, counting every raw slide. */
  n: number;
  /** The slide's lines, without the separators around it. */
  start: number;
  end: number;
  /** The lines before the first `|||` or notes marker. */
  head: DeckRange;
  /** After each `|||`, up to the next one or the notes marker (every one, past the third too). */
  columns: DeckRange[];
  /** From the notes marker to the slide's end, or null. */
  notes: DeckRange | null;
}

export interface DeckLayout {
  /** Every line's kind. */
  kinds: DeckLineKind[];
  /**
   * Whether each line is inside fenced code, or opens or closes it (the separator, column and
   * notes rules skip those lines). Front matter lines are never fenced.
   */
  fenced: boolean[];
  /** The fence state after each line (an opaque key): "" outside any fence. */
  fenceAfter: string[];
  /** frontMatterEnd: the front matter's closing line, or -1. */
  frontMatterEnd: number;
  slides: RawSlideLayout[];
}

/**
 * The deck's structure: every line's kind, the fence state after it, and the raw slides with the
 * ranges of their parts. Pure, linear in the lines, never throws. parseDeck reads decks through
 * it, so the room's checks (liveTypes.ts) and what a deck shows cannot disagree. The lines are a
 * deck's text split on "\n" after CRLF became LF (parseDeck does that first; a live draft holds
 * no "\r").
 */
export function deckLayout(lines: readonly string[]): DeckLayout {
  const n = lines.length;
  const kinds: DeckLineKind[] = new Array(n);
  const fenced: boolean[] = new Array(n);
  const fenceAfter: string[] = new Array(n);
  const fm = frontMatterEnd(lines);
  let from = 0;
  if (fm > 0) {
    for (let i = 0; i <= fm; i++) {
      kinds[i] = i === 0 ? "fm_open" : i === fm ? "fm_close" : "setting";
      fenced[i] = false;
      fenceAfter[i] = "";
    }
    from = fm + 1;
  }
  const slides: RawSlideLayout[] = [];
  let slide = newSlide(1, from);
  let part: DeckRange = slide.head;
  // One fence tracker for the whole deck, notes included: a separator inside a fence there does
  // not split either. Within a slide it is the one a slide's own split would keep, since a slide
  // starts outside any fence (a separator is read only there).
  const fences = new Fences();
  for (let i = from; i < n; i++) {
    const line = lines[i] ?? "";
    const wasInside = fences.inside;
    const inFence = fences.step(line);
    fenced[i] = wasInside || inFence;
    fenceAfter[i] = fences.key;
    const free = !wasInside && !inFence;
    if (free && SEPARATOR_RE.test(line)) {
      kinds[i] = "separator";
      part.end = i;
      slide.end = i;
      slides.push(slide);
      slide = newSlide(slides.length + 1, i + 1);
      part = slide.head;
      continue;
    }
    if (free && slide.notes === null) {
      if (NOTE_RE.test(line)) {
        kinds[i] = "note";
        part.end = i;
        slide.notes = { start: i, end: i + 1 };
        part = slide.notes;
        continue;
      }
      if (COLUMN_RE.test(line)) {
        kinds[i] = "column";
        part.end = i;
        part = { start: i + 1, end: i + 1 };
        slide.columns.push(part);
        continue;
      }
    }
    kinds[i] = "text";
    part.end = i + 1;
  }
  part.end = Math.max(part.end, n);
  slide.end = n;
  slides.push(slide);
  return { kinds, fenced, fenceAfter, frontMatterEnd: fm, slides };
}

function newSlide(n: number, start: number): RawSlideLayout {
  return { n, start, end: start, head: { start, end: start }, columns: [], notes: null };
}

/**
 * Whether each of `lines` is inside fenced code, or opens or closes it, starting outside any
 * fence (as DeckLayout.fenced reads them).
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  const f = new Fences();
  return lines.map((line) => {
    const wasInside = f.inside;
    return f.step(line) || wasInside;
  });
}

/** Whether a line opens fenced code (outside any fence). */
export function opensFence(line: string): boolean {
  return new Fences().step(line);
}

/** The fence state (a DeckLayout fenceAfter key) after `lines`, starting in state `key`. */
export function fenceStateAfter(key: string, lines: readonly string[]): string {
  const f = Fences.from(key);
  for (const l of lines) f.step(l);
  return f.key;
}

/**
 * Each line's kind as deckLayout reads it in a slide part, starting in fence state `key`:
 * "separator" outside fences; "column" and "note" too outside fences while the slide has no notes
 * yet (`inNotes` false), and every line after a "note" is text; anything else is "text".
 */
export function partLineKinds(
  key: string,
  lines: readonly string[],
  inNotes: boolean,
): DeckLineKind[] {
  const f = Fences.from(key);
  let notes = inNotes;
  return lines.map((line) => {
    const wasInside = f.inside;
    const inFence = f.step(line);
    if (wasInside || inFence) return "text";
    if (SEPARATOR_RE.test(line)) return "separator";
    if (notes) return "text";
    if (NOTE_RE.test(line)) {
      notes = true;
      return "note";
    }
    return COLUMN_RE.test(line) ? "column" : "text";
  });
}

/** Whether a line is a slide separator (`---`, trailing spaces and tabs allowed). */
export function isSeparatorLine(line: string | undefined): boolean {
  return line !== undefined && SEPARATOR_RE.test(line);
}

/** Whether a line is a notes marker (`Note:` or `Notes:` at its start). */
export function isNoteLine(line: string | undefined): boolean {
  return line !== undefined && NOTE_RE.test(line);
}

/** Whether a line, trimmed, reads as a `key: value` setting (what front matter is made of). */
export function readsAsSetting(line: string): boolean {
  return readSetting(line.trim()) !== null;
}

/** The marker word of a notes marker line ("Note" or "Notes"), and whether text follows it. */
export function noteMarkerOf(line: string): { word: "Note" | "Notes"; inline: boolean } | null {
  if (!NOTE_RE.test(line)) return null;
  const colon = line.indexOf(":");
  return {
    word: line.slice(0, colon) === "Notes" ? "Notes" : "Note",
    inline: line.slice(colon + 1).trim() !== "",
  };
}

/**
 * The text of a notes part (its marker line first), exactly as a slide shows it: what follows the
 * colon on the marker line, with leading spaces and tabs dropped, then the following lines,
 * trimmed.
 */
export function notesText(lines: readonly string[]): string {
  const [first, ...rest] = lines;
  if (first === undefined) return "";
  const head = first.slice(first.indexOf(":") + 1).replace(/^[ \t]+/, "");
  return [head, ...rest].join("\n").trim();
}

/** The Markdown of a head or column part, as a slide shows it: `\Note:` read as `Note:`. */
export function partText(lines: readonly string[], layout: DeckLayout, part: DeckRange): string {
  const out: string[] = [];
  for (let i = part.start; i < part.end; i++) {
    const line = lines[i] ?? "";
    out.push(!layout.fenced[i] && ESCAPED_NOTE_RE.test(line) ? line.slice(1) : line);
  }
  return out.join("\n");
}

/** Turns one raw slide into head, columns and notes, as the deck shows it. */
function splitSlide(
  lines: readonly string[],
  layout: DeckLayout,
  raw: RawSlideLayout,
  n: number,
  problems: DeckProblem[],
): SlideSource {
  // Parts past the third column join the last one (their ||| line is dropped).
  const parts: string[] = [partText(lines, layout, raw.head)];
  const cols = raw.columns;
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c] as DeckRange;
    const text = partText(lines, layout, col);
    if (c < MAX_SLIDE_COLUMNS) parts.push(text);
    else if (col.end > col.start) parts[parts.length - 1] = `${parts[parts.length - 1]}\n${text}`;
  }
  const line = raw.start + 1;
  if (cols.length > MAX_SLIDE_COLUMNS) {
    problems.push({
      code: "slides_setting",
      line,
      slide: n,
      message: `Slide ${n} (line ${line}) has more than ${MAX_SLIDE_COLUMNS} columns; the rest join the last one`,
    });
  }
  let head = parts[0] ?? "";
  let columns = parts.slice(1);
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
  const notes = raw.notes ? notesText(lines.slice(raw.notes.start, raw.notes.end)) : "";
  return { n, line, head, columns, notes };
}

function bodyOf(s: SlideSource): string {
  return [s.head, ...s.columns].join("\n");
}

const isBlank = (s: string) => s.trim() === "";

/**
 * The raw slides a deck shows, as indexes into deckLayout's slides [lo, hi): every one but the
 * empty ones (no body, no notes) before the first and after the last slide with content.
 */
export function shownRange(
  lines: readonly string[],
  layout: DeckLayout,
): { lo: number; hi: number } {
  const empty = (r: RawSlideLayout) => {
    const s = splitSlide(lines, layout, r, r.n, []);
    return isBlank(bodyOf(s)) && isBlank(s.notes);
  };
  let lo = 0;
  let hi = layout.slides.length;
  while (lo < hi && empty(layout.slides[lo] as RawSlideLayout)) lo++;
  while (hi > lo && empty(layout.slides[hi - 1] as RawSlideLayout)) hi--;
  return { lo, hi };
}

/** The settings and slides of a laid-out deck (parseDeck, without reading the text again). */
export function parseLaidOut(lines: readonly string[], layout: DeckLayout): ParsedDeck {
  const problems: DeckProblem[] = [];
  let settings: DeckSettings = { ...DEFAULT_DECK_SETTINGS };
  const end = layout.frontMatterEnd;
  if (end > 0) settings = readSettings(lines.slice(1, end), 2, problems);

  // An empty slide (no body, no notes) before the first or after the last real one is dropped:
  // a deck that opens with `---` (not front matter) or ends with a stray `---`.
  const { lo, hi } = shownRange(lines, layout);
  const slides: SlideSource[] = [];
  for (let i = lo; i < hi; i++) {
    const raw = layout.slides[i] as RawSlideLayout;
    const s = splitSlide(lines, layout, raw, slides.length + 1, problems);
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
 * A raw slide's own source as the deck shows it, for drawing every raw slide in edit mode (empty
 * ones at the edges included), numbered by its raw number.
 */
export function rawSlideSource(
  lines: readonly string[],
  layout: DeckLayout,
  raw: RawSlideLayout,
): SlideSource {
  return splitSlide(lines, layout, raw, raw.n, []);
}

/** Splits a deck. Linear in the input; CRLF is read as LF; never throws. */
export function parseDeck(text: string): ParsedDeck {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseLaidOut(lines, deckLayout(lines));
}

/**
 * What a change to a deck must keep (the room's rule 5 on every text edit, and every struct op's
 * postcondition; liveTypes.ts, slidesStruct.ts). `from[j]` is the line of `before` that line j of
 * `after` came from, or -1 for a line the edit or op put in (whose kinds its own checks cover). It
 * holds when every line that came from `before` has the kind it had there, and the front matter
 * (its lines and where it ends) is as it was, unless `op` is "set_deck", which writes it. It has
 * no merge clause: a deck draft is never merged.
 */
export function deckKeeps(
  before: readonly string[],
  after: readonly string[],
  from: readonly number[],
  op?: string,
  layouts?: { before?: DeckLayout; after?: DeckLayout },
): boolean {
  const a = layouts?.before ?? deckLayout(before);
  const b = layouts?.after ?? deckLayout(after);
  if (from.length !== after.length) return false;
  for (let j = 0; j < after.length; j++) {
    const i = from[j] as number;
    if (i < 0) continue;
    if (i >= before.length || a.kinds[i] !== b.kinds[j]) return false;
  }
  if (op === "set_deck") return true;
  if (a.frontMatterEnd !== b.frontMatterEnd) return false;
  for (let i = 0; i <= a.frontMatterEnd; i++) if (before[i] !== after[i]) return false;
  return true;
}

/**
 * The `from` map of deckKeeps for an edit that replaced `del` lines at `start` with `ins` lines:
 * each line of the result, the line it came from, or -1.
 */
export function editLineSources(total: number, start: number, del: number, ins: number): number[] {
  const out = new Array<number>(total - del + ins);
  for (let j = 0; j < out.length; j++) {
    out[j] = j < start ? j : j < start + ins ? -1 : j - ins + del;
  }
  return out;
}

/**
 * The relative image paths a deck's Markdown references outside code (`![alt](path)` or
 * `![alt](<path>)`), in order, once each, as files of the version: before any "?" or "#",
 * percent-decoded and with "." and ".." segments resolved from the deck's root, as the browser
 * resolves them. Absolute URLs, data: URLs, fragments and root-absolute paths are left out; a path
 * that climbs above the root is kept as written, so it is reported as missing.
 *
 * It runs on every deck publish over text up to LIMITS.maxSlidesBytes, so it is linear in the text:
 * one pass per line with no backtracking regex.
 */
export function deckImagePaths(text: string): string[] {
  const out = new Set<string>();
  const fences = new Fences();
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const wasInside = fences.inside;
    if (fences.step(line) || wasInside) continue;
    // Inline code spans are not images.
    for (const raw of imageDestinations(line.replace(/`[^`]*`/g, ""))) {
      const p = imageFile(raw);
      if (p) out.add(p);
    }
  }
  return [...out];
}

const isSpaceChar = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * The destinations of `![alt](dest` in one line, in order. The alt runs to the first "]"; an
 * angle-bracket destination runs to its ">" (spaces allowed), any other to the first space or ")".
 * Every "![" before the same "]" shares that alt's end and destination, so the search resumes after
 * it, and the next ">" is found once and reused: each character is looked at a bounded number of
 * times however many "![" the line holds.
 */
function imageDestinations(line: string): string[] {
  const found: string[] = [];
  let angle = -1; // index of the next ">" at or after the search point, or line.length for none
  let i = line.indexOf("![");
  while (i >= 0) {
    const close = line.indexOf("]", i + 2);
    if (close < 0) break;
    if (line[close + 1] !== "(") {
      i = line.indexOf("![", close + 1);
      continue;
    }
    let d = close + 2;
    while (isSpaceChar(line[d])) d++;
    let dest = "";
    let after = d;
    if (line[d] === "<") {
      if (angle < d + 1) {
        const at = line.indexOf(">", d + 1);
        angle = at < 0 ? line.length : at;
      }
      if (angle >= line.length) {
        i = line.indexOf("![", close + 1);
        continue;
      }
      dest = line.slice(d + 1, angle);
      after = angle + 1;
    } else {
      let e = d;
      while (e < line.length && line[e] !== ")" && !isSpaceChar(line[e])) e++;
      dest = line.slice(d, e);
      after = e;
    }
    if (dest !== "" && !dest.includes("<")) found.push(dest);
    i = line.indexOf("![", after);
  }
  return found;
}

/** A destination as a file path of the version, or "" when it names no file of it. */
function imageFile(dest: string): string {
  let p = dest.trim();
  if (p === "" || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/") || p.startsWith("#"))
    return "";
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep the path as written.
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return p;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Whether `n` is a slide number a message may carry: an integer from 1 to LIMITS.maxSlides. */
export function isSlideNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= LIMITS.maxSlides;
}
