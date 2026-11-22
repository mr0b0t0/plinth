// On-page editing of a doc (#36), as formatted text (doc-blocks): nobody sees Markdown. The page
// shows the doc block by block (blocks.ts); in edit mode a click (or Enter) on a block asks for a
// lease on its lines, and once it is granted the block is drawn again as formatted text that can be
// edited in place (../common/richblock.ts), with a format bar at selected text (bold, italic,
// code, strikethrough, link) and the block menu at its corner (Turn into, Insert below, Move up
// and down, Delete). Typing
// sends the whole block, re-written as Markdown by @plinth/shared's serializer, at most every
// 250 ms; Esc or moving focus elsewhere in the page releases it. Blocks other people hold show a
// bronze rule with their email and their text as it arrives.
//
// Only blocks the model can show faithfully are edited this way: the fidelity check
// (editableBlock) runs before a lease, and a block that fails it (a construct the model lacks, say
// a list item holding a code fence) is shown read-only, with "Ask an agent" and the block menu
// (its Move and Delete move or remove its lines byte for byte). Untouched blocks keep their bytes:
// only the leased block's lines are ever replaced, and the reference definitions that follow a
// block stay as they are. Images are agent-only: an image block's menu has "Alt text", which opens
// a field at its corner, and its "Ask an agent" asks the app to open its Ask dialog about the
// image; "Insert below", "Image" asks for a new one.
//
// Two backends: the room's doc socket (../common/live.ts, "room" mode), or a local copy of the
// text that only this frame edits ("solo" mode, where the app saves it through its own session).
// The editor never parses HTML from anyone: everything it draws is made with createElement and
// textContent, and every rendered block (and atom) went through the unchanged sanitizer first.
//
// The serializer writes a `<` that would start any top-level block as `\<` (it renders as `<`),
// so a block a person wrote can always become the first one. Deleting or moving a block that would
// leave an agent's block starting like an HTML document first re-sends that block escaped too. The
// doc's live rules (liveTypes.ts) run on the edit before it is sent, as the room runs them; a
// refusal (here, or from the room when the lines changed first) puts the block back as the room
// has it and says why. A block cleared where its empty lines would run the blocks around it
// together is removed at once, in the same one edit as Delete, and stays open, empty, where it
// was. Images are drawn from the draft's base version's files (common/files.ts), which are the
// files a Publish keeps.
import {
  blockLines,
  editableBlock,
  escapeHtmlDocumentStarts,
  isEmptyBlock,
  joinLines,
  LIMITS,
  type LineRange,
  liveRules,
  type MdEnv,
  PAGE_COMMENT_LIMITS,
  type RichBlock,
  type RichInline,
  rangesOverlap,
  serializeBlock,
  splitLines,
  stripUnsafeText,
  verifyBlock,
} from "@plinth/shared";
import {
  type AskWhat,
  MAX_RESCUE_ITEM,
  MAX_RESCUE_ITEMS,
  MAX_RESCUE_TOTAL,
} from "../../components/viewer/rendererProtocol.ts";
import { pinFiles } from "../common/files.ts";
import {
  type ClientLease,
  type LeaseDenial,
  type LeaseLoss,
  type LiveBackend,
  locateBlock,
} from "../common/live.ts";
import {
  FORMAT_LOST,
  kindName,
  RichBlockEditor,
  type RichHost,
  type RichPoint,
  reveal,
  type SplitMore,
} from "../common/richblock.ts";
import { type AskImage, askKey } from "./askAnchor.ts";
import { type Block, BlockCache, parseBlocks, rangeOf, reconcile } from "./blocks.ts";
import {
  docEnv,
  docMarkdownTools,
  isSafeHref,
  markdown,
  normalizeHref,
  renderInlineMarkdown,
} from "./markdown.ts";
import { BlockMenu, type MenuGroup, type MenuItem, type TableForm } from "./menu.ts";
import { sanitizeHtml } from "./sanitize.ts";

export const EDIT_DEBOUNCE_MS = 250;
const STALE_RETRIES = 3;
const RULES = liveRules("doc");
const TOOLS = docMarkdownTools();

/** Why a block was not kept, in the doc's words. */
export const REFUSED_EDIT =
  "That change would make the doc start like a web page, which a doc can't publish, so it wasn't kept.";
/** Why a block opens read-only: the description of its "Ask an agent". */
export const READ_ONLY_NOTE = "This part can't be edited here. An agent can change it.";
/** The label of the button that asks an agent about a block (an image block: its image). */
export const ASK_AGENT = "Ask an agent";
/** The description of an image block's "Ask an agent". */
export const IMAGE_NOTE = "An agent adds or replaces the image.";
export const EMPTY_DOC = "Write something";
/**
 * Why a Move, Delete, Turn into or Insert below was not made: the blocks around it would have
 * become one (or taken in the new block).
 */
export const JOINED_BLOCKS =
  "That would run the blocks around it together into one, so nothing was changed.";
/** Why a block op was not made: the doc has no room for it. */
export const DOC_FULL = "The doc is at its size limit, so that change wasn't made.";
/** Turn into that would drop text, a table, a divider or an image (see turnDrops). */
export const TURN_DROPS = "That would drop part of this block, so it wasn't changed.";
/** Why an edit was not sent: the room is out of reach (or this frame has no lease). */
export const NOT_SENT = "Not connected. Try again in a moment.";
/** Why a block was not sent: it is over one frame. */
export const TOO_LONG = "This block is too long to send. Split it into smaller blocks.";
/** Why a block op was not made yet: the one before it is still waiting for its lease. */
const STILL_MAKING = "One moment: the last change is still being made.";
/** Why a block op was not made: the lines it needed changed after it was asked for. */
const CHANGED_MEANWHILE = "The doc changed meanwhile. Try again.";
/**
 * Why a cleared block was not removed (removeCleared): its lease or its edit was refused. The block
 * stays open with its last text, which is what the doc has.
 */
export const CLEAR_REFUSED = "Couldn't remove this block now. Try again.";
/**
 * Why what was typed in a block closed while it was being removed (removeCleared) did not reach
 * the doc: the place it was going to changed, or someone else holds it.
 */
/**
 * Typing the page cannot write as Markdown as it stands (a mark CommonMark cannot open or close
 * there): the text stays in the block, which stays open, and nothing is published until it changes.
 */
export const UNSAVABLE = "This text can't be saved as typed. Change it to continue.";
/** Edit mode ended with such a block open: its text was kept without its formatting. */
export const FORMAT_DROPPED = "Formatting in the block you were typing in couldn't be kept.";
/** Someone took over such a block: its text goes in below it, without its formatting. */
export const TAKEN_KEPT =
  "Someone else took over this block. What you typed is kept below it, without its formatting.";
/** The draft changed under such a block: its text is kept, without its formatting. */
export const CLOSED_KEPT = "The draft changed. What you typed is kept, without its formatting.";
/** Rescued text that could not be written anywhere yet: it stays kept, and can be copied. */
export const RESCUE_STUCK = "What you typed couldn't be added to the doc yet. It is kept here.";
/** The same, for text the app did not take into its store (over its limits): only this page has it. */
export const RESCUE_FRAME_ONLY =
  "What you typed couldn't be added to the doc yet. It's kept on this page until you reload. Copy it to be safe.";
/** What both rescue notices start with. */
const RESCUE_NOTICE = "What you typed couldn't be added to the doc yet.";
/** Dismiss on a rescue notice asks once: kept text dropped on purpose cannot be brought back. */
export const RESCUE_DISMISS =
  "What you typed couldn't be added to the doc yet. Dismiss drops it for good: copy it first to keep it.";
/** The rescued text waits for a review to end before it goes in. */
export const RESCUE_WAITS =
  "Editing is paused until the changes are reviewed. What you typed is kept and goes in after.";
/** How many places a rescued text is tried at before it waits for a reconnect or a reload. */
const RESCUE_TRIES = 3;

/**
 * Text typed in a doc block that is not in the draft yet, kept until the room has a write holding
 * it (the rescue store). The app keeps a copy in its own storage and offers it back after a reload.
 */
export interface RescueItem {
  id: string;
  /** The block's text as Markdown, without its marks. */
  text: string;
  /** The line it belongs at, as near as the draft allows. */
  near: number;
}

/**
 * A change to the rescue store, for the app's copy, which only ever merges: `upsert` adds or
 * updates items by id, `written` names items the room acknowledged, `gone` items dropped on
 * purpose (a discard). Nothing else takes an item out. `n` orders the reports, for the app's
 * answer saying which ids it keeps.
 */
export interface RescueReport {
  upsert: RescueItem[];
  written: string[];
  gone: string[];
  n: number;
}
export const NOT_KEPT = "What you typed in the block you closed couldn't be added. Type it again.";

/** What the editor needs of the live draft: the room's (LiveDocClient) or a local one. */
export type DocBackend = LiveBackend;

/** The text only this frame edits (solo mode): every lease is granted and applied at once. */
export class LocalDoc implements DocBackend {
  lines: string[];
  readonly ready = true;
  readonly connected = true;
  readonly settled = true;
  mine: ClientLease | null = null;
  readonly leases = new Map<string, ClientLease>();
  readonly you = { id: "local", email: "", right: "write" as const };
  readonly conflictVersion = null;
  ackedText: string | null = null;
  readonly durableText = null;
  private n = 0;

  constructor(
    readonly baseText: string,
    private readonly events: { granted(l: ClientLease): void; changed(): void },
  ) {
    this.lines = splitLines(baseText);
  }

  get text(): string {
    return joinLines(this.lines);
  }

  get dirty(): boolean {
    return this.text !== this.baseText;
  }

  lease(range: LineRange): boolean {
    const id = `local${++this.n}`;
    this.mine = { id, ...range, by: "", holder: "local", at: Date.now() };
    this.ackedText = joinLines(this.lines.slice(range.start, range.end));
    this.events.granted(this.mine);
    return true;
  }

  edit(text: string): boolean {
    const l = this.mine;
    if (!l) return false;
    const ins = text === "" ? [] : text.split("\n");
    const next = [...this.lines.slice(0, l.start), ...ins, ...this.lines.slice(l.end)];
    if (new TextEncoder().encode(joinLines(next)).byteLength > LIMITS.maxDocBytes) return false;
    this.lines = next;
    this.mine = { ...l, end: l.start + ins.length, at: Date.now() };
    this.ackedText = text;
    this.events.changed();
    return true;
  }

  release(): void {
    this.mine = null;
    this.events.changed();
  }

  takeover(): boolean {
    return false;
  }
}

/**
 * A place on the page an agent is asked about (`ask`): a structural key, and the first words of
 * the block for the dialog's "Pointing at" chip (empty for a block with no text).
 */
export interface AskAnchor {
  key: string;
  text: string;
}

/** The editor's hooks into the frame: the save shortcut and status changes for the app. */
export interface EditorHooks {
  save(): void;
  status(): void;
  /** Esc at the top level of edit mode: the app moves focus to its strip. */
  leave?(): void;
  /** The version whose files the draft is drawn with (its base), or null for the page's own. */
  fileVersion?(): number | null;
  /**
   * Ask an agent about a place in the doc (the app's Ask dialog), with what kind of block it is
   * for the dialog's "Pointing at" chip.
   */
  ask?(anchor: AskAnchor, what: AskWhat): void;
  /** The published version's text the frame was served, which Ask anchors are named in. */
  published?(): string;
  /** The rescue store changed: the app merges this into its copy (see RescueReport). */
  rescue?(report: RescueReport): void;
  /** The words of an empty text's place to write in (EMPTY_DOC when not given). */
  empty?: string;
}

/** Elements whose text reads as separate words from the text next to them. */
const WORD_BREAKS = new Set([
  "BR",
  "P",
  "TD",
  "TH",
  "TR",
  "PRE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/**
 * The first words of a block as the person sees them, for the Ask dialog's "Pointing at" chip: spaces
 * between cells and lines, " · " between a list's items, every run of white space one space,
 * without the characters no label may hold (UNSAFE_TEXT_RE: control and format characters, emoji
 * joiners among them, which the server would refuse), at most the page anchor's length in UTF-16
 * code units (as the app and the server count it), never cutting a character in two.
 */
export function blockWords(nodes: Node[]): string {
  // Runs of text, cut at each list item's edges.
  const runs: string[] = [""];
  const add = (s: string) => {
    runs[runs.length - 1] += s;
  };
  const walk = (n: Node) => {
    if (n.nodeType === 3) add(n.nodeValue ?? "");
    else if (n.nodeType === 1) {
      // A heading's "#" link is not its text.
      if ((n as Element).classList.contains("plinth-doc__anchor")) return;
      const tag = (n as Element).tagName;
      const item = tag === "LI";
      const br = WORD_BREAKS.has(tag);
      if (item) runs.push("");
      else if (br) add(" ");
      for (const c of Array.from(n.childNodes)) walk(c);
      if (item) runs.push("");
      else if (br) add(" ");
    }
  };
  for (const n of nodes) walk(n);
  // White space (line breaks and tabs among it) reads as one space; what no label shows goes
  // (the BOM too, which JavaScript counts as white space).
  const words = (run: string) =>
    stripUnsafeText(run.replace(/[^\S\ufeff]+/g, " "))
      .replace(/ +/g, " ")
      .trim();
  const text = runs.map(words).filter(Boolean).join(" · ");
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > PAGE_COMMENT_LIMITS.maxText) break;
    out += ch;
  }
  return out.trimEnd();
}

/** What a drawn block is, in the Ask dialog's words ("Pointing at the list"), for one with no text. */
function whatOf(nodes: Node[]): AskWhat {
  const el = nodes.find((n): n is Element => n.nodeType === 1);
  if (!el) return "block";
  if (el.classList.contains("plinth-doc__table")) return "table";
  switch (el.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "UL":
    case "OL":
      return "list";
    case "BLOCKQUOTE":
      return "quote";
    case "PRE":
      return "code block";
    case "HR":
      return "divider";
    case "P":
      return el.querySelector("img") && !el.textContent?.trim() ? "image" : "paragraph";
    default:
      return "block";
  }
}

/** An open block's first words, as blockWords reads the drawn block (an image's alt for one). */
function modelWords(doc: Document, b: RichBlock): string {
  if (b.t === "image") return blockWords([doc.createTextNode(b.alt)]);
  // An atom reads as the page draws it: an image as nothing, a link as its label, an autolink as
  // its address.
  const atom = (md: string) =>
    md.startsWith("!")
      ? ""
      : md.startsWith("<")
        ? md.slice(1, -1)
        : (/^\[([^\]]*)\]/.exec(md)?.[1] ?? "");
  const words = (c: RichInline) =>
    c.map((s) => (s.k === "text" ? s.text : s.k === "atom" ? atom(s.md) : " ")).join("");
  const runs = runsOf(b).map(words);
  const text = b.t === "bullet" || b.t === "ordered" ? runs.join(" · ") : runs.join(" ");
  return blockWords([doc.createTextNode(text)]);
}

/** The same for a block's model (an open block). */
function whatOfModel(b: RichBlock): AskWhat {
  switch (b.t) {
    case "bullet":
    case "ordered":
      return "list";
    case "code":
    case "indented":
      return "code block";
    default:
      return b.t;
  }
}

/** What a granted op lease writes, from the lines it covers; null when it no longer applies. */
type OpBuild = (lines: readonly string[], lease: LineRange) => OpResult | null;

interface OpResult {
  text: string;
  /** The line the moved or new block starts at, to open or select it afterwards. */
  focus?: number;
  /** Open that block for editing once it is drawn (a table just inserted). */
  open?: boolean;
  /**
   * How many top-level blocks the doc has after the op. Anything else means blocks nobody touched
   * ran together (or came apart), and the op is refused.
   */
  blocks?: number;
}

interface Want extends LineRange {
  /** The block's text when asked for, to find it again if the lines moved meanwhile. */
  text: string;
  insert: boolean;
  /** Text to keep and send once granted (a block re-taken after a reconnect). */
  keep?: string;
  tries: number;
  /** The model a new block opens with. */
  initial?: RichBlock;
  /** A block op (move, delete, insert a divider or a table) instead of an edit. */
  op?: { build: OpBuild; plan: () => (LineRange & { text: string }) | null };
  /** Where the person clicked, to put the caret there. */
  at?: { x: number; y: number };
  /** Where the caret goes otherwise. */
  caret?: Caret;
  /** Select the block's text once open (a new doc's title, from `?edit`), not place a caret. */
  select?: true;
  /**
   * The op writes what was typed in a cleared block closed while it was being removed (keepTyped):
   * the frame reports unsent changes until it is made, and it is asked for again once the draft is
   * back after a reconnect.
   */
  kept?: true;
  /** The rescue store item this op writes (see Rescue). */
  rescue?: string;
}

