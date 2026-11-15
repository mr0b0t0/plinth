// The bounded tar reader (services/bundle.ts): formats real tars use, every refusal, and every
// streaming bound, including a lazily generated 50 MB bundle. These check what the reader counts
// and allocates, not heap use: workerd reports no heap figures and enforces no isolate limit in
// the pool. The structural memory bound (in-flight plus the next file) is in uploads.test.ts.
import { LIMITS } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/errors.ts";
import {
  type BundleBounds,
  echo,
  parseNumeric,
  parsePax,
  readBundle,
  stripPrefixFor,
} from "../src/services/bundle.ts";
import * as real from "./fixtures/bundles/real.ts";
import {
  BLOCK,
  concat,
  END,
  entry,
  filler,
  fromBase64,
  gzip,
  gzipStream,
  header,
  lazyStream,
  longNameEntry,
  paxEntry,
  streamOf,
  tar,
  viteBuild,
} from "./fixtures/bundles/tar.ts";

const MB = 1024 * 1024;
const LONG =
  "assets/a-directory-name-that-is-long-enough-to-push-paths-past-the-ustar-name-field/module-with-a-long-file-name-so-the-whole-path-is-long.js";

const BOUNDS: BundleBounds = {
  maxRawBytes: 58 * MB,
  maxInflatedBytes: 58 * MB,
  maxTotalBytes: 50 * MB,
  maxFileBytes: LIMITS.maxBundleFileBytes,
  maxEntries: 512,
  maxMetaBytes: LIMITS.maxTarMetaBytes,
  sourcePath: "index.html",
};

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function read(
  body: Uint8Array | ReadableStream<Uint8Array>,
  bounds: Partial<BundleBounds> = {},
) {
  const reader = readBundle(body instanceof Uint8Array ? streamOf(body) : body, {
    ...BOUNDS,
    ...bounds,
  });
  const files: { path: string; text: string; size: number }[] = [];
  for await (const e of reader)
    files.push({ path: e.path, text: text(e.bytes), size: e.bytes.byteLength });
  return { files, summary: reader.summary };
}

