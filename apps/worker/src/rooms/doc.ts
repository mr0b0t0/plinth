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
// The object's own storage holds one small record, never draft text (DOC_STATE_KEY): the draft's
// epoch and the checkpoint snapshots still being saved (their hash, rev, base, lock and whether
// they save a resolution). An idle room is evicted while a slow save runs (its sockets hibernate),
// and the record lets the next wake still know that save's version as its own and finish onto
// the same lines, instead of freezing the draft against it. While any snapshot is pending, the
// D1 row stays even when the draft is back at its base, so the wake reloads that base and those
// lines rather than taking the save's version as the draft.
//
// The room never creates a version. Checkpoints run on the app host (services/live.ts) through the
// stager, with this draft's base_version and its base's files; when a version is published from
// outside, a doc's draft is merged onto it when that is clean (merge3) and frozen for review when it
// is not, and a draft of every other type is frozen for review whenever the version changed its
// content. Draft text is never logged.
//
// Every type with `edit: "live"` has a draft here (docs, decks, sheets and design systems): the
// type's rules (liveTypes.ts) check each edit and each merge, so a sheet's draft is always valid
// canonical JSON lines, no text edit changes a deck's structure, a design system's draft is always
// its canonical line projection (designSystemLive.ts, held here in memory; D1 keeps its storage
// form), and no draft starts like an HTML document. A sheet's rows and columns move with `struct`,
// applied here and on every socket by the same pure function, only while nobody else holds a
// lease; a deck's notes and settings, and a design system's keys (dark values, optional texts,
// tokens), while no other lease overlaps the ranges the op touches, the other leases moving with
// their lines. A sheet's, a deck's or a design system's draft is never merged: a version published
// under it freezes it, and the editors review the whole draft beside it and publish theirs (with
// its base's files) or discard it. Both choices, and every save and discard, run under one
// checkpoint lock, so a frozen draft resolves exactly once.
import {
  type ArtifactTypeDef,
  applyLineEdit,
  blockLines,
  chunkText,
  type FileChangeSummary,
  type FileEntry,
  fileChanges,
  isLiveSource,
  isLiveType,
  joinLines,
  LIMITS,
  LIVE_DEFAULTS,
  LIVE_DOC,
  type LiveDocClientFrame,
  type LiveDocErrorCode,
  type LiveDocServerFrame,
  type LiveStructOp,
  type LiveTypeRules,
  liveRules,
  mapRange,
  merge3,
  rangesOverlap,
  shiftRange,
  splitLines,
  structOverlaps,
  summarizeFileChanges,
  typeDef,
  versionSourcePath,
} from "@plinth/shared";
import { type Bindings, getConfig } from "../config.ts";
import { randomString, sha256Hex } from "../lib/crypto.ts";
import { nowIso } from "../lib/time.ts";
import { type ManifestEntry, parseManifest } from "../services/storage.ts";

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
  /** The gen of the draft this socket was last sent (its welcome), so a reload can tell. */
  gen?: string;
}

/** What the room lends the doc channel. */
export interface DocHost {
  env: Bindings;
  /** Open doc sockets with their state. */
  sockets(): { ws: WebSocket; s: DocSocket }[];
  /** Store a socket's state (its attachment). */
  save(ws: WebSocket, s: DocSocket): boolean;
  /** The object's own storage, for the checkpoint record (DOC_STATE_KEY) only. */
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  send(ws: WebSocket, frame: LiveDocServerFrame): void;
  /** The artifact is gone: close every socket. */
  gone(): void;
  /** The draft ended (an HTML deck became current with nothing to keep): close the doc sockets. */
  closeDocs(): void;
  /** Close one doc socket so that it reconnects and takes the draft again (ROOM_CLOSE.resync). */
  resync(ws: WebSocket): void;
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
  /** The checkpoint lock this snapshot took ("" when it took none), for finish and abort. */
  lock: string;
  /** The draft's epoch when snapshotted, for finish (see `Loaded.epoch`). */
  epoch: string;
  /** Why the draft cannot become a version yet (LiveTypeRules.unpublishable), or null. */
  unpublishable: "empty" | null;
}

/** What a discard did: `ok`, or why not (`busy`: another holder has the checkpoint lock). */
export interface DocDiscardResult {
  ok: boolean;
  rev: number;
  busy?: true;
  /**
   * With a conflict version: "resolved" when the draft is no longer frozen (another choice ran),
   * "conflict" when a newer version froze it (`version` names it), "moved" when `rev` is not the
   * draft's.
   */
  reason?: "resolved" | "conflict" | "moved";
  version?: number;
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
  /** While frozen: the files conflictVersion changed since baseVersion, for the review. */
  conflictFiles: FileChangeSummary | null;
  /** The socket whose edit made the latest rev (for the last-writer autosave). */
  lastBy: string | null;
  /** The email behind the latest edit (updated_by_user). */
  lastEmail: string | null;
  lastEditAt: string | null;
}

/** A checkpoint's snapshot, and its lock while it holds it. Stored as is (no text). */
interface CheckpointLock {
  /** Random per snapshot: only the checkpoint that took the lock can release it. */
  id: string;
  rev: number;
  /** sha256 of the text it saves ("" until snapshotted): its version is known by this. */
  hash: string;
  until: number;
  /** The snapshot was of a frozen draft: the checkpoint is "Publish your changes" in the review. */
  resolved: boolean;
  /** The draft's epoch when snapshotted ("" until then): its version finishes onto these lines. */
  epoch: string;
  /** The draft's base_version when snapshotted. */
  base: number;
}

/** The object's storage key for the draft's epoch and the pending checkpoints. */
export const DOC_STATE_KEY = "live-doc";

/**
 * Storage key of the lines the doc sockets were last shown (DocSync): written when the draft is
 * loaded and after each flush, so a reload after a hibernation wake can tell whether the sockets
 * still open saw the lines it loaded.
 */
export const DOC_SYNC_KEY = "live-doc-sync";

/** The draft as the open sockets know it: its gen and rev, its base, its freeze and its lines. */
interface DocSync {
  artifactId: string;
  gen: string;
  rev: number;
  base: number;
  conflict: number | null;
  /** SHA-256 of the lines. */
  hash: string;
}

/** What DOC_STATE_KEY holds. */
interface DocState {
  artifactId: string;
  /** The draft's epoch (`Loaded.epoch`), so a reload goes on with it. */
  epoch: string;
  saving: CheckpointLock[];
}

