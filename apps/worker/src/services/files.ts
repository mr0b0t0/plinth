// Files people add to a page (docs/spec.md "Files people add to a page"): one implementation for
// the page API on the content host (content/files-api.ts), the read path (content/files.ts), REST,
// MCP and the hourly sweep. Every decision goes through policy.ts (pageFileAccess, canDeleteFile);
// the conditions are repeated in the SQL of each guarded write, so a delete, takedown or erase that
// lands between two requests of one upload can never bring a file back.
//
// Bytes live in R2 at artifacts/<artifact_id>/files/<id>, under the artifact's root, so deleting
// the artifact's root takes them. Rows are the only index. A row is `pending` while its parts
// arrive, `ready` once the last one landed, and `deleting` (a tombstone, counting toward no quota)
// from a delete, a cancel, an expiry, a takedown or an erase until the sweep has cleared its
// objects and removed it. Totals live in artifact_file_usage, kept by triggers
// (migrations/0014_artifact_files.sql).
import {
  type AgentFile,
  type ArtifactFilesList,
  type Capabilities,
  type EffectiveRole,
  FILE_LIMITS,
  FILE_TYPE_LIST,
  type FileLimitsInfo,
  type FilesSession,
  type FilesUnavailableReason,
  type FileType,
  isFileType,
  type PageFile,
  partCount,
  partLength,
  SNIFF_BYTES,
  sanitizeFileName,
  sniffFileType,
} from "@plinth/shared";
import { type Bindings, type Config, filesActive } from "../config.ts";
import { base64url, fromBase64url, newId, viewerIdFor } from "../lib/crypto.ts";
import { ApiError } from "../lib/errors.ts";
import { hit } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { canDeleteFile, type PageClaim, pageFileAccess } from "../policy.ts";

/** The artifact whose files are used, with its current version's declaration. */
export interface FilesTarget {
  id: string;
  ownerId: string;
  caps: Capabilities | null;
}

/** Who is uploading or deleting from the page, as the content pass says. */
export type FileWriter = PageClaim;

/** A row of artifact_files as D1 returns it. */
export interface StoredFile {
  id: string;
  artifact_id: string;
  r2_key: string;
  name: string;
  content_type: FileType;
  size_bytes: number;
  state: "pending" | "ready" | "deleting";
  parts: number;
  parts_done: number;
  part_etags: string | null;
  multipart_id: string | null;
  created_by_email: string | null;
  created_by_role: EffectiveRole | null;
  created_via: "page";
  created_at: string;
  completed_at: string | null;
  expires_at: number;
  claimed_at: number | null;
}

export type FileQuotaLimit = "files" | "bytes" | "uploader_bytes" | "user_bytes" | "pending";

const HOUR_S = 3600;

/** The R2 key of a file: under the artifact's root, never built from input. */
export function fileObjectKey(artifactId: string, fileId: string): string {
  return `artifacts/${artifactId}/files/${fileId}`;
}

/** The same-origin path a page loads a file from. */
export function fileUrl(fileId: string): string {
  return `/__plinth/files/${fileId}`;
}

// ---------- errors ----------

const invalid = (message: string, reason?: string) =>
  new ApiError("invalid_input", message, reason ? { reason } : undefined);
const quota = (limit: FileQuotaLimit) =>
  new ApiError("quota_exceeded", `This page's file store is full (${limit})`, { limit });
const fileNotFound = () => new ApiError("not_found", "File not found");
const denied = (reason: "read_only" | "forbidden") =>
  reason === "read_only"
    ? new ApiError("forbidden", "Only people this artifact is shared with can add files here", {
        reason: "read_only",
      })
    : new ApiError("forbidden", "You cannot delete this file");

// ---------- availability, usage and reads ----------

/**
 * Why files are unavailable for this artifact, or null when they are available. With
 * `assumeDeclared`, only the instance-wide reasons are checked (before the artifact is loaded).
 */
