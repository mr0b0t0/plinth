// The live room of one artifact (#36): a Durable Object, one per artifact (idFromName(artifact
// id)), reached only through the ROOMS binding, from the upgrade gate (content/room.ts) and from
// Worker RPC (rooms/notify.ts). Never from the internet: the gate builds a fresh request that
// carries only the x-plinth-room header, made from a checked content pass and policy.ts.
//
// It uses the WebSocket Hibernation API: an idle room is evicted from memory while its sockets
// stay open, and wakes for the next message. What a socket is (who, which rights, which rooms and
// presence) lives in its attachment, so nothing is lost on a wake. Nothing persists: the object
// writes no storage tables, only its alarm, which re-checks access in D1 while sockets are open.
// Message contents are never logged.
//
// A doc artifact's room also carries Plinth's own doc editing channel (kind "doc", rooms/doc.ts):
// the live draft, its leases and its D1 flush, and the checkpoint RPCs the app host calls.
import { DurableObject } from "cloudflare:workers";
import {
  type ArtifactType,
  canEmitTopic,
  type EffectiveRole,
  LIMITS,
  type LiveDocServerFrame,
  liveDocClientFrameSchema,
  mergePresence,
  ROOM_CLOSE,
  ROOM_LIMITS,
  ROOM_OPEN_ALL,
  ROOM_PROTOCOL,
  ROOM_TOPIC_RE,
  type RoomClientFrame,
  type RoomDocRight,
  type RoomEmitRight,
  type RoomErrorCode,
  type RoomIdentity,
  type RoomKind,
  type RoomPeer,
  type RoomServerFrame,
  roomClientFrameSchema,
} from "@plinth/shared";
import type { Bindings } from "../config.ts";
import { randomString } from "../lib/crypto.ts";
import { versionCapabilities } from "../services/artifacts.ts";
import { type DocSnapshot, LiveDoc, type StoredLease } from "./doc.ts";
import { roomDeclaration } from "./notify.ts";

/** The header the gate puts on the internal connect request: a JSON RoomConnect. */
export const ROOM_CONNECT_HEADER = "x-plinth-room";
/** The internal connect URL; a reserved TLD, so it can never mean a real site. */
export const ROOM_CONNECT_URL = "https://room.invalid/connect";

/** What the gate tells the room about one socket, after every check passed. */
export interface RoomConnect {
  artifactId: string;
  type: ArtifactType;
  kind: RoomKind;
  /** The artifact's access epoch the content pass was signed for. */
  epoch: number;
  /** When the content pass expires (ms since the epoch). */
  passExp: number;
  /** The per-artifact u_ viewer id. */
  viewer: string;
  role: EffectiveRole;
  email: string;
  /**
   * The display name read at connect (displayName.ts pageDisplayName), shown beside the email;
   * null without one, and on doc sockets.
   */
  name: string | null;
  /** Peers see this socket's email and role (the page declares `viewer`, or a doc socket). */
  seeIdentity: boolean;
  /** all (owners, editors), open (commenters: openTopics), none (viewers, doc sockets). */
  emit: RoomEmitRight;
  /** The page's declared open topics (re-checked against each new declaration). */
  openTopics: string[];
  doc: RoomDocRight;
  /** The instance's ROOM_* limits, as the Worker parsed them. */
  limits: { maxConnections: number; maxMessageBytes: number; messagesPerSecond: number };
}

/** One socket, as its hibernation attachment holds it. */
interface SocketState extends RoomConnect {
  /** Random per socket. */
  id: string;
  /** Joined rooms and this socket's presence in each. */
  rooms: Record<string, Record<string, unknown>>;
  /** A doc socket's lease on the live draft (rooms/doc.ts). */
  lease?: StoredLease | null;
}

const ROLES: ReadonlySet<string> = new Set(["owner", "editor", "commenter", "viewer"]);
const DOC_RIGHTS: ReadonlySet<string> = new Set(["none", "watch", "write"]);
const EMIT_RIGHTS: ReadonlySet<string> = new Set(["all", "open", "none"]);

/**
 * UTF-8 bytes a socket's display name may take in its attachment: 64 code points of at most 4
 * bytes each (LIMITS.maxPageDisplayNameLength), so a socket stays under ROOM_LIMITS.attachmentBytes.
 */