/** How two versions' files compare: by hash, or by where they are stored and their size. */
function fileKey(e: ManifestEntry): string {
  return e.sha256 ? `h:${e.sha256}` : `s:${e.stored_at ?? ""}:${e.size_bytes}`;
}

/** A version's files besides its source, keyed by path (the reserved paths are not files). */
function fileSet(def: ArtifactTypeDef, manifest: string): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  for (const e of parseManifest(manifest)) {
    if (!def.reservedPaths.includes(e.path)) out.set(e.path, e);
  }
  return out;
}

function sameFiles(a: Map<string, ManifestEntry>, b: Map<string, ManifestEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, e] of a) {
    const o = b.get(path);
    if (!o || fileKey(o) !== fileKey(e)) return false;
  }
  return true;
}

const asEntries = (m: Map<string, ManifestEntry>): FileEntry[] =>
  [...m.values()].map((e) => ({
    path: e.path,
    size_bytes: e.size_bytes,
    sha256: e.sha256 ?? null,
  }));

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
  /**
   * The artifact and epoch DOC_STATE_KEY was last written with (null while nothing was): a load
   * goes on with that epoch, since every change of epoch writes it.
   */
  private kept: { artifactId: string; epoch: string } | null = null;
  /** DOC_SYNC_KEY as last written or read. */
  private synced: DocSync | null = null;
  private restoring: Promise<void> | null = null;
  private needsFlush = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly host: DocHost) {}

  // ---------- loading ----------

  /** The draft in memory, loading it from D1 (or the current version in R2) on first use. */
  async ensure(artifactId: string): Promise<Loaded | null> {
    if (this.loaded?.artifactId === artifactId) return this.loaded;
    this.loading ??= this.restore()
      .then(() => this.load(artifactId))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /**
   * Once per instance: the pending checkpoints and the epoch from the object's storage (after an
   * eviction, the memory is new). A snapshot whose lock has not run out holds it again.
   */
  private restore(): Promise<void> {
    this.restoring ??= (async () => {
      let st: DocState | undefined;
      try {
        st = await this.host.storage.get<DocState>(DOC_STATE_KEY);
        this.synced ??= (await this.host.storage.get<DocSync>(DOC_SYNC_KEY)) ?? null;
      } catch {
        console.error("live doc state read failed");
      }
      if (!st || this.kept) return;
      this.kept = { artifactId: st.artifactId, epoch: st.epoch };
      this.saving = st.saving;
      const last = st.saving.at(-1);
      if (!this.lock && last && last.until > Date.now()) this.lock = last;
    })();
    return this.restoring;
  }

  /** Write DOC_STATE_KEY (the epoch and the pending checkpoints) after either changed. */
  private persist(doc: Loaded | null = this.loaded): void {
    const at = doc ? { artifactId: doc.artifactId, epoch: doc.epoch } : this.kept;
    if (!at) return;
    this.kept = at;
    const state: DocState = { ...at, saving: this.saving };
    this.host.storage.put(DOC_STATE_KEY, state).catch(() => {
      console.error("live doc state write failed");
    });
  }

  /** The lines were replaced: a new epoch, which a reload goes on with. */
  private newEpoch(doc: Loaded): void {
    doc.epoch = randomString(12);
    this.pruneSaving(doc);
    this.persist(doc);
  }

  private async load(artifactId: string): Promise<Loaded | null> {
    const DB = this.host.env.DB;
    const row = await DB.prepare(
      `SELECT a.type, a.current_version, a.deleted_at, a.taken_down_at,
              d.base_version, d.content, d.rev, d.conflict_version,
              (SELECT r2_prefix FROM versions
                WHERE artifact_id = a.id AND number = coalesce(d.base_version, a.current_version)) AS base_prefix,
              (SELECT manifest FROM versions
                WHERE artifact_id = a.id AND number = a.current_version) AS current_manifest
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
        current_manifest: string | null;
      }>();
    if (!row || row.deleted_at || row.taken_down_at || !row.base_prefix) return null;
    const def = typeDef(row.type);
    const rules = liveRules(row.type);
    if (!isLiveType(def) || !def || !rules) return null;
    const draft = row.content !== null && row.base_version !== null && row.rev !== null;
    // An HTML deck (deck.json) is never edited on its page: no draft opens on it. A Markdown
    // deck's draft from before it loads, frozen against it (outsideHtml), for its review only.
    const current = versionSourcePath(def, parseManifest(row.current_manifest ?? "[]"));
    if (!isLiveSource(def, current) && !draft) return null;
    const baseSource = await this.readVersionText(row.base_prefix, def);
    if (baseSource === null) return null;
    // The draft's lines are the type's live form of its source (identity for docs, decks and sheets).
    const baseText = rules.toLive(baseSource);
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
      lines: splitLines(draft ? rules.toLive(row.content as string) : baseText),
      conflictVersion: draft ? row.conflict_version : null,
      conflictFiles: null,
      lastBy: null,
      lastEmail: null,
      lastEditAt: null,
    };
    if (this.kept?.artifactId === artifactId) {
      // The lines are the ones last flushed under this epoch (every replacement writes a new one).
      doc.epoch = this.kept.epoch;
      // A rev never comes back below a pending snapshot's (a draft with no row, never durable at
      // the owner's limit, reloads at rev 0): a snapshot's rev is matched only by its own lines.
      const floor = Math.max(0, ...this.saving.map((r) => r.rev));
      if (doc.rev < floor) {
        doc.rev = floor + 1;
        doc.flushedRev = doc.rev;
      }
    }
    if (doc.conflictVersion !== null) {
      doc.conflictFiles = await this.filesBetween(doc, doc.baseVersion, doc.conflictVersion);
    }
    // Sockets still open across a hibernation wake were shown the draft as DOC_SYNC_KEY records
    // it. When the loaded lines are exactly those, the room goes on with that gen and rev, so they
    // stay in step. Otherwise (a version published while the room slept, edits lost with an
    // eviction) their lines are not the room's: they take the draft again (restoreLeases).
    const hash = await sha256Hex(this.text(doc));
    const was = this.synced;
    // Only for sockets still open: with none, a reload starts afresh, as it always has.
    const shown = this.host.sockets().some(({ s }) => s.gen !== undefined && s.gen === was?.gen);
    if (
      shown &&
      was?.artifactId === artifactId &&
      was.hash === hash &&
      was.base === doc.baseVersion &&
      was.conflict === doc.conflictVersion &&
      doc.rev <= was.rev
    ) {
      doc.gen = was.gen;
      doc.rev = was.rev;
      doc.flushedRev = Math.max(doc.flushedRev, was.rev);
    }
    this.loaded = doc;
    this.restoreLeases(doc);
    this.writeSync(doc, doc.rev, hash);
    // A version published while nobody held the draft in memory (or whose notify was lost).
    if (doc.baseVersion < row.current_version) await this.outside(doc, row.current_version, null);
    return this.loaded;
  }

  private async readVersionText(prefix: string, def: ArtifactTypeDef): Promise<string | null> {
    const obj = await this.host.env.FILES.get(`${prefix}${def.sourcePath}`);
    return obj ? obj.text() : null;
  }

  /** Version n's source file as stored, or null. */
  private async versionSource(doc: Loaded, n: number): Promise<string | null> {
    const v = await this.host.env.DB.prepare(
      "SELECT r2_prefix FROM versions WHERE artifact_id = ?1 AND number = ?2",
    )
      .bind(doc.artifactId, n)
      .first<{ r2_prefix: string }>();
    return v ? this.readVersionText(v.r2_prefix, doc.def) : null;
  }

  /** Version n's source in the draft's live form, or null. */
  private async versionText(doc: Loaded, n: number): Promise<string | null> {
    const text = await this.versionSource(doc, n);
    return text === null ? null : doc.rules.toLive(text);
  }

  /** The two versions' files (one D1 read), or null when either is missing. */
  private async fileSets(
    doc: Loaded,
    a: number,
    b: number,
  ): Promise<{ a: Map<string, ManifestEntry>; b: Map<string, ManifestEntry> } | null> {
    const r = await this.host.env.DB.prepare(
      "SELECT number, manifest FROM versions WHERE artifact_id = ?1 AND number IN (?2, ?3)",
    )
      .bind(doc.artifactId, a, b)
      .all<{ number: number; manifest: string }>();
    const rows = r.results ?? [];
    const ma = rows.find((x) => x.number === a);
    const mb = rows.find((x) => x.number === b);
    if (!ma || !mb) return null;
    return { a: fileSet(doc.def, ma.manifest), b: fileSet(doc.def, mb.manifest) };
  }

  /** What version b changed in the files of version a, as the review lists it. */
  private async filesBetween(doc: Loaded, a: number, b: number): Promise<FileChangeSummary | null> {
    const sets = await this.fileSets(doc, a, b);
    return sets ? summarizeFileChanges(fileChanges(asEntries(sets.a), asEntries(sets.b))) : null;
  }

  /**
   * Leases come back from the sockets' attachments; any that no longer fit are dropped. A socket
   * shown another gen of the draft (an earlier load) holds a range of lines the room may not have
   * any more, and its requests are worked out from them: its lease ends and it is closed, so it
   * reconnects and takes the draft again, and nothing it sends meanwhile is applied (message).
   */
  private restoreLeases(doc: Loaded): void {
    const kept: StoredLease[] = [];
    const stale: WebSocket[] = [];
    for (const { ws, s } of this.host.sockets()) {
      if (s.gen !== undefined && s.gen !== doc.gen) {
        stale.push(ws);
        if (s.lease) {
          s.lease = null;
          this.host.save(ws, s);
        }
        continue;
      }
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
    for (const ws of stale) this.host.resync(ws);
  }

  /** Record the draft as the sockets are shown it (DOC_SYNC_KEY), `hash` being its lines'. */
  private writeSync(
    doc: Loaded,
    rev: number,
    hash: string,
    base = doc.baseVersion,
    conflict = doc.conflictVersion,
  ): void {
    const sync: DocSync = { artifactId: doc.artifactId, gen: doc.gen, rev, base, conflict, hash };
    this.synced = sync;
    this.host.storage.put(DOC_SYNC_KEY, sync).catch(() => {
      console.error("live doc sync write failed");
    });
  }

  /** Drop the in-memory draft (the artifact is gone). A pending flush is cancelled. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.loaded = null;
    this.lock = null;
    this.saving = [];
    this.needsFlush = false;
    this.kept = null;
    this.synced = null;
    this.host.storage.delete(DOC_SYNC_KEY).catch(() => undefined);
    this.host.storage.delete(DOC_STATE_KEY).catch(() => {
      console.error("live doc state delete failed");
    });
  }

  // ---------- sockets ----------

  private text(doc: Loaded): string {
    return joinLines(doc.lines);
  }

  private broadcast(frame: LiveDocServerFrame, except?: WebSocket): void {
    for (const { ws } of this.host.sockets()) if (ws !== except) this.host.send(ws, frame);
  }

  /**
   * The client frame being handled and its `id` (docs/spec.md "Editing", the room protocol): set
   * only while its handler runs, synchronously, so only that frame's direct answers carry `re`.
   */
  private answering: { ws: WebSocket; id: number } | null = null;

  /** `frame` as the direct answer to the frame `ws` sent, with its `re` when it had an id. */
  private withRe<F extends LiveDocServerFrame>(ws: WebSocket, frame: F): F {
    const a = this.answering;
    return a && a.ws === ws ? { ...frame, re: a.id } : frame;
  }
  /** Sends `ws` the direct answer to its frame. */
  private answer(ws: WebSocket, frame: LiveDocServerFrame): void {
    this.host.send(ws, this.withRe(ws, frame));
  }
  /** Broadcasts a frame that answers `ws`'s frame: `ws`'s copy carries `re`. */
  private answerAll(ws: WebSocket, frame: LiveDocServerFrame): void {
    for (const o of this.host.sockets())
      this.host.send(o.ws, o.ws === ws ? this.withRe(ws, frame) : frame);
  }
  /** Refuses `ws`'s frame with an error that answers it. */
  private refuse(ws: WebSocket, code: LiveDocErrorCode): void {
    this.answer(ws, { t: "error", code });
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
    if (s.gen !== doc.gen) {
      s.gen = doc.gen;
      this.host.save(ws, s);
    }
    const all = this.host.sockets();
    this.answer(ws, {
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
      ...(doc.conflictVersion !== null && doc.conflictFiles ? { files: doc.conflictFiles } : {}),
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
    // A draft frozen against an HTML deck is joined only for its review: frozen, it takes no lease,
    // edit or struct op, and its socket's only use is the review's choices.
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

  /** An error that answers no frame (`draft_limit` after a flush). */
  private error(ws: WebSocket, code: LiveDocErrorCode): void {
    this.host.send(ws, { t: "error", code });
  }

  /** One frame from a doc socket, already size-checked and parsed. */
  async message(ws: WebSocket, s: DocSocket, f: LiveDocClientFrame, artifactId: string) {
    const doc = await this.ensure(artifactId);
    if (!doc) return this.host.gone();
    // Sent from lines of another gen (the room reloaded meanwhile, restoreLeases): never applied
    // to these. The socket is closed so that it takes the draft again.
    if (s.gen !== undefined && s.gen !== doc.gen) return this.host.resync(ws);
    // Its direct answers carry its id as `re`; a frame from an older tab has none, and they none.
    this.answering = f.id === undefined ? null : { ws, id: f.id };
    try {
      this.handle(ws, s, doc, f);
    } finally {
      this.answering = null;
    }
  }

  /** A draft being ended (dropDraft): its frames are refused, so its sockets keep their typing. */
  private ending: Loaded | null = null;

  private handle(ws: WebSocket, s: DocSocket, doc: Loaded, f: LiveDocClientFrame) {
    if (this.ending === doc && f.t !== "sync") {
      // As a frozen draft answers: the client keeps what it typed, and the closed sockets bring
      // everyone back to the version the draft ended for.
      if (f.t === "struct") return this.answer(ws, { t: "struct_denied", reason: "frozen" });
      if (f.t === "release" || f.t === "keep") return this.refuse(ws, "not_held");
      return this.answer(ws, { t: "lease_denied", reason: "frozen" });
    }
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
      case "keep":
        return this.keep(ws, s, f.lease);
      case "struct":
        return this.struct(ws, s, doc, f.rev, f.op);
    }
  }

  private holderOf(id: string): { ws: WebSocket; s: DocSocket } | null {
    return this.host.sockets().find((o) => o.s.lease?.id === id) ?? null;
  }

  private lease(ws: WebSocket, s: DocSocket, doc: Loaded, rev: number, start: number, end: number) {
    if (s.doc !== "write") return this.answer(ws, { t: "lease_denied", reason: "watch" });
    if (doc.conflictVersion !== null) {
      return this.answer(ws, { t: "lease_denied", reason: "frozen" });
    }
    if (rev !== doc.rev) return this.answer(ws, { t: "lease_denied", reason: "stale" });
    if (end > doc.lines.length || start > end) return this.refuse(ws, "invalid");
    const want = { start, end };
    for (const o of this.host.sockets()) {
      if (o.ws === ws || !o.s.lease) continue;
      if (rangesOverlap(o.s.lease, want)) {
        return this.answer(ws, { t: "lease_denied", reason: "held", by: o.s.email });
      }
    }
    // One lease per socket: taking a block releases the one held before.
    const prev = s.lease?.id;
    s.lease = { id: `l_${randomString(12)}`, start, end, at: Date.now() };
    this.host.save(ws, s);
    if (prev) this.broadcast({ t: "released", lease: prev });
    this.answerAll(ws, { t: "leased", lease: s.lease.id, start, end, holder: s.id, by: s.email });
  }

  private edit(ws: WebSocket, s: DocSocket, doc: Loaded, id: string, seq: number, text: string) {
    if (s.doc !== "write") return this.answer(ws, { t: "lease_denied", reason: "watch" });
    const l = s.lease;
    if (!l || l.id !== id) return this.refuse(ws, "not_held");
    if (doc.conflictVersion !== null) {
      return this.answer(ws, { t: "lease_denied", reason: "frozen" });
    }
    const ins = blockLines(text);
    // The type's rules first (a sheet's rows and header), then its size.
    const refused = doc.rules.checkEdit(doc.lines, l.start, l.end - l.start, ins);
    if (refused) return this.refuse(ws, refused);
    const next = applyLineEdit(doc.lines, l.start, l.end - l.start, ins);
    if (doc.rules.tooLarge(joinLines(next))) return this.refuse(ws, "too_large");
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
    this.answerAll(ws, {
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
    if (!s.lease || s.lease.id !== id) return this.refuse(ws, "not_held");
    s.lease = null;
    this.host.save(ws, s);
    this.answerAll(ws, { t: "released", lease: id });
    // A finished block is written straight away.
    if (this.needsFlush) void this.flushNow();
    else this.status(doc);
  }

  /**
   * The holder says its lease is in use though it sends no edit (typing it cannot write yet): the
   * lease's idle clock starts again, as after an edit, and the socket is answered `kept`.
   * A holder that sends neither for LIMITS.liveLeaseIdleS can still be taken over.
   */
  private keep(ws: WebSocket, s: DocSocket, id: string) {
    if (s.doc !== "write") return this.answer(ws, { t: "lease_denied", reason: "watch" });
    if (!s.lease || s.lease.id !== id) return this.refuse(ws, "not_held");
    s.lease = { ...s.lease, at: Date.now() };
    this.host.save(ws, s);
    this.answer(ws, { t: "kept", lease: id });
  }

  private takeover(ws: WebSocket, s: DocSocket, doc: Loaded, id: string) {
    if (s.doc !== "write") return this.answer(ws, { t: "lease_denied", reason: "watch" });
    if (doc.conflictVersion !== null) {
      return this.answer(ws, { t: "lease_denied", reason: "frozen" });
    }
    const holder = this.holderOf(id);
    if (!holder?.s.lease) return this.refuse(ws, "not_held");
    // Its own lease: the answer is the lease it holds.
    if (holder.ws === ws) {
      const own = holder.s.lease;
      return this.answer(ws, {
        t: "leased",
        lease: own.id,
        start: own.start,
        end: own.end,
        holder: s.id,
        by: s.email,
      });
    }
    if (Date.now() - holder.s.lease.at < LIMITS.liveLeaseIdleS * 1000) {
      return this.answer(ws, { t: "lease_denied", reason: "held", by: holder.s.email });
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
    this.answerAll(ws, { t: "leased", lease: s.lease.id, start, end, holder: s.id, by: s.email });
  }

  /**
   * A structural change (a sheet's rows or columns, a deck's notes or settings, a design system's
   * keys): a writer's, at the current rev, of a kind the artifact's type takes, while no other
   * socket's lease overlaps what the op touches ("all" for a sheet: no other lease at all, so no
   * lease has to move; a deck's or a design system's ranges per structOverlaps, and every lease then
   * moves by the op's line map). The sender's own lease ends first unless its type keeps it and the
   * map keeps it (a deck's: LiveStructRules.keepsSenderLease); the op is applied with the type's
   * pure function and broadcast as it came, and every socket applies it to the same lines. The
   * result must be a draft the type can hold.
   */
  private struct(ws: WebSocket, s: DocSocket, doc: Loaded, rev: number, op: LiveStructOp) {
    if (s.doc !== "write") return this.answer(ws, { t: "struct_denied", reason: "watch" });
    const rules = doc.rules.struct;
    if (!rules?.kinds.includes(op.op)) return this.refuse(ws, "invalid");
    if (doc.conflictVersion !== null) {
      return this.answer(ws, { t: "struct_denied", reason: "frozen" });
    }
    if (rev !== doc.rev) return this.answer(ws, { t: "struct_denied", reason: "stale" });
    const touched = rules.touches(doc.lines, op);
    for (const o of this.host.sockets()) {
      const l = o.s.lease;
      if (o.ws === ws || !l) continue;
      if (touched === "all" || touched.some((r) => structOverlaps(r, l))) {
        return this.answer(ws, { t: "struct_denied", reason: "held", by: o.s.email });
      }
    }
    // Two parses of the sheet per struct (the op's, then valid()'s check of its canonical result):
    // kept, since struct frames are rare next to edits and the second proves what is stored.
    const applied = rules.apply(doc.lines, op);
    if ("error" in applied) return this.refuse(ws, applied.error);
    const next = applied.lines;
    const text = joinLines(next);
    if (doc.rules.tooLarge(text)) return this.refuse(ws, "too_large");
    if (!doc.rules.valid(text)) return this.refuse(ws, "invalid");
    // With real ranges (a deck, a design system), every other lease moves by the op's line map: none overlaps what
    // the op touched, so each keeps its lines. The sender keeps its own lease the same way when the
    // op did not touch it. Without a map (a sheet, "all"), nobody else holds one.
    const ranges = touched === "all" ? null : touched;
    const map = ranges ? applied.map : undefined;
    const moved = (l: { start: number; end: number }) =>
      map && ranges && !ranges.some((r) => structOverlaps(r, l))
        ? mapRange(l, map, doc.lines.length, next.length)
        : null;
    if (s.lease) {
      const kept = rules.keepsSenderLease ? moved(s.lease) : null;
      if (kept) {
        s.lease = { ...s.lease, ...kept };
        this.host.save(ws, s);
      } else {
        const id = s.lease.id;
        s.lease = null;
        this.host.save(ws, s);
        this.broadcast({ t: "released", lease: id });
      }
    }
    if (map) {
      for (const o of this.host.sockets()) {
        if (o.ws === ws || !o.s.lease) continue;
        const kept = moved(o.s.lease);
        if (!kept) {
          // Never: the overlap check above refused an op that touches a held lease.
          const id = o.s.lease.id;
          o.s.lease = null;
          this.host.save(o.ws, o.s);
          this.host.send(o.ws, { t: "lease_lost", lease: id, reason: "closed" });
          this.broadcast({ t: "released", lease: id }, o.ws);
        } else if (kept.start !== o.s.lease.start || kept.end !== o.s.lease.end) {
          o.s.lease = { ...o.s.lease, ...kept };
          this.host.save(o.ws, o.s);
        }
      }
    }
    doc.lines = next;
    doc.rev += 1;
    doc.lastBy = s.id;
    doc.lastEmail = s.email;
    doc.lastEditAt = nowIso();
    // As it came: the frame schema checked it (a design system's value is any JSON there).
    const sent = op as Extract<LiveDocServerFrame, { t: "struct" }>["op"];
    this.answerAll(ws, { t: "struct", gen: doc.gen, rev: doc.rev, op: sent, by: s.id });
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
    const live = this.text(doc);
    const base = doc.baseVersion;
    const conflict = doc.conflictVersion;
    // What is stored is the type's source form of the lines (identity for docs, decks and sheets).
    const text = doc.rules.fromLive(live);
    const atBase = live === doc.baseText && doc.conflictVersion === null;
    // Equal to its base: there is no draft, and a reload takes "no row" as the current version.
    // Not while a snapshot is still being saved: its version would load as the base and the
    // finish drop the snapshot as already in it, losing an undo made during the save. The row is
    // kept (at its base) until the last pending snapshot is done with (settle).
    if (atBase && !this.saving.length) {
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
          if (!atBase) for (const { ws } of this.host.sockets()) this.error(ws, "draft_limit");
          return;
        }
        // A newer rev is already stored: nothing to do.
        return;
      }
    }
    if (this.loaded !== doc) return;
    doc.flushedRev = Math.max(doc.flushedRev, rev);
    this.broadcast({ t: "flushed", rev: doc.flushedRev });
    // What a reload finds is what the sockets were shown at `rev` (DOC_SYNC_KEY).
    const hash = await sha256Hex(live);
    if (this.loaded === doc) this.writeSync(doc, rev, hash, base, conflict);
  }

  // ---------- versions published from outside ----------

  /** A version was committed (an agent, the source editor, a restore, REST, or a checkpoint). */
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
    if (!rec || !this.saving.includes(rec)) return;
    this.saving = this.saving.filter((r) => r !== rec);
    this.persist();
    this.settle();
  }

  /**
   * The last pending snapshot is done with: a draft kept at its base for it (write) has no row
   * any more. The flush deletes it (a no-op when there was none).
   */
  private settle(): void {
    const doc = this.loaded;
    if (this.saving.length || !doc || doc.conflictVersion !== null) return;
    if (this.text(doc) === doc.baseText) this.scheduleFlush();
  }

  /**
   * Snapshots that can no longer publish or be recognized: taken on a base the draft has moved
   * past (the stager refuses their base as stale), or on lines replaced since whose lock ran out.
   */
  private pruneSaving(doc: Loaded): void {
    const now = Date.now();
    const live = this.saving.filter(
      (r) => r.base >= doc.baseVersion && (r.epoch === doc.epoch || r.until > now),
    );
    if (live.length === this.saving.length) return;
    this.saving = live;
    this.persist(doc);
    this.settle();
  }

  /**
   * Version `n` was published while the draft is loaded (an agent, a restore, REST, another tab),
   * and it is newer than the draft's base and than any version the draft is frozen against.
   * - A pending checkpoint's own version (its hash): that checkpoint finishes (finish).
   * - No changes: the draft moves to `n`, text and files (`reset`).
   * - A doc (merge "lines"): #49's rule. A clean merge3 that fits and that the type can hold
   *   rebases the draft onto `n` (`rebased`, the merged text on n's files); anything else freezes.
   * - Every other type (merge "review") is never merged. A version's content is its source and its
   *   files together. When `n`'s content is the draft's base's (it changed only the title, or
   *   restored the same content), the base moves under the draft's lines as they are (`rebased`,
   *   which also unfreezes a draft frozen against an older version); when it is the draft, the
   *   draft ends (`reset`); anything else freezes it for review.
   * - An HTML deck (a deck whose source is deck.json), which is never edited on its page: a draft
   *   with no changes ends, one with changes freezes for its review (outsideHtml).
   * A frozen draft takes no edits; the `conflict` frame says which files `n` changed.
   */
  private async outside(doc: Loaded, n: number, hash: string | null): Promise<void> {
    if (n <= doc.baseVersion) return;
    // Already frozen against this version (or a newer one): nothing new to review.
    if (doc.conflictVersion !== null && n <= doc.conflictVersion) return;
    if (doc.def.altSource && (await this.htmlVersion(doc, n))) return this.outsideHtml(doc, n);
    const source = await this.versionSource(doc, n);
    // Its hash, as a pending checkpoint's snapshot holds it (the notify's, or from its source when
    // it came without one: the alarm's catch-up, a load).
    const theirHash =
      source !== null && this.saving.length ? (hash ?? (await sha256Hex(source))) : null;
    const stale = () =>
      this.loaded !== doc ||
      n <= doc.baseVersion ||
      (doc.conflictVersion !== null && n <= doc.conflictVersion);
    if (source === null || stale()) return;
    const own = theirHash === null ? null : this.pendingCheckpoint(doc, theirHash);
    if (own) {
      // A pending checkpoint's own version (its finish RPC may not arrive), even when its lock
      // ran out while the stager wrote it, or the room was evicted meanwhile.
      this.finish(doc, n, source, own, own.rev, own.resolved);
      await this.refreeze(doc, n);
      await this.flushNow();
      return;
    }
    const theirs = doc.rules.toLive(source);
    const ours = this.text(doc);
    if (ours === doc.baseText && doc.conflictVersion === null) {
      this.replace(doc, n, theirs, null, "rebased");
      await this.flushNow();
      this.status(doc);
      return;
    }
    if (doc.rules.merge === "lines") {
      const m = merge3(doc.baseText, ours, theirs, { maxEdits: LIVE_DOC.maxMergeEdits });
      // A clean merge the type cannot hold is reviewed like an overlap.
      if (m.clean && !doc.rules.tooLarge(m.text) && doc.rules.valid(m.text)) {
        doc.lines = splitLines(m.text);
        doc.baseText = theirs;
        doc.baseVersion = n;
        doc.conflictVersion = null;
        doc.conflictFiles = null;
        doc.rev += 1;
        this.newEpoch(doc);
        this.revokeLeases("rebased");
        this.broadcast({ t: "rebased", version: n, gen: doc.gen, rev: doc.rev });
        this.broadcastText(doc);
      } else {
        const base = doc.baseVersion;
        const files = await this.filesBetween(doc, base, n);
        if (stale()) return;
        // A save finished meanwhile: the files (and the merge) were for the old base.
        if (doc.baseVersion !== base) return this.outside(doc, n, hash);
        this.freeze(doc, n, files);
      }
    } else {
      const base = doc.baseVersion;
      const sets = await this.fileSets(doc, base, n);
      if (stale()) return;
      if (doc.baseVersion !== base) return this.outside(doc, n, hash);
      // Edits applied (and acknowledged) during the read are part of the draft compared below.
      const now = this.text(doc);
      const same = sets !== null && sameFiles(sets.a, sets.b);
      if (same && theirs === doc.baseText) {
        // n holds nothing the draft would leave out: its lines stay as they are, on n.
        doc.baseText = theirs;
        doc.baseVersion = n;
        doc.conflictVersion = null;
        doc.conflictFiles = null;
        doc.rev += 1;
        this.newEpoch(doc);
        this.revokeLeases("rebased");
        this.broadcast({ t: "rebased", version: n, gen: doc.gen, rev: doc.rev });
        this.broadcastText(doc);
      } else if (same && theirs === now) {
        // n is the draft: nothing is unpublished any more.
        this.replace(doc, n, theirs, null, "closed");
      } else {
        this.freeze(
          doc,
          n,
          sets ? summarizeFileChanges(fileChanges(asEntries(sets.a), asEntries(sets.b))) : null,
        );
      }
    }
    this.needsFlush = true;
    await this.flushNow();
    this.status(doc);
  }

  /** The draft becomes version n's text exactly, on n (a new epoch); `why` when a choice did it. */
  private replace(
    doc: Loaded,
    n: number,
    text: string,
    why: "published" | "discarded" | null,
    leases: "rebased" | "closed",
  ): void {
    doc.lines = splitLines(text);
    doc.baseText = text;
    doc.baseVersion = n;
    doc.conflictVersion = null;
    doc.conflictFiles = null;
    doc.rev += 1;
    this.newEpoch(doc);
    this.revokeLeases(leases);
    this.broadcast({
      t: "reset",
      version: n,
      gen: doc.gen,
      rev: doc.rev,
      ...(why ? { why } : {}),
    });
    this.broadcastText(doc);
    this.needsFlush = true;
  }

  /** Freeze the draft against version n for review: every lease ends, edits are refused. */
  private freeze(doc: Loaded, n: number, files: FileChangeSummary | null): void {
    doc.conflictVersion = n;
    doc.conflictFiles = files;
    this.revokeLeases("closed");
    this.broadcast({ t: "conflict", version: n, ...(files ? { files } : {}) });
  }

  /** Whether version n of the draft's artifact is stored in the type's altSource (an HTML deck). */
  private async htmlVersion(doc: Loaded, n: number): Promise<boolean> {
    const row = await this.host.env.DB.prepare(
      "SELECT manifest FROM versions WHERE artifact_id = ?1 AND number = ?2",
    )
      .bind(doc.artifactId, n)
      .first<{ manifest: string }>();
    return (
      row !== null &&
      !isLiveSource(doc.def, versionSourcePath(doc.def, parseManifest(row.manifest)))
    );
  }

  /**
   * Version n is an HTML deck, which is never edited on its page: nothing can be merged onto it or
   * reset to it. A draft with no changes, and no lease held on it, ends: its row goes (it never
   * counts toward the owner's draft limit) and its sockets close. Any other draft freezes against
   * n and is kept for the people editing it, whose review publishes their deck as the next version
   * or discards it: one with changes, and one whose lease is held, since its holder may have typing
   * on its way (in the debounce, or sent with no answer), which goes back in after the review. A
   * socket that joins it (a reload, which the gate allows only for that review) finds it frozen:
   * no lease, edit or struct op.
   */
  private async outsideHtml(doc: Loaded, n: number): Promise<void> {
    if (this.loaded !== doc || n <= doc.baseVersion) return;
    if (doc.conflictVersion !== null && n <= doc.conflictVersion) return;
    const held = this.host.sockets().some(({ s }) => Boolean(s.lease));
    if (
      this.text(doc) === doc.baseText &&
      doc.conflictVersion === null &&
      !this.saving.length &&
      !held
    ) {
      await this.dropDraft(doc);
      return;
    }
    const files = await this.filesBetween(doc, doc.baseVersion, n);
    if (this.loaded !== doc || (doc.conflictVersion !== null && n <= doc.conflictVersion)) return;
    this.freeze(doc, n, files);
    this.needsFlush = true;
    await this.flushNow();
    this.status(doc);
  }

  /** The draft ends with nothing to keep: its leases, its row and its sockets go. */
  private async dropDraft(doc: Loaded): Promise<void> {
    // From here no frame changes the draft: one that came while the row is deleted would be
    // applied, acknowledged and then lost with the draft (the client drops its copy on the ack).
    this.ending = doc;
    this.revokeLeases("closed");
    try {
      await this.host.env.DB.prepare("DELETE FROM live_drafts WHERE artifact_id = ?1")
        .bind(doc.artifactId)
        .run();
      if (this.loaded === doc) this.loaded = null;
      this.needsFlush = false;
      this.host.closeDocs();
    } finally {
      if (this.ending === doc) this.ending = null;
    }
  }

  /**
   * A checkpoint's version `n` became the base of a draft still frozen against a newer version:
   * the review now runs from n, so the conflict names the files that version changed since n. A
   * version that froze the draft (or a save that moved its base) during the read set its own.
   */
  private async refreeze(doc: Loaded, n: number): Promise<void> {
    const frozen = doc.conflictVersion;
    if (frozen === null || doc.baseVersion !== n) return;
    const files = await this.filesBetween(doc, n, frozen);
    if (this.loaded === doc && doc.conflictVersion === frozen && doc.baseVersion === n) {
      this.freeze(doc, frozen, files);
    }
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
      unpublishable: null,
    };
    if (!doc) return { state: "gone", ...empty, unchanged: true };
    if (this.lock && this.lock.until > Date.now()) {
      return {
        state: "busy",
        ...empty,
        rev: doc.rev,
        base_version: doc.baseVersion,
        conflict_version: doc.conflictVersion,
        unchanged: false,
      };
    }
    // The lock is taken before the flush awaits D1, so a second snapshot (or a discard) arriving
    // meanwhile is busy instead of saving the same base. Its hash is filled in once flushed (an
    // empty hash never matches a version notify).
    const lock: CheckpointLock = {
      id: `k_${randomString(12)}`,
      rev: doc.rev,
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
        ? {
            state: "busy",
            ...empty,
            rev: doc.rev,
            base_version: doc.baseVersion,
            conflict_version: doc.conflictVersion,
            unchanged: false,
          }
        : { state: "gone", ...empty, unchanged: true };
    }
    const live = this.text(doc);
    // What a version stores is the type's source form of the lines (identity for docs, decks and sheets).
    const text = doc.rules.fromLive(live);
    const epoch = doc.epoch;
    const unchanged = live === doc.baseText;
    const hash = await sha256Hex(text);
    const state = doc.conflictVersion !== null ? "conflict" : unchanged ? "clean" : "ready";
    if (state === "clean") {
      if (this.lock === lock) this.lock = null;
    } else if (this.lock === lock) {
      lock.rev = doc.rev;
      lock.hash = hash;
      lock.resolved = state === "conflict";
      lock.epoch = epoch;
      lock.base = doc.baseVersion;
      this.saving = [...this.saving, lock].slice(-LIVE_DOC.maxPendingCheckpoints);
      this.persist(doc);
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
      unpublishable: doc.rules.unpublishable(live),
    };
  }

  /**
   * Version `n` holds the checkpoint: it becomes the draft's base; edits made since are kept.
   * `resolved` (or a snapshot of a frozen draft): the checkpoint was "Publish your changes", so
   * the draft is the saved text now and every review closes (`reset` with why "published").
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
    resolved = false,
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
      this.finish(doc, n, text, mine, rev ?? mine?.rev, resolved || mine?.resolved === true);
      await this.refreeze(doc, n);
    } else if (!rec && (await this.unrecordedOwn(doc, n, text, rev))) {
      this.finish(doc, n, text, null, rev, resolved);
      await this.refreeze(doc, n);
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
   * Defence in depth for a finish whose snapshot the room has no record of, on lines of another
   * epoch: the room never stored anything (its first load since the record existed, or the record
   * was lost), so the new epoch is a reload's, not a discard's or a reset's (those write theirs).
   * It is still this checkpoint's when version `n` holds exactly the text it saved and the draft
   * is at or past the snapshot's rev: the draft goes on from `n` (a freeze against `n` ends as
   * `rebased`, with the lines and the edits since kept).
   *
   * A deploy window, at most once per room: `kept` is null only until the room first stores its
   * record (a snapshot, a new epoch), and code with the record always stores one before a save,
   * so only a save started under code without it can arrive here. It loses nothing: a finish it
   * refuses goes to `outside`, which keeps the draft and freezes it for review.
   */
  private async unrecordedOwn(
    doc: Loaded,
    n: number,
    text: string,
    rev: number | undefined,
  ): Promise<boolean> {
    if (this.kept || rev === undefined || rev > doc.rev) return false;
    const saved = await this.versionSource(doc, n);
    return (
      saved === text && !this.kept && this.loaded === doc && n > doc.baseVersion && rev <= doc.rev
    );
  }

  /**
   * The checkpoint's version `n` (holding `source`, snapshotted at rev `since`) becomes the
   * draft's base. The lines become its text only when nothing was edited since the snapshot (a
   * review's "Publish your changes", or a draft frozen meanwhile and not edited): edits made after
   * the snapshot are never replaced by it. A draft frozen against this version (its notify came
   * unrecognized) or an older one goes on from it with those edits; one frozen against a newer
   * version stays frozen for that version's review (refreeze names its files from n).
   */
  private finish(
    doc: Loaded,
    n: number,
    source: string,
    lock: CheckpointLock | null,
    since: number | undefined,
    resolved: boolean,
  ): void {
    const text = doc.rules.toLive(source);
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
    if (!later && (resolved || frozen !== null)) {
      // "Publish your changes" (or a draft frozen since, unedited): the saved text is the draft
      // now, and every open review closes.
      doc.lines = splitLines(text);
      doc.conflictVersion = newer;
      doc.conflictFiles = null;
      doc.rev += 1;
      this.newEpoch(doc);
      this.revokeLeases("closed");
      this.broadcast({
        t: "reset",
        version: n,
        gen: doc.gen,
        rev: doc.rev,
        ...(resolved && frozen !== null ? { why: "published" as const } : {}),
      });
      this.broadcastText(doc);
      if (newer !== null) this.broadcast({ t: "conflict", version: newer });
    } else if (frozen !== null && newer === null) {
      // Frozen by this save's own version: editing resumes on it, the edits since kept as they are.
      doc.conflictVersion = null;
      doc.conflictFiles = null;
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
    await this.restore();
    if (this.lock?.id === lockId) this.lock = null;
    const rec = this.saving.find((r) => r.id === lockId) ?? null;
    this.dropSaving(rec);
    // The last one gone: a draft kept at its base for it loses its row now (settle).
    if (rec && !this.saving.length && this.needsFlush) await this.flushNow();
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
   * Drop the unpublished edits: the draft goes back to the current version, text and files. It
   * runs under the checkpoint lock, so it never interleaves with a save or the review's other
   * choice: `busy` while another holder has the lock; otherwise it takes the lock before its first
   * read (a snapshot arriving meanwhile is busy) and releases it when done. Every snapshot still
   * being saved is dropped with the edits.
   * `conflictVersion` ("Discard your changes" in the review) limits it to a draft frozen against
   * exactly that version, which must still be the current one: "resolved" when the draft is no
   * longer frozen, "conflict" when a newer version froze it. `rev`, the frozen version, the draft's
   * base and its epoch are checked again after the reads, so a version notify or a late save that
   * changed the draft meanwhile stops it.
   */
  async discard(
    artifactId: string,
    rev: number,
    opts: { conflictVersion?: number } = {},
  ): Promise<DocDiscardResult> {
    const doc = await this.ensure(artifactId);
    if (!doc) return { ok: true, rev: 0 };
    if (this.lock && this.lock.until > Date.now()) return { ok: false, rev: doc.rev, busy: true };
    const why = (): DocDiscardResult | null => {
      if (this.loaded !== doc) return { ok: false, rev: doc.rev };
      const want = opts.conflictVersion;
      if (want !== undefined) {
        if (doc.conflictVersion === null) {
          return { ok: false, rev: doc.rev, reason: "resolved", version: doc.baseVersion };
        }
        if (doc.conflictVersion !== want) {
          return { ok: false, rev: doc.rev, reason: "conflict", version: doc.conflictVersion };
        }
      }
      return rev === doc.rev ? null : { ok: false, rev: doc.rev, reason: "moved" };
    };
    const before = why();
    if (before) return before;
    const lock: CheckpointLock = {
      id: `k_${randomString(12)}`,
      rev: doc.rev,
      hash: "",
      until: Date.now() + LIVE_DOC.checkpointLockS * 1000,
      resolved: false,
      epoch: "",
      base: doc.baseVersion,
    };
    this.lock = lock;
    const epoch = doc.epoch;
    const base = doc.baseVersion;
    let out: DocDiscardResult;
    try {
      const cur = await this.host.env.DB.prepare(
        "SELECT current_version FROM artifacts WHERE id = ?1",
      )
        .bind(artifactId)
        .first<{ current_version: number }>();
      const text = cur ? await this.versionText(doc, cur.current_version) : null;
      const html =
        cur !== null && text === null && (await this.htmlVersion(doc, cur.current_version));
      const after = why();
      if (after) return after;
      if (html && cur && this.lock === lock && doc.epoch === epoch && doc.baseVersion === base) {
        if (opts.conflictVersion !== undefined && cur.current_version !== opts.conflictVersion) {
          return { ok: false, rev: doc.rev, reason: "conflict", version: cur.current_version };
        }
        // An HTML deck is current: there is no Markdown to go back to, so the draft ends.
        this.saving = [];
        const rev = doc.rev + 1;
        this.broadcast({
          t: "reset",
          version: cur.current_version,
          gen: doc.gen,
          rev,
          why: "discarded",
        });
        await this.dropDraft(doc);
        return { ok: true, rev };
      }
      if (!cur || text === null || this.lock !== lock) return { ok: false, rev: doc.rev };
      if (doc.epoch !== epoch || doc.baseVersion !== base) {
        // A late save finished, or a version moved the draft, while this read: look again.
        return { ok: false, rev: doc.rev, reason: "moved" };
      }
      if (opts.conflictVersion !== undefined && cur.current_version !== opts.conflictVersion) {
        // A newer version is current; its notify has not frozen the draft against it yet.
        return { ok: false, rev: doc.rev, reason: "conflict", version: cur.current_version };
      }
      this.saving = [];
      this.replace(doc, cur.current_version, text, "discarded", "closed");
      doc.lastBy = null;
      await this.flushNow();
      out = { ok: true, rev: doc.rev };
    } finally {
      if (this.lock === lock) this.lock = null;
    }
    this.status(doc);
    await this.releaseIfIdle(doc);
    return out;
  }

  /**
   * The freshest draft, for a stale checkpoint's answer (its numbers) and tests. Worker RPC only:
   * no route returns draft text.
   */
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
