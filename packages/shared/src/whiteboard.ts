// The whiteboard type's format (docs/spec.md "Whiteboards"). A board's blocks and arrows are
// shared data, two collections in the artifact's document store; a version holds only the board's
// settings, in board.json. Publishing a new board may carry a starting set of blocks and arrows,
// which the Worker writes into shared data once and never stores in the version.
//
// Format 1 grew without a new version: every field added since (shapes, sections, tables, text
// size and alignment, any #rrggbb, outlines, arrow sides, routes and heads) is optional, so a
// board written before reads the same.
//
// Pure code with no dependencies, used by the Worker (validation of board.json and of every
// whiteboard document write) and by the whiteboard renderer (lenient readers, arrow geometry).
import { LIMITS } from "./constants.ts";
import type { Capabilities } from "./data.ts";

export const BOARD_FORMAT_VERSION = 1;
/** The two collections a board keeps, both shared: any permitted writer may move any block. */
export const BOARD_COLLECTIONS = ["blocks", "arrows"] as const;
export type BoardCollection = (typeof BOARD_COLLECTIONS)[number];
/**
 * The room topics a board's page emits: a block being dragged, and a block or arrow just saved.
 * Commenters may emit them on a board whose `edit` is "commenters".
 */
export const BOARD_TOPICS = ["block.move", "block.saved", "arrow.saved"] as const;
/**
 * The outlined shapes a block can be: Plinth's box (`rect`) and ellipse, and the rest of Claude's
 * whiteboard set. Each is drawn from shapePath (whiteboardDraw.ts), on the page and in both
 * exports.
 */
