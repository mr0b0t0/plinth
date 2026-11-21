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
// - a component's status.
// Renaming tokens and groups, component code, fonts, the prefix and the format stay with agents:
// each has "Ask an agent", which posts `ask` with a structural anchor (token:<path>, group:<path>,
// component:<id>, system:settings) and the app opens its Ask dialog.
//
// One socket holds one lease at a time: whichever part of the page asks for it holds it, and the
// part that held it before sends what it has pending and lets go first.
import {
  type DesignSystem,
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
  PAGE_ANCHOR_KEY_RE,
  PAGE_COMMENT_LIMITS,
  parseDesignSystemValue,
  splitLines,
} from "@plinth/shared";
import type { ClientLease, LeaseDenial, LeaseLoss, LiveBackend } from "../common/live.ts";
import { DocEditor, type EditorHooks } from "../doc/edit.ts";
import { BlockMenu, type MenuGroup, type MenuItem } from "../doc/menu.ts";
import { starterValue, valueControl } from "./controls.ts";
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
   * Ask an agent about a place on the page; `text` only words the published version has, and
   * `key` only a name it has (else `fallback`, the place).
   */
  ask(anchor: { key: string; text: string; fallback?: string }): void;
  theme(): PreviewTheme;
  /** The site was drawn from the draft: load its fonts (from the draft's base files). */
  drawn?(ds: DesignSystem): void;
}

/** What the person is told when a change was not made. */
export const WORDS = {
  notSent: "Not connected. Try again in a moment.",
  held: (by: string) => `${by} is editing this. Try again when they finish.`,
  heldPlain: "Someone else is editing this. Try again when they finish.",
  stale: "The design system changed meanwhile. Try again.",
  frozen: "A newer version was published. Review it to go on.",
  watch: "You can follow the changes, but not make them here.",
  inUse: (users: string[]) =>
    `Used by ${users.slice(0, 3).join(", ")}${users.length > 3 ? ` and ${users.length - 3} more` : ""}. Change those first.`,
  invalid: "That value can't be used here, so it wasn't kept.",
  tooLarge: "That is more than a design system can hold, so it wasn't kept.",
} as const;

const NONE: unique symbol = Symbol("none");
/** A range no lease ever has: a part that asked the room for nothing expects no answer. */
const NO_LINES: LineRange = { start: -1, end: -1 };

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
 * A structural anchor: its key by name, or by place when the name does not fit one, and the key by
 * place (`fallback`), which the frame sends instead when the name is not in the published version.
 */
function anchorKey(kind: string, name: string, index: number): { key: string; fallback: string } {
  const key = `${kind}:${name}`;
  const fallback = `${kind}:${index}`;
  return {
    key: key.length <= PAGE_COMMENT_LIMITS.maxKey && PAGE_ANCHOR_KEY_RE.test(key) ? key : fallback,
    fallback,
  };
}

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
    this.host.take(this, null);
    return this.b.takeover(id);
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
      this.host.take(this, NO_LINES);
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
      this.host.struct(this, { op: "set_text", path: this.textPath, value: local });
      return;
    }
    if (local === this.roomValue) return;
    if (this.held && this.host.owns(this) && this.b.mine) {
      this.host.sent(this);
      this.b.edit(dsNodeLines(node, local).join("\n"));
      return;
    }
    this.ask(node);
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
    if (this.local === this.roomValue || (this.local === "" && !this.node())) this.local = null;
  }

  landed(op: DsStructOp): void {
    if (op.op !== "set_text" || op.path !== this.textPath || this.creating === null) return;
    this.creating = null;
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
}

