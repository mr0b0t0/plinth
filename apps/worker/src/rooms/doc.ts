// On-page doc editing in an artifact's room (#36, docs/spec.md "Editing"): the live draft of one
// doc, held by its ArtifactRoom. The room is the only place edits are ordered. Leases are exclusive
// line ranges the room enforces, and an edit replaces its whole leased range, so nobody ever edits
// lines another person holds and no transform is needed. Every applied edit bumps `rev` and goes to
// every doc socket (the sender's copy is its ack).
//
// The draft is durable in D1 (`live_drafts`, migration 0011), never in the object's own storage:
// a coalesced flush writes it at most every LIVE_DRAFT_FLUSH_S, guarded so it can never bring back
// a draft of a deleted or taken-down artifact, never moves `rev` backwards, and keeps at most
// LIMITS.maxLiveDraftsPerOwner drafts per owner. A pending flush timer keeps the object awake, so it
// never hibernates with an unflushed draft; only an eviction (a deploy or a crash) can lose up to
// one flush interval, and the sockets close then too.
//
// The room never creates a version. Checkpoints run on the app host (services/live.ts) through the
// stager, with this draft's base_version; when a version is published from outside, the draft is
// merged onto it when that is clean (merge3) and frozen for review when it is not. Draft text is
// never logged.
//
// Every type with liveEdit has a draft here (docs and sheets): the type's rules (liveTypes.ts)
// check each edit and each merge, so a sheet's draft is always valid canonical JSON lines. A
// sheet's rows and columns move with `struct`, applied here and on every socket by the same pure
// function, only while nobody else holds a lease. A sheet's draft is never merged: a version
// published under it freezes it, and the editors publish it as it is or discard it.
import {
  type ArtifactTypeDef,
  applyLineEdit,
  applySheetStruct,
  blockLines,
  chunkText,
  joinLines,
  LIMITS,
  LIVE_DEFAULTS,
  LIVE_DOC,
  type LiveDocClientFrame,
  type LiveDocErrorCode,
  type LiveDocServerFrame,
  type LiveTypeRules,
  liveRules,
  type Merge3Result,
  merge3,
  rangesOverlap,
  type SheetStructOp,
  shiftRange,
  splitLines,
  typeDef,
} from "@plinth/shared";
import { type Bindings, getConfig } from "../config.ts";
import { randomString, sha256Hex } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";

/** A doc socket's lease, as its hibernation attachment holds it. */
export interface StoredLease {
  id: string;
  start: number;
  /** Exclusive; equal to start for an insert point. */
  end: number;
  /** The holder's last lease or edit (ms since the epoch), for takeover. */
  at: number;
}

/** What the doc channel needs of a socket's state (ArtifactRoom's attachment). */
export interface DocSocket {
  id: string;
  email: string;
  doc: "none" | "watch" | "write";
  lease?: StoredLease | null;
}

/** What the room lends the doc channel. */
export interface DocHost {
  env: Bindings;
  /** Open doc sockets with their state. */
  sockets(): { ws: WebSocket; s: DocSocket }[];
  /** Store a socket's state (its attachment). */
  save(ws: WebSocket, s: DocSocket): boolean;
  send(ws: WebSocket, frame: LiveDocServerFrame): void;
  /** The artifact is gone: close every socket. */
  gone(): void;
}

/** What a checkpoint snapshot sees (services/live.ts). */
export interface DocSnapshot {
  state: "clean" | "busy" | "ready" | "conflict" | "gone";
  text: string;
  rev: number;
  base_version: number;
  conflict_version: number | null;
  /** sha256 of `text` (UTF-8, lowercase hex), as the stager hashes the version's source. */
  hash: string;
  /** The draft equals its base version. */
  unchanged: boolean;
  /** The checkpoint lock this snapshot took ("" when it took none), for resolve, finish and abort. */
  lock: string;
  /** The draft's epoch when snapshotted, for finish (see `Loaded.epoch`). */
  epoch: string;
}

interface Loaded {
  artifactId: string;
  /** The artifact's type (its source file) and its live rules. */
  def: ArtifactTypeDef;
  rules: LiveTypeRules;
  /** Random per in-memory load: a client never mistakes a reload for a continuation. */
  gen: string;
  /**
   * Random, new on every load and whenever the lines are replaced rather than edited (a discard,
   * a reset or rebase onto a version, a resolved conflict). A checkpoint that finishes without its
   * lock (it ran out) finishes onto the lines only when the epoch is the one it snapshotted.
   */
  epoch: string;
  rev: number;
  flushedRev: number;
  baseVersion: number;
  baseText: string;
  lines: string[];
  conflictVersion: number | null;
  /** The socket whose edit made the latest rev (for the last-writer autosave). */
  lastBy: string | null;
  /** The email behind the latest edit (updated_by_user). */
  lastEmail: string | null;
  lastEditAt: string | null;
}

interface CheckpointLock {
  /** Random per snapshot: only the checkpoint that took the lock can release it. */
  id: string;
  rev: number;
  text: string;
  hash: string;
  until: number;
  /** The checkpoint saves an editor's resolution of a conflict. */
  resolved: boolean;
  /** The draft's epoch when snapshotted ("" until then): its version finishes onto these lines. */
  epoch: string;
  /** The draft's base_version when snapshotted. */
  base: number;
}

