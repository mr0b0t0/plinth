// Editing a deck on its page (slides-text, docs/spec.md "Slides"): nobody sees Markdown. Edit mode
// draws every raw slide of the draft (editView.ts), empty ones at the deck's edges included, and
// makes each text element of a slide editable as formatted text (../common/richblock.ts): a click,
// or Enter on a focused element, asks for a lease on the lines of the top-level block that holds
// it (a heading, a paragraph, a list, a table, a quote or a code block of the slide's head or a
// column), and once it is granted the block is drawn again in place as formatted text. Typing
// sends the whole block, written back as Markdown by @plinth/shared's slides serializer (which
// escapes what a deck would read as structure), at most every 250 ms; Esc or moving focus
// elsewhere releases it. Speaker notes are edited the same way in a panel under the slide, as one
// lease on the whole notes part. Deck settings are a popover that sends one struct op.
//
// Before it sends, the editor runs the room's own rules (liveTypes.ts, the slides structure rule)
// on its copy, so a refusal from the room means another socket changed the lines first, or the
// edit was forged: the block is put back as the room has it and the frame's live region says why.
// Emptying a block sends zero lines, or one blank line, or first trims a bare opening `---`
// (deckEmptying), so a slide that loses its last block stays as an empty slide. Blocks the model
// cannot show faithfully (the fidelity check) and images are not edited in place: selecting one
// offers "Ask an agent", and an image also "Delete". Images are drawn from the draft's base
// version's files (../common/files.ts), which are the files a Publish keeps.
//
// Typing the draft does not hold yet is never dropped: it is written again where it can go, kept
// on the page with Copy where it cannot, and mirrored in the app's rescue store (alone too, beside
// the app's kept copy of the deck as written), each item tagged with the part it was typed in (a
// slide or its notes), so a reload writes it back into that part.
//
// Two backends: the room's draft socket (../common/live.ts, "room" mode), or a local copy that only
// this frame edits ("solo" mode, where the app saves it through its own session). Everything this
// file draws is made with createElement and textContent; every rendered block went through the
// unchanged sanitizer first.
import {
  applySlidesStruct,
  blockFromSource,
  blockLines,
  type DeckLayout,
  type DeckPartContext,
  type DeckSettings,
  deckEmptying,
  deckLayout,
  deckPartShown,
  editableBlock,
  escapeDeckPart,
  frontMatterEnd,
  isSeparatorLine,
  joinLines,
  LIMITS,
  type LineRange,
  liveRules,
  MAX_DECK_FOOTER,
  type MdEnv,
  mapRange,
  type NotesForm,
  notesFormOf,
  notesText,
  parseLaidOut,
  type RichBlock,
  rangesOverlap,
  type SlidesStructOp,
  sameBlock,
  serializeNotes,
  splitLines,
  verifyBlock,
} from "@plinth/shared";
import { personName } from "../../components/viewer/format.ts";
import {
  type AskWhat,
  MAX_RESCUE_REF,
  type RescueItem,
} from "../../components/viewer/rendererProtocol.ts";
import { pinFiles } from "../common/files.ts";
import {
  type ClientLease,
  type LeaseDenial,
  type LeaseLoss,
  type LiveBackend,
  locateBlock,
} from "../common/live.ts";
import { kindName, RichBlockEditor, type RichHost, type RichPoint } from "../common/richblock.ts";
import { parseBlocks } from "../doc/blocks.ts";
import {
  docEnv,
  docMarkdownTools,
  isSafeHref,
  normalizeHref,
  renderInlineMarkdown,
} from "../doc/markdown.ts";
import { sanitizeHtml } from "../doc/sanitize.ts";
import { el } from "./dom.ts";
import { blockAt, EDIT_VIEW_WORDS, type EditBlock, type EditSlideView } from "./editView.ts";

export const EDIT_DEBOUNCE_MS = 250;
/** How long a message stays on the page (it stays in the live region). */
export const NOTICE_MS = 6000;
const RULES = liveRules("slides");
const TOOLS = docMarkdownTools();

/** The editor's words (exported for tests). */
export const DECK_WORDS = {
  refused: "That change would change the deck's layout, so it wasn't kept.",
  held: (who: string, n: number) => `${who} is editing slide ${n}.`,
  heldHere: (who: string) => `${who} is editing this.`,
  /** Whoever holds it, when the room's answer names no one. */
  someone: "Someone",
  notConnected: "Not connected. Try again in a moment.",
  changed: "The deck changed meanwhile. Try again.",
  notKept: "The deck changed while you were offline, so the block you were typing in was closed.",
  unsavable: "This text can't be saved as typed. Change it to continue.",
  formatDropped: "Formatting in the block you were typing in couldn't be kept.",
  takenKept: "Someone else took over this block. What you typed is kept below it.",
  closedKept: "The draft changed. What you typed is kept and goes back in.",
  waitsKept:
    "Editing is paused until the changes are reviewed. What you typed is kept and goes in after.",
  stuckKept: "Couldn't add your text yet",
  frameOnly: "Couldn't add your text yet. Copy it before you reload",
  copy: "Copy",
  tooLong: "This block is too long to send. Split it into smaller blocks.",
  full: "The deck is at its size limit, so that change wasn't made.",
  fullHere: "The deck is at its size limit, so this text isn't in it. Shorten it to continue.",
  ask: "Ask an agent",
  readOnly: "This part can't be edited here. An agent can change it.",
  imageNote: "An agent adds or replaces the image.",
  delete: "Delete",
  notes: (n: number) => `Notes for slide ${n}`,
  addNotes: "Add speaker notes",
  empty: (n: number) => `Slide ${n}, empty`,
  dense: "Long slide: its text is shrunk to fit",
  settings: "Slide setup",
  apply: "Apply",
  cancel: "Cancel",
} as const;

/** What the editor needs of the live draft: the room's (LiveDocClient) or a local copy (solo). */
export interface DeckBackend extends LiveBackend {
  /** The draft's revision: a rebase's merged text comes with a higher one. */
  readonly rev: number;
  struct(op: SlidesStructOp): boolean;
}

/** The text only this frame edits (solo mode): every lease and op is granted and applied at once. */
export class LocalDeck implements DeckBackend {
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
  rev = 0;
  private n = 0;

