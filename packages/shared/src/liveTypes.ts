// On-page editing (#36) per type: what the room, the renderers and the app check about a live
// draft of each type whose registry row has liveEdit (docs and sheets). The room enforces these
// on every edit, structural change and merge; the renderers use the same rules to check before
// they send. No zod, so the renderer bundles can import it.
//
// A doc's draft is Markdown: any lines, up to LIMITS.maxDocBytes and LIMITS.maxLiveDocLines.
// A sheet's draft is its canonical JSON lines (serializeSheet): line 0 the header, then one row
// per line. Every line an edit puts in must be a valid row (or, on line 0, a header with the same
// number of columns) in its one canonical spelling, so the draft always is what a version stores
// and a checkpoint saves it byte for byte. Rows and columns move only through `struct`.
import type { ArtifactType } from "./artifactTypes.ts";
import { LIMITS } from "./constants.ts";
import type { LiveDocErrorCode } from "./liveDoc.ts";
import type { LineHunk, Merge3Sides } from "./merge3.ts";
import {
  checkRow,
  isFormula,
  parseSheet,
  type SheetHeader,
  serializeSheet,
  trimRow,
} from "./sheet/format.ts";

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

/** The rules of one live-editable type. */
export interface LiveTypeRules {
  /** Past the type's size or line limits. */
  tooLarge(text: string): boolean;
  /**
   * Why an edit that replaces `del` lines at `start` of `lines` with `ins` is refused, or null.
   * Size is tooLarge's check, made after this one.
   */
  checkEdit(
    lines: readonly string[],
    start: number,
    del: number,
    ins: readonly string[],
  ): LiveDocErrorCode | null;
  /** A whole draft the type can hold (a merge's result, a structural change's). */
  valid(text: string): boolean;
  /** The draft takes `struct` frames (rows and columns of a sheet). */
  struct: boolean;
  /** Each line is a record of its own: changes to adjacent lines merge (merge3 `rows`). */
  rows: boolean;
  /** A clean line merge the type still sends to review (merge3 `refuse`), when it has one. */
  refuseMerge?: (sides: Merge3Sides) => boolean;
}

