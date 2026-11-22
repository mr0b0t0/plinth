// A deck's structural ops (slides-text): the changes to a live deck draft that are not text
// inside one slide part, so the room never takes them as a text edit (liveTypes.ts, the slides
// rules). Pure and zod-free: the room applies them, and so does every renderer, to the same lines.
//
//   add_notes { n }       a blank line and `Note:` after raw slide n's last non-blank line
//                         (refused when it has notes); the person then types into them
//   remove_notes { n }    raw slide n's notes part and the blank lines just before it
//   set_deck { aspect, theme, paginate, footer }
//                         writes the front matter canonically: only the keys that differ from the
//                         defaults (`aspect: 16:9`, `theme: auto`, `paginate: true`, no footer),
//                         the footer as plain text of at most MAX_DECK_FOOTER characters; it
//                         creates the front matter at line 0 when the deck has none and removes it
//                         when nothing is left in it. Lines of keys the reader does not know are
//                         kept, after the canonical ones
//   trim_start {}         a deck whose line 0 is a bare `---` (no front matter): removes the
//                         bare `---` lines from line 0, each of which only drops an empty raw
//                         slide that presenting never shows
//
// `n` is a raw slide number (deckLayout, from 1), empty slides at the edges included. Every op
// ends with the line-0 step: unless the result starts with front matter the deck had (or that
// set_deck just wrote), it removes `---` lines from line 0 while there is one, so no op leaves a
// bare `---` at line 0 above lines that would then read as settings. Every op is checked by its
// postcondition before it is taken: deckKeeps with the op's line map (every line it did not put
// in keeps its kind; the front matter is byte for byte as it was, except after set_deck), the raw
// slide count it should give, every slide it does not name byte for byte at its new place, and
// the slides rules' `valid`. `slidesTouches` lists every range the op removes or rewrites, and
// every point it inserts at as a zero-length range, for the room's lease check (liveLines.ts
// structOverlaps).
import { LIMITS } from "./constants.ts";
import type { LineRange } from "./liveLines.ts";
import {
  DEFAULT_DECK_SETTINGS,
  type DeckLayout,
  type DeckTheme,
  deckKeeps,
  deckLayout,
  frontMatterEnd,
  isSeparatorLine,
  MAX_DECK_FOOTER,
  parseLaidOut,
  type RawSlideLayout,
  type SlideAspect,
} from "./slides.ts";

export type SlidesStructOp =
  | { op: "add_notes"; n: number }
  | { op: "remove_notes"; n: number }
  | { op: "set_deck"; aspect: SlideAspect; theme: DeckTheme; paginate: boolean; footer: string }
  | { op: "trim_start" };

// biome-ignore format: one op per line, so each feature adds its own line
export const SLIDES_STRUCT_KINDS = [
  "add_notes",
  "remove_notes",
  "set_deck",
  "trim_start",
] as const satisfies readonly SlidesStructOp["op"][];

/** Characters a footer may not hold: control and format characters, and line breaks. */
export const FOOTER_UNSAFE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** The footer set_deck writes: trimmed (as the reader trims it), or null when it cannot be one. */
export function deckFooter(footer: string): string | null {
  if (FOOTER_UNSAFE_RE.test(footer)) return null;
  const f = footer.trim();
  return f.length > MAX_DECK_FOOTER ? null : f;
}

const KNOWN_KEYS = new Set(["aspect", "theme", "paginate", "footer"]);

/** One replacement of `del` lines at `start` (in the lines before the op) by `ins`. */
interface Splice {
  start: number;
  del: number;
  ins: string[];
}

interface Plan {
  splices: Splice[];
  /** Ranges the op rewrites without removing them (a slide whose notes it adds or removes). */
  rewrites: LineRange[];
  /** The raw slide the op names (1-based), checked by its own rule after the op. */
  named: number | null;
  /** The front matter lines set_deck writes, or null (it keeps the deck's or writes none). */
  writes: string[] | null;
}

const lastNonBlank = (lines: readonly string[], from: number, to: number): number => {
  for (let i = to - 1; i >= from; i--) if ((lines[i] ?? "").trim() !== "") return i;
  return -1;
};

