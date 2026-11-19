// Files people add to a page (docs/spec.md "Files people add to a page"): the type allowlist and
// the sniffing that proves a type from the first bytes, file names, part sizes, the
// Content-Disposition value, agent tool inputs and the wire types. Pure code, used by the Worker,
// the web app and tests. A page declares `files`; the Worker stores bytes only of a type it proved
// from the bytes themselves, and never markup (no SVG, HTML, XML or text of any kind).
import { z } from "zod";
import type { EffectiveRole } from "./constants.ts";
import { artifactRefSchema } from "./schemas.ts";

/** A file's id: 20 random lowercase letters and digits. */
export const FILE_ID_RE = /^[a-z0-9]{20}$/;

const MiB = 1024 * 1024;

/**
 * Fixed rules, not env vars (the env-var caps are FILE_DEFAULTS). Every part of an upload but the
 * last is exactly `partBytes` long: 5 MiB is R2's smallest multipart part.
 */
export const FILE_LIMITS = {
  /** Bytes in each part of an upload but the last (R2's multipart minimum). */
  partBytes: 5 * MiB,
  /** Characters in a stored file name, its extension included. */
  maxNameLength: 200,
  /** Characters a page may send as a file's name, before it is cleaned. */
  maxInputNameLength: 400,
  /** Unfinished uploads one person may have on one artifact at a time. */
  maxPendingPerUploader: 3,
  /** Files in one page of a list. */
  maxListLimit: 100,
  /** An upload must finish within this long of its start. */
  uploadMs: 30 * 60 * 1000,
  /** A cancelled or expired upload's bytes are cleared this long after its deadline. */
  tombstoneGraceMs: 15 * 60 * 1000,
  /** A sweep that claimed a row and did not finish lets another one retry after this long. */
  reclaimMs: 10 * 60 * 1000,
  /** Bytes of a create request's JSON body. */
  createBodyBytes: 2048,
  /**
   * Part requests allowed per part of the largest file an hour, per person and per artifact, on
   * top of the upload rate limits: one send and the runtime's three retries.
   */
  sendsPerPart: 4,
} as const;

/** The env-var caps (FILES_*), with their defaults. */
export const FILE_DEFAULTS = {
  /** FILES_MAX_FILE_BYTES */
  maxFileBytes: 20 * MiB,
  /** FILES_MAX_PER_ARTIFACT */
  maxFilesPerArtifact: 500,
  /** FILES_MAX_BYTES_PER_ARTIFACT */
  maxBytesPerArtifact: 256 * MiB,
  /** FILES_MAX_BYTES_PER_UPLOADER: one person on one artifact; the owner is exempt. */
  maxBytesPerUploader: 64 * MiB,
  /** FILES_MAX_BYTES_PER_USER: across all of an owner's live artifacts. */
  maxBytesPerUser: 1024 * MiB,
  /** FILES_UPLOADS_PER_UPLOADER_PER_HOUR */
  uploadsPerUploaderPerHour: 60,
  /** FILES_UPLOADS_PER_ARTIFACT_PER_HOUR */
  uploadsPerArtifactPerHour: 300,
} as const;

/** Hard bounds an operator's FILES_MAX_FILE_BYTES and FILES_MAX_PER_ARTIFACT must stay within. */
export const FILE_BOUNDS = {
  maxFileBytes: [1 * MiB, 100 * MiB],
  maxFilesPerArtifact: [1, 10_000],
} as const;

/**
 * The types a page may upload, each with its canonical extension and the other extensions a name
 * may already end in. Nothing here is markup or text: the browser can never run any of them.
 */
export const FILE_TYPES = {
  "image/png": { ext: "png", also: [], family: "image" },
  "image/jpeg": { ext: "jpg", also: ["jpeg", "jpe"], family: "image" },
  "image/gif": { ext: "gif", also: [], family: "image" },
  "image/webp": { ext: "webp", also: [], family: "image" },
  "image/avif": { ext: "avif", also: [], family: "image" },
  "application/pdf": { ext: "pdf", also: [], family: "document" },
  "video/mp4": { ext: "mp4", also: ["m4v"], family: "video" },
  "video/webm": { ext: "webm", also: [], family: "video" },
  "audio/mpeg": { ext: "mp3", also: [], family: "audio" },
  "audio/mp4": { ext: "m4a", also: [], family: "audio" },
  "audio/ogg": { ext: "ogg", also: ["oga", "opus"], family: "audio" },
  "audio/wav": { ext: "wav", also: [], family: "audio" },
} as const satisfies Record<
  string,
  { ext: string; also: readonly string[]; family: "image" | "document" | "video" | "audio" }
