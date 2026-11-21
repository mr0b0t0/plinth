// The design type's content format (design.html): shared <head> tags, then artboards, each one
// starting with a whole line <!-- artboard name="Home" size="iphone" --> and followed by its HTML
// fragment, and canvas notes, each a whole line <!-- note kind="title" --> followed by its plain
// text. One pure parser for the Worker (validation, titles) and the design renderer
// (apps/web/src/renderers/design/), and the document one artboard frame renders.
//
// The parser is a hand-written line scanner with a linear attribute tokenizer (no regular
// expression runs over a whole line), so its cost is linear in the source whatever it holds.
import { ARTIFACT_IFRAME_SANDBOX_OPAQUE } from "./constants.ts";
import { escapeHtml } from "./markdown.ts";

export const DESIGN_LIMITS = {
  maxBoards: 60,
  minSide: 16,
  maxSide: 4096,
  maxNameLength: 80,
  maxIdLength: 40,
  maxSectionLength: 60,
  maxAttrLength: 120,
  /** Problems one parse reports, in line order. */
  maxIssues: 20,
  /** Board frames alive at once on the canvas; the rest are placeholders. */
  maxLiveFrames: 24,
  minZoom: 0.05,
  maxZoom: 4,
  /** The tallest a board with height="auto" grows to fit its content. */
  maxAutoHeight: 8000,
  /** x and y on the canvas, in CSS px either side of 0. */
  maxCoord: 100_000,
  maxNotes: 60,
  maxNoteLength: 1000,
  /** A note's width (a sticky's, or the most a title takes before it wraps). */
  minNoteWidth: 80,
  maxNoteWidth: 4096,
  /** A sticky's width when it gives none. */
  stickyWidth: 240,
} as const;

export interface DesignPreset {
  width: number;
  height: number;
  label: string;
  group: "Screens" | "Social" | "Ads" | "Print" | "Slides";
}

const preset = (
  group: DesignPreset["group"],
  label: string,
  width: number,
  height: number,
): DesignPreset => ({ width, height, label, group });

/** Size presets in CSS px (print sizes at 96 px per inch). One preset per line. */
export const DESIGN_PRESETS: Readonly<Record<string, DesignPreset>> = Object.freeze({
  iphone: preset("Screens", "iPhone", 393, 852),
  "iphone-pro-max": preset("Screens", "iPhone Pro Max", 430, 932),
  android: preset("Screens", "Android", 412, 915),
  ipad: preset("Screens", "iPad", 820, 1180),
  "ipad-landscape": preset("Screens", "iPad landscape", 1180, 820),
  laptop: preset("Screens", "Laptop", 1280, 800),
  desktop: preset("Screens", "Desktop", 1440, 900),
  "desktop-hd": preset("Screens", "Desktop HD", 1920, 1080),
  "instagram-post": preset("Social", "Instagram post", 1080, 1080),
  "instagram-portrait": preset("Social", "Instagram portrait", 1080, 1350),
  story: preset("Social", "Story", 1080, 1920),
  "x-post": preset("Social", "X post", 1600, 900),
  "linkedin-post": preset("Social", "LinkedIn post", 1200, 627),
  "facebook-cover": preset("Social", "Facebook cover", 1640, 624),
  "og-image": preset("Social", "Open Graph image", 1200, 630),
  "youtube-thumbnail": preset("Social", "YouTube thumbnail", 1280, 720),
  "ad-medium-rectangle": preset("Ads", "Medium rectangle", 300, 250),
  "ad-leaderboard": preset("Ads", "Leaderboard", 728, 90),
  "ad-wide-skyscraper": preset("Ads", "Wide skyscraper", 160, 600),
  "ad-half-page": preset("Ads", "Half page", 300, 600),
  "ad-billboard": preset("Ads", "Billboard", 970, 250),
  "ad-mobile-banner": preset("Ads", "Mobile banner", 320, 50),
  "ad-large-mobile-banner": preset("Ads", "Large mobile banner", 320, 100),
  a5: preset("Print", "A5", 559, 794),
  a4: preset("Print", "A4", 794, 1123),
  "a4-landscape": preset("Print", "A4 landscape", 1123, 794),
  a3: preset("Print", "A3", 1123, 1587),
  letter: preset("Print", "Letter", 816, 1056),
  "letter-landscape": preset("Print", "Letter landscape", 1056, 816),
  "poster-18x24": preset("Print", "Poster 18x24 in", 1728, 2304),
  "business-card": preset("Print", "Business card", 336, 192),
  "slide-16x9": preset("Slides", "Slide 16:9", 1920, 1080),
  "slide-4x3": preset("Slides", "Slide 4:3", 1024, 768),
});