interface Pad {
  before: boolean;
  after: boolean;
}

interface Rescue extends RescueItem {
  /**
   * Its last accepted send, until the room acknowledges it (then the item is dropped): the edit's
   * seq (null without acks, solo), its first line and text. `lost` when the socket closed before
   * the ack: once the draft is back, a match at that place means it landed, else it is written
   * again.
   */
  sent: { seq: number | null; start: number; text: string; lost: boolean } | null;
  /** Who writes it now: the open block (its own sends), a kept op, or nobody (flushRescues). */
  owner: "block" | "op" | null;
  /** Newer items have higher numbers (the size cap keeps the newest). */
  n: number;
  /** Written as a new block at the nearest free place, not in place of its block. */
  free: boolean;
  tries: number;
  /** Tried RESCUE_TRIES times: it waits for a reconnect or a reload, and can be copied. */
  parked: boolean;
  /** The report that last sent it to the app, and whether the app's store has it (null: unknown). */
  reported: number | null;
  kept: boolean | null;
}

/**
 * Where a block's menu acts: on its block in the doc, or, for an open block with no lines in the
 * doc yet (a new one not typed into, or one whose text was cleared and sent), on the block above
 * it (null at the top of the doc).
 */
type Place = { start: number } | { above: number | null };

/**
 * A cleared block being removed (removeCleared). "lease": the lease on its lines and the blocks
 * the removal writes again is asked for, in place of the block's own; "sent": the edit is sent;
 * "insert": the insert point the block stays open at is asked for. `drop` once the block was
 * closed meanwhile: the removal ends as a Delete does, and the lease is released where it lands,
 * after what was typed in the block meanwhile (`keep`) is written by itself (keepTyped).
 */
interface Clearing {
  phase: "lease" | "sent" | "insert";
  drop: boolean;
  /** "sent": the edit, its lease, and where the block stays open (from the lease's start). */
  text: string;
  lease: string;
  at: number;
  /** The block's own lease when it was cleared: its first line, its text and its padding. */
  from: number;
  own: string;
  pad: Pad;
  /** The lines kept around the block's core (Open.prefix and Open.suffix). */
  prefix: string[];
  suffix: string[];
  /** What was typed in the block before it was closed (its core, as Markdown), or null. */
  keep: string | null;
  /** The insert point the block stays open at, once the doc has the removal. */
  point: number | null;
}

/** The block being edited: its formatted-text editor and the lines kept around its core. */
interface Open {
  rich: RichBlockEditor;
  menu: BlockMenu;
  /** Lines of the lease before the block's own (the first block's reference definitions). */
  prefix: string[];
  /** Lines of the lease after it (reference definitions), kept byte for byte. */
  suffix: string[];
  env: MdEnv;
  /** The Enter (or paste) that made this block, which Undo in it takes back (undoSplit). */
  split?: Split;
}

type Caret = "start" | "end" | RichPoint;

/**
 * An Enter or a multi-paragraph paste that split a block: the blocks it left (their cores, in
 * order, from about line `near`) and the block as it was, which Undo writes back over them.
 */
interface Split {
  cores: string[];
  near: number;
  before: string;
  caret: RichPoint;
}

const isBlank = (s: string | undefined) => s === undefined || s.trim() === "";
const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** The field's text as the room stores it: an inserted block keeps a blank line on each side. */
export function padded(value: string, pad: Pad): string {
  if (value === "") return "";
  return `${pad.before ? "\n" : ""}${value}${pad.after ? "\n" : ""}`;
}

/** The inverse of padded() for the text of a held insert. */
export function unpadded(text: string, pad: Pad): string {
  let t = text;
  if (pad.before && t.startsWith("\n")) t = t.slice(1);
  if (pad.after && t.endsWith("\n")) t = t.slice(0, -1);
  return t;
}

/** A block's lines as the editor writes them: its kept lines around the serialized core. */
export function composeBlock(prefix: readonly string[], core: string, suffix: readonly string[]) {
  const out = [...prefix];
  const lines = core === "" ? [] : core.split("\n");
  if (lines.length > 0 && out.length > 0 && !isBlank(out.at(-1))) out.push("");
  out.push(...lines);
  if (lines.length > 0 && suffix.length > 0 && !isBlank(suffix[0])) out.push("");
  out.push(...suffix);
  return out.join("\n");
}

const para = (c: RichInline = []): RichBlock => ({ t: "paragraph", c });

/** The kinds "Turn into" and "Insert below" offer. */
export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "quote" | "code";

const KIND_LABELS: [BlockKind, string][] = [
  ["paragraph", "Paragraph"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["bullet", "Bulleted list"],
  ["ordered", "Numbered list"],
  ["quote", "Quote"],
  ["code", "Code block"],
];

function kindOf(b: RichBlock): BlockKind | null {
  if (b.t === "heading") return b.level <= 3 ? (`h${b.level}` as BlockKind) : null;
  if (b.t === "indented") return "code";
  if (b.t === "paragraph" || b.t === "bullet" || b.t === "ordered" || b.t === "quote") return b.t;
  if (b.t === "code") return "code";
  return null;
}

/** The text runs of a block, one per line or item, for turning it into another kind. */
function runsOf(b: RichBlock): RichInline[] {
  switch (b.t) {
    case "paragraph":
    case "heading":
      return [b.c];
    case "quote":
      return b.blocks.flatMap(runsOf);
    case "bullet":
    case "ordered":
      return b.items.flatMap((it) => it.blocks.flatMap(runsOf));
    case "code":
    case "indented":
      return b.text
        .replace(/\n$/, "")
        .split("\n")
        .map((t) => [{ k: "text" as const, text: t, m: {} }]);
    case "table":
      return [b.head, ...b.rows].map((r) =>
        r.flatMap((c, i) => (i > 0 ? [{ k: "text" as const, text: " ", m: {} }, ...c] : c)),
      );
    default:
      return [];
  }
}

const joinRuns = (runs: RichInline[], sep: string): RichInline =>
  runs.flatMap((r, i) => (i > 0 ? [{ k: "text" as const, text: sep, m: {} }, ...r] : r));

const plain = (c: RichInline) =>
  c.map((s) => (s.k === "text" ? s.text : s.k === "atom" ? s.md : "\n")).join("");

/** A list marker that does not run into the list next to it (two lists would join). */
function freeMarker<T extends string>(
  neighbours: (string | undefined)[],
  options: T[],
  re: RegExp,
) {
  const taken = new Set(neighbours.map((l) => (l ? re.exec(l)?.[1] : undefined)));
  return options.find((m) => !taken.has(m)) ?? (options[0] as T);
}

/** `b` turned into `kind`, keeping its text (and its marks, where the kind holds them). */
export function turnInto(b: RichBlock, kind: BlockKind, near: (string | undefined)[] = []) {
  const runs = runsOf(b);
  switch (kind) {
    case "paragraph":
      return para(joinRuns(runs, "\n"));
    case "h1":
    case "h2":
    case "h3":
      return {
        t: "heading",
        level: Number(kind[1]),
        setext: false,
        c: joinRuns(runs, " "),
      } satisfies RichBlock;
    case "bullet":
      return {
        t: "bullet",
        marker: freeMarker(near, ["-", "*", "+"], /^\s*([-*+])\s/),
        tight: true,
        items: (runs.length ? runs : [[]]).map((c) => ({ blocks: [para(c)] })),
      } satisfies RichBlock;
    case "ordered":
      return {
        t: "ordered",
        start: 1,
        delim: freeMarker(near, [".", ")"], /^\s*\d{1,9}([.)])\s/),
        tight: true,
        items: (runs.length ? runs : [[]]).map((c) => ({ blocks: [para(c)] })),
      } satisfies RichBlock;
    case "quote":
      return { t: "quote", blocks: [para(joinRuns(runs, "\n"))] } satisfies RichBlock;
    case "code":
      return {
        t: "code",
        fence: "```",
        info: b.t === "code" ? b.info : "",
        text: runs.length ? `${runs.map(plain).join("\n")}\n` : "",
      } satisfies RichBlock;
  }
}

/**
 * What Turn into must keep of a block: its text without white space, and what has no text as a
 * mark of its own (an image or other atom, a table, a divider). Formatting and white space may
 * change (a code block's indentation, a list's items as lines), and Undo puts them back.
 */
function keptText(b: RichBlock): string {
  const inline = (c: RichInline) =>
    c.map((s) => (s.k === "text" ? s.text : s.k === "atom" ? `\uFFFC${s.md}` : "")).join("");
  switch (b.t) {
    case "paragraph":
    case "heading":
      return inline(b.c);
    case "quote":
      return b.blocks.map(keptText).join("");
    case "bullet":
    case "ordered":
      return b.items.flatMap((it) => it.blocks.map(keptText)).join("");
    case "code":
    case "indented":
      return b.text;
    case "table":
      return `\uFFFCtable${[b.head, ...b.rows].flat().map(inline).join("")}`;
    case "divider":
      return "\uFFFCdivider";
    case "image":
      return `\uFFFCimage${b.alt}${b.rest}`;
  }
}

/** Whether turning `from` into `to` loses text, or a table, divider or image in it. */
export function turnDrops(from: RichBlock, to: RichBlock): boolean {
  const squeeze = (b: RichBlock) => keptText(b).replace(/\s+/g, "");
  return squeeze(from) !== squeeze(to);
}

/** Text standing in for what will be typed into an empty block, to check where it would go. */
const PROBE: RichInline = [{ k: "text", text: "x", m: {} }];

/**
 * Whether `block` (one block's lines) written over `range`, with a blank line where `pad` says,
 * leaves it one block of its own: true when no block around it joins it, or is taken into it (a
 * list goes on into an indented block below it, and a list next to one of its marker is one list).
 */
function staysOne(lines: readonly string[], range: LineRange, block: string, pad: Pad): boolean {
  const before = parseBlocks(joinLines(lines));
  const inside = before.filter(
    (b) => b.core.start >= range.start && b.core.end <= range.end,
  ).length;
  const after = [
    ...lines.slice(0, range.start),
    ...blockLines(padded(block, pad)),
    ...lines.slice(range.end),
  ];
  return parseBlocks(joinLines(after)).length === before.length - inside + 1;
}

/** An empty block of `kind`, for Insert below. */
function emptyOf(kind: BlockKind, near: (string | undefined)[]): RichBlock {
  return turnInto(para(), kind, near);
}