>;

export type FileType = keyof typeof FILE_TYPES;

/** Every accepted type, in a fixed order. */
export const FILE_TYPE_LIST = Object.keys(FILE_TYPES) as FileType[];

export function isFileType(t: unknown): t is FileType {
  return typeof t === "string" && Object.hasOwn(FILE_TYPES, t);
}

/** How many leading bytes sniffFileType needs at most. */
export const SNIFF_BYTES = 64;

/** ISO base media brands (ftyp) for MP4 video. QuickTime (`qt  `), HEIF and 3GP are refused. */
const MP4_VIDEO_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);
const M4A_BRANDS = new Set(["M4A "]);

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return s;
}

function startsWith(b: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (b.length < at + bytes.length) return false;
  return bytes.every((x, i) => b[at + i] === x);
}

/** A WebM file: an EBML header whose DocType element (0x4282, a one-byte size of 4) says webm. */
function isWebm(b: Uint8Array): boolean {
  if (!startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const end = Math.min(b.length, SNIFF_BYTES);
  for (let i = 4; i + 7 <= end; i++) {
    if (b[i] === 0x42 && b[i + 1] === 0x82 && b[i + 2] === 0x84 && ascii(b, i + 3, 4) === "webm")
      return true;
  }
  return false;
}

/**
 * The type the first bytes of a file prove, or null. Reads at most SNIFF_BYTES. Only the start of
 * the file counts: markup later in a file never makes it a document, and a file that does not
 * start with one of these signatures is refused whatever follows.
 */
export function sniffFileType(head: Uint8Array): FileType | null {
  const b = head.subarray(0, SNIFF_BYTES);
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const six = ascii(b, 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
    const kind = ascii(b, 8, 4);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
    return null;
  }
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (AVIF_BRANDS.has(brand)) return "image/avif";
    if (M4A_BRANDS.has(brand)) return "audio/mp4";
    if (MP4_VIDEO_BRANDS.has(brand)) return "video/mp4";
    return null;
  }
  if (isWebm(b)) return "video/webm";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  // An MPEG audio frame: an 11-bit sync, MPEG version not reserved (01), a layer not reserved
  // (00 is AAC's ADTS, refused).
  if (b.length >= 2 && b[0] === 0xff) {
    const b1 = b[1] as number;
    if ((b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0) return "audio/mpeg";
  }
  return null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
/** Bidirectional controls (an RTL override turns "gpj.exe" into "exe.jpg") and invisible marks. */
const BIDI_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** The extensions a name of this type may already end in. */
function extensionsOf(type: FileType): readonly string[] {
  const t = FILE_TYPES[type];
  return [t.ext, ...t.also];
}

/**
 * A name safe to show and to send in a header: the last path segment, NFC, without control or
 * bidirectional characters, trimmed, at most FILE_LIMITS.maxNameLength characters. When it does not
 * end in an extension of its proven type, the canonical one is appended (`evil.html` becomes
 * `evil.html.png`). It is still untrusted display text wherever it appears.
 */
export function sanitizeFileName(name: string, type: FileType): string {
  const base = (name.split(/[/\\]/).pop() ?? "")
    .normalize("NFC")
    .replace(CONTROL_RE, "")
    .replace(BIDI_RE, "")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const chars = [...base];
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const max = FILE_LIMITS.maxNameLength;
  if (chars.length > 0 && extensionsOf(type).includes(ext)) {
    if (chars.length <= max) return base;
    // Keep the extension, shorten the stem.
    const tail = `.${base.slice(dot + 1)}`;
    return chars.slice(0, max - [...tail].length).join("") + tail;
  }
  const suffix = `.${FILE_TYPES[type].ext}`;
  const stem = chars.length > 0 ? chars.slice(0, max - suffix.length).join("") : "file";
  return `${stem}${suffix}`;
}

/** How many parts an upload of `size` bytes takes. */
export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / FILE_LIMITS.partBytes));
}