export interface DesignBoard {
  id: string;
  name: string;
  width: number;
  height: number;
  /** The preset key the size came from, or null for a free size. */
  preset: string | null;
  background: string;
  section: string | null;
  /**
   * height="auto": a fluid page, as tall as its content once it has loaded, from `height` (its
   * least height: the size's height, or 10/16 of the width) up to DESIGN_LIMITS.maxAutoHeight.
   */
  autoHeight: boolean;
  /** Where the board sits on the canvas (its top-left corner), or null to be packed in rows. */
  x: number | null;
  y: number | null;
  /** 1-based line of the marker. */
  line: number;
  /** The fragment, verbatim. */
  html: string;
}

/** Sticky note fills (a title note takes the canvas's own ink). */
export const DESIGN_NOTE_COLORS = [
  "yellow",
  "gray",
  "red",
  "orange",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type DesignNoteColor = (typeof DESIGN_NOTE_COLORS)[number];

/** Text on the canvas itself, never in a board: a title over a group of boards, or a sticky. */
export interface DesignNote {
  kind: "title" | "sticky";
  /** Plain text, shown as text (never read as HTML); line breaks kept. */
  text: string;
  /** A sticky's width, or the most a title takes before it wraps; null for the default. */
  width: number | null;
  color: DesignNoteColor;
  x: number | null;
  y: number | null;
  /** How many boards come before it in the source: its place among the packed rows. */
  after: number;
  /** 1-based line of the marker. */
  line: number;
}

export interface DesignSource {
  /** Everything before the first marker, verbatim: copied into every board's <head>. */
  shared: string;
  boards: DesignBoard[];
  notes: DesignNote[];
}

export interface DesignIssue {
  /** 1-based line, or 0 for the whole source. */
  line: number;
  /** The board's name, when the issue is about one board and it has one. */
  board?: string;
  message: string;
}

export type DesignParse = { ok: true; design: DesignSource } | { ok: false; issues: DesignIssue[] };

/** postMessage protocol between the design renderer and its board loader frames. */
export const BOARD_MESSAGE_SOURCE = "plinth-board";
export const BOARD_PROTOCOL_VERSION = 1;
/** Every board frame's sandbox: the opaque artifact flags, never allow-same-origin. */
export const BOARD_IFRAME_SANDBOX = ARTIFACT_IFRAME_SANDBOX_OPAQUE;
/** The board loader's file name under /__plinth/frames/design/ (the registry's renderer.frame). */
export const BOARD_LOADER_FILE = "board.html";

/**
 * A link to one board: `#board=<id>` is the app address's fragment for a design opened at that
 * board (a deep link), and a link inside a board with that exact href moves the canvas to the
 * other board (a prototype flow).
 */
export const BOARD_LINK_PREFIX = "#board=";

/** Whether a value is a board id as the parser makes them: a-z, 0-9 and -, up to 40. */
export function isArtboardId(v: unknown): v is string {
  return typeof v === "string" && v.length <= DESIGN_LIMITS.maxIdLength && ID_RE.test(v);
}

/** The board an href or fragment names (`#board=<id>`), or null. */
export function boardLinkId(href: string): string | null {
  if (!href.startsWith(BOARD_LINK_PREFIX)) return null;
  const id = href.slice(BOARD_LINK_PREFIX.length);
  return isArtboardId(id) ? id : null;
}

// The server's PNG and PDF export (services/designExport.ts in the Worker) opens the shell
// top-level with print media emulated, where the renderer lays every board out at 100% (boot.ts),
// and evaluates these expressions in its own copy of the page. They are Plinth's own text: a board
// id is [a-z0-9-] and is quoted as a JSON string all the same.

/** The renderer's element for each board, keyed by data-board. */
const EXPORT_BOARD_SELECTOR = ".plinth-design__board";

/** True once the renderer has taken the export layout (never the canvas). */
export const DESIGN_EXPORT_LAYOUT_SCRIPT = 'document.documentElement.hasAttribute("data-export")';

/**
 * Removes every board but `id` from the page before the boards load, so one board's export waits
 * for and prints only that board. Evaluates to whether that board is on the page.
 */
export function designExportKeepOnlyScript(id: string): string {
  return `(() => { const id = ${JSON.stringify(id)}; let found = false; for (const el of document.querySelectorAll(${JSON.stringify(EXPORT_BOARD_SELECTOR)})) { if (el.getAttribute("data-board") === id) found = true; else el.remove(); } return found; })()`;
}

/** True once the export's boards have loaded: the one board, or `boards` of them. */
export function designExportLoadedScript(board: string | null, boards: number): string {
  return board !== null
    ? `document.querySelector(${JSON.stringify(`${EXPORT_BOARD_SELECTOR}[data-board=${JSON.stringify(board)}][data-loaded]`)}) !== null`
    : `Number(document.documentElement.getAttribute("data-boards-loaded") || "0") >= ${Math.trunc(boards)}`;
}

/** The board's element, for the PNG's box. */
export function designExportBoardSelector(id: string): string {
  return `${EXPORT_BOARD_SELECTOR}[data-board=${JSON.stringify(id)}]`;
}

const ATTRS = ["id", "name", "size", "width", "height", "background", "section", "x", "y"] as const;
type Attr = (typeof ATTRS)[number];
const ATTR_SET: ReadonlySet<string> = new Set(ATTRS);
const NOTE_ATTRS = ["kind", "x", "y", "width", "color"] as const;
type NoteAttr = (typeof NOTE_ATTRS)[number];
const NOTE_ATTR_SET: ReadonlySet<string> = new Set(NOTE_ATTRS);
const NOTE_COLOR_SET: ReadonlySet<string> = new Set(DESIGN_NOTE_COLORS);
const COORD_RE = /^-?[0-9]{1,6}$/;

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** The board id pattern, for the board loader's own script (which links it follows). */
export const BOARD_ID_PATTERN = ID_RE.source;
const SIDE_RE = /^[0-9]{1,5}$/;
const SIZE_RE = /^([0-9]{1,5})x([0-9]{1,5})$/;
const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent|[a-zA-Z]{3,20})$/;
const DEFAULT_BACKGROUND = "#ffffff";

