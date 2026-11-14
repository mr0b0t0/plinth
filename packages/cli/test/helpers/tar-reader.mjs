// A small, strict tar reader for the tests, written independently of bin/client/tar.mjs: ustar
// headers with checksums, the prefix field, pax `path` records, regular files only, and the
// end-of-archive blocks. gzip is detected by its magic bytes.
import { gunzipSync } from "node:zlib";

const dec = new TextDecoder();

function field(buf, off, len) {
  const end = buf.indexOf(0, off);
  return dec.decode(buf.subarray(off, end >= 0 && end < off + len ? end : off + len));
}

function octal(buf, off, len) {
  const s = field(buf, off, len).trim();
  if (!/^[0-7]+$/.test(s)) throw new Error(`bad octal field: ${JSON.stringify(s)}`);
  return Number.parseInt(s, 8);
}

/** Entries [{path, bytes, typeflag}] of a tar or tar.gz. Throws on anything malformed. */
export function readTar(input) {
  let buf = Buffer.from(input);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const out = [];
  let off = 0;
  let paxPath = null;
  let ended = false;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      const next = buf.subarray(off + 512, off + 1024);
      if (next.length !== 512 || !next.every((b) => b === 0)) throw new Error("single zero block");
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error(`checksum mismatch at ${off}`);
    if (field(h, 257, 6) !== "ustar") throw new Error("not ustar");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (body.length !== size) throw new Error("truncated entry");
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const text = dec.decode(body);
      let i = 0;
      while (i < text.length) {
        const sp = text.indexOf(" ", i);
        const len = Number(text.slice(i, sp));
        const rec = text.slice(sp + 1, i + len - 1);
        const eq = rec.indexOf("=");
        if (Buffer.byteLength(text.slice(i, i + len)) !== len) throw new Error("bad pax length");
        if (rec.slice(0, eq) === "path") paxPath = rec.slice(eq + 1);
        i += len;
      }
      continue;
    }
    if (type !== "0") throw new Error(`unexpected typeflag ${type}`);
    const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    out.push({ path, bytes: Buffer.from(body), mode: octal(h, 100, 8), mtime: octal(h, 136, 12) });
  }
  if (!ended) throw new Error("no end-of-archive blocks");
  return out;
}
