// Staging and committing one version (docs/spec.md, reuse by hash and commit-last). The inline
// publish, update and restore paths and the bundle upload path all write a version through these:
// objects go to R2 first under a unique per-attempt prefix `artifacts/<id>/v<n>.<nonce>/`, then
// one guarded D1 batch inserts the version row (and, for a publish, the artifact row), advances
// current_version and consumes the upload ticket, or does none of it. A killed invocation can only
// leave unreferenced objects under its own attempt prefix (plinth-admin sweep-orphans removes them).
import {
  type ArtifactType,
  type ArtifactTypeDef,
  ASSET_PATH_RE,
  LIMITS,
  type PublishResult,
  type PublishWarning,
  parseCapabilities,
  type Visibility,
} from "@plinth/shared";
import { appUrl, contentOrigin } from "../config.ts";
import { contentSources } from "../content/csp.ts";
import type { ArtifactRow, VersionRow } from "../db/schema.ts";
import { newArtifactId, newId, randomString } from "../lib/crypto.ts";
import { ApiError, isUniqueViolation, notFound, unauthorized } from "../lib/errors.ts";
import { enforce } from "../lib/ratelimit.ts";
import { nowIso } from "../lib/time.ts";
import { getVersionRow, requireArtifact } from "./artifacts.ts";
import { checkAsset, requireTypeDef, resolveSource } from "./artifactTypes.ts";
import type { Ctx } from "./context.ts";
import { scanPublish } from "./publishCheck.ts";
import {
  assetContentType,
  attemptPrefix,
  deletePrefix,
  type FileEntry,
  type ManifestEntry,
  parseManifest,
  relativePrefix,
  sha256Hex,
  sourceTooLarge,
  tooManyAssets,
  validStoredAt,
  versionTooLarge,
} from "./storage.ts";
import { artifactLimitFor, getUserById } from "./users.ts";

/** What a staged version will become. */
export type VersionTarget =
  /** A new artifact: `artifactId` is fresh and has no row yet (commitStaged inserts it). */
  | { mode: "publish"; artifactId: string; type: ArtifactType; title?: string }
  | { mode: "update"; artifact: ArtifactRow; baseVersion?: number; note?: string };

/** A version's files after staging: every object it needs is in R2, nothing is committed. */
export interface StagedVersion {
  /** `artifacts/<id>/v<n>.<nonce>/` */
  prefix: string;
  entries: ManifestEntry[];
  /** What a viewer loads: every file, reused ones included. */
  logicalBytes: number;
  /** Bytes put to R2 by this attempt. */
  writtenBytes: number;
  written: number;
  reused: number;
}

export interface Stager {
  /** `artifacts/<id>/v<n>.<nonce>/` */
  readonly prefix: string;
  /** Validate, hash, then reuse or put one file; awaits back-pressure from the in-flight budget. */
  add(path: string, bytes: Uint8Array): Promise<void>;
  /** An inline `{path, sha256}`: reuse that file from the current version. */
  addRef(path: string, sha256: string): void;
  /**
   * Settle every put, apply the prefix strip, write the source under its own prefix, and check
   * the count, size, references and paths.
   */
  finish(opts?: { stripPrefix?: string }): Promise<StagedVersion>;
  /** Settle every put, then delete this attempt's prefix. */
  abort(): Promise<void>;
}

// ---------- actors and targets ----------

function requireActor(ctx: Ctx): { userId: string; connectionId: string | null } {
  const p = ctx.principal;
  if (p.kind === "user") return { userId: p.userId, connectionId: null };
  if (p.kind === "agent") return { userId: p.userId, connectionId: p.connectionId };
  throw unauthorized();
}

function artifactLimitError(limit: number): ApiError {
  return new ApiError(
    "quota_exceeded",
    `Artifact limit reached (${limit}). Delete one or ask for a higher limit.`,
    { limit, next: "Delete an artifact you no longer need, or update an existing one" },
  );
}

