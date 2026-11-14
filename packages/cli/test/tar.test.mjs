// The CLI's tar writer: what it writes reads back through an independent reader and through the
// system tar, byte for byte, including paths that need the ustar prefix or a pax record, empty
// files and files that end exactly on a block boundary. The stream is gzip.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, it } from "node:test";
import {
  gzipTarStream,
  paxRecord,
  splitUstarPath,
  tarChunks,
  ustarHeader,
} from "../bin/client/tar.mjs";
import { readTar } from "./helpers/tar-reader.mjs";

const longDir = `${"d".repeat(60)}/${"e".repeat(60)}`;
const CASES = {
  "index.html": "<!doctype html><title>t</title>",
  "assets/app.js": randomBytes(70_000),
  "empty.txt": "",
  "block.bin": randomBytes(1024),
  [`${longDir}/${"f".repeat(70)}.js`]: "prefix split",
  [`${"g".repeat(150)}.css`]: "needs pax",
};

function folder() {
  const dir = mkdtempSync(path.join(tmpdir(), "plinth-tar-"));
  const files = [];
  for (const [p, content] of Object.entries(CASES)) {
    const abs = path.join(dir, p);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    files.push({ path: p, abs, size: Buffer.byteLength(content) });
  }
  return { dir, files };
}

describe("tar writer", () => {
  it("round-trips through an independent reader (gzip, prefix, pax, empty, block-sized)", async () => {
    const { dir, files } = folder();
    try {
      const gz = await buffer(gzipTarStream(files));
      assert.deepEqual([...gz.subarray(0, 2)], [0x1f, 0x8b]);
      const entries = readTar(gz);
      assert.deepEqual(
        entries.map((e) => e.path),
        files.map((f) => f.path),
      );
      for (const e of entries) {
        assert.deepEqual(e.bytes, readFileSync(path.join(dir, e.path)), e.path);
        assert.equal(e.mode, 0o644);
        assert.equal(e.mtime, 0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is read by the system tar, byte for byte", async () => {
    const { dir, files } = folder();
    const out = mkdtempSync(path.join(tmpdir(), "plinth-untar-"));
    try {
      const archive = path.join(out, "bundle.tar.gz");
      writeFileSync(archive, await buffer(gzipTarStream(files)));
      const dest = path.join(out, "x");
      mkdirSync(dest);
      const r = spawnSync("tar", ["-xzf", archive, "-C", dest], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      for (const f of files) {
        assert.deepEqual(readFileSync(path.join(dest, f.path)), readFileSync(f.abs), f.path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("splits long paths at a slash into prefix and name, and falls back to pax", () => {
    assert.deepEqual(splitUstarPath("a/b.js"), { prefix: "", name: "a/b.js" });
    const p = `${"x".repeat(90)}/${"y".repeat(90)}`;
    assert.deepEqual(splitUstarPath(p), { prefix: "x".repeat(90), name: "y".repeat(90) });
    assert.equal(splitUstarPath("z".repeat(101)), null);
    for (const value of ["a", "x".repeat(3), "y".repeat(93), "z".repeat(994)]) {
      const rec = Buffer.from(paxRecord("path", value)).toString();
      assert.equal(Number(rec.split(" ")[0]), Buffer.byteLength(rec), value.length);
      assert.ok(rec.endsWith(`path=${value}\n`));
    }
  });

  it("writes a valid header checksum and the ustar magic", () => {
    const h = ustarHeader({ name: "index.html", size: 5 });
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(Number.parseInt(Buffer.from(h.subarray(148, 154)).toString(), 8), sum);
    assert.equal(Buffer.from(h.subarray(257, 263)).toString(), "ustar\0");
  });

  it("fails when a file changes size after the walk", async () => {
    const chunks = tarChunks([{ path: "a.js", abs: "/nowhere", size: 3 }], () => Buffer.from("ab"));
    await assert.rejects(async () => {
      for await (const _ of chunks);
    }, /changed while it was being sent/);
  });
});
