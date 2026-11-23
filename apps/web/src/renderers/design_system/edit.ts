// On-page editing of a design system (#36, docs/spec.md "Design systems"): the reference site
// drawn from the live draft, with every editable value in place. The draft is a line projection
// of system.json (designSystemLive.ts) held by the artifact's room, or by this frame alone (solo,
// local.ts); a lease is the lines of one JSON value, and each change writes that whole value
// canonically, checked here first with the same rules the room runs (dsValueProblem), so a refusal
// from the room means someone else changed the lines first.
//
// What a person edits:
// - token values, light and dark, with a control per type that keeps the stored form
//   (controls.ts); a token's description; adding and removing a dark value, a description or a
//   token (struct ops, designSystemStruct.ts); another token instead of a value, or back;
// - the system's name, and its description, the guidelines and each component's description and
//   usage as formatted text: the doc's own block editor (doc/edit.ts) over the part of the draft
//   that holds them (the guidelines' lines, or one JSON string), so no Markdown is shown;
// - a component's status, from its ⋯ ("Status").
// Renaming tokens and groups, component code, fonts, the prefix and the format stay with agents:
// each has "Comment", which posts `ask` with a structural anchor (token:<path>, group:<path>,
// component:<id>, system:settings) and the app opens the comments panel pinned there.
//
// One socket holds one lease at a time: whichever part of the page asks for it holds it, and the
// part that held it before sends what it has pending and lets go first.
import {
  applyDesignSystemStruct,
  type DesignSystem,
  type DsComponent,
  type DsIssue,
  type DsLiveNode,
  type DsPath,
  type DsStructOp,
  type DsTokenType,
  dsAliasOf,
  dsDeclaredType,
  dsGet,
  dsIndexNodes,
  dsLiveSystem,
  dsNodeAtPath,
  dsNodeLines,
  dsProjectionEnd,
  dsTokenSegs,
  dsTokenUsers,
  dsValueProblem,
  isDsName,
  joinLines,
  LIMITS,
  type LineRange,
  type LiveStructOp,
  parseDesignSystemValue,
  splitLines,
} from "@plinth/shared";
import type { ClientLease, LeaseDenial, LeaseLoss, LiveBackend } from "../common/live.ts";
import { DocEditor, type EditorHooks, type RescueItem, type RescueReport } from "../doc/edit.ts";
import { BlockMenu, type MenuGroup, type MenuItem } from "../doc/menu.ts";
import { samplePicker, starterValue, valueControl } from "./controls.ts";
import type { SystemBackend } from "./local.ts";
import type { PreviewTheme } from "./preview.ts";
import { renderProblems, renderSite, sectionId, sections, tokenPage } from "./render.ts";

export interface DsEditorHooks {
  save(): void;
  status(): void;
  /** Esc at the top level of edit mode: the app moves focus to its strip. */
  leave(): void;
  /** The version whose files the draft is drawn with (its base), or null for the page's own. */
  fileVersion(): number | null;
  /**
   * Comment on a place on the page: a fixed key, or a token, group or component by its
   * name, which the frame keys from the published version alone (boot.ts). The frame sends `text`
   * only when the published version has those words.
   */
  ask(anchor: DsAskAnchor): void;
  /**
   * A formatted text as the published version has it (`guidelines`, `description`,
   * `component:<id>:description|usage`; "" when it has none): its blocks name an Ask's anchor, as
   * a doc's do (doc/askAnchor.ts), so the agent finds the block in the version it reads.
   */
  publishedText?(key: string): string;
  theme(): PreviewTheme;
  /** The site was drawn from the draft: load its fonts (from the draft's base files). */
  drawn?(ds: DesignSystem): void;
  /**
   * The formatted texts' rescue stores changed (doc/edit.ts RescueReport): the app merges this
   * into its copy. Ids carry the text they belong to (rescueCode), and `n` orders these reports.
   */
  rescue?(report: RescueReport): void;
}

/** What the person is told when a change was not made. */
export const WORDS = {
  notSent: "Not connected. Try again in a moment.",
  held: (by: string) => `${by} is editing this. Try again when they finish.`,
  heldPlain: "Someone else is editing this. Try again when they finish.",
  stale: "The design system changed meanwhile. Try again.",
  frozen: "A newer version was published. Review it to go on.",
  frozenValue:
    "A newer version was published. Review it to go on: your change isn't in the draft yet, and goes in if the draft is kept.",
  watch: "You can follow the changes, but not make them here.",
  inUse: (users: string[]) =>
    `Used by ${users.slice(0, 3).join(", ")}${users.length > 3 ? ` and ${users.length - 3} more` : ""}. Change those first.`,
  invalid: "That value can't be used here, so it wasn't kept.",
  tooLarge: "That is more than a design system can hold, so it wasn't kept.",
  fromCode:
    "This design system is published from code. Its next publish from code won't include changes made here.",
} as const;

const NONE: unique symbol = Symbol("none");
/**
 * A lease request the room has not answered in this long (counted from when it was sent) means the
 * socket is stuck: it is closed and opened again, and every part asks again after the welcome. No
 * request is ever dropped while its socket is open, so no late answer is taken for another's.
 */
export const ASK_TIMEOUT_MS = 15_000;