/** The ApiError a read throws. */
async function refusal(
  body: Uint8Array | ReadableStream<Uint8Array>,
  bounds: Partial<BundleBounds> = {},
): Promise<ApiError> {
  try {
    await read(body, bounds);
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the bundle to be refused");
}

const INDEX = entry({ name: "index.html", data: "<!doctype html><title>t</title>" });
const details = (e: ApiError) => e.details as Record<string, any>;
const site = [
  { name: "index.html", data: "<!doctype html><title>t</title>" },
  { name: "assets/app.js", data: "console.log(1)" },
];

describe("tar formats real archivers write", () => {
  it.each([
    ["ustar (long path split into the prefix field)", real.ustarTar],
    ["pax (path records)", real.paxTar],
    ["gnutar (L long names)", real.gnuTar],
  ])("reads bsdtar %s", async (_label, b64) => {
    const { files, summary } = await read(fromBase64(b64));
    expect(files.map((f) => f.path).sort()).toEqual(
      ["assets/app.js", "assets/style.css", LONG, "index.html"].sort(),
    );
    expect(files.find((f) => f.path === "assets/app.js")?.text).toBe('console.log("app");\n');
    expect(files.find((f) => f.path === LONG)?.text).toBe("export const deep = 1;\n");
    expect(summary).toEqual({ entries: 4, skipped: [".DS_Store"], strippedPrefix: null });
  });

  it("reads the gzip that `tar -czf - .` writes, detected by its magic bytes", async () => {
    const { files, summary } = await read(fromBase64(real.defaultTgz));
    expect(files.map((f) => f.path).sort()).toEqual(
      ["assets/app.js", "assets/style.css", LONG, "index.html"].sort(),
    );
    expect(summary.skipped).toEqual([".DS_Store"]);
  });

  it("reads what `tar -czf - .` writes to a pipe on macOS: gzip plus NUL padding", async () => {
    const body = fromBase64(real.stdoutTgz);
    expect(body.byteLength).toBe(10240);
    expect(body[body.byteLength - 1]).toBe(0);
    for (const chunk of [997, 10240, 1]) {
      const { files, summary } = await read(streamOf(body, chunk));
      expect(files.map((f) => f.path).sort()).toEqual(
        ["assets/app.js", "assets/style.css", LONG, "index.html"].sort(),
      );
      expect(summary.skipped).toEqual([".DS_Store"]);
    }
  });

  it("reads a padded gzip of a tar that ends at EOF, without end-of-archive blocks", async () => {
    // The reader needs the stream's end here, so the held zeros that finish the trailer are fed
    // and the decompressor closes (CRC and ISIZE checked); the rest of the padding is dropped.
    for (const n of [1, 300, 4000]) {
      const member = await gzip(
        tar([...site, { name: `f${n}.js`, data: filler(n, n) }], { end: false }),
      );
      const { files } = await read(
        concat([member, new Uint8Array(10240 - (member.byteLength % 10240))]),
      );
      expect(files.map((f) => f.path)).toEqual(["index.html", "assets/app.js", `f${n}.js`]);
    }
  });

  it("feeds zero runs that more data follows, wherever chunks split the gzip", async () => {
    // Deflate output is full of zero bytes; a run held back at a chunk's end must be fed once the
    // next chunk arrives, or the inflated bytes would be wrong.
    const zeroy = new Uint8Array(70_000);
    for (let i = 0; i < zeroy.byteLength; i += 509) zeroy[i] = i % 251;
    const body = await gzip(tar([...site, { name: "z.bin", data: zeroy }]));
    for (const chunk of [3, 64, 4096]) {
      const reader = readBundle(streamOf(body, chunk), BOUNDS);
      const got: Uint8Array[] = [];
      for await (const e of reader) if (e.path === "z.bin") got.push(e.bytes);
      expect(got[0]).toEqual(zeroy);
    }
  });

  it("still refuses a padded gzip whose trailer does not match", async () => {
    const member = await gzip(tar(site, { end: false }));
    member[member.byteLength - 6] = (member[member.byteLength - 6] ?? 0) ^ 0xff; // a CRC byte
    const e = await refusal(concat([member, new Uint8Array(5000)]));
    expect(e.message).toBe("The gzip data is corrupt or truncated");
    const cut = await gzip(tar(site, { end: false }));
    const e2 = await refusal(concat([cut.subarray(0, cut.byteLength - 12), new Uint8Array(64)]));
    expect(e2.message).toBe("The gzip data is corrupt or truncated");
  });

  it("strips the one top directory of `tar -czf - dist`", async () => {
    const { files, summary } = await read(fromBase64(real.distTgz));
    expect(files.map((f) => f.path)).toContain("dist/index.html");
    expect(summary.strippedPrefix).toBe("dist/");
    expect(summary.skipped).toEqual(["dist/.DS_Store"]);
  });

  it("joins a synthetic ustar prefix, applies pax path and size, and GNU L names", async () => {
    const body = tar([
      ...site,
      { name: "file.js", prefix: "assets/from-prefix", data: "p" },
      paxEntry({ path: "assets/from-pax.js" }),
      { name: "ignored-name.js", data: "x" },
      // pax size overrides the header's size field
      paxEntry({ size: "3" }),
      { name: "assets/sized.js", size: 99, data: "abc" },
      longNameEntry(`assets/${"l".repeat(150)}.js`),
      { name: "truncated-header-name", data: "L" },
    ]);
    const { files } = await read(body);
    expect(files.map((f) => [f.path, f.text])).toEqual([
      ["index.html", "<!doctype html><title>t</title>"],
      ["assets/app.js", "console.log(1)"],
      ["assets/from-prefix/file.js", "p"],
      ["assets/from-pax.js", "x"],
      ["assets/sized.js", "abc"],
      [`assets/${"l".repeat(150)}.js`, "L"],
    ]);
  });

  it("does not join the prefix field of GNU or v7 headers (it holds other data there)", async () => {
    const body = tar([
      ...site,
      { name: "gnu.js", prefix: "not-a-prefix", magic: "gnu", data: "g" },
      { name: "v7.js", prefix: "not-a-prefix", magic: "v7", data: "v" },
    ]);
    const { files } = await read(body);
    expect(files.map((f) => f.path)).toEqual(["index.html", "assets/app.js", "gnu.js", "v7.js"]);
  });

  it("ignores pax global headers and unknown pax keys", async () => {
    const body = tar([
      paxEntry({ comment: "global" }, "g"),
      paxEntry({ "SCHILY.xattr.com.apple.provenance": "x", mtime: "1.5" }),
      ...site,
    ]);
    const { files } = await read(body);
    expect(files.map((f) => f.path)).toEqual(["index.html", "assets/app.js"]);
  });

  it("treats a regular entry whose name ends in / as a directory, and skips directories", async () => {
    const body = tar([{ name: "./", type: "5" }, { name: "assets/", type: "0" }, ...site]);
    const { files, summary } = await read(body);
    expect(files.map((f) => f.path)).toEqual(["index.html", "assets/app.js"]);
    expect(summary.entries).toBe(2);
  });

  it("skips dotfiles (.DS_Store, ._*, .git) and lists them", async () => {
    const body = tar([
      ...site,
      { name: "./.DS_Store", data: "x" },
      { name: "assets/._app.js", data: "x" },
      { name: ".git/config", data: "x" },
      { name: ".well-known/~odd#name", data: "x" },
    ]);
    const { files, summary } = await read(body);
    expect(files.map((f) => f.path)).toEqual(["index.html", "assets/app.js"]);
    expect(summary.skipped).toEqual([
      ".DS_Store",
      "assets/._app.js",
      ".git/config",
      ".well-known/~odd#name",
    ]);
  });

  it("caps the skipped list at 50 names", async () => {
    const dots = Array.from({ length: 60 }, (_, i) => ({ name: `.d${i}`, data: "x" }));
    const { summary } = await read(tar([...site, ...dots]));
    expect(summary.skipped).toHaveLength(50);
  });

  it("accepts EOF at a block boundary without end-of-archive blocks", async () => {
    const { files } = await read(tar(site, { end: false }));
    expect(files).toHaveLength(2);
  });

  it("stops at end-of-archive: junk after it is never read and the stream is cancelled", async () => {
    let pulls = 0;
    let cancelled = false;
    const head = tar(site);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head);
      },
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024).fill(0x41)); // "AAAA...": not a tar header
      },
      cancel() {
        cancelled = true;
      },
    });
    const { files } = await read(body);
    expect(files).toHaveLength(2);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(3);
  });
});

