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
  type SlidesStructOp,
  sameBlock,
  serializeNotes,
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
const RULES = liveRules("slides");
const TOOLS = docMarkdownTools();

/** The editor's words (exported for tests). */
export const DECK_WORDS = {
  refused: "That change would change the deck's layout, so it wasn't kept.",
  held: (who: string, n: number) => `${who} is editing slide ${n}. Try again when they finish.`,
  heldHere: (who: string) => `${who} is editing this. Try again when they finish.`,
  notConnected: "Not connected. Try again in a moment.",
  changed: "The deck changed meanwhile. Try again.",
  notKept: "The deck changed while you were offline, so the block you were typing in was closed.",
  unsavable: "This text can't be saved as typed. Change it to continue.",
  tooLong: "This block is too long to send. Split it into smaller blocks.",
  full: "The deck is at its size limit, so that change wasn't made.",
  askBlock: "Ask an agent to change this",
  askImage: "Replace or add images: Ask an agent",
  askNotes: "Ask an agent to change these notes",
  readOnly: "This part can't be edited here. An agent can change it.",
  delete: "Delete",
  notes: (n: number) => `Notes for slide ${n}`,
  addNotes: "Add speaker notes",
  removeNotes: "Remove speaker notes",
  notesMenu: "Speaker notes",
  noNotes: "No speaker notes",
  empty: (n: number) => `Slide ${n}, empty`,
  dense: "Long slide: its text is shrunk to fit",
  settings: "Deck settings",
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
  /** Taken again after a reconnect: what was typed is sent once it is open. */
  resend?: true;
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

/** Where the place `mark` describes starts in `lines`, nearest to line `near`, or -1. */
function markAt(lines: readonly string[], mark: Mark, near: number): number {
  if (mark.text !== "") return locateBlock(lines, mark.text, near);
  let best = -1;
  for (let p = 0; p <= lines.length; p++) {
    if ((lines[p - 1] ?? null) !== mark.above || (lines[p] ?? null) !== mark.below) continue;
    if (best < 0 || Math.abs(p - near) < Math.abs(best - near)) best = p;
  }
  return best;
}

const para = (): RichBlock => ({ t: "paragraph", c: [] });

/** Whether a node is an element (frames have their own Element class, so no instanceof). */
const isEl = (n: Node): n is HTMLElement => n.nodeType === 1;

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
  /** Run once the room acked what this editor sent (a split's new block below). */
  private afterAck: (() => void) | null = null;
  private views: EditSlideView[] = [];
  private layout: DeckLayout | null = null;
  /** The bar of a selected block that is not edited in place (Ask an agent, Delete). */
  private bar: HTMLElement | null = null;
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

  /** Text waits in the debounce, or cannot be written as typed. */
  get pending(): boolean {
    return this.timer !== null || this.stuck || this.trimming;
  }

  get unsavable(): boolean {
    return this.stuck;
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
      this.close(true);
      this.closeSettings();
      this.hideBar();
    }
    this.editing = on;
    this.hooks.redraw();
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
      panel.append(this.notesHead(v, true), o.host);
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
    panel.append(this.notesHead(v, range !== null));
    if (!range) {
      const add = el(this.doc, "button", "plinth-slides__notepad-add", DECK_WORDS.addNotes);
      add.type = "button";
      add.addEventListener("click", () => this.addNotes(v));
      panel.append(add);
      host.replaceChildren(panel);
      return;
    }
    const lines = this.backend.lines.slice(range.start, range.end);
    const text = notesText(lines);
    const models = editableNotes(
      text,
      notesFormOf(lines[0]),
      afterBareOpen(this.backend.lines, v.n),
    );
    const body = el(this.doc, "div", "plinth-slides__notepad-body");
    if (text === "") {
      body.append(el(this.doc, "p", "plinth-slides__notepad-none", DECK_WORDS.noNotes));
    } else {
      const frag = sanitizeHtml(renderInlineFree(text), this.doc);
      pinFiles(frag, this.hooks.fileVersion());
      body.append(frag);
    }
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
        this.askButton(DECK_WORDS.askNotes, () => this.ask(v, "notes", "block")),
      );
    }
    host.replaceChildren(panel);
  }

  private notesHead(v: EditSlideView, hasNotes: boolean): HTMLElement {
    const head = el(this.doc, "div", "plinth-slides__notepad-head");
    head.append(
      el(this.doc, "h2", "plinth-slides__notepad-title", DECK_WORDS.notes(v.shownN ?? v.n)),
    );
    if (hasNotes) {
      const remove = el(
        this.doc,
        "button",
        "plinth-slides__notepad-remove",
        DECK_WORDS.removeNotes,
      );
      remove.type = "button";
      remove.addEventListener("mousedown", (e) => e.preventDefault());
      remove.addEventListener("click", () => this.removeNotes(v));
      head.append(remove);
    }
    return head;
  }

  private addNotes(v: EditSlideView): void {
    if (!this.writable()) return;
    this.close(true);
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

  private removeNotes(v: EditSlideView): void {
    if (!this.writable()) return;
    this.close(true);
    if (!this.backend.struct({ op: "remove_notes", n: v.n })) this.notify(DECK_WORDS.notConnected);
  }

  /** Run once this editor's own struct op landed. */
  private afterStruct: ((op: SlidesStructOp) => void) | null = null;

  private openNotes(v: EditSlideView, models: RichBlock[]): void {
    const range = this.notesRange(v);
    if (!range || !this.writable()) return;
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
    if (!b) return;
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
    if (!w || !this.editing) {
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
    };
    for (const m of w.open.models) o.editors.push(this.makeEditor(o, m));
    host.append(...o.editors.map((r) => r.el));
    host.addEventListener("focusin", () => {
      o.focused = true;
    });
    host.addEventListener("focusout", (e) => this.onFocusOut(e));
    this.open = o;
    this.stuck = false;
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
    this.stuck = false;
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
  private linesNow(o: Open, blocks?: RichBlock[]): string[] | null {
    if (o.kind === "notes") {
      const models = o.editors.map((r) => r.model);
      for (const m of models) if (verifyBlock(m, TOOLS, o.env) === null) return null;
      try {
        return serializeNotes(models, o.form, o.ctx.settings);
      } catch {
        return null;
      }
    }
    const model = o.editors[0]?.model;
    if (!model) return null;
    const lines: string[] = [];
    for (const m of blocks ?? [model]) {
      const part = deckBlockLines(m, o.ctx, o.env);
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
      this.stuck = true;
      this.notify(DECK_WORDS.unsavable);
      this.hooks.status();
      return false;
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
    if (text === o.sent) return true;
    if (new TextEncoder().encode(text).byteLength > LIMITS.liveDocFrameBytes - 512) {
      this.notify(DECK_WORDS.tooLong);
      return false;
    }
    if (!this.backend.edit(text)) {
      this.notify(DECK_WORDS.notConnected);
      return false;
    }
    o.sent = text;
    return true;
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

  /** A change this editor would not send: the block goes back to the room's lines. */
  private refusedHere(reason: string): boolean {
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
    // deck at once, whatever happens to the lease asked for next; its block then opens on its own
    // lines. With nothing after the caret, the new block is an insert point below.
    const tail = next ? deckBlockLines(next, o.ctx, o.env) : [];
    if (tail === null || this.linesNow(o, [keep, ...(next ? [next] : [])]) === null) {
      // Nothing changes: the block stays as typed.
      this.notify(DECK_WORDS.unsavable);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const sent = tail.length > 0 && next ? this.send([keep, next]) : this.send([keep]);
    // Not sent: the block stays as it was (or as the room has it, after a refusal).
    if (!sent) return;
    rich.setModel(keep);
    const n = o.n;
    const model = next ?? para();
    const go = () => {
      const mine = this.backend.mine;
      if (!mine || this.open !== o) return;
      const ctx = o.ctx;
      const env = o.env;
      const end = mine.end - (tail.length > 0 && o.pad.after ? 1 : 0);
      const range =
        tail.length > 0 ? { start: end - tail.length, end } : { start: mine.end, end: mine.end };
      this.close(true);
      this.request({
        range,
        focus: "start",
        open: {
          kind: "block",
          n,
          ctx,
          env,
          pad: tail.length > 0 ? { before: false, after: false } : this.padAt(range.start),
          form: notesFormOf(undefined),
          models: [model],
        },
      });
    };
    if (this.backend.ackedText === o.sent) go();
    else this.afterAck = go;
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
    this.open = null;
    this.afterAck = null;
    for (const r of o.editors) r.destroy();
    if (release && this.backend.mine) this.backend.release();
    const n = o.n;
    this.hooks.redraw();
    if (refocus) this.focusables(n)[0]?.focus();
    this.hooks.status();
  }

  // ---------- the room's answers ----------

  changed(): void {
    if (this.retake) this.tryRetake();
    if (this.afterAck && this.backend.ackedText === this.open?.sent) {
      const run = this.afterAck;
      this.afterAck = null;
      run();
    }
  }

  denied(reason: LeaseDenial, by?: string): void {
    const w = this.want;
    this.want = null;
    if (!w) return;
    if (reason === "held" && by) {
      this.notify(
        w.open.kind === "notes" ? DECK_WORDS.heldHere(by) : DECK_WORDS.held(by, w.open.n),
      );
    } else if (reason === "stale") {
      // The lines moved before the room read the lease: the place is looked for again, by what
      // it held, in the room's lines (which came before this answer), never at the same numbers.
      this.again(w);
    }
  }

  lost(reason: LeaseLoss): void {
    const o = this.open;
    if (!o) return;
    // What was typed, read while the editors are there: null when it cannot be written as typed.
    const typed = this.linesNow(o);
    this.open = null;
    const models = o.editors.map((r) => r.model);
    for (const r of o.editors) r.destroy();
    if (reason === "reconnect" || reason === "rebased") {
      // The room merged a version or the socket dropped: take the block again once the draft is
      // back, and send what was typed since. It is looked for by each text the room may hold of
      // it: after a merge, what the room acked of it; after a dropped socket, the text sent last
      // (it may have arrived without its answer), the text acked (the room kept running) or the
      // text last written to D1 (the room was evicted meanwhile). An empty one is an insert point,
      // found by the lines around it. A merge's text comes after the lease's end (with a higher
      // rev), so the block is looked for in it, not in the lines from before it.
      const b = this.backend;
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
          },
        };
        this.tryRetake();
      }
    }
    this.hooks.redraw();
    this.hooks.status();
  }

  /**
   * A place to ask for again: after a reconnect or a merge (a block with what was typed in it), or
   * after its lines moved meanwhile. It is looked for by what it held, nearest where it was, and
   * only in the room's lines: once connected, with no text on its way, no lease held and, after a
   * merge, once the draft is past the rev `after`.
   */
  private retake: { near: number; after: number | null; want: Want } | null = null;

  /** Asks again for a place whose lines moved, unless it was looked for too often already. */
  private again(w: Want): void {
    if (w.tries >= RETAKE_TRIES) {
      this.notify(w.resend ? DECK_WORDS.notKept : DECK_WORDS.changed);
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
    this.retake = null;
    // The same lines may sit on another slide too (two slides titled "Agenda"): the place
    // nearest where the block was is the one taken.
    const lines = b.lines;
    const w = r.want;
    let at = -1;
    let mark = w.mark;
    for (const m of w.alts ?? [w.mark]) {
      const p = markAt(lines, m, r.near);
      if (p >= 0 && (at < 0 || Math.abs(p - r.near) < Math.abs(at - r.near))) {
        at = p;
        mark = m;
      }
    }
    if (at < 0) {
      this.notify(w.resend ? DECK_WORDS.notKept : DECK_WORDS.changed);
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
   * The socket closed: an asked-for lease is never answered. A block with what was typed in it is
   * asked for again once the draft is back (the welcome brings the room's whole text).
   */
  disconnected(): void {
    const w = this.want;
    this.want = null;
    if (w?.resend) this.retake = { near: w.range.start, after: null, want: w };
    else if (this.retake) this.retake = { ...this.retake, after: null };
  }

  /** The room refused this editor's edit or op (`invalid`): put it back, say why. */
  refused(reason: string): void {
    this.trimming = false;
    this.settingsPending = false;
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
    const after = this.afterStruct;
    this.afterStruct = null;
    // The deck was drawn again for this op before this runs (changed comes after).
    if (after) this.win.setTimeout(() => after(op), 0);
  }

  structDenied(reason: LeaseDenial, by?: string): void {
    const n = this.trimming ? 1 : (this.open?.n ?? this.hooks.current());
    this.afterStruct = null;
    if (this.trimming) {
      this.trimming = false;
      this.putBack();
    }
    this.settingsPending = false;
    this.syncSettingsButtons();
    if (reason === "held" && by) this.notify(DECK_WORDS.held(by, n));
    else if (reason === "stale") this.notify(DECK_WORDS.changed);
  }

  notify(text: string): void {
    this.hooks.announce(text);
  }

  // ---------- blocks not edited in place ----------

  private askButton(label: string, run: () => void): HTMLButtonElement {
    const b = el(this.doc, "button", "plinth-slides__ask", label);
    b.type = "button";
    b.title = DECK_WORDS.readOnly;
    b.setAttribute("aria-description", DECK_WORDS.readOnly);
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
        this.askButton(DECK_WORDS.askImage, () => this.ask(v, `image-${imgIndex}`, "image")),
      );
      const del = el(this.doc, "button", "plinth-slides__ask", DECK_WORDS.delete);
      del.type = "button";
      del.addEventListener("click", () => this.deleteBlock(b, v));
      bar.append(del);
    } else {
      bar.append(
        this.askButton(DECK_WORDS.askBlock, () => this.ask(v, `block-${b.index}`, "block")),
      );
    }
    v.frame.append(bar);
    this.bar = bar;
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

  /** Opens the deck settings popover (the app's ⋯ "Deck settings…"). */
  openSettings(): void {
    if (!this.editing || !this.canWrite) return;
    this.closeSettings();
    const s = parseLaidOut(
      this.backend.lines,
      this.layout ?? deckLayout(this.backend.lines),
    ).settings;
    const pop = settingsPopover(this.doc, s, {
      apply: (next) => {
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
    pop.querySelector<HTMLElement>("input, select, button")?.focus();
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
    l.append(el(doc, "span", "plinth-slides__settings-label", label), control);
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
  check.append(paginate, el(doc, "span", "plinth-slides__settings-label", "Page numbers"));
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