function plan(lines: readonly string[], layout: DeckLayout, op: SlidesStructOp): Plan | null {
  const fm = layout.frontMatterEnd;
  const slide = (n: number): RawSlideLayout | null =>
    Number.isInteger(n) && n >= 1 ? (layout.slides[n - 1] ?? null) : null;
  switch (op.op) {
    case "add_notes": {
      const s = slide(op.n);
      if (!s || s.notes) return null;
      const last = lastNonBlank(lines, s.start, s.end);
      const splice =
        last < 0
          ? { start: s.start, del: 0, ins: ["Note:"] }
          : { start: last + 1, del: 0, ins: ["", "Note:"] };
      return {
        splices: [splice],
        rewrites: [{ start: s.start, end: s.end }],
        named: op.n,
        writes: null,
      };
    }
    case "remove_notes": {
      const s = slide(op.n);
      if (!s?.notes) return null;
      const end = lastNonBlank(lines, s.notes.start, s.end) + 1;
      let start = s.notes.start;
      while (start > s.start && (lines[start - 1] ?? "").trim() === "") start--;
      return {
        splices: [{ start, del: end - start, ins: [] }],
        rewrites: [{ start: s.start, end: s.end }],
        named: op.n,
        writes: null,
      };
    }
    case "set_deck": {
      const footer = deckFooter(op.footer);
      if (footer === null) return null;
      const want: string[] = [];
      if (op.aspect !== DEFAULT_DECK_SETTINGS.aspect) want.push(`aspect: ${op.aspect}`);
      if (op.theme !== DEFAULT_DECK_SETTINGS.theme) want.push(`theme: ${op.theme}`);
      if (op.paginate !== DEFAULT_DECK_SETTINGS.paginate) want.push(`paginate: ${op.paginate}`);
      if (footer !== "") want.push(`footer: ${footer}`);
      const unknown: string[] = [];
      for (let i = 1; i < fm; i++) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        const key = line.trim().slice(0, line.trim().indexOf(":"));
        if (!KNOWN_KEYS.has(key)) unknown.push(line);
      }
      const body = [...want, ...unknown];
      const writes = body.length > 0 ? ["---", ...body, "---"] : null;
      const del = fm > 0 ? fm + 1 : 0;
      return { splices: [{ start: 0, del, ins: writes ?? [] }], rewrites: [], named: null, writes };
    }
    case "trim_start":
      if (fm !== -1 || !isSeparatorLine(lines[0])) return null;
      return { splices: [], rewrites: [], named: null, writes: null };
  }
}

/** The lines after the splices (sorted, apart), and where each old line went (-1: removed). */
function splice(lines: readonly string[], splices: readonly Splice[]) {
  const out: string[] = [];
  const map = new Array<number>(lines.length);
  let i = 0;
  for (const s of splices) {
    for (; i < s.start; i++) map[i] = out.push(lines[i] as string) - 1;
    for (const l of s.ins) out.push(l);
    for (; i < s.start + s.del; i++) map[i] = -1;
  }
  for (; i < lines.length; i++) map[i] = out.push(lines[i] as string) - 1;
  return { lines: out, map };
}

/** For each line of a result of `afterLength` lines, the line it came from (deckKeeps), or -1. */
export function lineSources(map: readonly number[], afterLength: number): number[] {
  const from = new Array<number>(afterLength).fill(-1);
  for (let i = 0; i < map.length; i++) {
    const j = map[i] as number;
    if (j >= 0) from[j] = i;
  }
  return from;
}

interface Applied {
  lines: string[];
  map: number[];
  /** Lines the line-0 step (or trim_start) removed. */
  stepped: number;
  plan: Plan;
}

function run(lines: readonly string[], layout: DeckLayout, op: SlidesStructOp): Applied | null {
  const p = plan(lines, layout, op);
  if (!p) return null;
  const mid = splice(lines, p.splices);
  // The line-0 step: never over front matter the deck had (no op but set_deck touches it) or
  // that set_deck just wrote.
  const keep = p.writes !== null || (op.op !== "set_deck" && layout.frontMatterEnd > 0);
  let k = 0;
  if (!keep) while (k < mid.lines.length && isSeparatorLine(mid.lines[k])) k++;
  let out = k > 0 ? mid.lines.slice(k) : mid.lines;
  const map = mid.map.map((j) => (j < 0 || j < k ? -1 : j - k));
  // A text is never no lines at all.
  if (out.length === 0) out = [""];
  return { lines: out, map, stepped: k, plan: p };
}