/** A source that is a whole HTML page, not a design. */
const WHOLE_DOCUMENT_RE = /^\s*(?:<!doctype|<html[\s>])/i;

export const DESIGN_MESSAGES = {
  noBoards:
    'A design needs artboards: start each one with a line <!-- artboard name="Home" size="iphone" --> followed by its HTML.',
  wholeDocument:
    'A design is shared <head> tags followed by artboards, not a whole HTML document. Start each artboard with a line <!-- artboard name="Home" size="iphone" -->, or publish type "html" for one page.',
} as const;

type MarkerKind = "artboard" | "note";

/**
 * The marker's kind and attribute text (after the word `artboard` or `note`), or null for a line
 * that is not one.
 */
function markerBody(line: string): { kind: MarkerKind; body: string } | null {
  const t = line.trim();
  if (t.length < 7 || !t.startsWith("<!--") || !t.endsWith("-->")) return null;
  const inner = t.slice(4, -3).trim();
  for (const kind of ["artboard", "note"] as const) {
    if (!inner.startsWith(kind)) continue;
    const after = inner.charCodeAt(kind.length);
    // The word alone, or followed by whitespace; never "artboards" or "notes".
    if (inner.length > kind.length && after !== 0x20 && after !== 0x09) return null;
    return { kind, body: inner.slice(kind.length) };
  }
  return null;
}