/** One part of the page that may hold the socket's lease. */
interface LeaseOwner {
  granted(l: ClientLease): void;
  denied(reason: LeaseDenial, by?: string): void;
  lost(reason: LeaseLoss): void;
  /** Another part takes the lease: send what is pending and let go. */
  yield(): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const samePath = (a: DsPath, b: DsPath) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * What Comment points at: a fixed key (`system:settings`, a formatted text's block), or a
 * token, group or component by its name in the draft. The frame keys the named kinds from the
 * published version alone, so a name only the draft has never leaves the frame.
 */
export type DsAskAnchor =
  | { key: string; text: string }
  | { kind: DsAskKind; name: string; text: string };
export type DsAskKind = "token" | "group" | "component";

// ---------- the parts of the draft the doc's block editor edits ----------

/**
 * The guidelines: the draft's lines after the JSON part, as a doc of their own. Ranges move by the
 * JSON part's length, so the doc editor sees only Markdown lines.
 */
class GuidelinesDoc implements LiveBackend, LeaseOwner {
  editor: DocEditor | null = null;
  private cache: { src: readonly string[]; off: number; lines: string[] } | null = null;
  private mineCache: { src: ClientLease; off: number; out: ClientLease } | null = null;

  constructor(private readonly host: DsEditor) {}

  private get b(): SystemBackend {
    return this.host.backend;
  }

  private get off(): number {
    return this.view().off;
  }

  private view() {
    const src = this.b.lines;
    if (this.cache?.src !== src) {
      const off = dsProjectionEnd(src) + 1;
      this.cache = { src, off, lines: off > 0 ? src.slice(off) : [] };
    }
    return this.cache;
  }

  private shift(l: ClientLease, off: number): ClientLease {
    return { ...l, start: l.start - off, end: l.end - off };
  }

  get lines(): string[] {
    return this.view().lines;
  }
  get ready() {
    return this.b.ready;
  }
  get connected() {
    return this.b.connected;
  }
  get settled() {
    return this.b.settled;
  }
  get you() {
    return this.b.you;
  }
  get conflictVersion() {
    return this.b.conflictVersion;
  }
  get mine(): ClientLease | null {
    const m = this.b.mine;
    if (!m || !this.host.owns(this)) return null;
    const off = this.off;
    if (this.mineCache?.src !== m || this.mineCache.off !== off) {
      this.mineCache = { src: m, off, out: this.shift(m, off) };
    }
    return this.mineCache.out;
  }
  get leases(): Map<string, ClientLease> {
    const off = this.off;
    const out = new Map<string, ClientLease>();
    for (const [id, l] of this.b.leases) if (l.start >= off) out.set(id, this.shift(l, off));
    return out;
  }
  get ackedText() {
    return this.host.owns(this) ? this.b.ackedText : null;
  }
  get durableText() {
    return this.host.owns(this) ? this.b.durableText : null;
  }
  /**
   * The room's `keep` for the lease this part holds, and its edits' seqs and acks: the doc
   * editor's heartbeat and rescue store run on them. Absent alone (solo keeps a copy instead).
   */
  get keep(): (() => boolean) | undefined {
    const b = this.b;
    if (!b.keep) return undefined;
    return () => this.host.owns(this) && b.mine !== null && (b.keep?.() ?? false);
  }
  get lastSeq(): number | undefined {
    return this.b.lastSeq;
  }
  get acked(): ((seq: number) => boolean) | undefined {
    const b = this.b;
    return b.acked ? (seq: number) => b.acked?.(seq) ?? false : undefined;
  }

  lease(range: LineRange): boolean {
    const off = this.off;
    return this.host.ask(this, { start: range.start + off, end: range.end + off });
  }
  edit(text: string): boolean {
    if (!this.host.owns(this)) return false;
    this.host.sent(this);
    return this.b.edit(text);
  }
  release(): void {
    if (!this.host.owns(this)) return;
    this.b.release();
    this.host.drop(this);
  }
  takeover(id: string): boolean {
    return this.host.takeover(this, id);
  }

  granted(l: ClientLease): void {
    this.editor?.granted(this.shift(l, this.off));
  }
  denied(r: LeaseDenial, by?: string): void {
    this.editor?.denied(r, by);
  }
  lost(r: LeaseLoss): void {
    this.editor?.lost(r);
  }
  yield(): void {
    this.editor?.close(false);
  }
}

/**
 * One optional JSON string shown as formatted text (the description, a component's description
 * or usage), as a doc of its own: the doc editor's block leases are this frame's, and the room's
 * lease is on the value's one line. An absent value is created with set_text when the first words
 * are written, and removed with clear_text when it is emptied and let go.
 */
class TextValueDoc implements LiveBackend, LeaseOwner {
  editor: DocEditor | null = null;
  private local: string | null = null;
  private vmine: ClientLease | null = null;
  private want: LineRange | null = null;
  private creating: string | null = null;
  private letGo = false;
  /** This frame holds the value's line in the room, or has asked for it. */
  private held = false;
  private asking = false;
  ackedText: string | null = null;
  readonly durableText = null;
  private n = 0;
  /**
   * The doc editor's edits of the text, numbered (its `lastSeq`), and the last one the room has:
   * an edit counts as acknowledged (`acked`) once the room acknowledged the write that carried it,
   * so the doc editor's rescue store keeps typing until the room holds it, never only `local`.
   */
  private seq = 0;
  private inRoom = 0;
  /** The room edit (its socket seq) carrying local edit `k`, until the room acknowledges it. */
  private sentAs: { k: number; seq: number } | null = null;
  /** The local edit a set_text on its way carries. */
  private creatingK = 0;
  /** Text the room refused: not sent again until it changes. */
  private refusedText: string | null = null;

  constructor(
    private readonly host: DsEditor,
    /** The value's JSON path now (a component's index may move between versions). */
    private readonly path: () => DsPath | null,
    /** Its path as set_text and clear_text name it. */
    readonly textPath: string,
  ) {}

  private get b(): SystemBackend {
    return this.host.backend;
  }

  /** The value's JSON path now, or null. */
  currentPath(): DsPath | null {
    return this.path();
  }

  /** The value as the room has it ("" when absent). */
  private get roomValue(): string {
    const p = this.path();
    const v = p ? dsGet(this.host.system, p) : undefined;
    return typeof v === "string" ? v : "";
  }

  private get value(): string {
    return this.local ?? this.roomValue;
  }

  /** The text's lines: none for an empty text, so the first words are its only line. */
  get lines(): string[] {
    const v = this.value;
    return v === "" ? [] : splitLines(v);
  }
  get ready() {
    return this.b.ready;
  }
  get connected() {
    return this.b.connected;
  }
  get settled() {
    return this.b.settled;
  }
  get you() {
    return this.b.you;
  }
  get conflictVersion() {
    return this.b.conflictVersion;
  }
  get mine(): ClientLease | null {
    return this.vmine;
  }
  get leases(): Map<string, ClientLease> {
    const out = new Map<string, ClientLease>();
    const node = this.node();
    if (!node) return out;
    for (const [id, l] of this.b.leases) {
      if (l.id === this.b.mine?.id && this.host.owns(this)) continue;
      if (l.start < node.end && node.start < l.end) {
        out.set(id, { ...l, start: 0, end: this.lines.length });
      }
    }
    if (this.vmine) out.set(this.vmine.id, this.vmine);
    return out;
  }

  private node(): DsLiveNode | null {
    const p = this.path();
    return p ? this.host.nodeAt(p) : null;
  }

  /** The room's `keep` while this part holds the value's line (absent alone, as for a doc). */
  get keep(): (() => boolean) | undefined {
    const b = this.b;
    if (!b.keep) return undefined;
    return () => this.held && this.host.owns(this) && b.mine !== null && (b.keep?.() ?? false);
  }
  get lastSeq(): number {
    return this.seq;
  }
  get acked(): ((k: number) => boolean) | undefined {
    const b = this.b;
    if (!b.acked) return undefined;
    return (k: number) => {
      const s = this.sentAs;
      if (s && b.acked?.(s.seq)) {
        this.inRoom = Math.max(this.inRoom, s.k);
        this.sentAs = null;
      }
      return k <= this.inRoom;
    };
  }

  /**
   * Text typed here that the room does not have yet (on its way, or not sent because the line was
   * held or the creation refused): it counts as unsent changes, and goes once it can (retry).
   */
  get unsent(): boolean {
    const local = this.local;
    if (local === null || local === this.roomValue) return false;
    return !(local === "" && !this.node());
  }

  private grant(range: LineRange): void {
    this.vmine = { id: `t${++this.n}`, ...range, by: "", holder: "local", at: Date.now() };
    this.ackedText = joinLines(this.lines.slice(range.start, range.end));
    this.editor?.granted(this.vmine);
  }

  /** Ask the room for the value's line (once at a time); `granted` follows. */
  private ask(node: DsLiveNode): boolean {
    if (this.asking) return true;
    this.asking = true;
    if (this.host.ask(this, { start: node.start, end: node.end })) return true;
    this.asking = false;
    return false;
  }

  lease(range: LineRange): boolean {
    this.letGo = false;
    const node = this.node();
    if (!node || (this.held && this.host.owns(this) && this.b.mine)) {
      // Absent (set_text creates it with the first words), or held already: granted here, and no
      // answer from the room is this part's until it asks for the value's line.
      this.host.take(this);
      this.grant(range);
      return true;
    }
    this.want = range;
    return this.ask(node);
  }

  edit(text: string): boolean {
    const m = this.vmine;
    if (!m) return false;
    const ins = text === "" ? [] : text.split("\n");
    const lines = this.lines;
    const next = joinLines([...lines.slice(0, m.start), ...ins, ...lines.slice(m.end)]);
    const p = this.path();
    const system = this.host.system;
    if (!p || !system) return false;
    const problem = next === "" ? null : dsValueProblem(system, p, next);
    if (problem) {
      this.host.later(problem.message);
      return false;
    }
    this.local = next;
    this.seq += 1;
    this.refusedText = null;
    this.vmine = { ...m, end: m.start + ins.length, at: Date.now() };
    this.ackedText = text;
    this.push();
    this.editor?.changed();
    this.host.statusSoon();
    return true;
  }

  /**
   * Send the local text the way the value stands: its creation (set_text) when it is absent, an
   * edit of its line while this frame holds it, or a lease on its line first.
   */
  private push(): void {
    const local = this.local;
    if (local === null || this.creating !== null) return;
    const node = this.node();
    if (!node) {
      if (local === "") return;
      this.creating = local;
      this.creatingK = this.seq;
      if (!this.host.struct(this, { op: "set_text", path: this.textPath, value: local })) {
        this.creating = null;
      }
      return;
    }
    if (local === this.roomValue) {
      this.inRoom = this.seq;
      return;
    }
    if (this.held && this.host.owns(this) && this.b.mine) {
      this.host.sent(this);
      if (this.b.edit(dsNodeLines(node, local).join("\n"))) {
        const seq = this.b.lastSeq;
        if (seq === undefined) this.inRoom = this.seq;
        else this.sentAs = { k: this.seq, seq };
      }
      return;
    }
    this.ask(node);
  }

  /**
   * Send what the room does not have yet, once nothing else on the page holds the socket's lease
   * and nobody else holds the value's line (the draft changed, or a lease ended).
   */
  retry(): void {
    if (!this.unsent || this.asking || this.creating !== null || !this.b.connected) return;
    if (this.local === this.refusedText) return;
    if (!this.host.owns(this) && !this.host.idle) return;
    const node = this.node();
    const mine = this.b.mine?.id;
    if (
      node &&
      [...this.b.leases.values()].some(
        (l) => l.id !== mine && l.start < node.end && node.start < l.end,
      )
    ) {
      return;
    }
    this.push();
  }

  /**
   * The room refused this part's last write. A creation it denied (someone holds lines it
   * changes) is tried again once the place is free, and one it refused stays unsent until its
   * words change: either way its words stay. An edit of the value's line was refused because the
   * line changed first: the text is the room's again, as a doc block's is (the doc editor's
   * rescue store keeps typing it holds).
   */
  roomRefused(why: "denied" | "struct" | "edit"): void {
    if (why !== "edit") {
      this.creating = null;
      if (why === "struct") this.refusedText = this.local;
      return;
    }
    // The refused edits are never acknowledged: typing the rescue store keeps for them is written
    // again (the doc editor's refused()).
    this.sentAs = null;
    this.refusedText = null;
    this.local = null;
  }

  release(): void {
    this.letGo = true;
    this.vmine = null;
    if (!this.host.owns(this)) return;
    const node = this.node();
    if (node && this.local === "") {
      // Emptied: the key goes, never an empty string.
      this.host.struct(this, { op: "clear_text", path: this.textPath });
    } else if (this.held && this.b.mine) this.b.release();
    this.held = false;
    this.host.drop(this);
    this.settle();
  }

  takeover(): boolean {
    return false;
  }

  /** The room has the text this frame wrote: once let go, it reads it from the room again. */
  settle(): void {
    if (!this.letGo || this.local === null || this.creating !== null) return;
    if (this.local === this.roomValue || (this.local === "" && !this.node())) {
      this.local = null;
      this.inRoom = this.seq;
    }
  }

  landed(op: DsStructOp): void {
    if (op.op !== "set_text" || op.path !== this.textPath || this.creating === null) return;
    this.creating = null;
    this.inRoom = Math.max(this.inRoom, this.creatingK);
    if (this.letGo && this.local === this.roomValue) {
      this.local = null;
      return;
    }
    // Anything typed since goes now, on its own line.
    this.push();
  }

  granted(): void {
    this.asking = false;
    this.held = true;
    const w = this.want;
    this.want = null;
    if (w && !this.vmine) this.grant(w);
    this.push();
    // Asked for to send what was left unsent after the block closed: let go once it is sent.
    if (this.letGo && !this.vmine) this.release();
  }
  denied(r: LeaseDenial, by?: string): void {
    this.asking = false;
    this.want = null;
    this.editor?.denied(r, by);
  }
  lost(r: LeaseLoss): void {
    this.asking = false;
    this.held = false;
    this.vmine = null;
    this.editor?.lost(r);
  }
  yield(): void {
    this.editor?.close(false);
    this.held = false;
    this.asking = false;
  }
  /**
   * The socket closed before the room answered this part's request or its creation: it asks again,
   * or creates the text again (retry); the welcome's draft says whether the creation landed.
   */
  dropped(): void {
    this.asking = false;
    this.held = false;
    this.creating = null;
  }
}

/**
 * One token value (or the name, a description, a status): leased while it changes, then let go.
 *
 * A value the person set is never dropped in the frame. It waits (`want`) until the room grants
 * its lines: through edit mode ending, other parts' turns (a writer sends no lease request while
 * another is out, so each answer is matched to its own request), a reconnect and a freeze for
 * review. Once sent it is kept (`inFlight`) until the room acknowledges it or the draft holds it,
 * and it waits again when its edit is not taken (`not_held`, a lease lost or a socket closed
 * first). The room refusing it (`invalid`, `too_large`) or someone else holding its lines ends it,
 * and the person is told, with the value to copy.
 */
class ValueWriter implements LeaseOwner {
  private want: unknown = NONE;
  /** The value last sent, its socket seq and the lease it went on, until the room has it. */
  private inFlight: { value: unknown; seq: number | undefined; lease: string | null } | null = null;
  private held = false;
  private asked = false;
  /** The person just set it: it may take the socket's lease from a text that holds it. */
  private eager = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: DsEditor,
    readonly path: DsPath,
  ) {}

  /** A value set here that the room does not have yet: waiting, or sent and not acknowledged. */
  get pending(): boolean {
    return this.want !== NONE || this.inFlight !== null;
  }

  /** It asked for its lines and waits for the room's answer. */
  get waiting(): boolean {
    return this.asked && this.want !== NONE;
  }

  /** Write `value`: checked first; false when it is refused here. */
  write(value: unknown): boolean {
    const system = this.host.system;
    if (!system) return false;
    const problem = dsValueProblem(system, this.path, value);
    if (problem) {
      this.host.say(problemWords(problem));
      this.host.redrawSoon();
      return false;
    }
    this.want = value;
    this.eager = true;
    this.host.statusSoon();
    return this.go();
  }

  /** Send what waits: on the lease held, or ask for one when no other request is out. */
  private go(): boolean {
    if (this.want === NONE) return true;
    const b = this.host.backend;
    if (this.held && b.mine && this.host.owns(this)) return this.send();
    if (this.asked) return true;
    // Offline, frozen for review, or another request's answer still to come: it waits (retry).
    if (!b.connected || !b.ready || b.conflictVersion !== null || this.host.asking) return true;
    const node = this.host.nodeAt(this.path);
    if (!node) return this.gone();
    this.asked = true;
    if (!this.host.ask(this, { start: node.start, end: node.end })) {
      // Connected, yet the room takes no lease from this socket (watching).
      this.asked = false;
      this.end(WORDS.notSent);
      return false;
    }
    return true;
  }

  /** The value goes no further: the person is told, with it to copy. */
  private end(words: string): void {
    const v = this.want !== NONE ? this.want : this.inFlight?.value;
    this.want = NONE;
    this.inFlight = null;
    this.eager = false;
    this.host.drop(this);
    this.host.say(words, v === undefined ? undefined : this.host.copyAction(v));
    this.host.redrawSoon();
    this.host.statusSoon();
  }

  /** The token is gone from the draft: the value has nowhere to go. */
  private gone(): boolean {
    this.end(WORDS.stale);
    return false;
  }

  private send(): boolean {
    const node = this.host.nodeAt(this.path);
    const want = this.want;
    if (want === NONE) return true;
    if (!node) return this.gone();
    this.host.sent(this);
    const b = this.host.backend;
    const lease = b.mine?.id ?? null;
    // Not sent (the socket is closing): it stays, and goes after the reconnect.
    if (!b.edit(dsNodeLines(node, want).join("\n"))) return true;
    this.want = NONE;
    this.eager = false;
    this.inFlight = { value: want, seq: b.lastSeq, lease };
    this.host.statusSoon();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Out of edit mode the write was all it held the lines for.
    if (!this.host.editing) this.release();
    // Let go after a quiet moment, so others can change it too.
    else this.timer = setTimeout(() => this.release(), 1500);
    return true;
  }

  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.held && this.host.owns(this) && this.host.backend.mine) this.host.backend.release();
    this.held = false;
    this.host.drop(this);
  }

  /** The room has the value sent: it acknowledged it, or the draft holds it. */
  private landed(): boolean {
    const f = this.inFlight;
    if (!f) return true;
    const b = this.host.backend;
    if (f.seq !== undefined && b.acked?.(f.seq)) return true;
    return JSON.stringify(dsGet(this.host.system, this.path)) === JSON.stringify(f.value);
  }

  /** The draft changed: a value sent is done with once the room has it. */
  settle(): void {
    if (this.inFlight && this.landed()) {
      this.inFlight = null;
      this.host.statusSoon();
    }
  }

  /** A value sent that the room did not take waits again (unless a newer one does). */
  private again(): void {
    const f = this.inFlight;
    if (!f) return;
    const landed = this.landed();
    this.inFlight = null;
    if (!landed && this.want === NONE) this.want = f.value;
    this.host.statusSoon();
  }

  /**
   * The socket closed: a request it made is never answered, and a value sent that the room did
   * not acknowledge may not be in the draft. That value waits again.
   */
  dropped(): void {
    this.asked = false;
    this.held = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again();
    this.host.drop(this);
  }

  /** Its edit `seq` is the one on its way. */
  sent(seq: number): boolean {
    return this.inFlight !== null && this.inFlight.seq === seq;
  }

  /** The room answered its edit `not_held` (the lease went first): the value waits again. */
  notHeld(): void {
    this.held = false;
    this.again();
  }

  /** The room answered its edit with a denial (`frozen`, `watch`): it was not applied. */
  editDenied(r: LeaseDenial): void {
    this.held = false;
    this.again();
    if (this.want === NONE) return;
    if (r === "frozen") {
      this.host.say(WORDS.frozenValue, this.host.copyAction(this.want));
      this.host.statusSoon();
    } else this.end(denialWords(r));
  }

  /** The room refused the value sent (`invalid`, `too_large`): it is never sent again. */
  refused(words: string): void {
    const v = this.inFlight?.value;
    this.inFlight = null;
    this.host.say(words, v === undefined ? undefined : this.host.copyAction(v));
    this.host.redrawSoon();
    this.host.statusSoon();
  }

  /** The unpublished changes were discarded: so is what waits here. */
  discard(): void {
    this.want = NONE;
    this.inFlight = null;
    this.eager = false;
    this.asked = false;
    this.held = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Its request was answered with a lease it no longer takes (it went back to the room). */
  passed(): void {
    this.asked = false;
  }

  /**
   * Send what waits once no lease request is out and nothing else is in the way: a text holding
   * the socket's lease keeps it unless the person just set this value.
   */
  retry(): void {
    if (this.want === NONE || this.asked) return;
    const b = this.host.backend;
    if (!b.connected || !b.ready || !b.settled || b.structWaiting) return;
    if (b.conflictVersion !== null || this.host.asking) return;
    if (!this.eager && !this.host.owns(this) && !this.host.idle && !this.host.ownedByValue) return;
    this.go();
  }

  granted(): void {
    this.asked = false;
    this.held = true;
    // Nothing left to write (a discard, or the value ended meanwhile): the lines go back.
    if (this.want !== NONE) this.send();
    else this.release();
  }
  denied(r: LeaseDenial, by?: string): void {
    this.asked = false;
    this.host.drop(this);
    if (this.want === NONE) return;
    // The draft moved on while it asked: it asks again at the room's new rev (retry).
    if (r === "stale") return;
    // Frozen for review: it waits for the review's outcome, and the person sees it meanwhile.
    if (r === "frozen") {
      this.host.say(WORDS.frozenValue, this.host.copyAction(this.want));
      this.host.statusSoon();
      return;
    }
    this.end(r === "held" ? (by ? WORDS.held(by) : WORDS.heldPlain) : denialWords(r));
  }
  lost(): void {
    this.dropped();
  }
  yield(): void {
    if (this.held && this.want !== NONE) this.send();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    // A request not answered yet stays this writer's: its answer comes back to it.
  }
}