async function liveArtifactCount(ctx: Ctx, ownerId: string): Promise<number> {
  const r = await ctx.env.DB.prepare(
    "SELECT count(*) AS n FROM artifacts WHERE owner_id = ?1 AND deleted_at IS NULL",
  )
    .bind(ownerId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** The publish scope check and the artifact-count pre-check, then a target with a fresh id. */
export async function newArtifactTarget(
  ctx: Ctx,
  input: { type: ArtifactType; title?: string },
): Promise<VersionTarget> {
  const actor = requireActor(ctx);
  if (ctx.principal.kind === "agent" && !ctx.principal.scopes.has("artifacts:write")) {
    throw new ApiError("forbidden", "This token lacks the artifacts:write scope");
  }
  const user = await getUserById(ctx.db, actor.userId);
  if (!user) throw unauthorized();
  requireTypeDef(input.type);
  const limit = artifactLimitFor(ctx.config, user);
  if ((await liveArtifactCount(ctx, user.id)) >= limit) throw artifactLimitError(limit);
  const title = input.title?.trim();
  return {
    mode: "publish",
    artifactId: newArtifactId(),
    type: input.type,
    ...(title ? { title } : {}),
  };
}

export function conflictError(stated: number, current: number): ApiError {
  return new ApiError("conflict", `Version ${stated} is not current; current is ${current}`, {
    current_version: current,
    next: `v${current} is current; check what changed (get_artifact), then send your change again with base_version ${current}`,
  });
}

/** requireArtifact(edit) plus an early base check (a stale base is a conflict, before any rate hit). */
export async function updateTarget(
  ctx: Ctx,
  ref: string,
  input: { baseVersion?: number; note?: string },
): Promise<VersionTarget> {
  const { artifact } = await requireArtifact(ctx, ref, "edit");
  requireTypeDef(artifact.type);
  if (input.baseVersion !== undefined && input.baseVersion !== artifact.currentVersion) {
    throw conflictError(input.baseVersion, artifact.currentVersion);
  }
  const note = input.note?.trim();
  return {
    mode: "update",
    artifact,
    ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    ...(note ? { note } : {}),
  };
}

/** The per-user publish rate (MAX_PUBLISHES_PER_HOUR). */
export async function enforcePublishRate(ctx: Ctx): Promise<void> {
  const { userId } = requireActor(ctx);
  await enforce(
    ctx.env.DB,
    `publish:${userId}`,
    ctx.config.maxPublishesPerHour,
    3600,
    `Publish limit reached (${ctx.config.maxPublishesPerHour} per hour)`,
  );
}

// ---------- the stager ----------

interface Entry extends ManifestEntry {
  /** The path the file arrived under (before a prefix strip). */
  rawPath: string;
  /** Written by this attempt under prefix + rawPath (or pending: a source candidate). */
  own: boolean;
  /** Bytes kept until finish: source candidates only. */
  pending?: Uint8Array;
}

interface Reusable {
  stored_at: string;
  size_bytes: number;
  content_type: string;
}

/** What finish learned that commitStaged needs, kept beside the pinned StagedVersion shape. */
interface StagedExtra {
  stager: VersionStager;
  capabilities: string | null;
  title: string;
  warnings: PublishWarning[];
}

const stagedExtras = new WeakMap<StagedVersion, StagedExtra>();

/** At most this many R2 puts run at once (Workers allow six open connections per request). */
const MAX_PARALLEL_PUTS = 6;
const MAX_PATH_ERRORS = 20;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SCAN_TYPES = /^(text\/html|text\/css|text\/javascript|application\/javascript)/;

function pathProblem(path: string): string | null {
  if (path.length > LIMITS.maxAssetPathLength)
    return `longer than ${LIMITS.maxAssetPathLength} characters`;
  if (path.startsWith("__plinth/")) return "__plinth/ is reserved for Plinth";
  if (!ASSET_PATH_RE.test(path)) {
    if (/[^A-Za-z0-9._\-/]/.test(path))
      return "only letters, digits, '.', '_', '-' and '/' are allowed; rename the file";
    return "not a plain relative path (no leading '/', empty segment, '.' or '..', or trailing '/')";
  }
  return null;
}

function pathError(paths: { path: string; reason: string }[]): ApiError {
  return new ApiError(
    "invalid_input",
    `${paths.length === 1 ? "1 path" : `${paths.length} paths`} cannot be published: ${paths
      .slice(0, 3)
      .map((p) => `${p.path} (${p.reason})`)
      .join("; ")}`,
    {
      paths: paths.slice(0, MAX_PATH_ERRORS),
      next: "Rename these files to plain relative paths (letters, digits, . _ - /), or leave them out",
    },
  );
}

function noEntryFile(def: ArtifactTypeDef): ApiError {
  return new ApiError("invalid_input", `No ${def.sourcePath} at the top of the upload`, {
    reason: "no_entry_file",
    next: `Run tar from inside the build folder (the one with ${def.sourcePath} at its top)`,
  });
}

/** The title a page or doc names for itself: <title> of HTML, the first "# " line of Markdown. */
export function titleFromSource(def: ArtifactTypeDef, text: string): string | null {
  if (def.sourceField === "html") {
    const lower = text.slice(0, 64 * 1024).toLowerCase();
    const open = lower.indexOf("<title");
    if (open < 0) return null;
    const start = lower.indexOf(">", open);
    const end = lower.indexOf("</title", start + 1);
    if (start < 0 || end < 0) return null;
    const t = text
      .slice(start + 1, end)
      .replace(/\s+/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    return t ? t.slice(0, LIMITS.maxTitleLength) : null;
  }
  for (const line of text.split("\n", 200)) {
    if (line.startsWith("# ")) {
      const t = line.slice(2).trim();
      if (t) return t.slice(0, LIMITS.maxTitleLength);
    }
  }
  return null;
}

/**
 * One attempt at writing a version. Every file is validated, hashed, then either referenced
 * (bytes the current version already has, or that this attempt already put) or put to R2 under
 * the attempt prefix. Only source candidates and text kept for publish warnings stay in memory.
 */
export class VersionStager implements Stager {
  readonly prefix: string;
  readonly artifactId: string;
  readonly def: ArtifactTypeDef;
  private readonly rel: string;
  private readonly entries = new Map<string, Entry>();
  private readonly reusable = new Map<string, Reusable>();
  private readonly missing: string[] = [];
  private readonly badPaths: { path: string; reason: string }[] = [];
  private readonly scanText = new Map<string, Uint8Array>();
  private scanBytes = 0;
  private readonly unscanned: string[] = [];
  private readonly running = new Set<Promise<void>>();
  private inflightBytes = 0;
  private failure: unknown = null;
  private logicalBytes = 0;
  private writtenBytes = 0;
  private written = 0;
  private reused = 0;
  private aborted = false;
  /** Restore copies the old row's capabilities instead of parsing the source. */
  capabilitiesOverride: string | null | undefined;
  /** Restore returns no warnings. */
  scan = true;

  constructor(
    private readonly ctx: Ctx,
    readonly target: VersionTarget,
    readonly current: VersionRow | null,
  ) {
    this.artifactId = target.mode === "publish" ? target.artifactId : target.artifact.id;
    this.def = requireTypeDef(target.mode === "publish" ? target.type : target.artifact.type);
    const expected = target.mode === "publish" ? 1 : target.artifact.currentVersion + 1;
    this.prefix = attemptPrefix(this.artifactId, expected);
    this.rel = relativePrefix(this.artifactId, this.prefix);
    if (current) {
      for (const e of parseManifest(current.manifest)) {
        if (this.def.reservedPaths.includes(e.path) || !e.sha256 || unservableLegacy(e)) continue;
        const storedAt = e.stored_at ?? this.originOf(current, e.path);
        if (!this.reusable.has(e.sha256)) {
          this.reusable.set(e.sha256, {
            stored_at: storedAt,
            size_bytes: e.size_bytes,
            content_type: e.content_type,
          });
        }
      }
    }
  }

  /** `stored_at` for a file stored under version `v`'s own prefix. */
  private originOf(v: Pick<VersionRow, "number" | "r2Prefix">, path: string): string {
    const storedAt = relativePrefix(this.artifactId, v.r2Prefix) + path;
    if (!validStoredAt(storedAt, v.number)) {
      throw new ApiError("internal", `Stored file ${path} has an unexpected location`);
    }
    return storedAt;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
    if (this.aborted) throw new ApiError("internal", "This upload was abandoned");
  }

  /**
   * The top directory every file so far sits in, while a prefix strip is still possible: null
   * before the first file, false once a file sits at the root or in another directory.
   */
  private topDir: string | null | false = null;

  /** Track whether a prefix strip is still possible; flush held candidates when it is not. */
  private async noteTopDir(path: string): Promise<void> {
    if (this.topDir === false) return;
    const slash = path.indexOf("/");
    const dir = slash > 0 ? path.slice(0, slash + 1) : "";
    if (this.topDir === null && dir !== "") {
      this.topDir = dir;
      return;
    }
    if (dir !== "" && dir === this.topDir) return;
    this.topDir = false;
    // No strip can happen now: a held "<dir>/<source>" is an ordinary file. Write it.
    for (const e of this.entries.values()) {
      if (e.pending && e.path !== this.def.sourcePath) {
        const bytes = e.pending;
        e.pending = undefined;
        await this.put(e.path, bytes, e.content_type);
      }
    }
  }

  /** The source at the root, or "<top dir>/<source>" while a prefix strip is still possible. */
  private isSourceCandidate(path: string): boolean {
    const src = this.def.sourcePath;
    if (path === src) return true;
    if (typeof this.topDir !== "string") return false;
    return path === `${this.topDir}${src}`;
  }

  private checkCount(): void {
    // The source is one of the entries; assets are the rest.
    const assets = this.entries.size - (this.entries.has(this.def.sourcePath) ? 1 : 0);
    if (assets > this.ctx.config.maxAssetsPerVersion + 1) {
      throw tooManyAssets(this.ctx.config.maxAssetsPerVersion, assets);
    }
  }

  private countBytes(n: number): void {
    this.logicalBytes += n;
    if (this.logicalBytes > this.ctx.config.maxVersionBytes) {
      throw versionTooLarge(this.ctx.config.maxVersionBytes, [...this.entries.values()]);
    }
  }

  private keepForScan(path: string, contentType: string, bytes: Uint8Array): void {
    if (!this.scan || !SCAN_TYPES.test(contentType)) return;
    if (
      bytes.byteLength > LIMITS.maxScanFileBytes ||
      this.scanBytes + bytes.byteLength > LIMITS.maxScanBytes
    ) {
      this.unscanned.push(path);
      return;
    }
    this.scanBytes += bytes.byteLength;
    this.scanText.set(path, bytes);
  }

  /**
   * Validate a path once; false (and recorded) when it cannot be used. `check` runs the type's
   * asset rules between the path rules and the duplicate check, so an asset at a reserved path is
   * refused for what it is, not as a duplicate of the source.
   */
  private acceptPath(path: string, check?: () => void): boolean {
    const problem = pathProblem(path);
    if (problem) {
      this.badPaths.push({ path, reason: problem });
      return false;
    }
    check?.();
    if (this.entries.has(path)) {
      this.badPaths.push({ path, reason: "listed twice" });
      return false;
    }
    return true;
  }

  add(path: string, bytes: Uint8Array): Promise<void> {
    return this.addFile(path, bytes, { sourceAllowed: true });
  }

  /**
   * One file with its bytes. `sourceAllowed`: the bundle path, where the type's source file
   * arrives like any other file; inline assets may not use a reserved path. `expectedSha256`: a
   * hash the caller sent with the content, checked against the bytes.
   */
  async addFile(
    path: string,
    bytes: Uint8Array,
    opts: { sourceAllowed?: boolean; contentType?: string; expectedSha256?: string } = {},
  ): Promise<void> {
    this.throwIfFailed();
    const isSource = !!opts.sourceAllowed && path === this.def.sourcePath;
    const contentType = isSource ? this.def.contentType : assetContentType(path, opts.contentType);
    if (pathProblem(path) === null && opts.sourceAllowed) await this.noteTopDir(path);
    // A held "<dir>/<source>" is checked at finish, once a strip has decided what it is.
    const candidate = !!opts.sourceAllowed && this.isSourceCandidate(path);
    const check = isSource || candidate ? undefined : () => checkAsset(this.def, path, contentType);
    if (!this.acceptPath(path, check)) return;
    if (candidate && bytes.byteLength > this.def.maxSourceBytes && path === this.def.sourcePath) {
      throw sourceTooLarge(this.def.sourceLabel, this.def.maxSourceBytes, bytes.byteLength);
    }
    const sha256 = await sha256Hex(bytes);
    if (opts.expectedSha256 !== undefined && opts.expectedSha256 !== sha256) {
      throw new ApiError("invalid_input", `Asset ${path} does not match its sha256`, {
        path,
        expected: opts.expectedSha256,
        actual: sha256,
        next: "Send the sha256 of the bytes you send, or leave sha256 out",
      });
    }
    const entry: Entry = {
      path,
      rawPath: path,
      size_bytes: bytes.byteLength,
      content_type: contentType,
      sha256,
      own: false,
    };
    this.entries.set(path, entry);
    this.checkCount();
    this.countBytes(bytes.byteLength);
    this.keepForScan(path, contentType, bytes);
    if (candidate) {
      // Written at finish, once the final source path is known (a prefix strip may move it).
      entry.own = true;
      entry.pending = bytes;
      return;
    }
    const origin = this.reusable.get(sha256);
    if (origin) {
      entry.stored_at = origin.stored_at;
      this.reused++;
      return;
    }
    entry.own = true;
    this.reusable.set(sha256, {
      stored_at: this.rel + path,
      size_bytes: bytes.byteLength,
      content_type: contentType,
    });
    await this.put(path, bytes, contentType);
  }

  /** The type's source text (inline publish, update and restore). */
  async addSource(text: string | Uint8Array): Promise<void> {
    const bytes = typeof text === "string" ? encoder.encode(text) : text;
    if (bytes.byteLength > this.def.maxSourceBytes) {
      throw sourceTooLarge(this.def.sourceLabel, this.def.maxSourceBytes, bytes.byteLength);
    }
    await this.addFile(this.def.sourcePath, bytes, { sourceAllowed: true });
  }

  addRef(path: string, sha256: string): void {
    this.addRefTyped(path, sha256);
  }

  /** `{path, sha256}`, with the content type the caller named for an unknown extension. */
  addRefTyped(path: string, sha256: string, namedType?: string): void {
    this.throwIfFailed();
    const origin = this.reusable.get(sha256);
    const contentType = assetContentType(path, namedType ?? origin?.content_type);
    if (!this.acceptPath(path, () => checkAsset(this.def, path, contentType))) return;
    if (!origin) {
      this.missing.push(path);
      return;
    }
    this.entries.set(path, {
      path,
      rawPath: path,
      size_bytes: origin.size_bytes,
      content_type: contentType,
      sha256,
      stored_at: origin.stored_at,
      own: false,
    });
    this.checkCount();
    this.countBytes(origin.size_bytes);
    this.reused++;
  }

  /**
   * Carry one entry of a stored version forward unchanged: a reference, no R2 operation. A legacy
   * entry whose path the content host never served (`a//b.js`, `img/`) is dropped, not carried.
   */
  carry(from: Pick<VersionRow, "number" | "r2Prefix">, e: ManifestEntry): void {
    this.throwIfFailed();
    if (unservableLegacy(e)) return;
    if (this.entries.has(e.path)) {
      this.badPaths.push({ path: e.path, reason: "listed twice" });
      return;
    }
    const storedAt = e.stored_at ?? this.originOf(from, e.path);
    if (!validStoredAt(storedAt, from.number)) {
      throw new ApiError("internal", `Stored file ${e.path} has an unexpected location`);
    }
    this.entries.set(e.path, {
      path: e.path,
      rawPath: e.path,
      size_bytes: e.size_bytes,
      content_type: e.content_type,
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      stored_at: storedAt,
      own: false,
    });
    this.checkCount();
    this.countBytes(e.size_bytes);
    this.reused++;
  }

  /** Carry every non-reserved file of the current version (an update that sends no assets). */
  carryCurrent(): void {
    if (!this.current) return;
    for (const e of parseManifest(this.current.manifest)) {
      if (!this.def.reservedPaths.includes(e.path)) this.carry(this.current, e);
    }
  }

  private async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const size = bytes.byteLength;
    while (
      this.running.size > 0 &&
      (this.inflightBytes + size > LIMITS.bundleInFlightBytes ||
        this.running.size >= MAX_PARALLEL_PUTS)
    ) {
      await Promise.race(this.running);
    }
    this.throwIfFailed();
    this.inflightBytes += size;
    this.written++;
    this.writtenBytes += size;
    const p: Promise<void> = this.ctx.env.FILES.put(this.prefix + path, bytes, {
      httpMetadata: { contentType },
    })
      .then(
        () => undefined,
        (e: unknown) => {
          this.failure ??= e;
        },
      )
      .finally(() => {
        this.inflightBytes -= size;
        this.running.delete(p);
      });
    this.running.add(p);
  }

  /** Wait for every running put; then throw the first failure, if any. */
  private async settle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    if (this.failure) throw this.failure;
  }

  async finish(opts: { stripPrefix?: string } = {}): Promise<StagedVersion> {
    await this.settle();
    this.throwIfFailed();
    if (this.badPaths.length > 0) throw pathError(this.badPaths);
    const def = this.def;
    const list = [...this.entries.values()];

    const strip = opts.stripPrefix;
    if (strip) {
      if (!strip.endsWith("/") || pathProblem(strip.slice(0, -1)) !== null) {
        throw new ApiError("internal", "Bad prefix to strip");
      }
      if (list.some((e) => !e.path.startsWith(strip))) throw noEntryFile(def);
      for (const e of list) {
        e.path = e.path.slice(strip.length);
        // Already written under its raw path: point at that object, never rename it.
        if (e.own && !e.pending && e.stored_at === undefined) e.stored_at = this.rel + e.rawPath;
      }
      // Final paths are checked again: they decide reserved paths and the source.
      const seen = new Set<string>();
      for (const e of list) {
        const problem = pathProblem(e.path);
        if (problem) this.badPaths.push({ path: e.path, reason: problem });
        else if (seen.has(e.path)) this.badPaths.push({ path: e.path, reason: "listed twice" });
        seen.add(e.path);
      }
      if (this.badPaths.length > 0) throw pathError(this.badPaths);
    }

    const source = list.find((e) => e.path === def.sourcePath);
    if (!source?.pending) throw noEntryFile(def);
    for (const e of list) {
      if (e !== source) checkAsset(def, e.path, e.content_type);
    }
    if (this.missing.length > 0) {
      throw new ApiError(
        "invalid_input",
        `${this.missing.length} asset${this.missing.length === 1 ? "" : "s"} reuse files this artifact does not have; send their content`,
        {
          missing_paths: this.missing.slice(0, 100),
          next: "Send these assets with content (and sha256 if you like); sha256 alone only reuses files the artifact's current version has",
        },
      );
    }
    const assetCount = list.length - 1;
    if (assetCount > this.ctx.config.maxAssetsPerVersion) {
      throw tooManyAssets(this.ctx.config.maxAssetsPerVersion, assetCount);
    }
    if (this.logicalBytes > this.ctx.config.maxVersionBytes) {
      throw versionTooLarge(this.ctx.config.maxVersionBytes, list);
    }
    if (source.size_bytes > def.maxSourceBytes) {
      throw sourceTooLarge(def.sourceLabel, def.maxSourceBytes, source.size_bytes);
    }
    const sourceText = decoder.decode(source.pending);
    // A doc's source must be Markdown, never a whole HTML document (the bundle path included).
    resolveSource({ type: def.id, [def.sourceField]: sourceText }, null);

    // The source under its own prefix; other source candidates under their final path.
    source.content_type = def.contentType;
    for (const e of list) {
      if (!e.pending) continue;
      const bytes = e.pending;
      e.pending = undefined;
      await this.put(e.path, bytes, e.content_type);
      if (e !== source) {
        this.reusable.set(e.sha256 as string, {
          stored_at: this.rel + e.path,
          size_bytes: e.size_bytes,
          content_type: e.content_type,
        });
      }
    }
    await this.settle();

    const entries: ManifestEntry[] = list.map((e) => ({
      path: e.path,
      size_bytes: e.size_bytes,
      content_type: e.content_type,
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      ...(e.stored_at !== undefined ? { stored_at: e.stored_at } : {}),
    }));
    // Source first, then the files in the order they arrived.
    entries.sort((a, b) => (a.path === def.sourcePath ? -1 : b.path === def.sourcePath ? 1 : 0));

    let capabilities: string | null;
    if (this.capabilitiesOverride !== undefined) capabilities = this.capabilitiesOverride;
    else if (def.id === "html") {
      const caps = parseCapabilities(sourceText);
      capabilities = caps ? JSON.stringify(caps) : null;
    } else capabilities = null;

    let warnings: PublishWarning[] = [];
    if (this.scan) {
      const byRaw = new Map(list.map((e) => [e.rawPath, e.path]));
      const files: FileEntry[] = [];
      for (const [raw, bytes] of this.scanText) {
        const e = this.entries.get(raw);
        if (!e) continue;
        files.push({ path: byRaw.get(raw) ?? raw, bytes, contentType: e.content_type });
      }
      warnings = scanPublish({
        files,
        manifestPaths: new Set(entries.map((e) => e.path)),
        sources: contentSources(this.ctx.config),
        isolation: this.ctx.config.contentIsolation,
        unscanned: this.unscanned.map((p) => byRaw.get(p) ?? p),
      });
      this.scanText.clear();
    }

    const staged: StagedVersion = {
      prefix: this.prefix,
      entries,
      logicalBytes: this.logicalBytes,
      writtenBytes: this.writtenBytes,
      written: this.written,
      reused: this.reused,
    };
    const named = this.target.mode === "publish" ? this.target.title : undefined;
    stagedExtras.set(staged, {
      stager: this,
      capabilities,
      title: named || titleFromSource(def, sourceText) || "Untitled",
      warnings,
    });
    return staged;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
    await deletePrefix(this.ctx.env.FILES, this.prefix);
  }
}

async function currentVersionRow(ctx: Ctx, target: VersionTarget): Promise<VersionRow | null> {
  if (target.mode !== "update" || target.artifact.currentVersion < 1) return null;
  return getVersionRow(ctx, target.artifact.id, target.artifact.currentVersion);
}

/** A stager with the inline and restore helpers (addSource, addFile, carry). */
export async function openVersionStager(ctx: Ctx, target: VersionTarget): Promise<VersionStager> {
  return new VersionStager(ctx, target, await currentVersionRow(ctx, target));
}

export async function openStager(ctx: Ctx, target: VersionTarget): Promise<Stager> {
  return openVersionStager(ctx, target);
}

// ---------- the commit ----------

export interface CommitOptions {
  ticketId?: string;
  /** Publish only: the new artifact's visibility and password hash (default allowlist). */
  visibility?: Visibility;
  passwordHash?: string | null;
  restoredFrom?: number | null;
}

const QUOTA_GUARD = `(SELECT coalesce(sum(coalesce(v.stored_bytes, v.size_bytes)), 0) FROM versions v
    JOIN artifacts x ON x.id = v.artifact_id WHERE x.owner_id = ? AND x.deleted_at IS NULL) + ? <= ?`;
const TICKET_GUARD =
  "EXISTS (SELECT 1 FROM upload_tickets WHERE id = ? AND state = 'open' AND expires_at > ?)";

/** Bytes counted against the owner's storage quota (live artifacts, stored bytes). */
export async function storageUsed(ctx: Ctx, ownerId: string): Promise<number> {
  const row = await ctx.env.DB.prepare(
    `SELECT coalesce(sum(coalesce(v.stored_bytes, v.size_bytes)), 0) AS used FROM versions v
       JOIN artifacts a ON a.id = v.artifact_id
      WHERE a.owner_id = ?1 AND a.deleted_at IS NULL`,
  )
    .bind(ownerId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

function storageError(limit: number, used: number, adding: number): ApiError {
  return new ApiError(
    "quota_exceeded",
    `Storage limit reached (${Math.round(limit / 1024 / 1024)} MB). Delete artifacts to free space.`,
    {
      limit_bytes: limit,
      used_bytes: used,
      adding_bytes: adding,
      next: "Delete artifacts you no longer need; unchanged files sent as {path, sha256} add nothing",
    },
  );
}

/**
 * A manifest entry written before stored_at whose path the current ASSET_PATH_RE refuses. Older
 * releases accepted such paths (`a//b.js`, `img/`), but the content host never served them, so a
 * carry-forward or a restore leaves them out rather than failing on them.
 */
function unservableLegacy(e: ManifestEntry): boolean {
  return (
    e.stored_at === undefined &&
    (e.path.length > LIMITS.maxAssetPathLength || !ASSET_PATH_RE.test(e.path))
  );
}

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const suffix = randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  return base ? `${base}-${suffix}` : suffix;
}

/** How long a version row above current_version must have sat before it counts as an orphan. */
const ORPHAN_AGE_MS = 10 * 60 * 1000;

/**
 * One guarded D1 batch: the artifact row (publish), the version row, the current_version advance
 * and, with `ticketId`, the upload ticket's `open -> used`. Aborts the stager on failure.
 */
export async function commitStaged(
  ctx: Ctx,
  target: VersionTarget,
  staged: StagedVersion,
  opts?: { ticketId?: string },
): Promise<PublishResult> {
  return commitVersion(ctx, target, staged, opts ?? {});
}

/**
 * Errors after which the batch may have committed: the attempt's objects are kept (a version row
 * may name them), and sweep-orphans removes them later if none does.
 */
const keepObjects = new WeakSet<object>();

export async function commitVersion(
  ctx: Ctx,
  target: VersionTarget,
  staged: StagedVersion,
  opts: CommitOptions,
): Promise<PublishResult> {
  const extra = stagedExtras.get(staged);
  if (!extra) throw new ApiError("internal", "Version was not staged");
  try {
    return await commitOnce(ctx, target, staged, extra, opts);
  } catch (e) {
    if (!(typeof e === "object" && e !== null && keepObjects.has(e))) {
      await extra.stager.abort().catch(() => undefined);
    }
    throw e;
  }
}

/**
 * After DB.batch threw something other than a UNIQUE violation (a lost connection, a timeout),
 * whether the version row exists: D1 can report an error for a transaction it applied. Null when
 * that cannot be read either.
 */
async function versionLanded(DB: D1Database, versionId: string): Promise<boolean | null> {
  try {
    return (
      (await DB.prepare("SELECT 1 AS one FROM versions WHERE id = ?").bind(versionId).first()) !==
      null
    );
  } catch {
    return null;
  }
}

async function commitOnce(
  ctx: Ctx,
  target: VersionTarget,
  staged: StagedVersion,
  extra: StagedExtra,
  opts: CommitOptions,
): Promise<PublishResult> {
  const actor = requireActor(ctx);
  const DB = ctx.env.DB;
  const def = extra.stager.def;
  const artifactId = extra.stager.artifactId;
  const limit = ctx.config.maxStorageBytesPerUser;
  const manifest = JSON.stringify(staged.entries);

  let ownerId: string;
  let slug: string;
  let artifactLimit = 0;
  let visibility: Visibility;
  if (target.mode === "publish") {
    const user = await getUserById(ctx.db, actor.userId);
    if (!user) throw unauthorized();
    ownerId = user.id;
    artifactLimit = artifactLimitFor(ctx.config, user);
    slug = slugify(extra.title);
    visibility = opts.visibility ?? "allowlist";
  } else {
    ownerId = target.artifact.ownerId;
    slug = target.artifact.slug;
    visibility = target.artifact.visibility;
  }
  let base = target.mode === "publish" ? 0 : (target.baseVersion ?? target.artifact.currentVersion);
  let orphanCleared = false;

  for (let attempt = 0; attempt < 8; attempt++) {
    const now = nowIso();
    const n = base + 1;
    const versionId = newId();
    const ticketBinds = opts.ticketId ? [opts.ticketId, now] : [];
    const ticketClause = opts.ticketId ? ` AND ${TICKET_GUARD}` : "";
    const stmts: D1PreparedStatement[] = [];
    if (target.mode === "publish") {
      stmts.push(
        DB.prepare(
          `INSERT INTO artifacts (id, owner_id, slug, title, current_version, visibility, password_hash,
             access_epoch, created_at, updated_at, type)
           SELECT ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?
            WHERE (SELECT count(*) FROM artifacts WHERE owner_id = ? AND deleted_at IS NULL) < ?
              AND ${QUOTA_GUARD}${ticketClause}`,
        ).bind(
          artifactId,
          ownerId,
          slug,
          extra.title,
          visibility,
          opts.passwordHash ?? null,
          now,
          now,
          def.id,
          ownerId,
          artifactLimit,
          ownerId,
          staged.writtenBytes,
          limit,
          ...ticketBinds,
        ),
      );
    }
    const versionIndex = stmts.length;
    stmts.push(
      DB.prepare(
        `INSERT INTO versions (id, artifact_id, number, r2_prefix, size_bytes, stored_bytes, manifest,
           created_by_user, created_by_connection, note, restored_from, created_at, capabilities)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND deleted_at IS NULL AND current_version = ?)
            AND ${QUOTA_GUARD}${ticketClause}`,
      ).bind(
        versionId,
        artifactId,
        n,
        staged.prefix,
        staged.logicalBytes,
        staged.writtenBytes,
        manifest,
        actor.userId,
        actor.connectionId,
        target.mode === "update" ? (target.note ?? null) : null,
        opts.restoredFrom ?? null,
        now,
        extra.capabilities,
        artifactId,
        base,
        ownerId,
        staged.writtenBytes,
        limit,
        ...ticketBinds,
      ),
    );
    stmts.push(
      DB.prepare(
        `UPDATE artifacts SET current_version = ?, updated_at = ?
          WHERE id = ? AND current_version = ? AND EXISTS (SELECT 1 FROM versions WHERE id = ?)`,
      ).bind(n, now, artifactId, base, versionId),
    );
    if (opts.ticketId) {
      stmts.push(
        DB.prepare(
          `UPDATE upload_tickets SET state = 'used', result_artifact_id = ?, result_version = ?,
             used_at = ?, receiving_until = NULL
           WHERE id = ? AND state = 'open' AND EXISTS (SELECT 1 FROM versions WHERE id = ?)`,
        ).bind(artifactId, n, now, opts.ticketId, versionId),
      );
    }

    const committed = (): PublishResult => ({
      id: artifactId,
      slug,
      type: def.id,
      version: n,
      url: appUrl(ctx.config, `/a/${slug}`),
      content_url: `${contentOrigin(ctx.config, artifactId)}/`,
      visibility,
      warnings: extra.warnings,
      stored: {
        files: staged.entries.length,
        written: staged.written,
        reused: staged.reused,
        bytes: staged.logicalBytes,
        bytes_written: staged.writtenBytes,
      },
    });

    let results: D1Result[];
    try {
      results = await DB.batch(stmts);
    } catch (e) {
      if (!isUniqueViolation(e)) {
        // The batch is one transaction: the version row exists exactly when it all applied.
        const landed = await versionLanded(DB, versionId);
        if (landed) return committed();
        if (landed === null) {
          // Unknown outcome: never delete objects a live version may name.
          if (typeof e === "object" && e !== null) {
            keepObjects.add(e);
            throw e;
          }
          const wrapped = new Error(String(e));
          keepObjects.add(wrapped);
          throw wrapped;
        }
        throw e;
      }
      const msg = String((e as { message?: unknown }).message ?? e);
      if (target.mode === "publish" && msg.includes("slug")) {
        slug = slugify(`${extra.title} ${randomString(4, "abcdefghijklmnopqrstuvwxyz")}`);
        continue;
      }
      // UNIQUE(artifact_id, number): only a version row left by the old write order can hold a
      // number above current_version.
      const orphan = await DB.prepare(
        `SELECT v.id AS id, v.r2_prefix AS prefix, v.created_at AS created_at, a.current_version AS cur
           FROM versions v JOIN artifacts a ON a.id = v.artifact_id
          WHERE v.artifact_id = ? AND v.number = ?`,
      )
        .bind(artifactId, n)
        .first<{ id: string; prefix: string; created_at: string; cur: number }>();
      if (
        orphan &&
        n > orphan.cur &&
        !orphanCleared &&
        Date.now() - Date.parse(orphan.created_at) > ORPHAN_AGE_MS &&
        orphan.prefix.startsWith(`artifacts/${artifactId}/`) &&
        orphan.prefix !== `artifacts/${artifactId}/`
      ) {
        orphanCleared = true;
        await deletePrefix(ctx.env.FILES, orphan.prefix);
        await DB.prepare(
          `DELETE FROM versions WHERE id = ? AND number > (SELECT current_version FROM artifacts WHERE id = ?)`,
        )
          .bind(orphan.id, artifactId)
          .run();
        continue;
      }
      if (
        orphan &&
        n <= orphan.cur &&
        target.mode === "update" &&
        target.baseVersion === undefined
      ) {
        base = orphan.cur;
        continue;
      }
      if (
        target.mode === "update" &&
        target.baseVersion !== undefined &&
        orphan &&
        n <= orphan.cur
      ) {
        throw conflictError(target.baseVersion, orphan.cur);
      }
      throw new ApiError("conflict", "Another version is being written; try again shortly", {
        next: "Read the artifact again (get_artifact) and resend with base_version",
      });
    }

    if ((results[versionIndex]?.meta.changes ?? 0) === 1) return committed();

    // Nothing was written. Name the cause.
    if (opts.ticketId) {
      const t = await DB.prepare(
        "SELECT state, expires_at, result_artifact_id, result_version FROM upload_tickets WHERE id = ?",
      )
        .bind(opts.ticketId)
        .first<{
          state: string;
          expires_at: string;
          result_artifact_id: string | null;
          result_version: number | null;
        }>();
      if (!t) throw notFound("Upload");
      if (t.state === "used") {
        throw new ApiError("conflict", "This upload was already used", {
          reason: "upload_used",
          ...(t.result_version !== null ? { version: t.result_version } : {}),
          next: "Call start_upload again for another change",
        });
      }
      if (t.state === "dead") {
        throw new ApiError("conflict", "This upload can no longer be used", {
          reason: "upload_dead",
          next: "Call start_upload again",
        });
      }
      if (t.expires_at <= now) {
        throw new ApiError("invalid_input", "This upload expired", {
          reason: "upload_expired",
          next: "Call start_upload again",
        });
      }
    }
    if (target.mode === "publish") {
      if ((await liveArtifactCount(ctx, ownerId)) >= artifactLimit)
        throw artifactLimitError(artifactLimit);
    } else {
      const art = await DB.prepare(
        "SELECT current_version AS cur, deleted_at AS deleted FROM artifacts WHERE id = ?",
      )
        .bind(artifactId)
        .first<{ cur: number; deleted: string | null }>();
      if (!art || art.deleted) throw notFound();
      if (art.cur !== base) {
        if (target.baseVersion !== undefined) throw conflictError(target.baseVersion, art.cur);
        base = art.cur;
        continue;
      }
    }
    const used = await storageUsed(ctx, ownerId);
    if (used + staged.writtenBytes > limit) throw storageError(limit, used, staged.writtenBytes);
    // A race that resolved itself by the time we looked: try again.
  }
  throw new ApiError("conflict", "Too many concurrent updates, try again", {
    next: "Read the artifact again (get_artifact) and resend with base_version",
  });
}
