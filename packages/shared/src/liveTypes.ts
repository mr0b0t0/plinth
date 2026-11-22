// On-page editing (#36) per type: what the room, the renderers and the app check about a live
// draft of each type whose registry row has `edit: "live"` (docs, decks, sheets and design systems,
// whose draft is a line projection of its JSON: designSystemLive.ts). The room enforces
// these on every edit, structural change and merge; the renderers use the same rules to check
// before they send, so a refusal from the room means another socket changed the lines first, or
// the edit was forged. No zod, so the renderer bundles can import it.
//
// A doc's draft is Markdown: any lines, up to LIMITS.maxDocBytes and LIMITS.maxLiveDocLines, as
// long as the text does not start like a whole HTML document (the publish hook refuses that).
// A sheet's draft is its canonical JSON lines (serializeSheet): line 0 the header, then one row
// per line. Every line an edit puts in must be a valid row (or, on line 0, a header with the same
// number of columns) in its one canonical spelling, so the draft always is what a version stores
// and a checkpoint saves it byte for byte. A text edit changes the line count only by appending
// rows at the end: rows in the middle move only through `struct`, which rewrites the formula
// references the move shifts.
// A deck's draft is its Markdown (slides.md) with LF line ends. A text edit stays inside one part
// of one raw slide (a head, a column or its notes) and keeps every line's structural kind, the
// fence state and the front matter (the structure rule, checkDeckEdit), so the deck's slides,
// columns, notes and settings change only through `struct` (slidesStruct.ts). A draft may show no
// slide; it is then not publishable ("empty").
//
// What happens to a changed draft when a version is published meanwhile is `merge`: a doc keeps
// #49's rule (merged when merge3 is clean and the result fits, reviewed otherwise); a draft of every
// other type is never merged: it is frozen and reviewed whole beside that version.
import { type ArtifactType, HTML_DOCUMENT_RE } from "./artifactTypes.ts";
import { LIMITS } from "./constants.ts";
import {
  checkDesignSystemEdit,
  designSystemFromLive,
  designSystemToLive,
  liveDesignSystemTooLarge,
  validDesignSystemDraft,
} from "./designSystemLive.ts";
import { applyDesignSystemStruct, DS_STRUCT_KINDS, type DsStructOp } from "./designSystemStruct.ts";
import type { LiveDocErrorCode } from "./liveDoc.ts";
import type { LineRange } from "./liveLines.ts";
import {
  checkRow,
  isFormula,
  parseSheet,
  type SheetHeader,
  serializeSheet,
  trimRow,
} from "./sheet/format.ts";
import { applySheetStruct, SHEET_STRUCT_KINDS, type SheetStructOp } from "./sheet/ops.ts";
import {
  type DeckLayout,
  type DeckRange,
  deckKeeps,
  deckLayout,
  editLineSources,
  FRONT_MATTER_LINES,
  fenceStateAfter,
  frontMatterEnd,
  parseDeck,
  partLineKinds,
} from "./slides.ts";
import {
  applySlidesStruct,
  deckDraftValid,
  SLIDES_STRUCT_KINDS,
  type SlidesStructOp,
  slidesTouches,
} from "./slidesStruct.ts";

/** UTF-8 bytes of a string. */
function utf8(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** More than `max` lines? Counted without splitting. */
function moreLinesThan(text: string, max: number): boolean {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (++lines > max) return true;
  }
  return false;
}

/** Whether a draft text is past what a doc may hold: LIMITS.maxDocBytes or maxLiveDocLines. */
export function liveDocTooLarge(text: string): boolean {
  if (text.length > LIMITS.maxDocBytes || utf8(text) > LIMITS.maxDocBytes) return true;
  return moreLinesThan(text, LIMITS.maxLiveDocLines);
}

/** Whether a sheet draft is past LIMITS.maxSheetBytes or holds more than LIMITS.maxSheetRows rows. */
export function liveSheetTooLarge(text: string): boolean {
  if (text.length > LIMITS.maxSheetBytes || utf8(text) > LIMITS.maxSheetBytes) return true;
  return moreLinesThan(text, LIMITS.maxSheetRows + 1);
}

/**
 * How the lines that a structural op leaves untouched moved: `map[i]` is where old line i is now,
 * or -1 when the op removed or rewrote it.
 */
export type LineMap = readonly number[];

/** Every live type's structural op: a sheet's rows and columns, a design system's keys, a deck's notes and settings. */
export type LiveStructOp = SheetStructOp | DsStructOp | SlidesStructOp;

