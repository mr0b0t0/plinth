// A dependency-free ustar writer for the bundle the CLI sends to POST /uploads/:id/bundle. Regular
// files only (no links, no directories: the server ignores them), deterministic headers (mode 0644,
// mtime 0, no owner names), a pax `path` record when a path does not fit the ustar name and prefix
// fields, and the two zero blocks at the end. The stream is gzipped (zlib level 6); the server's
// limits apply to the uncompressed bytes.
import { readFileSync } from "node:fs";
import { pipeline, Readable } from "node:stream";
import { createGzip } from "node:zlib";

const BLOCK = 512;
const enc = new TextEncoder();

function writeString(buf, offset, length, value) {
  const bytes = enc.encode(value);
  if (bytes.length > length) throw new Error(`tar: field too long: ${value}`);
  buf.set(bytes, offset);
}

function writeOctal(buf, offset, length, value) {
  // length - 1 octal digits, then NUL.
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new Error(`tar: value too large: ${value}`);
  writeString(buf, offset, length - 1, digits.padStart(length - 1, "0"));
}

/** Split a path into the ustar prefix (<= 155 bytes) and name (<= 100 bytes), or null. */
export function splitUstarPath(p) {
  const bytes = enc.encode(p).length;
  if (bytes <= 100) return { prefix: "", name: p };
  for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name) {
      return { prefix, name };
    }
  }
  return null;
}

/** One 512-byte ustar header. */
export function ustarHeader({ name, prefix = "", size, typeflag = "0" }) {
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0);
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  writeString(h, 156, 1, typeflag);
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** A pax extended-header record: "<len> <key>=<value>\n", where len counts itself. */
export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).length;
  const digits = String(bodyLen).length;
  let len = bodyLen + digits;
  if (String(len).length > digits) len++;
  return enc.encode(`${len}${body}`);
}

const padding = (size) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The headers and padding for one file whose bytes follow; a pax header first when needed. */
export function* entryHeaders(p, size) {
  const split = splitUstarPath(p);
  if (split) {
    yield ustarHeader({ ...split, size });
    return;
  }
  const rec = paxRecord("path", p);
  yield ustarHeader({ name: "PaxHeader", size: rec.length, typeflag: "x" });
  yield rec;
  yield padding(rec.length);
  yield ustarHeader({ name: p.slice(-100).replace(/^\/+/, ""), size });
}

/**
 * The tar of `files` ([{path, abs, size}]), one file in memory at a time. A file whose size changed
 * since the walk is an error (the header already promised its size).
 */
export async function* tarChunks(files, read = (abs) => readFileSync(abs)) {
  for (const f of files) {
    const bytes = read(f.abs);
    if (bytes.length !== f.size) throw new Error(`${f.path} changed while it was being sent`);
    yield* entryHeaders(f.path, f.size);
    yield bytes;
    yield padding(f.size);
  }
  yield new Uint8Array(BLOCK * 2);
}

/** The gzipped tar as a Node stream (level 6), ready to be a fetch body. Errors end it. */
export function gzipTarStream(files, read) {
  return pipeline(Readable.from(tarChunks(files, read)), createGzip({ level: 6 }), () => {});
}