export function filesUnavailableReason(
  config: Pick<Config, "allowFiles" | "contentIsolation">,
  caps: Capabilities | null,
  opts: { assumeDeclared?: boolean } = {},
): FilesUnavailableReason | null {
  if (config.contentIsolation === "opaque") return "opaque_isolation";
  if (!config.allowFiles) return "disabled";
  if (opts.assumeDeclared !== true && caps?.files !== true) return "not_declared";
  return null;
}

export function fileLimitsOf(config: Config): FileLimitsInfo {
  return {
    max_file_bytes: config.files.maxFileBytes,
    max_files: config.files.maxFilesPerArtifact,
    max_bytes: config.files.maxBytesPerArtifact,
    max_bytes_per_uploader: config.files.maxBytesPerUploader,
    part_bytes: FILE_LIMITS.partBytes,
  };
}

/** One artifact's file totals (pending and ready rows) and change counter. */
export async function fileUsageOf(
  d1: D1Database,
  artifactId: string,
): Promise<{ files: number; bytes: number; seq: number }> {
  const row = await d1
    .prepare("SELECT files, bytes, seq FROM artifact_file_usage WHERE artifact_id = ?1")
    .bind(artifactId)
    .first<{ files: number; bytes: number; seq: number }>();
  return row ?? { files: 0, bytes: 0, seq: 0 };
}

/** Bytes of files across an owner's live artifacts (admin stats, quota checks). */
export async function ownerFileBytes(d1: D1Database, ownerId: string): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT coalesce(sum(u.bytes), 0) AS total FROM artifact_file_usage u
         JOIN artifacts a ON a.id = u.artifact_id WHERE a.owner_id = ?1 AND a.deleted_at IS NULL`,
    )
    .bind(ownerId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function uploaderBytes(d1: D1Database, artifactId: string, email: string): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT coalesce(sum(size_bytes), 0) AS total FROM artifact_files
        WHERE artifact_id = ?1 AND created_by_email = ?2 AND state != 'deleting'`,
    )
    .bind(artifactId, email)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** GET /__plinth/api/v1/files/session for a reader with a content pass. */
export async function filesSession(
  d1: D1Database,
  config: Config,
  target: FilesTarget,
  claim: PageClaim | null,
): Promise<FilesSession> {
  const reason = filesUnavailableReason(config, target.caps);
  if (reason) return { available: false, reason };
  const access = pageFileAccess(claim, target.caps, filesActive(config));
  const usage = await fileUsageOf(d1, target.id);
  return {
    available: true,
    can_upload: access.upload,
    accept: [...FILE_TYPE_LIST],
    limits: fileLimitsOf(config),
    usage: {
      files: usage.files,
      bytes: usage.bytes,
      mine_bytes: claim ? await uploaderBytes(d1, target.id, claim.email) : 0,
    },
    seq: usage.seq,
  };
}

/** The change counter the runtime polls: one row. */
export async function fileChanges(d1: D1Database, artifactId: string): Promise<{ seq: number }> {
  return { seq: (await fileUsageOf(d1, artifactId)).seq };
}

function encodeCursor(createdAt: string, id: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify([createdAt, id])));
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64url(cursor)),
    );
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      typeof v[1] === "string"
    ) {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw invalid("Bad cursor");
}

/**
 * One page of an artifact's ready files (and, with `withPending`, unfinished uploads), oldest
 * first, by keyset on (created_at, id). `mineEmail` keeps only that person's uploads.
 */