/** A sheet's header line: the header when it is valid and canonical, else null. */
export function sheetHeaderLine(line: string | undefined): SheetHeader | null {
  if (line === undefined) return null;
  const r = parseSheet(line);
  if (!r.ok) return null;
  return serializeSheet({ header: r.sheet.header, rows: [] }) === line ? r.sheet.header : null;
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

/**
 * Each column's name and type, in order: what a column is, as far as a header can tell. Width,
 * number format, options and frozen columns move no cell. Null for a header that does not parse.
 */
function columnKeys(line: string | undefined): string[] | null {
  const header = sheetHeaderLine(line);
  return header ? header.columns.map((c) => JSON.stringify([c.name, c.type])) : null;
}

/**
 * Whether a clean row-by-row merge of a sheet draft with a version would change what cells mean,
 * so it goes to review instead. Rows merge as records, but a structural change on one side moves
 * cells and rewrites that side's formulas (shiftFormula), and the other side's rows know nothing
 * of it:
 * - a side that inserts or deletes columns moves every cell right of them, and a row whose
 *   trailing cells are empty keeps its line, so a cell the other side set there would land in
 *   another column. Columns carry no identity but their name and type, so a column deleted and
 *   another inserted (the same count) shows only as names or types changed in place, and so does a
 *   rename: any change to a column's name or type, or to the count, is reviewed. When two columns
 *   share a name and type, a move between them changes neither, so any change to that header is.
 * - a side that inserts or deletes rows moves the rows after them, and the other side's rows added
 *   at the end come after them too; a deleted row also takes the cells a formula pointed at. So
 *   any change to the number of rows other than rows only appended after the last one is reviewed
 *   when the other side's changed or added rows hold a formula, whose references would point at
 *   other rows. A row deleted and another inserted keep the count, and when every row between
 *   them changed (shiftFormula rewrote them) the diff shows those rows changed in place; so a
 *   change of two or more adjacent rows counts as a move too.
 * - a line diff cannot tell which of several equal rows (blank ones, typically) a side inserted
 *   or deleted, and puts the change after the run of them. A row the other side changed in that
 *   run would then sit one row off from where the moving side's rows, and the formulas it
 *   rewrote, expect it. So a change of the row count is reviewed when the other side changed or
 *   added a row among the equal rows next to it.
 */
export function sheetMergeRefused(s: Merge3Sides): boolean {
  const base = columnKeys(s.base[0]);
  const same = (line: string | undefined) => {
    const keys = columnKeys(line);
    if (base === null || keys === null) return base === keys;
    return keys.length === base.length && keys.every((k, i) => k === base[i]);
  };
  if (!same(s.ours[0]) || !same(s.theirs[0])) return true;
  if (base !== null && new Set(base).size < base.length) {
    if (s.ours[0] !== s.base[0] || s.theirs[0] !== s.base[0]) return true;
  }
  return (
    rowsMoveUnder(s.base, s.ours, s.oursHunks, s.theirs, s.theirsHunks) ||
    rowsMoveUnder(s.base, s.theirs, s.theirsHunks, s.ours, s.oursHunks)
  );
}

/**
 * Whether one side's (`lines`, `hunks`) row changes could move rows under the other side's
 * changes (`other`, `otherHunks`): sheetMergeRefused's row half.
 */
function rowsMoveUnder(
  base: readonly string[],
  lines: readonly string[],
  hunks: readonly LineHunk[],
  other: readonly string[],
  otherHunks: readonly LineHunk[],
): boolean {
  // A hunk that starts past the last base row only appends, and one row changed in place moves
  // nothing; any other change of the count, or of two or more adjacent rows, may move rows.
  const counts = (h: LineHunk) => h.aEnd - h.aStart !== h.bEnd - h.bStart;
  const moves = hunks.filter((h) => h.aStart < base.length && (counts(h) || h.aEnd - h.aStart > 1));
  if (moves.length === 0) return false;
  if (otherHunks.some((h) => formulasIn(other.slice(Math.max(1, h.bStart), h.bEnd)) > 0)) {
    return true;
  }
  for (const h of moves) {
    if (!counts(h)) continue;
    // The run of base rows around the hunk equal to a row it inserted, deleted or rewrote: the
    // diff could have put the change anywhere in it.
    const equal = new Set([...base.slice(h.aStart, h.aEnd), ...lines.slice(h.bStart, h.bEnd)]);
    let lo = h.aStart;
    while (lo > 1 && equal.has(base[lo - 1] as string)) lo--;
    let hi = h.aEnd;
    while (hi < base.length && equal.has(base[hi] as string)) hi++;
    if (lo === h.aStart && hi === h.aEnd) continue;
    const touches = (o: LineHunk) =>
      o.aStart === o.aEnd ? lo < o.aStart && o.aStart < hi : o.aStart < hi && o.aEnd > lo;
    if (otherHunks.some(touches)) return true;
  }
  return false;
}

const docRules: LiveTypeRules = {
  tooLarge: liveDocTooLarge,
  checkEdit: () => null,
  valid: () => true,
  struct: false,
  rows: false,
};

const sheetRules: LiveTypeRules = {
  tooLarge: liveSheetTooLarge,
  checkEdit(lines, start, del, ins) {
    const oldHeader = sheetHeaderLine(lines[0]);
    if (!oldHeader) return "invalid";
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
      recheck = ins[0] !== lines[0];
      rows = ins.slice(1);
      firstRow = 2;
    }
    for (let i = 0; i < rows.length; i++) {
      if (!sheetRowLine(header, rows[i] as string, firstRow + i)) return "invalid";
    }
    if (recheck) {
      // A changed header: every row is checked against it again.
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
    const r = parseSheet(text);
    return r.ok && serializeSheet(r.sheet) === text;
  },
  struct: true,
  rows: true,
  refuseMerge: sheetMergeRefused,
};

/** Every live-editable type's rules. A type with liveEdit has an entry (artifactTypes test). */
export const LIVE_TYPE_RULES: Readonly<Partial<Record<ArtifactType, LiveTypeRules>>> = {
  doc: docRules,
  sheet: sheetRules,
};

/** The rules of a type, or null for a type that is not edited on its page. */
export function liveRules(type: string): LiveTypeRules | null {
  return Object.hasOwn(LIVE_TYPE_RULES, type)
    ? (LIVE_TYPE_RULES[type as ArtifactType] ?? null)
    : null;
}
