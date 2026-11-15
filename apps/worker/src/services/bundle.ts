// The bounded tar reader behind POST /uploads/:id/bundle (docs/spec.md, out-of-band uploads). It
// streams one archive, optionally gzip (detected by its magic bytes), and yields one regular file at
// a time as {path, bytes}, so memory is bounded by the largest file, never by the archive.
//
// Every bound is enforced while streaming, before anything is allocated: raw bytes on the wire,
// inflated bytes (a gzip bomb stops at the cap), each file's declared size, the version's total
// and the number of files. Headers are checksummed; links, devices, sparse files and unknown
// typeflags are refused by name; the pax and GNU long-name records before one entry are capped at
// LIMITS.maxTarMetaBytes in total before they are buffered, and only pax `path` and `size` are
// kept; every path is validated after the ustar prefix, pax `path` and GNU `L` overrides are
// applied. Dotfiles are skipped and listed. The archive's one top directory is
// stripped only when every kept file is inside it and it holds the source file.
import { ASSET_PATH_RE, LIMITS } from "@plinth/shared";
import { ApiError } from "../lib/errors.ts";

export interface BundleBounds {
  /** Bytes on the wire (maxBundleBytes(config)). */
  maxRawBytes: number;
  /** Bytes of tar after gzip is inflated: headers, padding and data. */
  maxInflatedBytes: number;
  /** Bytes of kept files in total (config.maxVersionBytes). */
  maxTotalBytes: number;
  /** Bytes of one file (LIMITS.maxBundleFileBytes). */
  maxFileBytes: number;
  /** Kept files (config.maxAssetsPerVersion + 1 for the source). */
  maxEntries: number;
  /** The pax records and GNU long names before one entry, in total (LIMITS.maxTarMetaBytes). */
  maxMetaBytes?: number;
  /** The target type's source file ("index.html" or "content.md"), for the prefix strip. */
  sourcePath: string;
  /**
   * Awaited with a file's size just before its bytes are allocated: the stager's back-pressure
   * (Stager.reserve), so the next file is not read while the in-flight budget is full.
   */
  reserve?: (size: number) => Promise<void>;
}

export interface BundleEntry {
  /** The path as archived (leading "./" removed); the strip is applied later by the stager. */
  path: string;
  bytes: Uint8Array;
}

export interface BundleSummary {
  /** Files yielded. */
  entries: number;
  /** Dotfiles left out, at most MAX_SKIPPED names. */
  skipped: string[];
  /** "dist/" when every kept file was under that one directory; null otherwise. */
  strippedPrefix: string | null;
}

export interface BundleReader extends AsyncIterable<BundleEntry> {
  /** Complete once iteration has finished without an error. */
  readonly summary: BundleSummary;
}

const BLOCK = 512;
const MAX_SKIPPED = 50;
const MAX_BAD_PATHS = 20;
const ECHO_CHARS = 200;

const SEND_TAR_NEXT =
  "Send a tar or a gzip tar of the build folder: cd <folder> && tar -cf - . | gzip -c | curl ... " +
  "(the commands.curl from start_upload)";
const LINK_NEXT = "Copy the specific files the page needs into the build folder";

/** Archived text echoed back (paths, names): control characters escaped, at most 200 characters. */
export function echo(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point
  const escaped = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return escaped.length > ECHO_CHARS ? `${escaped.slice(0, ECHO_CHARS)}…` : escaped;
}

const MB = 1024 * 1024;
const mb = (n: number) => `${Math.round((n / MB) * 10) / 10} MB`;

function invalid(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError("invalid_input", message, { next: SEND_TAR_NEXT, ...details });
}

function rawTooLarge(limit: number): ApiError {
  return new ApiError("payload_too_large", `The bundle is over ${mb(limit)} on the wire`, {
    limit_bytes: limit,
    next: "Leave out source maps (*.map) and files the page does not load, and gzip the tar (tar -cf - . | gzip -c)",
  });
}

function inflatedTooLarge(limit: number): ApiError {
  return new ApiError("payload_too_large", `The bundle inflates to over ${mb(limit)}`, {
    limit_bytes: limit,
    next: "Leave out source maps (*.map) and files the page does not load",
  });
}