/** Whether a whole deck draft is one the slides type can hold (the rules' `valid`, sans size). */
export function deckDraftValid(lines: readonly string[], layout: DeckLayout): boolean {
  if (layout.slides.length > LIMITS.maxSlides) return false;
  for (const l of lines) if (l.includes("\r")) return false;
  return true;
}

/**
 * The op applied to `lines`: the new lines and where every old line went (-1: removed or
 * rewritten), or null when the op does not apply here or its result fails the postcondition. The
 * caller checks the result's size and the HTML-document rule (the slides rules' `valid`).
 */
export function applySlidesStruct(
  lines: readonly string[],
  op: SlidesStructOp,
): { lines: string[]; map: number[] } | null {
  const before = deckLayout(lines);
  const r = run(lines, before, op);
  if (!r) return null;
  const after = deckLayout(r.lines);
  // Every line the op did not put in keeps its kind; the front matter is the deck's, unless
  // set_deck wrote it.
  if (!deckKeeps(lines, r.lines, lineSources(r.map, r.lines.length), op.op, { before, after })) {
    return null;
  }
  // Each `---` the step removed drops one empty raw slide; nothing else adds or removes one.
  if (after.slides.length !== before.slides.length - r.stepped) return null;
  // Every slide the op does not name is where the map puts it, byte for byte.
  for (const s of before.slides) {
    if (s.n === r.plan.named) continue;
    for (let i = s.start; i < s.end; i++) {
      const j = r.map[i] as number;
      if (j < 0 || r.lines[j] !== lines[i]) return null;
    }
  }
  if (r.plan.named !== null) {
    const s = after.slides[r.plan.named - 1 - r.stepped];
    if (!s) return null;
    if (op.op === "add_notes" && s.notes === null) return null;
    if (op.op === "remove_notes" && s.notes !== null) return null;
  }
  if (op.op === "set_deck") {
    const fm = after.frontMatterEnd;
    const wrote = r.plan.writes;
    if (wrote ? fm !== wrote.length - 1 : fm !== -1) return null;
    const s = parseLaidOut(r.lines, after).settings;
    if (
      s.aspect !== op.aspect ||
      s.theme !== op.theme ||
      s.paginate !== op.paginate ||
      s.footer !== deckFooter(op.footer)
    ) {
      return null;
    }
  } else if (op.op === "trim_start" && r.stepped === 0) {
    return null;
  }
  // No op leaves a bare `---` at line 0.
  if (isSeparatorLine(r.lines[0]) && frontMatterEnd(r.lines) === -1) return null;
  if (!deckDraftValid(r.lines, after)) return null;
  return { lines: r.lines, map: r.map };
}

/** Merges sorted ranges that share lines (zero-length ones are kept as they are). */
function ranges(lines: readonly number[]): LineRange[] {
  const out: LineRange[] = [];
  for (const i of lines) {
    const last = out.at(-1);
    if (last && last.end === i) last.end = i + 1;
    else out.push({ start: i, end: i + 1 });
  }
  return out;
}

/**
 * Every range of `lines` the op removes or rewrites, and every point it inserts at as a
 * zero-length range, in the lines before the op: what no other socket's lease may overlap
 * (liveLines.ts structOverlaps). Line 0 is listed whenever the deck has front matter (it is then
 * `fm_open`, which no lease can hold). Null when the op does not apply.
 */
export function slidesTouches(lines: readonly string[], op: SlidesStructOp): LineRange[] | null {
  const layout = deckLayout(lines);
  const r = run(lines, layout, op);
  if (!r) return null;
  const removed: number[] = [];
  for (let i = 0; i < r.map.length; i++) if (r.map[i] === -1) removed.push(i);
  const out: LineRange[] = [...ranges(removed), ...r.plan.rewrites];
  // Insertion points: where a run of lines of the result that came from nowhere sits, as the
  // line after the last kept line before it.
  const from = lineSources(r.map, r.lines.length);
  let prevKept = -1;
  let inRun = false;
  for (let j = 0; j < from.length; j++) {
    const i = from[j] as number;
    if (i >= 0) {
      prevKept = i;
      inRun = false;
    } else if (!inRun) {
      inRun = true;
      out.push({ start: prevKept + 1, end: prevKept + 1 });
    }
  }
  if (layout.frontMatterEnd > 0) out.push({ start: 0, end: 1 });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
