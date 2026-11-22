// The live draft socket client (#36): the renderer's side of the live draft in the artifact's room
// (apps/worker/src/rooms/doc.ts), shared by the doc, sheet and design system renderers. It lives
// inside the renderer bundles, never in the page runtime: /__plinth/runtime.js is not loaded in
// typed frames, where a heading id="plinth" would clobber it.
//
// Rules it keeps:
// - An op applies only when its `gen` is the room's current one and its `rev` is exactly the next;
//   anything else asks for a `sync`, and the welcome that answers replaces the state.
// - A `gen` it has not seen means the room reloaded the draft (an eviction, a wake): the lease
//   ended, and the editor (edit.ts) re-takes its block and resends what the room may have lost.
// - Reconnects back off 1, 2, 5, 10 then 30 s with jitter. A tab hidden for 60 s disconnects
//   unless it holds text the room has not written to D1 yet.
// - If the very first connection never opens, the client reports `failed` and stops, and the app
//   falls back to editing alone (solo).
// - A `struct` frame (a sheet's rows and columns, a deck's notes and settings) is applied with
//   the applier the renderer passes in (applySheetStruct, applySlidesStruct), exactly as the room
//   applied it; without one (a doc) it resyncs. A deck's op comes with its line map, and the
//   leases still held move by it.
// - While the draft is frozen for review, `conflictFiles` holds what the version it is frozen
//   against changed in the files (from `welcome` and `conflict`), for the review's files part.
import {
  blockLines,
  DS_TOKEN_TYPES,
  type FileChangeSummary,
  FOOTER_UNSAFE_RE,
  joinLines,
  LIMITS,
  type LineMap,
  type LineRange,
  type LiveDocErrorCode,
  type LiveDocServerFrame,
  type LiveStructOp,
  MAX_DECK_FOOTER,
  mapRange,
  ROOM_CLOSE,
  ROOM_PATH_PREFIX,
  ROOM_PROTOCOL,
  SHEET_COLUMN_TYPES,
  SHEET_NUMBER_STYLES,
  shiftRange,
  splitLines,
} from "@plinth/shared";

export const LIVE_BACKOFF_S = [1, 2, 5, 10, 30] as const;
export const HIDDEN_CLOSE_MS = 60_000;
export const PING_MS = 30_000;

/** A lease as the client sees it. `at` is when it last saw the holder lease or edit (ms). */
export interface ClientLease extends LineRange {
  id: string;
  /** The holder's email. */
  by: string;
  /** The holder's socket id, when known. */
  holder: string | null;
  at: number;
}

export type LeaseDenial = "held" | "stale" | "frozen" | "watch";
export type LeaseLoss = "takeover" | "rebased" | "closed" | "reconnect";

export interface LiveDocListener {
  /** The text or the leases changed: render again. */
  changed(): void;
  /** Something the app's status line shows changed. */
  status(): void;
  /** This socket's lease request was granted. */
  granted(lease: ClientLease): void;
  denied(reason: LeaseDenial, by?: string): void;
  /** This socket lost its lease. With "reconnect" and "rebased" the editor keeps its text. */
  lost(reason: LeaseLoss): void;
  /**
   * A version was saved, reset or merged onto, or froze the draft. `why` comes with a reset that
   * an editor's choice caused ("published", "discarded"); `was` is the version the draft was
   * frozen against before this frame (a reset or rebase that unfroze it), or null.
   */
  version(
    kind: "saved" | "reset" | "rebased" | "conflict",
    version: number,
    info: { why?: "published" | "discarded"; was: number | null },
  ): void;
  /**
   * The room refused a frame of this socket. `answers` says which, when the client can tell (the
   * room answers frames in order): an edit (its seq), a lease or takeover request, a release.
   */
  error(code: LiveDocErrorCode, answers?: Answered): void;
  /**
   * An edit of this socket was answered with a denial (`frozen`, `watch`), not applied. It is never
   * passed to `denied`, which answers lease requests only.
   */
  editDenied?(reason: LeaseDenial, seq: number): void;
  /** This socket's struct frame was refused (a sheet's rows or columns). */
  structDenied?(reason: LeaseDenial, by?: string): void;
  /** This socket's struct frame was applied (just before `changed`), with its op. */
  structLanded?(op: LiveStructOp): void;
}

/**
 * A frame of this socket the room has still to answer directly, by the `id` it carries (the room's
 * answer has it as `re`: docs/spec.md "Editing", the room protocol).
 */
type Due = { id: number } & (
  | { k: "lease" }
  | { k: "edit"; seq: number; lease: string }
  | { k: "release"; lease: string }
  | { k: "keep" }
  | { k: "struct" }
  | { k: "sync" }
);

/** Which frame an error answered: an edit (its seq), a lease or takeover request, a release. */
export type Answered = { edit: number } | { lease: true } | { release: true };