/**
 * A type's structural ops (a sheet's rows and columns: insert, delete, and move rows; a design
 * system's keys: dark values, optional texts, tokens; a deck's notes and settings), as the room
 * and the renderers apply them.
 */
export interface LiveStructRules {
  /** The op kinds this type takes. The room refuses an op of another kind with `invalid`. */
  kinds: readonly string[];
  /**
   * Pure: the new lines, or why not. With real ranges from `touches`, also `map`: how every old
   * line moved (-1: removed or rewritten), which the room moves the other leases by.
   */
  apply(
    lines: readonly string[],
    op: LiveStructOp,
  ): { lines: string[]; map?: LineMap } | { error: LiveDocErrorCode };
  /**
   * Every range the op removes or rewrites, and every point it inserts at as a zero-length range,
   * which no other socket's lease may overlap (liveLines.ts structOverlaps). "all": refused while
   * any other socket holds a lease (a sheet's rows and columns, which rewrite formulas that may
   * sit in any row).
   */
  touches(lines: readonly string[], op: LiveStructOp): readonly LineRange[] | "all";
  /**
   * The sender's own lease survives an op that does not touch it, moved by the line map (a deck's
   * notes and settings). Otherwise (a sheet, a design system) the room ends it before it applies
   * the op, and the sender's editor never expects it back.
   */
  keepsSenderLease?: boolean;
}

/** The rules of one live-editable type. */
export interface LiveTypeRules {
  /** Past the type's size or line limits. */
  tooLarge(live: string): boolean;
  /**
   * Why an edit that replaces `del` lines at `start` of `lines` with `ins` is refused, or null.
   * Size is tooLarge's check, made after this one. It also refuses an edit whose result the
   * type's publish hook would refuse on its source alone, so a draft can always be published.
   */
  checkEdit(
    lines: readonly string[],
    start: number,
    del: number,
    ins: readonly string[],
  ): LiveDocErrorCode | null;
  /**
   * A whole draft the type can hold (a doc merge's result, a structural change's). It holds only
   * for a text the type's publish hook accepts on its source alone (the stager parity test).
   */
  valid(live: string): boolean;
  /**
   * What happens to a changed draft when a version is published meanwhile (rooms/doc.ts outside):
   * "lines", #49's rule: a clean merge3 that fits is taken, anything else is reviewed (a doc);
   * "review": never merged, the whole draft is reviewed beside the version (every other type).
   */
  merge: "lines" | "review";
  /** The source text as the draft's lines, and back. Identity for docs and sheets (a deck: LF). */
  toLive(source: string): string;
  fromLive(live: string): string;
  /** Why a valid draft cannot become a version yet (a deck that shows no slide), or null. */
  unpublishable(live: string): "empty" | null;
  /** The type's structural ops, or null for a type that has none (a doc). */
  struct: LiveStructRules | null;
}

/** A sheet's header line: the header when it is valid and canonical, else null. */
export function sheetHeaderLine(line: string | undefined): SheetHeader | null {
  if (line === undefined) return null;
  const r = parseSheet(line);
  if (!r.ok) return null;
  return serializeSheet({ header: r.sheet.header, rows: [] }) === line ? r.sheet.header : null;
}

/**
 * Whether every row valid under header `a` is valid under `b`: the same number of columns with the
 * same types and options. A row's cells are checked against those only (checkRow), so a rename, a
 * width or a number format needs no recheck of the rows.
 */
export function sameRowRules(a: SheetHeader, b: SheetHeader): boolean {
  return (
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => {
      const d = b.columns[i];
      return (
        d !== undefined &&
        c.type === d.type &&
        JSON.stringify(c.options ?? null) === JSON.stringify(d.options ?? null)
      );
    })
  );
}

/** Whether `line` is a valid row of a sheet with `header`, in its canonical spelling. */
export function sheetRowLine(header: SheetHeader, line: string, rowNumber: number): boolean {
  if (line === "" || line.length > LIMITS.maxSheetRowBytes) return false;
  if (line.length * 3 > LIMITS.maxSheetRowBytes && utf8(line) > LIMITS.maxSheetRowBytes) {
    return false;
  }
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  if (!Array.isArray(row) || checkRow(header, row, rowNumber).length > 0) return false;
  return JSON.stringify(trimRow(row)) === line;
}