export class DocEditor {
  editing = false;
  private readonly cache: BlockCache;
  private open: Open | null = null;
  /** The range of the lease this editor held at the last render (to find its block again). */
  private held: LineRange | null = null;
  private pad: Pad = { before: false, after: false };
  private want: Want | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notice: HTMLElement | null = null;
  private readonly labels = new Map<string, HTMLElement>();
  private readonly labelLease = new WeakMap<Node, string>();
  private readonly tabbed = new WeakSet<Element>();
  private decorated = new Set<Element>();
  /**
   * A block that cannot be edited in place, selected: drawn in a panel like an open block's, with
   * a bar of what can be done with it on top.
   */
  private selected: {
    start: number;
    panel: HTMLElement;
    bar: HTMLElement;
    menu: BlockMenu;
  } | null = null;
  private placeholder: HTMLElement | null = null;
  /** The open or selected block whose floating bar was last placed (placeBar). */
  private barHost: HTMLElement | null = null;
  /** After an op: the line of the block to focus (and open, or select) once it is drawn. */
  private after: { line: number; open: boolean; insert?: RichBlock } | null = null;
  private afterCaret: Caret = "end";
  /** A split just sent, for the block it opens next (see Open.split). */
  private splitting: Split | null = null;
  /** What the person asked for while a block op waited for its lease, run once it is done. */
  private queued: (() => void) | null = null;
  /** A cleared block being removed (removeCleared), until the block is open where it was. */
  private clearing: Clearing | null = null;
  /** A lease request is on its way over the socket and has had no answer yet. */
  private asking = false;
  /**
   * The open block's text could not be written as Markdown at its last send (UNSAVABLE): it is not
   * in the doc, so it counts as pending, and the block does not close until the text changes.
   */
  private stuck = false;
  /** Why the open block is `stuck`: UNSAVABLE, or the reason its last send was refused. */
  private stuckWhy = UNSAVABLE;
  /** While `stuck` in a room: says the lease is in use every LIMITS.liveLeaseKeepS (`keep`). */
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** Text typed that is not in the draft yet, by id, until the room's lines hold it. */
  private readonly rescues = new Map<string, Rescue>();
  /** The rescue item of the open block (made when it was `stuck`), until the block closes. */
  private blockRescue: string | null = null;
  /** Rescue reports sent to the app so far. */
  private reportN = 0;
  private rescueN = 0;
  /** A rescue write was refused because a review waits: none is tried until the review ends. */
  private rescueFrozen: { seen: boolean } | null = null;
  /**
   * The last block send in a room, until the room acknowledges it: its seq, its lease, what it
   * wrote as the block's own Markdown (`core`, at line `near`), and whether its block is still
   * open. A refusal that arrives once the block has closed keeps that text, parked (roomRefused).
   * Closed is the editor's own record: the room's `released` comes only after the answer to the
   * send, so the lease is still `mine` when a refusal of it arrives.
   */
  private lastSend: {
    seq: number;
    lease: string;
    core: string;
    near: number;
    open: boolean;
  } | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly win: Window,
    private backend: DocBackend,
    private readonly hooks: EditorHooks,
    prepare?: (fragment: DocumentFragment) => void,
  ) {
    this.cache = new BlockCache(win.document, prepare);
  }

  get doc(): Document {
    return this.win.document;
  }

  /** A block op (move, delete, insert) has asked for its lease and not had it yet. */
  private get opPending(): boolean {
    return this.want?.op !== undefined;
  }

  /**
   * A block's text is waiting in the debounce, a cleared block's removal is on its way, or what was
   * typed in one closed meanwhile is.
   */
  get pending(): boolean {
    return (
      this.timer !== null ||
      this.clearing !== null ||
      this.want?.kept === true ||
      this.stuck ||
      this.rescues.size > 0
    );
  }

  /** The open block holds text that cannot be written as typed (see `stuck`). */
  get unsavable(): boolean {
    return this.stuck;
  }

  /**
   * Typing in the open block cannot be written as typed, or can again. While it cannot, nothing
   * is sent, so a room would see the lease as idle and let it be taken over after
   * LIMITS.liveLeaseIdleS: a connected holder says it is in use instead, until the text can be
   * written, the block closes or the socket goes.
   */
  private setStuck(on: boolean): void {
    if (!on) this.stuckWhy = UNSAVABLE;
    if (this.stuck === on) return;
    this.stuck = on;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (!on || !this.backend.keep) return;
    this.keepAlive = setInterval(() => {
      const b = this.backend;
      if (!this.stuck || !this.open) {
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.keepAlive = null;
        return;
      }
      if (b.connected && b.mine) b.keep?.();
    }, LIMITS.liveLeaseKeepS * 1000);
  }

  /**
   * Solo: the doc's text with what is typed in the open block, without its marks, while it cannot
   * be written as typed (the app's kept copy), else null.
   */
  textWithTyping(): string | null {
    const open = this.open;
    const mine = this.backend.mine;
    if (!this.stuck || !open || !mine) return null;
    const core = verifyBlock(withoutMarks(open.rich.model), TOOLS, open.env);
    if (core === null) return null;
    const text = core === "" ? "" : padded(composeBlock(open.prefix, core, open.suffix), this.pad);
    const lines = this.backend.lines;
    return joinLines([
      ...lines.slice(0, mine.start),
      ...blockLines(text),
      ...lines.slice(mine.end),
    ]);
  }

  /** A block op or a cleared block's removal is on its way: other ops and opens wait for it. */
  private get busy(): boolean {
    return this.opPending || this.clearing !== null;
  }

  setBackend(b: DocBackend): void {
    this.backend = b;
    // A new backend (the room failed, editing goes on alone): what was sent to the room is not in
    // this one's text, so every kept item is written here.
    for (const r of this.rescues.values()) {
      r.sent = null;
      if (r.owner === "op") r.owner = null;
    }
    if (this.want?.rescue) this.want = null;
    this.lastSend = null;
    if (this.rescues.size > 0) queueMicrotask(() => this.flushRescues());
  }

  private get canWrite(): boolean {
    return this.backend.you?.right === "write" && this.backend.conflictVersion === null;
  }

  // ---------- rendering ----------

  render(): void {
    const b = this.backend;
    if (!b.ready) return;
    const blocks = parseBlocks(joinLines(b.lines));
    const openEl = this.open?.rich.el ?? null;
    // While a block is being re-taken (after a reconnect or a merge), or a cleared block's lease
    // goes from its lines to the place it stays open at (removeCleared), it stays where it was,
    // keeping the text and the focus.
    const pinned =
      openEl && (this.want?.keep !== undefined || this.clearing !== null) ? this.held : null;
    const mine = this.editing && openEl ? (pinned ?? b.mine) : null;
    if (b.mine && mine === b.mine) this.held = { start: mine.start, end: mine.end };
    const others = this.editing ? [...b.leases.values()].filter((l) => l.id !== b.mine?.id) : [];
    const desired: Node[] = [];
    let placed = false;
    const labelled = new Set<string>();
    const nextDecorated = new Set<Element>();
    const placeOpen = () => {
      if (mine && openEl && !placed) {
        desired.push(openEl);
        placed = true;
      }
    };
    const label = (l: ClientLease) => {
      if (labelled.has(l.id)) return;
      labelled.add(l.id);
      let el = this.labels.get(l.id);
      if (!el) {
        el = this.doc.createElement("div");
        el.className = "plinth-doc__holder";
        this.labels.set(l.id, el);
      }
      el.textContent = `${l.by} is editing`;
      this.labelLease.set(el, l.id);
      desired.push(el);
    };
    let selectedSeen = false;
    for (const block of blocks) {
      if (mine && overlaps(block, mine)) {
        placeOpen();
        continue;
      }
      if (mine && !placed && block.start >= mine.end) placeOpen();
      for (const l of others) {
        if (!overlaps(block, l) && !labelled.has(l.id) && l.end <= block.start) label(l);
      }
      const holder = others.find((l) => overlaps(block, l));
      if (holder) label(holder);
      const selected = this.editing && this.selected?.start === block.start && !holder;
      const nodes = this.cache.nodes(block);
      for (const n of nodes) {
        if (n.nodeType === 1) {
          const el = n as Element;
          this.decorate(el, holder !== undefined);
          if (this.editing || holder) nextDecorated.add(el);
        }
      }
      if (selected && this.selected) {
        // Its panel holds the bar and the block's own nodes, as an open block's holds its toolbar
        // and text.
        reconcile(this.selected.panel, [this.selected.bar, ...nodes]);
        desired.push(this.selected.panel);
        selectedSeen = true;
      } else desired.push(...nodes);
    }
    placeOpen();
    for (const l of others) label(l);
    if (this.editing && blocks.length === 0 && !mine && this.canWrite) {
      // An empty doc: one empty paragraph to start writing in.
      this.placeholder ??= this.makePlaceholder();
      desired.push(this.placeholder);
    }
    if (!selectedSeen && this.selected) {
      this.selected.menu.close(false);
      this.selected = null;
    }
    this.cache.commit();
    for (const el of this.decorated) if (!nextDecorated.has(el)) this.undecorate(el);
    this.decorated = nextDecorated;
    for (const id of [...this.labels.keys()]) if (!labelled.has(id)) this.labels.delete(id);
    reconcile(this.root, desired);
    this.root.classList.toggle("plinth-doc--editing", this.editing);
    // In edit mode the draft is drawn with its base's files, which are the ones a Publish keeps;
    // view mode keeps the page's own addresses, as before.
    pinFiles(this.root, this.editing ? (this.hooks.fileVersion?.() ?? null) : null);
    this.placeBar();
    this.focusAfter(blocks);
    const q = this.queued;
    if (q && !this.busy && !this.backend.mine && !this.after) {
      this.queued = null;
      q();
    }
    this.tryFirst();
  }

  // ---------- `?edit`: the first block, open for typing ----------

  /** The app started editing from `?edit` (New and Import): open the first block once drawn. */
  private wantFirst = false;

  focusFirst(): void {
    this.wantFirst = true;
    this.tryFirst();
  }

  /**
   * Once the draft is here: open the doc's first block (a new doc's title) so the person types
   * into it, with a heading's text selected so the first keystroke replaces "Untitled document".
   * When that block is someone else's, or this person cannot write now, the block only takes the
   * focus, and nothing is asked of the room. A first block that cannot be edited in place is
   * selected, as a click would. An empty doc opens a new paragraph.
   */
  private tryFirst(): void {
    const b = this.backend;
    if (!this.wantFirst || !this.editing || !b.ready) return;
    this.wantFirst = false;
    const first = this.blocks()[0];
    if (!first) {
      if (this.canWrite) this.openInsert(0, para());
      return;
    }
    if (!this.canWrite || this.heldBy(first)) {
      const el = Array.from(this.root.children).find((n) => rangeOf(n)?.start === first.start);
      (el as HTMLElement | undefined)?.focus();
      return;
    }
    this.open_(first, "end", undefined, this.modelOf(first)?.model.t === "heading");
  }

  /**
   * The open or selected block's corner (its menu, and Ask an agent where it has one) floats on
   * the block's top edge, so opening it moves nothing and covers next to nothing. When the block
   * opens too near the top of the frame for the corner to be seen there, it sits on the bottom
   * edge instead. Once the caret is placed, the block and its corner are scrolled into view.
   * Placed once per block, not while typing.
   */
  private placeBar(): void {
    const host = this.open?.rich.el ?? this.selected?.panel ?? null;
    if (host === this.barHost) return;
    this.barHost = host;
    if (!host?.isConnected) return;
    const bar = host.querySelector<HTMLElement>(":scope > .plinth-rich__corner");
    const room = host.getBoundingClientRect().top;
    host.classList.toggle("plinth-rich--below", room < (bar?.offsetHeight ?? 0) / 2 + 16);
    queueMicrotask(() => {
      if (this.barHost !== host || !host.isConnected || !bar) return;
      reveal(this.win, [bar.getBoundingClientRect(), host.getBoundingClientRect()]);
    });
  }

  private makePlaceholder(): HTMLElement {
    const p = this.doc.createElement("p");
    p.className = "plinth-doc__placeholder";
    p.tabIndex = 0;
    p.setAttribute("role", "button");
    p.textContent = this.hooks.empty ?? EMPTY_DOC;
    return p;
  }

  /** After an op: focus the block it moved or made, and open or select it. */
  private focusAfter(blocks: Block[]): void {
    const a = this.after;
    if (!a || this.backend.mine) return;
    this.after = null;
    if (a.insert) {
      this.openInsert(Math.min(a.line, this.backend.lines.length), a.insert);
      return;
    }
    const block =
      blocks.find((b) => b.start <= a.line && a.line < Math.max(b.end, b.start + 1)) ??
      blocks.at(-1);
    if (!block) return;
    for (const n of Array.from(this.root.childNodes)) {
      const r = rangeOf(n);
      if (r && r.start === block.start && n.nodeType === 1) {
        (n as HTMLElement).focus({ preventScroll: true });
        break;
      }
    }
    const caret = this.afterCaret;
    this.afterCaret = "end";
    if (a.open) this.open_(block, caret);
  }

  private decorate(el: Element, held: boolean): void {
    el.classList.toggle("plinth-doc__held", held);
    if (this.editing && !el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "0");
      this.tabbed.add(el);
    } else if (!this.editing) this.untab(el);
    if (el.getAttribute("class") === "") el.removeAttribute("class");
  }

  private undecorate(el: Element): void {
    el.classList.remove("plinth-doc__held");
    if (el.getAttribute("class") === "") el.removeAttribute("class");
    this.untab(el);
  }

  private untab(el: Element): void {
    if (this.tabbed.has(el)) {
      el.removeAttribute("tabindex");
      this.tabbed.delete(el);
    }
  }

  // ---------- edit mode ----------

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (!on) {
      this.salvage();
      this.close(true, false, true);
      this.deselect();
    }
    this.editing = on;
    if (on) {
      this.root.addEventListener("click", this.onClick);
      this.root.addEventListener("keydown", this.onKey);
      this.root.addEventListener("focusout", this.onFocusOut);
      this.win.addEventListener("keydown", this.onSaveKey);
    } else {
      this.root.removeEventListener("click", this.onClick);
      this.root.removeEventListener("keydown", this.onKey);
      this.root.removeEventListener("focusout", this.onFocusOut);
      this.win.removeEventListener("keydown", this.onSaveKey);
      this.hideNotice();
      this.wantFirst = false;
    }
    this.render();
    this.hooks.status();
  }

  private readonly onSaveKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.flush();
      // Typing that cannot be written yet is not in the draft: no Publish goes out without it.
      if (this.stuck) {
        this.showNotice(this.stuckWhy);
        return;
      }
      this.hooks.save();
    }
  };

  private topLevel(target: EventTarget | null): Node | null {
    let n = target as Node | null;
    while (n && n.parentNode !== this.root) n = n.parentNode;
    return n;
  }

  private readonly onClick = (e: MouseEvent) => {
    const top = this.topLevel(e.target);
    if (!top || top === this.open?.rich.el) return;
    if (top === this.selected?.panel) {
      // A link in the selected block is not followed either; the bar's buttons work as usual.
      if (!this.selected.bar.contains(e.target as Node)) e.preventDefault();
      return;
    }
    if (top === this.placeholder) {
      e.preventDefault();
      return this.openInsert(0, para());
    }
    const leaseId = this.labelLease.get(top);
    if (leaseId) {
      e.preventDefault();
      const l = this.backend.leases.get(leaseId);
      if (l) this.explainHeld(l);
      return;
    }
    const range = rangeOf(top);
    if (!range) return;
    // A link in a block opens the block for editing, not the link.
    e.preventDefault();
    this.openRange(range, { x: e.clientX, y: e.clientY });
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (this.open?.rich.el.contains(e.target as Node)) return;
    if (this.selected?.panel.contains(e.target as Node)) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        this.deselect(true);
      }
      return;
    }
    if (e.key === "Escape" && !e.defaultPrevented) {
      this.hooks.leave?.();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const top = this.topLevel(e.target);
    if (!top || top !== e.target) return;
    if (top === this.placeholder) {
      e.preventDefault();
      return this.openInsert(0, para());
    }
    if (e.key !== "Enter") return;
    const range = rangeOf(top);
    if (!range) return;
    e.preventDefault();
    this.openRange(range);
  };

  private readonly onFocusOut = (e: FocusEvent) => {
    const open = this.open;
    if (!open?.rich.el.contains(e.target as Node)) return;
    // Leaving the frame (the app's bar, another window) keeps the block; moving to another place
    // in the page ends it.
    setTimeout(() => {
      if (this.open !== open) return;
      const active = this.doc.activeElement;
      if (active && open.rich.el.contains(active)) return;
      if (!this.doc.hasFocus()) return;
      if (this.want?.keep !== undefined) return;
      if (!this.close(true)) open.rich.focus("end");
    }, 0);
  };

  private heldBy(range: LineRange): ClientLease | undefined {
    const b = this.backend;
    for (const l of b.leases.values()) {
      if (l.id !== b.mine?.id && rangesOverlap(l, range)) return l;
    }
    return undefined;
  }

  private blocks(): Block[] {
    return parseBlocks(joinLines(this.backend.lines));
  }

  private blockAt(start: number): { block: Block; index: number; blocks: Block[] } | null {
    const blocks = this.blocks();
    const index = blocks.findIndex((b) => b.start === start);
    if (index < 0) return null;
    return { block: blocks[index] as Block, index, blocks };
  }

  /** Where the open block's menu acts (see Place); `start` is the line it was opened at. */
  private openPlace(start: number): Place {
    // While a cleared block is being removed its lease is not the block's: where it is shown is.
    const range = this.clearing ? this.held : (this.backend.mine ?? this.held);
    if (!range) return this.blockAt(start) ? { start } : { above: null };
    const blocks = this.blocks();
    const own = blocks.find(
      (b) => b.core.end > b.core.start && b.core.start >= range.start && b.core.end <= range.end,
    );
    if (own) return { start: own.start };
    return { above: blocks.filter((b) => b.end <= range.start).at(-1)?.start ?? null };
  }

  /** The block's model, if it can be edited in place (the fidelity check), with the doc's env. */
  private modelOf(block: Block): { model: RichBlock; env: MdEnv } | null {
    const lines = this.backend.lines;
    const env = docEnv(joinLines(lines));
    const core = joinLines(lines.slice(block.core.start, block.core.end));
    const model = editableBlock(core, TOOLS, env);
    return model ? { model, env } : null;
  }

  /** Open a block for editing, or select it when it cannot be edited in place. */
  private openRange(range: LineRange, at?: { x: number; y: number }): void {
    const found = this.blockAt(range.start);
    if (!found) return;
    this.open_(found.block, "end", at);
  }

  private open_(block: Block, caret: Caret, at?: { x: number; y: number }, select = false): void {
    const b = this.backend;
    if (!this.editing || !b.ready) return;
    const text = joinLines(b.lines.slice(block.start, block.end));
    const near = block.start;
    if (this.busy) {
      // A block op is waiting for its lease, or a cleared block is being removed (which this
      // closes): open this block once that is done, found again by its text (the op may move it,
      // or give a list another marker).
      if (!this.close(true)) return;
      this.queued = () => {
        const blocks = this.blocks();
        const i = this.findBlock(blocks, text, near, true);
        if (i >= 0) this.open_(blocks[i] as Block, caret);
      };
      return;
    }
    if (b.you?.right !== "write") {
      this.showNotice("Sign in to edit this doc.");
      return;
    }
    if (b.conflictVersion !== null) {
      this.showNotice("Editing is paused until the changes are reviewed.");
      return;
    }
    const other = this.heldBy(block);
    if (other) {
      this.explainHeld(other);
      return;
    }
    if (b.mine && b.mine.start === block.start && b.mine.end === block.end && this.open) {
      this.open.rich.focus("end");
      return;
    }
    if (!this.close(true)) return;
    // close() may have sent the open block's typing, which moves the lines (solo): find the block
    // again.
    const blocks = this.blocks();
    const again = blocks[this.findBlock(blocks, text, near)];
    if (!again) return;
    if (!this.modelOf(again)) {
      this.select(again);
      return;
    }
    this.deselect();
    this.want = {
      start: again.start,
      end: again.end,
      text,
      insert: false,
      tries: 0,
      caret,
      ...(at ? { at } : {}),
      ...(select ? { select: true as const } : {}),
    };
    if (!this.request(again)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  /** Open a new block of `initial` at line `at` (an insert-point lease). */
  private openInsert(where: number, initial: RichBlock): void {
    const b = this.backend;
    if (!this.canWrite) return;
    const point = this.pointAt(where);
    if (this.busy) {
      if (!this.close(true)) return;
      this.queued = () => this.openInsert(point(), initial);
      return;
    }
    if (!this.close(true)) return;
    this.deselect();
    // close() may have sent the open block's typing, which moves the lines (solo).
    const at = point();
    const range = { start: at, end: at };
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other);
      return;
    }
    this.pad = { before: at > 0 && !isBlank(b.lines[at - 1]), after: !isBlank(b.lines[at]) };
    this.want = { ...range, text: "", insert: true, tries: 0, initial };
    if (!this.request(range)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  /**
   * Line `at`, found again once the lines change: right after the block above it (by its text),
   * or the top of the doc.
   */
  private pointAt(at: number): () => number {
    const lines = this.backend.lines;
    const was = joinLines(lines);
    const above = this.blocks()
      .filter((x) => x.end <= at)
      .at(-1);
    const text = above ? joinLines(lines.slice(above.start, above.end)) : "";
    return () => {
      const now = this.backend.lines;
      if (joinLines(now) === was) return at;
      if (!above) return 0;
      const blocks = this.blocks();
      const found = blocks[this.findBlock(blocks, text, above.start, true)];
      return found ? found.end : Math.min(at, now.length);
    };
  }

  private explainHeld(l: ClientLease): void {
    const idle = Date.now() - l.at >= LIMITS.liveLeaseIdleS * 1000;
    this.showNotice(
      `${l.by} is editing this.`,
      idle && this.backend.you?.right === "write"
        ? {
            label: "Take over",
            run: () => {
              if (this.busy) {
                this.showNotice(STILL_MAKING);
                return;
              }
              if (!this.close(true)) return;
              this.want = { start: l.start, end: l.end, text: "", insert: false, tries: 0 };
              if (this.backend.takeover(l.id)) {
                this.asking = true;
                this.hideNotice();
              }
            },
          }
        : undefined,
    );
  }

  // ---------- a block that cannot be edited in place ----------

  private select(block: Block): void {
    this.deselect();
    const index = this.blockAt(block.start)?.index ?? 0;
    const panel = this.doc.createElement("div");
    panel.className = "plinth-doc__selected";
    // An open block's corner, with what can be done with this one.
    const bar = this.doc.createElement("div");
    bar.className = "plinth-rich__corner plinth-doc__blockbar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `Block ${index + 1}`);
    const ask = this.doc.createElement("button");
    ask.type = "button";
    ask.className = "plinth-rich__btn plinth-doc__ask";
    ask.textContent = ASK_AGENT;
    ask.title = READ_ONLY_NOTE;
    ask.setAttribute("aria-description", READ_ONLY_NOTE);
    ask.addEventListener("click", (e) => {
      e.preventDefault();
      this.ask(block.start, null);
    });
    const menu = new BlockMenu(this.doc, () =>
      this.menuGroups({ start: block.start }, null, this.tableForm(block.start)),
    );
    bar.append(ask, menu.button);
    this.selected = { start: block.start, panel, bar, menu };
    this.render();
    ask.focus({ preventScroll: true });
  }

  private deselect(refocus = false): void {
    const s = this.selected;
    if (!s) return;
    s.menu.close(false);
    this.selected = null;
    this.render();
    if (refocus) {
      for (const n of Array.from(this.root.childNodes)) {
        if (rangeOf(n)?.start === s.start && n.nodeType === 1) {
          (n as HTMLElement).focus();
          break;
        }
      }
    }
  }

  // ---------- the block menu ----------

  private menuGroups(
    place: Place,
    model: RichBlock | null,
    table: TableForm,
    alt?: () => void,
  ): MenuGroup[] {
    // A new block with nothing in the doc yet acts as the block above it would: what it inserts
    // below lands where it is, and it cannot move. Delete gives it up.
    const start = "start" in place ? place.start : place.above;
    const found = "start" in place ? this.blockAt(place.start) : null;
    const index = found?.index ?? -1;
    const count = found?.blocks.length ?? 0;
    const own = model ? kindOf(model) : null;
    const insert: MenuItem[] = [
      ...KIND_LABELS.map(([k, label]) => ({ label, run: () => this.insertBelow(start, k) })),
      { label: "Divider", run: () => this.insertDivider(start) },
      { label: "Table", table },
    ];
    // An image block's own "Ask an agent" already asks about an image there.
    if (model?.t !== "image") {
      insert.push({
        label: "Image",
        disabled: start === null,
        run: () => {
          if (start !== null) this.ask(start, "add");
        },
      });
    }
    const make: MenuItem[] = [];
    // An image's alt text opens as a field at its corner, as a link's address does at its text.
    if (model?.t === "image" && alt) make.push({ label: "Alt text", run: alt });
    if (model && own !== null) {
      make.push({
        label: "Turn into",
        sub: KIND_LABELS.map(([k, label]) => ({
          label,
          checked: k === own,
          run: () => this.turn(k),
        })),
      });
    }
    make.push({ label: "Insert below", sub: insert });
    const groups: MenuGroup[] = [{ items: make }];
    groups.push({
      items: [
        {
          label: "Move up",
          disabled: index <= 0,
          run: () => found && this.move(found.block.start, -1),
        },
        {
          label: "Move down",
          disabled: index < 0 || index >= count - 1,
          run: () => found && this.move(found.block.start, 1),
        },
        {
          label: "Delete",
          // A new block with no lines yet is given up, typing and all: the person asked for that.
          run: () => (found ? this.remove(found.block.start) : this.close(true, true, true)),
        },
      ],
    });
    return groups;
  }

  private tableForm(start: number | null): TableForm {
    return { insert: (rows: number, cols: number) => this.insertTable(start, rows, cols) };
  }

  /**
   * Ask an agent about block `start` (its image, or a new image below it, with `image`): the app
   * opens its Ask dialog. The key names the block as the published version has it (askKey), so the
   * agent finds it in the version it reads; a block only in the draft is named after the published
   * block above it, with its draft words.
   */
  private ask(start: number, image: AskImage): void {
    const found = this.blockAt(start);
    const index = found?.index ?? 0;
    const sel = this.selected;
    const place = this.open ? this.openPlace(start) : null;
    const open = place && "start" in place && place.start === start ? this.open?.rich.model : null;
    const nodes =
      sel?.start === start
        ? Array.from(sel.panel.childNodes).filter((n) => n !== sel.bar)
        : open
          ? null
          : this.drawnBlock(start);
    const what: AskWhat =
      image === "replace" ? "image" : nodes ? whatOf(nodes) : open ? whatOfModel(open) : "block";
    // The block's first words, as the person sees them (an image's alt text): its number would
    // mean nothing to the person asking.
    const text =
      open?.t === "image"
        ? blockWords([this.doc.createTextNode(open.alt)])
        : open
          ? modelWords(this.doc, open)
          : nodes
            ? blockWords(nodes)
            : "";
    if (!this.close(true)) return;
    this.deselect();
    const draft = joinLines(this.backend.lines);
    const { key } = askKey(draft, this.hooks.published?.() ?? draft, index, image);
    this.hooks.ask?.({ key, text }, what);
  }

  /** The drawn nodes of block `start` in the page (none for an open or a missing block). */
  private drawnBlock(start: number): Node[] | null {
    for (const n of Array.from(this.root.childNodes)) {
      if (n.nodeType === 1 && rangeOf(n)?.start === start) return [n];
    }
    return null;
  }

  private turn(kind: BlockKind): void {
    const open = this.open;
    const mine = this.backend.mine;
    if (!open || !mine) return;
    if (this.busy) {
      this.showNotice(STILL_MAKING);
      return;
    }
    const near = this.neighbours(mine);
    const next = turnInto(open.rich.model, kind, near);
    if (turnDrops(open.rich.model, next)) {
      this.showNotice(TURN_DROPS);
      return;
    }
    if (verifyBlock(next, TOOLS, open.env) === null) {
      this.showNotice(FORMAT_LOST);
      return;
    }
    // An empty block is sent once typed into, so it is checked as it will be then.
    const probe = isEmptyBlock(next) ? turnInto(para(PROBE), kind, near) : next;
    const core = verifyBlock(probe, TOOLS, open.env);
    if (
      core === null ||
      !staysOne(this.backend.lines, mine, composeBlock(open.prefix, core, open.suffix), this.pad)
    ) {
      // The block stays open as it was.
      this.showNotice(JOINED_BLOCKS);
      return;
    }
    // Undo in the block puts it back as it was (a code block's indentation, say).
    open.rich.setModel(next, null, true);
    open.rich.focus("end");
    this.cancelTimer();
    this.send();
    this.hooks.status();
  }

  /** The first lines of the blocks around a range (to keep a new list from joining theirs). */
  private neighbours(range: LineRange): (string | undefined)[] {
    const lines = this.backend.lines;
    const blocks = this.blocks();
    const before = blocks.filter((b) => b.end <= range.start).at(-1);
    const after = blocks.find((b) => b.start >= range.end && b.end > b.start);
    return [
      before ? lines[before.core.start] : undefined,
      after ? lines[after.core.start] : undefined,
    ];
  }

  /** A new block of `kind` below block `start`, or at the top of the doc for null. */
  private insertBelow(start: number | null, kind: BlockKind): void {
    if (this.busy) {
      this.showNotice(STILL_MAKING);
      return;
    }
    const found = start === null ? null : this.blockAt(start);
    if (start !== null && !found) return;
    const lines = this.backend.lines;
    const next = found ? found.blocks[found.index + 1] : this.blocks()[0];
    const near = [
      found ? lines[found.block.core.start] : undefined,
      next ? lines[next.core.start] : undefined,
    ];
    if (!this.close(true)) return;
    // close() may have changed the lines (solo): find the block again.
    const at = start === null ? 0 : (this.blockAt(start) ?? found)?.block.end;
    if (at === undefined) return;
    // The new block is sent once typed into, so it is checked as it will be then.
    const now = this.backend.lines;
    const pad = { before: at > 0 && !isBlank(now[at - 1]), after: !isBlank(now[at]) };
    const probe = serializeBlock(turnInto(para(PROBE), kind, near));
    if (!staysOne(now, { start: at, end: at }, probe, pad)) {
      this.deselect();
      this.showNotice(JOINED_BLOCKS);
      return;
    }
    this.openInsert(at, emptyOf(kind, near));
  }

  /** Runs `plan` (the range and its text, found again on every try) as a one-edit lease. */
  private runOp(plan: () => (LineRange & { text: string }) | null, build: OpBuild): void {
    if (!this.canWrite) return;
    if (this.busy) {
      this.showNotice(STILL_MAKING);
      return;
    }
    if (!this.close(true)) return;
    this.deselect();
    const p = plan();
    if (!p) return;
    const other = this.heldBy(p);
    if (other) {
      this.showNotice(`${other.by} is editing next to this block. Try again when they finish.`);
      return;
    }
    this.pad = { before: false, after: false };
    this.want = {
      start: p.start,
      end: p.end,
      text: p.text,
      insert: false,
      tries: 0,
      op: { build, plan },
    };
    if (!this.request(p)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  /** The doc with a range replaced, checked by the doc's rules; escaped once if that fixes it. */
  private fits(range: LineRange, text: string): string | null {
    const lines = this.backend.lines;
    const ok = (t: string) =>
      !RULES?.checkEdit(lines, range.start, range.end - range.start, blockLines(t));
    if (ok(text)) return text;
    const escaped = escapeHtmlDocumentStarts(text).text;
    return ok(escaped) ? escaped : null;
  }

  private move(start: number, dir: -1 | 1): void {
    const target = this.blockText(start);
    const plan = () => {
      const lines = this.backend.lines;
      const blocks = this.blocks();
      const i = this.findBlock(blocks, target, start);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= blocks.length) return null;
      const a = blocks[Math.min(i, j)] as Block;
      const b = blocks[Math.max(i, j)] as Block;
      const end = filledEnd(lines, b);
      return { start: a.start, end, text: joinLines(lines.slice(a.start, end)) };
    };
    this.runOp(plan, (lines, lease) => {
      const blocks = parseBlocks(joinLines(lines));
      const i = blocks.findIndex((x) => x.start === lease.start);
      const j = blocks.findIndex((x) => filledEnd(lines, x) === lease.end);
      const first = blocks[i];
      const second = blocks[j];
      if (!first || !second || i >= j) return null;
      // Each block moves with its own lines, blank lines after it left where they are.
      const own = (x: Block | undefined) => x && lines.slice(x.start, filledEnd(lines, x));
      let a = lines.slice(first.start, filledEnd(lines, first));
      const between = lines.slice(filledEnd(lines, first), second.start);
      let b = lines.slice(second.start, lease.end);
      // A moved list that would join the list next to it is written with another marker.
      b = apart(b, [own(blocks[i - 1]), a]) ?? b;
      a = apart(a, [b, own(blocks[j + 1])]) ?? a;
      const gap = between.length > 0 ? between : [""];
      const { text, lead } = separated(lines, lease, [...b, ...gap, ...a].join("\n"));
      const moved = first.start + lead + (dir < 0 ? 0 : b.length + gap.length);
      return { text, focus: moved, blocks: blocks.length };
    });
  }

  private remove(start: number): void {
    const { plan, build } = this.removal(start);
    this.runOp(plan, build);
  }

  /**
   * Delete of block `start`: the lines it covers (with the block after it when that one must be
   * written again: escaped, apart from the block before, or with a free list marker) and what they
   * become, in one edit. Delete and a cleared block (removeCleared) both make it.
   */
  private removal(start: number): {
    plan: () => (LineRange & { text: string }) | null;
    build: OpBuild;
  } {
    const target = this.blockText(start);
    const plan = () => {
      const lines = this.backend.lines;
      const blocks = this.blocks();
      const i = this.findBlock(blocks, target, start);
      if (i < 0) return null;
      const cur = blocks[i] as Block;
      const next = blocks[i + 1];
      const prev = blocks[i - 1];
      const s = next || !prev ? cur.start : prev.end;
      let e = next ? next.start : cur.end;
      const kept = removedText(lines, cur, { start: s, end: e }, next);
      // The next block is written again in the same edit when deleting this one would leave it
      // first, starting like a web page (escaped); right against the block before, with no blank
      // line left between them (one is added); or next to a list of its own marker (it takes
      // another).
      const own = (x: Block) => lines.slice(x.start, filledEnd(lines, x));
      if (
        next &&
        (RULES?.checkEdit(lines, s, e - s, blockLines(kept)) ||
          (prev &&
            ((kept === "" && !isBlank(lines[s - 1]) && !isBlank(lines[e])) ||
              listsJoin(own(prev), own(next)))))
      ) {
        e = next.end;
      }
      return { start: s, end: e, text: joinLines(lines.slice(s, e)) };
    };
    const build: OpBuild = (lines, lease) => {
      const blocks = parseBlocks(joinLines(lines));
      const i = blocks.findIndex((x) => x.core.start >= lease.start && x.core.end <= lease.end);
      const cur = blocks[i];
      if (!cur) return null;
      const k = blocks.findIndex((x) => x.start >= cur.end && x.end > x.start);
      const next = blocks[k];
      const withNext = next !== undefined && next.end === lease.end && next.start < lease.end;
      const own = (x: Block | undefined) => x && lines.slice(x.start, filledEnd(lines, x));
      let text: string;
      if (withNext) {
        const nextLines = lines.slice(next.start, next.end);
        const kept = apart(nextLines, [own(blocks[i - 1]), own(blocks[k + 1])]) ?? nextLines;
        text = composeBlock(defsOf(lines, cur), joinLines(kept), []);
      } else {
        text = removedText(
          lines,
          cur,
          lease,
          blocks.find((x) => x.start === lease.end),
        );
      }
      const out = separated(lines, lease, text);
      return { text: out.text, focus: lease.start + out.lead, blocks: blocks.length - 1 };
    };
    return { plan, build };
  }

  private insertDivider(start: number | null): void {
    this.insertAfter(start, () => ({ text: "---" }));
  }

  private insertTable(start: number | null, rows: number, cols: number): void {
    const cells = () => Array.from({ length: cols }, () => [] as RichInline);
    const table: RichBlock = {
      t: "table",
      align: Array.from({ length: cols }, () => null),
      head: Array.from({ length: cols }, (_, i) => [
        { k: "text" as const, text: `Column ${i + 1}`, m: {} },
      ]),
      rows: Array.from({ length: rows }, cells),
    };
    this.insertAfter(start, () => ({ text: serializeBlock(table), open: true }));
  }

  /** A new block from `make` right below block `start` (at the top for null), in one edit. */
  private insertAfter(start: number | null, make: () => { text: string; open?: boolean }): void {
    const target = start === null ? "" : this.blockText(start);
    const plan = () => {
      if (start === null) return { start: 0, end: 0, text: "" };
      const blocks = this.blocks();
      const i = this.findBlock(blocks, target, start);
      if (i < 0) return null;
      const at = (blocks[i] as Block).end;
      return { start: at, end: at, text: "" };
    };
    this.runOp(plan, (lines, lease) => {
      const made = make();
      const pad = {
        before: lease.start > 0 && !isBlank(lines[lease.start - 1]),
        after: !isBlank(lines[lease.start]),
      };
      return {
        text: padded(made.text, pad),
        focus: lease.start + (pad.before ? 1 : 0),
        blocks: parseBlocks(joinLines(lines)).length + 1,
        ...(made.open ? { open: true } : {}),
      };
    });
  }

  private blockText(start: number): string {
    const found = this.blockAt(start);
    if (!found) return "";
    return joinLines(this.backend.lines.slice(found.block.start, found.block.end));
  }

  /**
   * The block whose lines are `text`, nearest to line `near`. With `anyMarker`, a list whose
   * markers alone changed (a removal or Move gave it a free one) is found too, when no block's
   * lines are `text` as they are.
   */
  private findBlock(blocks: Block[], text: string, near: number, anyMarker = false): number {
    const lines = this.backend.lines;
    const nearest = (same: (t: string) => boolean) => {
      let best = -1;
      blocks.forEach((b, i) => {
        if (!same(joinLines(lines.slice(b.start, b.end)))) return;
        if (best < 0 || Math.abs(b.start - near) < Math.abs((blocks[best] as Block).start - near)) {
          best = i;
        }
      });
      return best;
    };
    const exact = nearest((t) => t === text);
    if (exact >= 0 || !anyMarker) return exact;
    const plainText = withoutMarkers(text);
    return nearest((t) => withoutMarkers(t) === plainText);
  }

  // ---------- lease events (from the backend) ----------

  /** Ask the room for `range`; false when it cannot be sent (not connected). */
  private request(range: LineRange): boolean {
    const sent = this.backend.lease(range);
    if (sent) this.asking = true;
    return sent;
  }

  granted(lease: ClientLease): void {
    this.asking = false;
    const w = this.want;
    this.want = null;
    const c = this.clearing;
    const placed = c?.phase === "insert" && !w?.op;
    if (c && placed) {
      // The place a cleared block stays open at, once its removal is in (removeCleared).
      this.clearing = null;
      if (c.drop || !this.open || !this.editing) {
        if (c.keep !== null) {
          this.keepTyped(c, c.keep);
          return;
        }
        this.backend.release();
        this.render();
        this.hooks.status();
        return;
      }
    }
    // A block op asked for in edit mode is made even when edit mode ended meanwhile (a cleared
    // block's removal as edit mode ends).
    if (!this.editing && !w?.op) {
      this.backend.release();
      return;
    }
    if (w?.op) {
      this.runGranted(w, lease);
      return;
    }
    const lines = this.backend.lines;
    const server = joinLines(lines.slice(lease.start, lease.end));
    if (!w?.insert && w?.keep === undefined) {
      this.pad = {
        before: lease.start > 0 && !isBlank(lines[lease.start - 1]),
        after: lease.end < lines.length && !isBlank(lines[lease.end]),
      };
    }
    // The block's own lines inside the lease, and the kept lines around them.
    let prefix: string[] = [];
    let suffix: string[] = [];
    let model: RichBlock | null = w?.initial ?? null;
    const env = docEnv(joinLines(lines));
    if (lease.end > lease.start) {
      const inner = unpadded(server, this.pad);
      const offset = server.startsWith("\n") && this.pad.before ? 1 : 0;
      const block = parseBlocks(joinLines(lines)).find(
        (b) => b.core.start >= lease.start + offset && b.core.end <= lease.end,
      );
      if (block) {
        prefix = lines.slice(lease.start + offset, block.core.start);
        const tailEnd = lease.end - (this.pad.after && inner !== server ? 1 : 0);
        suffix = lines.slice(block.core.end, Math.max(block.core.end, tailEnd));
        if (w?.keep === undefined || !this.open) {
          model = editableBlock(
            joinLines(lines.slice(block.core.start, block.core.end)),
            TOOLS,
            env,
          );
        }
      }
    }
    const keep = w?.keep !== undefined && this.open ? this.open : null;
    if (!keep && !model) {
      // The block changed meanwhile into one that cannot be edited in place.
      this.backend.release();
      const block = this.blockAt(lease.start)?.block;
      if (block) this.select(block);
      return;
    }
    const open = keep ?? this.makeOpen(lease.start, model as RichBlock, env);
    // The block an Enter just opened: Undo in it takes the Enter back.
    const split = this.splitting;
    this.splitting = null;
    if (!keep && split) open.split = split;
    open.prefix = prefix;
    open.suffix = suffix;
    open.env = env;
    this.open = open;
    this.held = { start: lease.start, end: lease.end };
    this.hideNotice();
    this.render();
    if (!keep) {
      if (w?.at && this.caretFromPoint(w.at)) {
        // The caret is where the person clicked.
      } else if (w?.select) open.rich.selectText();
      else open.rich.focus(w?.caret ?? (w?.insert ? "start" : "end"));
    }
    // What was typed in a cleared block while it was removed is sent now; an empty one has nothing.
    if (keep && !(placed && isEmptyBlock(open.rich.model))) this.schedule(0);
    else if (w?.insert && !isEmptyBlock(open.rich.model)) this.schedule(0);
    this.hooks.status();
  }

  private caretFromPoint(at: { x: number; y: number }): boolean {
    const doc = this.doc as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const el = this.open?.rich.editable;
    if (!el) return false;
    let node: Node | null = null;
    let offset = 0;
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(at.x, at.y);
      node = p?.offsetNode ?? null;
      offset = p?.offset ?? 0;
    } else if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(at.x, at.y);
      node = r?.startContainer ?? null;
      offset = r?.startOffset ?? 0;
    }
    if (!node || !el.contains(node)) return false;
    const editable = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(
      '[contenteditable="true"]',
    ) as HTMLElement | null;
    if (!editable) return false;
    editable.focus({ preventScroll: true });
    const sel = doc.getSelection();
    if (!sel) return false;
    const range = doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  private makeOpen(start: number, model: RichBlock, env: MdEnv): Open {
    const index = this.blockAt(start)?.index;
    const n = index === undefined ? null : index + 1;
    const label = `${n === null ? "New block" : `Block ${n}`}, ${kindName(model)}`;
    const holder: { open: Open | null } = { open: null };
    const menu = new BlockMenu(this.doc, () =>
      this.menuGroups(
        this.openPlace(start),
        holder.open?.rich.model ?? model,
        {
          insert: (rows, cols) => {
            const place = this.openPlace(start);
            this.insertTable("start" in place ? place.start : place.above, rows, cols);
          },
        },
        () => holder.open?.rich.editAlt(),
      ),
    );
    const extra: HTMLElement[] = [];
    if (model.t === "image") {
      const ask = this.doc.createElement("button");
      ask.type = "button";
      ask.className = "plinth-rich__btn plinth-doc__ask";
      ask.textContent = ASK_AGENT;
      ask.title = IMAGE_NOTE;
      ask.setAttribute("aria-description", IMAGE_NOTE);
      ask.addEventListener("mousedown", (e) => e.preventDefault());
      ask.addEventListener("click", (e) => {
        e.preventDefault();
        const place = this.openPlace(start);
        const at = "start" in place ? place.start : place.above;
        if (at !== null) this.ask(at, "replace");
      });
      extra.push(ask);
    }
    extra.push(menu.button);
    const host: RichHost = {
      atom: (md) => {
        const frag = sanitizeHtml(renderInlineMarkdown(md, holder.open?.env ?? env), this.doc);
        pinFiles(frag, this.hooks.fileVersion?.() ?? null);
        return Array.from(frag.childNodes);
      },
      changed: () => this.edited(),
      split: (keep, next, more) => this.split(keep, next, more),
      undo: () => this.undoSplit(holder.open),
      tab: (back) => this.tabOut(back),
      escape: () => this.close(true, true),
      announce: (text) => (text ? this.showNotice(text) : this.hideNotice()),
      verify: (b) => verifyBlock(b, TOOLS, holder.open?.env ?? env),
      isSafeHref,
      normalizeHref,
    };
    const rich = new RichBlockEditor(this.doc, host, model, { label, extra });
    rich.el.classList.add("plinth-doc__open");
    const open: Open = { rich, menu, prefix: [], suffix: [], env };
    holder.open = open;
    return open;
  }

  private runGranted(w: Want, lease: ClientLease): void {
    const op = w.op;
    if (!op) return;
    const lines = this.backend.lines;
    const text = joinLines(lines.slice(lease.start, lease.end));
    const result = text === w.text ? op.build(lines, lease) : null;
    const checked = result ? this.checkOp(lease, result) : { refusal: CHANGED_MEANWHILE };
    const refusal =
      "refusal" in checked
        ? checked.refusal
        : checked.text !== text && !this.backend.edit(checked.text)
          ? NOT_SENT
          : null;
    const c = this.clearing;
    if (c) {
      if (refusal !== null || !result || "refusal" in checked) {
        // Checked before the lease was asked for, so the doc changed meanwhile. The lease now
        // covers the blocks around the cleared one too, so the block closes with its last text;
        // what was typed in it meanwhile goes in its place (keepTyped), or, while it is open, the
        // block is taken again with its text, as after a reconnect.
        this.clearing = null;
        const typed = c.drop ? c.keep : this.typedCore();
        if (typed !== null && !c.drop && this.open && this.editing) {
          this.backend.release();
          this.retakeTyped(c);
          this.render();
          this.hooks.status();
          return;
        }
        if (typed !== null) {
          this.dropOpen();
          this.keepTyped(c, typed);
          return;
        }
        this.backend.release();
        this.dropOpen();
        this.held = null;
        this.showNotice(CLEAR_REFUSED);
        this.render();
        this.hooks.status();
        return;
      }
      c.phase = "sent";
      c.text = checked.text;
      c.at = (result.focus ?? lease.start) - lease.start;
      c.lease = lease.id;
      this.clearedSent();
      return;
    }
    this.backend.release();
    if (w.rescue && (refusal !== null || !result || "refusal" in checked)) {
      // Never dropped: tried elsewhere, or later, or kept (rescueFailed).
      this.rescueFailed(
        w.rescue,
        refusal === NOT_SENT ? "offline" : refusal === CHANGED_MEANWHILE ? "moved" : "refused",
      );
      return;
    }
    if (refusal !== null || !result) {
      // Nothing changed, so nothing is opened or selected for it.
      this.showNotice(w.kept ? NOT_KEPT : (refusal ?? CHANGED_MEANWHILE));
      this.render();
      this.hooks.status();
      return;
    }
    if (w.rescue && "text" in checked) {
      const r = this.rescues.get(w.rescue);
      if (r) r.owner = null;
      // Already the room's text (nothing was sent), or sent and waiting for its ack.
      const wrote = checked.text !== text;
      this.rescueSent(
        w.rescue,
        wrote ? (this.backend.lastSeq ?? null) : null,
        lease.start,
        checked.text,
      );
      if (!wrote) this.dropRescue(w.rescue);
    }
    if (result.focus !== undefined) this.after = { line: result.focus, open: !!result.open };
    this.render();
    this.hooks.status();
  }

  /** What an op's result writes over `range`, or why the doc cannot take it. */
  private checkOp(range: LineRange, result: OpResult): { text: string } | { refusal: string } {
    const fitted = this.fits(range, result.text);
    if (fitted === null) return { refusal: REFUSED_EDIT };
    const lines = this.backend.lines;
    const after = [
      ...lines.slice(0, range.start),
      ...blockLines(fitted),
      ...lines.slice(range.end),
    ];
    if (result.blocks !== undefined && parseBlocks(joinLines(after)).length !== result.blocks) {
      return { refusal: JOINED_BLOCKS };
    }
    if (this.tooLarge(joinLines(after))) return { refusal: DOC_FULL };
    // An op's edit is one frame of the room too (solo sends none).
    if (this.backend.keep && this.overFrame(fitted)) return { refusal: TOO_LONG };
    return { text: fitted };
  }

  denied(reason: LeaseDenial, by?: string): void {
    this.asking = false;
    const w = this.want;
    this.want = null;
    if (reason === "stale" && w && w.tries < STALE_RETRIES) {
      this.retake(w);
      // A cleared block's removal that no longer applies ends as a refused one does.
      if (this.clearing && !this.want) this.clearFailed();
      return;
    }
    const c = this.clearing;
    if (c && c.phase !== "insert") {
      this.clearFailed();
      return;
    }
    if (c) {
      // The removal is in, but not the place the block stays open at: what is typed in it stays
      // on the page to copy, as after a reconnect (below); an empty one closes. What was typed in
      // one closed meanwhile is written by itself.
      this.clearing = null;
      if (c.drop && c.keep !== null) {
        this.keepTyped(c, c.keep);
        return;
      }
      this.backend.release();
      if (c.drop || !this.open || isEmptyBlock(this.open.rich.model)) {
        this.dropOpen();
        this.held = null;
        this.render();
        this.hooks.status();
        return;
      }
    }
    if (w?.rescue) {
      this.rescueFailed(
        w.rescue,
        reason === "frozen" ? "frozen" : reason === "watch" ? "refused" : "moved",
      );
      return;
    }
    if (w?.kept) {
      this.showNotice(NOT_KEPT);
      this.render();
      this.hooks.status();
      return;
    }
    if (w?.op) {
      this.showNotice(
        reason === "held"
          ? `${by ?? "Someone"} is editing next to this block. Try again when they finish.`
          : CHANGED_MEANWHILE,
      );
      this.render();
      return;
    }
    if (w?.keep !== undefined) {
      // The block stays where it was with its text, so nothing typed is lost; Escape closes it.
      this.want = { ...w, tries: STALE_RETRIES };
      this.showNotice("Your block could not be reopened. Copy its text, then press Escape.");
      return;
    }
    if (reason === "held") this.showNotice(`${by ?? "Someone"} is editing this.`);
    else if (reason === "frozen")
      this.showNotice("Editing is paused until the changes are reviewed.");
    else if (reason === "watch") this.showNotice("Sign in to edit this doc.");
  }

  /** Ask again for a block whose lines may have moved, found by its text. */
  private retake(w: Want): void {
    const b = this.backend;
    if (w.op) {
      const p = w.op.plan();
      if (!p) return;
      const next = { ...w, ...p, tries: w.tries + 1 };
      this.want = next;
      // Not connected: typing kept from a closed block is asked for again once the draft is back.
      if (!this.request(p)) this.want = w.kept ? { ...next, tries: 0 } : null;
      return;
    }
    const n = w.text === "" ? 0 : w.text.split("\n").length;
    const at = w.insert ? Math.min(w.start, b.lines.length) : locateBlock(b.lines, w.text, w.start);
    if (at < 0) {
      // Its text is gone from the draft (someone changed it): put it back as a new block.
      const near = Math.min(w.start, b.lines.length);
      const next = { ...w, start: near, end: near, insert: true, tries: w.tries + 1 };
      this.pad = {
        before: near > 0 && !isBlank(b.lines[near - 1]),
        after: !isBlank(b.lines[near]),
      };
      this.want = next;
      if (!this.request(next)) this.want = w.keep !== undefined ? { ...w, tries: 0 } : null;
      return;
    }
    const next = { ...w, start: at, end: w.insert ? at : at + n, tries: w.tries + 1 };
    this.want = next;
    // Not connected: a block with text to keep is tried again once the draft is back.
    if (!this.request(next)) this.want = w.keep !== undefined ? { ...w, tries: 0 } : null;
  }

  /**
   * The socket closed (the client reports a lease it still held as lost first). A lease asked for
   * over it gets no answer, so nothing may wait for one: what keeps typing (a block to take again,
   * a closed block's typing to write) is asked for again once the draft is back, a cleared block's
   * removal ends as a lost lease does, and a block op or a block to open is not made, which the
   * page says.
   */
  disconnected(): void {
    if (this.backend.connected) return;
    // Sends the room had not acknowledged may or may not have landed: checked at their own place
    // once the draft is back (checkRescues).
    for (const r of this.rescues.values()) {
      if (r.sent && !(r.sent.seq !== null && this.backend.acked?.(r.sent.seq))) r.sent.lost = true;
    }
    // No refusal of a frame sent over the closed socket can come any more.
    this.lastSend = null;
    if (this.clearing) this.lost("reconnect");
    if (!this.asking) return;
    this.asking = false;
    const w = this.want;
    if (!w) return;
    if (w.kept || w.keep !== undefined) {
      this.want = { ...w, tries: 0 };
      this.hooks.status();
      return;
    }
    this.want = null;
    this.queued = null;
    this.showNotice(NOT_SENT);
    this.render();
    this.hooks.status();
  }

  lost(reason: LeaseLoss): void {
    const open = this.open;
    const held = this.held;
    this.cancelTimer();
    const c = this.clearing;
    if (c) {
      // A cleared block's lease ended while it was being removed. What was typed in it meanwhile
      // is kept: after a reconnect or a merge an open block stays open with it and is taken again
      // (as below), and a closed one's typing is written once the draft is back (keepTyped).
      // Otherwise the block closes as the doc has it, and the page says so when the removal was
      // not made.
      this.clearing = null;
      this.want = null;
      const typed = c.drop ? c.keep : this.typedCore();
      const again = reason === "reconnect" || reason === "rebased";
      if (typed !== null && again && !c.drop && open && held && this.editing) {
        this.retakeTyped(c);
        this.hooks.status();
        return;
      }
      if (typed !== null && again) {
        this.dropOpen();
        this.keepTyped(c, typed);
        return;
      }
      this.dropOpen();
      this.held = null;
      this.render();
      if (typed !== null) {
        this.showNotice(
          reason === "takeover"
            ? "Someone else took over this block."
            : "Editing is paused: the draft changed. Your block was closed.",
        );
      } else if (c.phase === "lease") this.showNotice(CLEAR_REFUSED);
      this.hooks.status();
      return;
    }
    if (this.stuck && open && held && (reason === "takeover" || reason === "closed")) {
      // Typing that could not be written yet is never dropped with the block.
      if (this.keepPlain(reason === "takeover")) {
        this.held = null;
        this.showNotice(reason === "takeover" ? TAKEN_KEPT : CLOSED_KEPT);
        return;
      }
    }
    if (!open || !held || !this.editing) {
      this.dropOpen();
      this.render();
      return;
    }
    if (reason === "reconnect" || reason === "rebased") {
      // Keep the text and take the block again once the draft is back.
      const text = reason === "reconnect" ? this.backend.durableText : this.backend.ackedText;
      this.want = {
        start: held.start,
        end: held.end,
        text: text ?? "",
        insert: (text ?? "") === "",
        keep: this.currentText() ?? "",
        tries: 0,
      };
      return;
    }
    this.dropOpen();
    this.held = null;
    this.render();
    this.showNotice(
      reason === "takeover"
        ? "Someone else took over this block."
        : "Editing is paused: the draft changed. Your block was closed.",
    );
    this.hooks.status();
  }

  /** The backend's text or leases changed. */
  changed(): void {
    const w = this.want;
    const b = this.backend;
    if (
      w &&
      (w.keep !== undefined || (w.kept && b.conflictVersion === null)) &&
      !b.mine &&
      b.connected &&
      b.settled &&
      w.tries === 0
    ) {
      // A block to re-take after a reconnect or a merge, or a closed block's typing to write.
      this.want = null;
      this.retake(w);
    }
    this.clearedSent();
    if (this.lastSend && this.backend.acked?.(this.lastSend.seq)) this.lastSend = null;
    // The rescue store: what the room's lines hold now goes, a review that ended lets the rest in.
    this.roomStatus();
    this.checkRescues();
    queueMicrotask(() => this.flushRescues());
    // Lines changed around an emptied block not sent yet can make its empty lines join them: it
    // is removed now, as typing would have (edited()), never later inside a close.
    if (this.clearedJoins()) {
      this.cancelTimer();
      this.removeCleared();
    }
    this.render();
  }

  // ---------- the open block ----------

  private dropOpen(): void {
    this.setStuck(false);
    if (this.lastSend) this.lastSend.open = false;
    const br = this.blockRescue ? this.rescues.get(this.blockRescue) : undefined;
    if (br?.owner === "block") br.owner = null;
    this.blockRescue = null;
    const open = this.open;
    if (!open) return;
    open.menu.close(false);
    open.rich.destroy();
    this.open = null;
  }

  /**
   * Enter that ends the block: this one keeps `keep`, and `next` goes into a new block below it,
   * in one edit (or, for an empty `next`, an insert right after it once this lease is released).
   */
  private split(keep: RichBlock, next: RichBlock | null, more: SplitMore = {}): void {
    const open = this.open;
    const mine = this.backend.mine;
    if (!open || !mine || this.clearing) return;
    const keepCore = verifyBlock(keep, TOOLS, open.env);
    const nextCore = next ? verifyBlock(next, TOOLS, open.env) : "";
    const between = (more.between ?? []).map((b) => verifyBlock(b, TOOLS, open.env));
    if (keepCore === null || nextCore === null || between.some((c) => c === null)) {
      // Nothing is split, and the text stays as typed.
      this.showNotice(UNSAVABLE);
      return;
    }
    if (keepCore === "" && nextCore === "" && this.emptyJoins()) {
      // An Enter that leaves nothing where empty lines would run the blocks around it together
      // (the last empty item of a list): the block is removed as a cleared one is.
      open.rich.setModel(para());
      this.cancelTimer();
      this.removeCleared();
      return;
    }
    const middle = between.filter((c): c is string => c !== null && c !== "");
    // What Undo in the block this opens writes back: the block as it was before the Enter.
    const beforeCore = more.before ? verifyBlock(more.before.model, TOOLS, open.env) : null;
    const undo = (cores: string[]): Split | null =>
      beforeCore && more.before
        ? {
            cores: cores.filter((c) => c !== ""),
            near: mine.start,
            before: beforeCore,
            caret: more.before.from,
          }
        : null;
    // Typing not sent yet goes with the split (at the start, before the paragraph above opens).
    const pending = this.timer !== null;
    this.cancelTimer();
    if (keepCore === "" && nextCore !== "" && middle.length === 0) {
      // Enter at the very start: a new paragraph above, once this block's typing is in.
      if (pending && !this.send()) {
        this.schedule(EDIT_DEBOUNCE_MS);
        return;
      }
      if (!this.close(true)) return;
      this.splitting = undo([nextCore]);
      this.openInsert(mine.start + (this.pad.before ? 1 : 0), para());
      return;
    }
    const parts = [keepCore, ...middle, nextCore].filter((c) => c !== "");
    const core = parts.join("\n\n");
    const block = composeBlock(open.prefix, core, open.suffix);
    const text = padded(block, this.pad);
    const lines = this.backend.lines;
    if (RULES?.checkEdit(lines, mine.start, mine.end - mine.start, blockLines(text))) {
      this.refused(REFUSED_EDIT);
      return;
    }
    const keepAt =
      mine.start +
      (this.pad.before && text !== "" ? 1 : 0) +
      open.prefix.length +
      (open.prefix.length > 0 && !isBlank(open.prefix.at(-1)) ? 1 : 0);
    const end = mine.start + (text === "" ? 0 : text.split("\n").length) - (this.pad.after ? 1 : 0);
    if (joinLines(lines.slice(mine.start, mine.end)) !== text) {
      const refusal =
        this.unsendable(lines, mine, text) ?? (this.backend.edit(text) ? null : NOT_SENT);
      if (refusal) {
        // Nothing changed: the block stays open with what was typed, still to be sent.
        this.showNotice(refusal);
        if (pending) this.schedule(EDIT_DEBOUNCE_MS);
        return;
      }
      // The block closes now: a refusal the room sends later keeps what this wrote (roomRefused).
      this.noteSent(mine, core);
    }
    this.backend.release();
    this.dropOpen();
    this.held = null;
    // The last block starts after the ones before it, each with a blank line after it.
    let nextAt = keepAt;
    for (const c of parts.slice(0, -1)) nextAt += c.split("\n").length + 1;
    this.after =
      nextCore === ""
        ? { line: Math.max(mine.start, end), open: false, insert: next ?? para() }
        : { line: nextAt, open: true };
    if (nextCore !== "") {
      this.afterCaret = more.caret !== undefined ? { leaf: 0, offset: more.caret } : "start";
    }
    this.splitting = undo(parts);
    this.render();
    this.hooks.status();
  }

  /**
   * Undo in a block an Enter (or a multi-paragraph paste) opened, with nothing left to undo in
   * it: the blocks the split left are written back as the one block it was, which opens with the
   * caret where the Enter was. Not once the block or the ones before it changed.
   */
  private undoSplit(open: Open | null): boolean {
    const split = open?.split;
    if (!split || open !== this.open || this.busy) return false;
    open.split = undefined;
    // The blocks the split wrote (the open one among them), or, when it opened an empty block not
    // typed into, the one block it left: that one is written back, and the empty one closes.
    const cores = split.cores;
    if (cores.length < 2 && !isEmptyBlock(open.rich.model)) return false;
    const find = (): { start: number; end: number } | null => {
      const lines = this.backend.lines;
      const blocks = this.blocks();
      const coreOf = (b: Block) => joinLines(lines.slice(b.core.start, b.core.end));
      let best: { start: number; end: number } | null = null;
      for (let i = 0; i + cores.length <= blocks.length; i++) {
        if (!cores.every((c, k) => coreOf(blocks[i + k] as Block) === c)) continue;
        const range = {
          start: (blocks[i] as Block).core.start,
          end: (blocks[i + cores.length - 1] as Block).core.end,
        };
        if (!best || Math.abs(range.start - split.near) < Math.abs(best.start - split.near)) {
          best = range;
        }
      }
      return best;
    };
    const plan = () => {
      const r = find();
      return r && { ...r, text: joinLines(this.backend.lines.slice(r.start, r.end)) };
    };
    if (!plan()) return false;
    this.afterCaret = split.caret;
    this.runOp(plan, (lines, lease) => ({
      text: split.before,
      focus: lease.start,
      open: true,
      blocks: parseBlocks(joinLines(lines)).length - (cores.length - 1),
    }));
    return true;
  }

  private tabOut(back: boolean): void {
    const from = this.held;
    const before = this.blocks();
    const next = from
      ? back
        ? before.filter((b) => b.end <= from.start).at(-1)
        : before.find((b) => b.start >= from.end && b.end > b.start)
      : undefined;
    const text = next ? joinLines(this.backend.lines.slice(next.start, next.end)) : "";
    // Focus stays on the block just closed (there may be no next one, and the next one opens
    // only once its lease arrives), never on the frame's body.
    if (!this.close(true, true)) return;
    if (!next) return;
    // close() may have changed the lines: find the next block again.
    const blocks = this.blocks();
    const again = blocks[this.findBlock(blocks, text, next.start)];
    if (again) this.open_(again, back ? "end" : "start");
  }

  /** The text the open block would be sent as now, or null when it cannot be. */
  private currentText(): string | null {
    const open = this.open;
    if (!open) return null;
    const core = verifyBlock(open.rich.model, TOOLS, open.env);
    if (core === null) return null;
    return composeBlock(open.prefix, core, open.suffix);
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, ms);
    this.hooks.status();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The open block's text changed: it is sent after the pause, and a cleared one removed now. */
  private edited(): void {
    if (this.clearedJoins()) {
      this.cancelTimer();
      this.removeCleared();
      return;
    }
    this.schedule(EDIT_DEBOUNCE_MS);
  }

  /** Sends the open block. False when it was not sent (refused, or not expressible). */
  private send(): boolean {
    const mine = this.backend.mine;
    // While a cleared block is being removed, its lease is not the block's: what is typed meanwhile
    // is sent once the block has its place again (granted()).
    if (!this.open || !mine || this.clearing) return false;
    if (this.clearedJoins()) {
      this.removeCleared();
      return true;
    }
    const block = this.currentText();
    // Never dropped: text that cannot be written as typed, or whose send is refused (the doc is
    // full, the block is over one frame, the socket did not take it), stays in the block, which
    // stays open and counts as pending and unsavable (close() refuses, nothing is published or
    // collected without it, leaving the page warns), and the person changes it or it is sent
    // again (flush, a reconnect). The keystroke is not undone. A room's copy goes to the rescue
    // store too, and a solo tab's kept copy has it (textWithTyping).
    const stick = (why: string): false => {
      this.setStuck(true);
      this.stuckWhy = why;
      this.noteStuck();
      this.showNotice(why);
      this.hooks.status();
      return false;
    };
    if (block === null) return stick(UNSAVABLE);
    if (this.stuck) {
      const why = this.stuckWhy;
      this.setStuck(false);
      if (this.notice?.textContent?.startsWith(why)) this.hideNotice();
      this.hooks.status();
    }
    const text = padded(block, this.pad);
    const lines = this.backend.lines;
    if (joinLines(lines.slice(mine.start, mine.end)) === text) {
      // The room holds this text already: the block's rescue copy has nothing left to keep.
      this.rescueSent(this.blockRescue, null, mine.start, text);
      return true;
    }
    // The room's rules, checked here first: a refusal is never silent.
    if (RULES?.checkEdit(lines, mine.start, mine.end - mine.start, blockLines(text))) {
      this.refused(REFUSED_EDIT);
      return false;
    }
    const refusal =
      this.unsendable(lines, mine, text) ?? (this.backend.edit(text) ? null : NOT_SENT);
    if (refusal) return stick(refusal);
    this.noteSent(mine, verifyBlock(this.open.rich.model, TOOLS, this.open.env) ?? "");
    // Every accepted send from a block with a rescue copy replaces what that copy waits for.
    this.rescueSent(this.blockRescue, this.backend.lastSeq ?? null, mine.start, text);
    return true;
  }

  /**
   * The open block is empty, and its lines written empty would run the blocks around it together
   * (two lists of one marker, or a list and the indented block below it).
   */
  private clearedJoins(): boolean {
    const open = this.open;
    if (!open || !isEmptyBlock(open.rich.model)) return false;
    return verifyBlock(open.rich.model, TOOLS, open.env) === "" && this.emptyJoins();
  }

  /** The open block's lines written empty would run the blocks around it together. */
  private emptyJoins(): boolean {
    const open = this.open;
    const mine = this.backend.mine;
    if (!open || !mine || this.clearing) return false;
    const text = padded(composeBlock(open.prefix, "", open.suffix), this.pad);
    return runsTogether(this.backend.lines, mine, text);
  }

  /**
   * The open block was emptied where its lines sent empty would run the blocks around it together.
   * One edit removes them at once, as Delete does (the list after it takes a free marker), under
   * one lease that takes the place of the block's own, so the doc never holds text the page no
   * longer shows. The block then stays open, empty, at the place it had (clearedSent). A removal
   * that cannot be made leaves the block open with its last text, which the doc has, and says why.
   */
  private removeCleared(): void {
    const b = this.backend;
    const mine = b.mine;
    if (!mine || this.clearing) return;
    const own = this.blocks().find(
      (x) => x.core.end > x.core.start && x.core.start >= mine.start && x.core.end <= mine.end,
    );
    if (!own) return;
    const { plan, build } = this.removal(own.start);
    const p = plan();
    const result = p ? build(b.lines, p) : null;
    const checked = p && result ? this.checkOp(p, result) : { refusal: CLEAR_REFUSED };
    if (!p || "refusal" in checked) {
      this.refused("refusal" in checked ? checked.refusal : CLEAR_REFUSED);
      return;
    }
    if (this.heldBy(p)) {
      this.refused(CLEAR_REFUSED);
      return;
    }
    const open = this.open;
    this.clearing = {
      phase: "lease",
      drop: false,
      text: "",
      lease: "",
      at: 0,
      from: mine.start,
      own: joinLines(b.lines.slice(mine.start, mine.end)),
      pad: { ...this.pad },
      prefix: open ? [...open.prefix] : [],
      suffix: open ? [...open.suffix] : [],
      keep: null,
      point: null,
    };
    this.want = {
      start: p.start,
      end: p.end,
      text: p.text,
      insert: false,
      tries: 0,
      op: { plan, build },
    };
    this.hooks.status();
    if (!this.request(p)) {
      this.want = null;
      this.clearing = null;
      this.refused(CLEAR_REFUSED);
    }
  }

  /**
   * A cleared block's removal, once the doc has it: the block stays open, empty, at the place it
   * had, under an insert-point lease that takes the place of the removal's. Closed meanwhile, the
   * removal ends as a Delete does.
   */
  private clearedSent(): void {
    const c = this.clearing;
    const b = this.backend;
    const m = b.mine;
    if (c?.phase !== "sent" || !m || m.id !== c.lease) return;
    // The room sends the edit back before the lines change here.
    const n = blockLines(c.text).length;
    if (m.end - m.start !== n || joinLines(b.lines.slice(m.start, m.end)) !== c.text) return;
    const at = m.start + c.at;
    c.point = at;
    if (c.drop || !this.open || !this.editing) {
      this.clearing = null;
      if (c.keep !== null) {
        this.keepTyped(c, c.keep);
        return;
      }
      b.release();
      if (this.editing) this.after = { line: at, open: false };
      this.render();
      this.hooks.status();
      return;
    }
    c.phase = "insert";
    this.held = { start: at, end: at };
    this.pad = { before: at > 0 && !isBlank(b.lines[at - 1]), after: !isBlank(b.lines[at]) };
    // One try spent, so a release seen before the grant does not ask again (changed()).
    this.want = { start: at, end: at, text: "", insert: true, keep: "", tries: 1 };
    if (!this.request(this.want)) {
      this.want = null;
      this.clearing = null;
      b.release();
      this.dropOpen();
      this.held = null;
      this.showNotice(NOT_SENT);
    }
    this.render();
    this.hooks.status();
  }

  /**
   * A cleared block's removal was refused, or no longer applies. Not granted, the block's own
   * lease is as it was: the block stays open with its last text, which the doc has, and the page
   * says so. Closed meanwhile, the lease is released and the block shows that text. What was typed
   * in it meanwhile is not empty, so it needs no removal: it is sent under that lease, as any
   * typing is.
   */
  private clearFailed(): void {
    const c = this.clearing;
    this.clearing = null;
    if (!c) return;
    if (!c.drop && this.open) {
      if (this.typedCore() !== null) this.schedule(0);
      else this.refused(CLEAR_REFUSED);
      this.render();
      return;
    }
    if (c.keep !== null) {
      this.keepTyped(c, c.keep);
      return;
    }
    if (this.backend.mine) this.backend.release();
    this.showNotice(CLEAR_REFUSED);
    this.render();
    this.hooks.status();
  }

  /**
   * What is typed in the open block, as Markdown: null when it is empty, or when it cannot be
   * written, which the page then says.
   */
  private typedCore(): string | null {
    const open = this.open;
    if (!open || isEmptyBlock(open.rich.model)) return null;
    const core = verifyBlock(open.rich.model, TOOLS, open.env);
    if (core === null) this.showNotice(UNSAVABLE);
    return core ? core : null;
  }

  /**
   * A cleared block typed into is still open, but its removal's lease is gone (refused once
   * granted, a reconnect, a merge): it stays where it was with its text and is taken again, as after
   * a reconnect. Until the removal is in, that is its own lines (or, when they are gone, a new block
   * near them); after, the place it stays open at.
   */
  private retakeTyped(c: Clearing): void {
    const keep = this.currentText() ?? "";
    this.want =
      c.point !== null
        ? { start: c.point, end: c.point, text: "", insert: true, keep, tries: 0 }
        : {
            start: c.from,
            end: c.from + blockLines(c.own).length,
            text: c.own,
            insert: false,
            keep,
            tries: 0,
          };
  }

  /**
   * What was typed in a cleared block that closed while its removal was on its way (or as its
   * lease ended), written by itself as a block op: in place of the block while the doc does not
   * have the removal, where the block was once it does. The lease held is used when it is the one
   * the op needs, and released otherwise. Until the op is made the frame reports unsent changes,
   * and after a reconnect it is asked for again once the draft is back. A refusal says so.
   */
  private keepTyped(c: Clearing, core: string, given?: string): void {
    const b = this.backend;
    // In a room the text is a rescue item while it is on its way, so a refusal of it (here or by
    // the room, which may have less room than this frame saw) keeps it, never only a notice.
    const rescue = given ?? this.keptItem(core, c.point ?? c.from);
    const block = composeBlock(c.prefix, core, c.suffix);
    const plan = () => {
      const lines = b.lines;
      if (c.point === null) {
        const at = locateBlock(lines, c.own, c.from);
        if (at >= 0) return { start: at, end: at + blockLines(c.own).length, text: c.own };
      }
      const near = Math.min(c.point ?? c.from, lines.length);
      const inside = parseBlocks(joinLines(lines)).find((x) => x.start < near && near < x.end);
      const at = inside ? inside.end : near;
      return { start: at, end: at, text: "" };
    };
    const build: OpBuild = (lines, lease) => {
      if (lease.end > lease.start) return { text: padded(block, c.pad) };
      const pad = {
        before: lease.start > 0 && !isBlank(lines[lease.start - 1]),
        after: !isBlank(lines[lease.start]),
      };
      return { text: padded(core, pad), blocks: parseBlocks(joinLines(lines)).length + 1 };
    };
    this.dropOpen();
    this.held = null;
    const p = plan();
    const w: Want = {
      ...p,
      insert: false,
      tries: 0,
      op: { plan, build },
      kept: true,
      ...(rescue ? { rescue } : {}),
    };
    const owned = rescue ? this.rescues.get(rescue) : undefined;
    if (owned) {
      owned.owner = "op";
      owned.sent = null;
    }
    const m = b.mine;
    if (m && m.start === p.start && m.end === p.end) {
      if (joinLines(b.lines.slice(m.start, m.end)) === p.text) {
        this.want = null;
        this.runGranted(w, m);
        return;
      }
    }
    if (m) b.release();
    this.want = w;
    if (b.connected && b.settled && b.conflictVersion === null) this.retake(w);
    this.render();
    this.hooks.status();
  }

  /**
   * Why `text` in place of the leased lines cannot be sent, checked first; null when it can: over
   * one frame (overFrame), or the doc after it past its size (tooLarge).
   */
  private unsendable(lines: readonly string[], mine: LineRange, text: string): string | null {
    if (this.overFrame(text)) return TOO_LONG;
    const after = [...lines.slice(0, mine.start), ...blockLines(text), ...lines.slice(mine.end)];
    if (this.tooLarge(joinLines(after))) return DOC_FULL;
    return null;
  }

  /**
   * `text` is over one frame of the room. A room's frame carries it as JSON, where quotes,
   * backslashes and line breaks take two bytes; solo, where nothing is sent, its bytes are counted.
   */
  private overFrame(text: string): boolean {
    const sent = this.backend.keep ? JSON.stringify(text) : text;
    return utf8Bytes(sent) > LIMITS.liveDocFrameBytes - 256;
  }

  /**
   * More than the doc may hold: LIMITS.maxDocBytes, and in a room also its line limit (the room's
   * own check, RULES.tooLarge), so a room never has to refuse a send for its size.
   */
  private tooLarge(doc: string): boolean {
    if (utf8Bytes(doc) > LIMITS.maxDocBytes) return true;
    return this.backend.keep !== undefined && (RULES?.tooLarge(doc) ?? false);
  }

  /**
   * A block send the room took into its socket (`lease`, writing `core`): kept until it is
   * acknowledged, for a refusal that comes once the block has closed. Rooms only.
   */
  private noteSent(lease: ClientLease, core: string): void {
    const b = this.backend;
    this.lastSend =
      b.acked && b.lastSeq !== undefined
        ? { seq: b.lastSeq, lease: lease.id, core, near: lease.start, open: true }
        : null;
  }

  /**
   * The room refused one of this socket's frames: `invalid` (its rules: the doc would start like a
   * web page) or `too_large` (its size check: bytes or lines). What was typed is never dropped:
   * - A send of a block that has closed since, or lost its lease, keeps what it wrote, parked in
   *   the rescue store (park).
   * - `too_large` for the open block's own send: the block stays open with its typing, `stuck`, as
   *   when this frame finds the doc full first.
   * - `invalid` for the open block: as refused().
   * - `not_held` (the lease went first, a takeover): the send was not applied, so a closed block's
   *   send is parked too. An open block (taken again after a merge) keeps its own typing.
   */
  roomRefused(code: "invalid" | "too_large" | "not_held"): void {
    const reason = code === "invalid" ? REFUSED_EDIT : code === "too_large" ? DOC_FULL : "";
    const open = this.open;
    const mine = this.backend.mine;
    // A rescue write the room refused after it was sent: tried again elsewhere, never dropped.
    const sent = [...this.rescues.values()]
      .filter((r) => r.sent?.seq != null && !this.backend.acked?.(r.sent.seq))
      .sort((a, b) => (b.sent?.seq ?? 0) - (a.sent?.seq ?? 0))[0];
    if (sent && sent.owner !== "block") {
      // A block's send that was the write of a rescue item it had: that item is the one kept.
      if (this.lastSend?.seq === sent.sent?.seq) this.lastSend = null;
      // Too large anywhere: kept to copy at once, not tried at other places.
      this.rescueFailed(sent.id, code === "too_large" ? "refused" : "moved");
      return;
    }
    if (sent) sent.sent = null;
    // The room answers a socket's frames in order: a send not acknowledged yet is the one refused.
    const last = this.lastSend;
    const unanswered = last !== null && !(this.backend.acked?.(last.seq) ?? true);
    this.lastSend = null;
    if (last && unanswered && !last.open) {
      // Its block closed before the answer: the open block, if any, is another.
      if (this.park(last.core, last.near)) this.showRescueNotice();
      else if (reason) this.showNotice(reason);
      this.hooks.status();
      return;
    }
    // Not held: the editor said what happened when the lease went (lost).
    if (code === "not_held") return;
    if (code === "too_large") {
      // The open block's send did not fit: it stays as typed, to be made smaller or sent again.
      if (unanswered && open && mine && this.typedDiffers(mine)) {
        this.cancelTimer();
        this.setStuck(true);
        this.stuckWhy = reason;
        this.noteStuck();
      }
      this.showNotice(reason);
      this.hooks.status();
      return;
    }
    this.refused(reason);
  }

  /**
   * An edit of the open block was refused by the doc's rules (this frame's check before sending,
   * or the room's: roomRefused): the block goes back to the room's text and stays open, and its
   * typing is kept first, parked in the rescue store with Copy and Dismiss (park). Typing that
   * cannot be written as typed (`stuck`) stays as typed instead.
   */
  refused(reason: string): void {
    this.cancelTimer();
    const open = this.open;
    const mine = this.backend.mine;
    if (this.stuck) {
      this.showNotice(reason);
      this.hooks.status();
      return;
    }
    let parked = false;
    if (open && mine) {
      const lines = this.backend.lines;
      const block = parseBlocks(joinLines(lines)).find(
        (b) => b.core.start >= mine.start && b.core.end <= mine.end,
      );
      const own = block ? joinLines(lines.slice(block.core.start, block.core.end)) : "";
      parked = this.parkTyped(open, own, mine.start);
      const model = block ? editableBlock(own, TOOLS, open.env) : null;
      open.rich.setModel(model ?? para());
    }
    if (parked) this.showRescueNotice();
    else this.showNotice(reason);
    this.hooks.status();
  }

  /** The open block holds text its leased lines do not (or text that cannot be written). */
  private typedDiffers(mine: LineRange): boolean {
    const block = this.currentText();
    if (block === null) return true;
    return padded(block, this.pad) !== joinLines(this.backend.lines.slice(mine.start, mine.end));
  }

  /**
   * The open block's typing, about to be replaced by the room's text (`own`), kept as a parked
   * rescue item (park). Whether there was anything to keep.
   */
  private parkTyped(open: Open, own: string, near: number): boolean {
    const model = open.rich.model;
    if (isEmptyBlock(model)) return false;
    const core =
      verifyBlock(model, TOOLS, open.env) ?? verifyBlock(withoutMarks(model), TOOLS, open.env);
    if (!core || core === own) return false;
    return this.park(core, near);
  }

  /** A rescue item for typing a kept op writes (keepTyped), in a room; none solo. */
  private keptItem(core: string, near: number): string | undefined {
    if (!this.backend.keep || core.trim() === "") return undefined;
    const id = `r${Date.now().toString(36)}${++this.rescueN}`;
    const r: Rescue = {
      id,
      text: core,
      near,
      sent: null,
      owner: null,
      n: ++this.rescueN,
      free: false,
      tries: 0,
      parked: false,
      reported: null,
      kept: null,
    };
    this.rescues.set(id, r);
    this.report([r], [], []);
    return id;
  }

  /**
   * Typed text that did not go in, kept as a parked rescue item near line `near`: the app keeps
   * it, the page offers Copy and Dismiss, and nothing writes it until a reload. Whether it was kept
   * (blank text is nothing to keep).
   */
  private park(core: string, near: number): boolean {
    if (core.trim() === "") return false;
    const id = `r${Date.now().toString(36)}${++this.rescueN}`;
    const r: Rescue = {
      id,
      text: core,
      near,
      sent: null,
      owner: null,
      n: ++this.rescueN,
      free: true,
      tries: RESCUE_TRIES,
      parked: true,
      reported: null,
      kept: null,
    };
    this.rescues.set(id, r);
    this.report([r], [], []);
    return true;
  }

  /** Send a pending block now. */
  flush(): void {
    if (!this.timer && !this.stuck) return;
    this.cancelTimer();
    this.send();
  }

  /**
   * Edit mode is ending with a block whose text cannot be written as typed: its text is kept
   * without its formatting, which can always be written, rather than lost with the block.
   */
  private salvage(): void {
    const open = this.open;
    if (!open || this.clearing) return;
    this.flush();
    if (!this.stuck) return;
    if (this.backend.mine) {
      open.rich.setModel(withoutMarks(open.rich.model));
      if (this.send()) this.showNotice(FORMAT_DROPPED);
      return;
    }
    // No lease (not connected, or it was lost): kept and written once a lease can be had.
    this.keepPlain(false);
  }

  /**
   * The open block's typing, which cannot be written as typed, is written without its marks once a
   * lease can be had (keepTyped): in place of the block as the doc had it (`after` false), or as a
   * new block right after it when someone else holds it now. While that waits the frame reports
   * unsent changes, and it is asked for again once the draft is back (and no review waits).
   */
  private keepPlain(after: boolean): boolean {
    const open = this.open;
    const held = this.held;
    if (!open || !held) return false;
    const core = verifyBlock(withoutMarks(open.rich.model), TOOLS, open.env);
    if (core === null || core === "") return false;
    const own = joinLines(this.backend.lines.slice(held.start, held.end));
    const c: Clearing = {
      phase: "insert",
      drop: true,
      text: "",
      lease: "",
      at: 0,
      from: after ? held.end : held.start,
      own,
      pad: this.pad,
      prefix: open.prefix,
      suffix: open.suffix,
      keep: core,
      point: after ? held.end : null,
    };
    const id = this.rescueFor(core, after ? held.end : held.start);
    this.setStuck(false);
    this.keepTyped(c, core, id);
    return true;
  }

  // ---------- the rescue store ----------

  /**
   * The rescue item for the open block's typing (`stuck`, or salvaged), made or brought up to
   * date. Rooms only: a solo tab's typing is in the app's kept copy.
   */
  private rescueFor(text: string, near: number): string | undefined {
    if (!this.backend.keep) return undefined;
    const id = this.blockRescue ?? `r${Date.now().toString(36)}${++this.rescueN}`;
    const was = this.rescues.get(id);
    const r: Rescue = {
      id,
      text,
      near,
      sent: null,
      owner: "block",
      n: ++this.rescueN,
      free: was?.free ?? false,
      tries: was?.tries ?? 0,
      parked: false,
      reported: was?.reported ?? null,
      kept: was?.kept ?? null,
    };
    this.rescues.set(id, r);
    this.blockRescue = id;
    if (was?.text !== text || was.near !== near) this.report([r], [], []);
    return id;
  }

  /**
   * An accepted write for item `id` (a send of its block, or its kept op): it is dropped once the
   * room acknowledges edit `seq`; without acks (solo, or nothing was sent) at once.
   */
  private rescueSent(
    id: string | null | undefined,
    seq: number | null,
    start: number,
    text: string,
  ) {
    const r = id ? this.rescues.get(id) : undefined;
    if (!r) return;
    if (seq === null || !this.backend.acked || this.backend.acked(seq)) {
      this.dropRescue(r.id);
      return;
    }
    r.sent = { seq, start, text, lost: false };
  }

  /** Item `id` leaves the store: written (the room acknowledged its write) or gone (on purpose). */
  private dropRescue(id: string, why: "written" | "gone" = "written"): void {
    if (!this.rescues.delete(id)) return;
    if (this.blockRescue === id) this.blockRescue = null;
    this.report([], why === "written" ? [id] : [], why === "gone" ? [id] : []);
    this.updateRescueNotice();
    this.hooks.status();
  }

  /**
   * Tells the app what changed in the store (it merges; see RescueReport). An item the app would
   * refuse (longer than one may be, or past a report's limits) would make it drop the whole
   * report: it stays on this page only, with Copy, and the rest goes.
   */
  private report(upsert: Rescue[], written: string[], gone: string[]): void {
    const n = ++this.reportN;
    const sent: Rescue[] = [];
    let total = 0;
    let capped = false;
    for (const r of upsert) {
      if (
        r.text.length > MAX_RESCUE_ITEM ||
        total + r.text.length > MAX_RESCUE_TOTAL ||
        sent.length >= MAX_RESCUE_ITEMS
      ) {
        r.reported = null;
        r.kept = false;
        capped = true;
        continue;
      }
      total += r.text.length;
      r.reported = n;
      sent.push(r);
    }
    this.hooks.rescue?.({
      upsert: sent.map(({ id, text, near }) => ({ id, text, near })),
      written,
      gone,
      n,
    });
    if (capped) this.updateRescueNotice();
  }

  /**
   * The app's answer to report `n` and the ones before it: the ids its store holds. An item it
   * was sent but does not hold (over its limits) is on this page only, which the page says, with
   * Copy.
   */
  rescueStored(ids: readonly string[], n: number): void {
    const held = new Set(ids);
    // Something left the app's store since its last answer (written or gone): an item it had no
    // room for is offered to it again.
    const freed = [...this.heldByApp].some((id) => !held.has(id));
    this.heldByApp = held;
    for (const r of this.rescues.values()) {
      if (held.has(r.id)) r.kept = true;
      else if (r.reported !== null && r.reported <= n) r.kept = false;
    }
    const retry = freed
      ? [...this.rescues.values()].filter(
          (r) => r.kept === false && r.text.length <= MAX_RESCUE_ITEM,
        )
      : [];
    if (retry.length > 0) this.report(retry, [], []);
    this.updateRescueNotice();
  }

  /** The ids the app's store held at its last answer (rescueStored). */
  private heldByApp = new Set<string>();

  /** Shows the rescue notice while something can only be copied, and hides it once nothing can. */
  private updateRescueNotice(): void {
    const shown = this.notice?.textContent ?? "";
    const showing = shown.startsWith(RESCUE_NOTICE);
    if (this.needsCopy) {
      // A Dismiss waiting for its confirmation stays as it is.
      if (!this.notice || (showing && !shown.startsWith(RESCUE_DISMISS))) this.showRescueNotice();
    } else if (showing) this.hideNotice();
  }

  /** Everything kept is dropped: the unpublished changes were discarded. */
  clearRescues(): void {
    // A send to the discarded draft that the room refuses keeps nothing either.
    this.lastSend = null;
    if (this.rescues.size === 0 && !this.want?.rescue) return;
    const ids = [...this.rescues.keys()];
    this.rescues.clear();
    if (ids.length > 0) this.report([], [], ids);
    this.updateRescueNotice();
    this.hooks.status();
    this.blockRescue = null;
    this.rescueFrozen = null;
    // A kept op on its way writes nothing either.
    if (this.want?.rescue && !this.backend.mine) this.want = null;
  }

  /** The open block cannot be written as typed: its text, without its marks, is kept. */
  private noteStuck(): void {
    const open = this.open;
    const at = this.backend.mine ?? this.held;
    if (!open || !at || !this.backend.keep) return;
    const core = verifyBlock(withoutMarks(open.rich.model), TOOLS, open.env);
    if (!core) return;
    this.rescueFor(core, at.start);
  }

  /**
   * Something kept can only be copied for now: items the app's store does not hold (only this page
   * has them), or ones tried too often.
   */
  private get needsCopy(): boolean {
    // Kept text that this person cannot write any more (their right changed) waits too.
    const blocked = this.backend.ready && this.backend.you?.right !== "write";
    return [...this.rescues.values()].some((r) => r.kept === false || r.parked || blocked);
  }

  /**
   * Items the app kept from before a reload: each one not in the draft already is written. With
   * `copy`, they are in this page's text already (solo, where the app could not keep a copy of
   * it): they are kept to copy or dismiss, never written again.
   */
  offerRescue(items: readonly RescueItem[], copy = false): void {
    let added = false;
    for (const it of items) {
      if (this.rescues.has(it.id)) continue;
      // From the app's store, which holds it already.
      this.rescues.set(it.id, {
        ...it,
        sent: null,
        owner: null,
        n: ++this.rescueN,
        free: true,
        tries: 0,
        parked: copy,
        reported: null,
        kept: true,
      });
      added = true;
    }
    if (!added) return;
    this.hooks.status();
    if (copy) this.updateRescueNotice();
    else this.flushRescues();
  }

  /**
   * The room's status changed (a review froze or ended): a rescue write that waited for the review
   * goes in once it is over.
   */
  roomStatus(): void {
    const f = this.rescueFrozen;
    if (!f) return;
    if (this.backend.conflictVersion !== null) f.seen = true;
    else if (f.seen) {
      this.rescueFrozen = null;
      queueMicrotask(() => this.flushRescues());
    }
  }

  /** Whether any typed text is still kept outside the draft. */
  get hasRescue(): boolean {
    return this.rescues.size > 0;
  }

  /** Items the room's lines hold now are dropped from the store. */
  private checkRescues(): void {
    const b = this.backend;
    for (const r of [...this.rescues.values()]) {
      const sent = r.sent;
      if (!sent) continue;
      if (!sent.lost) {
        if (sent.seq !== null && b.acked?.(sent.seq)) this.dropRescue(r.id);
        continue;
      }
      // The socket closed before the ack: it may or may not have landed, and matching text at its
      // place proves nothing (an insert can sit right before a same block). Written again once
      // the draft is back: a copy at worst, never a loss.
      if (!b.connected || !b.settled) continue;
      r.sent = null;
    }
  }

  /**
   * Writes the next kept item that is not written yet, once nothing else is going on (no block
   * open or asked for, connected, no review waiting): as a new block at the nearest free place.
   */
  private flushRescues(): void {
    const b = this.backend;
    if (this.want || b.mine || this.open || this.clearing) return;
    if (!b.ready || !b.connected || !b.settled || b.conflictVersion !== null) return;
    if (this.rescueFrozen) return;
    if (b.you?.right !== "write") {
      this.updateRescueNotice();
      return;
    }
    const r = [...this.rescues.values()].find(
      (x) => x.sent === null && x.owner === null && !x.parked,
    );
    if (!r) return;
    const point = this.freePoint(r.near);
    const c: Clearing = {
      phase: "insert",
      drop: true,
      text: "",
      lease: "",
      at: 0,
      from: point,
      own: "",
      pad: { before: false, after: false },
      prefix: [],
      suffix: [],
      keep: r.text,
      point,
    };
    this.keepTyped(c, r.text, r.id);
  }

  /**
   * The insert point nearest `near` between top-level blocks that no one else's lease touches,
   * else the end of the doc.
   */
  private freePoint(near: number): number {
    const b = this.backend;
    const lines = b.lines;
    const blocks = parseBlocks(joinLines(lines));
    const points = [0, ...blocks.flatMap((x) => [x.start, x.end]), lines.length];
    const others = [...b.leases.values()].filter((l) => l.id !== b.mine?.id);
    const free = [...new Set(points)]
      .filter((p) => p <= lines.length && !others.some((l) => l.start <= p && p <= l.end))
      .sort((x, y) => Math.abs(x - near) - Math.abs(y - near) || y - x);
    return free[0] ?? lines.length;
  }

  /**
   * A rescue write did not go in. A review waiting: it goes in once the review ends. Held or moved
   * meanwhile: it is tried at the nearest free place instead, RESCUE_TRIES times at most. Not
   * connected: again once the draft is back. Otherwise, and after the tries, it stays kept (the
   * frame still reports unsent changes, and the app keeps its copy), and the page says so with a
   * way to copy it.
   */
  private rescueFailed(id: string, why: "frozen" | "moved" | "offline" | "refused"): void {
    const r = this.rescues.get(id);
    if (!r) return;
    r.sent = null;
    r.owner = null;
    if (why === "frozen") {
      this.rescueFrozen = { seen: this.backend.conflictVersion !== null };
      this.showNotice(RESCUE_WAITS);
    } else if (why === "offline") {
      this.showNotice(NOT_SENT);
    } else {
      r.free = true;
      r.tries += 1;
      if (why === "refused" || r.tries >= RESCUE_TRIES) {
        r.parked = true;
        this.showRescueNotice();
      }
    }
    this.render();
    this.hooks.status();
    queueMicrotask(() => this.flushRescues());
  }

  private showRescueNotice(confirming = false): void {
    const only = [...this.rescues.values()].some((r) => r.kept === false);
    this.showNotice(
      confirming ? RESCUE_DISMISS : only ? RESCUE_FRAME_ONLY : RESCUE_STUCK,
      { label: "Copy", run: () => this.copyRescues() },
      {
        label: "Dismiss",
        run: () => (confirming ? this.dismissRescues() : this.showRescueNotice(true)),
      },
    );
  }

  /**
   * Dismiss, confirmed: every kept text leaves the store on purpose (`gone`), here and in the
   * app's copy. The person who typed it may, whatever their right on the doc now.
   */
  private dismissRescues(): void {
    const ids = [...this.rescues.keys()];
    this.rescues.clear();
    this.blockRescue = null;
    if (ids.length > 0) this.report([], [], ids);
    if (this.want?.rescue && !this.backend.mine) this.want = null;
    this.hideNotice();
    this.hooks.status();
  }

  /** Puts every kept text on the clipboard, for the person to paste where they want it. */
  private copyRescues(): void {
    const text = [...this.rescues.values()].map((r) => r.text).join("\n\n");
    const fallback = () => {
      const area = this.doc.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      this.doc.body.append(area);
      area.select();
      try {
        this.doc.execCommand("copy");
      } catch {
        // No clipboard here either: the text stays kept, and the notice stays.
      }
      area.remove();
    };
    const clip = this.win.navigator.clipboard;
    if (clip?.writeText) void clip.writeText(text).catch(fallback);
    else fallback();
  }

  /**
   * Close the open block: send what is pending, release the lease, show the block again. While a
   * cleared block is being removed (removeCleared) its lease is changing hands: the removal ends as
   * a Delete does, and the lease is released where it lands, once what was typed in the block
   * meanwhile is written there (keepTyped).
   */
  close(release: boolean, refocus = false, force = false): boolean {
    const open = this.open;
    const held = this.held;
    if (!open) {
      if (this.want && !this.want.op && !this.clearing) this.want = null;
      return true;
    }
    this.flush();
    if (this.stuck && !force) {
      // What is typed cannot be written yet: the block stays open with it, and the page says why.
      this.showNotice(this.stuckWhy);
      return false;
    }
    if (this.want && !this.want.op && !this.clearing) this.want = null;
    const c = this.clearing;
    if (c) {
      c.drop = true;
      c.keep = this.typedCore();
    } else if (release && this.backend.mine) this.backend.release();
    this.dropOpen();
    this.held = null;
    this.render();
    if (refocus && held) {
      for (const n of Array.from(this.root.childNodes)) {
        const r = rangeOf(n);
        if (r && r.start >= held.start && n.nodeType === 1) {
          (n as HTMLElement).focus();
          break;
        }
      }
    }
    this.hooks.status();
    return true;
  }

  // ---------- notices ----------

  /** A message in the frame's own status line (errors from the room). */
  notify(text: string): void {
    if (this.editing) this.showNotice(text);
  }

  private showNotice(
    text: string,
    action?: { label: string; run: () => void },
    second?: { label: string; run: () => void },
  ): void {
    let el = this.notice;
    if (!el) {
      el = this.doc.createElement("div");
      el.className = "plinth-doc__notice";
      el.setAttribute("role", "status");
      this.doc.body.append(el);
      this.notice = el;
    }
    const msg = this.doc.createElement("span");
    msg.textContent = text;
    const parts: Node[] = [msg];
    for (const a of [action, second]) {
      if (!a) continue;
      const btn = this.doc.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      btn.addEventListener("click", a.run);
      parts.push(btn);
    }
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "plinth-doc__notice-close";
    close.textContent = "×";
    // "Dismiss" is the rescue notice's own action there: this one only hides the notice.
    close.setAttribute("aria-label", second?.label === "Dismiss" ? "Close" : "Dismiss");
    close.addEventListener("click", () => this.hideNotice());
    parts.push(close);
    el.classList.toggle("plinth-doc__notice--two", second !== undefined);
    el.replaceChildren(...parts);
  }

  private hideNotice(): void {
    const was = this.notice?.textContent ?? "";
    this.notice?.remove();
    this.notice = null;
    // Kept text that can only be copied keeps its notice: it comes back once another one goes.
    if (this.needsCopy && !was.startsWith(RESCUE_NOTICE)) this.showRescueNotice();
  }

  /** For tests and the status line: the open block's editor. */
  get openEditor(): RichBlockEditor | null {
    return this.open?.rich ?? null;
  }
}

/** The end of a block's range without the blank lines at its end (a list's map has one). */
function filledEnd(lines: readonly string[], b: Block): number {
  let end = b.end;
  while (end > b.start && isBlank(lines[end - 1])) end--;
  return end;
}

/**
 * Whether `text`, which holds no block, written over `range` runs blocks outside it together: the
 * doc would then have fewer blocks than the ones outside the range.
 */
function runsTogether(lines: readonly string[], range: LineRange, text: string): boolean {
  const before = parseBlocks(joinLines(lines));
  const inside = before.filter((b) => b.core.start >= range.start && b.core.end <= range.end);
  const after = [...lines.slice(0, range.start), ...blockLines(text), ...lines.slice(range.end)];
  return parseBlocks(joinLines(after)).length !== before.length - inside.length;
}

/**
 * `text` for `range` with a blank line added at either end where it would sit right against the
 * line next to it, so a block an op moves or uncovers never runs into its neighbour. `lead` is 1
 * when one was added before it.
 */
function separated(
  lines: readonly string[],
  range: LineRange,
  text: string,
): { text: string; lead: number } {
  if (text === "") return { text, lead: 0 };
  const out = text.split("\n");
  let lead = 0;
  if (range.start > 0 && !isBlank(lines[range.start - 1]) && !isBlank(out[0])) {
    out.unshift("");
    lead = 1;
  }
  if (range.end < lines.length && !isBlank(lines[range.end]) && !isBlank(out.at(-1))) out.push("");
  return { text: out.join("\n"), lead };
}

const BULLETS = ["-", "*", "+"];
const DELIMITERS = [".", ")"];
const BULLET_AT = /^(\s{0,3})[-*+]/;
const NUMBER_AT = /^(\s{0,3}\d{1,9})[.)]/;

