// On-page editing of a doc (#36), as formatted text (doc-blocks): nobody sees Markdown. The page
// shows the doc block by block (blocks.ts); in edit mode a click (or Enter) on a block asks for a
// lease on its lines, and once it is granted the block is drawn again as formatted text that can be
// edited in place (../common/richblock.ts), with a toolbar (bold, italic, code, link,
// strikethrough) and the block menu (Turn into, Insert below, Move up and down, Delete). Typing
// sends the whole block, re-written as Markdown by @plinth/shared's serializer, at most every
// 250 ms; Esc or moving focus elsewhere in the page releases it. Blocks other people hold show a
// bronze rule with their email and their text as it arrives.
//
// Only blocks the model can show faithfully are edited this way: the fidelity check
// (editableBlock) runs before a lease, and a block that fails it (a construct the model lacks, say
// a list item holding a code fence) is shown read-only, with "Ask an agent to change this", Move
// and Delete, which move or remove its lines byte for byte. Untouched blocks keep their bytes: only
// the leased block's lines are ever replaced, and the reference definitions that follow a block
// stay as they are. Images are agent-only: an image block's alt text is a field, and "Add or
// replace an image: Ask an agent" asks the app to open its Ask dialog.
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
// has it and says why. Images are drawn from the draft's base version's files (common/files.ts),
// which are the files a Publish keeps.
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
  type RichBlock,
  type RichInline,
  rangesOverlap,
  serializeBlock,
  splitLines,
  verifyBlock,
} from "@plinth/shared";
import { pinFiles } from "../common/files.ts";
import {
  type ClientLease,
  type LeaseDenial,
  type LeaseLoss,
  type LiveBackend,
  locateBlock,
} from "../common/live.ts";
import { FORMAT_LOST, kindName, RichBlockEditor, type RichHost } from "../common/richblock.ts";
import { type Block, BlockCache, parseBlocks, rangeOf, reconcile } from "./blocks.ts";
import {
  docEnv,
  docMarkdownTools,
  isSafeHref,
  markdown,
  normalizeHref,
  renderInlineMarkdown,
} from "./markdown.ts";
import { BlockMenu, type MenuGroup } from "./menu.ts";
import { sanitizeHtml } from "./sanitize.ts";

export const EDIT_DEBOUNCE_MS = 250;
const STALE_RETRIES = 3;
const RULES = liveRules("doc");
const TOOLS = docMarkdownTools();

/** Why a block was not kept, in the doc's words. */
export const REFUSED_EDIT =
  "That change would make the doc start like a web page, which a doc can't publish, so it wasn't kept.";
export const READ_ONLY_NOTE =
  "This part can't be edited here, so it is shown as it is. An agent can change it.";
export const EMPTY_DOC = "Write something";
/** Why a Move or Delete was not made: the blocks around it would have become one. */
export const JOINED_BLOCKS =
  "That would run the blocks around it together into one, so nothing was changed.";
/** Why a block op was not made: the doc has no room for it. */
export const DOC_FULL = "The doc is at its size limit, so that change wasn't made.";
/** Why an edit was not sent: the room is out of reach (or this frame has no lease). */
export const NOT_SENT = "Not connected. Try again in a moment.";
/** Why a block was not sent: it is over one frame. */
export const TOO_LONG = "This block is too long to send. Split it into smaller blocks.";

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

/** A place on the page an agent is asked about (`ask`): a structural name, never content. */
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
  /** Ask an agent about a place in the doc (the app's Ask dialog). */
  ask?(anchor: AskAnchor): void;
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
}