function isControl(c: number): boolean {
  return c < 0x20 || c === 0x7f;
}

/** name="value" pairs, read once from left to right. A string is the reason it cannot be read. */
function tokenize(body: string, kind: MarkerKind): Map<string, string> | { error: string } {
  const allowed = kind === "note" ? NOTE_ATTR_SET : ATTR_SET;
  const names = kind === "note" ? NOTE_ATTRS : ATTRS;
  const out = new Map<string, string>();
  let i = 0;
  const n = body.length;
  const unreadable = { error: `write ${kind} attributes as name="value".` };
  while (i < n) {
    const c = body.charCodeAt(i);
    if (c === 0x20 || c === 0x09) {
      i++;
      continue;
    }
    const start = i;
    while (i < n) {
      const k = body.charCodeAt(i);
      const letter = (k >= 0x61 && k <= 0x7a) || (k >= 0x41 && k <= 0x5a) || k === 0x2d;
      if (!letter) break;
      i++;
    }
    if (i === start || body[i] !== "=" || body[i + 1] !== '"') return unreadable;
    const name = body.slice(start, i).toLowerCase();
    i += 2;
    const vStart = i;
    while (i < n && body[i] !== '"') {
      const k = body.charCodeAt(i);
      if (isControl(k) || k === 0x3c || k === 0x3e) {
        return { error: `the value of ${name} may not contain <, > or control characters.` };
      }
      i++;
    }
    if (i >= n) return unreadable;
    const value = body.slice(vStart, i);
    i++;
    if (i < n && body[i] !== " " && body[i] !== "\t") return unreadable;
    if (value.length > DESIGN_LIMITS.maxAttrLength) {
      return {
        error: `the value of ${name} is longer than ${DESIGN_LIMITS.maxAttrLength} characters.`,
      };
    }
    if (!allowed.has(name)) {
      return {
        error: `${kind} attribute "${name}" is not one of ${names.join(", ")}.`,
      };
    }
    if (out.has(name)) return { error: `${kind} attribute "${name}" is given twice.` };
    out.set(name, value);
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/** The board's name slugged into an id: ASCII lowercase, other runs to "-", trimmed, 40 at most. */
export function slugBoardId(name: string, max: number = DESIGN_LIMITS.maxIdLength): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "");
  return slug.slice(0, max).replace(/-+$/, "");
}

function side(v: string): number | null {
  return SIDE_RE.test(v) ? Number(v) : null;
}

/** The preset keys for messages: "iphone, iphone-pro-max, ...". */
const PRESET_LIST = Object.keys(DESIGN_PRESETS).join(", ");

interface Marker {
  kind: MarkerKind;
  line: number;
  attrs: Map<string, string>;
  /** Index into the source's lines of the marker line. */
  index: number;
}

/** x and y, both or neither: null when neither, a string when they cannot be read. */
function readPlace(
  x: string | undefined,
  y: string | undefined,
  at: string,
  what: string,
): { x: number; y: number } | null | string {
  if (x === undefined && y === undefined) return null;
  const max = DESIGN_LIMITS.maxCoord;
  const help = `${at} give the ${what} both x and y, whole CSS px from -${max} to ${max}, or neither.`;
  if (x === undefined || y === undefined || !COORD_RE.test(x) || !COORD_RE.test(y)) return help;
  const px = Number(x);
  const py = Number(y);
  if (Math.abs(px) > max || Math.abs(py) > max) return help;
  return { x: px === 0 ? 0 : px, y: py === 0 ? 0 : py };
}

/** A note's text: the lines after its marker, without blank lines round them. */
function noteText(lines: readonly string[]): string {
  const clean = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l).trimEnd());
  let a = 0;
  let b = clean.length;
  while (a < b && clean[a]?.trim() === "") a++;
  while (b > a && clean[b - 1]?.trim() === "") b--;
  return clean.slice(a, b).join("\n");
}