export const SHAPE_KINDS = [
  "rect",
  "rounded",
  "ellipse",
  "diamond",
  "pill",
  "hexagon",
  "parallelogram",
  "database",
  "queue",
  "document",
  "cloud",
  "person",
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
/**
 * Every kind of block: a note, words with no box (`text`), a shape, a section that holds other
 * blocks (`container`: drawn behind every other block, its text the title above it) and a table.
 */
export const BLOCK_KINDS = ["note", "text", ...SHAPE_KINDS, "container", "table"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const isShapeKind = (k: unknown): k is ShapeKind =>
  typeof k === "string" && (SHAPE_KINDS as readonly string[]).includes(k);
export const BOARD_COLORS = ["yellow", "green", "blue", "pink", "purple", "gray"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];
/** Any colour as `#rrggbb`, drawn as written in both themes. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export type HexColor = `#${string}`;
/** A fill: one of the board's colours (which follow the theme) or any `#rrggbb`. */
export type BoardPaint = BoardColor | HexColor;
/**
 * A line or text colour: "ink" (the board's text colour), a board colour's deeper tone, or any
 * `#rrggbb`.
 */
export type BoardInk = BoardColor | "ink" | HexColor;
/** Text sizes, named as Claude's whiteboard names them, in board units (px at 100%). */
export const TEXT_SIZES = ["small", "body", "large", "title", "huge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_PX: { readonly [K in TextSize]: number } = {
  small: 14,
  body: 16,
  large: 28,
  title: 48,
  huge: 96,
};
/** A block's text size when it names none: 14, as every board drew it before sizes. */
export const DEFAULT_TEXT_PX = 14;
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const ARROW_SIDES = ["top", "right", "bottom", "left"] as const;
export type ArrowSide = (typeof ARROW_SIDES)[number];
/** What each end of an arrow can carry (`heads`: the from end, then the to end). */
export const ARROW_END_HEADS = ["none", "arrow", "circle"] as const;
export type ArrowEndHead = (typeof ARROW_END_HEADS)[number];
export const BOARD_BACKGROUNDS = ["dots", "grid", "plain"] as const;
export type BoardBackground = (typeof BOARD_BACKGROUNDS)[number];
/**
 * The lowest role that may change the board from its page: "editors" unless the settings say
 * "commenters", so a commenter's role means view and comment until the owner opens the board.
 * Viewers never may.
 */
export const BOARD_EDIT_MODES = ["commenters", "editors"] as const;
export type BoardEditMode = (typeof BOARD_EDIT_MODES)[number];
/**
 * The settings' names and values as people read them: the Board settings dialog's labels, which
 * History's Compare page uses too ("Background: Dots → Grid").
 */
export const BOARD_SETTING_LABELS = {
  background: "Background",
  edit: "Who can change the board",
} as const;
export const BOARD_BACKGROUND_LABELS: { readonly [K in BoardBackground]: string } = {
  dots: "Dots",
  grid: "Grid",
  plain: "Plain",
};
export const BOARD_EDIT_LABELS: { readonly [K in BoardEditMode]: string } = {
  commenters: "Commenters and editors",
  editors: "Editors only",
};
export const ARROW_STYLES = ["solid", "dashed"] as const;
export const ARROW_HEADS = ["end", "both", "none"] as const;

export const BOARD_LIMITS = {
  /** Bytes of board.json a publish or update may send (the stored settings are far smaller). */
  maxBoardBytes: LIMITS.maxBoardBytes,
  /** |x| and |y| of a block, in board units. */
  maxCoord: 1_000_000,
  minSize: 24,
  maxSize: 4000,
  maxText: 4000,
  maxLabel: 120,
  /** A table's columns and rows, and one cell's characters. */
  maxTableCols: 40,
  maxTableRows: 500,
  maxCell: 1000,
  /** A column's width weight (its share of the table's w). */
  minColWidth: 10,
  /** Numbers in an arrow's planned route (`bends`), after its first direction. */
  maxBends: 12,
  /** |z| of a block: draw order is z, then id. */
  maxZ: 1_000_000,
  /** Blocks and arrows in a starting board, together. */
  seedDocs: 500,
} as const;

/** A document id as shared data takes it (data.ts DATA_DOC_ID_RE). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Personal documents (data.ts PERSONAL_DOC_PREFIX): a board has none. */
const PERSONAL_PREFIX = "u_";

/** A table's column: its place (`at`, low to high) and its width, a weight of the table's w. */
export interface TableCol {
  at: number;
  w?: number;
}

/**
 * A table's row: its place (`at`; the lowest is the header, drawn bold) and its cells by column
 * id, each a short plain text.
 */
export type TableRow = { at: number } & { [col: string]: string | number };

export interface BoardBlock {
  kind: BlockKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The block's words, a section's title; unused on a table. "" for none. */
  text: string;
  /** A fill (a note, shape or section; a table's header row), or the colour of a `text`'s words. */
  color?: BoardPaint;
  z?: number;
  /** An outline colour (a note, shape or section). */
  stroke?: BoardInk;
  /** No fill, only the outline (a note, shape or section). */
  hollow?: boolean;
  size?: TextSize;
  textAlign?: TextAlign;
  /** false: each line stays on one line instead of wrapping at the block's width. */
  wrap?: boolean;
  /** A table's columns and rows by id, its cell fills (row id, then column id) and its shading. */
  cols?: Record<string, TableCol>;
  rows?: Record<string, TableRow>;
  fills?: Record<string, Record<string, BoardPaint | "">>;
  heat?: { cols?: Record<string, BoardPaint>; rows?: Record<string, BoardPaint> };
}

export interface BoardArrow {
  from: string;
  to: string;
  label?: string;
  style?: (typeof ARROW_STYLES)[number];
  head?: (typeof ARROW_HEADS)[number];
  /** What each end carries, the from end then the to end; wins over `head`. */
  heads?: [ArrowEndHead, ArrowEndHead];
  /** The side of each block the arrow leaves or enters; with either, it runs in right angles. */
  fromSide?: ArrowSide;
  toSide?: ArrowSide;
  /**
   * A planned route: the direction it leaves `from` ("h" level, "v" upright), then where each
   * middle leg runs, the first half measured from the centre of `from` and the rest from `to`.
   */
  bends?: ["h" | "v", ...number[]];
  color?: BoardInk;
}

export interface BoardSettings {
  v: typeof BOARD_FORMAT_VERSION;
  background: BoardBackground;
  edit: BoardEditMode;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  v: BOARD_FORMAT_VERSION,
  background: "dots",
  edit: "editors",
};

export type SeedDoc =
  | { collection: "blocks"; id: string; data: BoardBlock }
  | { collection: "arrows"; id: string; data: BoardArrow };

/** A board.json that cannot be published: `path` names the offending value ("blocks[2].w"). */
export class BoardContentError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "BoardContentError";
    this.path = path;
  }
}

// ---------- checks ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

const intWithin = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Whether an id can name a block or arrow: a shared-data id that is not a personal one. */
export function isBoardId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id) && !id.startsWith(PERSONAL_PREFIX);
}