/** How many formulas the row lines hold (a malformed line counts none). */
function formulasIn(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line.includes('"=')) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (Array.isArray(row)) for (const c of row) if (isFormula(c)) n++;
    } catch {
      // not a row
    }
  }
  return n;
}

/** Whether a text starts like a whole HTML document (HTML_DOCUMENT_RE, as the stager checks). */
export function startsLikeHtmlDocument(text: string): boolean {
  return HTML_DOCUMENT_RE.test(text);
}

/**
 * Whether the result of an edit would start like a whole HTML document. HTML_DOCUMENT_RE reads
 * only the white space before the first non-blank line, that line, and whether a line follows it
 * (`<html` at the end of a line), so only that much of the result is put together.
 */
function editStartsHtmlDocument(
  lines: readonly string[],
  start: number,
  del: number,
  ins: readonly string[],
): boolean {
  const total = lines.length - del + ins.length;
  const at = (i: number): string =>
    (i < start
      ? lines[i]
      : i < start + ins.length
        ? ins[i - start]
        : lines[i - ins.length + del]) ?? "";
  const head: string[] = [];
  for (let i = 0; i < total; i++) {
    const line = at(i);
    head.push(line);
    if (line.trim() !== "") {
      return startsLikeHtmlDocument(i + 1 < total ? `${head.join("\n")}\n` : head.join("\n"));
    }
  }
  return false;
}

const identity = (s: string) => s;

const docRules: LiveTypeRules = {
  tooLarge: liveDocTooLarge,
  checkEdit: (lines, start, del, ins) =>
    editStartsHtmlDocument(lines, start, del, ins) ? "invalid" : null,
  valid: (text) => !startsLikeHtmlDocument(text),
  merge: "lines",
  toLive: identity,
  fromLive: identity,
  unpublishable: () => null,
  struct: null,
};

const sheetStruct: LiveStructRules = {
  kinds: SHEET_STRUCT_KINDS,
  apply(lines, op) {
    // The room checked the op's kind against `kinds` first.
    const next = applySheetStruct(lines, op as SheetStructOp);
    return next ? { lines: next } : { error: "invalid" };
  },
  // A row or column insert, delete or move rewrites formulas that may sit in any row.
  touches: () => "all",
};

const sheetRules: LiveTypeRules = {
  tooLarge: liveSheetTooLarge,
  checkEdit(lines, start, del, ins) {
    const oldHeader = sheetHeaderLine(lines[0]);
    if (!oldHeader) return "invalid";
    // The line count changes only by appending rows at the end: a row in the middle moves only
    // through a struct op, which rewrites the formula references the move shifts.
    if (ins.length !== del && (start + del !== lines.length || ins.length < del)) {
      return "invalid";
    }
    let header = oldHeader;
    let recheck = false;
    let rows = ins;
    let firstRow = start + 1;
    if (start === 0) {
      // Nothing goes above the header, and the header stays one line with the same columns.
      if (del === 0 || ins.length === 0) return "invalid";
      const next = sheetHeaderLine(ins[0]);
      if (!next || next.columns.length !== oldHeader.columns.length) return "invalid";
      header = next;
      recheck = ins[0] !== lines[0] && !sameRowRules(oldHeader, next);
      rows = ins.slice(1);
      firstRow = 2;
    }
    for (let i = 0; i < rows.length; i++) {
      if (!sheetRowLine(header, rows[i] as string, firstRow + i)) return "invalid";
    }
    if (recheck) {
      // A header whose types or options changed: every row is checked against it again.
      for (let i = start + del; i < lines.length; i++) {
        const n = i - del + ins.length + 1;
        if (!sheetRowLine(header, lines[i] as string, n)) return "invalid";
      }
    }
    if (lines.length - del + ins.length - 1 > LIMITS.maxSheetRows) return "too_large";
    const added = formulasIn(rows) - formulasIn(lines.slice(Math.max(1, start), start + del));
    if (added > 0 && formulasIn(lines.slice(1)) + added > LIMITS.maxSheetFormulaCells) {
      return "too_large";
    }
    return null;
  },
  valid(text) {
    // A canonical sheet's first line is its header (JSON), so it never starts like HTML.
    const r = parseSheet(text);
    return r.ok && serializeSheet(r.sheet) === text;
  },
  // Rows and columns refer to each other by position (formulas, a row's cells by column), and
  // a line merge cannot tell an edit from a move, so a sheet draft is reviewed, never merged.
  merge: "review",
  toLive: identity,
  fromLive: identity,
  unpublishable: () => null,
  struct: sheetStruct,
};

