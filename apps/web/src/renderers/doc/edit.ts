// On-page editing of a doc (#36), inside the doc renderer. The page shows the doc block by block
// (blocks.ts); in edit mode a click (or Enter) on a block asks for a lease on its lines, and once
// it is granted the block becomes a plain <textarea> holding that block's Markdown. Typing sends
// the whole block at most every 250 ms; Esc or moving focus elsewhere in the page releases it.
// Blocks other people hold show a bronze rule with their email and their text as it arrives.
//
// Two backends: the room's doc socket (live.ts, "room" mode), or a local copy of the text that
// only this frame edits ("solo" mode, where the app saves it through its own session). The
// editor never parses HTML from anyone: the textarea is created with createElement and filled
// through .value, and every rendered block went through the unchanged sanitizer first.
import { joinLines, LIMITS, type LineRange, rangesOverlap, splitLines } from "@plinth/shared";
import { type Block, BlockCache, parseBlocks, rangeOf, reconcile } from "./blocks.ts";
import { type ClientLease, type LeaseDenial, type LeaseLoss, locateBlock } from "./live.ts";

export const EDIT_DEBOUNCE_MS = 250;
const STALE_RETRIES = 3;

/** What the editor needs of the live draft: the room's (LiveDocClient) or a local one. */
export interface DocBackend {
  readonly lines: string[];
  readonly ready: boolean;
  readonly connected: boolean;
  readonly settled: boolean;
  readonly mine: ClientLease | null;
  readonly leases: Map<string, ClientLease>;
  readonly you: { id: string; email: string; right: "watch" | "write" } | null;
  readonly conflictVersion: number | null;
  /** The room's text of the held block as of the last ack, and as last written to D1. */
  readonly ackedText: string | null;
  readonly durableText: string | null;
  lease(range: LineRange): boolean;
  edit(text: string): boolean;
  release(): void;
  takeover(leaseId: string): boolean;
}

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

/** The editor's hooks into the frame: the save shortcut and status changes for the app. */
export interface EditorHooks {
  save(): void;
  status(): void;
}

interface Want extends LineRange {
  /** The block's text when asked for, to find it again if the lines moved meanwhile. */
  text: string;
  insert: boolean;
  /** Text to put in the field and send once granted (a block re-taken after a reconnect). */
  keep?: string;
  tries: number;
}

interface Pad {
  before: boolean;
  after: boolean;
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

export class DocEditor {
  editing = false;
  private readonly cache: BlockCache;
  private field: HTMLTextAreaElement | null = null;
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

  /** A block's text is waiting in the debounce, not yet sent. */
  get pending(): boolean {
    return this.timer !== null;
  }

  setBackend(b: DocBackend): void {
    this.backend = b;
  }

  // ---------- rendering ----------