/** One token value (or the name, a description, a status): leased while it changes, then let go. */
class ValueWriter implements LeaseOwner {
  private want: unknown = NONE;
  private held = false;
  private asked = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: DsEditor,
    readonly path: DsPath,
  ) {}

  /** Write `value`: checked first; false when it is not sent. */
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
    const b = this.host.backend;
    if (this.held && b.mine && this.host.owns(this)) return this.send();
    if (this.asked) return true;
    const node = this.host.nodeAt(this.path);
    if (!node) return false;
    this.asked = true;
    if (!this.host.ask(this, { start: node.start, end: node.end })) {
      this.asked = false;
      this.want = NONE;
      this.host.say(WORDS.notSent);
      return false;
    }
    return true;
  }

  private send(): boolean {
    const node = this.host.nodeAt(this.path);
    const want = this.want;
    this.want = NONE;
    if (!node || want === NONE) return false;
    this.host.sent(this);
    if (!this.host.backend.edit(dsNodeLines(node, want).join("\n"))) {
      this.host.say(WORDS.notSent);
      this.host.redrawSoon();
      return false;
    }
    // Let go after a quiet moment, so others can change it too.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), 1500);
    return true;
  }

  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.held && this.host.owns(this) && this.host.backend.mine) this.host.backend.release();
    this.held = false;
    this.host.drop(this);
  }

  granted(): void {
    this.asked = false;
    this.held = true;
    this.send();
  }
  denied(r: LeaseDenial, by?: string): void {
    this.asked = false;
    this.want = NONE;
    this.host.say(r === "held" ? (by ? WORDS.held(by) : WORDS.heldPlain) : denialWords(r));
    this.host.redrawSoon();
  }
  lost(): void {
    this.held = false;
    this.asked = false;
  }
  yield(): void {
    if (this.held && this.want !== NONE) this.send();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held = false;
    this.asked = false;
    this.want = NONE;
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

// ---------- the editor ----------

interface TextPart {
  el: HTMLElement;
  editor: DocEditor;
  doc: GuidelinesDoc | TextValueDoc;
}

export class DsEditor {
  editing = false;
  backend: SystemBackend;
  /** The draft's system.json value, and the system it parses to (null when it does not). */
  system: Record<string, unknown> | null = null;
  parsed: DesignSystem | null = null;
  private problems: DsIssue[] = [];
  private seen: readonly string[] | null = null;
  private index: DsLiveNode[] = [];
  private owner: LeaseOwner | null = null;
  /** The lease request waiting for the room's answer, and the part that made it. */
  private expect: { owner: LeaseOwner; range: LineRange | null } | null = null;
  /** The part whose edit or op was sent last: a refusal from the room is about it. */
  private last: LeaseOwner | null = null;
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
   * `o` holds (or asks for) the socket's lease from now: the part that held it before sends what
   * it has pending and lets go. `range` is what it asks for (null: any, a takeover).
   */
  take(o: LeaseOwner, range: LineRange | null = null): void {
    if (this.owner && this.owner !== o) this.owner.yield();
    this.owner = o;
    this.expect = { owner: o, range };
  }
  /** `o` asks the room for the lines `range`; its answer goes to `o` only. */
  ask(o: LeaseOwner, range: LineRange): boolean {
    this.take(o, range);
    if (this.backend.lease(range)) return true;
    this.expect = null;
    return false;
  }
  drop(o: LeaseOwner): void {
    if (this.owner === o) this.owner = null;
    if (this.expect?.owner === o) this.expect = null;
  }
  owns(o: LeaseOwner): boolean {
    return this.owner === o;
  }
  sent(o: LeaseOwner): void {
    this.last = o;
  }

  /**
   * A lease granted to this socket goes to the part that asked for exactly those lines; one asked
   * for by a part that has since let go (another part asked after it) is not anyone's.
   */
  granted(l: ClientLease): void {
    const e = this.expect;
    if (!e || e.owner !== this.owner) return;
    if (e.range && (e.range.start !== l.start || e.range.end !== l.end)) return;
    this.expect = null;
    this.owner?.granted(l);
  }
  denied(r: LeaseDenial, by?: string): void {
    const e = this.expect;
    this.expect = null;
    if (e && e.owner === this.owner) this.owner?.denied(r, by);
  }
  lost(r: LeaseLoss): void {
    this.owner?.lost(r);
  }
  disconnected(): void {
    for (const t of this.texts.values()) t.editor.disconnected();
  }

  /** The room refused the last edit or op. */
  error(code: string): void {
    const last = this.last;
    this.last = null;
    if (last instanceof GuidelinesDoc || last instanceof TextValueDoc) {
      last.editor?.refused(code === "too_large" ? WORDS.tooLarge : WORDS.invalid);
      return;
    }
    this.say(code === "too_large" ? WORDS.tooLarge : WORDS.invalid);
    this.redrawSoon();
  }

  structDenied(r: LeaseDenial, by?: string): void {
    this.last = null;
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
    // The room ends this socket's lease before it applies the op: no answer is owed to anyone.
    this.expect = null;
    if (from) this.last = from;
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

  /** The frame's own status line: what was not done, and why. */
  say(text: string): void {
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
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "plinth-doc__notice-close";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => this.hideNotice());
    el.replaceChildren(msg, close);
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
      // The texts close their blocks (sending what is pending) while they hold their leases; then
      // whatever else holds the socket's lease sends what it has and the lease is let go.
      for (const t of this.texts.values()) t.editor.setEditing(false);
      const o = this.owner;
      this.owner = null;
      this.expect = null;
      o?.yield();
      if (this.backend.mine) this.backend.release();
      this.hideNotice();
    }
    this.editing = on;
    if (on) for (const t of this.texts.values()) t.editor.setEditing(true);
    this.drawn.clear();
    this.draw();
    this.statusSoon();
  }

  /** Something in the frame holds text not written yet. */
  get pending(): boolean {
    return [...this.texts.values()].some((t) => t.editor.pending);
  }
  get unsavable(): boolean {
    return [...this.texts.values()].some((t) => t.editor.unsavable);
  }

  /** Send whatever is waiting (collect, review, Publish). */
  flush(): void {
    for (const t of this.texts.values()) t.editor.flush();
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
    const prefix = key === "guidelines" ? "guidelines" : key;
    const hooks: EditorHooks = {
      save: () => this.hooks.save(),
      status: () => this.statusSoon(),
      leave: () => this.hooks.leave(),
      fileVersion: () => this.hooks.fileVersion(),
      ask: (anchor) =>
        this.hooks.ask({ key: `${prefix}:${anchor.key}`.slice(0, 128), text: anchor.text }),
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
      this.hooks.save();
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

  /** Ask an agent about a place on the page, with its anchor's name and words only when published. */
  private askAbout(anchor: string | { key: string; fallback: string }, text: string): void {
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
    // Fonts and settings are agents' to change.
    const line = this.doc.createElement("div");
    line.className = "ds-settings";
    const what = this.doc.createElement("span");
    const fonts = ds.fonts.map((f) => f.family).join(", ");
    what.textContent = `Fonts: ${fonts || "none"} · Prefix: ${ds.prefix}`;
    const ask = this.doc.createElement("button");
    ask.type = "button";
    ask.className = "ds-button ds-button--ghost";
    ask.textContent = "Ask an agent";
    ask.setAttribute("aria-label", "Change fonts or settings: Ask an agent");
    ask.title = "Change fonts or settings";
    ask.addEventListener("click", () => this.askAbout("system:settings", "Fonts and settings"));
    line.append(what, ask);
    header.append(line);
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
    const index = ds?.tokens.indexOf(t) ?? 0;
    const controls = this.doc.createElement("div");
    controls.className = "ds-token__controls";
    const side = (which: "Light" | "Dark", value: unknown, valuePath: DsPath) => {
      const box = this.doc.createElement("div");
      box.className = "ds-token__side";
      if (darkValue !== undefined) {
        const l = this.doc.createElement("span");
        l.className = "ds-token__side-name";
        l.textContent = which;
        box.append(l);
      }
      const c = valueControl(
        {
          doc: this.doc,
          label: `${path}${darkValue !== undefined ? `, ${which.toLowerCase()}` : ""}`,
          targets: (type) => this.targets(type, path),
          change: (v) => this.writer(valuePath).write(v),
          confirm: (q, yes, run) => this.confirm(box, q, yes, run),
        },
        t.type,
        value,
      );
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
    values.replaceWith(controls);
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
        this.tokenMenu(row, path, segs, index, lightValue, darkValue, description),
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
    index: number,
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
        label: "Remove the dark value",
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
            label: "Rename: Ask an agent",
            run: () => this.askAbout(anchorKey("token", path, index), path),
          },
          {
            label: "Remove this token",
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
    f.append(q, ok, cancel);
    near.append(f);
    cancel.focus();
  }

  private decorateGroup(row: HTMLElement): void {
    const group = row.dataset.group ?? "";
    const cell = row.querySelector<HTMLElement>("th");
    if (!cell) return;
    const index = Array.from(this.root.querySelectorAll(".ds-group")).indexOf(row);
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
                    label: "Rename: Ask an agent",
                    run: () => this.askAbout(anchorKey("group", group, Math.max(0, index)), group),
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
    f.className = "ds-form";
    f.setAttribute("aria-label", `Add a token to ${group || "the top level"}`);
    const name = this.doc.createElement("input");
    name.type = "text";
    name.className = "ds-field";
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
    const list = this.system?.components;
    const i = Array.isArray(list) ? list.findIndex((x) => isObject(x) && x.id === id) : -1;
    const title = section.querySelector("h2");
    const bar = this.doc.createElement("div");
    bar.className = "ds-component__bar";
    const status = this.doc.createElement("select");
    status.className = "ds-field ds-field--select";
    status.setAttribute("aria-label", `${c.name}: status`);
    for (const [v, label] of [
      ["stable", "Stable"],
      ["beta", "Beta"],
      ["deprecated", "Deprecated"],
    ] as const) {
      const o = this.doc.createElement("option");
      o.value = v;
      o.textContent = label;
      status.append(o);
    }
    status.value = c.status;
    status.disabled = !this.canWrite || i < 0;
    status.addEventListener("change", () => {
      const p: DsPath = ["components", i, "status"];
      if (dsGet(this.system, p) !== undefined) this.writer(p).write(status.value);
      else if (status.value !== "stable") {
        this.struct(null, { op: "set_text", path: `components.${id}.status`, value: status.value });
      }
    });
    bar.append(status);
    const index = ds.components.indexOf(c);
    bar.append(
      this.menu(`${c.name}: actions`, () => [
        {
          items: [
            {
              label: "Ask an agent to change this component",
              run: () => this.askAbout(anchorKey("component", id, index), c.name),
            },
          ],
        },
      ]),
    );
    title?.after(bar);
    // In edit mode the texts are labelled, so an empty one says what it is for.
    for (const key of ["description", "usage"] as const) {
      const el = section.querySelector<HTMLElement>(`[data-text="component:${id}:${key}"]`);
      el?.setAttribute("aria-label", `${c.name}: ${key}`);
    }
  }
}
