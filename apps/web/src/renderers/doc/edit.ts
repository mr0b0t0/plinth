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
  verifyBlock,
} from "@plinth/shared";
import type { AskWhat } from "../../components/viewer/rendererProtocol.ts";
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
  reveal,
} from "../common/richblock.ts";
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
 * between cells and lines, " · " between a list's items, every run of white space or control
 * characters one space, at most the page anchor's length.
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
  // Control characters (none of them shown) read as spaces, as white space does.
  const words = (run: string) =>
    Array.from(run, (c) => (c < " " || c === "\u007f" ? " " : c))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const text = runs.map(words).filter(Boolean).join(" · ");
  return Array.from(text).slice(0, PAGE_COMMENT_LIMITS.maxText).join("").trimEnd();
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
  caret?: "start" | "end";
  /**
   * The op writes what was typed in a cleared block closed while it was being removed (keepTyped):
   * the frame reports unsent changes until it is made, and it is asked for again once the draft is
   * back after a reconnect.
   */
  kept?: true;
}

interface Pad {
  before: boolean;
  after: boolean;
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
}

const isBlank = (s: string | undefined) => s === undefined || s.trim() === "";

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
  private afterCaret: "start" | "end" = "end";
  /** What the person asked for while a block op waited for its lease, run once it is done. */
  private queued: (() => void) | null = null;
  /** A cleared block being removed (removeCleared), until the block is open where it was. */
  private clearing: Clearing | null = null;
  /** A lease request is on its way over the socket and has had no answer yet. */
  private asking = false;

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
    return this.timer !== null || this.clearing !== null || this.want?.kept === true;
  }

  /** A block op or a cleared block's removal is on its way: other ops and opens wait for it. */
  private get busy(): boolean {
    return this.opPending || this.clearing !== null;
  }

  setBackend(b: DocBackend): void {
    this.backend = b;
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
    p.textContent = EMPTY_DOC;
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
      this.close(true);
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
    }
    this.render();
    this.hooks.status();
  }

  private readonly onSaveKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.flush();
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
      this.close(true);
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

  private open_(block: Block, caret: "start" | "end", at?: { x: number; y: number }): void {
    const b = this.backend;
    if (!this.editing || !b.ready) return;
    const text = joinLines(b.lines.slice(block.start, block.end));
    const near = block.start;
    if (this.busy) {
      // A block op is waiting for its lease, or a cleared block is being removed (which this
      // closes): open this block once that is done, found again by its text (the op may move it,
      // or give a list another marker).
      this.close(true);
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
    this.close(true);
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
      this.close(true);
      this.queued = () => this.openInsert(point(), initial);
      return;
    }
    this.close(true);
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
              this.close(true);
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
      this.ask(block.start, false);
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
          if (start !== null) this.ask(start, true);
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
          run: () => (found ? this.remove(found.block.start) : this.close(true, true)),
        },
      ],
    });
    return groups;
  }

  private tableForm(start: number | null): TableForm {
    return { insert: (rows: number, cols: number) => this.insertTable(start, rows, cols) };
  }

  /** Ask an agent about block `start` (its image, with `image`): the app opens its Ask dialog. */
  private ask(start: number, image: boolean): void {
    const index = this.blockAt(start)?.index ?? 0;
    const sel = this.selected;
    const open = this.open?.rich.model;
    const nodes =
      sel?.start === start ? Array.from(sel.panel.childNodes).filter((n) => n !== sel.bar) : null;
    const what: AskWhat = image
      ? "image"
      : nodes
        ? whatOf(nodes)
        : open
          ? whatOfModel(open)
          : "block";
    // The block's first words, as the person sees them (an open image's alt text): its number
    // would mean nothing to the person asking. "Insert below, Image" asks about an image that is
    // not there yet, and the dialog names the kind of block instead. The frame posts them only
    // when the published version has them too (boot.ts).
    const text =
      open?.t === "image"
        ? blockWords([this.doc.createTextNode(open.alt)])
        : !image && nodes
          ? blockWords(nodes)
          : "";
    this.close(true);
    this.deselect();
    const n = index + 1;
    this.hooks.ask?.({ key: image ? `block-${n}:image` : `block-${n}`, text }, what);
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
    open.rich.setModel(next);
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
    this.close(true);
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
    this.close(true);
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
      } else open.rich.focus(w?.caret ?? (w?.insert ? "start" : "end"));
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
        if (at !== null) this.ask(at, true);
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
      split: (keep, next) => this.split(keep, next),
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
    if (refusal !== null || !result) {
      // Nothing changed, so nothing is opened or selected for it.
      this.showNotice(w.kept ? NOT_KEPT : (refusal ?? CHANGED_MEANWHILE));
      this.render();
      this.hooks.status();
      return;
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
    if (new TextEncoder().encode(joinLines(after)).byteLength > LIMITS.maxDocBytes) {
      return { refusal: DOC_FULL };
    }
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
      (w.keep !== undefined || w.kept) &&
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
  private split(keep: RichBlock, next: RichBlock | null): void {
    const open = this.open;
    const mine = this.backend.mine;
    if (!open || !mine || this.clearing) return;
    const keepCore = verifyBlock(keep, TOOLS, open.env);
    const nextCore = next ? verifyBlock(next, TOOLS, open.env) : "";
    if (keepCore === null || nextCore === null) {
      this.showNotice(FORMAT_LOST);
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
    // Typing not sent yet goes with the split (at the start, before the paragraph above opens).
    const pending = this.timer !== null;
    this.cancelTimer();
    if (keepCore === "" && nextCore !== "") {
      // Enter at the very start: a new paragraph above, once this block's typing is in.
      if (pending && !this.send()) {
        this.schedule(EDIT_DEBOUNCE_MS);
        return;
      }
      this.close(true);
      this.openInsert(mine.start + (this.pad.before ? 1 : 0), para());
      return;
    }
    const core = nextCore === "" ? keepCore : `${keepCore}\n\n${nextCore}`;
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
    const keepLines = keepCore === "" ? 0 : keepCore.split("\n").length;
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
    }
    this.backend.release();
    this.dropOpen();
    this.held = null;
    this.after =
      nextCore === ""
        ? { line: Math.max(mine.start, end), open: false, insert: next ?? para() }
        : { line: keepAt + keepLines + 1, open: true };
    if (nextCore !== "") this.afterCaret = "start";
    this.render();
    this.hooks.status();
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
    this.close(true, true);
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
    if (block === null) {
      this.showNotice(FORMAT_LOST);
      return false;
    }
    const text = padded(block, this.pad);
    const lines = this.backend.lines;
    if (joinLines(lines.slice(mine.start, mine.end)) === text) return true;
    // The room's rules, checked here first: a refusal is never silent.
    if (RULES?.checkEdit(lines, mine.start, mine.end - mine.start, blockLines(text))) {
      this.refused(REFUSED_EDIT);
      return false;
    }
    const refusal =
      this.unsendable(lines, mine, text) ?? (this.backend.edit(text) ? null : NOT_SENT);
    if (refusal) {
      this.showNotice(refusal);
      return false;
    }
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
    if (core === null) this.showNotice(FORMAT_LOST);
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
  private keepTyped(c: Clearing, core: string): void {
    const b = this.backend;
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
    const w: Want = { ...p, insert: false, tries: 0, op: { plan, build }, kept: true };
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
    if (b.connected && b.settled) this.retake(w);
    this.render();
    this.hooks.status();
  }

  /** Why `text` in place of the leased lines cannot be sent, checked first; null when it can. */
  private unsendable(lines: readonly string[], mine: LineRange, text: string): string | null {
    const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
    if (bytes(text) > LIMITS.liveDocFrameBytes - 256) return TOO_LONG;
    const after = [...lines.slice(0, mine.start), ...blockLines(text), ...lines.slice(mine.end)];
    if (bytes(joinLines(after)) > LIMITS.maxDocBytes) return DOC_FULL;
    return null;
  }

  /**
   * An edit was refused (by this frame's check, or by the room because the lines changed first):
   * the block goes back to the room's text and stays open, and the frame says why.
   */
  refused(reason: string): void {
    this.cancelTimer();
    const open = this.open;
    const mine = this.backend.mine;
    if (open && mine) {
      const lines = this.backend.lines;
      const block = parseBlocks(joinLines(lines)).find(
        (b) => b.core.start >= mine.start && b.core.end <= mine.end,
      );
      const model = block
        ? editableBlock(joinLines(lines.slice(block.core.start, block.core.end)), TOOLS, open.env)
        : null;
      open.rich.setModel(model ?? para());
    }
    this.showNotice(reason);
    this.hooks.status();
  }

  /** Send a pending block now. */
  flush(): void {
    if (!this.timer) return;
    this.cancelTimer();
    this.send();
  }

  /**
   * Close the open block: send what is pending, release the lease, show the block again. While a
   * cleared block is being removed (removeCleared) its lease is changing hands: the removal ends as
   * a Delete does, and the lease is released where it lands, once what was typed in the block
   * meanwhile is written there (keepTyped).
   */
  close(release: boolean, refocus = false): void {
    const open = this.open;
    const held = this.held;
    if (this.want && !this.want.op && !this.clearing) this.want = null;
    if (!open) return;
    this.flush();
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
  }

  // ---------- notices ----------

  /** A message in the frame's own status line (errors from the room). */
  notify(text: string): void {
    if (this.editing) this.showNotice(text);
  }

  private showNotice(text: string, action?: { label: string; run: () => void }): void {
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
    if (action) {
      const btn = this.doc.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.addEventListener("click", action.run);
      parts.push(btn);
    }
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "plinth-doc__notice-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => this.hideNotice());
    parts.push(close);
    el.replaceChildren(...parts);
  }

  private hideNotice(): void {
    this.notice?.remove();
    this.notice = null;
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