interface Pad {
  before: boolean;
  after: boolean;
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
  private readonly inserts: HTMLButtonElement[] = [];
  private readonly insertAt = new WeakMap<Node, number>();
  private readonly labels = new Map<string, HTMLElement>();
  private readonly labelLease = new WeakMap<Node, string>();
  private readonly tabbed = new WeakSet<Element>();
  private decorated = new Set<Element>();
  /** A block that cannot be edited in place, selected: its bar of what can be done with it. */
  private selected: { start: number; bar: HTMLElement; menu: BlockMenu } | null = null;
  private placeholder: HTMLElement | null = null;
  /** After an op: the line of the block to focus (and open, or select) once it is drawn. */
  private after: { line: number; open: boolean; insert?: RichBlock } | null = null;
  private afterCaret: "start" | "end" = "end";
  /** What the person asked for while a block op waited for its lease, run once it is done. */
  private queued: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly win: Window,
    private backend: DocBackend,
    private readonly hooks: EditorHooks,
  ) {
    this.cache = new BlockCache(win.document);
  }

  get doc(): Document {
    return this.win.document;
  }

  /** A block op (move, delete, insert) has asked for its lease and not had it yet. */
  private get opPending(): boolean {
    return this.want?.op !== undefined;
  }

  /** A block's text is waiting in the debounce, not yet sent. */
  get pending(): boolean {
    return this.timer !== null;
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
    // While a block is being re-taken (after a reconnect or a merge) it stays where it was,
    // keeping the text and the focus.
    const retaking = openEl && this.want?.keep !== undefined && !b.mine ? this.held : null;
    const mine = this.editing && openEl ? (b.mine ?? retaking) : null;
    if (b.mine && mine === b.mine) this.held = { start: mine.start, end: mine.end };
    const others = this.editing ? [...b.leases.values()].filter((l) => l.id !== b.mine?.id) : [];
    const desired: Node[] = [];
    let placed = false;
    let ins = 0;
    const labelled = new Set<string>();
    const nextDecorated = new Set<Element>();
    const placeOpen = () => {
      if (mine && openEl && !placed) {
        desired.push(openEl);
        placed = true;
      }
    };
    const insertButton = (at: number) => {
      if (!this.editing || !this.canWrite) return;
      let btn = this.inserts[ins];
      if (!btn) {
        btn = this.doc.createElement("button");
        btn.type = "button";
        btn.className = "plinth-doc__insert";
        btn.textContent = "+";
        btn.setAttribute("aria-label", "Add a paragraph here");
        this.inserts.push(btn);
      }
      ins++;
      this.insertAt.set(btn, at);
      desired.push(btn);
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
    insertButton(0);
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
      const isSelected = this.editing && this.selected?.start === block.start && !holder;
      if (isSelected && this.selected) {
        desired.push(this.selected.bar);
        selectedSeen = true;
      }
      for (const n of this.cache.nodes(block)) {
        desired.push(n);
        if (n.nodeType === 1) {
          const el = n as Element;
          this.decorate(el, holder !== undefined, isSelected);
          if (this.editing || holder) nextDecorated.add(el);
        }
      }
      insertButton(block.end);
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
    this.focusAfter(blocks);
    const q = this.queued;
    if (q && !this.opPending && !this.backend.mine && !this.after) {
      this.queued = null;
      q();
    }
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

  private decorate(el: Element, held: boolean, selected: boolean): void {
    el.classList.toggle("plinth-doc__held", held);
    el.classList.toggle("plinth-doc__selected", selected);
    if (this.editing && !el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "0");
      this.tabbed.add(el);
    } else if (!this.editing) this.untab(el);
    if (el.getAttribute("class") === "") el.removeAttribute("class");
  }

  private undecorate(el: Element): void {
    el.classList.remove("plinth-doc__held", "plinth-doc__selected");
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
    if (!top || top === this.open?.rich.el || top === this.selected?.bar) return;
    if (top === this.placeholder) {
      e.preventDefault();
      return this.openInsert(0, para());
    }
    const at = this.insertAt.get(top);
    if (at !== undefined) {
      e.preventDefault();
      return this.openInsert(at, para());
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
    if (this.selected?.bar.contains(e.target as Node)) {
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
    if (this.opPending) {
      // A block op is waiting for its lease: open this block once the op is done, found again by
      // its text (the op may move it).
      const text = joinLines(b.lines.slice(block.start, block.end));
      const near = block.start;
      this.queued = () => {
        const blocks = this.blocks();
        const i = this.findBlock(blocks, text, near);
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
    if (!this.modelOf(block)) {
      this.close(true);
      this.select(block);
      return;
    }
    this.close(true);
    this.deselect();
    this.want = {
      start: block.start,
      end: block.end,
      text: joinLines(b.lines.slice(block.start, block.end)),
      insert: false,
      tries: 0,
      caret,
      ...(at ? { at } : {}),
    };
    if (!b.lease(block)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  /** Open a new block of `initial` at line `at` (an insert-point lease). */
  private openInsert(at: number, initial: RichBlock): void {
    const b = this.backend;
    if (!this.canWrite) return;
    if (this.opPending) {
      this.queued = () => this.openInsert(Math.min(at, this.backend.lines.length), initial);
      return;
    }
    this.close(true);
    this.deselect();
    const range = { start: at, end: at };
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other);
      return;
    }
    this.pad = { before: at > 0 && !isBlank(b.lines[at - 1]), after: !isBlank(b.lines[at]) };
    this.want = { ...range, text: "", insert: true, tries: 0, initial };
    if (!b.lease(range)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  private explainHeld(l: ClientLease): void {
    const idle = Date.now() - l.at >= LIMITS.liveLeaseIdleS * 1000;
    this.showNotice(
      `${l.by} is editing this.`,
      idle && this.backend.you?.right === "write"
        ? {
            label: "Take over",
            run: () => {
              this.close(true);
              this.want = { start: l.start, end: l.end, text: "", insert: false, tries: 0 };
              if (this.backend.takeover(l.id)) this.hideNotice();
            },
          }
        : undefined,
    );
  }

  // ---------- a block that cannot be edited in place ----------

  private select(block: Block): void {
    this.deselect();
    const index = this.blockAt(block.start)?.index ?? 0;
    const bar = this.doc.createElement("div");
    bar.className = "plinth-doc__blockbar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `Block ${index + 1}`);
    const note = this.doc.createElement("span");
    note.className = "plinth-doc__blockbar-note";
    note.textContent = READ_ONLY_NOTE;
    const ask = this.doc.createElement("button");
    ask.type = "button";
    ask.className = "plinth-rich__btn plinth-doc__ask";
    ask.textContent = "Ask an agent to change this";
    ask.addEventListener("click", (e) => {
      e.preventDefault();
      this.ask(block.start, false);
    });
    const menu = new BlockMenu(
      this.doc,
      () => this.menuGroups(block.start, null),
      this.tableForm(block.start),
    );
    bar.append(note, ask, menu.button);
    this.selected = { start: block.start, bar, menu };
    this.render();
    ask.focus();
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

  private menuGroups(start: number, model: RichBlock | null): MenuGroup[] {
    const found = this.blockAt(start);
    const index = found?.index ?? -1;
    const count = found?.blocks.length ?? 0;
    const groups: MenuGroup[] = [];
    const own = model ? kindOf(model) : null;
    if (model && own !== null) {
      groups.push({
        label: "Turn into",
        items: KIND_LABELS.map(([k, label]) => ({
          label,
          checked: k === own,
          run: () => this.turn(k),
        })),
      });
    }
    groups.push({
      label: "Insert below",
      items: [
        ...KIND_LABELS.map(([k, label]) => ({ label, run: () => this.insertBelow(start, k) })),
        { label: "Divider", run: () => this.insertDivider(start) },
        {
          label: "Add or replace an image: Ask an agent",
          run: () => this.ask(start, true),
        },
      ],
    });
    groups.push({
      items: [
        { label: "Move up", disabled: index <= 0, run: () => this.move(start, -1) },
        {
          label: "Move down",
          disabled: index < 0 || index >= count - 1,
          run: () => this.move(start, 1),
        },
        { label: "Delete", run: () => this.remove(start) },
      ],
    });
    return groups;
  }

  private tableForm(start: number) {
    return { insert: (rows: number, cols: number) => this.insertTable(start, rows, cols) };
  }

  /** Ask an agent about block `start` (its image, with `image`): the app opens its Ask dialog. */
  private ask(start: number, image: boolean): void {
    const index = this.blockAt(start)?.index ?? 0;
    this.close(true);
    this.deselect();
    const n = index + 1;
    this.hooks.ask?.(
      image
        ? { key: `block-${n}:image`, text: `Block ${n}, image` }
        : { key: `block-${n}`, text: `Block ${n}` },
    );
  }

  private turn(kind: BlockKind): void {
    const open = this.open;
    const mine = this.backend.mine;
    if (!open || !mine) return;
    const next = turnInto(open.rich.model, kind, this.neighbours(mine));
    if (verifyBlock(next, TOOLS, open.env) === null) {
      this.showNotice(FORMAT_LOST);
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

  private insertBelow(start: number, kind: BlockKind): void {
    const found = this.blockAt(start);
    if (!found) return;
    const lines = this.backend.lines;
    const next = found.blocks[found.index + 1];
    const near = [lines[found.block.core.start], next ? lines[next.core.start] : undefined];
    this.close(true);
    // close() may have changed the lines (solo): find the block again.
    const again = this.blockAt(start) ?? found;
    this.openInsert(again.block.end, emptyOf(kind, near));
  }

  /** Runs `plan` (the range and its text, found again on every try) as a one-edit lease. */
  private runOp(plan: () => (LineRange & { text: string }) | null, build: OpBuild): void {
    if (!this.canWrite) return;
    if (this.opPending) {
      this.showNotice("One moment: the last change is still being made.");
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
    if (!this.backend.lease(p)) {
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
    this.runOp(plan, (lines, lease) => {
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
    });
  }

  private insertDivider(start: number): void {
    this.insertAfter(start, () => ({ text: "---" }));
  }

  private insertTable(start: number, rows: number, cols: number): void {
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

  /** A new block from `make` right below block `start`, in one edit. */
  private insertAfter(start: number, make: () => { text: string; open?: boolean }): void {
    const target = this.blockText(start);
    const plan = () => {
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
        ...(made.open ? { open: true } : {}),
      };
    });
  }

  private blockText(start: number): string {
    const found = this.blockAt(start);
    if (!found) return "";
    return joinLines(this.backend.lines.slice(found.block.start, found.block.end));
  }

  /** The block whose lines are `text`, nearest to line `near`. */
  private findBlock(blocks: Block[], text: string, near: number): number {
    const lines = this.backend.lines;
    let best = -1;
    blocks.forEach((b, i) => {
      if (joinLines(lines.slice(b.start, b.end)) !== text) return;
      if (best < 0 || Math.abs(b.start - near) < Math.abs((blocks[best] as Block).start - near)) {
        best = i;
      }
    });
    return best;
  }

  // ---------- lease events (from the backend) ----------

  granted(lease: ClientLease): void {
    const w = this.want;
    this.want = null;
    if (!this.editing) {
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
    if (keep) this.schedule(0);
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
    const menu = new BlockMenu(
      this.doc,
      () => {
        const s = this.backend.mine?.start ?? start;
        const found = this.blockAt(s) ?? this.blockAt(s + 1);
        return this.menuGroups(found?.block.start ?? s, holder.open?.rich.model ?? model);
      },
      {
        insert: (rows, cols) => {
          const s = this.backend.mine?.start ?? start;
          const found = this.blockAt(s) ?? this.blockAt(s + 1);
          this.insertTable(found?.block.start ?? s, rows, cols);
        },
      },
    );
    const extra: HTMLElement[] = [];
    if (model.t === "image") {
      const ask = this.doc.createElement("button");
      ask.type = "button";
      ask.className = "plinth-rich__btn plinth-doc__ask";
      ask.textContent = "Add or replace an image: Ask an agent";
      ask.addEventListener("mousedown", (e) => e.preventDefault());
      ask.addEventListener("click", (e) => {
        e.preventDefault();
        const s = this.backend.mine?.start ?? start;
        const found = this.blockAt(s) ?? this.blockAt(s + 1);
        this.ask(found?.block.start ?? s, true);
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
      changed: () => this.schedule(EDIT_DEBOUNCE_MS),
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
    if (!result) {
      this.backend.release();
      this.showNotice("The doc changed meanwhile. Try again.");
      return;
    }
    const fitted = this.fits(lease, result.text);
    if (fitted === null) {
      this.backend.release();
      this.showNotice(REFUSED_EDIT);
      return;
    }
    const after = [
      ...lines.slice(0, lease.start),
      ...blockLines(fitted),
      ...lines.slice(lease.end),
    ];
    let refusal: string | null = null;
    if (result.blocks !== undefined && parseBlocks(joinLines(after)).length !== result.blocks) {
      refusal = JOINED_BLOCKS;
    } else if (new TextEncoder().encode(joinLines(after)).byteLength > LIMITS.maxDocBytes) {
      refusal = DOC_FULL;
    } else if (fitted !== text && !this.backend.edit(fitted)) {
      refusal = NOT_SENT;
    }
    this.backend.release();
    if (refusal) {
      // Nothing changed, so nothing is opened or selected for it.
      this.showNotice(refusal);
      this.render();
      return;
    }
    if (result.focus !== undefined) this.after = { line: result.focus, open: !!result.open };
    this.render();
    this.hooks.status();
  }

  denied(reason: LeaseDenial, by?: string): void {
    const w = this.want;
    this.want = null;
    if (reason === "stale" && w && w.tries < STALE_RETRIES) {
      this.retake(w);
      return;
    }
    if (w?.op) {
      this.showNotice(
        reason === "held"
          ? `${by ?? "Someone"} is editing next to this block. Try again when they finish.`
          : "The doc changed meanwhile. Try again.",
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
      if (!b.lease(p)) this.want = null;
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
      if (!b.lease(next)) this.want = w.keep !== undefined ? { ...w, tries: 0 } : null;
      return;
    }
    const next = { ...w, start: at, end: w.insert ? at : at + n, tries: w.tries + 1 };
    this.want = next;
    // Not connected: a block with text to keep is tried again once the draft is back.
    if (!b.lease(next)) this.want = w.keep !== undefined ? { ...w, tries: 0 } : null;
  }

  lost(reason: LeaseLoss): void {
    const open = this.open;
    const held = this.held;
    this.cancelTimer();
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
    if (w?.keep !== undefined && !b.mine && b.connected && b.settled && w.tries === 0) {
      // A block to re-take after a reconnect or a merge.
      this.want = null;
      this.retake(w);
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
    if (!open || !mine) return;
    const keepCore = verifyBlock(keep, TOOLS, open.env);
    const nextCore = next ? verifyBlock(next, TOOLS, open.env) : "";
    if (keepCore === null || nextCore === null) {
      this.showNotice(FORMAT_LOST);
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
    // Focus stays on the block just closed (there may be no next one, and the next one opens
    // only once its lease arrives), never on the frame's body.
    this.close(true, true);
    if (!from) return;
    const blocks = this.blocks();
    const next = back
      ? blocks.filter((b) => b.end <= from.start).at(-1)
      : blocks.find((b) => b.start >= from.end && b.end > b.start);
    if (next) this.open_(next, back ? "end" : "start");
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

  /** Sends the open block. False when it was not sent (refused, or not expressible). */
  private send(): boolean {
    const mine = this.backend.mine;
    if (!this.open || !mine) return false;
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

  /** Close the open block: send what is pending, release the lease, show the block again. */
  close(release: boolean, refocus = false): void {
    const open = this.open;
    const held = this.held;
    if (this.want && !this.want.op) this.want = null;
    if (!open) return;
    this.flush();
    if (release && this.backend.mine) this.backend.release();
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