  constructor(
    readonly baseText: string,
    private readonly events: {
      granted(l: ClientLease): void;
      changed(): void;
      structLanded(op: SlidesStructOp): void;
      error(code: "invalid" | "too_large"): void;
      /** The held lease ended under an op (a struct op that removed one of its lines). */
      lost(reason: LeaseLoss): void;
    },
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
    if (RULES?.checkEdit(this.lines, l.start, l.end - l.start, ins)) {
      this.events.error("invalid");
      return false;
    }
    const next = [...this.lines.slice(0, l.start), ...ins, ...this.lines.slice(l.end)];
    if (RULES?.tooLarge(joinLines(next))) {
      this.events.error("too_large");
      return false;
    }
    this.lines = next;
    this.rev++;
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

  struct(op: SlidesStructOp): boolean {
    const r = applySlidesStruct(this.lines, op);
    if (!r || RULES?.tooLarge(joinLines(r.lines))) {
      this.events.error("invalid");
      return false;
    }
    const before = this.lines.length;
    this.lines = r.lines;
    this.rev++;
    if (this.mine) {
      const moved = mapRange(this.mine, r.map, before, r.lines.length);
      this.mine = moved ? { ...this.mine, ...moved } : null;
      // The op removed one of its lines: the lease ends as a room's does when the draft closes
      // under it, so typing it held is written again or kept, never left on the page unleased.
      if (!moved) this.events.lost("closed");
    }
    this.events.structLanded(op);
    this.events.changed();
    return true;
  }
}

/** The editor's hooks into the frame. */
export interface DeckEditorHooks {
  save(): void;
  status(): void;
  /** Esc at the top level of edit mode: the app moves focus to its strip. */
  leave(): void;
  /** The version whose files the draft is drawn with (its base), or null for the page's own. */
  fileVersion(): number | null;
  /** Ask an agent about a place on a slide (the app's Ask dialog). */
  ask(anchor: { key: string; text: string }, what: AskWhat): void;
  /** Draw the deck again from the backend's lines (boot.ts), which then calls decorate. */
  redraw(): void;
  /** The raw slide shown, and showing another one. */
  current(): number;
  goto(n: number): void;
  /** Fit the slide shown again (its text changed). */
  refit(): void;
  /** The frame's polite live region. */
  announce(text: string): void;
  /** The rescue store changed: the app merges this into its copy (see DeckRescueReport). */
  rescue?(report: DeckRescueReport): void;
}

/**
 * A change to the deck's rescue store, for the app's copy in its own storage, which
 * only ever merges, as a doc's does (renderers/doc/edit.ts RescueReport): `upsert` adds or
 * updates items by id, `written` names items the room acknowledged, `gone` items dropped on
 * purpose (a discard). Each item says whether it was typed on a slide or in its speaker notes, so
 * after a reload it goes back into the same part, never notes onto a slide.
 */
export interface DeckRescueReport {
  upsert: RescueItem[];
  written: string[];
  gone: string[];
  n: number;
}

/** A rescue store item as the editor keeps it, and whether the app's copy holds it. */
interface DeckRescue extends RescueItem {
  /** The report that last sent it to the app, and whether the app's store has it (null: unknown). */
  reported: number | null;
  kept: boolean | null;
}

/** A place in the deck the editor holds open. */
interface Open {
  kind: "block" | "notes";
  /** The raw slide. */
  n: number;
  editors: RichBlockEditor[];
  /** What the editors sit in (a block: in the slide; notes: in the notes panel). */
  host: HTMLElement;
  ctx: DeckPartContext;
  env: MdEnv;
  /** An inserted block keeps a blank line before and after it where its neighbours need one. */
  pad: { before: boolean; after: boolean };
  form: NotesForm;
  /** The text last sent for the lease. */
  sent: string | null;
  /** Where its lease started when last seen: a block taken again is looked for nearest here. */
  start: number;
  /**
   * The lines just above and below its lease when last seen: an insert point (an empty lease) is
   * taken again where the same lines are around it.
   */
  around: { above: string | null; below: string | null };
  /**
   * Where the caret was last seen in it (which editor, and where), while it has the focus: a
   * slide drawn again around it takes the focus away, and it is put back there.
   */
  caret: { i: number; at: RichPoint } | null;
  focused: boolean;
  /** Opened to write typing kept from a lease that ended: a refusal keeps it, never puts back. */
  kept?: true;
  /** An edit was sent for it. */
  wrote?: true;
  /**
   * Its typing since the last edit sent was not sent (the deck was at its size limit, the block too
   * long, the socket down): the room does not hold it, whatever it acknowledged.
   */
  notSent?: true;
  /** The rescue store item for typing in it the room does not hold yet (kept, or stuck). */
  rescue?: string;
}

/**
 * What a place held when it closed or its lease ended: what was typed in it, and whether the room
 * may not have it yet, to write it again (lost) rather than lose it.
 */
interface Snap {
  kind: Open["kind"];
  n: number;
  ctx: DeckPartContext;
  env: MdEnv;
  pad: Open["pad"];
  form: NotesForm;
  models: RichBlock[];
  /** Its lines as typed, or null when they cannot be written as typed. */
  typed: string[] | null;
  /** In the debounce, not writable as typed, not sent (Open's `notSent`), or not acknowledged yet. */
  unsent: boolean;
  /** Its last typing was never sent (Open's `notSent`): no acknowledgement makes it written. */
  notSent?: true;
  sent: string | null;
  start: number;
  around: Open["around"];
  rescue?: string;
  /** It was opened to write typing kept from a lease that ended (Open's `kept`). */
  kept?: true;
}

/**
 * A place closed while its last edit had no acknowledgement (its release goes after it): kept
 * until the room answers the edit and then the release, so a lease that ends first (a dropped
 * socket, a takeover) writes it again. A split (Enter) closes its block this way at once, and
 * opens the text after the caret on its own lines once the room let the old lease go.
 */
interface Closing {
  lease: string;
  snap: Snap;
  /** The lease's lines as last seen. */
  start: number;
  end: number;
  split?: {
    /** How many lines the text after the caret takes (0: an insert point below). */
    tail: number;
    model: RichBlock;
  };
}

/** A lease asked for and not answered yet, with what to open once it is granted. */
interface Want {
  range: LineRange;
  /**
   * What the range held when asked for: its lines, and for an insert point the line before it and
   * the line at it (null at the deck's edges). The models open only on lines that still read so;
   * when the lines moved meanwhile, the place is looked for again by them.
   */
  mark: Mark;
  /**
   * Taken again after its lease ended: each text the room may hold of it (what was sent last, what
   * the room acked, what it last wrote to D1). The one found nearest where it was is asked for.
   */
  alts?: Mark[];
  /** How many times it was looked for again after the lines moved. */
  tries: number;
  open: Omit<Open, "host" | "editors" | "sent" | "start" | "around" | "caret" | "focused"> & {
    models: RichBlock[];
  };
  focus: "start" | "end";
  /** The block is emptied as soon as the lease is granted (an image's Delete). */
  emptyNow?: true;
  /** Its text starts selected, so typing replaces it (New's first title). */
  select?: true;
  /**
   * What was typed, to send once it is open (taken again after its lease ended, or kept from one
   * that cannot be taken again): never dropped. When its place cannot be had it goes in as a new
   * block nearby (`anew`); when nothing takes it, it is kept on the page with Copy (`park`).
   */
  resend?: true;
  /** How many new places the kept text was tried at (anew), RETAKE_TRIES at most. */
  fallbacks?: number;
  /** Speaker notes kept: added after the slide's notes as they are once nobody else holds them. */
  append?: true;
  /** The rescue store item it writes (see DeckRescueReport). */
  rescue?: string;
  /** Written and closed once granted, never left open (its place had closed, or a reload's). */
  closeAfter?: true;
  /** Its text as kept, when it could not be read back as blocks (a reload's): copied as it is. */
  raw?: string;
}

interface Mark {
  text: string;
  above: string | null;
  below: string | null;
}

/** A place asked for is looked for again at most this many times when its lines keep moving. */
const RETAKE_TRIES = 3;

/** What `range` of `lines` holds, to find it again (markAt) or check it is still there (markIs). */
function markOf(lines: readonly string[], range: LineRange): Mark {
  const text = joinLines(lines.slice(range.start, range.end));
  if (text !== "") return { text, above: null, below: null };
  return { text, above: lines[range.start - 1] ?? null, below: lines[range.start] ?? null };
}

function markIs(lines: readonly string[], range: LineRange, mark: Mark): boolean {
  const now = markOf(lines, range);
  return now.text === mark.text && now.above === mark.above && now.below === mark.below;
}

const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

/** `f`, worked out once, on first use. */
function memo<T>(f: () => T): () => T {
  let done: { v: T } | null = null;
  return () => {
    done ??= { v: f() };
    return done.v;
  };
}

/**
 * The lines where a top-level block, or a slide part, starts or ends: a block's text matches a
 * run of lines only where the run starts and ends at such a line (wholeBlockAt), so the text of a block
 * that lost its last lines is never found as the first lines of the longer block still there.
 */
function blockEdges(lines: readonly string[]): Set<number> {
  const edges = new Set<number>([0, lines.length]);
  for (const slide of deckLayout(lines).slides) {
    edges.add(slide.start);
    edges.add(slide.end);
    if (slide.notes) {
      edges.add(slide.notes.start);
      edges.add(slide.notes.end);
    }
    for (const part of [slide.head, ...slide.columns]) {
      edges.add(part.start);
      edges.add(part.end);
      const shown = deckPartShown(lines.slice(part.start, part.end), false).join("\n");
      for (const b of parseBlocks(shown)) {
        edges.add(part.start + b.start);
        edges.add(part.start + b.core.start);
        edges.add(part.start + b.core.end);
        edges.add(part.start + b.end);
      }
    }
  }
  return edges;
}

/**
 * Where the text `text` sits in `lines` as whole blocks (it starts and ends at a block's edge, or
 * at a blank line it holds itself), nearest to line `near`, or -1.
 */
function wholeBlockAt(
  lines: readonly string[],
  text: string,
  near: number,
  edges: () => Set<number>,
): number {
  const want = blockLines(text);
  let best = -1;
  for (let i = locateBlock(lines, text, 0); i >= 0 && i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k] !== want[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const end = i + want.length;
    const head = isBlank(want[0]) || isBlank(lines[i - 1]) || edges().has(i);
    const tail = isBlank(want.at(-1)) || isBlank(lines[end]) || edges().has(end);
    if (!head || !tail) continue;
    if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** Where the place `mark` describes starts in `lines`, nearest to line `near`, or -1. */
function markAt(
  lines: readonly string[],
  mark: Mark,
  near: number,
  edges: () => Set<number> = memo(() => blockEdges(lines)),
): number {
  if (mark.text !== "") return wholeBlockAt(lines, mark.text, near, edges);
  let best = -1;
  for (let p = 0; p <= lines.length; p++) {
    if ((lines[p - 1] ?? null) !== mark.above || (lines[p] ?? null) !== mark.below) continue;
    if (best < 0 || Math.abs(p - near) < Math.abs(best - near)) best = p;
  }
  return best;
}

const para = (): RichBlock => ({ t: "paragraph", c: [] });

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

/** Whether a model holds any text (an empty paragraph or heading has nothing to keep). */
function hasText(m: RichBlock, env: MdEnv): boolean {
  const md = verifyBlock(withoutMarks(m), TOOLS, env);
  return md === null || md.trim() !== "";
}

/** Whether a node is an element (frames have their own Element class, so no instanceof). */
const isEl = (n: Node): n is HTMLElement => n.nodeType === 1;
/** An empty slide's "Click to add a title". */
const PLACEHOLDER = ".plinth-slides__placeholder";

/** Whether lines of a block read back, as the deck hands them to Markdown, into `model`. */
function readsBack(lines: readonly string[], model: RichBlock, env: MdEnv, notes: boolean) {
  if (lines.length === 0) return true;
  const back = blockFromSource(deckPartShown(lines, notes).join("\n"), TOOLS.source, env);
  return back !== null && sameBlock(back, model);
}

/** A block's lines as the deck stores them, or null when the model cannot be written so. */
export function deckBlockLines(
  model: RichBlock,
  ctx: DeckPartContext,
  env: MdEnv,
): string[] | null {
  const md = verifyBlock(model, TOOLS, env);
  if (md === null) return null;
  if (md === "") return [];
  const lines = escapeDeckPart(md.split("\n"), ctx);
  return readsBack(lines, model, env, ctx.notes) ? lines : null;
}

/**
 * The model of a slide block if it can be edited in place (the fidelity check, and its deck form
 * reads back the same), else null. Images and dividers are never edited in place.
 */
export function editableDeckBlock(
  shown: string,
  env: MdEnv,
  ctx: DeckPartContext,
): RichBlock | null {
  const m = editableBlock(shown, TOOLS, env);
  if (!m || m.t === "image" || m.t === "divider" || m.t === "indented") return null;
  const lines = deckBlockLines(m, ctx, env);
  return lines && lines.length > 0 ? m : null;
}

/** The notes part's blocks as models, if every one can be edited in place, else null. */
export function editableNotes(
  text: string,
  form: NotesForm,
  settings: boolean,
): RichBlock[] | null {
  if (text.trim() === "") return [];
  const env = docEnv(text);
  const models: RichBlock[] = [];
  for (const b of parseBlocks(text)) {
    const shown = text.split("\n").slice(b.core.start, b.core.end).join("\n");
    const m = editableBlock(shown, TOOLS, env);
    if (!m || m.t === "image" || m.t === "divider" || m.t === "indented") return null;
    models.push(m);
  }
  // The notes as written back must read as the same notes.
  let lines: string[];
  try {
    lines = serializeNotes(models, form, settings);
  } catch {
    return null;
  }
  const again = notesText(lines);
  if (again.replace(/\s+/g, " ") === text.replace(/\s+/g, " ")) return models;
  const reread = parseBlocks(again).map((b) =>
    editableBlock(again.split("\n").slice(b.core.start, b.core.end).join("\n"), TOOLS, env),
  );
  const same =
    reread.length === models.length &&
    reread.every((m, i) => {
      const want = models[i];
      return m !== null && want !== undefined && sameBlock(m, want);
    });
  return same ? models : null;
}

/** Whether a raw slide is the one right after a bare opening `---` (setting-like lines escape). */
function afterBareOpen(lines: readonly string[], n: number): boolean {
  return n === 2 && isSeparatorLine(lines[0]) && frontMatterEnd(lines) === -1;
}

/** Models' text as Markdown without their marks, one block per paragraph ("" for none). */
function plainText(models: readonly RichBlock[], env: MdEnv): string {
  return models
    .map((m) => verifyBlock(withoutMarks(m), TOOLS, env))
    .filter((t): t is string => t !== null && t.trim() !== "")
    .join("\n\n");
}

/** A rescued text read back as blocks to write (a reload's), or null when one cannot be. */
function modelsOf(text: string): RichBlock[] | null {
  const env = docEnv(text);
  const all = text.split("\n");
  const out: RichBlock[] = [];
  for (const b of parseBlocks(text)) {
    const m = editableBlock(all.slice(b.core.start, b.core.end).join("\n"), TOOLS, env);
    if (!m || m.t === "image" || m.t === "divider" || m.t === "indented") return null;
    out.push(m);
  }
  return out.length > 0 ? out : null;
}

/** A raw slide's first line of text, to find the slide again after a reload (a rescue's ref). */
function slideRef(lines: readonly string[], slide: { start: number; end: number }): string {
  for (let i = slide.start; i < slide.end; i++) {
    const t = (lines[i] ?? "").trim();
    if (t !== "") return t.slice(0, MAX_RESCUE_REF);
  }
  return "";
}

const ATTR_EDIT = "data-plinth-edit";

export class SlidesEditor {
  editing = false;
  private open: Open | null = null;
  private want: Want | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The open block's text cannot be written as Markdown as typed: nothing is sent. */
  private stuck = false;
  /** A trim_start sent before emptying a block, waiting for its answer. */
  private trimming = false;
  /** The block being emptied is an image's Delete: it closes once its edit is sent. */
  private deleting = false;
  /** A place closed with its last edit not acknowledged yet (see Closing). */
  private closing: Closing | null = null;
  /** Typed text the draft does not hold yet, by id, mirrored in the app's store. */
  private readonly rescues = new Map<string, DeckRescue>();
  private reportN = 0;
  private rescueN = 0;
  /** Items the app kept from before a reload, written one at a time (nextKept). */
  private fromStore: Want[] = [];
  /** Items the app offered before the room's draft was here. */
  private offered: RescueItem[] = [];
  private views: EditSlideView[] = [];
  private layout: DeckLayout | null = null;
  /** The bar of a selected block that is not edited in place (Ask an agent, Delete). */
  private bar: HTMLElement | null = null;
  /** The selected block's elements while its bar shows (data-selected). */
  private barNodes: Element[] = [];
  private popover: HTMLElement | null = null;
  /** A settings op sent, waiting for its answer. */
  private settingsPending = false;
  private readonly decorated = new WeakSet<Element>();
  /** What each slide's notes panel was last drawn from (drawNotes). */
  private readonly notesDrawn = new WeakMap<EditSlideView, string>();
  /** How many raw slides the deck had when last drawn (decorate). */
  private rawCount: number | null = null;

  private fileBase(): number | null {
    return this.hooks.fileVersion();
  }

  constructor(
    private readonly win: Window,
    private backend: DeckBackend,
    private readonly hooks: DeckEditorHooks,
  ) {
    this.doc.addEventListener("selectionchange", this.onSelection);
  }

  get doc(): Document {
    return this.win.document;
  }

  /** Stops listening to the document (the frame's editing stops for good). */
  stop(): void {
    this.setEditing(false);
    this.doc.removeEventListener("selectionchange", this.onSelection);
  }

  setBackend(b: DeckBackend): void {
    this.backend = b;
  }

  /**
   * Text waits in the debounce, cannot be written as typed, or was typed in a place whose lease
   * ended and is not in the draft yet (asked for again, or kept on the page).
   */
  get pending(): boolean {
    return (
      this.timer !== null ||
      this.stuck ||
      this.trimming ||
      this.want?.resend === true ||
      this.retake?.want.resend === true ||
      this.parked.length > 0 ||
      this.toRetry.length > 0 ||
      this.fromStore.length > 0 ||
      this.offered.length > 0 ||
      this.rescues.size > 0 ||
      this.open?.notSent === true ||
      this.closing?.snap.unsent === true
    );
  }

  get unsavable(): boolean {
    return this.stuck;
  }

  /** Solo: the frame's own copy is the draft, with no room to take typing again later. */
  private get solo(): boolean {
    return this.backend instanceof LocalDeck;
  }

  /**
   * Typing on the page that the backend's text does not hold and that a flush cannot write: the
   * open place's when it cannot be written as typed or was not sent (the deck at its size limit),
   * and typing kept from a place that closed. In solo mode this is what the app hears as
   * `unsavable`: the frame's text is the whole draft, so nothing is published, Done keeps editing
   * on and the page asks before it is left, until it is written. The app's kept copy is that text,
   * which can be published; the typing is in the rescue store beside it (keepRescue).
   */
  get unwritten(): boolean {
    return (
      this.stuck ||
      this.open?.notSent === true ||
      this.closing?.snap.unsent === true ||
      this.keptWants().length > 0
    );
  }

  /** Typing kept from places that closed, not in the backend's text yet. */
  private keptWants(): Want[] {
    return [
      ...this.parked,
      ...this.toRetry,
      ...this.fromStore,
      ...(this.retake?.want.resend ? [this.retake.want] : []),
      ...(this.want?.resend ? [this.want] : []),
    ];
  }

  /** Typed text no place took yet: kept on the page with Copy, tried again after a reconnect. */
  private parked: Want[] = [];
  /** Parked texts to try again now (a reconnect), one at a time. */
  private toRetry: Want[] = [];
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** What the notice says while typing is kept on the page (with Copy), or null. */
  private keptWords: string | null = null;
  /** The last message, shown in the notice's place for NOTICE_MS (notify). */
  private message: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The one notice, floating over the stage (drawNotice). */
  private notice: HTMLElement | null = null;

  /**
   * Typing in the open place cannot be written as typed, or can again. While it cannot, nothing
   * is sent, so a room would see the lease as idle and let it be taken over after
   * LIMITS.liveLeaseIdleS: a connected holder says it is in use (`keep`) instead, until the text
   * can be written, the place closes or the socket goes.
   */
  private setStuck(on: boolean): void {
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

  /** The range of the block open in the editor (its lines are not part of its slide's key). */
  get held(): LineRange | null {
    return this.open?.kind === "block" ? this.backend.mine : null;
  }

  private get canWrite(): boolean {
    return this.backend.you?.right === "write" && this.backend.conflictVersion === null;
  }

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (!on) {
      this.flush();
      this.salvage();
      this.close(true);
      this.closeSettings();
      this.hideBar();
    }
    this.editing = on;
    if (!on) this.hideToast();
    this.hooks.redraw();
    if (on && this.solo && this.parked.length > 0) {
      // Alone there is no reconnect to try kept typing again: edit mode starting again does, so
      // it can be shortened in a block of its own.
      this.toRetry.push(...this.parked);
      this.parked = [];
      this.nextKept();
    }
    this.hooks.status();
  }

  // ---------- drawing ----------

  /**
   * Called by boot.ts after it drew the edit-mode slides: makes each block focusable and opens it
   * on a click, puts the open block's editor back in its place, and fills the notes panel.
   */
  decorate(views: EditSlideView[], layout: DeckLayout): void {
    this.views = views;
    this.layout = layout;
    const base = this.hooks.fileVersion();
    const mine = this.backend.mine;
    // Between resets only the line-0 step removes raw slides, each one an empty slide at the
    // deck's start: the slide open, or asked for, moves down by as many.
    const gone = this.rawCount === null ? 0 : this.rawCount - layout.slides.length;
    this.rawCount = layout.slides.length;
    if (gone > 0) {
      for (const o of [this.open, this.want?.open]) {
        if (!o) continue;
        o.n = Math.max(1, o.n - gone);
        o.ctx = { ...o.ctx, settings: afterBareOpen(this.backend.lines, o.n) };
      }
    }
    if (this.open && mine) {
      this.open.start = mine.start;
      this.open.around = this.aroundOf(mine);
    }
    for (const v of views) {
      pinFiles(v.frame, base);
      if (!this.decorated.has(v.frame)) {
        this.decorated.add(v.frame);
        this.wireSlide(v);
      }
      this.markHolders(v);
      if (v.empty && !(this.open?.kind === "block" && this.open.n === v.n)) this.placeholder(v);
      this.drawNotes(v);
    }
    const o = this.open;
    if (o?.kind === "block" && mine) {
      const v = views.find((x) => x.n === o.n);
      if (v && !v.frame.contains(o.host)) this.placeOpen(v, o, mine);
    }
    if (this.wantFirst && this.editing && !this.open && !this.want) {
      this.win.setTimeout(() => this.focusFirst(), 0);
    }
  }

  /** Marks the blocks other people hold, with their email. */
  private markHolders(v: EditSlideView): void {
    const others = [...this.backend.leases.values()].filter((l) => l.id !== this.backend.mine?.id);
    for (const p of v.parts) {
      for (const b of p.blocks) {
        const held = others.find((l) => l.start < b.end && b.start < l.end);
        for (const n of b.nodes) {
          if (!isEl(n)) continue;
          n.toggleAttribute("data-held", held !== undefined);
          if (held) n.dataset.heldBy = held.by;
          else delete n.dataset.heldBy;
        }
      }
    }
  }

  private wireSlide(v: EditSlideView): void {
    for (const p of v.parts) {
      for (const b of p.blocks) {
        const model = this.modelOf(b, v);
        const image = b.nodes.some((n) => isEl(n) && n.querySelector("img") !== null);
        const name = model
          ? kindName(model)
          : image
            ? "image"
            : (b.nodes[0] as Element | undefined)?.localName === "pre"
              ? "code block"
              : "block";
        for (const n of b.nodes) {
          if (!isEl(n)) continue;
          n.setAttribute(ATTR_EDIT, model ? "text" : "other");
          // Its tint and bar fit the image, not the paragraph around it (slides.css).
          n.toggleAttribute("data-plinth-image", !model && image);
          n.tabIndex = 0;
          n.setAttribute("role", "button");
          n.dataset.plinthControl = "";
          n.setAttribute(
            "aria-label",
            model
              ? `Slide ${v.n}, ${name}, editable`
              : image
                ? `Slide ${v.n}, image`
                : `Slide ${v.n}, ${name}, not editable here`,
          );
        }
      }
    }
    v.frame.addEventListener("click", (e) => this.onClick(e, v));
    v.frame.addEventListener("keydown", (e) => this.onKey(e, v));
  }

  private placeholder(v: EditSlideView): void {
    const head = v.parts[0]?.el;
    if (!head || head.querySelector(".plinth-slides__placeholder")) return;
    const b = el(this.doc, "button", "plinth-slides__placeholder", EDIT_VIEW_WORDS.placeholder);
    b.type = "button";
    b.dataset.plinthControl = "";
    b.setAttribute(ATTR_EDIT, "placeholder");
    b.setAttribute("aria-label", `${DECK_WORDS.empty(v.n)}. ${EDIT_VIEW_WORDS.placeholder}`);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      this.addTitle(v);
    });
    head.append(b);
    v.frame.querySelector(".plinth-slides__canvas")?.setAttribute("data-empty", "");
  }

  // ---------- notes ----------

  private notesRange(v: EditSlideView): LineRange | null {
    const notes = v.raw.notes;
    if (!notes) return null;
    let end = notes.end;
    while (end > notes.start + 1 && (this.backend.lines[end - 1] ?? "").trim() === "") end--;
    return { start: notes.start, end };
  }

  private drawNotes(v: EditSlideView): void {
    const host = v.notesHost;
    const o = this.open;
    const panel = el(this.doc, "section", "plinth-slides__notepad");
    if (o?.kind === "notes" && o.n === v.n) {
      this.notesDrawn.delete(v);
      if (host.contains(o.host)) return;
      panel.setAttribute("aria-label", DECK_WORDS.notes(v.shownN ?? v.n));
      panel.dataset.plinthControl = "";
      panel.dataset.open = "";
      panel.append(o.host);
      host.replaceChildren(panel);
      this.refocus(o);
      return;
    }
    const range = this.notesRange(v);
    // Drawn again only when the notes, or what is held, changed: reading notes back is not free,
    // and every edit anywhere in the deck draws the deck again.
    const key = JSON.stringify([
      v.shownN,
      range ? this.backend.lines.slice(range.start, range.end) : null,
      this.fileBase(),
    ]);
    if (this.notesDrawn.get(v) === key && host.firstChild) return;
    this.notesDrawn.set(v, key);
    panel.setAttribute("aria-label", DECK_WORDS.notes(v.shownN ?? v.n));
    panel.dataset.plinthControl = "";
    const lines = range ? this.backend.lines.slice(range.start, range.end) : [];
    const text = range ? notesText(lines) : "";
    const models = range
      ? editableNotes(text, notesFormOf(lines[0]), afterBareOpen(this.backend.lines, v.n))
      : [];
    if (text === "" && models) {
      // No notes, or empty ones: the panel is one quiet "Add speaker notes", as an empty notes
      // field reads. An empty field is no notes: leaving it empty removes them (tidyNotes).
      const add = el(this.doc, "button", "plinth-slides__notepad-add", DECK_WORDS.addNotes);
      add.type = "button";
      add.addEventListener("click", () => (range ? this.openNotes(v, []) : this.addNotes(v)));
      panel.append(add);
      host.replaceChildren(panel);
      return;
    }
    const body = el(this.doc, "div", "plinth-slides__notepad-body");
    const frag = sanitizeHtml(renderInlineFree(text), this.doc);
    pinFiles(frag, this.hooks.fileVersion());
    body.append(frag);
    if (models) {
      body.tabIndex = 0;
      body.setAttribute("role", "button");
      body.setAttribute("aria-label", `${DECK_WORDS.notes(v.shownN ?? v.n)}, editable`);
      const open = () => this.openNotes(v, models);
      body.addEventListener("click", (e) => {
        if ((e.target as Element | null)?.closest?.("a")) e.preventDefault();
        open();
      });
      body.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      panel.append(body);
    } else {
      panel.append(
        body,
        this.askButton(DECK_WORDS.readOnly, () => this.ask(v, "notes", "block")),
      );
    }
    host.replaceChildren(panel);
  }

  private addNotes(v: EditSlideView): void {
    if (!this.writable() || !this.closeForStruct()) return;
    const n = v.n;
    const count = deckLayout(this.backend.lines).slides.length;
    this.afterStruct = (op) => {
      if (op.op !== "add_notes") return;
      // The op's line-0 step may have removed empty slides at the deck's start, each of which
      // moves this one down.
      const at = n - Math.max(0, count - deckLayout(this.backend.lines).slides.length);
      const view = this.views.find((x) => x.n === at);
      if (view) this.openNotes(view, []);
    };
    if (!this.backend.struct({ op: "add_notes", n })) {
      this.afterStruct = null;
      this.notify(DECK_WORDS.notConnected);
    }
  }

  /** The raw slide whose notes were left empty: removed once nothing of this editor's is on its way. */
  private emptyNotes: number | null = null;
  /** That removal is out: its answer says nothing to the person, whatever it is. */
  private tidying = false;

  /**
   * Notes left empty are no notes: once their last edit is in and their lease is let go, the empty
   * notes part goes (`remove_notes`), so the deck keeps no bare marker. Quiet: refused (someone
   * holds a line next to it, the lines moved), the empty notes simply stay, drawn as none.
   */
  private tidyNotes(): void {
    const n = this.emptyNotes;
    const b = this.backend;
    if (n === null || !this.editing) return;
    if (this.open || this.want || this.closing || b.mine || this.timer !== null) return;
    if (!b.ready || !b.settled || this.tidying || this.trimming || this.settingsPending) return;
    if (this.afterStruct || this.deleting) return;
    this.emptyNotes = null;
    const raw = deckLayout(b.lines).slides.find((s) => s.n === n);
    if (!raw?.notes || notesText(b.lines.slice(raw.notes.start, raw.notes.end)) !== "") return;
    this.tidying = true;
    if (!b.struct({ op: "remove_notes", n })) this.tidying = false;
  }

  /**
   * Whether a place stays open that close() could not close (its typing cannot be written as
   * typed, or alone the deck is at its size limit), saying why. Nothing that would take its lines
   * or its lease from under it goes out meanwhile: a new lease, or a struct op (which ends the
   * sender's own lease where it touches it, leaving the typing on the page with no lease to write
   * it).
   */
  private heldOpen(): boolean {
    const o = this.open;
    if (!o) return false;
    if (this.stuck) this.notify(DECK_WORDS.unsavable);
    else if (o.notSent) this.notify(DECK_WORDS.fullHere);
    return true;
  }

  /** Closes the open place before a struct op; false (and nothing goes out) when it stays open. */
  private closeForStruct(): boolean {
    this.close(true);
    return !this.heldOpen();
  }

  /** Run once this editor's own struct op landed. */
  private afterStruct: ((op: SlidesStructOp) => void) | null = null;

  private openNotes(v: EditSlideView, models: RichBlock[]): void {
    if (!this.writable()) return;
    // A block open elsewhere closes first, sending what waits (request refuses while it stays open).
    this.close(true);
    const view = this.views.find((x) => x.n === v.n) ?? v;
    const range = this.notesRange(view);
    if (!range) return;
    const lines = this.backend.lines.slice(range.start, range.end);
    this.request({
      range,
      focus: "end",
      open: {
        kind: "notes",
        n: v.n,
        ctx: { notes: true, settings: afterBareOpen(this.backend.lines, v.n) },
        env: docEnv(notesText(lines)),
        pad: { before: false, after: false },
        form: notesFormOf(lines[0]),
        models: models.length > 0 ? models : [para()],
      },
    });
  }

  // ---------- opening a block ----------

  private ctxOf(v: EditSlideView): DeckPartContext {
    return { notes: false, settings: afterBareOpen(this.backend.lines, v.n) };
  }

  private modelOf(b: EditBlock, v: EditSlideView): RichBlock | null {
    return editableDeckBlock(b.shown, docEnv(b.part.shown), this.ctxOf(v));
  }

  private onClick(e: MouseEvent, v: EditSlideView): void {
    if (!this.editing || e.defaultPrevented) return;
    const t = e.target as Element | null;
    if (t?.closest?.(".plinth-rich, .plinth-slides__notepad, .plinth-slides__blockbar")) return;
    const b = blockAt(t, v.frame);
    if (!b) {
      // An empty slide is one tap target: anywhere on it starts its title, as its placeholder does.
      if (v.empty && t?.closest?.(".plinth-slides__canvas") && v.el.querySelector(PLACEHOLDER)) {
        e.preventDefault();
        this.addTitle(v);
      }
      return;
    }
    e.preventDefault();
    this.activate(b, v);
  }

  private onKey(e: KeyboardEvent, v: EditSlideView): void {
    if (!this.editing || e.defaultPrevented) return;
    const t = e.target as Element | null;
    if (t?.closest?.(".plinth-rich, .plinth-slides__notepad, .plinth-slides__blockbar")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.hideBar();
      this.hooks.leave();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const b = blockAt(t, v.frame);
    if (!b) return;
    e.preventDefault();
    this.activate(b, v);
  }

  private activate(b: EditBlock, v: EditSlideView, select = false): void {
    this.hideBar();
    const model = this.modelOf(b, v);
    if (!model) {
      this.showBar(b, v);
      return;
    }
    if (!this.writable()) return;
    this.close(true);
    this.request({
      range: { start: b.start, end: b.end },
      focus: "end",
      ...(select ? { select: true as const } : {}),
      open: {
        kind: "block",
        n: v.n,
        ctx: this.ctxOf(v),
        env: docEnv(b.part.shown),
        pad: { before: false, after: false },
        form: notesFormOf(undefined),
        models: [model],
      },
    });
  }

  /** "Click to add a title" on an empty slide: an insert point at its first line. */
  private addTitle(v: EditSlideView): void {
    if (!this.writable()) return;
    this.close(true);
    const at = v.raw.head.start;
    this.request({
      range: { start: at, end: at },
      focus: "start",
      open: {
        kind: "block",
        n: v.n,
        ctx: this.ctxOf(v),
        env: {},
        pad: this.padAt(at),
        form: notesFormOf(undefined),
        models: [{ t: "heading", level: v.n === 1 ? 1 : 2, setext: false, c: [] }],
      },
    });
  }

  /** Whether lines inserted at `at` need a blank line before or after to stay their own block. */
  private padAt(at: number): { before: boolean; after: boolean } {
    const kinds = this.layout?.kinds ?? deckLayout(this.backend.lines).kinds;
    const text = (i: number) => kinds[i] === "text" && (this.backend.lines[i] ?? "").trim() !== "";
    return { before: at > 0 && text(at - 1), after: text(at) };
  }

  private writable(): boolean {
    if (!this.editing) return false;
    if (!this.canWrite) return false;
    if (!this.backend.connected) {
      this.notify(DECK_WORDS.notConnected);
      return false;
    }
    return true;
  }

  private request(ask: Omit<Want, "mark" | "tries">): void {
    if (this.want) return;
    // The place open could not close (its typing cannot be written as typed, or alone the deck is
    // at its size limit): a new lease would take its place from under it.
    if (this.heldOpen()) return;
    const w: Want = { ...ask, mark: markOf(this.backend.lines, ask.range), tries: 0 };
    this.want = w;
    if (!this.backend.lease(w.range)) {
      this.want = null;
      this.notify(DECK_WORDS.notConnected);
    }
  }

  granted(lease: ClientLease): void {
    const w = this.want;
    this.want = null;
    if (!w || (!this.editing && !w.resend)) {
      this.backend.release();
      return;
    }
    if (!markIs(this.backend.lines, lease, w.mark)) {
      // The lines granted are not the place asked for (they moved meanwhile): nothing opens on
      // them. The place is looked for again once the lease is released.
      this.backend.release();
      this.again(w);
      return;
    }
    const doc = this.doc;
    const host = el(
      doc,
      "div",
      w.open.kind === "notes" ? "plinth-slides__notepad-edit" : "plinth-slides__open",
    );
    host.dataset.plinthControl = "";
    const o: Open = {
      caret: null,
      focused: false,
      ...w.open,
      host,
      editors: [],
      sent: joinLines(this.backend.lines.slice(lease.start, lease.end)),
      start: lease.start,
      around: this.aroundOf(lease),
      ...(w.resend ? { kept: true as const } : {}),
      ...(w.rescue ? { rescue: w.rescue } : {}),
    };
    for (const m of w.open.models) o.editors.push(this.makeEditor(o, m));
    host.append(...o.editors.map((r) => r.el));
    host.addEventListener("focusin", () => {
      o.focused = true;
    });
    host.addEventListener("focusout", (e) => this.onFocusOut(e));
    this.open = o;
    this.setStuck(false);
    if (!this.editing || w.closeAfter || (o.kind === "block" && o.editors.length > 1)) {
      // Edit mode ended while typing kept from a lease that ended was asked for, the place it was
      // typed in had closed (or it came back after a reload), or it is more than one block (the
      // two halves of a split): it is written as it is (without its marks when it cannot be
      // written with them), and nothing opens.
      this.writeKept(o);
      return;
    }
    if (w.emptyNow) {
      o.sent = null;
      this.send();
      // An emptying that first trims the deck sends its edit once the trim lands.
      if (this.trimming) this.deleting = true;
      else this.close(true);
      return;
    }
    this.hooks.redraw();
    const first = o.editors[w.focus === "start" ? 0 : o.editors.length - 1];
    first?.focus(w.focus);
    if (w.select) first?.selectText();
    if (w.resend) this.schedule();
    this.hooks.status();
  }

  /** The lines just above and below a range of the backend's lines. */
  private aroundOf(range: LineRange): Open["around"] {
    const lines = this.backend.lines;
    return { above: lines[range.start - 1] ?? null, below: lines[range.end] ?? null };
  }

  private makeEditor(o: Open, model: RichBlock): RichBlockEditor {
    const label = o.kind === "notes" ? DECK_WORDS.notes(o.n) : `Slide ${o.n}, ${kindName(model)}`;
    const holder: { rich: RichBlockEditor | null } = { rich: null };
    const host: RichHost = {
      atom: (md) => {
        const frag = sanitizeHtml(renderInlineMarkdown(md, o.env), this.doc);
        pinFiles(frag, this.hooks.fileVersion());
        return Array.from(frag.childNodes);
      },
      changed: () => this.edited(),
      split: (keep, next) => this.split(holder.rich as RichBlockEditor, keep, next),
      tab: (back) => this.tabOut(holder.rich as RichBlockEditor, back),
      escape: () => this.close(true, true),
      announce: (text) => (text ? this.notify(text) : undefined),
      verify: (b) => {
        const lines = deckBlockLines(b, o.ctx, o.env);
        return lines === null ? null : lines.join("\n");
      },
      isSafeHref,
      normalizeHref,
      scale: () => this.scale(),
    };
    const rich = new RichBlockEditor(this.doc, host, model, { label });
    holder.rich = rich;
    return rich;
  }

  /** The slide's scale on screen (the editors place their floating bars by it). */
  private scale(): number {
    const s = Number.parseFloat(
      this.win
        .getComputedStyle(
          this.doc.documentElement.querySelector(".plinth-slides") ?? this.doc.documentElement,
        )
        .getPropertyValue("--s"),
    );
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  /** Puts the open block's editor where its block is in a freshly drawn slide. */
  private placeOpen(v: EditSlideView, o: Open, mine: LineRange): void {
    for (const p of v.parts) {
      if (mine.start < p.range.start || mine.start > p.range.end) continue;
      const covered = p.blocks.filter((b) => b.start < mine.end && mine.start < b.end);
      for (const b of covered) for (const n of b.nodes) n.parentNode?.removeChild(n);
      const after = p.blocks.find((b) => b.start >= mine.end && !covered.includes(b));
      const before = after?.nodes[0] ?? null;
      p.el.querySelector(".plinth-slides__placeholder")?.remove();
      p.el.insertBefore(o.host, before && before.parentNode === p.el ? before : null);
      break;
    }
    this.refocus(o);
  }

  /** Gives the open place the focus back where its caret was, when it had the focus. */
  private refocus(o: Open): void {
    if (!o.focused || o.host.contains(this.doc.activeElement)) return;
    const c = o.caret;
    const kept = c ? o.editors[c.i] : undefined;
    if (kept && c) kept.focus(c.at);
    else o.editors[0]?.focus("end");
  }

  /** Notes where the caret is in the open place (the document's selectionchange). */
  private readonly onSelection = () => {
    const o = this.open;
    if (!o?.host.contains(this.doc.activeElement)) return;
    o.editors.forEach((r, i) => {
      if (!r.el.contains(this.doc.activeElement)) return;
      const s = r.selection();
      if (s) o.caret = { i, at: s.from };
    });
  };

  // ---------- typing ----------

  private edited(): void {
    // Typing that cannot be written stays unsavable until a send can write it (send()).
    this.schedule();
    this.hooks.refit();
    this.hooks.status();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
      this.hooks.status();
    }, EDIT_DEBOUNCE_MS);
  }

  /**
   * The lines the open place is sent as now, or null when it cannot be written as typed. A block
   * split by Enter is sent as `blocks`: the text before the caret and the text after it, as two
   * blocks of the same lease (an empty one is left out).
   */
  private linesNow(o: Open, blocks?: RichBlock[], plain = false): string[] | null {
    const strip = (m: RichBlock) => (plain ? withoutMarks(m) : m);
    if (o.kind === "notes") {
      const models = o.editors.map((r) => strip(r.model));
      for (const m of models) if (verifyBlock(m, TOOLS, o.env) === null) return null;
      try {
        return serializeNotes(models, o.form, o.ctx.settings);
      } catch {
        return null;
      }
    }
    // One editor, or more for typing kept as more than one block (a split's two halves).
    const models = blocks ?? o.editors.map((r) => r.model);
    if (models.length === 0) return null;
    const lines: string[] = [];
    for (const m of models) {
      const part = deckBlockLines(strip(m), o.ctx, o.env);
      if (part === null) return null;
      if (part.length === 0) continue;
      if (lines.length > 0) lines.push("");
      lines.push(...part);
    }
    if (lines.length === 0) return lines;
    return [...(o.pad.before ? [""] : []), ...lines, ...(o.pad.after ? [""] : [])];
  }

  /** Sends the open place's text (or `blocks`, a split: linesNow). False when it was not sent. */
  private send(blocks?: RichBlock[]): boolean {
    const o = this.open;
    const mine = this.backend.mine;
    if (!o || !mine || this.trimming) return false;
    const lines = this.linesNow(o, blocks);
    if (lines === null) {
      // Never dropped: the text stays in the place as typed, which stays open and pending
      // (close() keeps it), and nothing is published until it changes. Its text without its marks
      // goes into the rescue store, which a reload offers back.
      this.setStuck(true);
      o.rescue = this.keepRescue(
        o.rescue,
        o.editors.map((r) => r.model),
        o,
        mine.start,
      );
      this.notify(DECK_WORDS.unsavable);
      this.hooks.status();
      return false;
    }
    if (this.stuck) {
      this.setStuck(false);
      this.hooks.status();
    }
    const del = mine.end - mine.start;
    let ins = lines;
    if (ins.length === 0) {
      // Emptied: zero lines, one blank line, or first the bare opening `---` away.
      const plan = deckEmptying(this.backend.lines, mine.start, del);
      if (plan === "trim") return this.trim();
      if (plan === null) return this.refusedHere(DECK_WORDS.refused);
      ins = plan.ins;
    }
    if (RULES?.checkEdit(this.backend.lines, mine.start, del, ins)) {
      // A bare opening `---` can turn what follows it into settings: trim it, then send.
      if (isSeparatorLine(this.backend.lines[0]) && frontMatterEnd(this.backend.lines) === -1) {
        return this.trim();
      }
      return this.refusedHere(DECK_WORDS.refused);
    }
    const text = ins.join("\n");
    if (text === o.sent) {
      delete o.notSent;
      return true;
    }
    // The room's frame limit; alone, only the deck's size limit counts.
    if (!this.solo && new TextEncoder().encode(text).byteLength > LIMITS.liveDocFrameBytes - 512) {
      return this.notSentHere(o, mine.start, DECK_WORDS.tooLong);
    }
    // Checked here first, as the doc editor does: a deck at its size limit keeps the typing.
    const all = this.backend.lines;
    if (RULES?.tooLarge(joinLines([...all.slice(0, mine.start), ...ins, ...all.slice(mine.end)]))) {
      return this.notSentHere(o, mine.start, DECK_WORDS.full);
    }
    if (!this.backend.edit(text)) {
      return this.notSentHere(o, mine.start, DECK_WORDS.notConnected);
    }
    o.sent = text;
    o.wrote = true;
    delete o.notSent;
    if (o.rescue && this.solo) {
      // Alone the edit is in the draft at once: the app keeps its copy, then lets the item go.
      this.dropRescue(o.rescue);
      delete o.rescue;
    } else if (o.rescue) {
      // Kept typing on its way: the store keeps what was sent until the room acknowledges it.
      o.rescue = this.keepRescue(o.rescue, blocks ?? o.editors.map((r) => r.model), o);
    }
    return true;
  }

  /**
   * Typing this frame would not send as it stands (the deck at its size limit, the block too long,
   * the socket down): it stays in the place as typed and counts as unsent until an edit of it is
   * sent, so closing the place or losing its lease writes it again rather than drops it (Snap's
   * `notSent`). A room's copy goes into the rescue store too, which a reload offers back.
   */
  private notSentHere(o: Open, at: number, reason: string): false {
    o.notSent = true;
    o.rescue = this.keepRescue(
      o.rescue,
      o.editors.map((r) => r.model),
      o,
      at,
    );
    this.notify(reason);
    this.hooks.status();
    return false;
  }

  private trim(): boolean {
    // Set first: a local deck answers before struct() returns.
    this.trimming = true;
    if (!this.backend.struct({ op: "trim_start" })) {
      this.trimming = false;
      this.notify(DECK_WORDS.notConnected);
      return false;
    }
    return true;
  }

  /**
   * A change this editor would not send: the block goes back to the room's lines. Typing kept from
   * a lease that ended is never put back: it is kept on the page instead (park).
   */
  private refusedHere(reason: string): boolean {
    if (this.open?.kept) {
      this.parkOpen();
      return false;
    }
    this.putBack();
    this.notify(reason);
    return false;
  }

  /** Draws the open place again from the room's lines (its lease is kept). */
  private putBack(): void {
    const o = this.open;
    const mine = this.backend.mine;
    if (!o || !mine) return;
    const lines = this.backend.lines.slice(mine.start, mine.end);
    o.sent = joinLines(lines);
    delete o.notSent;
    if (o.kind === "notes") {
      const text = notesText(lines);
      const models = editableNotes(text, o.form, o.ctx.settings) ?? [];
      const editors = (models.length > 0 ? models : [para()]).map((m) => this.makeEditor(o, m));
      for (const r of o.editors) r.destroy();
      o.editors = editors;
      o.host.replaceChildren(...editors.map((r) => r.el));
      editors.at(-1)?.focus("end");
      return;
    }
    const shown = deckPartShown(lines, false).join("\n").trim();
    const model = shown === "" ? null : editableBlock(shown, TOOLS, o.env);
    o.editors[0]?.setModel(model ?? para());
  }

  private split(rich: RichBlockEditor, keep: RichBlock, next: RichBlock | null): void {
    const o = this.open;
    if (!o) return;
    if (o.kind === "notes") {
      // Notes are one lease: a new paragraph is one more editor in it.
      rich.setModel(keep);
      const i = o.editors.indexOf(rich);
      const added = this.makeEditor(o, next ?? para());
      o.editors.splice(i + 1, 0, added);
      rich.el.after(added.el);
      added.focus("start");
      this.edited();
      return;
    }
    // The text after the caret is sent in the same edit as the text before it, so it is in the
    // deck at once, whatever happens to the lease asked for next. Then the block closes at once,
    // as a doc's does: its lease is let go and its editor is gone, so nothing typed from here on
    // (a key, a second Enter) can send the text before the caret alone over both. What it sent is
    // kept until the room answers (Closing): a lease that ends first writes both halves again.
    // Once the room let the lease go, the text after the caret opens on its own lines; with
    // nothing after the caret, the new block is an insert point below.
    const tail = next ? deckBlockLines(next, o.ctx, o.env) : [];
    const blocks = tail && tail.length > 0 && next ? [keep, next] : [keep];
    if (tail === null || this.linesNow(o, blocks) === null) {
      // Nothing changes: the block stays as typed.
      this.notify(DECK_WORDS.unsavable);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Not sent: the block stays as it was (or as the room has it, after a refusal).
    if (!this.send(blocks)) return;
    const mine = this.backend.mine;
    if (!mine || this.open !== o) return;
    const snap = this.snapOf(o, blocks);
    this.discardOpen();
    this.closing = {
      lease: mine.id,
      snap,
      start: mine.start,
      end: mine.end,
      split: { tail: tail.length, model: next ?? para() },
    };
    this.hooks.redraw();
    // A local deck lets go at once, and the next block opens before this returns (changed).
    this.backend.release();
    this.hooks.status();
  }

  /** What the open place holds now (or `blocks` in it, a split's), to keep it (Snap). */
  private snapOf(o: Open, blocks?: RichBlock[]): Snap {
    const b = this.backend;
    const mine = b.mine;
    const { kind, n, ctx, env, pad, form } = o;
    return {
      kind,
      n,
      ctx,
      env,
      pad,
      form,
      models: blocks ?? o.editors.map((r) => r.model),
      typed: this.linesNow(o, blocks),
      unsent:
        this.timer !== null ||
        this.stuck ||
        o.notSent === true ||
        (o.wrote === true && b.ackedText !== o.sent),
      ...(o.notSent ? { notSent: true as const } : {}),
      sent: o.sent,
      start: mine?.start ?? o.start,
      around: mine ? this.aroundOf(mine) : o.around,
      ...(o.rescue ? { rescue: o.rescue } : {}),
      ...(o.kept ? { kept: true as const } : {}),
    };
  }

  /** A split's second block, once the room let the first one's lease go: on its own lines. */
  private openTail(c: Closing): void {
    const sp = c.split;
    if (!sp || !this.editing || this.open || this.want || this.backend.mine) return;
    const end = c.end - (sp.tail > 0 && c.snap.pad.after ? 1 : 0);
    const range = sp.tail > 0 ? { start: end - sp.tail, end } : { start: c.end, end: c.end };
    this.request({
      range,
      focus: "start",
      open: {
        kind: "block",
        n: c.snap.n,
        ctx: c.snap.ctx,
        env: c.snap.env,
        pad: sp.tail > 0 ? { before: false, after: false } : this.padAt(range.start),
        form: notesFormOf(undefined),
        models: [sp.model],
      },
    });
  }

  private tabOut(rich: RichBlockEditor, back: boolean): void {
    const o = this.open;
    if (!o) return;
    if (o.kind === "notes") {
      const i = o.editors.indexOf(rich) + (back ? -1 : 1);
      const to = o.editors[i];
      if (to) {
        to.focus(back ? "end" : "start");
        return;
      }
    }
    const n = o.n;
    const anchor = o.host;
    const items = this.focusables(n);
    const at = items.indexOf(anchor);
    this.close(true);
    const list = this.focusables(n);
    const next = Math.max(at, 0) + (back ? -1 : 1);
    const target = list[next] ?? (back ? list[0] : list.at(-1));
    target?.focus();
  }

  /** The focusable editing places of raw slide n, in reading order. */
  private focusables(n: number): HTMLElement[] {
    const v = this.views.find((x) => x.n === n);
    if (!v) return [];
    return Array.from(
      v.frame.querySelectorAll<HTMLElement>(
        `[${ATTR_EDIT}], .plinth-slides__open, .plinth-slides__notepad-body[tabindex], .plinth-slides__notepad-add`,
      ),
    );
  }

  private onFocusOut(e: FocusEvent): void {
    const o = this.open;
    if (!o) return;
    const to = e.relatedTarget as Node | null;
    if (to && o.host.contains(to)) return;
    // Focus that left the frame (to the app's strip or another window) keeps the block open.
    if (to === null) return;
    o.focused = false;
    this.win.setTimeout(() => {
      if (this.open === o && !o.host.contains(this.doc.activeElement)) this.close(true);
    }, 0);
  }

  /** Sends what waits, now (Publish, Done). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.send();
    }
  }

  /** Closes the open place: sends what waits, and releases its lease when `release`. */
  close(release: boolean, refocus = false): void {
    const o = this.open;
    if (!o) return;
    this.flush();
    if (this.stuck) {
      // The text cannot be written as typed: it stays open so it is not lost.
      return;
    }
    if (this.solo && o.notSent) {
      // Alone, nothing makes room in the deck meanwhile: the block stays open, as typed, until
      // it is shortened.
      this.notify(DECK_WORDS.fullHere);
      this.hooks.status();
      return;
    }
    const mine = this.backend.mine;
    const snap = this.snapOf(o);
    this.open = null;
    // Notes left empty are no notes: removed once this close is in (tidyNotes).
    if (o.kind === "notes" && !o.editors.some((r) => hasText(r.model, o.env))) {
      this.emptyNotes = o.n;
    }
    for (const r of o.editors) r.destroy();
    if (snap.rescue && !snap.unsent) this.dropRescue(snap.rescue);
    if (release && mine) {
      // Its last edit has no answer yet, or its typing was never sent (the deck was full): kept
      // until the room's answer, which comes before the release's (Closing), so a lease that ends
      // first, or a release with nothing taken, writes it again.
      if (snap.unsent) this.closing = { lease: mine.id, snap, start: mine.start, end: mine.end };
      this.backend.release();
    }
    const n = o.n;
    this.hooks.redraw();
    if (refocus) this.focusables(n)[0]?.focus();
    this.hooks.status();
    this.tidyLater();
  }

  /** Removes notes left empty once this turn is over (tidyNotes), never from inside an answer. */
  private tidyLater(): void {
    if (this.emptyNotes !== null) this.win.setTimeout(() => this.tidyNotes(), 0);
  }

  // ---------- the room's answers ----------

  changed(): void {
    const b = this.backend;
    if (this.offered.length > 0 && b.ready && b.settled) {
      const items = this.offered;
      this.offered = [];
      this.offerRescue(items);
    }
    // Kept typing the room acknowledged is in the draft: the place is an ordinary one again, and
    // its rescue item is written.
    const o = this.open;
    if (o?.wrote && this.timer === null && !this.stuck && !o.notSent && b.ackedText === o.sent) {
      if (o.kept) delete o.kept;
      if (o.rescue) {
        this.dropRescue(o.rescue);
        delete o.rescue;
      }
    }
    const c = this.closing;
    if (c && b.mine?.id === c.lease) {
      // A closed place's lease moves with each op (its own edit's answer among them).
      c.start = b.mine.start;
      c.end = b.mine.end;
      // Typing never sent stays unsent, whatever the room acknowledged of what was sent before it.
      if (c.snap.unsent && !c.snap.notSent && b.ackedText === c.snap.sent) c.snap.unsent = false;
      if (!c.snap.unsent && c.snap.rescue) {
        this.dropRescue(c.snap.rescue);
        delete c.snap.rescue;
      }
    } else if (c) {
      // The room let it go, which it answers after the edit sent before the release.
      this.closing = null;
      if (c.snap.unsent) {
        // With no answer to that edit first, the room did not take it (too large, too fast): what
        // the place sent is not in the draft, and its lease held the old lines. Neither taken as
        // written nor opened on those lines (a split's tail would edit the old block).
        this.unanswered(c.snap);
      } else {
        // What the place sent is in the draft.
        if (c.snap.rescue) this.dropRescue(c.snap.rescue);
        this.openTail(c);
      }
    }
    if (!this.retake) this.nextKept();
    if (this.retake) this.tryRetake();
    this.tidyLater();
  }

  /**
   * A closed place (or one split by Enter) whose lease the room let go without taking its last
   * edit, which it refused (the deck was full, the typing came too fast; the notice said so) or
   * this frame never sent (the deck at its size limit, the block too long, the socket down). The
   * typing is kept in the store and written again in its place, both halves of a split at once,
   * and the place closes again, since the person had left it; refused a second time, or when the
   * deck cannot take it now, it is kept on the page with Copy and tried again after a reconnect.
   */
  private unanswered(s: Snap): void {
    const models = s.typed === null ? s.models.map(withoutMarks) : s.models;
    const { kind, n, ctx, env, pad, form } = s;
    const rescue = this.keepRescue(s.rescue, models, s, s.start);
    const open = { kind, n, ctx, env, pad, form, models };
    const extra = { closeAfter: true as const, ...(rescue ? { rescue } : {}) };
    if (s.kept) {
      // Already typing written again: kept to copy rather than sent over and over.
      this.park({
        range: { start: s.start, end: s.start },
        mark: markOf(this.backend.lines, { start: s.start, end: s.start }),
        tries: 0,
        focus: "end",
        open,
        resend: true,
        ...extra,
      });
      this.hooks.redraw();
      return;
    }
    if (!models.some((m) => hasText(m, env))) {
      // An emptying the room did not take: the block is still there, nothing typed is lost.
      if (rescue) this.dropRescue(rescue, "gone");
      return;
    }
    // What the room holds of the block: its last acknowledged text (the text at the grant when
    // none was), or else what was sent.
    const held = this.backend.ackedText ?? s.sent ?? "";
    const mark = (text: string): Mark =>
      text === "" ? { text, ...s.around } : { text, above: null, below: null };
    const alts = [held, ...(s.sent !== null && s.sent !== held ? [s.sent] : [])].map(mark);
    if (this.retake?.want.resend) this.fromStore.push(this.retake.want);
    this.retake = {
      near: s.start,
      after: null,
      want: {
        range: { start: s.start, end: s.start + blockLines(held).length },
        mark: mark(held),
        alts,
        tries: 0,
        focus: "end",
        open,
        resend: true,
        ...extra,
      },
    };
  }

  /** The room's status changed (a review froze or ended): kept typing that waited goes in. */
  roomStatus(): void {
    if (this.retake) this.tryRetake();
  }

  denied(reason: LeaseDenial, by?: string): void {
    const w = this.want;
    this.want = null;
    if (!w) return;
    if (w.resend) {
      // Typing kept from a lease that ended is never dropped with the answer: the lines moved, so
      // it is looked for again; someone else holds its place, so it goes in as a new block next to
      // it; a review waits, so it goes in after; nothing can be written, so it is kept to copy.
      if (reason === "stale") this.again(w);
      else if (reason === "held") this.anew(w);
      else if (reason === "frozen") {
        this.retake = { near: w.range.start, after: null, want: w };
        this.notify(DECK_WORDS.waitsKept);
      } else this.park(w);
      this.hooks.status();
      return;
    }
    if (reason === "held") {
      const who = holderName(by);
      this.notify(
        w.open.kind === "notes" ? DECK_WORDS.heldHere(who) : DECK_WORDS.held(who, w.open.n),
      );
    } else if (reason === "stale") {
      // The lines moved before the room read the lease: the place is looked for again, by what
      // it held, in the room's lines (which came before this answer), never at the same numbers.
      this.again(w);
    }
  }

  lost(reason: LeaseLoss): void {
    const open = this.open;
    const closing = this.closing;
    let o: Snap;
    if (open) {
      // What was typed, read while the editors are there (typed is null when it cannot be written
      // as typed), and whether the room may not have it: in the debounce, not writable as typed,
      // or sent with no acknowledgement before the lease went. A copy at worst, never a loss.
      o = this.snapOf(open);
      this.discardOpen();
    } else if (closing) {
      // A place closed (or split by Enter) whose last edit had no answer when its lease went: it
      // is written again, and closed once it is, since the person had left it.
      this.closing = null;
      if (!closing.snap.unsent) {
        if (closing.snap.rescue) this.dropRescue(closing.snap.rescue);
        return;
      }
      o = closing.snap;
    } else return;
    const { typed, unsent, models } = o;
    const after = open ? {} : { closeAfter: true as const };
    const b = this.backend;
    // Typing kept earlier that still waits for its place is never dropped for this one's: it goes
    // in as a new block near it, after.
    if (this.retake?.want.resend) {
      this.fromStore.push(this.retake.want);
      this.retake = null;
    }
    if (reason === "reconnect" || reason === "rebased") {
      // The room merged a version or the socket dropped: take the block again once the draft is
      // back, and send what was typed since. It is looked for by each text the room may hold of
      // it: after a merge, what the room acked of it; after a dropped socket, the text sent last
      // (it may have arrived without its answer), the text acked (the room kept running) or the
      // text last written to D1 (the room was evicted meanwhile). An empty one is an insert point,
      // found by the lines around it. A merge's text comes after the lease's end (with a higher
      // rev), so the block is looked for in it, not in the lines from before it.
      const texts =
        reason === "rebased"
          ? [b.ackedText, o.sent, b.durableText]
          : [o.sent, b.ackedText, b.durableText];
      const alts: Mark[] = [];
      for (const text of texts) {
        if (text === null || alts.some((m) => m.text === text)) continue;
        alts.push(text === "" ? { text, ...o.around } : { text, above: null, below: null });
      }
      // An insert point nothing was typed in just closes.
      const keep = alts.some((m) => m.text !== "") || typed === null || typed.length > 0;
      const mark = alts[0];
      if (keep && mark) {
        const { kind, n, ctx, env, pad, form } = o;
        // Typing the room may not have is kept in the store too, until it is written.
        const rescue = unsent ? this.keepRescue(o.rescue, models, o, o.start) : o.rescue;
        this.retake = {
          near: o.start,
          after: reason === "rebased" ? b.rev : null,
          want: {
            range: { start: o.start, end: o.start },
            mark,
            alts,
            tries: 0,
            focus: "end",
            open: { kind, n, ctx, env, pad, form, models },
            resend: true,
            ...after,
            ...(rescue ? { rescue } : {}),
          },
        };
        this.tryRetake();
      } else if (o.rescue) this.dropRescue(o.rescue, "gone");
    } else if (unsent && models.some((m) => hasText(m, o.env))) {
      // Taken over, or the draft closed under it (a review, a reset), with typing the room does
      // not have yet (in the debounce, or not writable as typed): never dropped with the block.
      // Written without its marks when it cannot be written with them. Taken over: as a new block
      // below it (the notes: after them, once free). Closed: in its place again, once a lease can
      // be had and no review waits.
      const keptModels = typed === null ? models.map(withoutMarks) : models;
      const { kind, n, ctx, env, pad, form } = o;
      const open = { kind, n, ctx, env, pad, form, models: keptModels };
      const rescue = this.keepRescue(o.rescue, keptModels, o, o.start);
      const extra = { ...after, ...(rescue ? { rescue } : {}) };
      // What the room holds of the block: its last acknowledged text (the text at the grant when
      // none was).
      const held = b.ackedText ?? o.sent ?? "";
      const heldLines = blockLines(held).length;
      if (reason === "takeover") {
        const at = Math.min(o.start + heldLines, b.lines.length);
        const w: Want = {
          range: { start: at, end: at },
          mark: markOf(b.lines, { start: at, end: at }),
          tries: 0,
          focus: "end",
          // Every block it holds (a split's two halves too).
          open: kind === "notes" ? open : { ...open, pad: this.padAt(at) },
          resend: true,
          ...(kind === "notes" ? { append: true as const } : {}),
          ...extra,
        };
        this.retake = { near: at, after: null, want: w };
        this.notify(DECK_WORDS.takenKept);
      } else {
        const mark = (text: string): Mark =>
          text === "" ? { text, ...o.around } : { text, above: null, below: null };
        const alts = [held, ...(o.sent !== null && o.sent !== held ? [o.sent] : [])].map(mark);
        this.retake = {
          near: o.start,
          after: null,
          want: {
            range: { start: o.start, end: o.start + heldLines },
            mark: mark(held),
            alts,
            tries: 0,
            focus: "end",
            open,
            resend: true,
            ...extra,
          },
        };
        this.notify(DECK_WORDS.closedKept);
      }
      this.tryRetake();
    } else if (o.rescue) {
      // Nothing the room does not hold: what was kept of it is written.
      this.dropRescue(o.rescue);
    }
    this.hooks.redraw();
    this.hooks.status();
  }

  /**
   * A place to ask for again: after a reconnect or a merge (a block with what was typed in it), or
   * after its lines moved meanwhile. It is looked for by what it held, nearest where it was, and
   * only in the room's lines: once connected, with no text on its way, no lease held, no review
   * waiting and, after a merge, once the draft is past the rev `after`.
   */
  private retake: { near: number; after: number | null; want: Want } | null = null;

  /** Asks again for a place whose lines moved, unless it was looked for too often already. */
  private again(w: Want): void {
    if (w.tries >= RETAKE_TRIES) {
      if (w.resend) this.anew(w);
      else this.notify(DECK_WORDS.changed);
      return;
    }
    this.retake = { near: w.range.start, after: null, want: { ...w, tries: w.tries + 1 } };
    this.tryRetake();
  }

  private tryRetake(): void {
    const r = this.retake;
    const b = this.backend;
    if (!r || this.want || this.open || b.mine || !b.connected || !b.ready || !b.settled) return;
    if (r.after !== null && b.rev <= r.after) return;
    // Typed text waits for a review to end; a place clicked is asked for, and answered `frozen`.
    if (r.want.resend && b.conflictVersion !== null) return;
    const lines = b.lines;
    const w = r.want;
    if (w.append) {
      this.retakeNotes(r);
      return;
    }
    this.retake = null;
    // The same lines may sit on another slide too (two slides titled "Agenda"): the place
    // nearest where the block was is the one taken. Each text is found only as whole blocks, and
    // of two found as near, the longer is taken: the text sent last can be the first lines of
    // the block the room still holds (its last lines deleted, the edit never landed), which is
    // then leased whole and written again, never leased short.
    let at = -1;
    let mark = w.mark;
    const edges = memo(() => blockEdges(lines));
    for (const m of w.alts ?? [w.mark]) {
      const p = markAt(lines, m, r.near, edges);
      if (p < 0) continue;
      const d = Math.abs(p - r.near);
      const was = Math.abs(at - r.near);
      if (at < 0 || d < was || (d === was && m.text.length > mark.text.length)) {
        at = p;
        mark = m;
      }
    }
    if (at < 0) {
      // Typed text whose place is gone goes in as a new block nearby; a place clicked is not.
      if (w.resend) this.anew({ ...w, range: { start: r.near, end: r.near } });
      else this.notify(DECK_WORDS.changed);
      return;
    }
    const slide = deckLayout(lines).slides.find((x) => x.start <= at && at < x.end);
    const n = slide?.n ?? w.open.n;
    const want: Want = {
      ...w,
      open: { ...w.open, n, ctx: { ...w.open.ctx, settings: afterBareOpen(lines, n) } },
      mark,
      range: { start: at, end: at + blockLines(mark.text).length },
    };
    this.want = want;
    if (!b.lease(want.range)) {
      this.want = null;
      // What was typed is asked for again once connected; a place clicked is not.
      if (w.resend) this.retake = { ...r, after: null };
      else this.notify(DECK_WORDS.notConnected);
    }
  }

  /**
   * Kept speaker notes: the slide's notes as they are now, with the kept ones after them, once no
   * one else holds them. Kept on the page when the slide has no notes any more, or they cannot be
   * edited in place.
   */
  private retakeNotes(r: { near: number; after: number | null; want: Want }): void {
    const b = this.backend;
    const lines = b.lines;
    const w = r.want;
    const slide =
      deckLayout(lines).slides.find((x) => x.start <= r.near && r.near < x.end) ??
      deckLayout(lines).slides.find((x) => x.n === w.open.n);
    const notes = slide?.notes;
    if (!slide || !notes) {
      this.retake = null;
      this.park(w);
      return;
    }
    let end = notes.end;
    while (end > notes.start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    const range = { start: notes.start, end };
    // Someone else holds them: asked for once they are free (changed()).
    if ([...b.leases.values()].some((l) => l.id !== b.mine?.id && rangesOverlap(l, range))) return;
    this.retake = null;
    const part = lines.slice(range.start, range.end);
    const form = notesFormOf(part[0]);
    const settings = afterBareOpen(lines, slide.n);
    const now = editableNotes(notesText(part), form, settings);
    if (now === null) {
      this.park(w);
      return;
    }
    const want: Want = {
      range,
      mark: markOf(lines, range),
      tries: 0,
      focus: "end",
      open: {
        ...w.open,
        kind: "notes",
        n: slide.n,
        ctx: { notes: true, settings },
        env: docEnv(notesText(part)),
        form,
        models: [...now, ...w.open.models],
      },
      resend: true,
      ...(w.fallbacks !== undefined ? { fallbacks: w.fallbacks } : {}),
      ...(w.rescue ? { rescue: w.rescue } : {}),
      ...(w.closeAfter ? { closeAfter: true as const } : {}),
    };
    this.want = want;
    if (!b.lease(range)) {
      this.want = null;
      this.retake = r;
    }
  }

  /**
   * Typed text whose place cannot be had: a new block at the free place nearest where it was (the
   * end of a block in a slide's head or a column that no one else's lease touches), RETAKE_TRIES
   * places at most; then it is kept on the page. Kept notes go after the slide's notes instead.
   */
  private anew(w: Want): void {
    const fallbacks = (w.fallbacks ?? 0) + 1;
    if (fallbacks > RETAKE_TRIES) {
      this.park(w);
      return;
    }
    const near = w.range.start;
    if (w.open.kind === "notes") {
      this.retake = {
        near,
        after: null,
        want: { ...w, append: true, fallbacks, tries: 0 },
      };
      this.tryRetake();
      return;
    }
    const at = this.freePoint(near);
    if (at === null) {
      this.park(w);
      return;
    }
    const lines = this.backend.lines;
    this.retake = {
      near: at.at,
      after: null,
      want: {
        ...w,
        range: { start: at.at, end: at.at },
        mark: markOf(lines, { start: at.at, end: at.at }),
        alts: undefined,
        tries: RETAKE_TRIES,
        fallbacks,
        open: {
          ...w.open,
          n: at.n,
          ctx: { notes: false, settings: afterBareOpen(lines, at.n) },
          pad: this.padAt(at.at),
          // Every block it holds (a split's two halves too), written there together.
          models: w.open.models,
        },
      },
    };
    this.tryRetake();
  }

  /**
   * The insert point nearest `near` at a block's end in a slide's head or a column (or an empty
   * part's start) that no other lease touches.
   */
  private freePoint(near: number): { at: number; n: number } | null {
    const b = this.backend;
    const lines = b.lines;
    const others = [...b.leases.values()].filter((l) => l.id !== b.mine?.id);
    let best: { at: number; n: number } | null = null;
    for (const slide of deckLayout(lines).slides) {
      for (const part of [slide.head, ...slide.columns]) {
        const shown = deckPartShown(lines.slice(part.start, part.end), false).join("\n");
        const ends = parseBlocks(shown).map((x) => part.start + x.core.end);
        for (const p of ends.length > 0 ? ends : [part.start]) {
          if (others.some((l) => l.start <= p && p <= l.end)) continue;
          const d = Math.abs(p - near);
          const was = best ? Math.abs(best.at - near) : Number.POSITIVE_INFINITY;
          // Nearest; of two as near, the one below.
          if (d < was || (d === was && best && p > best.at)) best = { at: p, n: slide.n };
        }
      }
    }
    return best;
  }

  /**
   * Typed text no place takes for now: kept on the page, which says so with Copy, and counted as
   * unsent changes (the page asks before it is left). Tried again after a reconnect.
   */
  private park(w: Want): void {
    if (!w.raw && !w.open.models.some((m) => hasText(m, w.open.env))) {
      if (w.rescue) this.dropRescue(w.rescue, "gone");
      return;
    }
    this.parked.push({ ...w, tries: 0, fallbacks: 0, alts: undefined, append: undefined });
    this.showKept();
    this.hooks.status();
  }

  /** The open place is typing kept from a lease that ended and cannot be written: kept to copy. */
  private parkOpen(): void {
    const o = this.open;
    if (!o) return;
    const mine = this.backend.mine;
    const at = mine?.start ?? o.start;
    const { kind, n, ctx, env, pad, form } = o;
    const models = o.editors.map((r) => r.model);
    const rescue = this.keepRescue(o.rescue, models, o, at);
    const w: Want = {
      range: { start: at, end: at },
      mark: markOf(this.backend.lines, { start: at, end: at }),
      tries: 0,
      focus: "end",
      open: { kind, n, ctx, env, pad, form, models },
      resend: true,
      ...(rescue ? { rescue } : {}),
    };
    this.discardOpen();
    if (mine) this.backend.release();
    this.park(w);
    this.hooks.redraw();
  }

  /**
   * After a reconnect, the next parked text is tried again (as a new block nearby); after a reload,
   * the next text the app kept is written back (offerRescue).
   */
  private nextKept(): void {
    const b = this.backend;
    if (this.toRetry.length + this.fromStore.length === 0 || this.want || this.open || b.mine) {
      return;
    }
    if (!b.connected || !b.ready || !b.settled || b.conflictVersion !== null) return;
    if (b.you?.right !== "write") return;
    const w = (this.toRetry.shift() ?? this.fromStore.shift()) as Want;
    this.updateKept();
    if (w.open.models.length === 0) {
      // Not readable as blocks: kept to copy.
      this.park(w);
      return;
    }
    this.anew({ ...w, fallbacks: 0 });
  }

  /**
   * Edit mode ends: the open place's typing that cannot be written as typed is written without its
   * marks rather than lost with the place.
   */
  private salvage(): void {
    const o = this.open;
    if (o && this.solo && o.notSent && !this.stuck) {
      // Alone, at the deck's size limit: kept on the page with Copy, and opened again as a new
      // block when edit mode starts again (setEditing), never dropped with the place.
      this.parkOpen();
      return;
    }
    if (!o || !this.stuck) return;
    for (const r of o.editors) r.setModel(withoutMarks(r.model));
    if (this.send()) {
      this.notify(DECK_WORDS.formatDropped);
      return;
    }
    if (this.open === o) this.parkOpen();
  }

  /** Writes a kept place granted after edit mode ended, then releases it; kept when it cannot be. */
  private writeKept(o: Open): void {
    if (this.linesNow(o) === null) {
      for (const r of o.editors) r.setModel(withoutMarks(r.model));
    }
    if (this.send()) {
      this.close(true);
      return;
    }
    if (this.open === o) this.parkOpen();
  }

  /** Takes the open place off the page without sending or releasing (its lease ended, or is kept). */
  private discardOpen(): void {
    const o = this.open;
    if (!o) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setStuck(false);
    this.open = null;
    for (const r of o.editors) r.destroy();
  }

  /** Everything kept is dropped: the unpublished changes were discarded. */
  clearKept(): void {
    this.parked = [];
    this.toRetry = [];
    this.fromStore = [];
    if (this.retake?.want.resend) this.retake = null;
    if (this.want?.resend) this.want = null;
    if (this.open?.rescue) delete this.open.rescue;
    if (this.closing?.snap.rescue) delete this.closing.snap.rescue;
    const ids = [...this.rescues.keys()];
    this.rescues.clear();
    if (ids.length > 0) this.report([], [], ids);
    this.updateKept();
    this.hooks.status();
  }

  // ---------- the rescue store ----------

  /**
   * The rescue item for typing kept in the place `where` describes (made, or brought up to date):
   * its text without its marks, whether it was typed on a slide or in its notes, the raw slide and
   * that slide's first line of text, and `near`, the line it belongs at. Alone too: a solo tab's
   * kept copy is the deck's text as written, which can be published (typing at the deck's size
   * limit would put it past it), so typing it does not hold is kept here, apart. Returns its id
   * (or `id` as it was, when nothing is kept).
   */
  private keepRescue(
    id: string | undefined,
    models: readonly RichBlock[],
    where: { kind: Open["kind"]; n: number; env: MdEnv },
    near?: number,
  ): string | undefined {
    const text = plainText(models, where.env);
    if (text === "") return id;
    const rid = id ?? `d${Date.now().toString(36)}${++this.rescueN}`;
    const was = this.rescues.get(rid);
    const lines = this.backend.lines;
    const slide = deckLayout(lines).slides.find((s) => s.n === where.n);
    const r: DeckRescue = {
      id: rid,
      text,
      near: Math.max(0, near ?? was?.near ?? slide?.start ?? 0),
      part: where.kind === "notes" ? "notes" : "slide",
      slide: where.n,
      ref: slide ? slideRef(lines, slide) : (was?.ref ?? ""),
      reported: was?.reported ?? null,
      kept: was?.kept ?? null,
    };
    this.rescues.set(rid, r);
    if (
      !was ||
      was.text !== r.text ||
      was.near !== r.near ||
      was.part !== r.part ||
      was.slide !== r.slide ||
      was.ref !== r.ref
    ) {
      this.report([r], [], []);
    }
    return rid;
  }

  /** Item `id` leaves the store: written (the room acknowledged its write) or gone (on purpose). */
  private dropRescue(id: string, why: "written" | "gone" = "written"): void {
    if (!this.rescues.delete(id)) return;
    this.report([], why === "written" ? [id] : [], why === "gone" ? [id] : []);
    this.updateKept();
    this.hooks.status();
  }

  /** Tells the app what changed in the store (it merges; see DeckRescueReport). */
  private report(upsert: DeckRescue[], written: string[], gone: string[]): void {
    const n = ++this.reportN;
    for (const r of upsert) r.reported = n;
    this.hooks.rescue?.({
      upsert: upsert.map(({ id, text, near, part, slide, ref }) => ({
        id,
        text,
        near,
        ...(part ? { part } : {}),
        ...(slide ? { slide } : {}),
        ...(ref !== undefined ? { ref } : {}),
      })),
      written,
      gone,
      n,
    });
  }

  /**
   * The app's answer to report `n` and the ones before it: the ids its store holds. An item it
   * was sent but does not hold (over its limits) is on this page only, which the page says, with
   * Copy.
   */
  rescueStored(ids: readonly string[], n: number): void {
    const held = new Set(ids);
    for (const r of this.rescues.values()) {
      if (held.has(r.id)) r.kept = true;
      else if (r.reported !== null && r.reported <= n) r.kept = false;
    }
    this.updateKept();
  }

  /**
   * Items the app kept from before a reload: each one this page does not know is written back into
   * the part it was typed in, one at a time, and closed once written: a slide's as a new block at
   * the free place nearest where it was on its slide, notes after that slide's notes (never on a
   * slide; kept to copy when the slide has no notes now). The slide is found by its first line of
   * text then, else by its number. What cannot be placed is kept to copy.
   */
  offerRescue(items: readonly RescueItem[]): void {
    if (!this.backend.ready || !this.backend.settled) {
      // Placed once the room's draft is here (changed).
      this.offered.push(...items);
      return;
    }
    let added = false;
    for (const it of items) {
      if (this.rescues.has(it.id)) continue;
      this.rescues.set(it.id, { ...it, reported: null, kept: true });
      added = true;
      const notes = it.part === "notes";
      const lines = this.backend.lines;
      const slides = deckLayout(lines).slides;
      const byRef =
        it.ref !== undefined && it.ref !== ""
          ? slides
              .filter((s) => slideRef(lines, s) === it.ref)
              .sort((a, b) => Math.abs(a.start - it.near) - Math.abs(b.start - it.near))[0]
          : undefined;
      const slide = byRef ?? slides.find((s) => s.n === it.slide);
      const n = slide?.n ?? it.slide ?? 1;
      const models = modelsOf(it.text);
      // Near its place, on its slide as it is now.
      const near = slide ? Math.min(slide.end, Math.max(slide.start, it.near)) : it.near;
      const w: Want = {
        range: { start: slide ? slide.start : near, end: slide ? slide.start : near },
        mark: { text: "", above: null, below: null },
        tries: 0,
        focus: "end",
        open: {
          kind: notes ? "notes" : "block",
          n,
          ctx: { notes, settings: afterBareOpen(lines, n) },
          env: docEnv(it.text),
          pad: { before: false, after: false },
          form: notesFormOf(undefined),
          models: models ?? [],
        },
        resend: true,
        rescue: it.id,
        closeAfter: true,
        ...(models ? {} : { raw: it.text }),
      };
      if (!slide && (notes || !models)) {
        // Its slide is gone: notes never go onto another slide's text; kept to copy.
        this.park(w);
        continue;
      }
      if (!notes) w.range = { start: near, end: near };
      this.fromStore.push(w);
    }
    if (added) {
      this.hooks.status();
      this.nextKept();
    }
  }

  private showKept(): void {
    this.keptWords ??= DECK_WORDS.stuckKept;
    this.drawNotice();
  }

  /**
   * Shows the notice while anything is kept on the page, or kept only here (the app's store did not
   * take it: over its limits), and takes it away once nothing is.
   */
  private updateKept(): void {
    const only = [...this.rescues.values()].some((r) => r.kept === false);
    if (this.parked.length + this.toRetry.length > 0 || only) {
      this.keptWords = only ? DECK_WORDS.frameOnly : DECK_WORDS.stuckKept;
    } else this.keptWords = null;
    this.drawNotice();
  }

  /** The kept texts, as Markdown without marks, one block per paragraph. */
  keptText(): string {
    const store = [...this.rescues.values()].map((r) => r.text);
    const others = [...this.parked, ...this.toRetry, ...this.fromStore]
      .filter((w) => !(w.rescue && this.rescues.has(w.rescue)))
      .map((w) => w.raw ?? plainText(w.open.models, w.open.env));
    return [...store, ...others].filter((t) => t.trim() !== "").join("\n\n");
  }

  /** Puts every kept text on the clipboard, for the person to paste where they want it. */
  private copyKept(): void {
    const text = this.keptText();
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
    const clip = this.win.navigator?.clipboard;
    if (clip?.writeText) void clip.writeText(text).catch(fallback);
    else fallback();
  }

  /**
   * The socket closed: an asked-for lease is never answered. A block with what was typed in it is
   * asked for again once the draft is back (the welcome brings the room's whole text), and so is
   * typing kept on the page.
   */
  disconnected(): void {
    this.tidying = false;
    const w = this.want;
    this.want = null;
    if (w?.resend) this.retake = { near: w.range.start, after: null, want: w };
    else if (this.retake) this.retake = { ...this.retake, after: null };
    if (this.parked.length > 0) {
      this.toRetry.push(...this.parked);
      this.parked = [];
    }
  }

  /**
   * The room refused this editor's edit or op (`invalid`): put it back, say why. Typing that cannot
   * be written as typed stays as typed, and typing kept from a lease that ended is kept on the
   * page: the room's text never replaces either.
   */
  refused(reason: string): void {
    if (this.tidying && !this.open) {
      // Removing notes left empty (nothing else is out meanwhile): they stay, drawn as none.
      this.tidying = false;
      return;
    }
    this.tidying = false;
    this.trimming = false;
    this.settingsPending = false;
    if (this.stuck) {
      this.notify(reason);
      this.hooks.status();
      return;
    }
    if (this.open?.kept) {
      this.parkOpen();
      this.notify(reason);
      return;
    }
    const c = this.closing;
    if (!this.open && c?.snap.unsent) {
      // The last edit of a place closed meanwhile was refused: what it held is kept to copy (and
      // tried again after a reconnect), never put back as the room has it.
      this.closing = null;
      const s = c.snap;
      const models = s.typed === null ? s.models.map(withoutMarks) : s.models;
      const rescue = this.keepRescue(s.rescue, models, s, s.start);
      this.park({
        range: { start: s.start, end: s.start },
        mark: markOf(this.backend.lines, { start: s.start, end: s.start }),
        tries: 0,
        focus: "end",
        open: { kind: s.kind, n: s.n, ctx: s.ctx, env: s.env, pad: s.pad, form: s.form, models },
        resend: true,
        closeAfter: true,
        ...(rescue ? { rescue } : {}),
      });
      this.notify(reason);
      return;
    }
    this.putBack();
    this.notify(reason);
  }

  structLanded(op: SlidesStructOp): void {
    if (op.op === "trim_start" && this.trimming) {
      this.trimming = false;
      this.send();
      if (this.deleting) {
        this.deleting = false;
        this.close(true);
      }
      return;
    }
    if (op.op === "set_deck") {
      this.settingsPending = false;
      this.closeSettings();
    }
    if (op.op === "remove_notes") this.tidying = false;
    const after = this.afterStruct;
    this.afterStruct = null;
    // The deck was drawn again for this op before this runs (changed comes after).
    if (after) this.win.setTimeout(() => after(op), 0);
  }

  structDenied(reason: LeaseDenial, by?: string): void {
    if (this.tidying) {
      // Removing notes left empty: refused, they stay as empty notes, drawn as none.
      this.tidying = false;
      return;
    }
    const n = this.trimming ? 1 : (this.open?.n ?? this.hooks.current());
    this.afterStruct = null;
    if (this.trimming) {
      this.trimming = false;
      this.putBack();
    }
    this.settingsPending = false;
    this.syncSettingsButtons();
    if (reason === "held") this.notify(DECK_WORDS.held(holderName(by), n));
    else if (reason === "stale") this.notify(DECK_WORDS.changed);
  }

  /**
   * Says why something was not done: in the deck's live region, and on the page for a few seconds
   * in the notice floating over the stage (the live region already reads it, so the notice is hidden from
   * assistive technology while it shows a message).
   */
  notify(text: string): void {
    this.hooks.announce(text);
    if (!text || !this.editing) return;
    this.message = text;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.hideToast(), NOTICE_MS);
    this.drawNotice();
  }

  private hideToast(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    if (this.message === null) return;
    this.message = null;
    this.drawNotice();
  }

  /**
   * The one notice, a toast floating over the stage that never resizes the slide (at phone width
   * it sits in the empty stage under the notes): typing kept on the page, with Copy, while there is
   * any (the action stays in reach; a message meanwhile is read by the live region only), else the
   * editor's last message for a few seconds.
   */
  private drawNotice(): void {
    const text = this.keptWords ?? this.message;
    const was = this.notice;
    if (text === null) {
      if (!was) return;
      was.remove();
      this.notice = null;
      return;
    }
    const kept = this.keptWords !== null;
    const n = was ?? el(this.doc, "div", "plinth-slides__notice");
    n.className = `plinth-slides__notice ${kept ? "plinth-slides__kept" : "plinth-slides__toast"}`;
    n.dataset.plinthControl = "";
    if (kept) {
      n.setAttribute("role", "status");
      n.removeAttribute("aria-hidden");
      const copy = el(this.doc, "button", "plinth-slides__kept-copy", DECK_WORDS.copy);
      copy.type = "button";
      copy.addEventListener("click", () => this.copyKept());
      n.replaceChildren(el(this.doc, "span", "plinth-slides__kept-text", text), copy);
    } else {
      n.removeAttribute("role");
      n.setAttribute("aria-hidden", "true");
      n.replaceChildren(el(this.doc, "span", "plinth-slides__kept-text", text));
    }
    this.notice = n;
    const root = this.doc.getElementById("__plinth-slides") ?? this.doc.body;
    if (!root.contains(n)) root.append(n);
  }

  // ---------- blocks not edited in place ----------

  /** "Ask an agent", described by what an agent would do there. */
  private askButton(note: string, run: () => void): HTMLButtonElement {
    const b = el(this.doc, "button", "plinth-slides__ask", DECK_WORDS.ask);
    b.type = "button";
    b.title = note;
    b.setAttribute("aria-description", note);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      run();
    });
    return b;
  }