// ---------- the byte stream: raw cap, gzip detection, inflated cap ----------

interface RawState {
  rawExceeded: boolean;
}

/**
 * The tar byte stream of a request body: the raw bytes counted against the wire cap and, when the
 * first two bytes are gzip's magic number, inflated through DecompressionStream (gunzip below).
 */
async function tarStream(
  body: ReadableStream<Uint8Array>,
  maxRaw: number,
  state: RawState,
): Promise<{ stream: ReadableStream<Uint8Array>; gzip: boolean; empty: boolean }> {
  const raw = body.getReader();
  let rawBytes = 0;
  const head: Uint8Array[] = [];
  let headLength = 0;
  let ended = false;
  const count = (chunk: Uint8Array) => {
    rawBytes += chunk.byteLength;
    if (rawBytes > maxRaw) {
      state.rawExceeded = true;
      raw.cancel().catch(() => undefined);
      throw rawTooLarge(maxRaw);
    }
  };
  while (headLength < 2) {
    const r = await raw.read();
    if (r.done) {
      ended = true;
      break;
    }
    const chunk = toBytes(r.value);
    count(chunk);
    head.push(chunk);
    headLength += chunk.byteLength;
  }
  const first = concat(head, headLength);
  const gzip = first[0] === 0x1f && first[1] === 0x8b;
  const counted = new ReadableStream<Uint8Array>({
    start(c) {
      if (first.byteLength > 0) c.enqueue(first);
      if (ended) c.close();
    },
    async pull(c) {
      const r = await raw.read();
      if (r.done) {
        c.close();
        return;
      }
      const chunk = toBytes(r.value);
      try {
        count(chunk);
      } catch (e) {
        c.error(e);
        return;
      }
      c.enqueue(chunk);
    },
    cancel(reason) {
      return raw.cancel(reason);
    },
  });
  const stream = gzip ? gunzip(counted) : counted;
  return { stream: stream as ReadableStream<Uint8Array>, gzip, empty: headLength === 0 };
}

/** The smallest and largest compressed slice written to the decompressor at once. */
const MIN_SLICE = 1024;
const MAX_SLICE = 8 * 1024;
/** Inflated bytes one write aims for: the slice shrinks as the data compresses better. */
const TARGET_OUT = 1024 * 1024;
const IDLE_MS = 25;
/**
 * Microtask turns a slice's output gets to show up after its write resolves. workerd fulfils a
 * pending read during the write, so it is readable within one; a timer turn (about 1 ms in
 * workerd) per slice would cap inflation near 3 MB/s.
 */
const OUTPUT_TURNS = 8;
/** The decompressor is read into a buffer this big: a read that does not fill it took all there was. */
const OUT_CHUNK = 256 * 1024;
const ZEROS = new Uint8Array(MAX_SLICE);
const TICK = Symbol("tick");
const IDLE = Symbol("idle");

async function turns(n: number): Promise<symbol> {
  for (let i = 0; i < n; i++) await undefined;
  return TICK;
}

/** `p` if it settles within a few microtask turns, else TICK. */
function soon<T>(p: Promise<T>): Promise<T | symbol> {
  return Promise.race([p, turns(OUTPUT_TURNS)]);
}