const designSystemStruct: LiveStructRules = {
  kinds: DS_STRUCT_KINDS,
  apply(lines, op) {
    const r = applyDesignSystemStruct(lines, op as DsStructOp);
    return typeof r === "string" ? { error: "invalid" } : { lines: r.lines, map: r.map };
  },
  // The one run of lines the op changes (designSystemStruct.ts): a lease outside it moves by the
  // map; one inside it (a value whose comma the op adds or drops included) refuses the op.
  touches(lines, op) {
    const r = applyDesignSystemStruct(lines, op as DsStructOp);
    return typeof r === "string" ? [] : r.touched;
  },
};

// A design system's draft is its line projection (designSystemLive.ts): one JSON value per lease,
// each edit a whole value written canonically and checked with the publish rules on the whole
// system, the guidelines as Markdown lines after the JSON. Never merged: a version published
// meanwhile is compared by projection, and reviewed whole unless it changed nothing the draft holds.
const designSystemRules: LiveTypeRules = {
  tooLarge: liveDesignSystemTooLarge,
  checkEdit: checkDesignSystemEdit,
  valid: validDesignSystemDraft,
  merge: "review",
  toLive: designSystemToLive,
  fromLive: designSystemFromLive,
  unpublishable: () => null,
  struct: designSystemStruct,
};
// ---------- slides (slides-text) ----------

/** Whether a deck draft is past LIMITS.maxSlidesBytes or LIMITS.maxLiveDocLines. */
export function liveSlidesTooLarge(text: string): boolean {
  if (text.length > LIMITS.maxSlidesBytes || utf8(text) > LIMITS.maxSlidesBytes) return true;
  return moreLinesThan(text, LIMITS.maxLiveDocLines);
}

/**
 * The layout of the lines a deck edit starts from. The room checks every edit against the lines
 * it holds, which are the previous edit's result: the layout computed for that result (rule 5) is
 * kept and reused while the lines are equal to it, so rules 1 to 4 cost the edited lines plus one
 * pass of string comparisons (the same strings, so each is a pointer check). One deck is kept.
 */
let lastDeck: { lines: readonly string[]; layout: DeckLayout } | null = null;

function layoutOf(lines: readonly string[]): DeckLayout {
  const c = lastDeck;
  if (c && c.lines.length === lines.length) {
    let same = true;
    for (let i = 0; i < lines.length; i++) {
      if (c.lines[i] !== lines[i]) {
        same = false;
        break;
      }
    }
    if (same) return c.layout;
  }
  const layout = deckLayout(lines);
  lastDeck = { lines: [...lines], layout };
  return layout;
}

/**
 * The part of a raw slide (its head, a column, or its notes) that holds [start, start + del), or
 * the insert point at `start`: an insert point on the boundary of two parts belongs to the first.
 */
function partOf(
  layout: DeckLayout,
  start: number,
  del: number,
): { part: DeckRange; notes: boolean } | null {
  const slides = layout.slides;
  // The first raw slide that ends at or after `start` (an insert point at a slide's end belongs
  // to it, before its separator).
  let lo = 0;
  let hi = slides.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((slides[mid] as (typeof slides)[number]).end < start) lo = mid + 1;
    else hi = mid;
  }
  const s = slides[lo];
  if (!s || start < s.start || start + del > s.end) return null;
  const parts: { part: DeckRange; notes: boolean }[] = [
    { part: s.head, notes: false },
    ...s.columns.map((part) => ({ part, notes: false })),
    ...(s.notes ? [{ part: s.notes, notes: true }] : []),
  ];
  for (const p of parts) {
    const inside =
      del === 0
        ? p.part.start <= start && start <= p.part.end
        : p.part.start <= start && start + del <= p.part.end;
    if (inside) return p;
  }
  return null;
}

/**
 * The slides structure rule (docs/spec.md "Slides"): an edit that replaces `del` lines at `start`
 * with `ins` is taken only when (1) it lies inside one part of one raw slide (its head, one
 * column, or its notes part), never in the front matter; (2) the structural kinds of the removed
 * lines equal those of the inserted ones, read in the same part and fence state: none in a head
 * or column, and in notes the marker first when the edit starts on it; (3) the fence state after
 * the inserted lines is the one after the removed lines; (4) frontMatterEnd of the result is the
 * deck's; (5) deckKeeps holds on the whole result. The result must not start like an HTML
 * document, and no inserted line holds "\r", which the deck would read as a line break.
 */