/** The least height of a fluid board given only a width: 10/16 of it, within the side limits. */
export function autoStartHeight(width: number): number {
  return Math.min(
    DESIGN_LIMITS.maxSide,
    Math.max(DESIGN_LIMITS.minSide, Math.round((width * 10) / 16)),
  );
}

/**
 * Parse a design source. At most DESIGN_LIMITS.maxIssues problems, in line order; the first one is
 * what a refusal says. A marker line inside a <script> at the start of a line still starts a board
 * or a note (only whole lines are read, never HTML). A note's lines are its text, not part of the
 * board before it.
 */
export function parseDesign(input: string): DesignParse {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (WHOLE_DOCUMENT_RE.test(text.slice(0, 1024))) {
    return { ok: false, issues: [{ line: 1, message: DESIGN_MESSAGES.wholeDocument }] };
  }
  const lines = text.split("\n");
  const issues: DesignIssue[] = [];
  // Unreadable markers are capped as they are found (a source may hold many); the board checks
  // after them run on at most maxBoards markers, and the whole list is sorted and capped at the end.
  const add = (issue: DesignIssue) => {
    issues.push(issue);
  };
  const markers: Marker[] = [];
  let boardMarkers = 0;
  let noteMarkers = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const found = markerBody(line);
    if (found === null) continue;
    if (found.kind === "artboard") boardMarkers++;
    else noteMarkers++;
    const parsed = tokenize(found.body, found.kind);
    if ("error" in parsed) {
      if (issues.length < DESIGN_LIMITS.maxIssues) {
        add({ line: i + 1, message: `Line ${i + 1}: ${parsed.error}` });
      }
      markers.push({ kind: found.kind, line: i + 1, attrs: new Map(), index: i });
      continue;
    }
    markers.push({ kind: found.kind, line: i + 1, attrs: parsed, index: i });
  }
  if (boardMarkers === 0) {
    return { ok: false, issues: [{ line: 0, message: DESIGN_MESSAGES.noBoards }] };
  }
  if (boardMarkers > DESIGN_LIMITS.maxBoards) {
    return {
      ok: false,
      issues: [
        {
          line: 0,
          message: `A design has at most ${DESIGN_LIMITS.maxBoards} artboards; this one has ${boardMarkers}. Split it into two designs.`,
        },
      ],
    };
  }
  if (noteMarkers > DESIGN_LIMITS.maxNotes) {
    return {
      ok: false,
      issues: [
        {
          line: 0,
          message: `A design has at most ${DESIGN_LIMITS.maxNotes} notes; this one has ${noteMarkers}.`,
        },
      ],
    };
  }

  // Explicit ids first, so a derived id never takes one a later board names.
  const taken = new Map<string, number>();
  const unreadable = new Set(issues.map((x) => x.line));
  for (const m of markers) {
    if (m.kind !== "artboard") continue;
    const id = m.attrs.get("id");
    if (id === undefined) continue;
    if (!ID_RE.test(id)) {
      add({
        line: m.line,
        message: `Line ${m.line}: id "${id}" may use a-z, 0-9 and -, up to ${DESIGN_LIMITS.maxIdLength}.`,
      });
      continue;
    }
    const first = taken.get(id);
    if (first !== undefined) {
      add({
        line: m.line,
        message: `Line ${m.line}: id "${id}" is already used on line ${first}.`,
      });
      continue;
    }
    taken.set(id, m.line);
  }

  const boards: DesignBoard[] = [];
  const notes: DesignNote[] = [];
  let boardsSoFar = 0;
  for (const [n, m] of markers.entries()) {
    const end = markers[n + 1]?.index ?? lines.length;
    if (m.kind === "note") {
      if (!unreadable.has(m.line)) {
        const note = readNote(m, lines.slice(m.index + 1, end), boardsSoFar, add);
        if (note) notes.push(note);
      }
      continue;
    }
    const k = boardsSoFar++;
    if (unreadable.has(m.line)) continue;
    const a = (key: Attr) => m.attrs.get(key);
    const at = `Line ${m.line}:`;
    const nameRaw = a("name");
    const name = nameRaw === undefined ? "" : decodeEntities(nameRaw).trim();
    if (!name) {
      add({ line: m.line, message: `${at} the artboard needs a name="...".` });
      continue;
    }
    const label = { line: m.line, board: name };
    if (name.length > DESIGN_LIMITS.maxNameLength) {
      add({
        ...label,
        message: `${at} the artboard name is longer than ${DESIGN_LIMITS.maxNameLength} characters.`,
      });
      continue;
    }

    const size = a("size");
    const w = a("width");
    const hRaw = a("height");
    // height="auto": a fluid board, its width from `size` or `width`.
    const autoHeight = hRaw === "auto";
    const h = autoHeight ? undefined : hRaw;
    let width: number | null = null;
    let height: number | null = null;
    let presetKey: string | null = null;
    const sizeHelp = `${at} give the artboard size="iphone" (a preset), size="1080x1080", or width and height, only one of them.`;
    if (size !== undefined && (w !== undefined || h !== undefined)) {
      add({ ...label, message: sizeHelp });
      continue;
    }
    let shown = "";
    if (size !== undefined) {
      const free = SIZE_RE.exec(size);
      if (free) {
        width = Number(free[1]);
        height = Number(free[2]);
        shown = size;
      } else if (Object.hasOwn(DESIGN_PRESETS, size)) {
        const p = DESIGN_PRESETS[size] as DesignPreset;
        width = p.width;
        height = p.height;
        presetKey = size;
      } else {
        add({
          ...label,
          message: `${at} "${size}" is not a size preset. Presets: ${PRESET_LIST} (or use size="WxH").`,
        });
        continue;
      }
    } else if (w !== undefined && autoHeight) {
      width = side(w);
      shown = `${w}x${hRaw}`;
      if (width === null) {
        add({ ...label, message: sizeHelp });
        continue;
      }
      height = autoStartHeight(width);
    } else if (w !== undefined && h !== undefined) {
      width = side(w);
      height = side(h);
      shown = `${w}x${h}`;
      if (width === null || height === null) {
        add({ ...label, message: sizeHelp });
        continue;
      }
    } else {
      add({ ...label, message: sizeHelp });
      continue;
    }
    const { minSide, maxSide } = DESIGN_LIMITS;
    if (width < minSide || width > maxSide || height < minSide || height > maxSide) {
      add({
        ...label,
        message: `${at} artboard sides are ${minSide} to ${maxSide} px; "${shown}" is not.`,
      });
      continue;
    }

    const bg = a("background");
    if (bg !== undefined && !COLOR_RE.test(bg)) {
      add({ ...label, message: `${at} background is a hex color, transparent or a color name.` });
      continue;
    }

    const sectionRaw = a("section");
    let section: string | null = null;
    if (sectionRaw !== undefined) {
      section = decodeEntities(sectionRaw).trim();
      if (!section || section.length > DESIGN_LIMITS.maxSectionLength) {
        add({
          ...label,
          message: `${at} section is 1 to ${DESIGN_LIMITS.maxSectionLength} characters.`,
        });
        continue;
      }
    }

    const place = readPlace(a("x"), a("y"), at, "artboard");
    if (typeof place === "string") {
      add({ ...label, message: place });
      continue;
    }

    let id = a("id");
    if (id === undefined) {
      const base = slugBoardId(name) || `board-${k + 1}`;
      id = base;
      for (let j = 2; taken.has(id); j++) {
        const suffix = `-${j}`;
        id = `${slugBoardId(base, DESIGN_LIMITS.maxIdLength - suffix.length)}${suffix}`;
      }
      taken.set(id, m.line);
    } else if (!ID_RE.test(id) || taken.get(id) !== m.line) {
      // Reported above.
      continue;
    }

    boards.push({
      id,
      name,
      width,
      height,
      preset: presetKey,
      background: bg ?? DEFAULT_BACKGROUND,
      section,
      autoHeight,
      x: place?.x ?? null,
      y: place?.y ?? null,
      line: m.line,
      html: lines.slice(m.index + 1, end).join("\n"),
    });
  }

  if (issues.length > 0) {
    issues.sort((x, y) => x.line - y.line);
    return { ok: false, issues: issues.slice(0, DESIGN_LIMITS.maxIssues) };
  }
  const first = markers[0] as Marker;
  return {
    ok: true,
    design: { shared: lines.slice(0, first.index).join("\n"), boards, notes },
  };
}