  /** The bar under a selected block that is not edited in place. */
  private showBar(b: EditBlock, v: EditSlideView): void {
    this.hideBar();
    const image = b.nodes.some((n) => isEl(n) && n.querySelector("img"));
    const bar = el(this.doc, "div", "plinth-slides__blockbar");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", `Slide ${v.n}, ${image ? "image" : "block"}`);
    bar.dataset.plinthControl = "";
    if (image) {
      const imgIndex = this.imageIndex(b, v);
      bar.append(
        this.askButton(DECK_WORDS.imageNote, () => this.ask(v, `image-${imgIndex}`, "image")),
      );
      const del = el(this.doc, "button", "plinth-slides__ask", DECK_WORDS.delete);
      del.type = "button";
      del.addEventListener("click", () => this.deleteBlock(b, v));
      bar.append(del);
    } else {
      bar.append(
        this.askButton(DECK_WORDS.readOnly, () => this.ask(v, `block-${b.index}`, "block")),
      );
    }
    v.frame.append(bar);
    this.bar = bar;
    // The block stays marked while its bar shows (an image's tint is on the image itself).
    this.barNodes = b.nodes.filter(isEl);
    for (const n of this.barNodes) n.setAttribute("data-selected", "");
    // Next to the block, covering as little of the slide's other blocks as it can (the deck's
    // controls step aside while it shows).
    const avoid = v.parts
      .flatMap((p) => p.blocks)
      .filter((o) => o !== b)
      .flatMap((o) => o.nodes.filter(isEl).map((n) => n.getBoundingClientRect()));
    placeBar(bar, b, v.frame, avoid);
    (bar.querySelector("button") as HTMLButtonElement | null)?.focus();
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideBar();
        (b.nodes[0] as HTMLElement | undefined)?.focus?.();
      }
    });
  }

  private hideBar(): void {
    this.bar?.remove();
    this.bar = null;
    for (const n of this.barNodes) n.removeAttribute("data-selected");
    this.barNodes = [];
  }

  private imageIndex(b: EditBlock, v: EditSlideView): number {
    const all = Array.from(v.el.querySelectorAll("img"));
    const first = b.nodes
      .flatMap((n) => (isEl(n) ? Array.from(n.querySelectorAll("img")) : []))
      .at(0);
    return first ? all.indexOf(first) + 1 : 1;
  }

  /** Ask an agent about a place on slide `v`: a structural key and words, never its text. */
  private ask(v: EditSlideView, place: string, what: AskWhat): void {
    this.hideBar();
    this.close(true);
    const n = v.shownN ?? v.n;
    const words =
      place === "notes"
        ? `Slide ${n}, speaker notes`
        : place.startsWith("image-")
          ? `Slide ${n}, image ${place.slice(6)}`
          : `Slide ${n}, ${what}`;
    this.hooks.ask({ key: `slide-${n}:${place}`, text: words }, what);
  }

  /** Deletes a block that is not edited in place (an image): its lease, then zero lines. */
  private deleteBlock(b: EditBlock, v: EditSlideView): void {
    this.hideBar();
    if (!this.writable()) return;
    this.close(true);
    this.request({
      range: { start: b.start, end: b.end },
      focus: "end",
      open: {
        kind: "block",
        n: v.n,
        ctx: this.ctxOf(v),
        env: {},
        pad: { before: false, after: false },
        form: notesFormOf(undefined),
        models: [para()],
      },
      // Once granted, the empty paragraph sends zero lines (or the emptying procedure's).
      emptyNow: true,
    });
  }

  // ---------- deck settings ----------

  /** Opens the deck settings popover (the app's ⋯ "Slide setup"). */
  openSettings(): void {
    if (!this.editing || !this.canWrite) return;
    this.closeSettings();
    const s = parseLaidOut(
      this.backend.lines,
      this.layout ?? deckLayout(this.backend.lines),
    ).settings;
    const pop = settingsPopover(this.doc, s, {
      apply: (next) => {
        // A place that could not close keeps its lease: the settings wait until it is written.
        if (this.open && (this.stuck || this.open.notSent) && this.heldOpen()) return;
        this.settingsPending = true;
        this.syncSettingsButtons();
        if (!this.backend.struct({ op: "set_deck", ...next })) {
          this.settingsPending = false;
          this.syncSettingsButtons();
          this.notify(DECK_WORDS.notConnected);
        }
      },
      cancel: () => this.closeSettings(),
    });
    this.doc.getElementById("__plinth-slides")?.append(pop);
    this.popover = pop;
    // The dialog itself takes focus, so no control shows a focus ring before a key is pressed;
    // Tab goes on to the first setting.
    pop.tabIndex = -1;
    pop.focus();
  }

  private syncSettingsButtons(): void {
    const apply = this.popover?.querySelector<HTMLButtonElement>(".plinth-slides__settings-apply");
    if (apply) apply.disabled = this.settingsPending;
  }

  closeSettings(): void {
    this.popover?.remove();
    this.popover = null;
  }

  /** A `focus: "first"` that came before the draft was drawn: done at the next decorate. */
  private wantFirst = false;

  /** `focus: "first"` (New): open the first editable block of the slide shown. */
  focusFirst(): void {
    const v = this.views.find((x) => x.n === this.hooks.current()) ?? this.views[0];
    if (!v || !this.backend.ready) {
      this.wantFirst = true;
      return;
    }
    this.wantFirst = false;
    for (const p of v.parts) {
      for (const b of p.blocks) {
        if (this.modelOf(b, v)) {
          this.activate(b, v, true);
          return;
        }
      }
    }
    if (v.empty) this.addTitle(v);
  }

  /** Where each other editor is, for the app's status ("slide 3"): structural, never content. */
  whereOf(lease: LineRange): string | null {
    const v = this.views.find((x) => lease.start >= x.raw.start && lease.start <= x.raw.end);
    return v ? `slide ${v.shownN ?? v.n}` : null;
  }
}