/** The exact length of part `n` (1-based) of an upload of `size` bytes. */
export function partLength(size: number, n: number): number {
  const parts = partCount(size);
  if (!Number.isInteger(n) || n < 1 || n > parts) return 0;
  return n < parts ? FILE_LIMITS.partBytes : size - (parts - 1) * FILE_LIMITS.partBytes;
}

/** The longest JSON body a part may have: `{"data":"<base64>"}` with a little whitespace. */
export function maxPartBodyBytes(): number {
  return 4 * Math.ceil(FILE_LIMITS.partBytes / 3) + 64;
}

/** RFC 5987 encoding of a header parameter value. */
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(
    /['()*]/g,
    (c) => `%${(c.codePointAt(0) as number).toString(16).toUpperCase()}`,
  );
}

/**
 * A Content-Disposition value (RFC 6266): `inline` or `attachment`, an ASCII fallback name with
 * every other character replaced, and the full name as `filename*=UTF-8''…`.
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = [...name]
    .map((c) => (/^[\x20-\x7e]$/.test(c) && !/["\\%;]/.test(c) ? c : "_"))
    .join("");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}

// ---------- inputs ----------

/** POST /__plinth/api/v1/files: start an upload. The type is checked against FILE_TYPES. */
export const createFileInput = z.strictObject({
  name: z.string().min(1).max(FILE_LIMITS.maxInputNameLength),
  type: z.string().min(1).max(100),
  size: z.number().int().min(1),
});
export type CreateFileInput = z.infer<typeof createFileInput>;

/** list_artifact_files and GET /api/v1/artifacts/:ref/files */
export const listArtifactFilesInput = z.object({
  id: artifactRefSchema,
  limit: z.number().int().min(1).max(FILE_LIMITS.maxListLimit).default(50),
  cursor: z.string().max(400).optional().describe("next_cursor from the previous page"),
});

export const fileIdSchema = z
  .string()
  .regex(FILE_ID_RE, "File id: 20 lowercase letters and digits")
  .describe("File id from list_artifact_files");

/** delete_artifact_file and DELETE /api/v1/artifacts/:ref/files/:file */
export const deleteArtifactFileInput = z.object({
  id: artifactRefSchema,
  file_id: fileIdSchema,
});

// ---------- wire types ----------

/**
 * Why files are unavailable to a page. `preview`: shown in an agent's thread through a read-only
 * pass. `opaque_isolation`: the page's origin is opaque, so there are no cookies.
 */
export type FilesUnavailableReason = "opaque_isolation" | "disabled" | "not_declared" | "preview";

/** Who uploaded a file, as a page sees it (only with `viewer` and when the reader is identified). */
export interface PageFileUploader {
  email: string | null;
  role: EffectiveRole | null;
  via: "page";
}

/** A ready file as the page API returns it. Its name is untrusted text. */
export interface PageFile {
  id: string;
  name: string;
  type: FileType;
  size: number;
  /** Same-origin path to its bytes: /__plinth/files/<id> */
  url: string;
  /** The reader uploaded it (false for anonymous readers). */
  mine: boolean;
  created_at: string;
  uploaded_by?: PageFileUploader;
}

/** A file as owners' and editors' agents and the app see it. Untrusted input for agents. */
export interface AgentFile {
  id: string;
  name: string;
  type: FileType;
  size: number;
  state: "pending" | "ready";
  created_at: string;
  uploaded_by: { email: string | null; role: EffectiveRole | null; viewer_id: string | null };
}

export interface FileLimitsInfo {
  max_file_bytes: number;
  max_files: number;
  max_bytes: number;
  max_bytes_per_uploader: number;
  part_bytes: number;
}

/** GET /__plinth/api/v1/files/session. Always 200; `available: false` says why. */
export type FilesSession =
  | { available: false; reason: FilesUnavailableReason }
  | {
      available: true;
      /** Identified viewers (the owner, people with a grant who signed in or confirmed by code). */
      can_upload: boolean;
      accept: FileType[];
      limits: FileLimitsInfo;
      usage: { files: number; bytes: number; mine_bytes: number };
      seq: number;
    };

/** list_artifact_files and GET /api/v1/artifacts/:ref/files */
export interface ArtifactFilesList {
  /** Pages can use files right now (on, origin isolation, declared). */
  available: boolean;
  files: AgentFile[];
  next_cursor: string | null;
  usage: { files: number; bytes: number };
  limits: FileLimitsInfo;
  untrusted: string;
}