/** `p`, or `tag` once `ms` have passed (a timer turn, so output already queued wins). */
function within<T>(p: Promise<T>, ms: number, tag: symbol): Promise<T | symbol> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<symbol>((ok) => {
      timer = setTimeout(() => ok(tag), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Inflate one gzip member, driven by the reader. workerd's DecompressionStream accepts every write
 * at once and queues all of its output whether or not anyone reads it, so the compressed body is
 * fed one small slice at a time, and only when the reader wants bytes and the output of the
 * slices before has been read. What sits inflated and unread is then about one slice's output
 * (TARGET_OUT, at most MAX_SLICE x 1032, about 8.4 MB, for the first slice after the data starts
 * compressing better), however small the body or slow the reader. "Has been read" needs no
 * timer in the common case: the decompressor is read BYOB into an OUT_CHUNK buffer, and a read
 * that does not fill it has taken everything queued, while a slice's output fulfils the pending
 * read within a few microtask turns of its write. A timer turn is waited only after a read that
 * filled the buffer (more may be queued, and it arrives on the event loop, not in microtasks), or
 * after a MAX_SLICE of input with no output at all (output that lags, or a run of empty blocks),
 * so output that lags cannot let the feed run ahead by more than one more slice.
 *
 * It tolerates NUL padding after the member. bsdtar (macOS tar) pads `tar -czf -` to a
 * 10240-byte record when it writes to a pipe, and the decompressor errors on any byte after the
 * gzip trailer, discarding output not yet read. So a trailing run of zero bytes is held back: it
 * is fed only when more bytes follow it. The tar reader normally stops at its end-of-archive
 * block before the held run matters. When it needs more once everything else has been inflated,
 * the held zeros that end the trailer are those whose ISIZE (the trailer's last four bytes)
 * equals the inflated length; they are fed and the decompressor is closed, so its CRC check
 * still runs. The rest of the run is padding and is dropped.
 */
function gunzip(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const out = ds.readable.getReader({ mode: "byob" });
  let buf = new Uint8Array(OUT_CHUNK);
  /** The last read filled `buf`, so more output may be queued. */
  let maybeMore = false;
  const input = src.getReader();
  /** Compressed bytes read from the body and not yet fed: `zerosBefore` zero bytes, then `data`. */
  let data: Uint8Array = new Uint8Array(0);
  let zerosBefore = 0;
  /** A trailing zero run, fed only once data follows it. */
  let held = 0;
  let inputDone = false;
  let closing = false;
  const tail: number[] = [];
  let inflated = 0;
  let slice = MIN_SLICE;
  let sliceFed = 0;
  let outSinceFeed = 0;
  /** Compressed bytes fed since output was last read. */
  let fedSinceOut = 0;
  let read: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  // The last eight bytes fed: the trailer's candidates come from them.
  const noteTail = (bytes: Uint8Array) => {
    for (const b of bytes.subarray(Math.max(0, bytes.byteLength - 8))) tail.push(b);
    if (tail.length > 8) tail.splice(0, tail.length - 8);
  };

  /** Feed one slice; false when the body has ended and only held zeros (if any) are left. */
  const feedOne = async (): Promise<boolean> => {
    while (zerosBefore === 0 && data.byteLength === 0) {
      if (inputDone) return false;
      const r = await input.read();
      if (r.done) {
        inputDone = true;
        return false;
      }
      const chunk = toBytes(r.value);
      let end = chunk.byteLength;
      while (end > 0 && chunk[end - 1] === 0) end--;
      if (end === 0) {
        held += chunk.byteLength;
        continue;
      }
      zerosBefore = held;
      held = chunk.byteLength - end;
      data = chunk.subarray(0, end);
    }
    // Size the slice from the last one's yield, so one write inflates to about TARGET_OUT.
    if (sliceFed > 0) {
      const ratio = Math.max(1, outSinceFeed / sliceFed);
      slice = Math.min(MAX_SLICE, Math.max(MIN_SLICE, Math.floor(TARGET_OUT / ratio)));
    }
    let bytes: Uint8Array;
    if (zerosBefore > 0) {
      bytes = ZEROS.subarray(0, Math.min(zerosBefore, slice));
      zerosBefore -= bytes.byteLength;
    } else {
      bytes = data.subarray(0, slice);
      data = data.subarray(bytes.byteLength);
    }
    sliceFed = bytes.byteLength;
    fedSinceOut += bytes.byteLength;
    outSinceFeed = 0;
    maybeMore = false;
    await writer.write(bytes);
    noteTail(bytes);
    return true;
  };

  /** Feed the held zeros that complete the trailer, then close (an unmatched trailer errors). */
  const closeHeld = () => {
    closing = true;
    for (let j = 0; j <= Math.min(held, 8); j++) {
      const t = [...tail, ...new Array<number>(j).fill(0)].slice(-8);
      if (t.length < 8) continue;
      const isize =
        ((t[4] ?? 0) | ((t[5] ?? 0) << 8) | ((t[6] ?? 0) << 16) | ((t[7] ?? 0) << 24)) >>> 0;
      if (isize === inflated % 2 ** 32) {
        (j > 0 ? writer.write(ZEROS.subarray(0, j)) : Promise.resolve())
          .then(() => writer.close())
          .catch(() => undefined);
        return;
      }
    }
    writer.close().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        for (;;) {
          read ??= out.read(buf);
          // Output already inflated comes first; only once there is none is another slice fed.
          let r = closing ? await read : await soon(read);
          if (r === TICK && (maybeMore || fedSinceOut >= MAX_SLICE)) {
            r = await within(read, 0, TICK);
          }
          if (r === TICK) {
            let more: boolean;
            try {
              more = await feedOne();
            } catch (e) {
              await writer.abort(e).catch(() => undefined);
              throw e;
            }
            if (more) continue;
            if (held === 0) {
              closing = true;
              writer.close().catch(() => undefined);
              continue;
            }
            // Everything but the held zeros is fed; output still queued arrives well within
            // IDLE_MS. Past that, the decompressor has nothing more to give without its trailer.
            r = await within(read, IDLE_MS, IDLE);
            if (r === IDLE) {
              closeHeld();
              continue;
            }
          }
          read = null;
          const res = r as ReadableStreamReadResult<Uint8Array>;
          if (res.done) {
            c.close();
            return;
          }
          const n = res.value.byteLength;
          // The read transferred `buf`: copy the bytes out and read into it again.
          const chunk = res.value.slice();
          buf = new Uint8Array(res.value.buffer);
          maybeMore = n === buf.byteLength;
          inflated += n;
          outSinceFeed += n;
          fedSinceOut = 0;
          c.enqueue(chunk);
          return;
        }
      },
      async cancel(reason) {
        await Promise.allSettled([input.cancel(reason), out.cancel(reason), writer.abort(reason)]);
      },
    },
    { highWaterMark: 0 },
  );
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw invalid("The request body is not binary data");
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Pulls exact byte counts out of a chunked stream, counting inflated bytes against their cap. */
class ByteSource {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private done = false;
  private total = 0;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly maxInflated: number,
    private readonly gzip: boolean,
    private readonly raw: RawState,
    private readonly rawLimit: number,
  ) {
    this.reader = stream.getReader();
  }

  /** Make bytes available; false at the end of the stream. */
  private async fill(): Promise<boolean> {
    while (this.offset >= this.chunk.byteLength) {
      if (this.done) return false;
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await this.reader.read();
      } catch (e) {
        if (this.raw.rawExceeded) throw rawTooLarge(this.rawLimit);
        if (e instanceof ApiError) throw e;
        throw this.gzip
          ? invalid("The gzip data is corrupt or truncated")
          : invalid("The request body could not be read");
      }
      if (r.done) {
        this.done = true;
        return false;
      }
      this.chunk = toBytes(r.value);
      this.offset = 0;
      this.total += this.chunk.byteLength;
      if (this.total > this.maxInflated) throw inflatedTooLarge(this.maxInflated);
    }
    return true;
  }

  /** Fill `dst` completely; returns the bytes read (fewer only at the end of the stream). */
  async readInto(dst: Uint8Array): Promise<number> {
    let n = 0;
    while (n < dst.byteLength) {
      if (!(await this.fill())) break;
      const take = Math.min(dst.byteLength - n, this.chunk.byteLength - this.offset);
      dst.set(this.chunk.subarray(this.offset, this.offset + take), n);
      this.offset += take;
      n += take;
    }
    return n;
  }

  /** Discard `count` bytes; returns the bytes discarded (fewer only at the end of the stream). */
  async skip(count: number): Promise<number> {
    let n = 0;
    while (n < count) {
      if (!(await this.fill())) break;
      const take = Math.min(count - n, this.chunk.byteLength - this.offset);
      this.offset += take;
      n += take;
    }
    return n;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

// ---------- headers ----------

const decoder = new TextDecoder();

/** A NUL-terminated string field. */
function field(h: Uint8Array, start: number, length: number): string {
  const f = h.subarray(start, start + length);
  const end = f.indexOf(0);
  return decoder.decode(end === -1 ? f : f.subarray(0, end));
}

/**
 * A numeric field: octal ASCII (leading spaces, then digits, then NULs or spaces) or GNU base-256
 * (high bit set). Returns null for anything else, a negative number or one past 2^53.
 */
export function parseNumeric(f: Uint8Array): number | null {
  const lead = f[0] ?? 0;
  if (lead & 0x80) {
    // Base-256, two's complement: 0xff in the first byte means negative.
    if (lead === 0xff) return null;
    let v = lead & 0x7f;
    for (let i = 1; i < f.byteLength; i++) {
      v = v * 256 + (f[i] ?? 0);
      if (v > Number.MAX_SAFE_INTEGER) return null;
    }
    return v;
  }
  let i = 0;
  while (i < f.byteLength && f[i] === 0x20) i++;
  let v = 0;
  let digits = 0;
  while (i < f.byteLength) {
    const b = f[i] ?? 0;
    if (b < 0x30 || b > 0x37) break;
    v = v * 8 + (b - 0x30);
    digits++;
    i++;
  }
  if (digits === 0) return null;
  for (; i < f.byteLength; i++) {
    if (f[i] !== 0 && f[i] !== 0x20) return null;
  }
  return v <= Number.MAX_SAFE_INTEGER ? v : null;
}

function isZeroBlock(h: Uint8Array): boolean {
  for (let i = 0; i < h.byteLength; i++) if (h[i] !== 0) return false;
  return true;
}

/** The header checksum: the stored value must match the unsigned (or historic signed) sum. */
function checksumOk(h: Uint8Array): boolean {
  const stored = parseNumeric(h.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

const REGULAR = new Set(["0", "\0", "7"]);
const REFUSED: Record<string, string> = {
  "1": "a hard link",
  "2": "a symbolic link",
  "3": "a character device",
  "4": "a block device",
  "6": "a FIFO",
  K: "a GNU long link name",
  S: "a GNU sparse file",
  V: "a GNU volume header",
  M: "a GNU multi-volume continuation",
};

/** The pax records of one extended header: "<len> <key>=<value>\n", repeated. */
export function parsePax(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.byteLength) {
    // Trailing NULs pad some writers' records; nothing after them counts.
    if (body[i] === 0) break;
    let j = i;
    let length = 0;
    while (j < body.byteLength && (body[j] ?? 0) >= 0x30 && (body[j] ?? 0) <= 0x39) {
      length = length * 10 + ((body[j] ?? 0) - 0x30);
      if (length > body.byteLength) throw invalid("A pax header in the bundle is malformed");
      j++;
    }
    const end = i + length;
    if (j === i || body[j] !== 0x20 || end > body.byteLength || end <= j + 1) {
      throw invalid("A pax header in the bundle is malformed");
    }
    if (body[end - 1] !== 0x0a) throw invalid("A pax header in the bundle is malformed");
    const record = decoder.decode(body.subarray(j + 1, end - 1));
    const eq = record.indexOf("=");
    if (eq <= 0) throw invalid("A pax header in the bundle is malformed");
    out.set(record.slice(0, eq), record.slice(eq + 1));
    i = end;
  }
  return out;
}

// ---------- paths ----------

export type PathReason =
  | "absolute"
  | "parent_segment"
  | "dot_segment"
  | "reserved"
  | "too_long"
  | "invalid";

/** An absolute path or a "." or ".." segment. */
function structuralProblem(p: string): PathReason | null {
  if (p.startsWith("/")) return "absolute";
  const segments = p.split("/");
  if (segments.includes("..")) return "parent_segment";
  if (segments.includes(".")) return "dot_segment";
  return null;
}

/** Why a final path cannot be stored, or null when it can. */
export function pathProblem(p: string): PathReason | null {
  const structural = structuralProblem(p);
  if (structural) return structural;
  if (p.length > LIMITS.maxAssetPathLength) return "too_long";
  if (p.startsWith("__plinth/")) return "reserved";
  if (!ASSET_PATH_RE.test(p)) return "invalid";
  return null;
}

/** A segment starting with "." (not "." or ".."): .DS_Store, ._x, .git. */
function isDotfile(p: string): boolean {
  return p.split("/").some((s) => s.startsWith(".") && s !== "." && s !== "..");
}

/** Remove leading "./" (as `tar -cf - .` writes) and trailing "/". "" is the archive root. */
function normalize(name: string): string {
  let p = name;
  while (p.startsWith("./")) p = p.slice(2);
  if (p === ".") return "";
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// ---------- the reader ----------

/** Read a bundle. Iterate it once; `summary` is complete when iteration ends without an error. */
export function readBundle(body: ReadableStream<Uint8Array>, bounds: BundleBounds): BundleReader {
  const summary: BundleSummary = { entries: 0, skipped: [], strippedPrefix: null };
  return {
    summary,
    [Symbol.asyncIterator]: () => entries(body, bounds, summary),
  };
}

async function* entries(
  body: ReadableStream<Uint8Array>,
  bounds: BundleBounds,
  summary: BundleSummary,
): AsyncGenerator<BundleEntry> {
  const maxMeta = bounds.maxMetaBytes ?? LIMITS.maxTarMetaBytes;
  const rawState: RawState = { rawExceeded: false };
  const opened = await tarStream(body, bounds.maxRawBytes, rawState);
  if (opened.empty) throw invalid("The request body is empty");
  const src = new ByteSource(
    opened.stream,
    bounds.maxInflatedBytes,
    opened.gzip,
    rawState,
    bounds.maxRawBytes,
  );
  const kept = new Set<string>();
  const bad: { path: string; reason: PathReason }[] = [];
  let badCount = 0;
  let total = 0;
  const largest: { path: string; size_bytes: number }[] = [];
  // Pending extended-header state for the next entry: only the two pax keys the reader uses, and
  // the bytes of every x, g and L record since the last entry (capped at maxMeta in total, so a
  // run of extended headers can never build up state).
  let paxPath: string | undefined;
  let paxSize: string | undefined;
  let longName: string | null = null;
  let metaBytes = 0;
  let index = 0;

  const header = new Uint8Array(BLOCK);
  try {
    for (; ; index++) {
      const got = await src.readInto(header);
      if (got === 0) break; // EOF at a block boundary: accepted as the end.
      if (got < BLOCK) throw invalid("The bundle ends in the middle of a tar header");
      if (isZeroBlock(header)) break; // End-of-archive. Anything after it is never read.
      if (!checksumOk(header)) {
        if (index === 0) {
          const zip = header[0] === 0x50 && header[1] === 0x4b;
          throw invalid(
            zip ? "The body is a zip archive, not a tar" : "The body is not a tar archive",
          );
        }
        throw invalid(`The bundle has a corrupt tar header (entry ${index + 1})`);
      }
      const flag = String.fromCharCode(header[156] ?? 0);
      const declared = parseNumeric(header.subarray(124, 136));
      if (declared === null) {
        throw invalid(`A tar header in the bundle has an invalid size (entry ${index + 1})`);
      }

      // Extended headers apply to the next entry.
      if (flag === "x" || flag === "g" || flag === "L") {
        if (declared > maxMeta) {
          throw invalid(
            `A ${flag === "L" ? "GNU long name" : "pax header"} in the bundle is over ${maxMeta / 1024} KB`,
            { limit_bytes: maxMeta },
          );
        }
        metaBytes += declared;
        if (metaBytes > maxMeta) {
          throw invalid(
            `The extended headers before one entry in the bundle are over ${maxMeta / 1024} KB in total (entry ${index + 1})`,
            { limit_bytes: maxMeta },
          );
        }
        const meta = new Uint8Array(declared);
        if ((await src.readInto(meta)) < declared) {
          throw invalid("The bundle ends in the middle of an entry");
        }
        await skipPadding(src, declared);
        if (flag === "x") {
          const records = parsePax(meta);
          for (const key of records.keys()) {
            if (key.startsWith("GNU.sparse.")) {
              throw invalid("The bundle contains a sparse file; archive it as a regular file");
            }
          }
          paxPath = records.get("path") ?? paxPath;
          paxSize = records.get("size") ?? paxSize;
        } else if (flag === "L") {
          const end = meta.indexOf(0);
          longName = decoder.decode(end === -1 ? meta : meta.subarray(0, end));
        }
        continue;
      }

      const ustar = field(header, 257, 6) === "ustar" && header[262] === 0;
      const prefix = ustar ? field(header, 345, 155) : "";
      const plain = field(header, 0, 100);
      const archived = paxPath ?? longName ?? (prefix ? `${prefix}/${plain}` : plain);
      let size = declared;
      if (paxSize !== undefined) {
        if (!/^\d{1,16}$/.test(paxSize) || Number(paxSize) > Number.MAX_SAFE_INTEGER) {
          throw invalid(`A pax header in the bundle has an invalid size (${echo(archived)})`);
        }
        size = Number(paxSize);
      }
      paxPath = undefined;
      paxSize = undefined;
      longName = null;
      metaBytes = 0;

      const refused = REFUSED[flag];
      if (refused || (!REGULAR.has(flag) && flag !== "5")) {
        const what = refused ?? `an entry of unknown type "${echo(flag)}"`;
        throw new ApiError(
          "invalid_input",
          `${echo(archived)} is ${what}; bundles hold regular files only`,
          {
            path: echo(archived),
            next: flag === "1" || flag === "2" ? LINK_NEXT : SEND_TAR_NEXT,
          },
        );
      }
      const isDir = flag === "5" || (REGULAR.has(flag) && archived.endsWith("/"));
      if (isDir) {
        // Directories carry no data that matters; skip whatever they declare.
        await skipData(src, size);
        continue;
      }

      const path = normalize(archived);
      // Traversal is refused before anything else; then dotfiles are skipped, whatever their
      // characters; then the remaining path rules apply.
      const structural = archived.startsWith("/") ? "absolute" : structuralProblem(path);
      if (!structural && path !== "" && isDotfile(path)) {
        if (summary.skipped.length < MAX_SKIPPED) summary.skipped.push(echo(path));
        await skipData(src, size);
        continue;
      }
      const problem = path === "" ? "invalid" : (structural ?? pathProblem(path));
      if (problem) {
        badCount++;
        if (bad.length < MAX_BAD_PATHS) bad.push({ path: echo(archived), reason: problem });
        await skipData(src, size);
        continue;
      }
      if (kept.has(path)) {
        throw new ApiError("invalid_input", `${echo(path)} appears twice in the bundle`, {
          path: echo(path),
          next: "Archive each file once",
        });
      }
      // Bounds, all checked against the declared size before a byte is allocated.
      if (kept.size + 1 > bounds.maxEntries) {
        // maxEntries counts the source too, so this many fewer files fit.
        const drop = kept.size + 1 - bounds.maxEntries;
        throw new ApiError(
          "payload_too_large",
          `The bundle has at least ${kept.size + 1} files; this instance allows ${bounds.maxEntries - 1} asset files per version`,
          {
            limit: bounds.maxEntries - 1,
            // The reader stops at the first file over the limit, so this is a lower bound.
            count: kept.size + 1,
            count_is_minimum: true,
            // The actionable part first: commands.curl already leaves out source maps.
            next:
              `Remove at least ${drop} file${drop === 1 ? "" : "s"} the page does not load ` +
              "(and source maps, if your tar command did not leave them out with tar --exclude='*.map' " +
              "as commands.curl does). " +
              "Never merge chunks to fit. The instance operator can raise " +
              `MAX_ASSETS_PER_VERSION (up to ${LIMITS.maxAssetsCeiling})`,
          },
        );
      }
      if (size > bounds.maxFileBytes) {
        throw new ApiError(
          "payload_too_large",
          `${echo(path)} is over ${mb(bounds.maxFileBytes)} (${mb(size)})`,
          {
            path: echo(path),
            limit_bytes: bounds.maxFileBytes,
            size_bytes: size,
            next: "Split or compress this file",
          },
        );
      }
      noteLargest(largest, path, size);
      if (total + size > bounds.maxTotalBytes) {
        throw new ApiError(
          "payload_too_large",
          `Version is over ${mb(bounds.maxTotalBytes)} in total (${mb(total + size)} so far)`,
          {
            limit_bytes: bounds.maxTotalBytes,
            size_bytes: total + size,
            largest: largest.map((l) => ({ path: echo(l.path), size_bytes: l.size_bytes })),
            next: "Leave out source maps (*.map) and files the page does not load. Never merge chunks to fit",
          },
        );
      }
      kept.add(path);
      if (badCount > 0) {
        // The bundle is refused anyway; keep reading only to name every bad path.
        await skipData(src, size);
        continue;
      }
      total += size;
      if (bounds.reserve) await bounds.reserve(size);
      const bytes = new Uint8Array(size);
      if ((await src.readInto(bytes)) < size) {
        throw invalid(`The bundle ends in the middle of ${echo(path)}`);
      }
      await skipPadding(src, size);
      summary.entries++;
      yield { path, bytes };
    }

    if (badCount > 0) throw badPaths(bad, badCount);
    summary.strippedPrefix = stripPrefixFor(kept, bounds.sourcePath);
  } finally {
    await src.cancel();
  }
}

async function skipPadding(src: ByteSource, size: number): Promise<void> {
  const pad = (BLOCK - (size % BLOCK)) % BLOCK;
  if (pad > 0 && (await src.skip(pad)) < pad) {
    throw invalid("The bundle ends in the middle of an entry");
  }
}

async function skipData(src: ByteSource, size: number): Promise<void> {
  if ((await src.skip(size)) < size) throw invalid("The bundle ends in the middle of an entry");
  await skipPadding(src, size);
}

function noteLargest(list: { path: string; size_bytes: number }[], path: string, size: number) {
  list.push({ path, size_bytes: size });
  list.sort((a, b) => b.size_bytes - a.size_bytes);
  if (list.length > 5) list.length = 5;
}

function badPaths(bad: { path: string; reason: PathReason }[], count: number): ApiError {
  return new ApiError(
    "invalid_input",
    count === 1
      ? "1 path in the bundle is not allowed"
      : `${count} paths in the bundle are not allowed`,
    {
      paths: bad,
      next:
        "Rename these files: relative paths of letters, digits, '.', '_', '-' and '/', at most " +
        `${LIMITS.maxAssetPathLength} characters, with no '.' or '..' segment and nothing under __plinth/`,
    },
  );
}

/**
 * The prefix to strip: null when the source file is at the root; "<dir>/" when every kept file is
 * under that one directory and it holds the source file. Anything else has no entry file.
 */
export function stripPrefixFor(kept: ReadonlySet<string>, sourcePath: string): string | null {
  if (kept.has(sourcePath)) return null;
  const noEntry = new ApiError("invalid_input", `The bundle has no ${sourcePath} at its top`, {
    reason: "no_entry_file",
    next: `Run tar from inside the build folder (the one with ${sourcePath} at its top)`,
  });
  let top: string | null = null;
  for (const p of kept) {
    const slash = p.indexOf("/");
    if (slash === -1) throw noEntry;
    const dir = p.slice(0, slash + 1);
    if (top === null) top = dir;
    else if (dir !== top) throw noEntry;
  }
  if (top === null || !kept.has(`${top}${sourcePath}`)) throw noEntry;
  const bad: { path: string; reason: PathReason }[] = [];
  let count = 0;
  for (const p of kept) {
    const problem = pathProblem(p.slice(top.length));
    if (problem) {
      count++;
      if (bad.length < MAX_BAD_PATHS)
        bad.push({ path: echo(p.slice(top.length)), reason: problem });
    }
  }
  if (count > 0) throw badPaths(bad, count);
  return top;
}