function checkDeckEdit(
  lines: readonly string[],
  start: number,
  del: number,
  ins: readonly string[],
): LiveDocErrorCode | null {
  if (start < 0 || del < 0 || start + del > lines.length) return "invalid";
  for (const l of ins) if (l.includes("\r")) return "invalid";
  const layout = layoutOf(lines);
  const fm = layout.frontMatterEnd;
  // 1. Inside one part, never the front matter (an insert point at its closing line is in it).
  if (fm > 0 && start <= fm) return "invalid";
  const at = partOf(layout, start, del);
  if (!at) return "invalid";
  // 2. The same structural kinds, in order. In notes only a separator (outside fences) is
  // structure, besides the marker on the part's first line.
  const before = start > 0 ? (layout.fenceAfter[start - 1] ?? "") : "";
  const marker = at.notes && start === at.part.start;
  const kinds = partLineKinds(before, ins, at.notes && !marker);
  if (marker && kinds[0] !== "note") return "invalid";
  const removed = layout.kinds.slice(start, start + del).filter((k) => k !== "text");
  const added = kinds.filter((k) => k !== "text");
  if (removed.length !== added.length || removed.some((k, i) => k !== added[i])) {
    return "invalid";
  }
  // 3. The fence state after the edit is the one the removed lines left.
  const after = del > 0 ? (layout.fenceAfter[start + del - 1] ?? "") : before;
  if (fenceStateAfter(before, ins) !== after) return "invalid";
  // 4. frontMatterEnd is unchanged. It reads at most the first FRONT_MATTER_LINES + 2 lines.
  const head: string[] = [];
  const total = lines.length - del + ins.length;
  for (let i = 0; i < Math.min(total, FRONT_MATTER_LINES + 2); i++) {
    const line =
      i < start ? lines[i] : i < start + ins.length ? ins[i - start] : lines[i - ins.length + del];
    head.push(line ?? "");
  }
  if (frontMatterEnd(head) !== fm) return "invalid";
  if (editStartsHtmlDocument(lines, start, del, ins)) return "invalid";
  // 5. deckKeeps on the whole result: every line outside the edit keeps its kind, and the front
  // matter is byte for byte as it was. Rules 1 to 4 imply it; it still runs on every edit.
  const next = [...lines.slice(0, start), ...ins, ...lines.slice(start + del)];
  const nextLayout = deckLayout(next);
  const from = editLineSources(lines.length, start, del, ins.length);
  if (!deckKeeps(lines, next, from, undefined, { before: layout, after: nextLayout })) {
    return "invalid";
  }
  lastDeck = { lines: next, layout: nextLayout };
  return null;
}

/** Whether a whole deck draft is one the slides rules can hold (`valid`, apart from its size). */
function deckValid(text: string): boolean {
  if (startsLikeHtmlDocument(text)) return false;
  const lines = text.split("\n");
  return deckDraftValid(lines, layoutOf(lines));
}

const slidesStruct: LiveStructRules = {
  kinds: SLIDES_STRUCT_KINDS,
  apply(lines, op) {
    // The room checked the op's kind against `kinds` first; the op's postcondition runs inside.
    const r = applySlidesStruct(lines, op as SlidesStructOp);
    if (!r || startsLikeHtmlDocument(r.lines.join("\n"))) return { error: "invalid" };
    return r;
  },
  // An op that does not apply touches nothing: `apply` refuses it.
  touches: (lines, op) => slidesTouches(lines, op as SlidesStructOp) ?? [],
  keepsSenderLease: true,
};

const slidesRules: LiveTypeRules = {
  tooLarge: liveSlidesTooLarge,
  checkEdit: checkDeckEdit,
  valid: deckValid,
  // A deck line's kind depends on the lines above it (fences, notes, columns), so a line merge
  // could change what a line is: a deck draft is reviewed, never merged.
  merge: "review",
  // The deck's lines as the deck reads them: CRLF (and a lone CR) as LF, as parseDeck does, so a
  // line the room checks is the line every slide shows. Identity for a deck without "\r".
  toLive: (source) => (source.includes("\r") ? source.replace(/\r\n?/g, "\n") : source),
  fromLive: identity,
  // A draft may show no slide (an emptied New deck); it is never published like that.
  unpublishable: (text) => (parseDeck(text).slides.length === 0 ? "empty" : null),
  struct: slidesStruct,
};