/** The gap between a selected block and its bar, in CSS pixels on screen. */
const BAR_GAP = 6;

/** How much of `r` the box at x, y of size w, h covers. */
function overlap(x: number, y: number, w: number, h: number, r: DOMRect): number {
  const dx = Math.min(x + w, r.right) - Math.max(x, r.left);
  const dy = Math.min(y + h, r.bottom) - Math.max(y, r.top);
  return dx > 0 && dy > 0 ? dx * dy : 0;
}

/**
 * Puts a selected block's bar next to the block, at its right edge (its images' edge, for an
 * image): just above it, as the doc editor's bar sits on its block's corner, or just below it when
 * that covers less of what else is on the slide (`avoid`, in screen pixels: its other blocks). It
 * stays inside the slide's frame.
 */
export function placeBar(
  bar: HTMLElement,
  b: EditBlock,
  frame: HTMLElement,
  avoid: readonly DOMRect[] = [],
): void {
  const els = b.nodes.filter(isEl);
  const imgs = els.flatMap((n) => Array.from(n.querySelectorAll("img")));
  const rects = (imgs.length > 0 ? imgs : els).map((e) => e.getBoundingClientRect());
  if (rects.length === 0) return;
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const right = Math.max(...rects.map((r) => r.right));
  const f = frame.getBoundingClientRect();
  // Within the slide itself, not the notes panel under it.
  const slide = frame.querySelector(".plinth-slides__canvas")?.getBoundingClientRect() ?? f;
  const w = bar.offsetWidth;
  const h = bar.offsetHeight;
  const x = Math.max(f.left, Math.min(right - w, f.right - w));
  const covered = (y: number) => avoid.reduce((sum, r) => sum + overlap(x, y, w, h, r), 0);
  const above = top - h - BAR_GAP;
  const below = bottom + BAR_GAP;
  const fitsAbove = above >= slide.top;
  const y =
    fitsAbove && (below + h > slide.bottom || covered(above) <= covered(below)) ? above : below;
  bar.style.top = `${Math.round(y - f.top)}px`;
  bar.style.left = `${Math.round(x - f.left)}px`;
}