/** What an editor needs of the live draft: the room's (LiveDocClient) or a local copy (solo). */
export interface LiveBackend {
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
  /** A struct op this socket sent that the room has not answered yet (room only). */
  readonly structWaiting?: boolean;
  /** Close the socket and open it again (a room that stopped answering); room only. */
  reconnect?(): void;
  /** Say the held lease is in use though no edit is sent (the room's `keep`); room only. */
  keep?(): boolean;
  /** The seq of the last edit sent (room only), to ask `acked` about later. */
  readonly lastSeq?: number;
  /** Whether the room acknowledged this socket's edit `seq` (one of its recent ones). */
  acked?(seq: number): boolean;
}

type Socket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

export interface LiveDocOptions {
  win: Window;
  listener: LiveDocListener;
  /** For tests: makes the socket. */
  connect?: (url: string, protocols: string[]) => Socket;
  /** For tests: the random part of the backoff (0 to 1). */
  random?: () => number;
  /**
   * The editor holds text not in the draft yet (typing it cannot write as typed, or text it is
   * still to write): a hidden tab keeps its socket, as it does for unflushed text.
   */
  keepOpen?: () => boolean;
  /**
   * The editor may have several lease requests out at once and matches each answer to its own
   * request (by `re`): every `lease_denied` is passed on, not only the first after a request.
   * Without it, one denial is passed on per round of requests.
   */
  countLeases?: boolean;
  /**
   * Applies a struct frame's op to the lines (a sheet's applySheetStruct); absent for a doc. A
   * deck's ops (applySlidesStruct) and a design system's (applyDesignSystemStruct) also return
   * their line map: the room applies them while other leases are held, and every lease moves by
   * the map.
   */
  applyStruct?(
    lines: readonly string[],
    op: LiveStructOp,
  ): string[] | { lines: string[]; map: LineMap } | null;
}