  render(): void {
    const b = this.backend;
    if (!b.ready) return;
    const blocks = parseBlocks(joinLines(b.lines));
    // While a block is being re-taken (after a reconnect or a merge) its field stays where it was,
    // keeping the text and the focus.
    const retaking = this.field && this.want?.keep !== undefined && !b.mine ? this.held : null;
    const mine = this.editing && this.field ? (b.mine ?? retaking) : null;
    if (b.mine && mine === b.mine) this.held = { start: mine.start, end: mine.end };
    const others = this.editing ? [...b.leases.values()].filter((l) => l.id !== b.mine?.id) : [];
    const desired: Node[] = [];
    let placed = false;
    let ins = 0;
    const labelled = new Set<string>();
    const nextDecorated = new Set<Element>();
    const placeField = () => {
      if (mine && this.field && !placed) {
        desired.push(this.field);
        placed = true;
      }
    };
    const insertButton = (at: number) => {
      if (!this.editing || b.you?.right !== "write" || b.conflictVersion !== null) return;
      let btn = this.inserts[ins];
      if (!btn) {
        btn = this.doc.createElement("button");
        btn.type = "button";
        btn.className = "plinth-doc__insert";
        btn.textContent = "+";
        btn.setAttribute("aria-label", "Add a block here");
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
    insertButton(0);
    for (const block of blocks) {
      if (mine && overlaps(block, mine)) {
        placeField();
        continue;
      }
      if (mine && !placed && block.start >= mine.end) placeField();
      for (const l of others) {
        if (!overlaps(block, l) && !labelled.has(l.id) && l.end <= block.start) label(l);
      }
      const holder = others.find((l) => overlaps(block, l));
      if (holder) label(holder);
      for (const n of this.cache.nodes(block)) {
        desired.push(n);
        if (n.nodeType === 1) {
          const el = n as Element;
          this.decorate(el, holder !== undefined);
          if (this.editing || holder) nextDecorated.add(el);
        }
      }
      insertButton(block.end);
    }
    placeField();
    for (const l of others) label(l);
    this.cache.commit();
    for (const el of this.decorated) if (!nextDecorated.has(el)) this.undecorate(el);
    this.decorated = nextDecorated;
    for (const id of [...this.labels.keys()]) if (!labelled.has(id)) this.labels.delete(id);
    reconcile(this.root, desired);
    this.root.classList.toggle("plinth-doc--editing", this.editing);
    if (this.field) this.grow(this.field);
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

  private grow(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  // ---------- edit mode ----------

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    if (!on) this.close(true);
    this.editing = on;
    if (on) {
      this.root.addEventListener("click", this.onClick);
      this.root.addEventListener("keydown", this.onKey);
      this.win.addEventListener("keydown", this.onSaveKey);
    } else {
      this.root.removeEventListener("click", this.onClick);
      this.root.removeEventListener("keydown", this.onKey);
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
    if (!top || top === this.field) return;
    const at = this.insertAt.get(top);
    if (at !== undefined) {
      e.preventDefault();
      return this.openInsert(at);
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
    this.open(range);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.target === this.field) return this.onFieldKey(e);
    if (e.key !== "Enter") return;
    const top = this.topLevel(e.target);
    if (!top || top !== e.target) return;
    const range = rangeOf(top);
    if (!range) return;
    e.preventDefault();
    this.open(range);
  };

  private onFieldKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close(true, true);
    } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const from = this.held;
      // Focus stays on the block just closed (there may be no next one, and the next one opens
      // only once its lease arrives), never on the frame's body.
      this.close(true, true);
      if (!from) return;
      const blocks = parseBlocks(joinLines(this.backend.lines));
      const next = e.shiftKey
        ? blocks.filter((b) => b.end <= from.start).at(-1)
        : blocks.find((b) => b.start >= from.end && b.end > b.start);
      if (next) this.open(next);
    }
  }

  private heldBy(range: LineRange): ClientLease | undefined {
    const b = this.backend;
    for (const l of b.leases.values()) {
      if (l.id !== b.mine?.id && rangesOverlap(l, range)) return l;
    }
    return undefined;
  }

  /** Ask for a block's lines. */
  open(range: LineRange): void {
    const b = this.backend;
    if (!this.editing || !b.ready) return;
    if (b.you?.right !== "write") {
      this.showNotice("Sign in to edit this doc.");
      return;
    }
    if (b.conflictVersion !== null) {
      this.showNotice("Editing is paused until the changes are reviewed.");
      return;
    }
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other);
      return;
    }
    if (b.mine && b.mine.start === range.start && b.mine.end === range.end && this.field) {
      this.field.focus();
      return;
    }
    this.close(true);
    this.want = {
      start: range.start,
      end: range.end,
      text: joinLines(b.lines.slice(range.start, range.end)),
      insert: false,
      tries: 0,
    };
    if (!b.lease(range)) {
      this.want = null;
      this.showNotice("Not connected. Try again in a moment.");
    }
  }