interface ListMark {
  ordered: boolean;
  /** The bullet, or a numbered list's delimiter. */
  mark: string;
  /** The lines (counted from the first given) the list's own items start on. */
  items: number[];
}

/** The list a block's lines start with, or null when they do not start with one. */
function listMark(lines: readonly string[]): ListMark | null {
  const tokens = markdown().parse(joinLines(lines), {});
  const first = tokens[0];
  if (first?.type !== "bullet_list_open" && first?.type !== "ordered_list_open") return null;
  const close = first.type.replace("_open", "_close");
  const end = tokens.findIndex((t) => t.type === close && t.level === 0);
  const items = tokens
    .slice(0, end < 0 ? undefined : end)
    .filter((t) => t.type === "list_item_open" && t.level === 1)
    .map((t) => t.map?.[0] ?? -1);
  return { ordered: first.type === "ordered_list_open", mark: first.markup, items };
}

/** A block's text with every line's list marker written one way, to find a re-marked list. */
function withoutMarkers(text: string): string {
  return text.replace(/^(\s*)[-*+](?=\s|$)/gm, "$1-").replace(/^(\s*\d{1,9})[.)](?=\s|$)/gm, "$1.");
}

/** Whether two blocks are lists that would be read as one with only blank lines between them. */
function listsJoin(a: readonly string[], b: readonly string[]): boolean {
  const x = listMark(a);
  const y = listMark(b);
  return !!x && !!y && x.ordered === y.ordered && x.mark === y.mark;
}