describe("refusals", () => {
  it("refuses a body that is not a tar, naming a zip", async () => {
    const zip = concat([new Uint8Array([0x50, 0x4b, 0x03, 0x04]), new Uint8Array(1020)]);
    const e = await refusal(zip);
    expect(e.code).toBe("invalid_input");
    expect(e.message).toMatch(/zip archive, not a tar/);
    expect(details(e).next).toMatch(/tar -cf - \. \| gzip -c/);
    const html = await refusal(new TextEncoder().encode("<!doctype html>".padEnd(600, " ")));
    expect(html.message).toMatch(/not a tar/);
  });

  it("refuses an empty body", async () => {
    const e = await refusal(new Uint8Array(0));
    expect(e.message).toMatch(/empty/);
  });

  it("refuses a later header with a bad checksum", async () => {
    const body = tar([...site, { name: "x.js", data: "x", badChecksum: true }]);
    const e = await refusal(body);
    expect(e.code).toBe("invalid_input");
    expect(e.message).toMatch(/corrupt tar header \(entry 3\)/);
  });

  it.each([
    ["1", "a hard link"],
    ["2", "a symbolic link"],
    ["3", "a character device"],
    ["4", "a block device"],
    ["6", "a FIFO"],
    ["S", "a GNU sparse file"],
    ["K", "a GNU long link name"],
    ["V", "a GNU volume header"],
    ["M", "a GNU multi-volume continuation"],
    ["Z", 'an entry of unknown type "Z"'],
  ])("refuses typeflag %s, naming the entry", async (flag, what) => {
    const body = tar([...site, { name: "assets/thing", type: flag, linkname: "index.html" }]);
    const e = await refusal(body);
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe(`assets/thing is ${what}; bundles hold regular files only`);
    expect(details(e).path).toBe("assets/thing");
  });

  it("refuses the links bsdtar writes, telling the agent to copy files instead (never -h)", async () => {
    for (const b64 of [real.symlinkTar, real.hardlinkTar]) {
      const e = await refusal(fromBase64(b64));
      expect(e.message).toMatch(/link\.html is a symbolic link|copy\.html is a hard link/);
      expect(details(e).next).toBe("Copy the specific files the page needs into the build folder");
      expect(JSON.stringify(e.details)).not.toMatch(/-h\b/);
    }
  });

  it("refuses pax sparse files", async () => {
    const body = tar([
      ...site,
      paxEntry({ "GNU.sparse.major": "1" }),
      { name: "a.bin", data: "x" },
    ]);
    expect((await refusal(body)).message).toMatch(/sparse/);
  });

  it("refuses absolute paths, .. and . segments, __plinth/ and bad characters, naming each", async () => {
    const body = tar([
      ...site,
      { name: "/etc/passwd", data: "x" },
      { name: "assets/../../escape.js", data: "x" },
      { name: "assets/./x.js", data: "x" },
      { name: "__plinth/bridge.js", data: "x" },
      { name: "assets/a b.js", data: "x" },
      paxEntry({ path: `assets/${"n".repeat(200)}.js` }),
      { name: "placeholder.js", data: "x" },
      paxEntry({ path: "../pax-escape.js" }),
      { name: "harmless.js", data: "x" },
    ]);
    const e = await refusal(body);
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe("7 paths in the bundle are not allowed");
    expect(details(e).paths).toEqual([
      { path: "/etc/passwd", reason: "absolute" },
      { path: "assets/../../escape.js", reason: "parent_segment" },
      { path: "assets/./x.js", reason: "dot_segment" },
      { path: "__plinth/bridge.js", reason: "reserved" },
      { path: "assets/a b.js", reason: "invalid" },
      { path: `assets/${"n".repeat(193)}…`, reason: "too_long" },
      { path: "../pax-escape.js", reason: "parent_segment" },
    ]);
    expect(details(e).next).toMatch(/Rename these files/);
  });

  it("refuses a dotfile path that tries to climb out (.. wins over the dotfile skip)", async () => {
    const e = await refusal(tar([...site, { name: ".git/../../x", data: "x" }]));
    expect(details(e).paths).toEqual([{ path: ".git/../../x", reason: "parent_segment" }]);
  });

  it("caps the named bad paths at 20 but counts them all", async () => {
    const bad = Array.from({ length: 25 }, (_, i) => ({ name: `/abs${i}`, data: "x" }));
    const e = await refusal(tar([...site, ...bad]));
    expect(e.message).toBe("25 paths in the bundle are not allowed");
    expect(details(e).paths).toHaveLength(20);
  });

  it("refuses a duplicate path, including ./x after x", async () => {
    const e = await refusal(tar([...site, { name: "./assets/app.js", data: "again" }]));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe("assets/app.js appears twice in the bundle");
  });

  it("escapes control characters and truncates echoed names", async () => {
    expect(echo("a\u0000b\u001bc")).toBe("a\\u0000b\\u001bc");
    expect(echo("x".repeat(300))).toHaveLength(201);
    const e = await refusal(tar([...site, { name: "evil\u001b[31m", type: "2", linkname: "x" }]));
    expect(e.message).toContain("evil\\u001b[31m");
  });
});