  private openInsert(at: number): void {
    const b = this.backend;
    if (b.you?.right !== "write" || b.conflictVersion !== null) return;
    this.close(true);
    const range = { start: at, end: at };
    const other = this.heldBy(range);
    if (other) {
      this.explainHeld(other);
      return;
    }
    this.pad = { before: at > 0 && !isBlank(b.lines[at - 1]), after: !isBlank(b.lines[at]) };
    this.want = { ...range, text: "", insert: true, tries: 0 };
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

  // ---------- lease events (from the backend) ----------

  granted(lease: ClientLease): void {
    const w = this.want;
    this.want = null;
    if (!this.editing) {
      this.backend.release();
      return;
    }
    if (!w?.insert && w?.keep === undefined) this.pad = { before: false, after: false };
    const server = joinLines(this.backend.lines.slice(lease.start, lease.end));
    const field = this.field ?? this.makeField();
    // A re-taken block keeps what is in its field now (typed while the lease was away).
    const keep = w?.keep !== undefined ? (this.field?.value ?? w.keep) : undefined;
    field.value = keep ?? unpadded(server, this.pad);
    this.field = field;
    this.held = { start: lease.start, end: lease.end };
    this.hideNotice();
    this.render();
    field.focus();
    if (keep !== undefined && padded(keep, this.pad) !== server) this.schedule(0);
    this.hooks.status();
  }

  denied(reason: LeaseDenial, by?: string): void {
    const w = this.want;
    this.want = null;
    if (reason === "stale" && w && w.tries < STALE_RETRIES) {
      this.retake(w);
      return;
    }
    if (w?.keep !== undefined) {
      // The field stays where it was with its text, so nothing typed is lost; Escape closes it.
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
    const field = this.field;
    const held = this.held;
    this.cancelTimer();
    if (!field || !held || !this.editing) {
      this.field = null;
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
        keep: field.value,
        tries: 0,
      };
      return;
    }
    this.field = null;
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

  // ---------- the field ----------

  private makeField(): HTMLTextAreaElement {
    const el = this.doc.createElement("textarea");
    el.className = "plinth-doc__field";
    el.setAttribute("aria-label", "Edit this block (Markdown). Escape to finish.");
    el.spellcheck = true;
    el.rows = 1;
    if (this.win.matchMedia?.("(pointer: coarse)").matches) el.style.fontSize = "16px";
    el.addEventListener("input", () => {
      this.grow(el);
      this.schedule(EDIT_DEBOUNCE_MS);
    });
    el.addEventListener("blur", () => {
      // Leaving the frame (the app's bar, another window) keeps the block; moving to another
      // place in the page ends it.
      setTimeout(() => {
        if (this.field !== el || this.doc.activeElement === el || !this.doc.hasFocus()) return;
        if (this.want?.keep !== undefined) return;
        this.close(true);
      }, 0);
    });
    return el;
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

  private send(): void {
    const f = this.field;
    if (!f || !this.backend.mine) return;
    const text = padded(f.value, this.pad);
    if (new TextEncoder().encode(text).byteLength > LIMITS.liveDocFrameBytes - 256) {
      this.showNotice("This block is too long to send. Split it into smaller blocks.");
      return;
    }
    this.backend.edit(text);
  }

  /** Send a pending block now. */
  flush(): void {
    if (!this.timer) return;
    this.cancelTimer();
    this.send();
  }

  /** Close the open block: send what is pending, release the lease, show the block again. */
  close(release: boolean, refocus = false): void {
    const field = this.field;
    const held = this.held;
    this.want = null;
    if (!field) return;
    this.flush();
    if (release && this.backend.mine) this.backend.release();
    this.field = null;
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

  /** For tests and the status line. */
  get fieldElement(): HTMLTextAreaElement | null {
    return this.field;
  }
}

function overlaps(block: Block | LineRange, l: LineRange): boolean {
  if (block.start === block.end) return false;
  return rangesOverlap(block, l);
}