/**
 * A block's lines, with a list's markers changed to one no list among `neighbours` uses when one
 * of them shares its marker (two such lists would join); the lines as they are when none does,
 * and null when no marker is free.
 */
function apart(
  lines: readonly string[],
  neighbours: readonly (readonly string[] | undefined)[],
): string[] | null {
  const list = listMark(lines);
  if (!list) return [...lines];
  const taken = new Set<string>();
  for (const n of neighbours) {
    const m = n && listMark(n);
    if (m && m.ordered === list.ordered) taken.add(m.mark);
  }
  if (!taken.has(list.mark)) return [...lines];
  const re = list.ordered ? NUMBER_AT : BULLET_AT;
  if (!list.items.every((n) => n >= 0 && re.test(lines[n] ?? ""))) return null;
  for (const mark of list.ordered ? DELIMITERS : BULLETS) {
    if (taken.has(mark)) continue;
    const out = [...lines];
    for (const n of list.items) out[n] = (out[n] as string).replace(re, `$1${mark}`);
    // The new marker must keep it the same list ("* * *" is a divider, not an item).
    const again = listMark(out);
    if (again?.mark === mark && again.items.length === list.items.length) return out;
  }
  return null;
}

/** A block's reference definitions (the lines of its range outside its core). */
function defsOf(lines: readonly string[], b: Block): string[] {
  return [...lines.slice(b.start, b.core.start), ...lines.slice(b.core.end, b.end)].filter(
    (l) => !isBlank(l),
  );
}

/** What a Delete of `cur` over `range` leaves: its definitions, kept. */
function removedText(
  lines: readonly string[],
  cur: Block,
  range: LineRange,
  next: Block | undefined,
): string {
  const defs = defsOf(lines, cur);
  if (defs.length === 0) return "";
  if (next) return joinLines([...defs, ""]);
  return joinLines(range.start > 0 && range.end === lines.length ? ["", ...defs] : defs);
}

function overlaps(block: Block | LineRange, l: LineRange): boolean {
  if (block.start === block.end) return false;
  return rangesOverlap(block, l);
}

/** `b` with every mark taken off its text (links and code too), which can always be written. */
function withoutMarks(b: RichBlock): RichBlock {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (o.k === "text" || o.k === "atom") return { ...o, m: {} };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, strip(x)]));
  };
  return strip(b) as RichBlock;
}