/**
 * How the renderer empties a block of a deck (all of its text deleted), so the room's structure
 * rule takes it: the lines to send for [start, start + del), or "trim" when the deck must first
 * lose the bare `---` lines at line 0 (the struct op trim_start, after which the renderer asks
 * again with the moved range), or null when nothing would pass. Zero lines remove the block; one
 * blank line (a single space, since an edit's text "" is no lines at all) keeps the lines around
 * it apart (two text lines would run together, or a `---`
 * would come to line 0 and turn the slide below it into settings); a deck that opens with a bare
 * `---` would read blank lines under it as empty front matter, so it is trimmed first.
 */
export function deckEmptying(
  lines: readonly string[],
  start: number,
  del: number,
): { ins: string[] } | "trim" | null {
  const kinds = layoutOf(lines).kinds;
  const text = (i: number) => kinds[i] === "text" && (lines[i] ?? "").trim() !== "";
  const joins = start > 0 && start + del < lines.length && text(start - 1) && text(start + del);
  // The blank line is one space: an edit's text "" means no lines at all.
  const tries: string[][] = joins ? [[" "]] : [[], [" "]];
  for (const ins of tries) if (checkDeckEdit(lines, start, del, ins) === null) return { ins };
  if (frontMatterEnd(lines) === -1 && /^---[ \t]*$/.test(lines[0] ?? "")) return "trim";
  return null;
}

/** Every live-editable type's rules. A type with `edit: "live"` has an entry (liveTypes test). */
export const LIVE_TYPE_RULES: Readonly<Partial<Record<ArtifactType, LiveTypeRules>>> = {
  doc: docRules,
  slides: slidesRules,
  sheet: sheetRules,
  design_system: designSystemRules,
};

/** The rules of a type, or null for a type that is not edited on its page. */
export function liveRules(type: string): LiveTypeRules | null {
  return Object.hasOwn(LIVE_TYPE_RULES, type)
    ? (LIVE_TYPE_RULES[type as ArtifactType] ?? null)
    : null;
}

/** "v6", or "v6 to v7": the versions published since a draft's base, up to `to`. */
export function versionRange(from: number, to: number): string {
  return from >= to ? `v${to}` : `v${from} to v${to}`;
}

/**
 * The note of page edits published whole over the versions `from` to `to` ("Publish your changes" in the
 * review, where the draft is not combined with them): `note` (the editor's own, or "Edited on the
 * page") first, then what the new version leaves out, cut so the whole fits LIMITS.maxNoteLength.
 * "Edited on the page. Replaces the changes in v6." or "… in v6 to v7."
 */
export function liveReplacesNote(note: string, from: number, to: number = from): string {
  const tail = `Replaces the changes in ${versionRange(from, to)}.`;
  let head = note.trim().replace(/[\s.]+$/, "");
  const room = LIMITS.maxNoteLength - tail.length - 2;
  if (head.length > room) {
    head = head.slice(0, room);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    head = head.trimEnd();
  }
  return head ? `${head}. ${tail}` : tail;
}

/**
 * The text a block of Markdown is stored as so that it can never make the doc start like an HTML
 * document: a `<` that would open `<html` or `<!doctype html` at the start of a top-level block
 * (outside fenced code, indented at most three spaces) is written `\<`, which renders as `<`. Every
 * block escaped this way can become the doc's first block safely (when the one above it is
 * deleted). `at` lists where a backslash went in, as offsets in the original text (each before
 * the `<` it escapes), for moving a caret.
 */
export function escapeHtmlDocumentStarts(text: string): { text: string; at: number[] } {
  const lines = text.split("\n");
  const at: number[] = [];
  let fence: string | null = null;
  let blockStart = true;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const wasFenced = fence !== null;
    if (fence !== null) {
      if (open && (open[1] as string)[0] === fence[0] && (open[1] as string).length >= fence.length)
        fence = null;
    } else if (open) {
      fence = open[1] as string;
    } else if (blockStart) {
      const m = /^( {0,3})<(!doctype html|html(?:[\s>]|$))/i.exec(line);
      if (m) {
        const pos = (m[1] as string).length;
        lines[i] = `${line.slice(0, pos)}\\${line.slice(pos)}`;
        at.push(offset + pos);
      }
    }
    // A blank line ends a block, and so does a fence that just closed.
    blockStart = fence === null && (line.trim() === "" || wasFenced);
    offset += line.length + 1;
  }
  return { text: at.length ? lines.join("\n") : text, at };
}