export async function listFiles(
  d1: D1Database,
  artifactId: string,
  opts: { limit?: number; cursor?: string | null; mineEmail?: string; withPending?: boolean },
): Promise<{ rows: StoredFile[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), FILE_LIMITS.maxListLimit);
  const [afterAt, afterId] = opts.cursor ? decodeCursor(opts.cursor) : ["", ""];
  const states = opts.withPending ? "('pending','ready')" : "('ready')";
  const { results } = await d1
    .prepare(
      `SELECT * FROM artifact_files
        WHERE artifact_id = ?1 AND state IN ${states}
          AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
          AND (?4 IS NULL OR created_by_email = ?4)
        ORDER BY created_at, id LIMIT ?5`,
    )
    .bind(artifactId, afterAt, afterId, opts.mineEmail ?? null, limit + 1)
    .all<StoredFile>();
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return {
    rows,
    next_cursor: results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

/** A ready file of this artifact, or null. */
export async function getReadyFile(
  d1: D1Database,
  artifactId: string,
  id: string,
): Promise<StoredFile | null> {
  return (
    (await d1
      .prepare(
        "SELECT * FROM artifact_files WHERE id = ?1 AND artifact_id = ?2 AND state = 'ready'",
      )
      .bind(id, artifactId)
      .first<StoredFile>()) ?? null
  );
}

async function getRow(d1: D1Database, artifactId: string, id: string): Promise<StoredFile | null> {
  return (
    (await d1
      .prepare("SELECT * FROM artifact_files WHERE id = ?1 AND artifact_id = ?2")
      .bind(id, artifactId)
      .first<StoredFile>()) ?? null
  );
}

/** A ready file as a page sees it: who uploaded it only with `viewer` and an identified reader. */
export function toPageFile(
  row: StoredFile,
  claim: PageClaim | null,
  seeIdentity: boolean,
): PageFile {
  return {
    id: row.id,
    name: row.name,
    type: row.content_type,
    size: row.size_bytes,
    url: fileUrl(row.id),
    mine: claim !== null && row.created_by_email === claim.email,
    created_at: row.created_at,
    ...(seeIdentity
      ? { uploaded_by: { email: row.created_by_email, role: row.created_by_role, via: "page" } }
      : {}),
  };
}

/** A file as owners' and editors' agents and the app see it. */
export async function toAgentFile(
  secret: string,
  row: StoredFile,
  cache: Map<string, string>,
): Promise<AgentFile> {
  let viewerId: string | null = null;
  const email = row.created_by_email;
  if (email) {
    viewerId = cache.get(email) ?? (await viewerIdFor(secret, row.artifact_id, email));
    cache.set(email, viewerId);
  }
  return {
    id: row.id,
    name: row.name,
    type: row.content_type,
    size: row.size_bytes,
    state: row.state === "ready" ? "ready" : "pending",
    created_at: row.created_at,
    uploaded_by: { email, role: row.created_by_role, viewer_id: viewerId },
  };
}

/** What list_artifact_files returns, without the untrusted note. */
export async function agentFileList(
  d1: D1Database,
  config: Config,
  target: FilesTarget,
  opts: { limit?: number; cursor?: string | null },
): Promise<Omit<ArtifactFilesList, "untrusted">> {
  const page = await listFiles(d1, target.id, { ...opts, withPending: true });
  const usage = await fileUsageOf(d1, target.id);
  const cache = new Map<string, string>();
  const files: AgentFile[] = [];
  for (const row of page.rows) files.push(await toAgentFile(config.tokenSigningKey, row, cache));
  return {
    available: filesUnavailableReason(config, target.caps) === null,
    files,
    next_cursor: page.next_cursor,
    usage: { files: usage.files, bytes: usage.bytes },
    limits: fileLimitsOf(config),
  };
}

// ---------- uploads ----------

/** Checked inside every guarded write: the artifact still exists and is not taken down. */
const ARTIFACT_LIVE_SQL = `EXISTS (SELECT 1 FROM artifacts WHERE id = ?2
  AND deleted_at IS NULL AND taken_down_at IS NULL)`;

function requireUploader(writer: FileWriter | null): FileWriter {
  if (writer) return writer;
  throw denied("read_only");
}

async function limitUploads(d1: D1Database, config: Config, artifactId: string, email: string) {
  for (const [key, limit] of [
    [`files:u:${artifactId}:${email}`, config.files.uploadsPerUploaderPerHour],
    [`files:u:${artifactId}:all`, config.files.uploadsPerArtifactPerHour],
  ] as const) {
    const r = await hit(d1, key, limit, HOUR_S);
    if (!r.allowed) {
      throw new ApiError("rate_limited", "Too many uploads, try again later", {
        retry_after: r.retryAfter,
      });
    }
  }
}

/** Which quota stopped a guarded insert. */
async function whyNotCreated(
  d1: D1Database,
  config: Config,
  target: FilesTarget,
  writer: FileWriter,
  size: number,
): Promise<FileQuotaLimit | "gone"> {
  const r = await d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM artifacts WHERE id = ?1
                       AND deleted_at IS NULL AND taken_down_at IS NULL) AS live,
              coalesce((SELECT files FROM artifact_file_usage WHERE artifact_id = ?1), 0) AS files,
              coalesce((SELECT bytes FROM artifact_file_usage WHERE artifact_id = ?1), 0) AS bytes,
              (SELECT count(*) FROM artifact_files WHERE artifact_id = ?1 AND created_by_email = ?2
                 AND state = 'pending') AS pending`,
    )
    .bind(target.id, writer.email)
    .first<{ live: number; files: number; bytes: number; pending: number }>();
  if (!r?.live) return "gone";
  if (r.files >= config.files.maxFilesPerArtifact) return "files";
  if (r.bytes + size > config.files.maxBytesPerArtifact) return "bytes";
  if (r.pending >= FILE_LIMITS.maxPendingPerUploader) return "pending";
  if (
    writer.role !== "owner" &&
    (await uploaderBytes(d1, target.id, writer.email)) + size > config.files.maxBytesPerUploader
  ) {
    return "uploader_bytes";
  }
  return "user_bytes";
}

export interface CreatedUpload {
  file: PageFile & { state: "pending" };
  parts: number;
  part_bytes: number;
}

/**
 * Start an upload (POST /__plinth/api/v1/files): validate, rate-limit, then reserve its bytes with
 * a guarded insert that checks every quota in the same statement. The stored type is the declared
 * one; the first part must prove it.
 */
export async function createUpload(
  env: Pick<Bindings, "DB" | "FILES">,
  config: Config,
  target: FilesTarget,
  writer: FileWriter | null,
  input: { name: string; type: string; size: number },
  now = Date.now(),
): Promise<{ row: StoredFile; created: CreatedUpload }> {
  const w = requireUploader(writer);
  if (!isFileType(input.type)) {
    throw invalid(
      "Files of this type cannot be added here: images (PNG, JPEG, GIF, WebP, AVIF), PDF, video (MP4, WebM) and audio (MP3, M4A, Ogg, WAV) only",
      "unsupported_type",
    );
  }
  const type = input.type;
  if (input.size > config.files.maxFileBytes) {
    throw new ApiError(
      "payload_too_large",
      `A file may be at most ${config.files.maxFileBytes} bytes`,
      {
        max_file_bytes: config.files.maxFileBytes,
      },
    );
  }
  await limitUploads(env.DB, config, target.id, w.email);
  const id = newId();
  const key = fileObjectKey(target.id, id);
  const parts = partCount(input.size);
  const row = await env.DB.prepare(
    `INSERT INTO artifact_files (id, artifact_id, r2_key, name, content_type, size_bytes, state,
       parts, created_by_email, created_by_role, created_via, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, 'page', ?10, ?11
      WHERE ${ARTIFACT_LIVE_SQL}
        AND coalesce((SELECT files FROM artifact_file_usage WHERE artifact_id = ?2), 0) < ?12
        AND coalesce((SELECT bytes FROM artifact_file_usage WHERE artifact_id = ?2), 0) + ?6 <= ?13
        AND (SELECT coalesce(sum(u.bytes), 0) FROM artifact_file_usage u
               JOIN artifacts a ON a.id = u.artifact_id
              WHERE a.owner_id = ?14 AND a.deleted_at IS NULL) + ?6 <= ?15
        AND (?9 = 'owner' OR (SELECT coalesce(sum(size_bytes), 0) FROM artifact_files
              WHERE artifact_id = ?2 AND created_by_email = ?8 AND state != 'deleting') + ?6 <= ?16)
        AND (SELECT count(*) FROM artifact_files WHERE artifact_id = ?2 AND created_by_email = ?8
              AND state = 'pending') < ?17
     RETURNING *`,
  )
    .bind(
      id,
      target.id,
      key,
      sanitizeFileName(input.name, type),
      type,
      input.size,
      parts,
      w.email,
      w.role,
      nowIso(),
      now + FILE_LIMITS.uploadMs,
      config.files.maxFilesPerArtifact,
      config.files.maxBytesPerArtifact,
      target.ownerId,
      config.files.maxBytesPerUser,
      config.files.maxBytesPerUploader,
      FILE_LIMITS.maxPendingPerUploader,
    )
    .first<StoredFile>();
  if (!row) {
    const why = await whyNotCreated(env.DB, config, target, w, input.size);
    if (why === "gone") throw new ApiError("not_found", "Not found");
    throw quota(why);
  }
  let stored = row;
  if (parts > 1) {
    const mp = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    const updated = await env.DB.prepare(
      `UPDATE artifact_files SET multipart_id = ?3
        WHERE id = ?1 AND artifact_id = ?2 AND state = 'pending' RETURNING *`,
    )
      .bind(id, target.id, mp.uploadId)
      .first<StoredFile>();
    if (!updated) {
      await mp.abort().catch(() => undefined);
      throw fileNotFound();
    }
    stored = updated;
  }
  const file = { ...toPageFile(stored, w, false), state: "pending" as const };
  return { row: stored, created: { file, parts, part_bytes: FILE_LIMITS.partBytes } };
}

export type PartResult =
  | { parts_done: number; parts: number }
  | { parts_done: number; parts: number; file: PageFile };

/** Mark a pending row a tombstone; the trigger frees its quota. */
async function tombstone(d1: D1Database, artifactId: string, id: string) {
  await d1
    .prepare(
      `UPDATE artifact_files SET state = 'deleting', claimed_at = NULL
        WHERE id = ?1 AND artifact_id = ?2 AND state = 'pending'`,
    )
    .bind(id, artifactId)
    .run();
}

/**
 * Receive part `n` of an upload (PUT /__plinth/api/v1/files/<id>/parts/<n>): parts arrive in
 * order, and the last accepted one may be sent again (its answer was lost). The first part must
 * start with the signature of the declared type, or the upload is cancelled. The last part
 * completes the upload and makes the file ready.
 */
export async function putPart(
  env: Pick<Bindings, "DB" | "FILES">,
  target: FilesTarget,
  writer: FileWriter | null,
  id: string,
  n: number,
  bytes: Uint8Array,
  seeIdentity: boolean,
  now = Date.now(),
): Promise<PartResult> {
  const w = requireUploader(writer);
  const row = await getRow(env.DB, target.id, id);
  // Another person's upload is indistinguishable from none.
  if (!row || row.created_by_email !== w.email) throw fileNotFound();
  if (row.state === "ready" && n === row.parts) {
    // The final part sent again after its answer was lost: the same answer.
    return { parts_done: row.parts, parts: row.parts, file: toPageFile(row, w, seeIdentity) };
  }
  if (row.state !== "pending" || row.expires_at <= now) throw fileNotFound();
  if (!Number.isInteger(n) || n < 1 || n > row.parts) {
    throw new ApiError("invalid_input", `Part: 1 to ${row.parts}`);
  }
  if (n !== row.parts_done && n !== row.parts_done + 1) {
    throw new ApiError("conflict", "Parts must arrive in order", { parts_done: row.parts_done });
  }
  if (bytes.byteLength !== partLength(row.size_bytes, n)) {
    throw invalid(`Part ${n} must be ${partLength(row.size_bytes, n)} bytes`);
  }
  if (n === 1 && sniffFileType(bytes.subarray(0, SNIFF_BYTES)) !== row.content_type) {
    await tombstone(env.DB, target.id, id);
    throw invalid("The file's contents do not match its type", "type_mismatch");
  }
  let etag: string | null = null;
  if (row.parts === 1) {
    await env.FILES.put(row.r2_key, bytes, { httpMetadata: { contentType: row.content_type } });
  } else {
    if (!row.multipart_id) throw fileNotFound();
    const mp = env.FILES.resumeMultipartUpload(row.r2_key, row.multipart_id);
    etag = (await mp.uploadPart(n, bytes)).etag;
  }
  const recorded = await env.DB.prepare(
    `UPDATE artifact_files
        SET parts_done = ?3,
            part_etags = CASE WHEN ?4 IS NULL THEN part_etags
              ELSE json_set(coalesce(part_etags, '[]'), '$[' || CAST(?3 - 1 AS INTEGER) || ']', ?4) END
      WHERE id = ?1 AND artifact_id = ?2 AND state = 'pending' AND expires_at > ?5
        AND parts_done IN (?3 - 1, ?3) AND ${ARTIFACT_LIVE_SQL}
      RETURNING parts_done, part_etags`,
  )
    .bind(id, target.id, n, etag, now)
    .first<{ parts_done: number; part_etags: string | null }>();
  // Deleted, taken down or expired meanwhile: the sweep owns whatever was written.
  if (!recorded) throw fileNotFound();
  if (n < row.parts) return { parts_done: recorded.parts_done, parts: row.parts };

  if (row.parts > 1 && row.multipart_id) {
    const etags = JSON.parse(recorded.part_etags ?? "[]") as string[];
    const mp = env.FILES.resumeMultipartUpload(row.r2_key, row.multipart_id);
    await mp.complete(etags.map((e, i) => ({ partNumber: i + 1, etag: e })));
  }
  const ready = await env.DB.prepare(
    `UPDATE artifact_files
        SET state = 'ready', parts_done = parts, part_etags = NULL, multipart_id = NULL,
            completed_at = ?3
      WHERE id = ?1 AND artifact_id = ?2 AND state = 'pending' AND ${ARTIFACT_LIVE_SQL}
      RETURNING *`,
  )
    .bind(id, target.id, nowIso())
    .first<StoredFile>();
  if (!ready) {
    // A retry of this same part may have finished it first.
    const again = await getRow(env.DB, target.id, id);
    if (again?.state === "ready") {
      return {
        parts_done: again.parts,
        parts: again.parts,
        file: toPageFile(again, w, seeIdentity),
      };
    }
    // Deleted or taken down while the last part was written: drop the object (the sweep repeats).
    await env.FILES.delete(row.r2_key).catch(() => undefined);
    throw fileNotFound();
  }
  return { parts_done: ready.parts, parts: ready.parts, file: toPageFile(ready, w, seeIdentity) };
}

// ---------- deletes ----------

/**
 * Delete a ready file, or cancel a pending upload (DELETE /__plinth/api/v1/files/<id>). Pending:
 * only its uploader; another person's pending upload reads as none. Ready: its uploader, the owner
 * and editors. The object of a ready file goes at once (best effort; the sweep repeats it); a
 * cancelled upload is left to the sweep's grace window, since a part may still be writing.
 */
export async function deleteFile(
  env: Pick<Bindings, "DB" | "FILES">,
  target: FilesTarget,
  writer: FileWriter | null,
  id: string,
  defer: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<void> {
  if (!writer) throw denied("read_only");
  const row = await getRow(env.DB, target.id, id);
  if (!row || row.state === "deleting") throw fileNotFound();
  if (row.state === "pending" && row.created_by_email !== writer.email) throw fileNotFound();
  const d = canDeleteFile(writer, { state: row.state, creatorEmail: row.created_by_email });
  if (!d.allow) throw denied(d.reason);
  const moderator = writer.role === "owner" || writer.role === "editor";
  const claimed = await env.DB.prepare(
    `UPDATE artifact_files SET state = 'deleting', claimed_at = ?3
      WHERE id = ?1 AND artifact_id = ?2 AND state != 'deleting'
        AND (created_by_email = ?4 OR (state = 'ready' AND ?5 = 1))
      RETURNING r2_key, multipart_id, completed_at`,
  )
    .bind(id, target.id, now, writer.email, moderator ? 1 : 0)
    .first<{ r2_key: string; multipart_id: string | null; completed_at: string | null }>();
  if (!claimed) throw fileNotFound();
  if (claimed.completed_at !== null) defer(clearObject(env, id, claimed.r2_key, null));
}

/**
 * Delete a ready file as its artifact's owner or editor from the app or an agent (REST, MCP). The
 * caller's right (policy action data_write) was decided before; pending uploads are not listed
 * as deletable here and read as not found.
 */
export async function deleteFileAsModerator(
  env: Pick<Bindings, "DB" | "FILES">,
  artifactId: string,
  id: string,
  defer: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<void> {
  const claimed = await env.DB.prepare(
    `UPDATE artifact_files SET state = 'deleting', claimed_at = ?3
      WHERE id = ?1 AND artifact_id = ?2 AND state = 'ready' RETURNING r2_key`,
  )
    .bind(id, artifactId, now)
    .first<{ r2_key: string }>();
  if (!claimed) throw fileNotFound();
  defer(clearObject(env, id, claimed.r2_key, null));
}

/**
 * Delete every file of an artifact (the owner's "Delete all uploaded files"): every row becomes a
 * tombstone in one statement; ready objects go at once, pending ones after the grace window.
 */
export async function clearFiles(
  env: Pick<Bindings, "DB" | "FILES">,
  artifactId: string,
  defer: (p: Promise<unknown>) => void,
  now = Date.now(),
): Promise<{ files: number }> {
  const { results } = await env.DB.prepare(
    `UPDATE artifact_files SET state = 'deleting', claimed_at = ?2
      WHERE artifact_id = ?1 AND state != 'deleting'
      RETURNING id, r2_key, multipart_id, completed_at`,
  )
    .bind(artifactId, now)
    .all<TombstonedFile>();
  const ready = results.filter((r) => r.completed_at !== null);
  defer(Promise.all(ready.map((r) => clearObject(env, r.id, r.r2_key, null))));
  return { files: results.length };
}

// ---------- tombstones and the sweep ----------

/** A row a delete, takedown, cancel or expiry turned into a tombstone. */
export interface TombstonedFile {
  id: string;
  r2_key: string;
  multipart_id: string | null;
  completed_at: string | null;
}

/**
 * The statements that take an artifact's files with its deletion or takedown, for its batch
 * (services/cleanup.ts): every row a tombstone (the trigger frees the usage), then the usage row.
 * The first statement returns the rows, so a takedown can clear the ready objects right after.
 */
export function tombstoneArtifactFiles(d1: D1Database, artifactId: string): D1PreparedStatement[] {
  return [
    d1
      .prepare(
        `UPDATE artifact_files SET state = 'deleting', claimed_at = NULL
          WHERE artifact_id = ?1 AND state != 'deleting'
          RETURNING id, r2_key, multipart_id, completed_at`,
      )
      .bind(artifactId),
    d1.prepare("DELETE FROM artifact_file_usage WHERE artifact_id = ?1").bind(artifactId),
  ];
}

/**
 * After a takedown's batch: delete the ready objects at once and their rows. Pending ones are left
 * to the sweep's grace window, since a part may still be writing. Best effort: a failure leaves the
 * row for the sweep.
 */
export async function clearTombstonedFiles(
  env: Pick<Bindings, "DB" | "FILES">,
  rows: readonly TombstonedFile[] | undefined,
): Promise<void> {
  for (const r of rows ?? []) {
    if (r.completed_at === null) continue;
    await clearObject(env, r.id, r.r2_key, null);
  }
}

/** Delete one tombstone's object (and abort its multipart upload), then its row. */
async function clearObject(
  env: Pick<Bindings, "DB" | "FILES">,
  id: string,
  key: string,
  multipartId: string | null,
): Promise<void> {
  try {
    await env.FILES.delete(key);
    if (multipartId) {
      await env.FILES.resumeMultipartUpload(key, multipartId)
        .abort()
        .catch(() => undefined);
    }
    await env.DB.prepare("DELETE FROM artifact_files WHERE id = ?1 AND state = 'deleting'")
      .bind(id)
      .run();
  } catch (e) {
    // The row stays a tombstone; the next sweep retries.
    console.error("file cleanup failed:", e instanceof Error ? e.message : "unknown");
  }
}

/**
 * The hourly sweep (index.ts scheduled), also started now and then by uploads on instances
 * without a cron. It expires uploads past their deadline, then claims tombstones whose objects may
 * go: one that was ready (nothing writes to it any more), or one past its deadline plus the grace
 * window, unclaimed or claimed by a sweep that did not finish. The claim is one statement, so two
 * sweeps never take the same row. Each claimed row's object is deleted, its multipart upload
 * aborted, and the row removed.
 */
export async function sweepArtifactFiles(
  env: Pick<Bindings, "DB" | "FILES">,
  nowMs: number,
  opts: { limit?: number } = {},
): Promise<{ expired: number; cleared: number }> {
  const limit = opts.limit ?? 50;
  const expired = await env.DB.prepare(
    `UPDATE artifact_files SET state = 'deleting', claimed_at = NULL
      WHERE id IN (SELECT id FROM artifact_files WHERE state = 'pending' AND expires_at < ?1
                    LIMIT ?2)
      RETURNING id`,
  )
    .bind(nowMs, limit)
    .all<{ id: string }>();
  const { results } = await env.DB.prepare(
    `UPDATE artifact_files SET claimed_at = ?1
      WHERE id IN (SELECT id FROM artifact_files
                    WHERE state = 'deleting'
                      AND (completed_at IS NOT NULL OR expires_at + ?2 < ?1)
                      AND (claimed_at IS NULL OR claimed_at < ?1 - ?3)
                    LIMIT ?4)
      RETURNING id, r2_key, multipart_id`,
  )
    .bind(nowMs, FILE_LIMITS.tombstoneGraceMs, FILE_LIMITS.reclaimMs, limit)
    .all<{ id: string; r2_key: string; multipart_id: string | null }>();
  for (const r of results) await clearObject(env, r.id, r.r2_key, r.multipart_id);
  return { expired: expired.results.length, cleared: results.length };
}

let lastOpportunisticSweep = 0;

/**
 * Start a small sweep from an upload, at most once a minute per isolate, so instances with no cron
 * (wrangler dev: local, tunnel, Docker) clear tombstones too.
 */
export function maybeSweepFiles(
  env: Pick<Bindings, "DB" | "FILES">,
  defer: (p: Promise<unknown>) => void,
  now = Date.now(),
): boolean {
  if (now - lastOpportunisticSweep < 60_000) return false;
  lastOpportunisticSweep = now;
  defer(sweepArtifactFiles(env, now, { limit: 20 }).catch(() => undefined));
  return true;
}

/** For tests: forget when the last opportunistic sweep ran. */
export function resetOpportunisticSweep(): void {
  lastOpportunisticSweep = 0;
}
