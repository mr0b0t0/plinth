// The whiteboard type's format (docs/spec.md "Whiteboards"). A board's blocks and arrows are
// shared data, two collections in the artifact's document store; a version holds only the board's
// settings, in board.json. Publishing a new board may carry a starting set of blocks and arrows,
// which the Worker writes into shared data once and never stores in the version.
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
export const BLOCK_KINDS = ["note", "text", "rect", "ellipse"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const BOARD_COLORS = ["yellow", "green", "blue", "pink", "purple", "gray"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];
export const BOARD_BACKGROUNDS = ["dots", "grid", "plain"] as const;
export type BoardBackground = (typeof BOARD_BACKGROUNDS)[number];
/** The lowest role that may change the board from its page. Viewers never may. */
export const BOARD_EDIT_MODES = ["commenters", "editors"] as const;
export type BoardEditMode = (typeof BOARD_EDIT_MODES)[number];
export const ARROW_STYLES = ["solid", "dashed"] as const;
export const ARROW_HEADS = ["end", "both", "none"] as const;

export const BOARD_LIMITS = {
  /** Bytes of board.json a publish or update may send (the stored settings are far smaller). */
  maxBoardBytes: LIMITS.maxBoardBytes,
  /** |x| and |y| of a block, in board units. */
  maxCoord: 1_000_000,
  minSize: 24,
  maxSize: 4000,
  maxText: 2000,
  maxLabel: 120,
  /** |z| of a block: draw order is z, then id. */
  maxZ: 1_000_000,
  /** Blocks and arrows in a starting board, together. */
  seedDocs: 500,
} as const;

/** A document id as shared data takes it (data.ts DATA_DOC_ID_RE). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Personal documents (data.ts PERSONAL_DOC_PREFIX): a board has none. */
const PERSONAL_PREFIX = "u_";

export interface BoardBlock {
  kind: BlockKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color?: BoardColor;
  z?: number;
}

export interface BoardArrow {
  from: string;
  to: string;
  label?: string;
  style?: (typeof ARROW_STYLES)[number];
  head?: (typeof ARROW_HEADS)[number];
}

export interface BoardSettings {
  v: typeof BOARD_FORMAT_VERSION;
  background: BoardBackground;
  edit: BoardEditMode;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  v: BOARD_FORMAT_VERSION,
  background: "dots",
  edit: "commenters",
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

const BLOCK_KEYS = ["kind", "x", "y", "w", "h", "text", "color", "z"] as const;
const ARROW_KEYS = ["from", "to", "label", "style", "head"] as const;

/** Why `data` is not a block: [path within the block, message], or null. */
function blockProblem(data: unknown): [string, string] | null {
  if (!isObject(data)) return ["", "a block is a JSON object"];
  const extra = unknownKey(data, BLOCK_KEYS);
  if (extra !== null) return [extra, `unknown key; a block has ${BLOCK_KEYS.join(", ")}`];
  const L = BOARD_LIMITS;
  if (!oneOf(BLOCK_KINDS, data.kind)) return ["kind", `one of ${BLOCK_KINDS.join(", ")}`];
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
  if (typeof data.text !== "string") return ["text", "a string (empty for none)"];
  if (length(data.text) > L.maxText) return ["text", `at most ${L.maxText} characters`];
  if (data.color !== undefined && !oneOf(BOARD_COLORS, data.color)) {
    return ["color", `one of ${BOARD_COLORS.join(", ")}`];
  }
  if (data.z !== undefined && !intWithin(data.z, -L.maxZ, L.maxZ)) {
    return ["z", `a whole number from ${-L.maxZ} to ${L.maxZ}`];
  }
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
    dictation: false,
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
  if (oneOf(BOARD_COLORS, data.color)) out.color = data.color;
  if (finite(data.z)) out.z = clamp(Math.round(data.z), -L.maxZ, L.maxZ);
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