/**
 * Who holds a place, as a one-line message names them: a first name from their address ("Ana"),
 * as the sheet's messages do, or "Someone" when there is none.
 */
export function holderName(by: string | undefined): string {
  const name = by ? personName(by) : "";
  return name === "" || name.includes("@") ? DECK_WORDS.someone : name;
}

/** A notes text as the page draws it (Markdown through the doc pipeline). */
function renderInlineFree(text: string): string {
  return parseBlocks(text)
    .map((b) => b.html)
    .join("");
}

/** The deck settings popover: aspect, theme, page numbers and footer, applied as one set_deck. */
export function settingsPopover(
  doc: Document,
  s: DeckSettings,
  on: {
    apply(next: Omit<Extract<SlidesStructOp, { op: "set_deck" }>, "op">): void;
    cancel(): void;
  },
): HTMLElement {
  const pop = el(doc, "div", "plinth-slides__settings");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", DECK_WORDS.settings);
  pop.dataset.plinthControl = "";
  const title = el(doc, "h2", "plinth-slides__settings-title", DECK_WORDS.settings);
  const row = (label: string, control: HTMLElement) => {
    const l = el(doc, "label", "plinth-slides__settings-row");
    let c = control;
    if (control.localName === "select") {
      // Drawn as the app's own selects are, with a chevron of its own.
      c = el(doc, "span", "plinth-slides__select");
      c.append(control);
    }
    l.append(el(doc, "span", "plinth-slides__settings-label", label), c);
    return l;
  };
  const aspect = doc.createElement("select");
  for (const [v, t] of [
    ["16:9", "16:9 (wide)"],
    ["4:3", "4:3"],
  ] as const) {
    const o = doc.createElement("option");
    o.value = v;
    o.textContent = t;
    aspect.append(o);
  }
  aspect.value = s.aspect;
  const theme = doc.createElement("select");
  for (const [v, t] of [
    ["auto", "Match the viewer"],
    ["light", "Light"],
    ["dark", "Dark"],
  ] as const) {
    const o = doc.createElement("option");
    o.value = v;
    o.textContent = t;
    theme.append(o);
  }
  theme.value = s.theme;
  const paginate = doc.createElement("input");
  paginate.type = "checkbox";
  paginate.checked = s.paginate;
  const footer = doc.createElement("input");
  footer.type = "text";
  footer.maxLength = MAX_DECK_FOOTER;
  footer.value = s.footer;
  footer.placeholder = "None";
  const actions = el(doc, "div", "plinth-slides__settings-actions");
  const cancel = el(doc, "button", "plinth-slides__settings-cancel", DECK_WORDS.cancel);
  cancel.type = "button";
  cancel.addEventListener("click", () => on.cancel());
  const apply = el(doc, "button", "plinth-slides__settings-apply", DECK_WORDS.apply);
  apply.type = "button";
  apply.addEventListener("click", () =>
    on.apply({
      aspect: aspect.value === "4:3" ? "4:3" : "16:9",
      theme: theme.value === "light" ? "light" : theme.value === "dark" ? "dark" : "auto",
      paginate: paginate.checked,
      // One line of plain text: line breaks and control characters become spaces.
      footer: footer.value
        .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
        .trim()
        .slice(0, MAX_DECK_FOOTER),
    }),
  );
  actions.append(cancel, apply);
  const check = el(doc, "label", "plinth-slides__settings-row plinth-slides__settings-check");
  check.append(paginate, el(doc, "span", "plinth-slides__settings-checktext", "Page numbers"));
  pop.append(
    title,
    row("Aspect", aspect),
    row("Theme", theme),
    check,
    row("Footer", footer),
    actions,
  );
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      on.cancel();
    }
  });
  return pop;
}