/** A note marker and its lines, read, or null after reporting why not. */
function readNote(
  m: Marker,
  body: readonly string[],
  after: number,
  add: (issue: DesignIssue) => void,
): DesignNote | null {
  const a = (key: NoteAttr) => m.attrs.get(key);
  const at = `Line ${m.line}:`;
  const issue = (message: string) => {
    add({ line: m.line, message });
    return null;
  };
  const kind = a("kind") ?? "sticky";
  if (kind !== "title" && kind !== "sticky") {
    return issue(`${at} a note's kind is "title" or "sticky".`);
  }
  const text = noteText(body);
  if (!text) {
    return issue(`${at} write the note's text on the lines after its marker.`);
  }
  if (text.length > DESIGN_LIMITS.maxNoteLength) {
    return issue(`${at} a note's text is at most ${DESIGN_LIMITS.maxNoteLength} characters.`);
  }
  let width: number | null = null;
  const w = a("width");
  if (w !== undefined) {
    width = side(w);
    const { minNoteWidth: lo, maxNoteWidth: hi } = DESIGN_LIMITS;
    if (width === null || width < lo || width > hi) {
      return issue(`${at} a note's width is ${lo} to ${hi} px.`);
    }
  }
  const colorRaw = a("color");
  if (kind === "title" && colorRaw !== undefined) {
    return issue(`${at} color is for a sticky note; a title takes the canvas's own ink.`);
  }
  const color = colorRaw ?? "yellow";
  if (!NOTE_COLOR_SET.has(color)) {
    return issue(`${at} a note's color is one of ${DESIGN_NOTE_COLORS.join(", ")}.`);
  }
  const place = readPlace(a("x"), a("y"), at, "note");
  if (typeof place === "string") return issue(place);
  return {
    kind,
    text,
    width,
    color: color as DesignNoteColor,
    x: place?.x ?? null,
    y: place?.y ?? null,
    after,
    line: m.line,
  };
}