describe("sizes and bounds", () => {
  it("parses octal, padded octal, GNU base-256 and refuses negative or non-numeric sizes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parseNumeric(enc("00000000017\0"))).toBe(15);
    expect(parseNumeric(enc("     17 \0\0\0\0"))).toBe(15);
    expect(parseNumeric(new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00]))).toBe(256);
    expect(
      parseNumeric(
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfb]),
      ),
    ).toBeNull();
    expect(parseNumeric(enc("12a45\0"))).toBeNull();
    expect(parseNumeric(enc("-0000017\0"))).toBeNull();
    expect(parseNumeric(enc("00000000089\0"))).toBeNull();
    expect(parseNumeric(new Uint8Array(12))).toBeNull();
    expect(
      parseNumeric(
        new Uint8Array([0x80, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      ),
    ).toBeNull();
  });

  it("refuses a header whose size is negative (base-256) or not a number", async () => {
    const neg = new Uint8Array(12).fill(0xff);
    const e1 = await refusal(concat([INDEX, header({ name: "a.js", sizeField: neg }), END]));
    expect(e1.message).toMatch(/invalid size \(entry 2\)/);
    const nan = new TextEncoder().encode("0000000abc1\0");
    const e2 = await refusal(concat([INDEX, header({ name: "a.js", sizeField: nan }), END]));
    expect(e2.message).toMatch(/invalid size/);
    const e3 = await refusal(tar([...site, paxEntry({ size: "-5" }), { name: "b.js", data: "" }]));
    expect(e3.message).toMatch(/pax header in the bundle has an invalid size/);
    const e4 = await refusal(tar([...site, paxEntry({ size: "1e3" }), { name: "b.js", data: "" }]));
    expect(e4.message).toMatch(/invalid size/);
  });

  it("refuses an oversize pax record or GNU long name before buffering it", async () => {
    const over = LIMITS.maxTarMetaBytes + 1;
    // Only the header is sent: the refusal comes from the declared size, not from reading data.
    for (const type of ["x", "L", "g"]) {
      const e = await refusal(concat([INDEX, header({ name: "meta", type, size: over })]));
      expect(e.code).toBe("invalid_input");
      expect(e.message).toMatch(/over 64 KB/);
    }
  });

  /** A pax header of about `bytes` bytes, made of distinct keys (`tag` keeps headers apart). */
  const bigPax = (tag: string, bytes: number) => {
    const records: Record<string, string> = {};
    for (let i = 0; i * 16 < bytes; i++) records[`k${tag}${String(i).padStart(7, "0")}`] = "";
    return paxEntry(records);
  };

  it("refuses many consecutive pax headers once their total passes the cap, before buffering more", async () => {
    // Each header is under 64 KB on its own; the second takes the total over it. Only the second
    // header block is sent, so the refusal comes from its declared size, not from reading it.
    const first = bigPax("a", 40 * 1024);
    const e = await refusal(
      concat([INDEX, first, header({ name: "PaxHeaders/x", type: "x", size: 30 * 1024 })]),
    );
    expect(e.code).toBe("invalid_input");
    expect(e.message).toMatch(
      /extended headers before one entry .* over 64 KB in total \(entry 3\)/,
    );
    expect(details(e)).toMatchObject({ limit_bytes: LIMITS.maxTarMetaBytes });

    // The same holds for a long name after a pax header, and for a run of global headers.
    const e2 = await refusal(
      concat([INDEX, first, header({ name: "L", type: "L", magic: "gnu", size: 30 * 1024 })]),
    );
    expect(e2.message).toMatch(/in total/);
    const e3 = await refusal(
      concat([INDEX, first, header({ name: "PaxHeaders/g", type: "g", size: 30 * 1024 })]),
    );
    expect(e3.message).toMatch(/in total/);
  });

  it("stops a long run of 60 KB pax headers at the second one, having read almost nothing", async () => {
    // 900 headers of distinct keys (about 54 MB, under the raw and inflated caps) before one file.
    // A reader that merged them would hold millions of keys; this one reads two and refuses.
    let produced = 0;
    const body = lazyStream(async function* () {
      yield INDEX;
      for (let i = 0; i < 900; i++) {
        const h = bigPax(String(i), 60 * 1024);
        produced += h.byteLength;
        yield h;
      }
      yield entry({ name: "a.js", data: "x" });
      yield END;
    });
    const e = await refusal(body);
    expect(e.message).toMatch(/in total/);
    expect(produced).toBeLessThan(10 * 60 * 1024);
  });

  it("resets the extended-header total at every entry, and keeps only pax path and size", async () => {
    // Two files, each after its own 60 KB pax header with a path record: both pass.
    const nearCap = (path: string, tag: string) => {
      const records: Record<string, string> = { path };
      for (let i = 0; i * 16 < 60 * 1024; i++) records[`k${tag}${String(i).padStart(7, "0")}`] = "";
      return paxEntry(records);
    };
    const { files } = await read(
      tar([
        INDEX,
        nearCap("assets/one.js", "a"),
        { name: "ignored-1", data: "1" },
        nearCap("assets/two.js", "b"),
        { name: "ignored-2", data: "2" },
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(["index.html", "assets/one.js", "assets/two.js"]);
    // A path from one pax header still applies when a later header before the same entry sets
    // only the size; neither carries over to the entry after.
    const { files: f2 } = await read(
      tar([
        INDEX,
        paxEntry({ path: "assets/from-pax.js" }),
        paxEntry({ size: "3" }),
        { name: "ignored", data: "abc" },
        { name: "assets/plain.js", data: "p" },
      ]),
    );
    expect(f2.map((f) => [f.path, f.text])).toEqual([
      ["index.html", "<!doctype html><title>t</title>"],
      ["assets/from-pax.js", "abc"],
      ["assets/plain.js", "p"],
    ]);
  });

  it("refuses malformed pax records", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parsePax(enc("16 path=abc/def\n")).get("path")).toBe("abc/def");
    expect(() => parsePax(enc("99 path=x\n"))).toThrow(/malformed/);
    expect(() => parsePax(enc("x path=x\n"))).toThrow(/malformed/);
    expect(() => parsePax(enc("9 pathx\n"))).toThrow(/malformed/);
    expect(() => parsePax(enc("10 path=xy"))).toThrow(/malformed/);
  });

  it("refuses a 30 MB file from its declared size, before allocating or reading it", async () => {
    // Header only, no data: a reader that allocated or read first would report truncation.
    const e = await refusal(concat([INDEX, header({ name: "big.bin", size: 30 * MB })]));
    expect(e.code).toBe("payload_too_large");
    expect(details(e)).toMatchObject({
      path: "big.bin",
      limit_bytes: LIMITS.maxBundleFileBytes,
      size_bytes: 30 * MB,
      next: "Split or compress this file",
    });
  });

  it("refuses a file that would pass the version budget, before allocating it", async () => {
    const body = concat([
      entry({ name: "index.html", data: "x".repeat(600 * 1024) }),
      header({ name: "assets/next.bin", size: 500 * 1024 }),
    ]);
    const e = await refusal(body, { maxTotalBytes: 1 * MB });
    expect(e.code).toBe("payload_too_large");
    expect(e.message).toMatch(/Version is over 1 MB in total/);
    expect(details(e).largest[0]).toEqual({ path: "index.html", size_bytes: 600 * 1024 });
    expect(details(e).next).toMatch(/Never merge chunks/);
  });

  it("refuses more files than the instance allows", async () => {
    const files = viteBuild(12);
    const e = await refusal(tar(files), { maxEntries: 11 });
    expect(e.code).toBe("payload_too_large");
    expect(details(e)).toMatchObject({ limit: 10, count: 12, count_is_minimum: true });
    // What to do first: commands.curl already excludes source maps.
    // index.html plus 11 assets against 10: one file fewer fits.
    expect(details(e).next).toMatch(/^Remove at least 1 file the page does not load/);
    const fits = await read(tar(viteBuild(12).slice(0, 11)), { maxEntries: 11 });
    expect(fits.files).toHaveLength(11);
    expect(e.message).toBe(
      "The bundle has at least 12 files; this instance allows 10 asset files per version",
    );
    // How to leave the maps out of the archive, and the operator's setting.
    expect(details(e).next).toContain("tar --exclude='*.map'");
    expect(details(e).next).toContain(`MAX_ASSETS_PER_VERSION (up to ${LIMITS.maxAssetsCeiling})`);
  });

  it("refuses a body over the raw cap while streaming (no Content-Length needed)", async () => {
    const e = await refusal(tar([...site, { name: "a.bin", data: filler(300 * 1024, 1) }]), {
      maxRawBytes: 200 * 1024,
    });
    expect(e.code).toBe("payload_too_large");
    expect(e.message).toMatch(/on the wire/);
  });

  it("caps inflated bytes: a gzip bomb stops at the cap while its wire size is tiny", async () => {
    // 20 MB of zeros inside one entry gzip to a few KB on the wire.
    const zeros = lazyStream(async function* () {
      yield INDEX;
      yield header({ name: "assets/zeros.bin", size: 20 * MB });
      for (let i = 0; i < 20; i++) yield new Uint8Array(MB);
      yield END;
    });
    const wire = new Uint8Array(await new Response(gzipStream(zeros)).arrayBuffer());
    expect(wire.byteLength).toBeLessThan(64 * 1024);
    const e = await refusal(wire, { maxRawBytes: 1 * MB, maxInflatedBytes: 2 * MB });
    expect(e.code).toBe("payload_too_large");
    expect(e.message).toMatch(/inflates to over 2 MB/);
  });

  it("inflates only as the reader reads: a stalled reader stops the gzip body being fed", async () => {
    // workerd's DecompressionStream takes every write and queues all its output unread, so a
    // decompressor fed ahead of the reader could hold hundreds of MB from a body of a few
    // hundred KB. Here: index.html, then 8 entries of 25 MB of zeros (200 MB inflated), and the
    // reader stalls before the first zero file (its reserve never resolves).
    const zeroFile = new Uint8Array(LIMITS.maxBundleFileBytes);
    const wire = new Uint8Array(
      await new Response(
        gzipStream(
          lazyStream(async function* () {
            yield INDEX;
            for (let i = 0; i < 8; i++) {
              yield header({ name: `assets/z${i}.bin`, size: zeroFile.byteLength });
              yield zeroFile;
            }
            yield END;
          }),
        ),
      ).arrayBuffer(),
    );
    expect(wire.byteLength).toBeLessThan(400 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (pulled >= wire.byteLength) {
            c.close();
            return;
          }
          const chunk = wire.slice(pulled, pulled + 4096);
          pulled += chunk.byteLength;
          c.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    let reserves = 0;
    const reader = readBundle(body, {
      ...BOUNDS,
      reserve: () => (++reserves === 1 ? Promise.resolve() : new Promise<void>(() => {})),
    });
    const it = reader[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.path).toBe("index.html");
    void it.next();
    await new Promise((ok) => setTimeout(ok, 500));
    expect(reserves).toBe(2);
    // About one slice past what the reader read: never the rest of the body. Each compressed
    // byte inflates to at most 1032, so 16 KB fed bounds what sits inflated at ~16 MB.
    expect(pulled).toBeLessThanOrEqual(16 * 1024);
  });

  it("paces gzip without a timer per slice: an incompressible body reads at CPU speed", async () => {
    // A setTimeout(0) costs about 1 ms in workerd, and a slice is at most 8 KB and one body
    // chunk, so waiting a timer turn before each slice capped inflation near 3 MB/s.
    const data = new Uint8Array(2 * MB);
    for (let o = 0; o < data.byteLength; o += 65536)
      crypto.getRandomValues(data.subarray(o, o + 65536));
    const wire = await gzip(tar([...site, { name: "assets/blob.bin", data }]));
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const { files } = await read(streamOf(wire, 4096));
      expect(files.map((f) => f.size)).toEqual([31, 14, data.byteLength]);
      // About 500 slices; only the wait for held padding (none here) may use a timer.
      expect(timers.mock.calls.length).toBeLessThan(10);
    } finally {
      timers.mockRestore();
    }
  });

  it("refuses a stream truncated inside a file, inside a header, or inside gzip", async () => {
    const whole = tar([...site, { name: "assets/a.bin", data: filler(4000, 2) }]);
    const midData = await refusal(whole.slice(0, 5 * BLOCK + 1000));
    expect(midData.message).toBe("The bundle ends in the middle of assets/a.bin");
    const midHeader = await refusal(whole.slice(0, 4 * BLOCK + 100));
    expect(midHeader.message).toMatch(/middle of a tar header/);
    const gz = await gzip(whole);
    const midGzip = await refusal(gz.slice(0, Math.floor(gz.byteLength / 2)));
    expect(midGzip.code).toBe("invalid_input");
  });
});

