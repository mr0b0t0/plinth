// The board's live room: who is here, their cursors and selections (presence, at most 10 a
// second), a block moving while someone drags it (block.move), and a nudge to re-read a block or
// arrow someone just saved (block.saved, arrow.saved). The room keeps nothing: the board itself is
// shared data. Everything a peer sends is checked for shape before it is used.
//
// Who may change the board is the server's decision (the data API refuses writes below the board's
// floor), and the renderer follows it: a viewer may write when the session says so and, while the
// room is up, when the room lets them emit block.move. That is recomputed every time the room
// opens, so a version that lets only editors change the board turns a commenter's board read-only
// as soon as their socket reconnects.
import { isBoardId } from "@plinth/shared";
import type { RoomStatus, RuntimePeer, RuntimeRoom, RuntimeRoomReady } from "./runtime.ts";

/** Presence and moves go out at most this often (ms). */
export const SEND_MS = 100;

export interface LiveHooks {
  peers(list: RuntimePeer[]): void;
  /** A peer is dragging block `id` to (x, y). */
  moved(id: string, x: number, y: number): void;
  /** A peer saved this block or arrow: read it again. */
  saved(collection: "blocks" | "arrows", id: string): void;
  status(s: RoomStatus): void;
  /** Whether this viewer may change the board now. */
  canWrite(may: boolean): void;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A throttle that sends the newest value at most every SEND_MS. */
function throttled<T>(send: (v: T) => void): { push(v: T): void; flush(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    last = Date.now();
    const { v } = pending;
    pending = null;
    send(v);
  };
  return {
    push(v: T) {
      pending = { v };
      const wait = SEND_MS - (Date.now() - last);
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    },
    flush,
  };
}

export class Live {
  private ready: RuntimeRoomReady | null = null;
  private presence: { x: number | null; y: number | null; sel: string | null } = {
    x: null,
    y: null,
    sel: null,
  };
  private readonly cursor = throttled<void>(() => {
    this.room.presence({ ...this.presence });
  });
  private readonly move = throttled<{ id: string; x: number; y: number }>((m) => {
    this.room.emit("block.move", m);
  });

  constructor(
    private readonly room: RuntimeRoom,
    private readonly sessionCanWrite: boolean,
    private readonly hooks: LiveHooks,
  ) {}

  /** Connect, and wire the room's events. Resolves with what the room said. */
  async start(): Promise<RuntimeRoomReady> {
    const r = this.room;
    const ready = await r.ready;
    this.ready = ready;
    this.hooks.canWrite(this.mayWrite());
    if (!ready.available) return ready;
    r.onStatus((s) => {
      this.hooks.status(s);
      // A reconnect after the room's declaration changed carries the new rights.
      if (s === "open") this.hooks.canWrite(this.mayWrite());
    });
    r.onPeers((list) => this.hooks.peers(list));
    r.on("block.move", (d) => {
      if (typeof d !== "object" || d === null) return;
      const m = d as Record<string, unknown>;
      if (!isBoardId(m.id) || !finite(m.x) || !finite(m.y)) return;
      this.hooks.moved(m.id, m.x, m.y);
    });
    r.on("block.saved", (d) => this.onSaved("blocks", d));
    r.on("arrow.saved", (d) => this.onSaved("arrows", d));
    return ready;
  }

  private onSaved(collection: "blocks" | "arrows", d: unknown) {
    const id = typeof d === "object" && d !== null ? (d as { id?: unknown }).id : undefined;
    if (isBoardId(id)) this.hooks.saved(collection, id);
  }

  /** The session's answer, narrowed by the room's while the room is up. */
  mayWrite(): boolean {
    const r = this.ready;
    if (!this.sessionCanWrite) return false;
    return !r?.available || r.canEmit("block.move");
  }

  /** This viewer's pointer on the board (board units), or null when it left. */
  pointer(x: number | null, y: number | null): void {
    if (!this.ready?.available) return;
    this.presence.x = x === null ? null : Math.round(x);
    this.presence.y = y === null ? null : Math.round(y);
    if (x === null) {
      this.cursor.flush();
      this.room.presence({ x: null, y: null });
    } else this.cursor.push();
  }

  /** The block this viewer has selected, shown to the others. */
  select(id: string | null): void {
    if (!this.ready?.available || this.presence.sel === id) return;
    this.presence.sel = id;
    this.cursor.push();
  }

  /** A block being dragged: the others see it move. */
  moving(id: string, x: number, y: number): void {
    if (this.ready?.available && this.mayWrite()) this.move.push({ id, x, y });
  }

  /** The drag ended: send its last position now. */
  moved(): void {
    this.move.flush();
  }

  saved(topic: "block.saved" | "arrow.saved", id: string): void {
    if (this.ready?.available && this.ready.canEmit(topic)) this.room.emit(topic, { id });
  }
}