/** The first issue as a sentence, with "and N more" when there are others. */
export function designIssueSummary(issues: readonly DesignIssue[]): string {
  const first = issues[0]?.message ?? DESIGN_MESSAGES.noBoards;
  return issues.length > 1
    ? `${first} (and ${issues.length - 1} more problem${issues.length === 2 ? "" : "s"})`
    : first;
}

/**
 * The document one board frame renders: Plinth's base, viewport and reset first, then the shared
 * section, then the fragment, all verbatim. Pure. `baseHref` is where the board's relative URLs
 * resolve (the shown version's own path, /__plinth/v/<n>/); the first <base> wins, so an author's own cannot redirect
 * them. Sizes are integers and the background passed the parser's charset, so neither can break
 * out of the reset rule. A fluid board (height="auto") gets no height, so its document is as tall
 * as its content, which the board loader measures.
 */
export function boardDocument(o: { board: DesignBoard; shared: string; baseHref: string }): string {
  const { board } = o;
  const w = Math.trunc(board.width);
  const h = Math.trunc(board.height);
  const bg = COLOR_RE.test(board.background) ? board.background : DEFAULT_BACKGROUND;
  const reset =
    board.autoHeight === true
      ? `html{width:${w}px;overflow:hidden;background:${bg}}body{margin:0}`
      : `html{width:${w}px;height:${h}px;overflow:hidden;background:${bg}}body{margin:0;min-height:100%}`;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">\n' +
    `<base href="${escapeHtml(o.baseHref)}">\n` +
    `<meta name="viewport" content="width=${w}, initial-scale=1">\n` +
    `<title>${escapeHtml(board.name)}</title>\n` +
    `<style>${reset}</style>\n` +
    `${o.shared}\n` +
    "</head><body>\n" +
    `${board.html}\n` +
    "</body></html>"
  );
}