export const ROOM_NAME_BYTES = 256;

/**
 * A name as the gate sends it: null, or display text with no "@" that fits ROOM_NAME_BYTES. A
 * missing name reads as null, so a Worker isolate still running the release before names (whose
 * header has no `name`) can connect while a deploy rolls out; a present but invalid one is refused.
 */
function validName(n: unknown): boolean {
  return (
    n === undefined ||
    n === null ||
    (typeof n === "string" && !n.includes("@") && utf8Bytes(n) <= ROOM_NAME_BYTES)
  );
}

/**
 * The header value for a connect: JSON with every non-ASCII character escaped (\uXXXX), since a
 * header value must be ASCII and a display name need not be. JSON.parse reads it back unchanged.
 */
export function encodeConnect(c: RoomConnect): string {
  return JSON.stringify(c).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The header, checked for shape (it is the Worker's own, but a room never trusts a bad one). */
export function parseConnect(raw: string | null): RoomConnect | null {
  if (!raw || raw.length > 4096) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const int = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const l = c.limits as Record<string, unknown> | undefined;
  const ok =
    typeof c.artifactId === "string" &&
    (c.type === "html" || c.type === "doc") &&
    (c.kind === "page" || c.kind === "doc") &&
    int(c.epoch) &&
    int(c.passExp) &&
    typeof c.viewer === "string" &&
    typeof c.role === "string" &&
    ROLES.has(c.role) &&
    typeof c.email === "string" &&
    validName(c.name) &&
    typeof c.seeIdentity === "boolean" &&
    typeof c.emit === "string" &&
    EMIT_RIGHTS.has(c.emit) &&
    Array.isArray(c.openTopics) &&
    c.openTopics.length <= ROOM_LIMITS.maxOpenTopics &&
    c.openTopics.every(
      (t) => typeof t === "string" && (t === ROOM_OPEN_ALL || ROOM_TOPIC_RE.test(t)),
    ) &&
    typeof c.doc === "string" &&
    DOC_RIGHTS.has(c.doc) &&
    typeof l === "object" &&
    l !== null &&
    int(l.maxConnections) &&
    int(l.maxMessageBytes) &&
    int(l.messagesPerSecond);
  return ok ? ({ ...c, name: c.name ?? null } as unknown as RoomConnect) : null;
}

const encoder = new TextEncoder();
const utf8Bytes = (s: string) => encoder.encode(s).byteLength;

interface Bucket {
  tokens: number;
  at: number;
  drops: number[];
}

export class ArtifactRoom extends DurableObject<Bindings> {
  /** Attachments already read in this wake. */
  private readonly states = new WeakMap<WebSocket, SocketState>();
  /** Sockets this room closed itself, so their peers were already told. */
  private readonly closed = new WeakSet<WebSocket>();
  /** Message buckets per socket id. In memory: a wake resets them, which is acceptable. */
  private readonly buckets = new Map<string, Bucket>();
  /** Connect times per viewer in the last minute. In memory, like the buckets. */
  private readonly connects = new Map<string, number[]>();
  /** The live draft of a doc artifact (kind "doc" sockets and the checkpoint RPCs). */
  private readonly doc: LiveDoc;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.doc = new LiveDoc({
      env,
      sockets: () => this.sockets("doc"),
      save: (ws, s) => this.save(ws, s as SocketState),
      send: (ws, frame) => this.sendDoc(ws, frame),
      gone: () => {
        this.doc.reset();
        for (const { ws } of this.sockets()) this.drop(ws, ROOM_CLOSE.gone, "gone");
      },
    });
    // The client's keep-alive, answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426 });
    }
    const info = parseConnect(request.headers.get(ROOM_CONNECT_HEADER));
    if (!info) return new Response(null, { status: 400 });
    // A doc socket is for owners and editors (watch or write); the gate never sends "none".
    if (info.kind === "doc" && info.doc === "none") return new Response(null, { status: 403 });

    // A doc's draft is loaded (and rebased onto a newer version) before the socket joins, so the
    // socket's first frame is its welcome.
    if (info.kind === "doc" && !(await this.doc.ensure(info.artifactId))) {
      return new Response(null, { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const headers = { "Sec-WebSocket-Protocol": ROOM_PROTOCOL };
    if (this.isFull(info)) {
      // Accepted without hibernation only to say why, then closed: it never counts as a peer.
      server.accept();
      server.close(ROOM_CLOSE.full, "full");
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    const state: SocketState = {
      ...info,
      id: `s_${randomString(16)}`,
      rooms: {},
      ...(info.kind === "doc" ? { lease: null } : {}),
    };
    this.ctx.acceptWebSocket(server, [`k:${info.kind}`, `v:${info.viewer}`, `e:${info.epoch}`]);
    if (!this.save(server, state)) {
      server.close(ROOM_CLOSE.invalid, "invalid");
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    if (info.kind === "doc") {
      if (!(await this.doc.connected(server, state, info.artifactId))) {
        this.drop(server, ROOM_CLOSE.gone, "gone");
        return new Response(null, { status: 101, webSocket: client, headers });
      }
    } else {
      this.send(server, {
        t: "welcome",
        v: 1,
        you: this.you(state),
        limits: {
          max_message_bytes: info.limits.maxMessageBytes,
          messages_per_second: info.limits.messagesPerSecond,
          presence_bytes: ROOM_LIMITS.presenceBytes,
        },
      });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIMITS.recheckIntervalS * 1000);
    }
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /** The per-artifact, per-viewer and per-minute caps. Records the connect when it is allowed. */
  private isFull(info: RoomConnect): boolean {
    if (this.ctx.getWebSockets().length >= info.limits.maxConnections) return true;
    if (this.ctx.getWebSockets(`v:${info.viewer}`).length >= ROOM_LIMITS.socketsPerViewer) {
      return true;
    }
    const now = Date.now();
    const recent = (this.connects.get(info.viewer) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= ROOM_LIMITS.connectsPerViewerPerMinute) {
      this.connects.set(info.viewer, recent);
      return true;
    }
    recent.push(now);
    this.connects.set(info.viewer, recent);
    return false;
  }

  // ---------- sockets and their state ----------

  private state(ws: WebSocket): SocketState | null {
    const cached = this.states.get(ws);
    if (cached) return cached;
    const s = ws.deserializeAttachment() as SocketState | null;
    if (!s || typeof s !== "object" || typeof s.id !== "string") return null;
    this.states.set(ws, s);
    return s;
  }

  /** Store a socket's state, refusing one over the attachment limit (2 KiB on the platform). */
  private save(ws: WebSocket, s: SocketState): boolean {
    if (utf8Bytes(JSON.stringify(s)) > ROOM_LIMITS.attachmentBytes) return false;
    ws.serializeAttachment(s);
    this.states.set(ws, s);
    return true;
  }

  /** Open sockets this room has not closed, with their state. */
  private sockets(kind?: RoomKind): { ws: WebSocket; s: SocketState }[] {
    const out: { ws: WebSocket; s: SocketState }[] = [];
    for (const ws of this.ctx.getWebSockets(kind ? `k:${kind}` : undefined)) {
      if (this.closed.has(ws)) continue;
      const s = this.state(ws);
      if (s) out.push({ ws, s });
    }
    return out;
  }

  private members(room: string): { ws: WebSocket; s: SocketState }[] {
    return this.sockets("page").filter(({ s }) => s.rooms[room] !== undefined);
  }

  private send(ws: WebSocket, frame: RoomServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket is closing; its close handler tidies up.
    }
  }

  private sendDoc(ws: WebSocket, frame: LiveDocServerFrame): void {
    if (this.closed.has(ws)) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Closing.
    }
  }

  /** Who `p` is to `to`: email, name and role only when both may see identities. */
  private identity(p: SocketState, to: SocketState): RoomIdentity {
    const out: RoomIdentity = { id: p.id, viewer: p.viewer };
    if (p.seeIdentity && to.seeIdentity) {
      out.role = p.role;
      out.email = p.email;
      out.name = p.name ?? null;
    }
    return out;
  }

  /** A socket's own identity: its role always, its email and name only when the page may see them. */
  private you(s: SocketState): RoomIdentity {
    const out: RoomIdentity = { id: s.id, viewer: s.viewer, role: s.role };
    if (s.seeIdentity) {
      out.email = s.email;
      out.name = s.name ?? null;
    }
    return out;
  }

  private peer(p: SocketState, room: string, to: SocketState): RoomPeer {
    return { ...this.identity(p, to), presence: p.rooms[room] ?? {} };
  }

  private error(ws: WebSocket, code: RoomErrorCode): void {
    this.send(ws, { t: "error", code });
  }

  /** Close a socket, telling its rooms' peers first. */
  private drop(ws: WebSocket, code: number, reason: string): void {
    if (this.closed.has(ws)) return;
    this.leaveAll(ws);
    this.closed.add(ws);
    this.docGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private leaveAll(ws: WebSocket): void {
    const s = this.state(ws);
    if (!s) return;
    this.buckets.delete(s.id);
    const names = Object.keys(s.rooms);
    if (!names.length) return;
    s.rooms = {};
    this.states.set(ws, s);
    for (const room of names) {
      for (const m of this.members(room)) {
        if (m.ws !== ws) this.send(m.ws, { t: "gone", room, id: s.id });
      }
    }
  }

  // ---------- messages ----------

  /** A token bucket per socket: `messagesPerSecond`, with a burst of twice that. */
  private allow(s: SocketState): "ok" | "drop" | "close" {
    const rate = s.limits.messagesPerSecond;
    const now = Date.now();
    const b = this.buckets.get(s.id) ?? { tokens: rate * 2, at: now, drops: [] };
    b.tokens = Math.min(rate * 2, b.tokens + ((now - b.at) * rate) / 1000);
    b.at = now;
    this.buckets.set(s.id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return "ok";
    }
    b.drops = b.drops.filter((t) => now - t < ROOM_LIMITS.rateDropWindowS * 1000);
    b.drops.push(now);
    return b.drops.length >= ROOM_LIMITS.rateDropsToClose ? "close" : "drop";
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.closed.has(ws)) return;
    const s = this.state(ws);
    if (!s) return this.drop(ws, ROOM_CLOSE.invalid, "invalid");
    // Sizes and kinds are checked on the raw frame, before anything is parsed. A doc frame may
    // carry a block's text, so it gets the fixed doc limit instead of the page one.
    if (typeof message !== "string") return this.drop(ws, 1003, "binary");
    const max = s.kind === "doc" ? LIMITS.liveDocFrameBytes : s.limits.maxMessageBytes;
    if (message.length > max || utf8Bytes(message) > max) {
      return this.drop(ws, 1009, "too_large");
    }
    if (message === "ping") {
      // Normally answered by the auto-response without waking the object.
      try {
        ws.send("pong");
      } catch {
        // Closing.
      }
      return;
    }
    const rate = this.allow(s);
    if (rate === "close") return this.drop(ws, ROOM_CLOSE.rate, "rate");
    if (rate === "drop") {
      if (s.kind === "doc") return this.sendDoc(ws, { t: "error", code: "rate_limited" });
      return this.error(ws, "rate_limited");
    }
    if (s.kind === "doc") return this.docMessage(ws, s, message);
    let frame: RoomClientFrame;
    try {
      const parsed = roomClientFrameSchema.safeParse(JSON.parse(message));
      if (!parsed.success) return this.error(ws, "invalid");
      frame = parsed.data;
    } catch {
      return this.error(ws, "invalid");
    }
    if (s.kind !== "page") return this.error(ws, "invalid");
    switch (frame.t) {
      case "join":
        return this.join(ws, s, frame.room);
      case "leave":
        return this.leave(ws, s, frame.room);
      case "presence":
        return this.presence(ws, s, frame.room, frame.state);
      case "emit":
        return this.emit(ws, s, frame.room, frame.topic, frame.data);
    }
  }

  private join(ws: WebSocket, s: SocketState, room: string) {
    if (s.rooms[room] === undefined) {
      if (Object.keys(s.rooms).length >= ROOM_LIMITS.roomsPerConnection) {
        return this.error(ws, "too_large");
      }
      s.rooms[room] = {};
      if (!this.save(ws, s)) {
        delete s.rooms[room];
        return this.error(ws, "too_large");
      }
      for (const m of this.members(room)) {
        if (m.ws !== ws) this.send(m.ws, { t: "peer", room, peer: this.peer(s, room, m.s) });
      }
    }
    // The full list, this socket included (the client marks it as `you`).
    const peers = this.members(room).map((m) => this.peer(m.s, room, s));
    this.send(ws, { t: "peers", room, peers });
  }

  private leave(ws: WebSocket, s: SocketState, room: string) {
    if (s.rooms[room] === undefined) return this.error(ws, "not_joined");
    delete s.rooms[room];
    this.save(ws, s);
    for (const m of this.members(room)) this.send(m.ws, { t: "gone", room, id: s.id });
  }

  private presence(
    ws: WebSocket,
    s: SocketState,
    room: string,
    patch: Record<string, unknown> | null,
  ) {
    const prev = s.rooms[room];
    if (prev === undefined) return this.error(ws, "not_joined");
    const next = mergePresence(prev, patch);
    if (utf8Bytes(JSON.stringify(next)) > ROOM_LIMITS.presenceBytes) {
      return this.error(ws, "too_large");
    }
    s.rooms[room] = next;
    if (!this.save(ws, s)) {
      s.rooms[room] = prev;
      return this.error(ws, "too_large");
    }
    for (const m of this.members(room)) {
      if (m.ws !== ws) this.send(m.ws, { t: "peer", room, peer: this.peer(s, room, m.s) });
    }
  }

  private emit(ws: WebSocket, s: SocketState, room: string, topic: string, data: unknown) {
    if (s.rooms[room] === undefined) return this.error(ws, "not_joined");
    if (!canEmitTopic(s.emit, s.openTopics, topic)) return this.error(ws, "forbidden_topic");
    for (const m of this.members(room)) {
      if (m.ws === ws) continue;
      this.send(m.ws, { t: "event", room, topic, data, from: this.identity(s, m.s) });
    }
  }

  private async docMessage(ws: WebSocket, s: SocketState, message: string): Promise<void> {
    let parsed: ReturnType<typeof liveDocClientFrameSchema.safeParse>;
    try {
      parsed = liveDocClientFrameSchema.safeParse(JSON.parse(message));
    } catch {
      return this.sendDoc(ws, { t: "error", code: "invalid" });
    }
    if (!parsed.success) return this.sendDoc(ws, { t: "error", code: "invalid" });
    try {
      await this.doc.message(ws, s, parsed.data, s.artifactId);
    } catch {
      console.error("live doc message failed");
      this.sendDoc(ws, { t: "error", code: "unavailable" });
    }
  }

  /** A doc socket is gone (closed by us or by the client): its lease ends. */
  private docGone(ws: WebSocket): void {
    const s = this.state(ws);
    if (s?.kind !== "doc") return;
    this.ctx.waitUntil(
      this.doc.closed(ws, s).catch(() => {
        console.error("live doc close failed");
      }),
    );
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const ours = this.closed.has(ws);
    if (!ours) {
      this.leaveAll(ws);
      this.closed.add(ws);
      this.docGone(ws);
    }
    this.closed.add(ws);
    try {
      // Complete the closing handshake (a no-op where the runtime already replied).
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    if (!this.closed.has(ws)) {
      this.leaveAll(ws);
      this.closed.add(ws);
      this.docGone(ws);
    }
  }

  // ---------- revocation (Worker RPC, and the alarm as its backstop) ----------

  /** Close sockets whose content pass predates this access epoch (a sharing change). */
  async revoke(minEpoch: number): Promise<number> {
    let n = 0;
    for (const { ws, s } of this.sockets()) {
      if (s.epoch < minEpoch) {
        this.drop(ws, ROOM_CLOSE.unauthorized, "access_changed");
        n++;
      }
    }
    return n;
  }

  /** The artifact was deleted or taken down: close everything, and forget the live draft. */
  async gone(): Promise<number> {
    this.doc.reset();
    let n = 0;
    for (const { ws } of this.sockets()) {
      this.drop(ws, ROOM_CLOSE.gone, "gone");
      n++;
    }
    return n;
  }

  /** The current version changed what it declares about rooms: page sockets reconnect. */
  async redeclare(): Promise<number> {
    let n = 0;
    for (const { ws } of this.sockets("page")) {
      this.drop(ws, ROOM_CLOSE.redeclared, "redeclared");
      n++;
    }
    return n;
  }

  /** How many sockets are open (tests and diagnostics; never who). */
  async size(): Promise<number> {
    return this.sockets().length;
  }

  // ---------- the live doc draft (Worker RPC from services/live.ts and rooms/notify.ts) ----------

  /** Version `n` of the doc was committed; `hash` is its content.md sha256 when known. */
  async docVersion(artifactId: string, n: number, hash: string | null): Promise<void> {
    await this.doc.version(artifactId, n, hash);
  }

  /** Flush and return the draft for a checkpoint, under a 30 s lock. */
  async docSnapshot(artifactId: string): Promise<DocSnapshot> {
    return this.doc.snapshot(artifactId);
  }

  /** The checkpoint holding `lockId` saves an editor's resolution of a conflict instead. */
  async docResolve(lockId: string, text: string): Promise<boolean> {
    return this.doc.resolveWith(lockId, text);
  }

  async docFinish(
    artifactId: string,
    n: number,
    text: string,
    lockId: string,
  ): Promise<{ rev: number; dirty: boolean }> {
    return this.doc.finishCheckpoint(artifactId, n, text, lockId);
  }

  /** The checkpoint holding `lockId` gave up (another checkpoint's lock stays). */
  async docAbort(lockId: string): Promise<void> {
    await this.doc.abortCheckpoint(lockId);
  }

  async docDiscard(artifactId: string, rev: number): Promise<{ ok: boolean; rev: number }> {
    return this.doc.discard(artifactId, rev);
  }

  async docPeek(artifactId: string) {
    return this.doc.peek(artifactId);
  }

  /** Doc sockets open now, and their emails (never draft text). */
  async docInfo(): Promise<{ editors_online: number }> {
    return { editors_online: this.sockets("doc").length };
  }

  /**
   * While any socket is open, every ROOM_LIMITS.recheckIntervalS: one D1 read of the artifact's
   * epoch, takedown, deletion and current declaration. It closes what an RPC lost in waitUntil, or
   * a change made with SQL, left open, and any socket whose content pass has expired.
   */
  override async alarm(): Promise<void> {
    const open = this.sockets();
    if (!open.length) return;
    const artifactId = open[0]?.s.artifactId ?? "";
    let row: {
      current_version: number;
      access_epoch: number;
      taken_down_at: string | null;
      deleted_at: string | null;
      capabilities: string | null;
    } | null;
    try {
      row = await this.env.DB.prepare(
        `SELECT a.current_version, a.access_epoch, a.taken_down_at, a.deleted_at, v.capabilities
           FROM artifacts a
           LEFT JOIN versions v ON v.artifact_id = a.id AND v.number = a.current_version
          WHERE a.id = ?1`,
      )
        .bind(artifactId)
        .first();
    } catch {
      console.error("room recheck failed");
      await this.ctx.storage.setAlarm(Date.now() + ROOM_LIMITS.recheckIntervalS * 1000);
      return;
    }
    const now = Date.now();
    const caps = row ? versionCapabilities(row) : null;
    for (const { ws, s } of open) {
      if (!row || row.deleted_at || row.taken_down_at) this.drop(ws, ROOM_CLOSE.gone, "gone");
      else if (s.epoch < row.access_epoch || s.passExp <= now) {
        this.drop(ws, ROOM_CLOSE.unauthorized, "access_changed");
      } else if (s.kind === "page" && !sameDeclaration(caps, s)) {
        this.drop(ws, ROOM_CLOSE.redeclared, "redeclared");
      }
    }
    // A doc version whose notify was lost (or published while rooms were off): the draft in
    // memory catches up, so a checkpoint is not refused as stale until everyone leaves.
    if (row && !row.deleted_at && !row.taken_down_at && this.sockets("doc").length) {
      try {
        await this.doc.catchUp(artifactId, row.current_version);
      } catch {
        console.error("live doc catch-up failed");
      }
    }
    if (this.sockets().length) {
      await this.ctx.storage.setAlarm(now + ROOM_LIMITS.recheckIntervalS * 1000);
    }
  }
}

/** Whether the current declaration still gives a page socket what it was admitted with. */
function sameDeclaration(caps: ReturnType<typeof versionCapabilities>, s: SocketState): boolean {
  return (
    roomDeclaration(caps) ===
    roomDeclaration({ room: true, viewer: s.seeIdentity, roomOpen: s.openTopics })
  );
}