/** LIVE_* settings as the Worker parses them; the defaults when the config cannot be read. */
function liveSettings(env: Bindings) {
  try {
    return getConfig(env as unknown as Record<string, unknown>).live;
  } catch {
    return LIVE_DEFAULTS;
  }
}

export class LiveDoc {
  private loaded: Loaded | null = null;
  private loading: Promise<Loaded | null> | null = null;
  private lock: CheckpointLock | null = null;
  /**
   * Every checkpoint snapshot still being saved (each the same object as its lock), oldest first,
   * kept after its lock runs out until its own finish or abort, a discard, or the base moving
   * past the version it was taken on. Another snapshot never drops one, whether it is ready,
   * clean or busy: a slow save's own version is still recognized when its notify or finish comes
   * late, even after a later save took the lock and gave up.
   */
  private saving: CheckpointLock[] = [];
  private needsFlush = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly host: DocHost) {}

  // ---------- loading ----------

  /** The draft in memory, loading it from D1 (or the current version in R2) on first use. */
  async ensure(artifactId: string): Promise<Loaded | null> {
    if (this.loaded?.artifactId === artifactId) return this.loaded;
    this.loading ??= this.load(artifactId).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(artifactId: string): Promise<Loaded | null> {
    const DB = this.host.env.DB;
    const row = await DB.prepare(
      `SELECT a.type, a.current_version, a.deleted_at, a.taken_down_at,
              d.base_version, d.content, d.rev, d.conflict_version,
              (SELECT r2_prefix FROM versions
                WHERE artifact_id = a.id AND number = coalesce(d.base_version, a.current_version)) AS base_prefix
         FROM artifacts a LEFT JOIN live_drafts d ON d.artifact_id = a.id
        WHERE a.id = ?1`,
    )
      .bind(artifactId)
      .first<{
        type: string;
        current_version: number;
        deleted_at: string | null;
        taken_down_at: string | null;
        base_version: number | null;
        content: string | null;
        rev: number | null;
        conflict_version: number | null;
        base_prefix: string | null;
      }>();
    if (!row || row.deleted_at || row.taken_down_at || !row.base_prefix) return null;
    const def = typeDef(row.type);
    const rules = liveRules(row.type);
    if (!def?.liveEdit || !rules) return null;
    const baseText = await this.readVersionText(row.base_prefix, def);
    if (baseText === null) return null;
    const draft = row.content !== null && row.base_version !== null && row.rev !== null;
    const doc: Loaded = {
      artifactId,
      def,
      rules,
      gen: randomString(16),
      epoch: randomString(12),
      rev: draft ? (row.rev as number) : 0,
      flushedRev: draft ? (row.rev as number) : 0,
      baseVersion: draft ? (row.base_version as number) : row.current_version,
      baseText,
      lines: splitLines(draft ? (row.content as string) : baseText),
      conflictVersion: draft ? row.conflict_version : null,
      lastBy: null,
      lastEmail: null,
      lastEditAt: null,
    };
    this.loaded = doc;
    this.restoreLeases(doc);
    // A version published while nobody held the draft in memory (or whose notify was lost).
    if (doc.baseVersion < row.current_version) await this.outside(doc, row.current_version, null);
    return this.loaded;
  }

  private async readVersionText(prefix: string, def: ArtifactTypeDef): Promise<string | null> {
    const obj = await this.host.env.FILES.get(`${prefix}${def.sourcePath}`);
    return obj ? obj.text() : null;
  }

  private async versionText(doc: Loaded, n: number): Promise<string | null> {
    const v = await this.host.env.DB.prepare(
      "SELECT r2_prefix FROM versions WHERE artifact_id = ?1 AND number = ?2",
    )
      .bind(doc.artifactId, n)
      .first<{ r2_prefix: string }>();
    return v ? this.readVersionText(v.r2_prefix, doc.def) : null;
  }

  /** Leases come back from the sockets' attachments; any that no longer fit are dropped. */
  private restoreLeases(doc: Loaded): void {
    const kept: StoredLease[] = [];
    for (const { ws, s } of this.host.sockets()) {
      const l = s.lease;
      if (!l) continue;
      const fits =
        s.doc === "write" &&
        doc.conflictVersion === null &&
        l.end <= doc.lines.length &&
        !kept.some((k) => rangesOverlap(k, l));
      if (fits) kept.push(l);
      else {
        s.lease = null;
        this.host.save(ws, s);
      }
    }
  }

  /** Drop the in-memory draft (the artifact is gone). A pending flush is cancelled. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.loaded = null;
    this.lock = null;
    this.saving = [];
    this.needsFlush = false;
  }

  // ---------- sockets ----------

  private text(doc: Loaded): string {
    return joinLines(doc.lines);
  }

  private broadcast(frame: LiveDocServerFrame, except?: WebSocket): void {
    for (const { ws } of this.host.sockets()) if (ws !== except) this.host.send(ws, frame);
  }

  private sendText(ws: WebSocket, doc: Loaded): void {
    const parts = chunkText(this.text(doc), LIVE_DOC.textChunkBytes);
    parts.forEach((chunk, part) => {
      this.host.send(ws, { t: "text", gen: doc.gen, part, of: parts.length, chunk });
    });
  }

  private broadcastText(doc: Loaded): void {
    for (const { ws } of this.host.sockets()) this.sendText(ws, doc);
  }

  private welcome(ws: WebSocket, s: DocSocket, doc: Loaded): void {
    const all = this.host.sockets();
    this.host.send(ws, {
      t: "welcome",
      v: 1,
      you: { id: s.id, email: s.email, right: s.doc === "write" ? "write" : "watch" },
      gen: doc.gen,
      rev: doc.rev,
      base_version: doc.baseVersion,
      flushed_rev: doc.flushedRev,
      conflict_version: doc.conflictVersion,
      last_by_you: doc.lastBy === s.id,
      leases: all
        .filter((o) => o.s.lease)
        .slice(0, 1000)
        .map((o) => {
          const l = o.s.lease as StoredLease;
          return { id: l.id, start: l.start, end: l.end, by: o.s.email };
        }),
      peers: all
        .filter((o) => o.ws !== ws)
        .slice(0, 1000)
        .map((o) => ({ id: o.s.id, email: o.s.email, lease: o.s.lease?.id ?? null })),
    });
    this.sendText(ws, doc);
  }

  private status(doc: Loaded): void {
    const all = this.host.sockets();
    const editors = [...new Set(all.map((o) => o.s.email))].slice(0, LIVE_DOC.maxEditorsListed);
    const dirty = doc.conflictVersion !== null || this.text(doc) !== doc.baseText;
    for (const { ws, s } of all) {
      this.host.send(ws, {
        t: "status",
        dirty,
        editors,
        last_edit_at: doc.lastEditAt,
        last_by_you: doc.lastBy === s.id,
      });
    }
  }

  /** A doc socket was accepted: send it the draft. False when the artifact is gone. */
  async connected(ws: WebSocket, s: DocSocket, artifactId: string): Promise<boolean> {
    const doc = await this.ensure(artifactId);
    if (!doc) return false;
    this.welcome(ws, s, doc);
    this.status(doc);
    return true;
  }

  /** A doc socket closed: its lease goes; the last one out flushes and frees the memory. */
  async closed(ws: WebSocket, s: DocSocket): Promise<void> {
    // The lease is in the socket's attachment, so it ends for the others even when the draft is
    // not in memory (after a hibernation wake, before anyone sent a frame).
    if (s.lease) {
      const id = s.lease.id;
      s.lease = null;
      this.broadcast({ t: "released", lease: id }, ws);
    }
    const doc = this.loaded;
    if (!doc) return;
    const left = this.host.sockets().filter((o) => o.ws !== ws);
    if (left.length) {
      this.status(doc);
      return;
    }
    await this.flushNow();
    if (!this.host.sockets().length && !this.lock && !this.needsFlush && this.loaded === doc) {
      this.loaded = null;
    }
  }

  private error(ws: WebSocket, code: LiveDocErrorCode): void {
    this.host.send(ws, { t: "error", code });
  }

  /** One frame from a doc socket, already size-checked and parsed. */
  async message(ws: WebSocket, s: DocSocket, f: LiveDocClientFrame, artifactId: string) {
    const doc = await this.ensure(artifactId);
    if (!doc) return this.host.gone();
    switch (f.t) {
      case "sync":
        return this.welcome(ws, s, doc);
      case "lease":
        return this.lease(ws, s, doc, f.rev, f.start, f.end);
      case "edit":
        return this.edit(ws, s, doc, f.lease, f.seq, f.text);
      case "release":
        return this.release(ws, s, doc, f.lease);
      case "takeover":
        return this.takeover(ws, s, doc, f.lease);
      case "struct":
        return this.struct(ws, s, doc, f.rev, f.op);
    }
  }

  private holderOf(id: string): { ws: WebSocket; s: DocSocket } | null {
    return this.host.sockets().find((o) => o.s.lease?.id === id) ?? null;
  }

  private lease(ws: WebSocket, s: DocSocket, doc: Loaded, rev: number, start: number, end: number) {
    if (s.doc !== "write") return this.host.send(ws, { t: "lease_denied", reason: "watch" });
    if (doc.conflictVersion !== null) {
      return this.host.send(ws, { t: "lease_denied", reason: "frozen" });
    }
    if (rev !== doc.rev) return this.host.send(ws, { t: "lease_denied", reason: "stale" });
    if (end > doc.lines.length || start > end) return this.error(ws, "invalid");
    const want = { start, end };
    for (const o of this.host.sockets()) {
      if (o.ws === ws || !o.s.lease) continue;
      if (rangesOverlap(o.s.lease, want)) {
        return this.host.send(ws, { t: "lease_denied", reason: "held", by: o.s.email });
      }
    }
    // One lease per socket: taking a block releases the one held before.
    const prev = s.lease?.id;
    s.lease = { id: `l_${randomString(12)}`, start, end, at: Date.now() };
    this.host.save(ws, s);
    if (prev) this.broadcast({ t: "released", lease: prev });
    this.broadcast({ t: "leased", lease: s.lease.id, start, end, holder: s.id, by: s.email });
  }

  private edit(ws: WebSocket, s: DocSocket, doc: Loaded, id: string, seq: number, text: string) {
    if (s.doc !== "write") return this.host.send(ws, { t: "lease_denied", reason: "watch" });
    const l = s.lease;
    if (!l || l.id !== id) return this.error(ws, "not_held");
    if (doc.conflictVersion !== null) {
      return this.host.send(ws, { t: "lease_denied", reason: "frozen" });
    }
    const ins = blockLines(text);
    // The type's rules first (a sheet's rows and header), then its size.
    const refused = doc.rules.checkEdit(doc.lines, l.start, l.end - l.start, ins);
    if (refused) return this.error(ws, refused);
    const next = applyLineEdit(doc.lines, l.start, l.end - l.start, ins);
    if (doc.rules.tooLarge(joinLines(next))) return this.error(ws, "too_large");
    const e = { start: l.start, del: l.end - l.start, ins: ins.length };
    doc.lines = next;
    doc.rev += 1;
    doc.lastBy = s.id;
    doc.lastEmail = s.email;
    doc.lastEditAt = nowIso();
    s.lease = { id: l.id, start: l.start, end: l.start + ins.length, at: Date.now() };
    this.host.save(ws, s);
    // The other leases move with the lines; attachments change in the same turn as the op.
    for (const o of this.host.sockets()) {
      if (o.ws === ws || !o.s.lease) continue;
      const moved = shiftRange(o.s.lease, e);
      if (moved.start !== o.s.lease.start || moved.end !== o.s.lease.end) {
        o.s.lease = { ...o.s.lease, ...moved };
        this.host.save(o.ws, o.s);
      }
    }
    this.broadcast({
      t: "op",
      gen: doc.gen,
      rev: doc.rev,
      lease: l.id,
      start: e.start,
      del: e.del,
      ins: text,
      by: s.id,
      seq,
    });
    this.scheduleFlush();
  }

  private release(ws: WebSocket, s: DocSocket, doc: Loaded, id: string) {
    if (!s.lease || s.lease.id !== id) return this.error(ws, "not_held");
    s.lease = null;
    this.host.save(ws, s);
    this.broadcast({ t: "released", lease: id });
    // A finished block is written straight away.
    if (this.needsFlush) void this.flushNow();
    else this.status(doc);
  }

  private takeover(ws: WebSocket, s: DocSocket, doc: Loaded, id: string) {
    if (s.doc !== "write") return this.host.send(ws, { t: "lease_denied", reason: "watch" });
    if (doc.conflictVersion !== null) {
      return this.host.send(ws, { t: "lease_denied", reason: "frozen" });
    }
    const holder = this.holderOf(id);
    if (!holder?.s.lease) return this.error(ws, "not_held");
    if (holder.ws === ws) return;
    if (Date.now() - holder.s.lease.at < LIMITS.liveLeaseIdleS * 1000) {
      return this.host.send(ws, { t: "lease_denied", reason: "held", by: holder.s.email });
    }
    const { start, end } = holder.s.lease;
    holder.s.lease = null;
    this.host.save(holder.ws, holder.s);
    this.host.send(holder.ws, { t: "lease_lost", lease: id, reason: "takeover" });
    const prev = s.lease?.id;
    s.lease = { id: `l_${randomString(12)}`, start, end, at: Date.now() };
    this.host.save(ws, s);
    if (prev) this.broadcast({ t: "released", lease: prev });
    this.broadcast({ t: "released", lease: id });
    this.broadcast({ t: "leased", lease: s.lease.id, start, end, holder: s.id, by: s.email });
  }

  /**
   * A sheet's rows or columns (struct): a writer's, at the current rev, while no other socket holds
   * a lease (so no lease has to move). The sender's own lease ends first; the op is applied with
   * applySheetStruct and broadcast as it came, and every socket applies it to the same lines.
   */
  private struct(ws: WebSocket, s: DocSocket, doc: Loaded, rev: number, op: SheetStructOp) {
    if (s.doc !== "write") return this.host.send(ws, { t: "struct_denied", reason: "watch" });
    if (!doc.rules.struct) return this.error(ws, "invalid");
    if (doc.conflictVersion !== null) {
      return this.host.send(ws, { t: "struct_denied", reason: "frozen" });
    }
    if (rev !== doc.rev) return this.host.send(ws, { t: "struct_denied", reason: "stale" });
    for (const o of this.host.sockets()) {
      if (o.ws !== ws && o.s.lease) {
        return this.host.send(ws, { t: "struct_denied", reason: "held", by: o.s.email });
      }
    }
    // Two parses of the sheet per struct (the op's, then valid()'s check of its canonical result):
    // kept, since struct frames are rare next to edits and the second proves what is stored.
    const next = applySheetStruct(doc.lines, op);
    if (!next) return this.error(ws, "invalid");
    const text = joinLines(next);
    if (doc.rules.tooLarge(text)) return this.error(ws, "too_large");
    if (!doc.rules.valid(text)) return this.error(ws, "invalid");
    if (s.lease) {
      const id = s.lease.id;
      s.lease = null;
      this.host.save(ws, s);
      this.broadcast({ t: "released", lease: id });
    }
    doc.lines = next;
    doc.rev += 1;
    doc.lastBy = s.id;
    doc.lastEmail = s.email;
    doc.lastEditAt = nowIso();
    this.broadcast({ t: "struct", gen: doc.gen, rev: doc.rev, op, by: s.id });
    this.scheduleFlush();
  }

  /** Every lease ends (a rebase, a conflict, a reset): holders keep their text and re-lease. */
  private revokeLeases(reason: "rebased" | "closed"): void {
    for (const { ws, s } of this.host.sockets()) {
      if (!s.lease) continue;
      const id = s.lease.id;
      s.lease = null;
      this.host.save(ws, s);
      this.host.send(ws, { t: "lease_lost", lease: id, reason });
      this.broadcast({ t: "released", lease: id }, ws);
    }
  }

  // ---------- the D1 flush ----------

  private scheduleFlush(): void {
    this.needsFlush = true;
    if (this.timer) return;
    const s = liveSettings(this.host.env).draftFlushS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, s * 1000);
  }

  /** Write now (release, the last close, a snapshot, a rebase). */
  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    const doc = this.loaded;
    if (!doc || !this.needsFlush) return;
    this.needsFlush = false;
    const run = this.write(doc).catch(() => {
      console.error("live draft flush failed");
      if (this.loaded === doc) this.scheduleFlush();
    });
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = null;
    }
  }

  private async write(doc: Loaded): Promise<void> {
    const DB = this.host.env.DB;
    const rev = doc.rev;
    const text = this.text(doc);
    if (text === doc.baseText && doc.conflictVersion === null) {
      // Equal to its base: there is no draft.
      await DB.prepare("DELETE FROM live_drafts WHERE artifact_id = ?1 AND rev <= ?2")
        .bind(doc.artifactId, Math.max(rev, 1))
        .run();
    } else {
      const now = nowIso();
      const r = await DB.prepare(
        `INSERT INTO live_drafts (artifact_id, base_version, content, size_bytes, rev,
           conflict_version, updated_by_user, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, (SELECT id FROM users WHERE email = ?7), ?8, ?8
           FROM artifacts a
          WHERE a.id = ?1 AND a.deleted_at IS NULL AND a.taken_down_at IS NULL
            AND (EXISTS (SELECT 1 FROM live_drafts WHERE artifact_id = ?1)
                 OR (SELECT count(*) FROM live_drafts d JOIN artifacts o ON o.id = d.artifact_id
                      WHERE o.owner_id = a.owner_id) < ?9)
         ON CONFLICT (artifact_id) DO UPDATE SET
           base_version = excluded.base_version,
           content = excluded.content,
           size_bytes = excluded.size_bytes,
           rev = excluded.rev,
           conflict_version = excluded.conflict_version,
           updated_by_user = coalesce(excluded.updated_by_user, live_drafts.updated_by_user),
           updated_at = excluded.updated_at
          WHERE live_drafts.rev <= excluded.rev`,
      )
        .bind(
          doc.artifactId,
          doc.baseVersion,
          text,
          new TextEncoder().encode(text).byteLength,
          Math.max(rev, 1),
          doc.conflictVersion,
          doc.lastEmail,
          now,
          LIMITS.maxLiveDraftsPerOwner,
        )
        .run();
      if ((r.meta.changes ?? 0) === 0) {
        const why = await DB.prepare(
          `SELECT a.deleted_at, a.taken_down_at,
                  (SELECT rev FROM live_drafts WHERE artifact_id = a.id) AS rev
             FROM artifacts a WHERE a.id = ?1`,
        )
          .bind(doc.artifactId)
          .first<{ deleted_at: string | null; taken_down_at: string | null; rev: number | null }>();
        if (!why || why.deleted_at || why.taken_down_at) {
          this.reset();
          this.host.gone();
          return;
        }
        if (why.rev === null) {
          // The owner's drafts are at the limit: edits stay live here but are not durable.
          for (const { ws } of this.host.sockets()) this.error(ws, "draft_limit");
          return;
        }
        // A newer rev is already stored: nothing to do.
        return;
      }
    }
    if (this.loaded !== doc) return;
    doc.flushedRev = Math.max(doc.flushedRev, rev);
    this.broadcast({ t: "flushed", rev: doc.flushedRev });
  }

  // ---------- versions published from outside ----------

  /** A version was committed (an agent, the source editor, a restore, or a checkpoint). */
  async version(artifactId: string, n: number, hash: string | null): Promise<void> {
    if (this.loaded?.artifactId !== artifactId) {
      // Nothing in memory: only a stored draft needs rebasing, which loading does.
      if (!this.host.sockets().length) {
        const row = await this.host.env.DB.prepare(
          "SELECT 1 AS one FROM live_drafts WHERE artifact_id = ?1",
        )
          .bind(artifactId)
          .first();
        if (!row) return;
      }
      const doc = await this.ensure(artifactId);
      if (!doc) return this.host.gone();
      await this.releaseIfIdle(doc);
      return;
    }
    await this.outside(this.loaded, n, hash);
  }

  private async releaseIfIdle(doc: Loaded): Promise<void> {
    if (this.host.sockets().length || this.lock) return;
    await this.flushNow();
    if (this.loaded === doc && !this.needsFlush) this.loaded = null;
  }

  /** A pending checkpoint that saved `hash`, while the lines are still the ones it snapshotted. */
  private pendingCheckpoint(doc: Loaded, hash: string): CheckpointLock | null {
    return this.saving.find((r) => r.hash === hash && r.epoch === doc.epoch) ?? null;
  }

  /** A checkpoint's snapshot is done with (its finish, its abort, or a finish it lost to). */
  private dropSaving(rec: CheckpointLock | null): void {
    if (rec) this.saving = this.saving.filter((r) => r !== rec);
  }

  /**
   * Snapshots that can no longer publish or be recognized: taken on a base the draft has moved
   * past (the stager refuses their base as stale), or on lines replaced since whose lock ran out.
   */
  private pruneSaving(doc: Loaded): void {
    const now = Date.now();
    this.saving = this.saving.filter(
      (r) => r.base >= doc.baseVersion && (r.epoch === doc.epoch || r.until > now),
    );
  }

  private async outside(doc: Loaded, n: number, hash: string | null): Promise<void> {
    if (n <= doc.baseVersion) return;
    // Already frozen against this version (or a newer one): nothing new to merge.
    if (doc.conflictVersion !== null && n <= doc.conflictVersion) return;
    const own = hash === null ? null : this.pendingCheckpoint(doc, hash);
    if (own) {
      // This is the pending checkpoint's own version (its finish RPC may not arrive), even when
      // its lock ran out while the stager wrote it.
      this.finish(doc, n, own.text, own, own.rev);
      await this.flushNow();
      return;
    }
    const theirs = await this.versionText(doc, n);
    if (theirs === null || this.loaded !== doc || n <= doc.baseVersion) return;
    if (doc.conflictVersion !== null && n <= doc.conflictVersion) return;
    const still = this.saving.find((r) => r.text === theirs && r.epoch === doc.epoch);
    if (still) {
      // A notify without the hash (the alarm's catch-up) of that checkpoint's text.
      this.finish(doc, n, still.text, still, still.rev);
      await this.flushNow();
      return;
    }
    const ours = this.text(doc);
    if (ours === doc.baseText && doc.conflictVersion === null) {
      doc.lines = splitLines(theirs);
      doc.baseText = theirs;
      doc.baseVersion = n;
      doc.epoch = randomString(12);
      doc.rev += 1;
      this.pruneSaving(doc);
      this.revokeLeases("rebased");
      this.broadcast({ t: "reset", version: n, gen: doc.gen, rev: doc.rev });
      this.broadcastText(doc);
      this.needsFlush = true;
      await this.flushNow();
      this.status(doc);
      return;
    }
    // A type that never merges (a sheet) is frozen for review whenever the version changed the
    // source under the draft, and nothing is combined. Only a version whose source is byte for
    // byte the draft's base (a title change), or the draft itself, moves the base under the
    // draft's lines as they are.
    const m: Merge3Result = doc.rules.merge
      ? merge3(doc.baseText, ours, theirs, { maxEdits: LIVE_DOC.maxMergeEdits })
      : theirs === doc.baseText || theirs === ours
        ? { clean: true, text: ours, work: 0 }
        : { clean: false, reason: "conflict", conflicts: [], work: 0 };
    // A clean merge the type cannot hold is reviewed like an overlap.
    if (m.clean && !doc.rules.tooLarge(m.text) && doc.rules.valid(m.text)) {
      doc.lines = splitLines(m.text);
      doc.baseText = theirs;
      doc.baseVersion = n;
      doc.conflictVersion = null;
      doc.epoch = randomString(12);
      doc.rev += 1;
      this.pruneSaving(doc);
      this.revokeLeases("rebased");
      this.broadcast({ t: "rebased", version: n, gen: doc.gen, rev: doc.rev });
      this.broadcastText(doc);
    } else {
      doc.conflictVersion = n;
      this.revokeLeases("closed");
      this.broadcast({ t: "conflict", version: n });
    }
    this.needsFlush = true;
    await this.flushNow();
    this.status(doc);
  }

  // ---------- checkpoints (Worker RPC from services/live.ts) ----------

  /** Flush, then the draft as a checkpoint would save it, under a 30 s lock. */
  async snapshot(artifactId: string): Promise<DocSnapshot> {
    const doc = await this.ensure(artifactId);
    const empty = {
      text: "",
      rev: 0,
      base_version: 1,
      conflict_version: null,
      hash: "",
      lock: "",
      epoch: "",
    };
    if (!doc) return { state: "gone", ...empty, unchanged: true };
    if (this.lock && this.lock.until > Date.now()) {
      return {
        state: "busy",
        ...empty,
        rev: doc.rev,
        base_version: doc.baseVersion,
        unchanged: false,
      };
    }
    // The lock is taken before the flush awaits D1, so a second snapshot arriving meanwhile is
    // busy instead of saving the same base. Its text and hash are filled in once flushed (an
    // empty hash never matches a version notify).
    const lock: CheckpointLock = {
      id: `k_${randomString(12)}`,
      rev: doc.rev,
      text: "",
      hash: "",
      until: Date.now() + LIVE_DOC.checkpointLockS * 1000,
      resolved: false,
      epoch: "",
      base: doc.baseVersion,
    };
    this.lock = lock;
    try {
      await this.flushNow();
    } catch (e) {
      if (this.lock === lock) this.lock = null;
      throw e;
    }
    if (this.loaded !== doc || this.lock !== lock) {
      // Reset (gone) while flushing, or the lock ran out and another checkpoint took it.
      if (this.lock === lock) this.lock = null;
      return this.loaded === doc
        ? { state: "busy", ...empty, rev: doc.rev, base_version: doc.baseVersion, unchanged: false }
        : { state: "gone", ...empty, unchanged: true };
    }
    const text = this.text(doc);
    const epoch = doc.epoch;
    const unchanged = text === doc.baseText;
    const hash = await sha256Hex(text);
    const state = doc.conflictVersion !== null ? "conflict" : unchanged ? "clean" : "ready";
    if (state === "clean") {
      if (this.lock === lock) this.lock = null;
    } else if (this.lock === lock) {
      lock.rev = doc.rev;
      lock.text = text;
      lock.hash = hash;
      lock.epoch = epoch;
      lock.base = doc.baseVersion;
      this.saving = [...this.saving, lock].slice(-LIVE_DOC.maxPendingCheckpoints);
    }
    return {
      state,
      text,
      rev: doc.rev,
      base_version: doc.baseVersion,
      conflict_version: doc.conflictVersion,
      hash,
      unchanged,
      lock: state === "clean" ? "" : lock.id,
      epoch,
    };
  }

  /** The checkpoint holding `lockId` will save `text` (an editor's resolution) instead. */
  async resolveWith(lockId: string, text: string): Promise<boolean> {
    const lock = this.lock;
    if (!lock || lock.id !== lockId) return false;
    const hash = await sha256Hex(text);
    if (this.lock !== lock) return false;
    lock.text = text;
    lock.hash = hash;
    lock.resolved = true;
    return true;
  }

  /**
   * Version `n` holds the checkpoint: it becomes the draft's base; edits made since are kept.
   * When the checkpoint no longer holds its lock (it ran out) and the lines were replaced since
   * its snapshot (`epoch`: a discard, a reset), the saved text is not their ancestor, so `n` is
   * handled as any version published meanwhile instead of becoming the base under them. `rev` is
   * the snapshot's, so edits made since are known even when the lock is gone.
   */
  async finishCheckpoint(
    artifactId: string,
    n: number,
    text: string,
    lockId: string,
    epoch?: string,
    rev?: number,
  ): Promise<{ rev: number; dirty: boolean }> {
    const doc = await this.ensure(artifactId);
    if (!doc) return { rev: 0, dirty: false };
    const held = this.lock?.id === lockId ? this.lock : null;
    const rec = held ?? this.saving.find((r) => r.id === lockId) ?? null;
    // A lock that ran out is still this checkpoint's while the lines are the ones it snapshotted.
    const mine = rec && (rec.until > Date.now() || rec.epoch === doc.epoch) ? rec : null;
    if (n <= doc.baseVersion) {
      if (held) this.lock = null;
      this.dropSaving(rec);
    } else if (mine || epoch === undefined || epoch === doc.epoch) {
      this.finish(doc, n, text, mine, rev ?? mine?.rev);
    } else {
      this.dropSaving(rec);
      await this.outside(doc, n, null);
    }
    await this.flushNow();
    const out = { rev: doc.rev, dirty: this.text(doc) !== doc.baseText };
    await this.releaseIfIdle(doc);
    return out;
  }

  /**
   * The checkpoint's version `n` (holding `text`, snapshotted at rev `since`) becomes the draft's
   * base. The lines become `text` only when nothing was edited since the snapshot (a resolved
   * conflict, or a draft frozen meanwhile and not edited): edits made after the snapshot are never
   * replaced by it. A draft frozen against this version (its notify came unrecognized) or an
   * older one goes on from it with those edits; one frozen against a newer version stays frozen
   * for that version's review.
   */
  private finish(
    doc: Loaded,
    n: number,
    text: string,
    lock: CheckpointLock | null,
    since: number | undefined,
  ): void {
    // Another checkpoint's lock (this one's ran out and a newer save took it) stays.
    if (!this.lock || this.lock === lock || this.lock.until <= Date.now()) this.lock = null;
    this.dropSaving(lock);
    // Without the snapshot's rev, lines other than the saved text count as edits made since.
    const later = since === undefined ? this.text(doc) !== text : doc.rev !== since;
    const frozen = doc.conflictVersion;
    const newer = frozen !== null && frozen > n ? frozen : null;
    doc.baseVersion = n;
    doc.baseText = text;
    // The other saves of the old base can no longer publish.
    this.pruneSaving(doc);
    if (!later && (lock?.resolved === true || frozen !== null)) {
      // A resolved conflict (or a draft frozen since, unedited): the saved text is the draft now.
      doc.lines = splitLines(text);
      doc.conflictVersion = newer;
      doc.epoch = randomString(12);
      doc.rev += 1;
      this.revokeLeases("closed");
      this.broadcast({ t: "reset", version: n, gen: doc.gen, rev: doc.rev });
      this.broadcastText(doc);
      if (newer !== null) this.broadcast({ t: "conflict", version: newer });
    } else if (frozen !== null && newer === null) {
      // Frozen by this save's own version: editing resumes on it, the edits since kept as they are.
      doc.conflictVersion = null;
      doc.rev += 1;
      this.broadcast({ t: "rebased", version: n, gen: doc.gen, rev: doc.rev });
      this.broadcastText(doc);
    }
    this.needsFlush = true;
    this.broadcast({ t: "saved", version: n, rev: doc.rev });
    this.status(doc);
  }

  /**
   * The checkpoint holding `lockId` gave up; another checkpoint's lock is left alone, and so is
   * every other snapshot still being saved (a slower save's own version is still recognized).
   */
  async abortCheckpoint(lockId: string): Promise<void> {
    if (this.lock?.id === lockId) this.lock = null;
    this.dropSaving(this.saving.find((r) => r.id === lockId) ?? null);
    if (this.loaded) await this.releaseIfIdle(this.loaded);
  }

  /**
   * The alarm's backstop for a lost version notify: when the current version is newer than the
   * draft's base, merge onto it (or freeze) as the notify would have. Not while a checkpoint is
   * being saved, whose own version this may be.
   */
  async catchUp(artifactId: string, current: number): Promise<void> {
    const doc = this.loaded;
    if (doc?.artifactId !== artifactId || current <= doc.baseVersion) return;
    if (this.lock && this.lock.until > Date.now()) return;
    await this.outside(doc, current, null);
  }

  /**
   * Drop the unsaved edits: the draft goes back to the current version. It runs under the
   * checkpoint lock, so it never interleaves with a save or the review's other choice: `busy`
   * while another checkpoint holds the lock; otherwise it takes the lock before its first read
   * (a snapshot arriving meanwhile is busy) and releases it when done. `lock` is the caller's own
   * checkpoint lock ("Discard mine" in the review), which it runs under and releases.
   * `conflictVersion` limits it to a draft frozen against that version, which must still be the
   * current one. `rev` (and `conflictVersion`) are checked before and after the reads.
   */
  async discard(
    artifactId: string,
    rev: number,
    opts: { lock?: string; conflictVersion?: number } = {},
  ): Promise<{ ok: boolean; rev: number; busy?: true }> {
    const doc = await this.ensure(artifactId);
    if (!doc) return { ok: true, rev: 0 };
    const held = this.lock && this.lock.until > Date.now() ? this.lock : null;
    if (held && held.id !== opts.lock) return { ok: false, rev: doc.rev, busy: true };
    const fits = () =>
      this.loaded === doc &&
      rev === doc.rev &&
      (opts.conflictVersion === undefined || doc.conflictVersion === opts.conflictVersion);
    if (!fits()) return { ok: false, rev: doc.rev };
    const lock: CheckpointLock = held ?? {
      id: `k_${randomString(12)}`,
      rev: doc.rev,
      text: "",
      hash: "",
      until: Date.now() + LIVE_DOC.checkpointLockS * 1000,
      resolved: false,
      epoch: "",
      base: doc.baseVersion,
    };
    this.lock = lock;
    const release = () => {
      if (this.lock === lock) this.lock = null;
    };
    try {
      const cur = await this.host.env.DB.prepare(
        "SELECT current_version FROM artifacts WHERE id = ?1",
      )
        .bind(artifactId)
        .first<{ current_version: number }>();
      const text = cur ? await this.versionText(doc, cur.current_version) : null;
      const reviewed =
        opts.conflictVersion === undefined || cur?.current_version === opts.conflictVersion;
      if (!cur || text === null || this.lock !== lock || !fits() || !reviewed) {
        return { ok: false, rev: doc.rev };
      }
      doc.lines = splitLines(text);
      doc.baseText = text;
      doc.baseVersion = cur.current_version;
      doc.conflictVersion = null;
      doc.epoch = randomString(12);
      doc.rev += 1;
      doc.lastBy = null;
      this.saving = [];
      this.revokeLeases("closed");
      this.broadcast({ t: "reset", version: doc.baseVersion, gen: doc.gen, rev: doc.rev });
      this.broadcastText(doc);
      this.needsFlush = true;
      await this.flushNow();
    } finally {
      release();
    }
    this.status(doc);
    await this.releaseIfIdle(doc);
    return { ok: true, rev: doc.rev };
  }

  /** The freshest draft, for reviewing a conflict. */
  async peek(artifactId: string) {
    const doc = await this.ensure(artifactId);
    if (!doc) return null;
    const out = {
      text: this.text(doc),
      base_version: doc.baseVersion,
      rev: doc.rev,
      conflict_version: doc.conflictVersion,
    };
    await this.releaseIfIdle(doc);
    return out;
  }
}