/** The first key of `v` outside `allowed`, or null. */
function unknownKey(v: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) return k;
  return null;
}

/** The text code points of a string, as the limits count them. */
function length(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** A fill: a board colour or `#rrggbb`. */
export function isBoardPaint(v: unknown): v is BoardPaint {
  return oneOf(BOARD_COLORS, v) || (typeof v === "string" && HEX_COLOR_RE.test(v));
}

/** A line or text colour: a fill's colours, or "ink". */
export function isBoardInk(v: unknown): v is BoardInk {
  return v === "ink" || isBoardPaint(v);
}

const PAINT_TEXT = `one of ${BOARD_COLORS.join(", ")}, or #rrggbb`;
const INK_TEXT = `ink, one of ${BOARD_COLORS.join(", ")}, or #rrggbb`;

const COMMON_KEYS = ["kind", "x", "y", "w", "h", "text", "color", "z"] as const;
/** What a note, a shape and a section add. */
const STYLE_KEYS = ["stroke", "hollow", "size", "textAlign", "wrap"] as const;
const TEXT_KEYS = ["size", "textAlign", "wrap"] as const;
const TABLE_KEYS = ["cols", "rows", "fills", "heat", "size", "textAlign"] as const;
const ALL_BLOCK_KEYS = [...new Set([...COMMON_KEYS, ...STYLE_KEYS, ...TABLE_KEYS])];
const ARROW_KEYS = [
  "from",
  "to",
  "label",
  "style",
  "head",
  "heads",
  "fromSide",
  "toSide",
  "bends",
  "color",
] as const;

/** The keys a block of `kind` may have. */
export function blockKeys(kind: BlockKind): readonly string[] {
  if (kind === "text") return [...COMMON_KEYS, ...TEXT_KEYS];
  if (kind === "table") return [...COMMON_KEYS, ...TABLE_KEYS];
  return [...COMMON_KEYS, ...STYLE_KEYS];
}

/** A table's column or row id: 1 to 40 of A-Z a-z 0-9 _ -, and never "at" (a row's place). */
const TABLE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const isTableId = (k: string) => TABLE_ID_RE.test(k) && k !== "at";
const TABLE_ID_TEXT = 'ids of 1 to 40 of A-Z a-z 0-9 _ -, never "at"';

/** Why a table's own fields are wrong: [path, message], or null. */
function tableProblem(data: Record<string, unknown>): [string, string] | null {
  const L = BOARD_LIMITS;
  const { cols, rows, fills, heat } = data;
  if (!isObject(cols)) return ["cols", "an object of columns by id: { c1: { at: 1, w: 160 } }"];
  const colIds = Object.keys(cols);
  if (colIds.length < 1 || colIds.length > L.maxTableCols) {
    return ["cols", `1 to ${L.maxTableCols} columns`];
  }
  for (const id of colIds) {
    const c = cols[id];
    if (!isTableId(id)) return [`cols.${id}`, TABLE_ID_TEXT];
    if (!isObject(c)) return [`cols.${id}`, "an object { at, w? }"];
    const extra = unknownKey(c, ["at", "w"]);
    if (extra !== null) return [`cols.${id}.${extra}`, "unknown key; a column has at, w"];
    if (!intWithin(c.at, -L.maxCoord, L.maxCoord)) return [`cols.${id}.at`, "a whole number"];
    if (c.w !== undefined && !intWithin(c.w, L.minColWidth, L.maxSize)) {
      return [`cols.${id}.w`, `a whole number from ${L.minColWidth} to ${L.maxSize}`];
    }
  }
  if (!isObject(rows)) return ["rows", 'an object of rows by id: { r1: { at: 1, c1: "Plan" } }'];
  const rowIds = Object.keys(rows);
  if (rowIds.length < 1 || rowIds.length > L.maxTableRows) {
    return ["rows", `1 to ${L.maxTableRows} rows`];
  }
  for (const id of rowIds) {
    const r = rows[id];
    if (!isTableId(id)) return [`rows.${id}`, TABLE_ID_TEXT];
    if (!isObject(r)) return [`rows.${id}`, "an object { at, <column id>: text }"];
    if (!intWithin(r.at, -L.maxCoord, L.maxCoord)) return [`rows.${id}.at`, "a whole number"];
    for (const [k, v] of Object.entries(r)) {
      if (k === "at") continue;
      if (!(k in cols)) return [`rows.${id}.${k}`, "a column id from cols"];
      if (typeof v !== "string") return [`rows.${id}.${k}`, "a string"];
      if (length(v) > L.maxCell) return [`rows.${id}.${k}`, `at most ${L.maxCell} characters`];
    }
  }
  if (fills !== undefined) {
    if (!isObject(fills)) return ["fills", "an object by row id, then column id"];
    for (const [rid, byCol] of Object.entries(fills)) {
      if (!(rid in rows)) return [`fills.${rid}`, "a row id from rows"];
      if (!isObject(byCol)) return [`fills.${rid}`, "an object by column id"];
      for (const [cid, v] of Object.entries(byCol)) {
        if (!(cid in cols)) return [`fills.${rid}.${cid}`, "a column id from cols"];
        if (v !== "" && !isBoardPaint(v)) return [`fills.${rid}.${cid}`, `${PAINT_TEXT}, or ""`];
      }
    }
  }
  if (heat !== undefined) {
    if (!isObject(heat)) return ["heat", "an object { cols } or { rows }"];
    const extra = unknownKey(heat, ["cols", "rows"]);
    if (extra !== null) return [`heat.${extra}`, "unknown key; heat has cols or rows"];
    if ((heat.cols === undefined) === (heat.rows === undefined)) {
      return ["heat", "one of cols or rows, not both"];
    }
    const which = heat.cols !== undefined ? "cols" : "rows";
    const named = which === "cols" ? cols : rows;
    const map = heat[which];
    if (!isObject(map)) return [`heat.${which}`, "an object of colours by id"];
    for (const [k, v] of Object.entries(map)) {
      if (!(k in named)) return [`heat.${which}.${k}`, `an id from ${which}`];
      if (!isBoardPaint(v)) return [`heat.${which}.${k}`, PAINT_TEXT];
    }
  }
  return null;
}

/** Why `data` is not a block: [path within the block, message], or null. */
function blockProblem(data: unknown): [string, string] | null {
  if (!isObject(data)) return ["", "a block is a JSON object"];
  const kind = oneOf(BLOCK_KINDS, data.kind) ? data.kind : null;
  const allowed = kind ? blockKeys(kind) : ALL_BLOCK_KEYS;
  const extra = unknownKey(data, allowed);
  if (extra !== null) {
    return [extra, `unknown key; a ${kind ?? "block"} block has ${allowed.join(", ")}`];
  }
  const L = BOARD_LIMITS;
  if (!kind) return ["kind", `one of ${BLOCK_KINDS.join(", ")}`];
  for (const k of ["x", "y"] as const) {
    if (!intWithin(data[k], -L.maxCoord, L.maxCoord)) {
      return [k, `a whole number from ${-L.maxCoord} to ${L.maxCoord}`];
    }
  }
  for (const k of ["w", "h"] as const) {
    if (!intWithin(data[k], L.minSize, L.maxSize)) {
      return [k, `a whole number from ${L.minSize} to ${L.maxSize}`];
    }
  }
  // A table has no words of its own; every other block names its text, "" for none.
  if (data.text !== undefined || kind !== "table") {
    if (typeof data.text !== "string") return ["text", "a string (empty for none)"];
    if (length(data.text) > L.maxText) return ["text", `at most ${L.maxText} characters`];
  }
  if (data.color !== undefined && !isBoardPaint(data.color)) return ["color", PAINT_TEXT];
  if (data.z !== undefined && !intWithin(data.z, -L.maxZ, L.maxZ)) {
    return ["z", `a whole number from ${-L.maxZ} to ${L.maxZ}`];
  }
  if (data.stroke !== undefined && !isBoardInk(data.stroke)) return ["stroke", INK_TEXT];
  if (data.hollow !== undefined && typeof data.hollow !== "boolean")
    return ["hollow", "true or false"];
  if (data.size !== undefined && !oneOf(TEXT_SIZES, data.size)) {
    return ["size", `one of ${TEXT_SIZES.join(", ")}`];
  }
  if (data.textAlign !== undefined && !oneOf(TEXT_ALIGNS, data.textAlign)) {
    return ["textAlign", `one of ${TEXT_ALIGNS.join(", ")}`];
  }
  if (data.wrap !== undefined && typeof data.wrap !== "boolean") return ["wrap", "true or false"];
  if (kind === "table") return tableProblem(data);
  return null;
}

/** Why `data` is not an arrow: [path within the arrow, message], or null. */
function arrowProblem(data: unknown): [string, string] | null {
  if (!isObject(data)) return ["", "an arrow is a JSON object"];
  const extra = unknownKey(data, ARROW_KEYS);
  if (extra !== null) return [extra, `unknown key; an arrow has ${ARROW_KEYS.join(", ")}`];
  if (!isBoardId(data.from)) return ["from", "the id of a block"];
  if (!isBoardId(data.to)) return ["to", "the id of a block"];
  if (data.from === data.to) return ["to", "an arrow joins two different blocks"];
  if (data.label !== undefined) {
    if (typeof data.label !== "string") return ["label", "a string"];
    if (length(data.label) > BOARD_LIMITS.maxLabel) {
      return ["label", `at most ${BOARD_LIMITS.maxLabel} characters`];
    }
  }
  if (data.style !== undefined && !oneOf(ARROW_STYLES, data.style)) {
    return ["style", `one of ${ARROW_STYLES.join(", ")}`];
  }
  if (data.head !== undefined && !oneOf(ARROW_HEADS, data.head)) {
    return ["head", `one of ${ARROW_HEADS.join(", ")}`];
  }
  if (data.heads !== undefined) {
    const h = data.heads;
    if (!Array.isArray(h) || h.length !== 2 || !h.every((x) => oneOf(ARROW_END_HEADS, x))) {
      return ["heads", `[from, to], each one of ${ARROW_END_HEADS.join(", ")}`];
    }
  }
  for (const k of ["fromSide", "toSide"] as const) {
    if (data[k] !== undefined && !oneOf(ARROW_SIDES, data[k])) {
      return [k, `one of ${ARROW_SIDES.join(", ")}`];
    }
  }
  if (data.bends !== undefined) {
    const b = data.bends;
    const L = BOARD_LIMITS;
    if (!Array.isArray(b) || (b[0] !== "h" && b[0] !== "v")) {
      return ["bends", '["h" or "v", then up to 12 whole numbers]'];
    }
    if (b.length - 1 > L.maxBends) return ["bends", `at most ${L.maxBends} numbers`];
    for (let i = 1; i < b.length; i++) {
      if (!intWithin(b[i], -L.maxCoord, L.maxCoord)) {
        return [`bends[${i}]`, `a whole number from ${-L.maxCoord} to ${L.maxCoord}`];
      }
    }
  }
  if (data.color !== undefined && !isBoardInk(data.color)) return ["color", INK_TEXT];
  return null;
}

/**
 * Why a document may not be written to a whiteboard's shared data, or null when it may. Checked
 * by the Worker on every whiteboard write, from the page, an agent or the app: only the `blocks`
 * and `arrows` collections, each document in its own shape. An arrow may name a block that does
 * not exist (yet, or any more): it is simply not drawn.
 */
export function boardDocError(collection: string, data: unknown): string | null {
  if (collection !== "blocks" && collection !== "arrows") {
    return "A whiteboard keeps only blocks and arrows";
  }
  const problem = collection === "blocks" ? blockProblem(data) : arrowProblem(data);
  if (!problem) return null;
  const [path, message] = problem;
  const what = collection === "blocks" ? "block" : "arrow";
  return path
    ? `Not a valid ${what}: ${path} must be ${message}`
    : `Not a valid ${what}: ${message}`;
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// ---------- board.json ----------

const SETTINGS_KEYS = ["v", "background", "edit"] as const;
const CONTENT_KEYS = [...SETTINGS_KEYS, "blocks", "arrows"] as const;

function settingsFrom(v: Record<string, unknown>, fail: (p: string, m: string) => never) {
  if (v.v !== BOARD_FORMAT_VERSION) fail("v", `must be ${BOARD_FORMAT_VERSION}`);
  if (v.background !== undefined && !oneOf(BOARD_BACKGROUNDS, v.background)) {
    fail("background", `must be one of ${BOARD_BACKGROUNDS.join(", ")}`);
  }
  if (v.edit !== undefined && !oneOf(BOARD_EDIT_MODES, v.edit)) {
    fail("edit", `must be one of ${BOARD_EDIT_MODES.join(", ")}`);
  }
  return {
    v: BOARD_FORMAT_VERSION,
    background: (v.background as BoardBackground | undefined) ?? DEFAULT_BOARD_SETTINGS.background,
    edit: (v.edit as BoardEditMode | undefined) ?? DEFAULT_BOARD_SETTINGS.edit,
  } satisfies BoardSettings;
}

/**
 * Read board.json as a publish or update sends it: the settings, and a starting board (`blocks`
 * and `arrows`, each item with its `id`) that only a new or empty board takes. Throws
 * BoardContentError with the path of the first problem: invalid JSON, an unknown key, a wrong
 * format version, a block or arrow out of shape, an id that is not a shared-data id or is a
 * personal one, an id used twice (blocks and arrows share one id space), an arrow naming a block
 * that is not in the same input, more than BOARD_LIMITS.seedDocs items, or more than
 * BOARD_LIMITS.maxBoardBytes of input.
 */
export function parseBoardContent(text: string): { settings: BoardSettings; seed: SeedDoc[] } {
  const fail = (path: string, message: string): never => {
    throw new BoardContentError(path, message);
  };
  if (utf8Length(text) > BOARD_LIMITS.maxBoardBytes) {
    fail("", `board.json is over ${BOARD_LIMITS.maxBoardBytes} bytes`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail("", 'board.json is not valid JSON; start from {"v": 1}');
  }
  if (!isObject(v)) return fail("", 'board.json is a JSON object such as {"v": 1}');
  const extra = unknownKey(v, CONTENT_KEYS);
  if (extra !== null) fail(extra, `unknown key; board.json has ${CONTENT_KEYS.join(", ")}`);
  const settings = settingsFrom(v, fail);

  const seed: SeedDoc[] = [];
  const ids = new Set<string>();
  const blockIds = new Set<string>();
  for (const name of BOARD_COLLECTIONS) {
    const list = v[name];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(name, "must be a list");
    for (const [i, item] of (list as unknown[]).entries()) {
      const at = `${name}[${i}]`;
      if (!isObject(item)) fail(at, "must be a JSON object");
      const { id, ...data } = item as Record<string, unknown>;
      if (!isBoardId(id)) {
        fail(
          `${at}.id`,
          "must be a letter or digit, then up to 63 of A-Z a-z 0-9 _ -, and not start with u_",
        );
      }
      if (ids.has(id as string)) fail(`${at}.id`, `${id as string} is used twice`);
      ids.add(id as string);
      const problem = name === "blocks" ? blockProblem(data) : arrowProblem(data);
      if (problem) fail(problem[0] ? `${at}.${problem[0]}` : at, `must be ${problem[1]}`);
      if (name === "blocks") {
        blockIds.add(id as string);
        seed.push({ collection: "blocks", id: id as string, data: data as unknown as BoardBlock });
      } else {
        seed.push({ collection: "arrows", id: id as string, data: data as unknown as BoardArrow });
      }
      if (seed.length > BOARD_LIMITS.seedDocs) {
        fail(name, `a starting board has at most ${BOARD_LIMITS.seedDocs} blocks and arrows`);
      }
    }
  }
  for (const [i, s] of seed.entries()) {
    if (s.collection !== "arrows") continue;
    const at = `arrows[${i - seed.findIndex((x) => x.collection === "arrows")}]`;
    if (!blockIds.has(s.data.from)) fail(`${at}.from`, `names no block in blocks: ${s.data.from}`);
    if (!blockIds.has(s.data.to)) fail(`${at}.to`, `names no block in blocks: ${s.data.to}`);
  }
  return { settings, seed };
}

/**
 * A stored board.json's settings. Lenient: a file that does not parse, or a value out of its
 * list, falls back to the default, so a board always renders and its capabilities always derive.
 */
export function parseBoardSettings(text: string): BoardSettings {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ...DEFAULT_BOARD_SETTINGS };
  }
  if (!isObject(v)) return { ...DEFAULT_BOARD_SETTINGS };
  return {
    v: BOARD_FORMAT_VERSION,
    background: oneOf(BOARD_BACKGROUNDS, v.background)
      ? v.background
      : DEFAULT_BOARD_SETTINGS.background,
    edit: oneOf(BOARD_EDIT_MODES, v.edit) ? v.edit : DEFAULT_BOARD_SETTINGS.edit,
  };
}

/** The canonical stored board.json: the settings only, two-space indent, a final newline. */
export function boardSettingsText(s: BoardSettings): string {
  const out: BoardSettings = { v: BOARD_FORMAT_VERSION, background: s.background, edit: s.edit };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * What a board's versions store as versions.capabilities: shared data with both collections
 * shared, viewer identity (cursors and the people list show names, and every viewer is told so),
 * the live room with the board's topics open to commenters on a "commenters" board, and the write
 * floor (`writers`) the policy module enforces on page writes and room emits.
 */
export function boardCapabilities(s: BoardSettings): Capabilities {
  const commenters = s.edit === "commenters";
  return {
    data: true,
    viewer: true,
    shared: [...BOARD_COLLECTIONS],
    room: true,
    roomOpen: commenters ? [...BOARD_TOPICS] : [],
    people: false,
    comments: false,
    hold: false,
    writers: commenters ? "commenter" : "editor",
  };
}

// ---------- the renderer's lenient readers ----------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A stored block as the renderer draws it, clamped into bounds and with unknown values dropped,
 * or null when it is not a block at all. The Worker already validates every write; this keeps a
 * hand-edited row from breaking the page.
 */
export function cleanBlock(data: unknown): BoardBlock | null {
  if (!isObject(data) || !finite(data.x) || !finite(data.y)) return null;
  const L = BOARD_LIMITS;
  const size = (v: unknown, d: number) =>
    finite(v) ? clamp(Math.round(v), L.minSize, L.maxSize) : d;
  const out: BoardBlock = {
    kind: oneOf(BLOCK_KINDS, data.kind) ? data.kind : "note",
    x: clamp(Math.round(data.x), -L.maxCoord, L.maxCoord),
    y: clamp(Math.round(data.y), -L.maxCoord, L.maxCoord),
    w: size(data.w, 200),
    h: size(data.h, 140),
    text: typeof data.text === "string" ? [...data.text].slice(0, L.maxText).join("") : "",
  };
  if (isBoardPaint(data.color)) out.color = data.color;
  if (finite(data.z)) out.z = clamp(Math.round(data.z), -L.maxZ, L.maxZ);
  if (isBoardInk(data.stroke)) out.stroke = data.stroke;
  if (data.hollow === true) out.hollow = true;
  if (oneOf(TEXT_SIZES, data.size)) out.size = data.size;
  if (oneOf(TEXT_ALIGNS, data.textAlign)) out.textAlign = data.textAlign;
  if (data.wrap === false) out.wrap = false;
  if (out.kind === "table") Object.assign(out, cleanTable(data));
  return out;
}

/**
 * A table's columns, rows, fills and shading, keeping every well-formed entry (a page's save
 * writes the block back whole, so nothing valid may be dropped here) and nothing else.
 */
function cleanTable(
  data: Record<string, unknown>,
): Pick<BoardBlock, "cols" | "rows" | "fills" | "heat"> {
  const L = BOARD_LIMITS;
  const place = (v: unknown) => clamp(Math.round(v as number), -L.maxCoord, L.maxCoord);
  const cols: Record<string, TableCol> = {};
  if (isObject(data.cols)) {
    for (const [id, c] of Object.entries(data.cols).slice(0, L.maxTableCols)) {
      if (!isTableId(id) || !isObject(c) || !finite(c.at)) continue;
      const col: TableCol = { at: place(c.at) };
      if (finite(c.w)) col.w = clamp(Math.round(c.w), L.minColWidth, L.maxSize);
      cols[id] = col;
    }
  }
  const rows: Record<string, TableRow> = {};
  if (isObject(data.rows)) {
    for (const [id, r] of Object.entries(data.rows).slice(0, L.maxTableRows)) {
      if (!isTableId(id) || !isObject(r) || !finite(r.at)) continue;
      const row: TableRow = { at: place(r.at) };
      for (const [k, v] of Object.entries(r)) {
        if (k !== "at" && k in cols && typeof v === "string") {
          row[k] = [...v].slice(0, L.maxCell).join("");
        }
      }
      rows[id] = row;
    }
  }
  const out: Pick<BoardBlock, "cols" | "rows" | "fills" | "heat"> = { cols, rows };
  if (isObject(data.fills)) {
    const fills: Record<string, Record<string, BoardPaint | "">> = {};
    for (const [rid, byCol] of Object.entries(data.fills)) {
      if (!(rid in rows) || !isObject(byCol)) continue;
      const kept: Record<string, BoardPaint | ""> = {};
      for (const [cid, v] of Object.entries(byCol)) {
        if (cid in cols && (v === "" || isBoardPaint(v))) kept[cid] = v;
      }
      fills[rid] = kept;
    }
    out.fills = fills;
  }
  if (isObject(data.heat)) {
    const which = isObject(data.heat.cols) ? "cols" : isObject(data.heat.rows) ? "rows" : null;
    if (which) {
      const named = which === "cols" ? cols : rows;
      const map: Record<string, BoardPaint> = {};
      for (const [k, v] of Object.entries(data.heat[which] as Record<string, unknown>)) {
        if (k in named && isBoardPaint(v)) map[k] = v;
      }
      out.heat = { [which]: map };
    }
  }
  return out;
}

/** A stored arrow as the renderer draws it, or null. */
export function cleanArrow(data: unknown): BoardArrow | null {
  if (!isObject(data) || !isBoardId(data.from) || !isBoardId(data.to)) return null;
  if (data.from === data.to) return null;
  const out: BoardArrow = { from: data.from, to: data.to };
  if (typeof data.label === "string" && data.label) {
    out.label = [...data.label].slice(0, BOARD_LIMITS.maxLabel).join("");
  }
  if (oneOf(ARROW_STYLES, data.style)) out.style = data.style;
  if (oneOf(ARROW_HEADS, data.head)) out.head = data.head;
  const h = data.heads;
  if (Array.isArray(h) && h.length === 2 && h.every((x) => oneOf(ARROW_END_HEADS, x))) {
    out.heads = [h[0], h[1]] as [ArrowEndHead, ArrowEndHead];
  }
  if (oneOf(ARROW_SIDES, data.fromSide)) out.fromSide = data.fromSide;
  if (oneOf(ARROW_SIDES, data.toSide)) out.toSide = data.toSide;
  const b = data.bends;
  if (Array.isArray(b) && (b[0] === "h" || b[0] === "v")) {
    const L = BOARD_LIMITS;
    const nums = b
      .slice(1, L.maxBends + 1)
      .filter(finite)
      .map((n) => clamp(Math.round(n), -L.maxCoord, L.maxCoord));
    out.bends = [b[0], ...nums];
  }
  if (isBoardInk(data.color)) out.color = data.color;
  return out;
}

type Box = Pick<BoardBlock, "x" | "y" | "w" | "h">;

/** Where the line from a box's centre toward (tx, ty) leaves the box, `gap` units outside it. */
function exitPoint(b: Box, tx: number, ty: number, gap: number): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : (b.w / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : (b.h / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

/**
 * The segment an arrow from block `a` to block `b` is drawn along: from where the line between
 * their centres leaves `a` to where it enters `b`, each `gap` units off the edge. Used by the
 * view and by both exports.
 */
export function arrowEndpoints(
  a: Box,
  b: Box,
  gap = 4,
): { x1: number; y1: number; x2: number; y2: number } {
  const [x1, y1] = exitPoint(a, b.x + b.w / 2, b.y + b.h / 2, gap);
  const [x2, y2] = exitPoint(b, a.x + a.w / 2, a.y + a.h / 2, gap);
  return { x1, y1, x2, y2 };
}

/** How far an arrow's label sits off its line: clear of the arrowhead (8 units each side). */
export const ARROW_LABEL_OFFSET = 14;

/**
 * Where an arrow's label goes: beside the middle of the segment, `ARROW_LABEL_OFFSET` units off
 * the line on its upper side (its left on a vertical one), anchored so the text grows away from
 * the line. `anchor` is the SVG text-anchor; the point is the text's vertical middle.
 */
export function arrowLabelAt(p: { x1: number; y1: number; x2: number; y2: number }): {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
} {
  const dx = p.x2 - p.x1;
  const dy = p.y2 - p.y1;
  const len = Math.hypot(dx, dy) || 1;
  // The unit normal on the upper side (or the left, for a vertical line).
  let nx = dy / len;
  let ny = -dx / len;
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  const mx = (p.x1 + p.x2) / 2;
  const my = (p.y1 + p.y2) / 2;
  // Mostly horizontal: centred above. Otherwise beside it, growing away from the line.
  const anchor = Math.abs(ny) >= 0.7 ? "middle" : nx < 0 ? "end" : "start";
  return {
    x: mx + nx * ARROW_LABEL_OFFSET,
    y: my + ny * ARROW_LABEL_OFFSET - (anchor === "middle" ? 6 : 0),
    anchor,
  };
}