describe("the prefix strip", () => {
  it("strips only when every kept file is under one directory that holds the source", async () => {
    const { summary } = await read(
      tar([
        { name: "dist/", type: "5" },
        { name: "dist/index.html", data: "<p>x</p>" },
        { name: "dist/assets/a.js", data: "a" },
        { name: "dist/.DS_Store", data: "x" },
      ]),
    );
    expect(summary.strippedPrefix).toBe("dist/");
  });

  it("refuses with no_entry_file when a stray file sits beside dist/", async () => {
    const e = await refusal(
      tar([
        { name: "dist/index.html", data: "<p>x</p>" },
        { name: "dist/assets/a.js", data: "a" },
        { name: "package.json", data: "{}" },
      ]),
    );
    expect(e.code).toBe("invalid_input");
    expect(details(e)).toMatchObject({
      reason: "no_entry_file",
      next: "Run tar from inside the build folder (the one with index.html at its top)",
    });
  });

  it("refuses with no_entry_file without a source file, or with it two levels down", async () => {
    for (const files of [
      [{ name: "assets/a.js", data: "a" }],
      [{ name: "a/b/index.html", data: "x" }],
      [{ name: "dist/a.js", data: "x" }],
    ]) {
      const e = await refusal(tar(files));
      expect(details(e).reason).toBe("no_entry_file");
    }
  });

  it("looks for the target type's source: content.md for a doc", async () => {
    const doc = tar([
      { name: "content.md", data: "# Hi" },
      { name: "img/a.png", data: "png" },
    ]);
    expect((await read(doc, { sourcePath: "content.md" })).summary.strippedPrefix).toBeNull();
    const e = await refusal(doc);
    expect(e.message).toBe("The bundle has no index.html at its top");
    const nested = tar([{ name: "out/content.md", data: "# Hi" }]);
    expect((await read(nested, { sourcePath: "content.md" })).summary.strippedPrefix).toBe("out/");
  });

  it("re-validates paths after the strip (dist/__plinth/x would become reserved)", () => {
    expect(() =>
      stripPrefixFor(new Set(["dist/index.html", "dist/__plinth/x.js"]), "index.html"),
    ).toThrow(/1 path in the bundle is not allowed/);
    expect(stripPrefixFor(new Set(["index.html", "dist/a.js"]), "index.html")).toBeNull();
  });
});

