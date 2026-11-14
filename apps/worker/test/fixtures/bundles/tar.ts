// A small tar writer for the bundle tests: ustar headers with every field the reader looks at
// (name, prefix, size, typeflag, magic, checksum), pax and GNU long-name records, gzip, and
// streams that arrive in awkward chunks or are generated lazily (so a 50 MB bundle never sits in
// the test's memory).

const enc = new TextEncoder();
export const BLOCK = 512;

export interface EntrySpec {
  name: string;
  data?: Uint8Array | string;
  /** Typeflag character; default "0". */
  type?: string;
  /** ustar prefix field (joined with name by "/"). */
  prefix?: string;
  /** "ustar" (POSIX, default), "gnu" ("ustar  \0") or "v7" (no magic). */
  magic?: "ustar" | "gnu" | "v7";
  /** The declared size (default: the data length); the data written stays `data`. */
  size?: number;
  /** A raw 12-byte size field, written as is. */
  sizeField?: Uint8Array;
  /** Corrupt the checksum. */
  badChecksum?: boolean;
  linkname?: string;
}

function put(h: Uint8Array, offset: number, length: number, value: string): void {
  const b = enc.encode(value);
  if (b.byteLength > length) throw new Error(`field too long: ${value}`);
  h.set(b, offset);
}

function octal(n: number, length: number): string {
  return `${n.toString(8).padStart(length - 1, "0")}\0`;
}

export function bytesOf(data: Uint8Array | string | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0);
  return typeof data === "string" ? enc.encode(data) : data;
}

/** One 512-byte header. */
export function header(spec: EntrySpec): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const data = bytesOf(spec.data);
  put(h, 0, 100, spec.name);
  put(h, 100, 8, octal(0o644, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  if (spec.sizeField) h.set(spec.sizeField.subarray(0, 12), 124);
  else put(h, 124, 12, octal(spec.size ?? data.byteLength, 12));
  put(h, 136, 12, octal(0, 12));
  put(h, 156, 1, spec.type ?? "0");
  if (spec.linkname) put(h, 157, 100, spec.linkname);
  const magic = spec.magic ?? "ustar";
  if (magic === "ustar") {
    put(h, 257, 6, "ustar\0");
    put(h, 263, 2, "00");
  } else if (magic === "gnu") {
    put(h, 257, 8, "ustar  \0");
  }
  if (spec.prefix) put(h, 345, 155, spec.prefix);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  if (spec.badChecksum) sum += 1;
  put(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

/** Header plus padded data. */
export function entry(spec: EntrySpec): Uint8Array {
  return concat([header(spec), padded(bytesOf(spec.data))]);
}

/** A pax extended header (typeflag x) with these records, applying to the next entry. */
export function paxEntry(records: Record<string, string>, type: "x" | "g" = "x"): Uint8Array {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = enc.encode(rest).byteLength + 1;
    while (String(len).length + enc.encode(rest).byteLength !== len) len++;
    body += `${len}${rest}`;
  }
  return entry({ name: "PaxHeaders/x", type, data: body });
}

/** A GNU long name (typeflag L) for the next entry. */
export function longNameEntry(name: string): Uint8Array {
  return entry({ name: "././@LongLink", type: "L", magic: "gnu", data: `${name}\0` });
}

/** Two zero blocks. */
export const END = new Uint8Array(2 * BLOCK);

export function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** A whole archive of regular files (or specs), ended by two zero blocks. */
export function tar(files: (EntrySpec | Uint8Array)[], opts: { end?: boolean } = {}): Uint8Array {
  const parts = files.map((f) => (f instanceof Uint8Array ? f : entry(f)));
  if (opts.end !== false) parts.push(END);
  return concat(parts);
}

/** A stream of these bytes in chunks of `chunk` bytes (odd sizes exercise every boundary). */
export function streamOf(bytes: Uint8Array, chunk = 997): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (o >= bytes.byteLength) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(o, o + chunk));
      o += chunk;
    },
  });
}

/** A stream made from an async generator of chunks, produced only as the reader pulls. */
export function lazyStream(gen: () => AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  const it = gen();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const r = await it.next();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = streamOf(bytes, 64 * 1024).pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function gzipStream(s: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return s.pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Deterministic filler bytes, so equal sizes never mean equal content by accident. */
export function filler(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed * 2654435761 + 1;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** A Vite-like build: index.html at the top, hashed chunks and assets under assets/. */
export function viteBuild(files: number, opts: { dir?: string } = {}): EntrySpec[] {
  const d = opts.dir ? `${opts.dir}/` : "";
  const out: EntrySpec[] = [
    {
      name: `${d}index.html`,
      data:
        '<!doctype html><html><head><title>Vite build</title><script type="module" crossorigin ' +
        'src="./assets/index-0.js"></script><link rel="stylesheet" href="./assets/index-0.css"></head>' +
        '<body><div id="app"></div></body></html>',
    },
  ];
  for (let i = 0; out.length < files; i++) {
    const kind = i % 3;
    const name = kind === 0 ? `index-${i}.js` : kind === 1 ? `index-${i}.css` : `logo-${i}.svg`;
    const data =
      kind === 0
        ? `export const v${i} = ${i};\n`
        : kind === 1
          ? `.c${i}{color:#${(i % 4096).toString(16).padStart(3, "0")}}\n`
          : `<svg xmlns="http://www.w3.org/2000/svg"><text>${i}</text></svg>`;
    out.push({ name: `${d}assets/${name}`, data });
  }
  return out;
}
