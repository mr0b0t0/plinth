// R2 layout: artifacts/<artifact_id>/v<n>/<source> plus asset paths, where <source> is the type's
// source file (index.html for an html page, content.md for a doc; packages/shared/src/
// artifactTypes.ts). A version's prefix is written once and never changed (versions are immutable).
import type { ArtifactTypeDef, AssetInput } from "@plinth/shared";
import type { Config } from "../config.ts";
import { ApiError } from "../lib/errors.ts";
import { checkAsset } from "./artifactTypes.ts";

/** The instance's per-version limits (MAX_VERSION_BYTES, MAX_ASSETS_PER_VERSION). */
export type VersionLimits = Pick<Config, "maxVersionBytes" | "maxAssetsPerVersion">;

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

/**
 * The R2 key of one manifest entry of version `v`: `v.r2Prefix + e.path`, or, with `stored_at`,
 * `artifacts/<artifactId>/` + `stored_at` after validating it. Throws notFound on a bad stored_at.
 */
export function fileKey(
  _artifactId: string,
  _v: { number: number; r2Prefix: string },
  _e: ManifestEntry,
): string {
  throw new Error("not implemented");
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
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
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

export function versionPrefix(artifactId: string, n: number): string {
  return `artifacts/${artifactId}/v${n}/`;
}

const utf8 = new TextEncoder();

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("bad base64");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Validate and encode the files of one version: the type's source file at def.sourcePath, then the
 * assets. Enforces the source and per-version size limits and the type's asset rules.
 */
export function prepareFiles(
  def: ArtifactTypeDef,
  source: string,
  assets: AssetInput[] | undefined,
  limits: VersionLimits,
): FileEntry[] {
  const sourceBytes = utf8.encode(source);
  if (sourceBytes.byteLength > def.maxSourceBytes) {
    throw new ApiError(
      "payload_too_large",
      `${def.sourceLabel} is over ${def.maxSourceBytes / 1024 / 1024} MB`,
      {
        limit_bytes: def.maxSourceBytes,
        size_bytes: sourceBytes.byteLength,
      },
    );
  }
  const count = assets?.length ?? 0;
  if (count > limits.maxAssetsPerVersion) {
    throw new ApiError(
      "payload_too_large",
      `${count} asset files; this instance allows ${limits.maxAssetsPerVersion} per version`,
      { limit: limits.maxAssetsPerVersion, count },
    );
  }
  const files: FileEntry[] = [
    { path: def.sourcePath, bytes: sourceBytes, contentType: def.contentType },
  ];
  const seen = new Set([def.sourcePath]);
  for (const a of assets ?? []) {
    const byExt = contentTypeFor(a.path);
    const contentType =
      byExt === "application/octet-stream" &&
      a.content_type &&
      /^[\w.+-]+\/[\w.+-]+$/.test(a.content_type)
        ? a.content_type
        : byExt;
    checkAsset(def, a.path, contentType);
    if (seen.has(a.path)) throw new ApiError("invalid_input", `Duplicate asset path: ${a.path}`);
    seen.add(a.path);
    const content = a.content;
    if (content === undefined) {
      throw new ApiError("invalid_input", `Asset ${a.path} has no content`, { path: a.path });
    }
    let bytes: Uint8Array;
    try {
      bytes = a.encoding === "base64" ? decodeBase64(content) : utf8.encode(content);
    } catch {
      throw new ApiError("invalid_input", `Asset ${a.path} is not valid base64`);
    }
    files.push({ path: a.path, bytes, contentType });
  }
  checkTotal(files, limits.maxVersionBytes);
  return files;
}

export function checkTotal(files: { bytes: Uint8Array }[], maxVersionBytes: number): number {
  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > maxVersionBytes) {
    throw new ApiError(
      "payload_too_large",
      `Version is over ${Math.round((maxVersionBytes / 1024 / 1024) * 10) / 10} MB in total`,
      {
        limit_bytes: maxVersionBytes,
        size_bytes: total,
      },
    );
  }
  return total;
}

export function manifestOf(files: FileEntry[]): ManifestEntry[] {
  return files.map((f) => ({
    path: f.path,
    size_bytes: f.bytes.byteLength,
    content_type: f.contentType,
  }));
}

export async function writeFiles(
  bucket: R2Bucket,
  prefix: string,
  files: FileEntry[],
): Promise<void> {
  await Promise.all(
    files.map((f) =>
      bucket.put(prefix + f.path, f.bytes, { httpMetadata: { contentType: f.contentType } }),
    ),
  );
}

/** Read every file of a stored version (used for restore and for carrying assets forward). */
export async function readFiles(
  bucket: R2Bucket,
  prefix: string,
  manifest: ManifestEntry[],
): Promise<FileEntry[]> {
  return Promise.all(
    manifest.map(async (m) => {
      const obj = await bucket.get(prefix + m.path);
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

export function parseManifest(json: string): ManifestEntry[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}