/** The doc socket's URL on this content origin. */
export function docSocketUrl(loc: Pick<Location, "protocol" | "host">): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${ROOM_PATH_PREFIX}doc`;
}

interface PendingText {
  gen: string;
  /** How many parts; -1 until the first one says. */
  of: number;
  parts: string[];
  /** Applied once the text is complete. */
  apply: (text: string) => void;
}

/** One acked edit of this socket's block: the room's text of the block as of `rev`. */
interface Ack {
  rev: number;
  text: string;
}

export class LiveDocClient implements LiveBackend {
  lines: string[] = [];
  /** The text has arrived at least once. */
  ready = false;
  gen = "";
  rev = 0;
  baseVersion = 0;
  flushedRev = 0;
  conflictVersion: number | null = null;
  /** While frozen: the files the version it is frozen against changed since the base. */
  conflictFiles: FileChangeSummary | null = null;
  you: { id: string; email: string; right: "watch" | "write" } | null = null;
  leases = new Map<string, ClientLease>();
  mine: ClientLease | null = null;
  connected = false;
  failed = false;
  /** Why the room closed the socket for good (access changed, the artifact is gone). */
  ended: "unauthorized" | "gone" | null = null;
  dirty = false;
  /**
   * `dirty` is the room's word since this socket's welcome (a status frame, a reset or a rebase):
   * until then it is not known whether the draft holds edits.
   */
  dirtyKnown = false;
  editors: string[] = [];
  lastByYou = false;
  lastEditAt: string | null = null;

  private ws: Socket | null = null;
  private attempt = 0;
  private everWelcomed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pausedHidden = false;
  private stopped = false;
  private syncing = false;
  private pendingText: PendingText | null = null;
  private seq = 0;
  /**
   * The frames this socket sent that the room has not answered yet: each carries an `id`, and the
   * room's direct answer carries it back as `re`. A frame with no `re` answers nothing (a
   * `draft_limit` after a flush, a `released` that someone else's takeover caused), except, from a
   * room deployed before `re`, a denial, grant, ack or `kept` (matched by kind, oldest first).
   */
  private due: Due[] = [];
  private frameId = 0;
  private acks: Ack[] = [];
  /** The room's text of this socket's block as written to D1 (or as it was when leased). */
  private durable: string | null = null;
  /** Lease and takeover requests sent and not answered yet (at most 1 without `countLeases`). */
  private leaseAsks = 0;
  /** A struct frame sent and not answered yet. */
  private structPending = false;
  /** The seqs of this socket's recent edits the room acknowledged (its own `op`), newest last. */
  private ackedSeqs: number[] = [];
  /** `keep` frames sent and not answered yet (`kept`, or an error from a room that has none). */
  private keepsAwaiting = 0;
  /** The room answered a `keep` with `invalid` (deployed before it knew it): none is sent again. */
  private keepUnsupported = false;
  /** The latest rev made by this socket's own struct frame. */
  private ownStructRev = 0;

  constructor(private readonly opts: LiveDocOptions) {}

  /** The seq of this socket's newest edit the room has not answered, or null. */
  private get unacked(): number | null {
    for (let i = this.due.length - 1; i >= 0; i--) {
      const d = this.due[i] as Due;
      if (d.k === "edit") return d.seq;
    }
    return null;
  }

  /**
   * The frame `f` answers, taken off the list: the one whose id is its `re`. Without `re`, from a
   * room deployed before it, the oldest one `fits` (only for frames given `fits`).
   */
  private answer(f: { re?: number }, fits?: (d: Due) => boolean): Due | null {
    const i =
      f.re !== undefined
        ? this.due.findIndex((d) => d.id === f.re)
        : fits
          ? this.due.findIndex(fits)
          : -1;
    if (i < 0) return null;
    const [d] = this.due.splice(i, 1);
    return d ?? null;
  }

  /** Text this socket sent that the room has not written to D1 yet (beforeunload, hidden tabs). */
  get unflushed(): boolean {
    return (
      this.unacked !== null ||
      this.structPending ||
      this.ownStructRev > this.flushedRev ||
      this.acks.some((a) => a.rev > this.flushedRev)
    );
  }

  get structWaiting(): boolean {
    return this.structPending;
  }

  /** The room's text of this socket's block as of its last ack, for re-taking it. */
  get ackedText(): string | null {
    return this.acks.at(-1)?.text ?? this.durable;
  }

  /** The room's text of this socket's block as last written to D1, for re-taking it after a reload. */
  get durableText(): string | null {
    return this.durable;
  }

  get text(): string {
    return joinLines(this.lines);
  }

  /** No text transfer is in flight, so `lines` and `rev` are the room's. */
  get settled(): boolean {
    return this.pendingText === null;
  }

  start(): void {
    this.stopped = false;
    this.opts.win.document.addEventListener("visibilitychange", this.onVisibility);
    this.open();
  }

  /**
   * The room has not answered for too long: close this socket (its late answers are never read)
   * and open another, as after a drop, so every request is made again after the welcome.
   */
  reconnect(): void {
    const ws = this.ws;
    if (!ws || this.stopped) return;
    this.ws = null;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close(1000);
    } catch {
      // closing anyway
    }
    this.onClosed(1006);
  }

  stop(): void {
    this.stopped = true;
    this.opts.win.document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
    this.connected = false;
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (this.ping) clearInterval(this.ping);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.retry = null;
    this.hiddenTimer = null;
    this.ping = null;
    this.syncTimer = null;
  }

  private open(): void {
    if (this.stopped || this.ws) return;
    const url = docSocketUrl(this.opts.win.location);
    const make = this.opts.connect ?? ((u, p) => new WebSocket(u, p) as unknown as Socket);
    let ws: Socket;
    try {
      ws = make(url, [ROOM_PROTOCOL]);
    } catch {
      this.onClosed(1006);
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClosed(ev.code);
    };
    ws.onerror = () => undefined;
  }

  private onClosed(code: number): void {
    const was = this.connected;
    this.connected = false;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    if (this.mine) {
      this.mine = null;
      this.opts.listener.lost("reconnect");
    }
    this.due = [];
    this.structPending = false;
    this.keepsAwaiting = 0;
    this.leaseAsks = 0;
    if (code === ROOM_CLOSE.unauthorized || code === ROOM_CLOSE.gone) {
      this.ended = code === ROOM_CLOSE.gone ? "gone" : "unauthorized";
      this.stopped = true;
    } else if (!this.everWelcomed) {
      // The first connection never got through: edit alone instead.
      this.failed = true;
      this.stopped = true;
    }
    if (was || this.stopped) this.opts.listener.status();
    if (this.stopped || this.pausedHidden) return;
    const base = LIVE_BACKOFF_S[Math.min(this.attempt, LIVE_BACKOFF_S.length - 1)] ?? 30;
    this.attempt++;
    const jitter = 0.5 + (this.opts.random ?? Math.random)() * 0.5;
    this.retry = setTimeout(
      () => {
        this.retry = null;
        this.open();
      },
      base * 1000 * jitter,
    );
  }

  private readonly onVisibility = () => {
    const hidden = this.opts.win.document.visibilityState === "hidden";
    if (hidden) {
      if (this.hiddenTimer) return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        if (this.unflushed || this.opts.keepOpen?.() || !this.ws) return;
        this.pausedHidden = true;
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null;
        ws.close(1000);
        this.onClosed(1000);
      }, HIDDEN_CLOSE_MS);
      return;
    }
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.pausedHidden) {
      this.pausedHidden = false;
      this.open();
    }
  };

  private send(frame: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || !this.connected) return false;
    const raw = JSON.stringify(frame);
    if (
      raw.length * 3 > LIMITS.liveDocFrameBytes &&
      new TextEncoder().encode(raw).byteLength > LIMITS.liveDocFrameBytes
    ) {
      this.opts.listener.error("too_large");
      return false;
    }
    try {
      ws.send(raw);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- requests ----------

  /** Ask for the lines [start, end) (start === end: an insert point). */
  lease(range: LineRange): boolean {
    if (this.you?.right !== "write" || this.conflictVersion !== null) return false;
    const id = ++this.frameId;
    if (!this.send({ t: "lease", rev: this.rev, start: range.start, end: range.end, id })) {
      return false;
    }
    this.due.push({ id, k: "lease" });
    this.asked();
    return true;
  }

  /** Replace the whole leased range with `text`. */
  edit(text: string): boolean {
    const l = this.mine;
    if (!l) return false;
    const seq = ++this.seq;
    const id = ++this.frameId;
    if (!this.send({ t: "edit", lease: l.id, seq, text, id })) return false;
    this.due.push({ id, k: "edit", seq, lease: l.id });
    return true;
  }

  release(): void {
    const l = this.mine;
    if (!l) return;
    const id = ++this.frameId;
    if (this.send({ t: "release", lease: l.id, id }))
      this.due.push({ id, k: "release", lease: l.id });
  }

  takeover(leaseId: string): boolean {
    const id = ++this.frameId;
    if (!this.send({ t: "takeover", lease: leaseId, id })) return false;
    this.due.push({ id, k: "lease" });
    this.asked();
    return true;
  }

  private asked(): void {
    this.leaseAsks = this.opts.countLeases ? this.leaseAsks + 1 : 1;
  }
  /** A lease request was answered. */
  private answered(): void {
    this.leaseAsks = this.opts.countLeases ? Math.max(0, this.leaseAsks - 1) : 0;
  }

  get lastSeq(): number {
    return this.seq;
  }

  acked(seq: number): boolean {
    return this.ackedSeqs.includes(seq);
  }

  keep(): boolean {
    const l = this.mine;
    if (!l || !this.connected || this.keepUnsupported) return false;
    const id = ++this.frameId;
    if (!this.send({ t: "keep", lease: l.id, id })) return false;
    this.due.push({ id, k: "keep" });
    this.keepsAwaiting += 1;
    return true;
  }

  /**
   * A structural change: a sheet's rows or columns (applied by the room only while nobody else
   * holds a lease), or a deck's notes and settings or a design system's keys (while no lease
   * overlaps the lines it changes).
   */
  struct(op: LiveStructOp): boolean {
    if (this.you?.right !== "write" || this.conflictVersion !== null || !this.opts.applyStruct) {
      return false;
    }
    const id = ++this.frameId;
    if (!this.send({ t: "struct", rev: this.rev, op, id })) return false;
    this.due.push({ id, k: "struct" });
    this.structPending = true;
    return true;
  }

  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** A sync the room dropped (over the rate) is asked for again a second later. */
  private retrySync(): void {
    if (this.syncTimer || this.stopped) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (!this.stopped && this.ws) this.sync();
    }, 1000);
  }

  private sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    const id = ++this.frameId;
    if (this.send({ t: "sync", id })) this.due.push({ id, k: "sync" });
  }

  // ---------- frames ----------

  private onMessage(data: unknown): void {
    if (typeof data !== "string" || data === "pong") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const f = readServerFrame(raw);
    if (f) this.handle(f);
  }

  /** Exposed for tests: one validated frame. */
  handle(f: LiveDocServerFrame): void {
    const L = this.opts.listener;
    if (this.pendingText && f.t !== "text") {
      // A frame in the middle of a text transfer means the transfer was cut: start again.
      this.pendingText = null;
      this.sync();
    }
    switch (f.t) {
      case "welcome": {
        // The answer to this socket's sync, when it is one.
        this.answer(f);
        this.welcome(f);
        return;
      }
      case "text": {
        const p = this.pendingText;
        if (p && p.of === -1 && f.part === 0) p.of = f.of;
        if (!p || p.gen !== f.gen || f.part !== p.parts.length || f.of !== p.of) {
          this.pendingText = null;
          this.sync();
          return;
        }
        p.parts.push(f.chunk);
        if (p.parts.length === p.of) {
          this.pendingText = null;
          p.apply(p.parts.join(""));
        }
        return;
      }
      case "leased": {
        const lease: ClientLease = {
          id: f.lease,
          start: f.start,
          end: f.end,
          by: f.by,
          holder: f.holder,
          at: Date.now(),
        };
        this.leases.set(f.lease, lease);
        if (f.holder === this.you?.id) {
          this.mine = lease;
          this.answered();
          this.answer(f, (d) => d.k === "lease");
          this.acks = [];
          this.durable = joinLines(this.lines.slice(f.start, f.end));
          L.granted(lease);
        }
        L.changed();
        L.status();
        return;
      }
      case "lease_denied": {
        // A lease or takeover request's answer, or an edit's (frozen, watch): the first due.
        const d = this.answer(f, (x) => x.k === "lease" || x.k === "edit");
        if (d?.k === "edit") {
          L.editDenied?.(f.reason, d.seq);
          L.status();
          return;
        }
        if (this.leaseAsks === 0) return;
        this.answered();
        L.denied(f.reason, f.by);
        return;
      }
      case "op": {
        this.op(f);
        return;
      }
      case "struct": {
        this.struct_(f);
        return;
      }
      case "struct_denied":
        this.answer(f, (d) => d.k === "struct");
        if (!this.structPending) return;
        this.structPending = false;
        L.structDenied?.(f.reason, f.by);
        L.status();
        return;
      case "kept":
        this.answer(f, (d) => d.k === "keep");
        if (this.keepsAwaiting > 0) this.keepsAwaiting -= 1;
        return;
      case "released":
        // Only with `re` is it the answer to this socket's own release.
        this.answer(f);
        this.leases.delete(f.lease);
        if (this.mine?.id === f.lease) this.mine = null;
        L.changed();
        L.status();
        return;
      case "lease_lost":
        this.leases.delete(f.lease);
        if (this.mine?.id === f.lease) {
          this.mine = null;
          L.lost(f.reason);
        }
        L.changed();
        L.status();
        return;
      case "flushed": {
        this.flushedRev = Math.max(this.flushedRev, f.rev);
        const kept = this.acks.filter((a) => a.rev <= this.flushedRev).at(-1);
        if (kept) this.durable = kept.text;
        this.acks = this.acks.filter((a) => a.rev > this.flushedRev);
        L.status();
        return;
      }
      case "saved":
        this.baseVersion = f.version;
        L.version("saved", f.version, { was: this.conflictVersion });
        {
          L.status();
          return;
        }
      case "reset":
      case "rebased": {
        const kind = f.t;
        const gen = f.gen;
        this.pendingText = {
          gen,
          // `of` comes with the first text frame.
          of: -1,
          parts: [],
          apply: (text) => {
            const was = this.conflictVersion;
            this.lines = splitLines(text);
            this.rev = f.rev;
            this.gen = gen;
            this.baseVersion = f.version;
            this.conflictVersion = null;
            this.conflictFiles = null;
            this.dirty = kind === "rebased";
            this.dirtyKnown = true;
            L.changed();
            L.version(kind, f.version, {
              was,
              ...(f.t === "reset" && f.why ? { why: f.why } : {}),
            });
            L.status();
          },
        };
        return;
      }
      case "conflict": {
        const was = this.conflictVersion;
        this.conflictVersion = f.version;
        this.conflictFiles = f.files ?? null;
        this.dirty = true;
        L.version("conflict", f.version, { was });
        L.changed();
        L.status();
        return;
      }
      case "status":
        this.dirty = f.dirty;
        this.dirtyKnown = true;
        this.editors = f.editors;
        this.lastEditAt = f.last_edit_at;
        this.lastByYou = f.last_by_you;
        {
          L.status();
          return;
        }
      case "error": {
        // An error answers a frame only by its `re`; without one it answers nothing
        // (`draft_limit` after a flush) and goes to the editor as it is.
        const d = this.answer(f);
        if (d?.k === "sync") {
          // A sync dropped (over the rate): asked again in a moment.
          this.syncing = false;
          this.retrySync();
          return;
        }
        // The answer to a `keep`: a room deployed before `keep` refuses it as invalid, and one
        // whose lease went meanwhile (a takeover racing it) as not held. Neither concerns the
        // editor: no more `keep` to the first, and nothing to say about the second. (A room
        // deployed before `re` sends it with none, while nothing else waits for an answer.)
        if (
          d?.k === "keep" ||
          (d === null &&
            f.re === undefined &&
            (f.code === "invalid" || f.code === "not_held") &&
            this.keepsAwaiting > 0 &&
            this.unacked === null &&
            !this.structPending)
        ) {
          if (d === null) this.answer({}, (x) => x.k === "keep");
          if (this.keepsAwaiting > 0) this.keepsAwaiting -= 1;
          if (f.code === "invalid") this.keepUnsupported = true;
          return;
        }
        // A refused struct frame is answered with an error too (invalid, too_large).
        if (d?.k === "struct" || (d === null && this.structPending)) this.structPending = false;
        if (d?.k === "lease") this.answered();
        L.error(
          f.code,
          d?.k === "edit"
            ? { edit: d.seq }
            : d?.k === "lease"
              ? { lease: true }
              : d?.k === "release"
                ? { release: true }
                : undefined,
        );
        return;
      }
    }
  }

  private welcome(f: Extract<LiveDocServerFrame, { t: "welcome" }>): void {
    const fresh = f.gen !== this.gen;
    const holders = new Map<string, string>();
    for (const p of f.peers) if (p.lease) holders.set(p.lease, p.id);
    this.pendingText = {
      gen: f.gen,
      of: -1,
      parts: [],
      apply: (text) => {
        this.syncing = false;
        this.everWelcomed = true;
        this.attempt = 0;
        this.connected = true;
        this.ready = true;
        this.you = f.you;
        this.gen = f.gen;
        this.rev = f.rev;
        this.lines = splitLines(text);
        this.baseVersion = f.base_version;
        this.dirtyKnown = false;
        this.flushedRev = f.flushed_rev;
        this.conflictVersion = f.conflict_version;
        this.conflictFiles = f.conflict_version !== null ? (f.files ?? null) : null;
        this.lastByYou = f.last_by_you;
        const now = Date.now();
        const old = this.leases;
        this.leases = new Map(
          f.leases.map((l) => [
            l.id,
            {
              ...l,
              holder: holders.get(l.id) ?? null,
              at: old.get(l.id)?.at ?? now,
            },
          ]),
        );
        const mine = this.mine;
        if (mine && (fresh || !this.leases.has(mine.id))) {
          this.mine = null;
          this.opts.listener.lost("reconnect");
        } else if (mine) {
          this.mine = this.leases.get(mine.id) ?? null;
        }
        if (!this.ping) {
          this.ping = setInterval(() => {
            try {
              this.ws?.send("ping");
            } catch {
              // the close handler reconnects
            }
          }, PING_MS);
        }
        this.opts.listener.changed();
        this.opts.listener.status();
      },
    };
  }

  private struct_(f: Extract<LiveDocServerFrame, { t: "struct" }>): void {
    const apply = this.opts.applyStruct?.bind(this.opts);
    if (!apply || f.gen !== this.gen || f.rev !== this.rev + 1) {
      this.sync();
      return;
    }
    const applied = apply(this.lines, f.op);
    // A sheet's: the room applies it only while no other lease is held, and ends the sender's
    // first. A deck's comes with its line map, and every lease still held moves by it.
    const map = applied && !Array.isArray(applied) ? applied.map : null;
    const next = applied && !Array.isArray(applied) ? applied.lines : applied;
    if (!next || (map === null && this.leases.size > 0)) {
      this.sync();
      return;
    }
    if (map) {
      for (const [id, l] of this.leases) {
        const moved = mapRange(l, map, this.lines.length, next.length);
        if (!moved) {
          this.sync();
          return;
        }
        this.leases.set(id, { ...l, ...moved });
      }
      const own = this.mine ? this.leases.get(this.mine.id) : undefined;
      if (own) this.mine = own;
    }
    this.lines = next;
    this.rev = f.rev;
    this.lastByYou = f.by === this.you?.id;
    this.lastEditAt = new Date().toISOString();
    this.dirty = true;
    if (f.by === this.you?.id) {
      this.answer(f, (d) => d.k === "struct");
      this.structPending = false;
      this.ownStructRev = f.rev;
      this.opts.listener.structLanded?.(f.op);
    }
    this.opts.listener.changed();
    this.opts.listener.status();
  }

  private op(f: Extract<LiveDocServerFrame, { t: "op" }>): void {
    if (f.gen !== this.gen || f.rev !== this.rev + 1) {
      this.sync();
      return;
    }
    const ins = blockLines(f.ins);
    if (f.start + f.del > this.lines.length) {
      this.sync();
      return;
    }
    this.lines = [...this.lines.slice(0, f.start), ...ins, ...this.lines.slice(f.start + f.del)];
    this.rev = f.rev;
    const e = { start: f.start, del: f.del, ins: ins.length };
    const now = Date.now();
    for (const [id, l] of this.leases) {
      if (id === f.lease)
        this.leases.set(id, { ...l, start: f.start, end: f.start + ins.length, at: now });
      else this.leases.set(id, { ...l, ...shiftRange(l, e) });
    }
    const own = this.mine ? this.leases.get(this.mine.id) : undefined;
    if (own) this.mine = own;
    this.lastByYou = f.by === this.you?.id;
    this.lastEditAt = new Date(now).toISOString();
    this.dirty = true;
    if (f.by === this.you?.id && this.mine?.id === f.lease) {
      this.acks.push({ rev: f.rev, text: f.ins });
    }
    if (f.by === this.you?.id && f.seq !== undefined) {
      const seq = f.seq;
      this.answer(f, (d) => d.k === "edit" && d.seq === seq);
      this.ackedSeqs.push(f.seq);
      if (this.ackedSeqs.length > 64) this.ackedSeqs.shift();
    }
    this.opts.listener.changed();
    this.opts.listener.status();
  }
}

/**
 * Where `block` (a block's text) sits in `lines`, nearest to line `near`: the start line, or -1.
 * An empty block is an insert point at `near` (kept inside the text).
 */
export function locateBlock(lines: readonly string[], block: string, near: number): number {
  const want = blockLines(block);
  if (want.length === 0) return Math.max(0, Math.min(near, lines.length));
  let best = -1;
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k] !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok && (best === -1 || Math.abs(i - near) < Math.abs(best - near))) best = i;
  }
  return best;
}

// ---------- frame validation ----------
// The same rules as liveDocServerFrameSchema in @plinth/shared (live.test.ts checks that every
// frame this accepts, the schema accepts too), written out so the renderer bundle, which every
// doc viewer loads, does not carry zod.

const LEASE_RE = /^[A-Za-z0-9_-]{1,32}$/;
// A design system's projection may run past a doc's line limit.
const MAX_LINE = Math.max(LIMITS.maxLiveDocLines, LIMITS.maxLiveProjectionLines);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isLease = (v: unknown): v is string => typeof v === "string" && LEASE_RE.test(v);
const isLine = (v: unknown): v is number => isInt(v, 0, MAX_LINE);
const isEmail = (v: unknown): v is string => isStr(v, 254);
const isId = (v: unknown): v is string => isStr(v, 64);
const isGen = (v: unknown): v is string => isStr(v, 64, 1);
const isVersion = (v: unknown): v is number => isInt(v, 1);
const LEASE_REASONS = new Set(["held", "stale", "frozen", "watch"]);
const COLUMN_TYPES: ReadonlySet<string> = new Set(SHEET_COLUMN_TYPES);
const NUMBER_STYLES: ReadonlySet<string> = new Set(SHEET_NUMBER_STYLES);
const COLUMN_KEYS = new Set(["name", "type", "width", "format", "options"]);
const FORMAT_KEYS = new Set(["style", "decimals", "currency", "grouping"]);
const LETTERS_RE = /^[A-Z]{1,3}$/;
const isSheetRow = (v: unknown) => isInt(v, 2, LIMITS.maxSheetRows + 2);
const isRowCount = (v: unknown) => isInt(v, 1, LIMITS.maxSheetRows);
const onlyKeys = (o: Record<string, unknown>, keys: ReadonlySet<string>) =>
  Object.keys(o).every((k) => keys.has(k));

/** A new column's definition, as sheetColumnInputSchema checks it. */
function isColumnInput(c: unknown): boolean {
  if (!isObj(c) || !onlyKeys(c, COLUMN_KEYS) || !isStr(c.name, 100, 1)) return false;
  if (c.type !== undefined && !COLUMN_TYPES.has(c.type as string)) return false;
  if (c.width !== undefined && !isInt(c.width, 40, 800)) return false;
  if (c.format !== undefined) {
    const f = c.format;
    if (!isObj(f) || !onlyKeys(f, FORMAT_KEYS) || !NUMBER_STYLES.has(f.style as string)) {
      return false;
    }
    if (f.decimals !== undefined && !isInt(f.decimals, 0, 10)) return false;
    if (
      f.currency !== undefined &&
      !(typeof f.currency === "string" && /^[A-Z]{3}$/.test(f.currency))
    ) {
      return false;
    }
    if (f.grouping !== undefined && typeof f.grouping !== "boolean") return false;
  }
  if (c.options !== undefined) {
    const o = c.options;
    if (!Array.isArray(o) || o.length < 1 || o.length > 100) return false;
    if (!o.every((x) => isStr(x, 100, 1))) return false;
  }
  return true;
}

/** A struct frame's op, as liveStructOpSchema checks it. */
function isStructOp(op: unknown): boolean {
  if (!isObj(op)) return false;
  switch (op.op) {
    case "insert_rows":
      return (
        onlyKeys(op, new Set(["op", "before", "count"])) &&
        isSheetRow(op.before) &&
        isRowCount(op.count)
      );
    case "delete_rows":
      return (
        onlyKeys(op, new Set(["op", "from", "count"])) &&
        isSheetRow(op.from) &&
        isRowCount(op.count)
      );
    case "insert_columns":
      return (
        onlyKeys(op, new Set(["op", "before", "columns"])) &&
        typeof op.before === "string" &&
        LETTERS_RE.test(op.before) &&
        Array.isArray(op.columns) &&
        op.columns.length >= 1 &&
        op.columns.length <= LIMITS.maxSheetColumns &&
        op.columns.every(isColumnInput)
      );
    case "delete_columns":
      return (
        onlyKeys(op, new Set(["op", "from", "count"])) &&
        typeof op.from === "string" &&
        LETTERS_RE.test(op.from) &&
        isInt(op.count, 1, LIMITS.maxSheetColumns)
      );
    case "move_rows":
      return (
        onlyKeys(op, new Set(["op", "from", "count", "to"])) &&
        isSheetRow(op.from) &&
        isRowCount(op.count) &&
        isSheetRow(op.to)
      );
    // A design system's keys, as designSystemStructOpSchema checks them.
    case "set_dark":
      return (
        onlyKeys(op, new Set(["op", "token", "value"])) && isTokenPath(op.token) && "value" in op
      );
    case "clear_dark":
      return onlyKeys(op, new Set(["op", "token"])) && isTokenPath(op.token);
    case "set_text":
      return (
        onlyKeys(op, new Set(["op", "path", "value"])) &&
        isStr(op.path, 1200) &&
        isStr(op.value, LIMITS.liveDocFrameBytes)
      );
    case "clear_text":
      return onlyKeys(op, new Set(["op", "path"])) && isStr(op.path, 1200);
    case "add_token":
      return (
        onlyKeys(op, new Set(["op", "group", "name", "value", "type"])) &&
        (op.group === "" || isTokenPath(op.group)) &&
        typeof op.name === "string" &&
        TOKEN_NAME_RE.test(op.name) &&
        "value" in op &&
        (op.type === undefined || TOKEN_TYPES.has(op.type as string))
      );
    case "remove_token":
      return onlyKeys(op, new Set(["op", "path"])) && isTokenPath(op.path);
    case "add_notes":
    case "remove_notes":
      return onlyKeys(op, new Set(["op", "n"])) && isInt(op.n, 1, LIMITS.maxSlides);
    case "set_deck":
      return (
        onlyKeys(op, new Set(["op", "aspect", "theme", "paginate", "footer"])) &&
        (op.aspect === "16:9" || op.aspect === "4:3") &&
        (op.theme === "auto" || op.theme === "light" || op.theme === "dark") &&
        typeof op.paginate === "boolean" &&
        isStr(op.footer, MAX_DECK_FOOTER) &&
        !FOOTER_UNSAFE_RE.test(op.footer)
      );
    case "trim_start":
      return onlyKeys(op, new Set(["op"]));
    default:
      return false;
  }
}
const TOKEN_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATH_RE = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}$/;
const TOKEN_TYPES: ReadonlySet<string> = new Set(DS_TOKEN_TYPES);
const isTokenPath = (v: unknown): boolean => typeof v === "string" && TOKEN_PATH_RE.test(v);
const LOST_REASONS = new Set(["takeover", "rebased", "closed"]);
const FILE_KINDS = new Set(["added", "removed", "replaced", "same"]);

/** A frame's `files` (summarizeFileChanges), as liveFilesSchema checks it. */
function isFiles(v: unknown): boolean {
  if (!isObj(v) || !isInt(v.more) || !isInt(v.same)) return false;
  for (const k of ["added", "removed", "replaced"] as const) {
    const list = v[k];
    if (!Array.isArray(list) || list.length > 50) return false;
    for (const c of list) {
      if (!isObj(c) || !isStr(c.path, 512) || !FILE_KINDS.has(c.kind as string)) return false;
      if (c.before !== undefined && !isInt(c.before)) return false;
      if (c.after !== undefined && !isInt(c.after)) return false;
    }
  }
  return true;
}
const ERROR_CODES = new Set([
  "invalid",
  "too_large",
  "rate_limited",
  "not_held",
  "draft_limit",
  "unavailable",
]);

/** A frame from the room, checked field by field, or null. */
export function readServerFrame(raw: unknown): LiveDocServerFrame | null {
  if (!isObj(raw)) return null;
  const f = raw;
  // The id of this socket's frame it answers, on a direct answer only.
  if (f.re !== undefined && !isInt(f.re)) return null;
  const ok = (() => {
    switch (f.t) {
      case "welcome": {
        const you = f.you;
        if (f.v !== 1 || !isObj(you) || !isId(you.id) || !isEmail(you.email)) return false;
        if (you.right !== "watch" && you.right !== "write") return false;
        if (!isGen(f.gen) || !isInt(f.rev) || !isVersion(f.base_version) || !isInt(f.flushed_rev)) {
          return false;
        }
        if (f.conflict_version !== null && !isVersion(f.conflict_version)) return false;
        if (typeof f.last_by_you !== "boolean") return false;
        if (!Array.isArray(f.leases) || f.leases.length > 1000) return false;
        for (const l of f.leases) {
          if (!isObj(l) || !isLease(l.id) || !isLine(l.start) || !isLine(l.end) || !isEmail(l.by)) {
            return false;
          }
        }
        if (!Array.isArray(f.peers) || f.peers.length > 1000) return false;
        for (const p of f.peers) {
          if (!isObj(p) || !isId(p.id) || !isEmail(p.email)) return false;
          if (p.lease !== null && !isLease(p.lease)) return false;
        }
        return f.files === undefined || isFiles(f.files);
      }
      case "text":
        return isGen(f.gen) && isInt(f.part) && isInt(f.of, 1) && typeof f.chunk === "string";
      case "leased":
        return (
          isLease(f.lease) && isLine(f.start) && isLine(f.end) && isId(f.holder) && isEmail(f.by)
        );
      case "lease_denied":
        return LEASE_REASONS.has(f.reason as string) && (f.by === undefined || isEmail(f.by));
      case "op":
        return (
          isGen(f.gen) &&
          isInt(f.rev, 1) &&
          isLease(f.lease) &&
          isLine(f.start) &&
          isInt(f.del) &&
          typeof f.ins === "string" &&
          isId(f.by) &&
          (f.seq === undefined || isInt(f.seq))
        );
      case "struct":
        return isGen(f.gen) && isInt(f.rev, 1) && isStructOp(f.op) && isId(f.by);
      case "struct_denied":
        return LEASE_REASONS.has(f.reason as string) && (f.by === undefined || isEmail(f.by));
      case "released":
      case "kept":
        return isLease(f.lease);
      case "lease_lost":
        return isLease(f.lease) && LOST_REASONS.has(f.reason as string);
      case "flushed":
        return isInt(f.rev);
      case "saved":
        return isVersion(f.version) && isInt(f.rev);
      case "reset":
        return (
          isVersion(f.version) &&
          isGen(f.gen) &&
          isInt(f.rev) &&
          (f.why === undefined || f.why === "published" || f.why === "discarded")
        );
      case "rebased":
        return isVersion(f.version) && isGen(f.gen) && isInt(f.rev);
      case "conflict":
        return isVersion(f.version) && (f.files === undefined || isFiles(f.files));
      case "status":
        return (
          typeof f.dirty === "boolean" &&
          Array.isArray(f.editors) &&
          f.editors.length <= 50 &&
          f.editors.every(isEmail) &&
          (f.last_edit_at === null || isStr(f.last_edit_at, 40)) &&
          typeof f.last_by_you === "boolean"
        );
      case "error":
        return ERROR_CODES.has(f.code as string);
      default:
        return false;
    }
  })();
  return ok ? (f as LiveDocServerFrame) : null;
}