describe("memory stays bounded by file size, not bundle size", () => {
  it("streams a 50 MB, 511-file gzip bundle through the reader in the Workers pool", async () => {
    // 1 index.html plus 510 assets of ~100 KB: 50 MB of file bytes, generated as the reader pulls,
    // so neither the test nor the reader ever holds more than one file.
    const count = 511;
    const per = Math.floor((50 * MB - 1024) / (count - 1)) - BLOCK;
    const body = gzipStream(
      lazyStream(async function* () {
        yield entry({ name: "./index.html", data: "<!doctype html><title>big</title>" });
        for (let i = 1; i < count; i++) {
          yield entry({ name: `./assets/chunk-${i}.js`, data: filler(per, i) });
        }
        yield END;
      }),
    );
    const reader = readBundle(body, BOUNDS);
    let files = 0;
    let bytes = 0;
    let largest = 0;
    for await (const e of reader) {
      files++;
      bytes += e.bytes.byteLength;
      largest = Math.max(largest, e.bytes.byteLength);
    }
    expect(files).toBe(511);
    expect(bytes).toBeGreaterThan(49 * MB);
    expect(bytes).toBeLessThanOrEqual(50 * MB);
    expect(largest).toBe(per);
    expect(reader.summary).toEqual({ entries: 511, skipped: [], strippedPrefix: null });
  }, 120_000);
});