function denialWords(r: LeaseDenial): string {
  return r === "stale"
    ? WORDS.stale
    : r === "frozen"
      ? WORDS.frozen
      : r === "watch"
        ? WORDS.watch
        : WORDS.heldPlain;
}

/** A problem as a person reads it: the part named, then what is wrong. */
function problemWords(p: DsIssue): string {
  const where = p.path.replace(/^tokens\./, "").replace(/\.\$value$/, "");
  return `${where || "This"} ${p.message}.`;
}

/**
 * The short code a formatted text's rescue items carry in their ids (`<code>_<id>`), so the app's
 * one store per artifact holds every text's items and each comes back to its own text: "g" for the
 * guidelines, "d" for the description, and a hash of the key for a component's texts.
 */
export function rescueCode(key: string): string {
  if (key === "guidelines") return "g";
  if (key === "description") return "d";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `c${h.toString(36)}`;
}

// ---------- the editor ----------

interface TextPart {
  el: HTMLElement;
  editor: DocEditor;
  doc: GuidelinesDoc | TextValueDoc;
}

export class DsEditor {
  editing = false;
  /**
   * Published from code (the app's `edit` message says so, from the gate's `from_code`): starting
   * edit mode says that the next publish from code won't include the changes made here.
   */
  fromCode = false;
  backend: SystemBackend;
  /** The draft's system.json value, and the system it parses to (null when it does not). */
  system: Record<string, unknown> | null = null;
  parsed: DesignSystem | null = null;
  private problems: DsIssue[] = [];
  private seen: readonly string[] | null = null;
  private index: DsLiveNode[] = [];
  private owner: LeaseOwner | null = null;
  /**
   * The lease requests sent that the room has not answered, oldest first, and the part that made
   * each (range null: a takeover). The room answers each in order (leased or lease_denied), so the
   * first answer is always the first request's.
   */
  private asks: { owner: LeaseOwner; range: LineRange | null; at: number }[] = [];
  private askTimer: ReturnType<typeof setTimeout> | null = null;
  /** The part whose edit or op was sent last: a refusal from the room is about it. */
  private last: LeaseOwner | null = null;
  /** Whether that was a struct op (else an edit). */
  private lastStruct = false;
  /** Rescue reports sent to the app (`n`), with the text and the text's own report each was. */
  private rescueN = 0;
  private rescueReports: { n: number; key: string; local: number }[] = [];
  /** Items offered back whose text is not drawn yet (the system does not parse): offered later. */
  private unplaced: RescueItem[] = [];
  /** Items offered back for a text that is gone, kept by the guidelines: their ids as the app has them. */
  private readonly aliases = new Map<string, string>();
  private saveQueued = false;
  private readonly texts = new Map<string, TextPart>();
  private readonly writers = new Map<string, ValueWriter>();
  private readonly drawn = new Map<string, string>();
  private shape = "";
  private redrawQueued = false;
  private statusQueued = false;
  private notice: HTMLElement | null = null;
  private announcer: HTMLElement | null = null;
  private pendingFocus: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly win: Window,
    backend: SystemBackend,
    private readonly hooks: DsEditorHooks,
  ) {
    this.backend = backend;
    root.addEventListener("focusout", this.onFocusOut);
    root.addEventListener("keydown", this.onKey);
  }

  private get doc(): Document {
    return this.win.document;
  }

  setBackend(b: SystemBackend): void {
    if (this.owner) this.owner.yield();
    this.owner = null;
    this.asks = [];
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    for (const w of this.writers.values()) w.passed();
    this.backend = b;
    this.seen = null;
    this.refresh();
    for (const t of this.texts.values()) t.editor.render();
    this.draw();
  }

  // ---------- the draft ----------

  /** Reads the draft again when its lines changed. */
  private refresh(): void {
    const lines = this.backend.lines;
    if (lines === this.seen) return;
    this.seen = lines;
    this.index = dsIndexNodes(lines);
    this.system = dsLiveSystem(lines);
    const r = this.system ? parseDesignSystemValue(this.system) : null;
    this.parsed = r?.ok ? r.value : null;
    this.problems = r && !r.ok ? r.errors : [];
  }

  /** The lines of the value at `path` in the draft now, or null. */
  nodeAt(path: DsPath): DsLiveNode | null {
    this.refresh();
    return this.index.find((n) => samePath(n.path, path)) ?? null;
  }

  /** Too large to edit on the page (LIMITS.maxLiveProjectionLines). */
  get tooLarge(): boolean {
    return this.backend.lines.length > LIMITS.maxLiveProjectionLines;
  }

  // ---------- who holds the lease ----------

  /**
   * `o` holds the socket's lease from now (one it holds already, or one it asks for): the part
   * that held it before sends what it has pending and lets go.
   */
  take(o: LeaseOwner): void {
    if (this.owner && this.owner !== o) this.owner.yield();
    this.owner = o;
  }
  /** `o` asks the room for the lines `range`; the answer to this request goes to `o`. */
  ask(o: LeaseOwner, range: LineRange): boolean {
    this.take(o);
    // In the list before it is sent: the frame alone (local.ts) answers at once.
    const a = { owner: o, range, at: Date.now() };
    this.asks.push(a);
    if (this.backend.lease(range)) return this.armAsks();
    this.asks = this.asks.filter((x) => x !== a);
    return false;
  }
  /** `o` takes over the lease `id`; the answer goes to `o`. */
  takeover(o: LeaseOwner, id: string): boolean {
    this.take(o);
    const a = { owner: o, range: null, at: Date.now() };
    this.asks.push(a);
    if (this.backend.takeover(id)) return this.armAsks();
    this.asks = this.asks.filter((x) => x !== a);
    return false;
  }

  /**
   * Times the oldest request still unanswered, ASK_TIMEOUT_MS from when it was sent (once per
   * request: set again whenever the oldest changes). If it is still first then, the socket is
   * opened again (LiveBackend.reconnect), and `disconnected` sends every part to ask again.
   */
  private armAsks(): true {
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    const head = this.asks[0];
    if (!head) return true;
    this.askTimer = setTimeout(
      () => {
        this.askTimer = null;
        if (this.asks[0] === head) this.backend.reconnect?.();
      },
      Math.max(0, head.at + ASK_TIMEOUT_MS - Date.now()),
    );
    return true;
  }

  /** A request answered with an error (a takeover whose holder let go first): its part asks again. */
  private unanswered(a: { owner: LeaseOwner; range: LineRange | null } | undefined): void {
    if (!a) return;
    if (a.owner instanceof ValueWriter) a.owner.passed();
    else if (a.owner instanceof TextValueDoc) a.owner.dropped();
    // A text's block asks again as after a stale answer (doc/edit.ts denied).
    else if (a.owner === this.owner) a.owner.denied("stale");
  }
  drop(o: LeaseOwner): void {
    if (this.owner === o) this.owner = null;
  }
  owns(o: LeaseOwner): boolean {
    return this.owner === o;
  }
  sent(o: LeaseOwner): void {
    this.last = o;
    this.lastStruct = false;
  }
  /** A lease request is out, its answer still to come. */
  get asking(): boolean {
    return this.asks.length > 0;
  }
  /** No part holds the socket's lease or waits for one. */
  get idle(): boolean {
    return this.owner === null && this.asks.length === 0 && !(this.backend.structWaiting ?? false);
  }
  /** The socket's lease is a value's (held briefly), or nobody's. */
  get ownedByValue(): boolean {
    return this.owner === null || this.owner instanceof ValueWriter;
  }

  /**
   * The answer to the oldest request: the lease goes to the part that asked for exactly those
   * lines if it still holds the socket's turn, or to a value that asked and waits with no request
   * after it; otherwise it is nobody's, and goes back to the room.
   */
  granted(l: ClientLease): void {
    const head = this.asks.shift();
    this.armAsks();
    this.unowned = null;
    const fits =
      head && (head.range === null || (head.range.start === l.start && head.range.end === l.end));
    if (head && fits && head.owner === this.owner) {
      this.owner?.granted(l);
    } else if (
      head &&
      fits &&
      head.owner instanceof ValueWriter &&
      head.owner.waiting &&
      this.asks.length === 0 &&
      this.ownedByValue
    ) {
      this.take(head.owner);
      head.owner.granted();
    } else {
      if (head?.owner instanceof ValueWriter) head.owner.passed();
      // Nobody here holds it: it goes back to the room, so nobody else sees those lines held. With
      // a newer request out, that request's lease replaces it, unless it is refused (letGoUnowned).
      if (this.backend.mine?.id === l.id) {
        if (this.asks.length === 0) this.backend.release();
        else this.unowned = l.id;
      }
    }
    this.kick();
  }
  /** A lease the room granted that no part took, while a newer request was out. */
  private unowned: string | null = null;
  /** The last request was refused: a lease no part took goes back to the room. */
  private letGoUnowned(): void {
    const id = this.unowned;
    if (id === null || this.asks.length > 0) return;
    this.unowned = null;
    if (this.backend.mine?.id === id) this.backend.release();
  }
  denied(r: LeaseDenial, by?: string): void {
    const head = this.asks.shift();
    this.armAsks();
    this.letGoUnowned();
    if (!head) return;
    // A value's request is its own however the turn moved on; a text hears only while it asks.
    if (head.owner instanceof ValueWriter) head.owner.denied(r, by);
    else if (head.owner === this.owner) head.owner.denied(r, by);
    this.kick();
  }
  lost(r: LeaseLoss): void {
    this.owner?.lost(r);
  }
  disconnected(): void {
    // The requests the closed socket made are never answered: whoever made them asks again on
    // the reconnect, and what each was for waits meanwhile.
    this.asks = [];
    this.unowned = null;
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    for (const t of this.texts.values()) if (t.doc instanceof TextValueDoc) t.doc.dropped();
    for (const w of this.writers.values()) w.dropped();
    if (this.owner instanceof ValueWriter) this.owner = null;
    for (const t of this.texts.values()) t.editor.disconnected();
  }

  /**
   * The room answered a lease or takeover request with an error (`not_held`: a takeover of a lease
   * its holder let go first; `invalid`). The client matched the answer to the request (the room
   * answers in order), so it is the oldest one here: its part asks again.
   */
  leaseFailed(): void {
    this.unanswered(this.asks.shift());
    this.armAsks();
    this.letGoUnowned();
    this.kick();
  }

  /** The room answered a value's edit `seq` with `not_held` (its lease went first): it waits again. */
  notHeld(seq: number): void {
    for (const w of this.writers.values()) if (w.sent(seq)) w.notHeld();
    this.kick();
  }

  /** The room answered a value's edit `seq` with a denial (`frozen`, `watch`). */
  editDenied(r: LeaseDenial, seq: number): void {
    for (const w of this.writers.values()) if (w.sent(seq)) w.editDenied(r);
    this.kick();
  }

  /** The values waiting get their turn, once the current frames are handled. */
  private kick(): void {
    queueMicrotask(() => {
      for (const t of this.texts.values()) if (t.doc instanceof TextValueDoc) t.doc.retry();
      for (const w of this.writers.values()) w.retry();
    });
  }

  /** A notice's action that puts `value` (as the page writes it) on the clipboard. */
  copyAction(value: unknown): { label: string; run: () => void } {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { label: "Copy", run: () => this.copy(text) };
  }

  private copy(text: string): void {
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
        // No clipboard here either: the notice stays.
      }
      area.remove();
    };
    const clip = this.win.navigator.clipboard;
    if (clip?.writeText) void clip.writeText(text).catch(fallback);
    else fallback();
  }

  /** The unpublished changes were discarded: the values waiting are dropped with them. */
  clearValues(): void {
    for (const w of this.writers.values()) w.discard();
    if (this.owner instanceof ValueWriter) this.owner = null;
    this.statusSoon();
  }

  /** The room refused the last edit or op. */
  error(code: string): void {
    const last = this.last;
    this.last = null;
    if (last instanceof ValueWriter && !this.lastStruct) {
      last.refused(code === "too_large" ? WORDS.tooLarge : WORDS.invalid);
      return;
    }
    if (last instanceof TextValueDoc) last.roomRefused(this.lastStruct ? "struct" : "edit");
    if (last instanceof GuidelinesDoc || last instanceof TextValueDoc) {
      last.editor?.refused(code === "too_large" ? WORDS.tooLarge : WORDS.invalid);
      return;
    }
    this.say(code === "too_large" ? WORDS.tooLarge : WORDS.invalid);
    this.redrawSoon();
  }

  structDenied(r: LeaseDenial, by?: string): void {
    const last = this.last;
    this.last = null;
    // A text's creation that was refused stays unsent, and goes once the place is free.
    if (last instanceof TextValueDoc) last.roomRefused("denied");
    this.say(r === "held" ? (by ? WORDS.held(by) : WORDS.heldPlain) : denialWords(r));
  }

  structLanded(op: LiveStructOp): void {
    for (const t of this.texts.values()) {
      if (t.doc instanceof TextValueDoc) t.doc.landed(op as DsStructOp);
    }
  }

  /** Send a struct op for `from` (which lets go of what it holds first). */
  struct(from: LeaseOwner | null, op: DsStructOp): boolean {
    if (this.owner && this.owner !== from) this.owner.yield();
    // The room ends this socket's lease before it applies the op. A refusal of it is about this op
    // (and `from`, when a part sent it), never an earlier edit.
    this.last = from;
    this.lastStruct = true;
    if (!this.backend.struct(op)) {
      const local = this.backend as { refusal?: string | null };
      this.say(
        local.refusal === "in_use" && op.op === "remove_token"
          ? WORDS.inUse(this.system ? dsTokenUsers(this.system, op.path) : [])
          : local.refusal
            ? WORDS.invalid
            : WORDS.notSent,
      );
      return false;
    }
    return true;
  }

  // ---------- messages ----------

  /** The frame's own status line: what was not done, and why (with one thing to do about it). */
  say(text: string, action?: { label: string; run: () => void }): void {
    let el = this.notice;
    if (!el) {
      el = this.doc.createElement("div");
      el.className = "plinth-doc__notice ds-notice";
      el.setAttribute("role", "status");
      this.doc.body.append(el);
      this.notice = el;
    }
    const msg = this.doc.createElement("span");
    msg.textContent = text;
    const parts: HTMLElement[] = [msg];
    if (action) {
      const b = this.doc.createElement("button");
      b.type = "button";
      b.textContent = action.label;
      b.addEventListener("click", action.run);
      parts.push(b);
    }
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "plinth-doc__notice-close";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => this.hideNotice());
    el.replaceChildren(...parts, close);
  }

  /** Said after the doc editor's own words for the same refusal. */
  later(text: string): void {
    setTimeout(() => this.say(text), 0);
  }

  private hideNotice(): void {
    this.notice?.remove();
    this.notice = null;
  }

  /** A polite announcement (a token added, a value changed by someone else). */
  private announce(text: string): void {
    if (!this.announcer) {
      const a = this.doc.createElement("div");
      a.className = "ds-visually-hidden";
      a.setAttribute("role", "status");
      a.setAttribute("aria-live", "polite");
      this.doc.body.append(a);
      this.announcer = a;
    }
    this.announcer.textContent = "";
    this.announcer.textContent = text;
  }

  statusSoon(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      this.hooks.status();
    });
  }

  // ---------- turning editing on and off ----------

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (!on) {
      // A field being typed in is committed first (its `change`), so its value is written too.
      const active = this.doc.activeElement as HTMLElement | null;
      if (active && active !== this.doc.body && this.root.contains(active)) active.blur?.();
      // The texts close their blocks (sending what is pending) while they hold their leases; then
      // whatever else holds the socket's lease sends what it has and the lease is let go.
      for (const t of this.texts.values()) t.editor.setEditing(false);
      const o = this.owner;
      // A text that asked for a lease just now to write what it keeps (its typing, without its
      // formatting), or a value that asked for its lines, holds on to that request: its write goes
      // in once the lease comes, and the lease is let go after it.
      const keeping =
        (o instanceof ValueWriter && o.waiting) ||
        [...this.texts.values()].some((t) => t.doc === o && t.editor.pending);
      if (!keeping) {
        this.owner = null;
        o?.yield();
        if (this.backend.mine) this.backend.release();
      }
      this.hideNotice();
    }
    this.editing = on;
    if (on) for (const t of this.texts.values()) t.editor.setEditing(true);
    this.drawn.clear();
    this.draw();
    // Published from code: once each time edit mode starts, never blocking it.
    if (on && this.fromCode) {
      this.say(WORDS.fromCode);
    }
    this.statusSoon();
  }

  /**
   * Something in the frame holds text not written yet: typing to send, typing that cannot be
   * written as typed, kept to rescue, or a text's words the room does not have yet.
   */
  get pending(): boolean {
    if (this.unplaced.length > 0) return true;
    if ([...this.writers.values()].some((w) => w.pending)) return true;
    return [...this.texts.values()].some(
      (t) => t.editor.pending || (t.doc instanceof TextValueDoc && t.doc.unsent),
    );
  }
  get unsavable(): boolean {
    return [...this.texts.values()].some((t) => t.editor.unsavable);
  }

  /** Send whatever is waiting (collect, review, Publish). */
  flush(): void {
    for (const t of this.texts.values()) t.editor.flush();
  }

  /**
   * Publish (Cmd/Ctrl+S on the page, from any of its texts): once per keystroke, and never while a
   * text holds typing that cannot be written as typed, which is not in the draft.
   */
  save(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      // The text that holds it says so itself (UNSAVABLE).
      if (this.unsavable) return;
      this.hooks.save();
    });
  }

  /**
   * Solo: the draft with what is typed in each text that cannot be written as typed, without its
   * formatting (the app's kept copy), else null.
   */
  textWithTyping(): string | null {
    let lines: string[] | null = null;
    for (const t of this.texts.values()) {
      if (!t.editor.unsavable) continue;
      const typed = t.editor.textWithTyping();
      if (typed === null) continue;
      const now: string[] = lines ?? [...this.backend.lines];
      if (t.doc instanceof GuidelinesDoc) {
        const off = dsProjectionEnd(now) + 1;
        if (off <= 0) continue;
        lines = [...now.slice(0, off), ...(typed === "" ? [] : splitLines(typed))];
        continue;
      }
      const doc = t.doc;
      const path = doc.currentPath();
      const node = path ? dsNodeAtPath(now, path) : null;
      if (node) {
        lines = [...now.slice(0, node.start), ...dsNodeLines(node, typed), ...now.slice(node.end)];
      } else if (typed !== "") {
        const r = applyDesignSystemStruct(now, {
          op: "set_text",
          path: doc.textPath,
          value: typed,
        });
        if (typeof r !== "string") lines = r.lines;
      }
    }
    return lines ? joinLines(lines) : null;
  }

  // ---------- the rescue store (rooms) ----------

  /** A text's rescue report, for the app: its ids carry the text's code. */
  private reportRescue(key: string, r: RescueReport): void {
    const code = rescueCode(key);
    const id = (x: string) => this.aliases.get(`${key}\n${x}`) ?? `${code}_${x}`;
    const n = ++this.rescueN;
    this.rescueReports.push({ n, key, local: r.n });
    this.hooks.rescue?.({
      upsert: r.upsert.map((it) => ({ ...it, id: id(it.id) })),
      written: r.written.map(id),
      gone: r.gone.map(id),
      n,
    });
    for (const x of [...r.written, ...r.gone]) this.aliases.delete(`${key}\n${x}`);
  }

  /** The app's answer to report `n` and the ones before it: the ids its store holds. */
  rescueStored(ids: readonly string[], n: number): void {
    const upTo = new Map<string, number>();
    for (const r of this.rescueReports) {
      if (r.n <= n) upTo.set(r.key, Math.max(upTo.get(r.key) ?? 0, r.local));
    }
    this.rescueReports = this.rescueReports.filter((r) => r.n > n);
    const held = new Set(ids);
    for (const [key, local] of upTo) {
      const t = this.texts.get(key);
      if (!t) continue;
      const code = `${rescueCode(key)}_`;
      const mine: string[] = [];
      for (const id of held) if (id.startsWith(code)) mine.push(id.slice(code.length));
      for (const [k, full] of this.aliases) {
        if (k.startsWith(`${key}\n`) && held.has(full)) mine.push(k.slice(key.length + 1));
      }
      t.editor.rescueStored(mine, local);
    }
  }

  /**
   * Items the app kept from before a reload: each goes back to its own text, which writes what the
   * draft does not hold yet. One whose text is gone (a component removed meanwhile) goes into the
   * guidelines as a block of its own, never dropped.
   */
  offerRescue(items: readonly RescueItem[]): void {
    if (!this.parsed) {
      for (const it of items)
        if (!this.unplaced.some((u) => u.id === it.id)) this.unplaced.push(it);
      return;
    }
    const keys = ["guidelines", "description"];
    const list = this.system?.components;
    for (const c of Array.isArray(list) ? list : []) {
      if (!isObject(c) || typeof c.id !== "string") continue;
      keys.push(`component:${c.id}:description`, `component:${c.id}:usage`);
    }
    const byCode = new Map(keys.map((k) => [rescueCode(k), k]));
    const out = new Map<string, RescueItem[]>();
    for (const it of items) {
      const at = it.id.indexOf("_");
      let key = at > 0 ? byCode.get(it.id.slice(0, at)) : undefined;
      let id = at > 0 ? it.id.slice(at + 1) : "";
      if (!key || !id || !this.textEl(key)) {
        key = "guidelines";
        id = it.id.replace(/_/g, "-").slice(-40);
        this.aliases.set(`${key}\n${id}`, it.id);
      }
      const k = key;
      out.set(k, [...(out.get(k) ?? []), { ...it, id }]);
    }
    for (const [key, list] of out) {
      if (!this.textEl(key)) continue;
      this.texts.get(key)?.editor.offerRescue(list);
    }
    this.statusSoon();
  }

  /** The unpublished changes were discarded: so is everything kept to rescue, in every text. */
  clearRescues(): void {
    this.unplaced = [];
    for (const t of this.texts.values()) t.editor.clearRescues();
    this.aliases.clear();
  }

  /** The room's status changed (a review froze or ended): each text's rescue writes follow it. */
  roomStatus(): void {
    for (const t of this.texts.values()) t.editor.roomStatus();
  }

  /** `?edit`: the first thing to change, the name field, gets the focus. */
  focusFirst(): void {
    this.root.querySelector<HTMLElement>(".ds-name")?.focus();
  }

  /** Where another editor is: the page part of the line their lease starts at. */
  whereOf(line: number): string | undefined {
    this.refresh();
    const end = dsProjectionEnd(this.backend.lines);
    if (end >= 0 && line > end) return "Guidelines";
    const n = this.index.filter((x) => x.start <= line && line < x.end).at(-1);
    const p = n?.path;
    if (!p) return undefined;
    if (p[0] === "components" && typeof p[1] === "number" && this.parsed) {
      return this.parsed.components[p[1]]?.name.slice(0, 80);
    }
    if (p[0] === "tokens" || p[0] === "themes") return "Tokens";
    return "Overview";
  }

  // ---------- drawing ----------

  /** The backend's lines changed. */
  changed(): void {
    this.refresh();
    for (const t of this.texts.values()) {
      if (t.doc instanceof TextValueDoc) t.doc.settle();
      t.editor.changed();
    }
    this.update();
    if (this.unplaced.length > 0 && this.parsed) {
      const items = this.unplaced;
      this.unplaced = [];
      this.offerRescue(items);
    }
    for (const w of this.writers.values()) w.settle();
    // A text's words and the values the room does not have yet go once the place is free.
    this.kick();
  }

  redrawSoon(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    setTimeout(() => {
      this.redrawQueued = false;
      this.drawn.clear();
      this.update();
    }, 0);
  }

  /** The persistent element of a formatted text, created with its block editor on first use. */
  private textEl = (key: string): HTMLElement | null => {
    let t = this.texts.get(key);
    if (!t) {
      const made = this.makeText(key);
      if (!made) return null;
      t = made;
      this.texts.set(key, t);
    }
    return t.el;
  };

  private makeText(key: string): TextPart | null {
    let part: GuidelinesDoc | TextValueDoc;
    if (key === "guidelines") part = new GuidelinesDoc(this);
    else if (key === "description")
      part = new TextValueDoc(this, () => ["description"], "description");
    else {
      const m = /^component:([a-z][a-z0-9-]{0,47}):(description|usage)$/.exec(key);
      if (!m) return null;
      const id = m[1] as string;
      const field = m[2] as string;
      part = new TextValueDoc(
        this,
        () => {
          const list = this.system?.components;
          const i = Array.isArray(list) ? list.findIndex((c) => isObject(c) && c.id === id) : -1;
          return i < 0 ? null : ["components", i, field];
        },
        `components.${id}.${field}`,
      );
    }
    const el = this.doc.createElement("div");
    // An empty text in edit mode is named by what it holds, where it goes.
    const empty =
      key === "guidelines" ? "Guidelines" : key.endsWith(":usage") ? "Usage" : "Description";
    el.dataset.placeholder = empty;
    const prefix = key === "guidelines" ? "guidelines" : key;
    const hooks: EditorHooks = {
      save: () => this.save(),
      status: () => this.statusSoon(),
      rescue: (r) => this.reportRescue(key, r),
      leave: () => this.hooks.leave(),
      fileVersion: () => this.hooks.fileVersion(),
      ask: (anchor) =>
        this.hooks.ask({ key: `${prefix}:${anchor.key}`.slice(0, 128), text: anchor.text }),
      ...(this.hooks.publishedText
        ? { published: () => this.hooks.publishedText?.(key) ?? "" }
        : {}),
      empty,
    };
    const editor = new DocEditor(el, this.win, part, hooks);
    part.editor = editor;
    if (this.editing) editor.setEditing(true);
    editor.render();
    return { el, editor, doc: part };
  }

  private options() {
    return {
      editing: this.editing,
      text: this.textEl,
      fileVersion: this.hooks.fileVersion(),
    };
  }

  /** The site's shape: what makes a whole redraw necessary (its sections and the header). */
  private siteShape(): string {
    const ds = this.parsed;
    if (!ds) return `problems:${JSON.stringify(this.problems.slice(0, 10))}`;
    const hashes = sections(this.doc, ds, "light", { editing: this.editing }).map((s) => s.hash);
    return JSON.stringify([
      this.editing,
      this.hooks.fileVersion(),
      hashes,
      ds.name,
      ds.fonts,
      ds.prefix,
    ]);
  }

  /** What one section shows, to tell when it must be drawn again. */
  private sectionShape(hash: string): string {
    const ds = this.parsed;
    const sys = this.system;
    if (!ds || !sys) return "";
    if (hash === "overview") return "";
    if (hash.startsWith("components/")) {
      const id = hash.slice("components/".length);
      const c = ds.components.find((x) => x.id === id);
      return JSON.stringify([c, ds.css, ds.tokens.map((t) => [t.cssValue, t.darkCssValue])]);
    }
    return JSON.stringify(
      ds.tokens.filter((t) => tokenPage(t) === hash).map((t) => [t, this.rawToken(t.path)]),
    );
  }

  private rawToken(path: string) {
    const segs = path.split(".");
    return [
      dsGet(this.system, ["tokens", ...segs]),
      dsGet(this.system, ["themes", "dark", ...segs]),
    ];
  }

  /** Draw the whole site again (or the error page). */
  draw(): void {
    // Until the room sent the draft, the page shows the version it opened with.
    if (!this.backend.ready) return;
    this.refresh();
    const doc = this.doc;
    const ds = this.parsed;
    this.shape = this.siteShape();
    this.drawn.clear();
    if (!ds) {
      const ask =
        this.backend.you?.right === "write"
          ? () => this.askAbout("system:problems", "Problems")
          : undefined;
      this.root.replaceChildren(renderProblems(doc, this.problems, ask));
      return;
    }
    const site = renderSite(doc, ds, this.hooks.theme(), this.options());
    if (this.editing) this.decorate(site);
    for (const s of Array.from(site.querySelectorAll<HTMLElement>("[data-hash]"))) {
      this.drawn.set(s.dataset.hash ?? "", this.sectionShape(s.dataset.hash ?? ""));
    }
    this.root.replaceChildren(site);
    this.hooks.drawn?.(ds);
    for (const t of this.texts.values()) t.editor.render();
    this.placeFocus();
  }

  /** The draft changed: draw what it changed, never under the person's focus. */
  private update(): void {
    if (!this.backend.ready) return;
    if (this.siteShape() !== this.shape) {
      if (this.focusInside(this.root) && this.editing) this.deferUntilBlur(this.root);
      else this.draw();
      return;
    }
    const ds = this.parsed;
    if (!ds) return;
    const header = this.root.querySelector<HTMLElement>(".ds-header");
    if (header && this.editing) this.syncHeader(header);
    let rebuilt = false;
    for (const s of sections(this.doc, ds, this.hooks.theme(), this.options())) {
      const shape = this.sectionShape(s.hash);
      if (this.drawn.get(s.hash) === shape) continue;
      const old = this.root.querySelector<HTMLElement>(`#${CSS.escape(sectionId(s.hash))}`);
      if (!old) continue;
      if (s.hash.startsWith("tokens/") && this.editing) {
        if (this.updateRows(old, s.hash)) {
          this.drawn.set(s.hash, shape);
          continue;
        }
      }
      if (this.focusInside(old)) {
        this.deferUntilBlur(old);
        continue;
      }
      const node = s.build();
      node.id = sectionId(s.hash);
      node.setAttribute("data-hash", s.hash);
      if (this.editing) this.decorate(node);
      old.replaceWith(node);
      this.drawn.set(s.hash, shape);
      rebuilt = true;
    }
    // A section drawn again holds the same text elements, which draw their blocks again.
    if (rebuilt) for (const t of this.texts.values()) t.editor.render();
    this.placeFocus();
  }

  /**
   * A token section whose rows are the same tokens: each row that changed is drawn again, unless
   * the person is in it (it is drawn once they leave). False when the rows themselves changed.
   */
  private updateRows(section: HTMLElement, hash: string): boolean {
    const ds = this.parsed;
    if (!ds) return false;
    const fresh = sections(this.doc, ds, this.hooks.theme(), this.options()).find(
      (s) => s.hash === hash,
    );
    if (!fresh) return false;
    const next = fresh.build();
    if (this.editing) this.decorate(next);
    const keyOf = (r: Element) =>
      r.getAttribute("data-path") ?? `g:${r.getAttribute("data-group")}`;
    const oldRows = Array.from(section.querySelectorAll("tbody > tr"));
    const newRows = Array.from(next.querySelectorAll("tbody > tr"));
    if (oldRows.map(keyOf).join("\n") !== newRows.map(keyOf).join("\n")) {
      if (this.focusInside(section)) {
        this.deferUntilBlur(section);
        return true;
      }
      return false;
    }
    newRows.forEach((row, i) => {
      const old = oldRows[i] as HTMLElement;
      if (old.getAttribute("data-shape") === row.getAttribute("data-shape")) return;
      if (this.focusInside(old)) this.deferUntilBlur(old);
      else old.replaceWith(row);
    });
    themesHeading(section);
    return true;
  }

  private focusInside(el: Element): boolean {
    const a = this.doc.activeElement;
    return a !== null && a !== this.doc.body && el.contains(a);
  }

  private deferred = new Set<Element>();
  private recheck: ReturnType<typeof setTimeout> | null = null;
  /**
   * Draw `el` again once the focus has left it: on focusout, and on a timer too, since a focused
   * element that is removed (a form that closed) sends no focusout everywhere.
   */
  private deferUntilBlur(el: Element): void {
    this.deferred.add(el);
    if (!this.recheck) this.recheck = setTimeout(this.onFocusOut, 250);
  }

  private readonly onFocusOut = () => {
    if (this.deferred.size === 0) return;
    setTimeout(() => {
      if (this.recheck) clearTimeout(this.recheck);
      this.recheck = null;
      for (const el of [...this.deferred]) {
        if (!this.focusInside(el) || !el.isConnected) this.deferred.delete(el);
      }
      if (this.deferred.size === 0) {
        this.drawn.clear();
        this.update();
      } else this.recheck = setTimeout(this.onFocusOut, 250);
    }, 0);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.editing || e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      // A field's value is written when it changes: commit the one being typed in first.
      (this.doc.activeElement as HTMLElement | null)?.blur?.();
      e.preventDefault();
      this.flush();
      this.save();
      return;
    }
    if (e.key === "Escape") {
      const t = e.target as HTMLElement;
      if (t.closest(".plinth-doc__menu, .ds-form")) return;
      if (t.closest(".plinth-doc--editing")) return;
      this.hooks.leave();
    }
  };

  private placeFocus(): void {
    const want = this.pendingFocus;
    if (!want) return;
    const row = this.root.querySelector<HTMLElement>(`.ds-token[data-path="${CSS.escape(want)}"]`);
    if (!row) return;
    this.pendingFocus = null;
    row.querySelector<HTMLElement>("input, select")?.focus();
  }

  // ---------- edit mode: the controls ----------

  private writer(path: DsPath): ValueWriter {
    const key = JSON.stringify(path);
    let w = this.writers.get(key);
    if (!w) {
      w = new ValueWriter(this, path);
      this.writers.set(key, w);
    }
    return w;
  }

  private get canWrite(): boolean {
    return this.backend.you?.right === "write" && this.backend.conflictVersion === null;
  }

  /**
   * The place at `target` for a comment while the person picks one (common/pick.ts): a token, a
   * group or a component, as its Comment controls name them (boot.ts keys them from the published
   * version). Nothing closes.
   */
  placeAt(target: Node): { el: HTMLElement; anchor: DsAskAnchor } | null {
    const t = target.nodeType === 1 ? (target as Element) : target.parentElement;
    if (!t || !this.root.contains(t)) return null;
    const token = t.closest<HTMLElement>(".ds-token[data-path]");
    const path = token?.dataset.path;
    if (token && path) return { el: token, anchor: { kind: "token", name: path, text: path } };
    const group = t.closest<HTMLElement>(".ds-group[data-group]");
    const g = group?.dataset.group;
    if (group && g) return { el: group, anchor: { kind: "group", name: g, text: g } };
    const comp = t.closest<HTMLElement>(".ds-component[data-component]");
    const id = comp?.dataset.component;
    if (comp && id) {
      const name = comp.querySelector("h2")?.textContent?.trim() || id;
      return { el: comp, anchor: { kind: "component", name: id, text: name } };
    }
    return null;
  }

  /** Comment on a place on the page (the frame keeps draft names and words out). */
  private askAbout(anchor: string | { kind: DsAskKind; name: string }, text: string): void {
    this.hooks.ask(typeof anchor === "string" ? { key: anchor, text } : { ...anchor, text });
  }

  private menu(label: string, groups: () => MenuGroup[]): HTMLElement {
    const m = new BlockMenu(this.doc, groups, label);
    const box = this.doc.createElement("div");
    box.className = "ds-menu";
    box.append(m.button);
    return box;
  }

  /** Add the controls of edit mode to a drawn site, or one section of it. */
  private decorate(el: HTMLElement): void {
    const header = el.matches(".ds-site") ? el.querySelector<HTMLElement>(".ds-header") : null;
    if (header) this.decorateHeader(header);
    for (const row of Array.from(el.querySelectorAll<HTMLElement>(".ds-token[data-path]"))) {
      this.decorateToken(row);
    }
    for (const row of Array.from(el.querySelectorAll<HTMLElement>(".ds-group[data-group]"))) {
      this.decorateGroup(row);
    }
    themesHeading(el);
    const comps = el.matches(".ds-component")
      ? [el]
      : Array.from(el.querySelectorAll<HTMLElement>(".ds-component"));
    for (const c of comps) this.decorateComponent(c);
  }

  private decorateHeader(header: HTMLElement): void {
    const ds = this.parsed;
    if (!ds) return;
    const h1 = header.querySelector("h1");
    const name = this.doc.createElement("input");
    name.type = "text";
    name.className = "ds-name";
    name.value = ds.name;
    name.maxLength = 120;
    name.setAttribute("aria-label", "Design system name");
    name.disabled = !this.canWrite;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v === "") {
        this.say("The name may not be empty.");
        name.value = this.parsed?.name ?? "";
        return;
      }
      this.writer(["name"]).write(v);
    });
    h1?.replaceChildren(name);
    // Fonts and settings are agents' to change: the header's one ⋯.
    header.classList.add("ds-header--editing");
    header.append(
      this.menu(`${ds.name}: actions`, () => [
        {
          items: [
            {
              label: "Comment",
              run: () => this.askAbout("system:settings", "Fonts and settings"),
            },
          ],
        },
      ]),
    );
  }

  private syncHeader(header: HTMLElement): void {
    const name = header.querySelector<HTMLInputElement>(".ds-name");
    if (name && this.doc.activeElement !== name && this.parsed) name.value = this.parsed.name;
  }

  private decorateToken(row: HTMLElement): void {
    const ds = this.parsed;
    const sys = this.system;
    const path = row.dataset.path ?? "";
    const t = ds?.tokens.find((x) => x.path === path);
    const segs = dsTokenSegs(path);
    if (!t || !sys || !segs) return;
    const [light, darkNode] = this.rawToken(path);
    const lightValue = isObject(light) ? light.$value : undefined;
    const darkValue = isObject(darkNode) ? darkNode.$value : undefined;
    const description = isObject(light) ? light.$description : undefined;
    row.dataset.shape = JSON.stringify([t, light, darkNode]);
    row.classList.add("ds-token--editing");
    const info = row.querySelector<HTMLElement>(".ds-token__info");
    const values = row.querySelector<HTMLElement>(".ds-token__values");
    if (!info || !values) return;
    // Edit mode shows a light and a dark sample whenever there is a dark value, even one that is
    // the same, so each value has its sample (a colour's is its picker).
    const pair = row.querySelector<HTMLElement>(".ds-token__pair");
    const drawn = Array.from(pair?.querySelectorAll<HTMLElement>(":scope > .ds-sample") ?? []);
    if (pair && darkValue !== undefined && drawn.length === 1) {
      const one = drawn[0] as HTMLElement;
      const light = one.cloneNode(true) as HTMLElement;
      const dark = one.cloneNode(true) as HTMLElement;
      light.dataset.theme = "light";
      dark.dataset.theme = "dark";
      pair.replaceChildren(light, dark);
    }
    const samples = Array.from(pair?.querySelectorAll<HTMLElement>(":scope > .ds-sample") ?? []);
    // A composite's two sides are each a grid of parts, so they say which is which; one value a
    // side sits under its sample's column order, as the "Light" and "Dark" above the samples say.
    const composite = t.type === "shadow" || t.type === "border" || t.type === "typography";
    const controls = this.doc.createElement("div");
    controls.className = "ds-token__controls";
    const side = (which: "Light" | "Dark", value: unknown, valuePath: DsPath) => {
      const box = this.doc.createElement("div");
      box.className = composite ? "ds-token__side ds-token__side--parts" : "ds-token__side";
      if (darkValue !== undefined && composite) {
        const l = this.doc.createElement("span");
        l.className = "ds-token__side-name";
        l.textContent = which;
        box.append(l);
      }
      const ctx = {
        doc: this.doc,
        label: `${path}${darkValue !== undefined ? `, ${which.toLowerCase()}` : ""}`,
        targets: (type: DsTokenType) => this.targets(type, path),
        change: (v: unknown) => this.writer(valuePath).write(v),
        current: () => ({
          value: dsGet(this.system, valuePath),
          pending: this.writer(valuePath).pending,
        }),
        confirm: (q: string, yes: string, run: () => void) => this.confirm(box, q, yes, run),
        swatch: t.type !== "color",
      };
      const c = valueControl(ctx, t.type, value);
      const sample = samples[which === "Light" ? 0 : 1];
      if (t.type === "color" && dsAliasOf(value) === null && sample) {
        samplePicker(ctx, value, sample);
        const pick = sample.querySelector<HTMLInputElement>(".ds-sample__picker");
        if (pick) pick.disabled = !this.canWrite;
      }
      if (!this.canWrite) {
        for (const f of Array.from(c.querySelectorAll<HTMLInputElement>("input, select"))) {
          f.disabled = true;
        }
      }
      box.append(c);
      return box;
    };
    controls.append(side("Light", lightValue, ["tokens", ...segs, "$value"]));
    if (darkValue !== undefined) {
      controls.append(side("Dark", darkValue, ["themes", "dark", ...segs, "$value"]));
    }
    // The fields have a line of their own under the variable, at the same left edge in every row.
    values.remove();
    const line = info.querySelector(".ds-token__line");
    if (line) line.after(controls);
    else info.append(controls);
    // The description: a field when there is one (the menu adds one).
    const desc = row.querySelector<HTMLElement>(".ds-token__desc");
    if (typeof description === "string") {
      const field = this.descriptionField(path, segs, description);
      if (desc) desc.replaceWith(field);
      else info.append(field);
    }
    row.querySelector(".ds-token__alias")?.remove();
    info.append(
      this.menu(`${path}: actions`, () =>
        this.tokenMenu(row, path, segs, lightValue, darkValue, description),
      ),
    );
  }

  private descriptionField(path: string, segs: string[], value: string): HTMLElement {
    const f = this.doc.createElement("input");
    f.type = "text";
    f.className = "ds-field ds-token__desc-field";
    f.value = value;
    f.placeholder = "Description";
    f.setAttribute("aria-label", `${path}: description`);
    f.disabled = !this.canWrite;
    f.addEventListener("change", () => {
      const v = f.value.trim();
      const p: DsPath = ["tokens", ...segs, "$description"];
      const exists = dsGet(this.system, p) !== undefined;
      if (v === "") {
        if (exists) this.struct(null, { op: "clear_text", path: `tokens.${path}.$description` });
        return;
      }
      if (exists) this.writer(p).write(v);
      else this.struct(null, { op: "set_text", path: `tokens.${path}.$description`, value: v });
    });
    return f;
  }

  /** Tokens of `type` a value may name: every other one (the room refuses a cycle). */
  private targets(type: DsTokenType, self: string): string[] {
    return (this.parsed?.tokens ?? [])
      .filter((t) => t.type === type && t.path !== self)
      .map((t) => t.path);
  }

  /** The value an alias stands for, as its target stores it (a composite as its object). */
  private resolved(target: string): unknown {
    let at = target;
    for (let hops = 0; hops < 20; hops++) {
      const t = dsGet(this.system, ["tokens", ...at.split("."), "$value"]);
      const next = dsAliasOf(t);
      if (next === null) return t === undefined ? undefined : JSON.parse(JSON.stringify(t));
      at = next;
    }
    return undefined;
  }

  private tokenMenu(
    row: HTMLElement,
    path: string,
    segs: string[],
    light: unknown,
    dark: unknown,
    description: unknown,
  ): MenuGroup[] {
    const t = this.parsed?.tokens.find((x) => x.path === path);
    const write = this.canWrite;
    const value: MenuItem[] = [];
    if (dark === undefined) {
      value.push({
        label: "Add a dark value",
        disabled: !write,
        run: () => this.struct(null, { op: "set_dark", token: path, value: light }),
      });
    } else {
      value.push({
        label: "Remove dark value",
        disabled: !write,
        run: () => this.struct(null, { op: "clear_dark", token: path }),
      });
    }
    if (description === undefined) {
      value.push({
        label: "Add a description",
        disabled: !write,
        run: () => {
          const info = row.querySelector<HTMLElement>(".ds-token__info");
          const field = this.descriptionField(path, segs, "");
          info?.querySelector(".ds-menu")?.before(field);
          field.focus();
        },
      });
    }
    const alias = dsAliasOf(light);
    if (alias !== null) {
      value.push({
        label: "Use a value",
        disabled: !write,
        run: () => {
          const v = this.resolved(alias);
          if (v !== undefined) this.writer(["tokens", ...segs, "$value"]).write(v);
        },
      });
    } else if (t) {
      const others = this.targets(t.type, path);
      value.push({
        label: "Use another token",
        disabled: !write || others.length === 0,
        sub: others.slice(0, 500).map((p) => ({
          label: p,
          run: () => this.writer(["tokens", ...segs, "$value"]).write(`{${p}}`),
        })),
      });
    }
    return [
      { items: value },
      {
        items: [
          {
            label: "Comment to rename",
            run: () => this.askAbout({ kind: "token", name: path }, path),
          },
          {
            label: "Remove",
            disabled: !write,
            run: () => this.removeToken(row, path),
          },
        ],
      },
    ];
  }

  private removeToken(row: HTMLElement, path: string): void {
    const users = this.system ? dsTokenUsers(this.system, path) : [];
    if (users.length > 0) {
      this.say(WORDS.inUse(users));
      return;
    }
    const info = row.querySelector<HTMLElement>(".ds-token__info");
    if (!info) return;
    this.confirm(info, `Remove ${path}?`, "Remove", () => {
      if (this.struct(null, { op: "remove_token", path })) this.announce(`${path} removed`);
    });
  }

  /** A short question in place, with yes and Cancel (the frame cannot open the app's dialogs). */
  private confirm(near: HTMLElement, question: string, yes: string, run: () => void): void {
    near.querySelector(".ds-form")?.remove();
    const f = this.doc.createElement("div");
    f.className = "ds-form";
    f.setAttribute("role", "group");
    f.setAttribute("aria-label", question);
    const q = this.doc.createElement("span");
    q.className = "ds-form__question";
    q.textContent = question;
    const ok = this.doc.createElement("button");
    ok.type = "button";
    ok.className = "ds-button";
    ok.textContent = yes;
    const cancel = this.doc.createElement("button");
    cancel.type = "button";
    cancel.className = "ds-button ds-button--ghost";
    cancel.textContent = "Cancel";
    const done = () => f.remove();
    ok.addEventListener("click", () => {
      done();
      run();
    });
    cancel.addEventListener("click", () => {
      done();
      this.redrawSoon();
    });
    f.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done();
      }
    });
    // The two buttons wrap together, so on a phone the question has its line and they the next.
    const actions = this.doc.createElement("span");
    actions.className = "ds-form__actions";
    actions.append(ok, cancel);
    f.append(q, actions);
    near.append(f);
    cancel.focus();
  }

  private decorateGroup(row: HTMLElement): void {
    const group = row.dataset.group ?? "";
    const cell = row.querySelector<HTMLElement>("th");
    if (!cell) return;
    cell.append(
      this.menu(`${group || "Top level"}: actions`, () => [
        {
          items: [
            {
              label: "Add a token",
              disabled: !this.canWrite,
              run: () => this.addTokenForm(row, group),
            },
            ...(group
              ? [
                  {
                    label: "Comment to rename",
                    run: () => this.askAbout({ kind: "group", name: group }, group),
                  },
                ]
              : []),
          ],
        },
      ]),
    );
  }

  /** "Add a token": a name, and a type when the group gives none; the value is edited next. */
  private addTokenForm(row: HTMLElement, group: string): void {
    const cell = row.querySelector<HTMLElement>("th");
    if (!cell || !this.system) return;
    cell.querySelector(".ds-form")?.remove();
    const segs = group === "" ? [] : (dsTokenSegs(group) ?? []);
    const declared = dsDeclaredType(this.system, segs);
    const f = this.doc.createElement("form");
    f.className = "ds-form ds-form--add";
    f.setAttribute("aria-label", `Add a token to ${group || "the top level"}`);
    const name = this.doc.createElement("input");
    name.type = "text";
    name.className = "ds-field ds-form__name";
    name.placeholder = "Name";
    name.setAttribute("aria-label", "Token name");
    name.maxLength = 64;
    let type: HTMLSelectElement | null = null;
    if (declared === null) {
      type = this.doc.createElement("select");
      type.className = "ds-field ds-field--select";
      type.setAttribute("aria-label", "Token type");
      for (const k of [
        "color",
        "dimension",
        "fontFamily",
        "fontWeight",
        "duration",
        "cubicBezier",
        "number",
        "shadow",
        "typography",
        "border",
      ]) {
        const o = this.doc.createElement("option");
        o.value = k;
        o.textContent = k;
        type.append(o);
      }
    }
    const add = this.doc.createElement("button");
    add.type = "submit";
    add.className = "ds-button";
    add.textContent = "Add";
    const cancel = this.doc.createElement("button");
    cancel.type = "button";
    cancel.className = "ds-button ds-button--ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => f.remove());
    f.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        f.remove();
      }
    });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const n = name.value.trim();
      const container = dsGet(this.system, ["tokens", ...segs]);
      if (!isDsName(n)) {
        this.say("A name is 1 to 64 letters, digits, '-' or '_'.");
        return;
      }
      if (isObject(container) && Object.hasOwn(container, n)) {
        this.say(`${group ? `${group}.` : ""}${n} is already a token or group.`);
        return;
      }
      const t = (declared ?? type?.value ?? "color") as DsTokenType;
      const op: DsStructOp = {
        op: "add_token",
        group,
        name: n,
        value: starterValue(t),
        ...(declared === null ? { type: t } : {}),
      };
      const path = group ? `${group}.${n}` : n;
      // The form goes first, so the section is drawn again at once with the new row, whose value
      // takes the focus.
      f.remove();
      this.pendingFocus = path;
      if (this.struct(null, op)) this.announce(`${path} added`);
      else this.pendingFocus = null;
    });
    f.append(name, ...(type ? [type] : []), add, cancel);
    cell.append(f);
    name.focus();
  }

  private decorateComponent(section: HTMLElement): void {
    const id = section.dataset.component ?? "";
    const ds = this.parsed;
    const c = ds?.components.find((x) => x.id === id);
    if (!c || !ds) return;
    // Where the component is in the draft when the menu is used (it opens later than it is drawn).
    const at = () => {
      const list = this.system?.components;
      return Array.isArray(list) ? list.findIndex((x) => isObject(x) && x.id === id) : -1;
    };
    const statusNow = () => this.parsed?.components.find((x) => x.id === id)?.status ?? c.status;
    // The status stays the pill beside the name; it and Comment are the heading's one ⋯.
    const setStatus = (value: DsComponent["status"]) => {
      const i = at();
      if (i < 0) return;
      const p: DsPath = ["components", i, "status"];
      if (dsGet(this.system, p) !== undefined) this.writer(p).write(value);
      else if (value !== "stable") {
        this.struct(null, { op: "set_text", path: `components.${id}.status`, value });
      }
    };
    section.classList.add("ds-component--editing");
    section.querySelector("h2")?.after(
      this.menu(`${c.name}: actions`, () => [
        {
          items: [
            {
              label: "Status",
              disabled: !this.canWrite || at() < 0,
              sub: STATUSES.map(([value, label]) => ({
                label,
                checked: statusNow() === value,
                run: () => {
                  if (statusNow() !== value) setStatus(value);
                },
              })),
            },
            {
              label: "Comment",
              run: () => this.askAbout({ kind: "component", name: id }, c.name),
            },
          ],
        },
      ]),
    );
    // In edit mode the texts are labelled, so an empty one says what it is for.
    for (const key of ["description", "usage"] as const) {
      const el = section.querySelector<HTMLElement>(`[data-text="component:${id}:${key}"]`);
      el?.setAttribute("aria-label", `${c.name}: ${key}`);
    }
  }
}

const STATUSES: readonly (readonly [DsComponent["status"], string])[] = [
  ["stable", "Stable"],
  ["beta", "Beta"],
  ["deprecated", "Deprecated"],
];

/**
 * "Light" and "Dark" once above a token table's samples, in edit mode whenever a row shows a
 * light and a dark sample (a dark value the same as the light one included).
 */
function themesHeading(el: HTMLElement): void {
  const tables = el.matches(".ds-table")
    ? [el]
    : Array.from(el.querySelectorAll<HTMLElement>(".ds-table"));
  for (const table of tables) {
    const pairs = table.querySelector(".ds-token__pair > .ds-sample + .ds-sample") !== null;
    const head = table.querySelector(":scope > .ds-themes");
    if (pairs && !head) {
      const doc = table.ownerDocument;
      const h = doc.createElement("div");
      h.className = "ds-themes";
      h.setAttribute("aria-hidden", "true");
      for (const w of ["Light", "Dark"]) {
        const sp = doc.createElement("span");
        sp.textContent = w;
        h.append(sp);
      }
      table.prepend(h);
    } else if (!pairs && head) head.remove();
  }
}
