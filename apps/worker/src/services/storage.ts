// R2 layout (docs/spec.md, reuse by hash and commit-last): a version's own objects live under its
// prefix, `artifacts/<artifact_id>/v<n>.<nonce>/` for versions written from 0.4.0 on and
// `artifacts/<artifact_id>/v<n>/` for older ones. The prefix holds the type's source file
// (index.html for an html page, content.md for a doc; packages/shared/src/artifactTypes.ts) and the
// files this version wrote. A file reused from an earlier version of the same artifact is not copied:
// its manifest entry carries `stored_at`, the object's physical origin. A prefix is written once and
// never changed (versions are immutable), and objects are never deleted one version at a time.
import { ASSET_PATH_RE, LIMITS, STORED_AT_RE } from "@plinth/shared";
import { randomString } from "../lib/crypto.ts";
import { ApiError, notFound } from "../lib/errors.ts";

export interface FileEntry {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ManifestEntry {
  path: string;
  size_bytes: number;
  content_type: string;
  /** Lowercase hex SHA-256 of the bytes, computed by the server (files written after 0006). */
  sha256?: string;
  /**
   * Server-written pointer to the object's physical origin inside the same artifact:
   * `v<m>[.<nonce>]/<path>`, relative to `artifacts/<id>/` (STORED_AT_RE). Never accepted from
   * input and never returned by the API.
   */
  stored_at?: string;
}

/** `artifacts/<id>/`: everything one artifact stores. */
export function artifactRoot(artifactId: string): string {
  return `artifacts/${artifactId}/`;
}

/**
 * The R2 key of one manifest entry of version `v`: `v.r2Prefix + e.path`, or, with `stored_at`,
 * `artifacts/<artifactId>/` + `stored_at` after validating it. Throws notFound on a bad stored_at:
 * one that does not parse, names a version above `v.number`, or whose path is not a plain asset
 * path. A prefix outside the artifact's own root is refused too, so a key never leaves it.
 */
export function fileKey(
  artifactId: string,
  v: { number: number; r2Prefix: string },
  e: ManifestEntry,
): string {
  const root = artifactRoot(artifactId);
  if (!v.r2Prefix.startsWith(root) || v.r2Prefix.length === root.length) throw notFound("File");
  if (e.stored_at === undefined) return v.r2Prefix + e.path;
  if (!validStoredAt(e.stored_at, v.number)) throw notFound("File");
  return root + e.stored_at;
}

/** A stored_at that parses, names version `maxNumber` or below, and whose path is plain. */
export function validStoredAt(storedAt: unknown, maxNumber: number): storedAt is string {
  if (typeof storedAt !== "string") return false;
  const m = STORED_AT_RE.exec(storedAt);
  if (!m?.[3]) return false;
  if (Number(m[1]) > maxNumber) return false;
  return m[3].length <= LIMITS.maxAssetPathLength && ASSET_PATH_RE.test(m[3]);
}

/** Lowercase hex SHA-256 of some bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  jsonld: "application/ld+json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  wasm: "application/wasm",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/**
 * A fresh, unique prefix for one attempt at writing version `n` (the number the writer expects;
 * the version row's r2_prefix is authoritative, the number in it only a hint).
 */
export function attemptPrefix(artifactId: string, n: number): string {
  return `${artifactRoot(artifactId)}v${n}.${randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789")}/`;
}

/** A prefix relative to the artifact's root (`v<n>[.<nonce>]/`), as stored_at uses it. */
export function relativePrefix(artifactId: string, prefix: string): string {
  const root = artifactRoot(artifactId);
  if (!prefix.startsWith(root))
    throw new ApiError("internal", "Version prefix outside its artifact");
  return prefix.slice(root.length);
}

const utf8 = new TextEncoder();

export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("bad base64");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An inline asset's bytes (utf8 text or base64). */
export function assetBytes(
  path: string,
  content: string,
  encoding: string | undefined,
): Uint8Array {
  try {
    return encoding === "base64" ? decodeBase64(content) : utf8.encode(content);
  } catch {
    throw new ApiError("invalid_input", `Asset ${path} is not valid base64`, { path });
  }
}

/** The content type for a path: by extension, else a well-formed one the caller named. */
export function assetContentType(path: string, named?: string): string {
  const byExt = contentTypeFor(path);
  return byExt === "application/octet-stream" && named && /^[\w.+-]+\/[\w.+-]+$/.test(named)
    ? named
    : byExt;
}

const MBf = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/** The source file over its type's limit. */
export function sourceTooLarge(label: string, limit: number, size: number): ApiError {
  return new ApiError("payload_too_large", `${label} is over ${limit / 1024 / 1024} MB`, {
    limit_bytes: limit,
    size_bytes: size,
    next: "Move inline scripts and data into asset files",
  });
}

/** More asset files than this instance allows in one version. */
export function tooManyAssets(limit: number, count: number): ApiError {
  return new ApiError(
    "payload_too_large",
    `${count} asset files; this instance allows ${limit} per version`,
    {
      limit,
      count,
      next: "Leave out source maps (*.map). Never merge chunks to fit. Large builds: call start_upload, or run npx @mr0b0t0/plinth publish <dir>",
    },
  );
}

/** A version over MAX_VERSION_BYTES, naming its largest files. */
export function versionTooLarge(
  limit: number,
  entries: { path: string; size_bytes: number }[],
): ApiError {
  const total = entries.reduce((n, e) => n + e.size_bytes, 0);
  const largest = [...entries]
    .sort((a, b) => b.size_bytes - a.size_bytes)
    .slice(0, 5)
    .map((e) => ({ path: e.path, size_bytes: e.size_bytes }));
  return new ApiError(
    "payload_too_large",
    `Version is over ${MBf(limit)} in total (${MBf(total)})`,
    {
      limit_bytes: limit,
      size_bytes: total,
      largest,
      next: "Leave out source maps (*.map) and files the page does not load, or compress large media",
    },
  );
}

/** Read stored files of version `v` (resolving stored_at). */
export async function readFiles(
  bucket: R2Bucket,
  artifactId: string,
  v: { number: number; r2Prefix: string },
  manifest: ManifestEntry[],
): Promise<FileEntry[]> {
  return Promise.all(
    manifest.map(async (m) => {
      const obj = await bucket.get(fileKey(artifactId, v, m));
      if (!obj) throw new ApiError("internal", `Missing stored file ${m.path}`);
      return {
        path: m.path,
        bytes: new Uint8Array(await obj.arrayBuffer()),
        contentType: m.content_type,
      };
    }),
  );
}

export async function readText(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** A version's manifest. Malformed JSON or entries read as empty or are dropped. */
export function parseManifest(json: string): ManifestEntry[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is ManifestEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof e.path === "string" &&
      typeof e.size_bytes === "number" &&
      typeof e.content_type === "string",
  );
}
