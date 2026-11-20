// The client commands, run as a real process (bin/plinth.mjs) against a fake instance: publish
// (bundle for a new artifact, inline reuse by sha256 for a small update, a bundle for a big one,
// conflicts exit 3), upload with a ticket, origin resolution and token binding, the edge 1010
// message, refused redirects and links, limit pre-checks, and sign-in state on disk.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSheet, serializeSheet } from "../../shared/src/sheet/format.ts";
import { claudeCodeConnectText } from "../bin/client/connect.mjs";
import { canonicalSheet, checkLimits } from "../bin/client/files.mjs";
import { ApiError } from "../bin/client/http.mjs";
import { HOSTED_ORIGIN, resolveOrigin } from "../bin/client/origin.mjs";
import { isVersionConflict, splitWarnings } from "../bin/client/publish.mjs";
import { PAT, startFakePlinth } from "./helpers/fake-plinth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const BIN = path.join(pkgDir, "bin", "plinth.mjs");
const VERSION = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;

let fake;
let work;
let env;

/** Run the CLI; never spawnSync (the fake server shares this event loop). */
function plinth(args, { extraEnv = {}, bin = BIN, onStderr } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], {
      env: { ...env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => {
      stdout += d;
    });
    c.stderr.on("data", (d) => {
      stderr += d;
      onStderr?.(stderr);
    });
    c.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A build folder from {path: content}. */
function build(files) {
  const dir = mkdtempSync(path.join(work, "build-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), content);
  }
  return dir;
}

const site = (n = 3) => {
  const files = {
    "index.html": '<!doctype html><title>Site</title><script src="assets/a0.js"></script>',
  };
  for (let i = 0; i < n; i++) files[`assets/a${i}.js`] = `console.log(${i});`;
  return files;
};

const asPat = () => ({ PLINTH_TOKEN: PAT, PLINTH_URL: fake.origin });
const since = (from) => fake.state.requests.slice(from);

before(async () => {
  fake = await startFakePlinth();
  work = mkdtempSync(path.join(tmpdir(), "plinth-cli-test-"));
});
after(async () => {
  await fake.close();
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  const config = mkdtempSync(path.join(work, "config-"));
  // A minimal environment: no wrangler on PATH, no PLINTH_* from the developer's shell.
  env = {
    PATH: path.dirname(process.execPath),
    HOME: work,
    XDG_CONFIG_HOME: config,
    PLINTH_HOME: path.join(work, "no-instances"),
  };
});

describe("plinth publish", () => {
  it("publishes a new folder as one gzipped bundle and verifies every file", async () => {
    const dir = build(site(3));
    const from = fake.state.requests.length;
    const r = await plinth(["publish", dir, "--json", "--title", "My site"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), [
      "content_url",
      "id",
      "slug",
      "stored",
      // The title, as the read-back returned it (docs/ci.md).
      "title",
      "url",
      "verified",
      "version",
      "warnings",
    ]);
    assert.equal(out.version, 1);
    assert.equal(out.verified, true);
    assert.equal(out.stored.files, 4);
    assert.match(r.stderr, new RegExp(`plinth: ${fake.origin} \\(PLINTH_URL\\)`));
    assert.deepEqual(fake.state.lastUploadInput, { type: "html", title: "My site" });

    const reqs = since(from);
    for (const q of reqs) assert.equal(q.ua, `plinth-cli/${VERSION}`, `${q.method} ${q.path}`);
    const bundle = reqs.find((q) => q.path.endsWith("/bundle"));
    assert.equal(bundle.contentType, "application/gzip");
    assert.match(bundle.authorization, /^Bearer plinth_up_/);
    // The upload token goes to the bundle route only; the PAT never goes there.
    for (const q of reqs.filter((x) => x !== bundle))
      assert.ok(!q.authorization?.includes("plinth_up_"), q.path);
    assert.deepEqual([...fake.state.lastBundle.subarray(0, 2)], [0x1f, 0x8b]);
    const stored = fake.state.artifacts.get(out.id).versions[0];
    assert.deepEqual([...stored.keys()].sort(), Object.keys(site(3)).sort());
  });

  it("republishes one changed file inline: written 2, the rest sent as {path, sha256}", async () => {
    const files = site(300);
    const dir = build(files);
    const first = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    assert.equal(first.code, 0, first.stderr);
    const { id } = JSON.parse(first.stdout);
    writeFileSync(path.join(dir, "assets/a7.js"), "console.log('changed');");
    const r = await plinth(["publish", dir, "--id", id, "--json", "--note", "one fix"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 2);
    assert.equal(out.stored.written, 2);
    assert.equal(out.stored.reused, 299);
    assert.equal(out.verified, true);
    const put = fake.state.lastPut;
    assert.equal(put.base_version, 1);
    assert.equal(put.note, "one fix");
    const withContent = put.assets.filter((a) => a.content !== undefined);
    assert.deepEqual(
      withContent.map((a) => a.path),
      ["assets/a7.js"],
    );
    assert.match(withContent[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(put.assets.length, 300);
  });

  it("resends the files the server reports missing, once, with content", async () => {
    const a = fake.seed(site(2));
    const dir = build(site(2));
    fake.state.forgetOnce = true;
    const r = await plinth(["publish", dir, "--id", a.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.lastPut.assets.filter((x) => x.content !== undefined).length, 2);
  });

  it("verifies a source that starts with a BOM, by bundle and inline", async () => {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const html = (t) => Buffer.concat([BOM, Buffer.from(`<!doctype html><title>${t}</title>`)]);
    const dir = build({ "index.html": html("one"), "a.js": "1" });
    const first = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    assert.equal(first.code, 0, first.stderr);
    const out = JSON.parse(first.stdout);
    assert.equal(out.verified, true);

    writeFileSync(path.join(dir, "index.html"), html("two"));
    const r = await plinth(["publish", dir, "--id", out.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verified, true);
    assert.ok(fake.state.lastPut.html.startsWith("\uFEFF<!doctype"), "inline, with the BOM");
    // The inline update keeps the BOM, so the stored bytes are the file's bytes.
    const stored = fake.state.artifacts.get(out.id).versions.at(-1).get("index.html").bytes;
    assert.deepEqual(stored, html("two"));
  });

  it("still fails verification when the stored source really differs", async () => {
    const dir = build(site(1));
    const first = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    const { id } = JSON.parse(first.stdout);
    fake.state.tamperSource = true;
    try {
      writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Changed</title>");
      const r = await plinth(["publish", dir, "--id", id], { extraEnv: asPat() });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stdout, /Verification failed[\s\S]*differs: index\.html/);
    } finally {
      fake.state.tamperSource = false;
    }
  });

  it("sends a big update as a bundle with the base version", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const dir = build({
      "index.html": "<title>big</title>",
      "small.js": "1",
      "one.bin": randomBytes(13 * 1024 * 1024),
      "two.bin": randomBytes(13 * 1024 * 1024),
    });
    const from = fake.state.requests.length;
    const r = await plinth(["publish", dir, "--id", a.slug, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fake.state.lastUploadInput, { id: a.id, base_version: 1 });
    assert.ok(since(from).some((q) => q.path.endsWith("/bundle")));
    assert.ok(!since(from).some((q) => q.method === "PUT"));
    assert.equal(JSON.parse(r.stdout).verified, true);
  });

  it("exits 3 on a stale --base-version without writing, and on a conflict from the server", async () => {
    const a = fake.seed(site(1));
    fake.bump(a);
    const dir = build(site(1));
    const from = fake.state.requests.length;
    const r = await plinth(["publish", dir, "--id", a.id, "--base-version", "1"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, new RegExp(`${a.id} changed since v1 \\(now v2\\)`));
    assert.ok(!since(from).some((q) => q.method !== "GET"));

    // Someone else publishes between the read and the write: the server's 409 is never retried.
    const b = fake.seed(site(1));
    const realBump = () => fake.bump(b);
    const origPut = fake.state;
    origPut.bumpBeforePut = realBump;
    const r2 = await plinth(["publish", dir, "--id", b.id], { extraEnv: asPat() });
    origPut.bumpBeforePut = null;
    assert.equal(r2.code, 3, r2.stderr);
    assert.match(r2.stderr, /changed since v1 \(now v2\)/);
    assert.equal(since(from).filter((q) => q.method === "PUT").length, 1);
  });

  it("exits 3 when someone publishes while a big update's bundle is on its way", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const dir = build({
      "index.html": "<title>big</title>",
      "small.js": "2",
      "one.bin": randomBytes(13 * 1024 * 1024),
      "two.bin": randomBytes(13 * 1024 * 1024),
    });
    const from = fake.state.requests.length;
    fake.state.bumpBeforeBundle = () => fake.bump(a);
    try {
      const r = await plinth(["publish", dir, "--id", a.id], { extraEnv: asPat() });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, new RegExp(`${a.id} changed since v1 \\(now v2\\)`));
    } finally {
      fake.state.bumpBeforeBundle = null;
    }
    assert.ok(since(from).some((q) => q.path.endsWith("/bundle")));
    assert.equal(since(from).filter((q) => q.path.endsWith("/bundle")).length, 1);
  });

  it("refuses symlinks, skips dotfiles and source maps, and suggests renames", async () => {
    const dir = build({
      ...site(1),
      ".env": "SECRET=1",
      "assets/a0.js.map": "{}",
      ".git/HEAD": "x",
    });
    const outside = path.join(work, "outside.txt");
    writeFileSync(outside, "not part of the build");
    symlinkSync(outside, path.join(dir, "linked.txt"));
    const r = await plinth(["publish", dir, "--dry-run"], { extraEnv: asPat() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /linked\.txt is a symbolic link/);
    assert.match(r.stderr, /never follows links/);
    rmSync(path.join(dir, "linked.txt"));

    const ok = await plinth(["publish", dir, "--dry-run"], { extraEnv: asPat() });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Would publish 2 files/);
    assert.match(ok.stderr, /Left out 3 dotfiles and source maps/);
    const maps = await plinth(["publish", dir, "--dry-run", "--include-maps"], {
      extraEnv: asPat(),
    });
    assert.match(maps.stdout, /Would publish 3 files/);

    writeFileSync(path.join(dir, "my photo (1).png"), "x");
    const bad = await plinth(["publish", dir, "--dry-run"], { extraEnv: asPat() });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /my photo \(1\)\.png has characters/);
    assert.match(bad.stderr, /for example my-photo-1\.png/);
  });

  it("pre-checks the instance's limits: file count, one file's size and the total", async () => {
    const limits = fake.state.limits;
    const saved = { ...limits };
    try {
      limits.max_assets_per_version = 2;
      const many = await plinth(["publish", build(site(3)), "--dry-run"], { extraEnv: asPat() });
      assert.equal(many.code, 1);
      assert.match(many.stderr, /3 asset files; this instance allows 2 per version/);
      Object.assign(limits, saved, { max_bundle_file_bytes: 1000 });
      const big = await plinth(
        ["publish", build({ "index.html": "x", "big.bin": randomBytes(2000) }), "--dry-run"],
        { extraEnv: asPat() },
      );
      assert.equal(big.code, 1);
      assert.match(big.stderr, /big\.bin is 2\.0 KB; one file may be at most 1000 B/);
      Object.assign(limits, saved, { max_version_bytes: 1500 });
      const total = await plinth(
        [
          "publish",
          build({ "index.html": "x", "a.bin": randomBytes(1000), "b.bin": randomBytes(1000) }),
          "--dry-run",
        ],
        { extraEnv: asPat() },
      );
      assert.equal(total.code, 1);
      assert.match(total.stderr, /in total; this instance allows 1\.5 KB per version/);
      assert.match(total.stderr, /a\.bin|b\.bin/);
    } finally {
      Object.assign(limits, saved);
    }
  });

  it("--json --dry-run prints one JSON object of what would be sent, and sends nothing", async () => {
    const from = fake.state.requests.length;
    const fresh = await plinth(["publish", build(site(1)), "--json", "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(fresh.code, 0, fresh.stderr);
    const n = JSON.parse(fresh.stdout);
    assert.equal(n.outcome, "dry_run");
    assert.equal(n.dry_run, true);
    assert.equal(n.type, "html");
    assert.equal(n.files, 2);
    assert.equal(n.send, "bundle");
    assert.ok(Number.isInteger(n.bytes) && n.bytes > 0);
    assert.equal(n.version, undefined);
    // The sentence goes to stderr, so stdout stays one object.
    assert.match(fresh.stderr, /Would publish 2 files/);

    const a = fake.seed({ "index.html": "<p>1</p>", "a.css": "p{}", "b.css": "b{}" });
    const dir = build({ "index.html": "<p>2</p>", "a.css": "p{}", "b.css": "changed{}" });
    const upd = await plinth(["publish", dir, "--id", a.id, "--json", "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(upd.code, 0, upd.stderr);
    const u = JSON.parse(upd.stdout);
    assert.equal(u.outcome, "dry_run");
    assert.equal(u.id, a.id);
    assert.equal(u.slug, a.slug);
    assert.equal(u.base_version, 1);
    assert.equal(u.next_version, 2);
    assert.equal(u.files, 3);
    assert.equal(u.changed, 1);
    assert.equal(u.reused, 1);
    assert.equal(u.send, "inline");
    assert.match(upd.stderr, /Would update .* from v1 to v2/);
    assert.equal(a.versions.length, 1);
    assert.deepEqual(
      since(from)
        .filter((q) => q.method !== "GET")
        .map((q) => `${q.method} ${q.path}`),
      [],
    );
    // Without --json the sentence stays on stdout.
    const text = await plinth(["publish", dir, "--id", a.id, "--dry-run"], { extraEnv: asPat() });
    assert.match(text.stdout, /^Would update /);
  });

  it("needs index.html (or content.md) at the top of the folder", async () => {
    const r = await plinth(["publish", build({ "dist/index.html": "x" }), "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No index\.html/);
    assert.match(r.stderr, /slides\.md for a deck/);
    assert.match(r.stderr, /sheet\.jsonl for a sheet/);
  });

  it("publishes a folder with sheet.jsonl as a sheet, stored canonical, and still verifies", async () => {
    const sheet =
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item"},{"name":"Qty","type":"number"}]}\n["Apples",3]\n';
    const dir = build({ "sheet.jsonl": sheet });
    const dry = await plinth(["publish", dir, "--dry-run"], { extraEnv: asPat() });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /as a new sheet/);
    const r = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fake.state.lastUploadInput, { type: "sheet" });
    const out = JSON.parse(r.stdout);
    assert.equal(out.verified, true);
    const stored = fake.state.artifacts.get(out.id).versions[0];
    // The fake stores it without the final newline, as the server's canonical form may differ.
    assert.equal(stored.get("sheet.jsonl").bytes.toString(), sheet.slice(0, -1));
  });

  describe("a sheet's read-back compares sheet.jsonl in its canonical spelling", () => {
    const v1 =
      '{"plinth":"sheet","v":1,"columns":[{"name":"Item"},{"name":"Qty","type":"number"}]}\n["Apples",3]\n';
    const v2 = v1.replace('["Apples",3]', '["Apples",4]');
    // The same sheet as v1, spelled the way people write it: keys out of order, no column type,
    // spaces, a number as 3.0, CRLF line ends.
    const v1Loose =
      '{ "columns": [ {"name": "Item"}, {"type": "number", "name": "Qty"} ], "v": 1, "plinth": "sheet" }\r\n[ "Apples", 3.0 ]\r\n';
    const writes = (from) => since(from).filter((q) => q.method === "PUT" || q.method === "POST");
    const publishNew = async (text) => {
      const r = await plinth(["publish", build({ "sheet.jsonl": text }), "--json"], {
        extraEnv: asPat(),
      });
      assert.equal(r.code, 0, r.stderr);
      return fake.state.artifacts.get(JSON.parse(r.stdout).id);
    };
    const rerun = (dir, a) =>
      plinth(["publish", dir, "--id", a.id, "--base-version", "1", "--json"], {
        extraEnv: asPat(),
      });
    const storedText = (a, n) => a.versions[n - 1].get("sheet.jsonl").bytes.toString();

    it("matches the shared serializer on every rule it restates", () => {
      const cases = [
        v1,
        v1Loose,
        '{"plinth":"sheet","v":1,"freeze":{"cols":0},"columns":[{"name":"A"},{"name":"B"}]}\n[]\n[null,null]\n["a",null]',
        '{"freeze":{"cols":2},"plinth":"sheet","v":1,"columns":[{"name":"A"},{"name":"B"}]}\n["x",1e2]',
        '{"plinth":"sheet","v":1,"columns":[{"options":["Café","Tea"],"type":"select","name":"Café"}]}\n["Tea"]',
        '{"plinth":"sheet","v":1,"columns":[{"name":"P","width":120,"type":"number","format":{"grouping":false,"decimals":2,"currency":"EUR","style":"currency"}}]}\n[12.50]\n["=SUM(A2:A2)"]',
        '﻿{"plinth":"sheet","v":1,"columns":[{"name":"T"},{"name":"C","type":"checkbox"}]}\n["\\u0041\\n\\"q\\"",true]\n[-0,false]\n',
      ];
      for (const text of cases) {
        // The server receives the text without a leading BOM (it is dropped on decoding).
        const parsed = parseSheet(text.replace(/^﻿/, ""));
        assert.ok(parsed.ok, `${text}: ${JSON.stringify(parsed.errors)}`);
        assert.equal(canonicalSheet(text), serializeSheet(parsed.sheet), text);
        // The canonical form is a fixed point, so comparing both sides in it is safe.
        assert.equal(canonicalSheet(serializeSheet(parsed.sheet)), serializeSheet(parsed.sheet));
      }
      assert.equal(canonicalSheet("not json"), null);
      assert.equal(
        canonicalSheet('{"plinth":"sheet","v":1,"columns":[{"name":"A"}]}\n\n[1]'),
        null,
      );
      assert.equal(canonicalSheet('{"plinth":"sheet","v":1,"columns":[{"name":"A"}]}\n{}'), null);
    });

    it("--base-version N with a changed cell publishes N+1 (it is not 'nothing to publish')", async () => {
      const a = await publishNew(v1);
      const dir = build({ "sheet.jsonl": v2 });
      const r = await rerun(dir, a);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.outcome, undefined);
      assert.equal(out.version, 2);
      assert.equal(out.verified, true);
      assert.equal(a.versions.length, 2);
      assert.equal(storedText(a, 2), v2.slice(0, -1));
    });

    it("--base-version N when someone else made N+1: a conflict (exit 3), nothing sent", async () => {
      const a = await publishNew(v1);
      fake.commitFiles(a, { "sheet.jsonl": v1.replace("Apples", "Pears").slice(0, -1) });
      const from = fake.state.requests.length;
      const r = await rerun(build({ "sheet.jsonl": v2 }), a);
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, /changed since v1 \(now v2\)/);
      assert.equal(writes(from).length, 0);
      assert.equal(a.versions.length, 2);
    });

    it("a folder spelled differently from the stored sheet still matches it", async () => {
      fake.state.canonicalSheet = (text) => serializeSheet(parseSheet(text).sheet);
      try {
        const a = await publishNew(v1Loose);
        assert.notEqual(storedText(a, 1), v1Loose);
        const same = await rerun(build({ "sheet.jsonl": v1Loose }), a);
        assert.equal(same.code, 0, same.stderr);
        assert.equal(JSON.parse(same.stdout).outcome, "nothing_to_publish");
        const changed = await rerun(build({ "sheet.jsonl": v1Loose.replace("3.0", "5") }), a);
        assert.equal(changed.code, 0, changed.stderr);
        assert.equal(JSON.parse(changed.stdout).version, 2);
        assert.equal(JSON.parse(changed.stdout).verified, true);
      } finally {
        fake.state.canonicalSheet = undefined;
      }
    });

    it("fails verification when the stored sheet really differs", async () => {
      const a = await publishNew(v1);
      fake.state.tamperSource = true;
      try {
        const r = await plinth(["publish", build({ "sheet.jsonl": v2 }), "--id", a.id], {
          extraEnv: asPat(),
        });
        assert.equal(r.code, 1, r.stderr);
        assert.match(r.stdout, /Verification failed[\s\S]*differs: sheet\.jsonl/);
      } finally {
        fake.state.tamperSource = false;
      }
    });
  });

  it("imports one .csv file as a new sheet, and an .xlsx as the next version of one", async () => {
    const dir = build({ "q4-budget.csv": "Item,Qty\nApples,3\n", "book.xlsx": "PK-not-really" });
    const dry = await plinth(["publish", path.join(dir, "q4-budget.csv"), "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would import q4-budget\.csv .* as a new sheet/);
    const r = await plinth(["publish", path.join(dir, "q4-budget.csv"), "--json"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fake.state.lastPost, {
      type: "sheet",
      title: "q4-budget",
      content: "Item,Qty\nApples,3\n",
      content_format: "csv",
    });
    const out = JSON.parse(r.stdout);
    assert.equal(out.verified, true);

    const up = await plinth(["publish", path.join(dir, "book.xlsx"), "--id", out.id, "--json"], {
      extraEnv: asPat(),
    });
    assert.equal(up.code, 0, up.stderr);
    const put = fake.state.lastPut;
    assert.equal(put.content_format, "xlsx");
    assert.equal(Buffer.from(put.content, "base64").toString(), "PK-not-really");
    assert.equal(put.base_version, 1);
    assert.equal(JSON.parse(up.stdout).version, 2);

    const stale = await plinth(
      ["publish", path.join(dir, "q4-budget.csv"), "--id", out.id, "--base-version", "1"],
      { extraEnv: asPat() },
    );
    assert.equal(stale.code, 3);

    const page = fake.seed(site(1));
    const wrong = await plinth(["publish", path.join(dir, "q4-budget.csv"), "--id", page.id], {
      extraEnv: asPat(),
    });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /is a page; a \.csv or \.xlsx file updates a sheet only/);
  });

  it("checks a sheet's sheet.jsonl against the sheet limit", () => {
    const limits = { ...fake.state.limits, max_sheet_bytes: 100 };
    assert.throws(
      () => checkLimits([{ path: "sheet.jsonl", size: 200 }], "sheet.jsonl", "sheet", limits),
      /limit is 100 B/,
    );
    assert.doesNotThrow(() =>
      checkLimits([{ path: "sheet.jsonl", size: 20 }], "sheet.jsonl", "sheet", limits),
    );
  });

  it("publishes a folder with slides.md as a deck, and updates it inline with content", async () => {
    const deck = {
      "slides.md": "# Talk\n\n---\n\n## Two\n\n![c](img/c.png)\n",
      "img/c.png": "png",
    };
    const dir = build(deck);
    const dry = await plinth(["publish", dir, "--dry-run"], { extraEnv: asPat() });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /as a new deck/);
    const first = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(fake.state.lastUploadInput, { type: "slides" });
    const out = JSON.parse(first.stdout);
    assert.equal(out.verified, true);
    const stored = fake.state.artifacts.get(out.id).versions[0];
    assert.deepEqual([...stored.keys()].sort(), ["img/c.png", "slides.md"]);

    writeFileSync(path.join(dir, "slides.md"), "# Talk\n\n---\n\n## Two, again\n");
    const r = await plinth(["publish", dir, "--id", out.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).verified, true);
    const put = fake.state.lastPut;
    assert.equal(put.content, "# Talk\n\n---\n\n## Two, again\n");
    assert.equal(put.html, undefined);

    const wrong = await plinth(["publish", build(site(1)), "--id", out.id, "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /is a deck; the folder needs slides\.md at its top/);
  });

  it("checks a deck's slides.md against the Markdown limit, not the HTML one", () => {
    const limits = { ...fake.state.limits, max_html_bytes: 10 };
    const files = [{ path: "slides.md", size: 2 * 1024 * 1024 }];
    assert.throws(() => checkLimits(files, "slides.md", "slides", limits), /limit is 1\.0 MB/);
    assert.doesNotThrow(() =>
      checkLimits([{ path: "slides.md", size: 20 }], "slides.md", "slides", limits),
    );
  });

  it("refuses an upload_url the server returns on another origin", async () => {
    const other = await startFakePlinth({
      uploadUrl: "https://elsewhere.example/api/v1/uploads/abcdefghij0123456789/bundle",
    });
    try {
      const r = await plinth(["publish", build(site(1))], {
        extraEnv: { PLINTH_TOKEN: PAT, PLINTH_URL: other.origin },
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Refusing the upload URL .*it must be https|is not on/);
      assert.ok(!other.state.requests.some((q) => q.path.endsWith("/bundle")));
    } finally {
      await other.close();
    }
  });
});

describe("plinth publish --category", () => {
  it("sends the category with a new publish, normalised, and prints the stored name", async () => {
    const dir = build(site(1));
    const r = await plinth(["publish", dir, "--json", "--category", "  acme   site "], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fake.state.lastUploadInput, { type: "html", category: "acme site" });
    assert.equal(JSON.parse(r.stdout).category, "acme site");

    const text = await plinth(["publish", build(site(1)), "--category", "Acme site"], {
      extraEnv: asPat(),
    });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^Published v1 under Acme site: http/m);
  });

  it("carries it on an inline update (PUT) and on a bundled update (POST /uploads)", async () => {
    const a = fake.seed(site(1));
    const r = await plinth(
      ["publish", build(site(1)), "--id", a.id, "--json", "--category", "Acme site"],
      { extraEnv: asPat() },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.lastPut.category, "Acme site");
    assert.equal(fake.state.lastPut.base_version, 1);
    assert.equal(JSON.parse(r.stdout).category, "Acme site");

    const big = fake.seed({ "index.html": "<title>big</title>" });
    const dir = build({
      "index.html": "<title>big</title>",
      "one.bin": randomBytes(13 * 1024 * 1024),
      "two.bin": randomBytes(13 * 1024 * 1024),
    });
    const b = await plinth(
      ["publish", dir, "--id", big.id, "--json", "--note", "n", "--category", "Acme site"],
      { extraEnv: asPat() },
    );
    assert.equal(b.code, 0, b.stderr);
    assert.deepEqual(fake.state.lastUploadInput, {
      id: big.id,
      base_version: 1,
      note: "n",
      category: "Acme site",
    });
    assert.equal(JSON.parse(b.stdout).category, "Acme site");
  });

  it("refuses a name that is too long, empty or has control characters before any request", async () => {
    const dir = build(site(1));
    for (const bad of ["x".repeat(61), "   ", "a\u202Eb", "a\u200Bb", "-", " _ - "]) {
      const from = fake.state.requests.length;
      const r = await plinth(["publish", dir, "--category", bad], { extraEnv: asPat() });
      assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.stderr}`);
      assert.match(r.stderr, /--category/);
      assert.equal(since(from).length, 0, JSON.stringify(bad));
    }
    const ok = await plinth(["publish", dir, "--dry-run", "--category", "x".repeat(60)], {
      extraEnv: asPat(),
    });
    assert.equal(ok.code, 0, ok.stderr);
  });

  it("reports the owner-only refusal on an artifact you do not own, and publishes nothing", async () => {
    const a = fake.seed(site(1));
    fake.state.notOwner = true;
    try {
      const r = await plinth(["publish", build(site(1)), "--id", a.id, "--category", "Mine"], {
        extraEnv: asPat(),
      });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /plinth: Only the owner sets an artifact's category/);
      assert.match(r.stderr, /without --category/);
      assert.equal(a.versions.length, 1);
    } finally {
      fake.state.notOwner = false;
    }
  });

  it("turns line breaks and separators into a space, as the server stores them", async () => {
    const r = await plinth(
      ["publish", build(site(1)), "--json", "--category", "acme\u2028site\nweb"],
      {
        extraEnv: asPat(),
      },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.state.lastUploadInput.category, "acme site web");
  });

  it("says the category was not applied when the folder already matches and nothing is sent", async () => {
    const a = fake.seed(site(1));
    const from = fake.state.requests.length;
    const r = await plinth(
      ["publish", build(site(1)), "--id", a.id, "--base-version", "1", "--category", "Acme site"],
      { extraEnv: asPat() },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /nothing to publish/);
    assert.match(r.stderr, /--category was not applied, since nothing was sent/);
    assert.equal(since(from).filter((q) => q.method === "PUT" || q.method === "POST").length, 0);
    assert.equal(a.category, undefined);
    const json = await plinth(
      [
        "publish",
        build(site(1)),
        "--id",
        a.id,
        "--base-version",
        "1",
        "--json",
        "--category",
        "Acme site",
      ],
      { extraEnv: asPat() },
    );
    assert.equal(json.code, 0, json.stderr);
    assert.match(json.stderr, /--category was not applied/);
    assert.ok(!("category" in JSON.parse(json.stdout)));
  });

  it("reads the stored category back when a publish's answer was lost", async () => {
    fake.state.dropBundle = "after";
    const r = await plinth(["publish", build(site(3)), "--json", "--category", "Acme site"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.recovered, true);
    assert.equal(out.category, "Acme site");
  });

  it("reads the stored category back when an inline update's answer was lost", async () => {
    const a = fake.seed(site(2));
    fake.state.dropPut = "after";
    const r = await plinth(
      [
        "publish",
        build({ ...site(2), "assets/a1.js": "console.log('cat');" }),
        "--id",
        a.id,
        "--json",
        "--category",
        "Acme site",
      ],
      { extraEnv: asPat() },
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.recovered, true);
    assert.equal(out.category, "Acme site");
  });

  it("leaves category out of every body when the flag is absent", async () => {
    const a = fake.seed(site(1));
    const r = await plinth(["publish", build(site(1)), "--id", a.id, "--json"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!("category" in fake.state.lastPut));
    assert.ok(!("category" in JSON.parse(r.stdout)));
  });
});

describe("plinth upload", () => {
  async function ticket(input = {}) {
    const res = await fetch(`${fake.origin}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  }

  it("sends the folder with PLINTH_UPLOAD_TOKEN and prints the BundleResult", async () => {
    const t = await ticket({ type: "html" });
    const r = await plinth(["upload", build(site(2)), "--to", t.upload_url], {
      extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 1);
    assert.equal(out.bundle.entries, 3);
    assert.match(r.stderr, /Published v1: /);
  });

  it("sends a deck's folder (slides.md at its top) for a slides ticket", async () => {
    const t = await ticket({ type: "slides" });
    const dir = build({ "slides.md": "# Talk\n\n---\n\n## Two\n", "img/c.png": "png" });
    const r = await plinth(["upload", dir, "--to", t.upload_url], {
      extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.type, "slides");
    assert.equal(out.bundle.entries, 2);
    const stored = fake.state.artifacts.get(out.id).versions[0];
    assert.deepEqual([...stored.keys()].sort(), ["img/c.png", "slides.md"]);
  });

  it("refuses an http or wrong-path --to, and a missing token", async () => {
    const t = await ticket({ type: "html" });
    const dir = build(site(1));
    const tokenEnv = { extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token } };
    for (const to of [
      "http://plinth.example.com/api/v1/uploads/abcdefghij0123456789/bundle",
      `${fake.origin}/api/v1/artifacts`,
      `${fake.origin}/api/v1/uploads/abcdefghij0123456789/bundle?x=1`,
      "https://user:pw@plinth.example.com/api/v1/uploads/abcdefghij0123456789/bundle",
    ]) {
      const r = await plinth(["upload", dir, "--to", to], tokenEnv);
      assert.equal(r.code, 2, `${to}: ${r.stderr}`);
      assert.match(r.stderr, /Refusing the upload URL/);
    }
    const none = await plinth(["upload", dir, "--to", t.upload_url]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /PLINTH_UPLOAD_TOKEN/);
  });

  it("exits 3 when the artifact moved past the ticket's base", async () => {
    const a = fake.seed(site(1));
    const t = await ticket({ id: a.id, base_version: 1 });
    fake.bump(a);
    const r = await plinth(["upload", build(site(1)), "--to", t.upload_url], {
      extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
    });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /changed since start_upload \(now v2\)/);
  });
});

describe("a lost response", () => {
  async function ticket(input = {}) {
    const res = await fetch(`${fake.origin}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return res.json();
  }
  const bundles = (from) => since(from).filter((q) => q.path.endsWith("/bundle"));
  const statusReads = (from) =>
    since(from).filter(
      (q) => q.method === "GET" && /^\/api\/v1\/uploads\/[a-z0-9]{20}$/.test(q.path),
    );
  const bigFolder = () => ({
    "index.html": "<title>big</title>",
    "small.js": "2",
    "one.bin": randomBytes(13 * 1024 * 1024),
    "two.bin": randomBytes(13 * 1024 * 1024),
  });

  it("publish: the server commits, then drops the connection; it reports that version and sends nothing twice", async () => {
    const before = fake.state.artifacts.size;
    const commits = fake.state.bundleCommits ?? 0;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "after";
    const r = await plinth(["publish", build(site(3)), "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 1);
    assert.equal(out.verified, true);
    assert.equal(out.recovered, true);
    assert.match(out.url, /\/a\/page-/);
    assert.match(r.stderr, /answer was lost/);
    assert.equal(bundles(from).length, 1);
    assert.equal(fake.state.bundleCommits, commits + 1);
    assert.equal(fake.state.artifacts.size, before + 1);
    // It asked the ticket's status with the upload token, on the same origin, before anything else.
    const status = statusReads(from);
    assert.equal(status.length, 1);
    assert.match(status[0].authorization, /^Bearer plinth_up_/);
    for (const q of since(from).filter((x) => !x.path.startsWith("/api/v1/uploads/")))
      assert.ok(!q.authorization?.includes("plinth_up_"), q.path);
  });

  it("publish: a status read that fails at first is tried again, so the commit is still found", async () => {
    const before = fake.state.artifacts.size;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "after";
    fake.state.statusFail = 2;
    try {
      const r = await plinth(["publish", build(site(3)), "--json"], { extraEnv: asPat() });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).recovered, true);
      assert.equal(statusReads(from).length, 3);
      assert.equal(fake.state.artifacts.size, before + 1);
    } finally {
      fake.state.statusFail = 0;
    }
  });

  it("publish: when the status never reads, it names the reserved artifact id and the upload id", async () => {
    const before = fake.state.artifacts.size;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "after";
    fake.state.statusFail = Number.POSITIVE_INFINITY;
    let r;
    try {
      r = await plinth(["publish", build(site(3)), "--json"], { extraEnv: asPat() });
    } finally {
      fake.state.statusFail = 0;
    }
    assert.equal(r.code, 1, r.stderr);
    const uploadId = /\/api\/v1\/uploads\/([a-z0-9]{20})$/.exec(statusReads(from)[0].path)[1];
    const reserved = fake.state.tickets.get(uploadId).reserved;
    assert.match(r.stderr, new RegExp(`artifact ${reserved}`));
    assert.match(r.stderr, new RegExp(uploadId));
    assert.match(r.stderr, /HTTP 503/);
    assert.deepEqual(JSON.parse(r.stdout), {
      published: "unknown",
      id: reserved,
      upload_id: uploadId,
    });
    assert.ok(statusReads(from).length > 1, "the status read is retried");
    assert.equal(fake.state.artifacts.size, before + 1);
  });

  it("publish: dropped before the commit, it says nothing was published (exit 1) and does not resend", async () => {
    const before = fake.state.artifacts.size;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "before";
    const r = await plinth(["publish", build(site(2))], { extraEnv: asPat() });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /nothing was published/i);
    assert.equal(bundles(from).length, 1);
    assert.equal(statusReads(from).length, 1);
    assert.equal(fake.state.artifacts.size, before);
  });

  it("publish: a connection lost while the bundle is still being sent fails at once, with no status check", async () => {
    const before = fake.state.artifacts.size;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "midway";
    const r = await plinth(["publish", build(bigFolder())], { extraEnv: asPat() });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /did not arrive in full, so nothing was published/);
    assert.equal(statusReads(from).length, 0);
    assert.equal(fake.state.artifacts.size, before);
  });

  it("publish --id, big update: a conflict whose answer was lost still exits 3", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const from = fake.state.requests.length;
    fake.state.bumpBeforeBundle = () => fake.bump(a);
    fake.state.dropBundle = "after";
    try {
      const r = await plinth(["publish", build(bigFolder()), "--id", a.id], { extraEnv: asPat() });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, new RegExp(`${a.id} changed since v1`));
    } finally {
      fake.state.bumpBeforeBundle = null;
      fake.state.dropBundle = null;
    }
    assert.equal(bundles(from).length, 1);
    assert.equal(a.versions.length, 2);
  });

  it("publish --id, inline: the PUT commits and the answer is lost; it reads the artifact and reports v2, one PUT", async () => {
    const a = fake.seed(site(2));
    const dir = build({ ...site(2), "assets/a1.js": "console.log('new');" });
    const from = fake.state.requests.length;
    fake.state.dropPut = "after";
    const r = await plinth(["publish", dir, "--id", a.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 2);
    assert.equal(out.verified, true);
    assert.equal(out.recovered, true);
    assert.equal(since(from).filter((q) => q.method === "PUT").length, 1);
    assert.equal(a.versions.length, 2);
  });

  it("publish --id, inline: the PUT commits just after the connection broke; it finds that version", async () => {
    const a = fake.seed(site(2));
    const dir = build({ ...site(2), "assets/a1.js": "console.log('late');" });
    const from = fake.state.requests.length;
    fake.state.dropPut = "late";
    const r = await plinth(["publish", dir, "--id", a.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 2);
    assert.equal(out.recovered, true);
    assert.equal(since(from).filter((q) => q.method === "PUT").length, 1);
    assert.equal(a.versions.length, 2);
  });

  describe("publish --id --base-version N exits 0 in exactly two cases", () => {
    const writes = (from) => since(from).filter((q) => q.method === "PUT" || q.method === "POST");
    const rerun = (dir, a, extra = []) =>
      plinth(["publish", dir, "--id", a.id, "--base-version", "1", ...extra], {
        extraEnv: asPat(),
      });

    it("(a) current is N+1 and equals the folder: already published as N+1, nothing sent", async () => {
      const a = fake.seed(site(2));
      const dir = build({ ...site(2), "assets/a1.js": "console.log('landed');" });
      const first = await plinth(["publish", dir, "--id", a.id], { extraEnv: asPat() });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(a.versions.length, 2);
      const from = fake.state.requests.length;
      // The rerun a lost answer suggests, after that update landed anyway.
      const r = await rerun(dir, a);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /already published as v2/);
      assert.match(r.stderr, /nothing was sent/i);
      assert.equal(writes(from).length, 0);
      assert.equal(a.versions.length, 2);
      const json = await rerun(dir, a, ["--json"]);
      assert.equal(json.code, 0, json.stderr);
      assert.deepEqual(
        { ...JSON.parse(json.stdout), url: undefined },
        {
          id: a.id,
          slug: a.slug,
          version: 2,
          url: undefined,
          verified: true,
          unchanged: true,
          outcome: "already_published",
        },
      );
    });

    it("(b) current is N and equals the folder: nothing to publish, nothing sent", async () => {
      const a = fake.seed(site(2));
      const dir = build(site(2));
      const from = fake.state.requests.length;
      const r = await rerun(dir, a);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /v1 already matches this folder: nothing to publish/);
      assert.equal(writes(from).length, 0);
      assert.equal(a.versions.length, 1);
      const json = await rerun(dir, a, ["--json"]);
      assert.equal(JSON.parse(json.stdout).outcome, "nothing_to_publish");
      assert.equal(JSON.parse(json.stdout).version, 1);
    });

    it("current is N+1 with different files: a conflict (exit 3), nothing sent", async () => {
      const a = fake.seed(site(2));
      fake.bump(a);
      const from = fake.state.requests.length;
      const r = await rerun(build(site(2)), a);
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, new RegExp(`${a.id} changed since v1 \\(now v2\\)`));
      assert.equal(writes(from).length, 0);
    });

    it("current is N+2 with the folder's files: a conflict (exit 3), since N+1 was someone else's", async () => {
      const a = fake.seed(site(2));
      const files = { ...site(2), "assets/a1.js": "console.log('mine');" };
      fake.bump(a);
      fake.commitFiles(a, files);
      assert.equal(a.versions.length, 3);
      const from = fake.state.requests.length;
      const r = await rerun(build(files), a);
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, /changed since v1 \(now v3\)/);
      assert.equal(writes(from).length, 0);
      assert.equal(a.versions.length, 3);
    });

    it("current is N with different files: it publishes N+1 as usual", async () => {
      const a = fake.seed(site(2));
      const dir = build({ ...site(2), "assets/a1.js": "console.log('new');" });
      const r = await rerun(dir, a, ["--json"]);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.version, 2);
      assert.equal(out.verified, true);
      assert.equal(out.outcome, undefined);
      assert.equal(a.versions.length, 2);
    });
  });

  it("publish --id, inline: lost before the commit, it says nothing was published (exit 1)", async () => {
    const a = fake.seed(site(2));
    const dir = build({ ...site(2), "assets/a1.js": "console.log('new');" });
    fake.state.dropPut = "before";
    const r = await plinth(["publish", dir, "--id", a.id], { extraEnv: asPat() });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /nothing was published/i);
    // A rerun states the base, so a commit that still lands late stops it (exit 3), never twice.
    assert.match(r.stderr, /--base-version 1/);
    assert.equal(a.versions.length, 1);
  });

  it("publish --id, big update: when the status never reads, it names the base and the rerun that cannot publish twice", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const dir = build(bigFolder());
    const from = fake.state.requests.length;
    fake.state.dropBundle = "after";
    fake.state.statusFail = Number.POSITIVE_INFINITY;
    let r;
    try {
      r = await plinth(["publish", dir, "--id", a.id, "--json"], { extraEnv: asPat() });
    } finally {
      fake.state.statusFail = 0;
    }
    assert.equal(r.code, 1, r.stderr);
    const uploadId = /\/api\/v1\/uploads\/([a-z0-9]{20})$/.exec(statusReads(from)[0].path)[1];
    assert.deepEqual(JSON.parse(r.stdout), {
      published: "unknown",
      id: a.id,
      upload_id: uploadId,
      base_version: 1,
    });
    assert.match(r.stderr, /--base-version 1/);
    assert.equal(a.versions.length, 2);
    // The rerun it names, once the lost commit is visible: exit 0, nothing sent.
    const at = fake.state.requests.length;
    const again = await plinth(["publish", dir, "--id", a.id, "--base-version", "1"], {
      extraEnv: asPat(),
    });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(since(at).filter((q) => q.method === "PUT" || q.method === "POST").length, 0);
    assert.equal(a.versions.length, 2);
  });

  it("publish --id, inline: when the artifact cannot be read after a lost PUT, --json still says unknown", async () => {
    const a = fake.seed(site(2));
    const dir = build({ ...site(2), "assets/a1.js": "console.log('unread');" });
    fake.state.dropPut = "after";
    fake.state.armReadFail = true;
    let r;
    try {
      r = await plinth(["publish", dir, "--id", a.id, "--json"], { extraEnv: asPat() });
    } finally {
      fake.state.armReadFail = false;
      fake.state.artifactReadFail = 0;
    }
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { published: "unknown", id: a.id, base_version: 1 });
    assert.match(r.stderr, /--base-version 1/);
    assert.equal(a.versions.length, 2);
  });

  it("still receiving after the wait: publish --id and upload print unknown with the ids (and the base) to check", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const t = await ticket({ type: "html" });
    fake.state.dropBundle = "after";
    fake.state.dropBundleSticky = true;
    fake.state.statusReceiving = true;
    let pub;
    let up;
    try {
      // Both wait out the 30 s status window, so they run side by side.
      [pub, up] = await Promise.all([
        plinth(["publish", build(bigFolder()), "--id", a.id, "--json"], { extraEnv: asPat() }),
        plinth(["upload", build(site(2)), "--to", t.upload_url], {
          extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
        }),
      ]);
    } finally {
      fake.state.dropBundle = null;
      fake.state.dropBundleSticky = false;
      fake.state.statusReceiving = false;
    }
    assert.equal(pub.code, 1, pub.stderr);
    const out = JSON.parse(pub.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["base_version", "id", "published", "upload_id"]);
    assert.equal(out.published, "unknown");
    assert.equal(out.id, a.id);
    assert.equal(out.base_version, 1);
    assert.match(pub.stderr, /still working on the bundle.*--base-version 1/s);
    assert.equal(up.code, 1, up.stderr);
    assert.deepEqual(JSON.parse(up.stdout), {
      published: "unknown",
      id: t.target.id,
      upload_id: t.upload_id,
    });
  });

  it("a takedown that ended the upload is reported as one: nothing published, no conflict, no resend", async () => {
    const a = fake.seed({ "index.html": "<title>big</title>", "small.js": "1" });
    const from = fake.state.requests.length;
    fake.state.dropBundle = "before";
    fake.state.statusState = "taken_down";
    try {
      const r = await plinth(["publish", build(bigFolder()), "--id", a.id], { extraEnv: asPat() });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /taken down/);
      assert.match(r.stderr, /nothing was published/i);
      assert.doesNotMatch(r.stderr, /changed since|Run the same command again/);
      assert.equal(bundles(from).length, 1);
    } finally {
      fake.state.statusState = null;
      fake.state.dropBundle = null;
    }
  });

  it("upload: the server commits, then drops the connection; it prints the existing version and does not publish twice", async () => {
    const t = await ticket({ type: "html" });
    const before = fake.state.artifacts.size;
    const from = fake.state.requests.length;
    fake.state.dropBundle = "after";
    const r = await plinth(["upload", build(site(2)), "--to", t.upload_url], {
      extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.id, t.target.id);
    assert.equal(out.version, 1);
    assert.equal(out.recovered, true);
    assert.match(out.url, /\/a\/page-/);
    assert.match(r.stderr, /Published v1: .*answer was lost/s);
    assert.equal(bundles(from).length, 1);
    assert.equal(statusReads(from).length, 1);
    assert.equal(fake.state.artifacts.size, before + 1);

    // Running it again is safe too: the used ticket is refused, and still nothing is added.
    const again = await plinth(["upload", build(site(2)), "--to", t.upload_url], {
      extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
    });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already published/);
    assert.equal(fake.state.artifacts.size, before + 1);
  });

  it("upload: a conflict whose answer was lost exits 3", async () => {
    const a = fake.seed(site(1));
    const t = await ticket({ id: a.id, base_version: 1 });
    fake.state.bumpBeforeBundle = () => fake.bump(a);
    fake.state.dropBundle = "after";
    try {
      const r = await plinth(["upload", build(site(1)), "--to", t.upload_url], {
        extraEnv: { PLINTH_UPLOAD_TOKEN: t.upload_token },
      });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, /changed since start_upload/);
    } finally {
      fake.state.bumpBeforeBundle = null;
      fake.state.dropBundle = null;
    }
  });
});

describe("origin and credentials", () => {
  it("never sends PLINTH_TOKEN to another --url (exit 2) and never writes it to disk", async () => {
    const r = await plinth(["whoami", "--url", "https://other.example"], {
      extraEnv: { PLINTH_TOKEN: PAT },
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /PLINTH_TOKEN belongs to https:\/\/plinth\.aconite\.io/);
    const bound = await plinth(["whoami", "--url", "http://localhost:1"], { extraEnv: asPat() });
    assert.equal(bound.code, 2);

    const ok = await plinth(["whoami"], { extraEnv: asPat() });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /owner@example\.com on .* \(PLINTH_TOKEN\)/);
    const files = readdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    for (const f of files) {
      const abs = path.join(env.XDG_CONFIG_HOME, f);
      if (statSync(abs).isFile()) assert.ok(!readFileSync(abs, "utf8").includes(PAT), f);
    }
  });

  /** A Plinth home with one local instance "dev" on the fake server's address. */
  function homeWithDev(name = "dev") {
    const home = path.join(work, `home-${randomBytes(3).toString("hex")}`);
    const port = new URL(fake.origin).port;
    mkdirSync(path.join(home, name), { recursive: true });
    writeFileSync(path.join(home, name, "instance.json"), JSON.stringify({ name, port }));
    writeFileSync(
      path.join(home, name, "wrangler.jsonc"),
      `{ "vars": { "APP_HOST": "127.0.0.1:${port}", "PUBLIC_SCHEME": "http" } }`,
    );
    return home;
  }

  it("lets --name and --home win over PLINTH_URL and PLINTH_TOKEN, never sending the token", () => {
    const home = homeWithDev();
    const dev = { origin: fake.origin, source: 'local instance "dev"' };
    const none = { PLINTH_HOME: path.join(work, "no-instances") };
    // --name picks the local instance even with PLINTH_URL set.
    assert.deepEqual(
      resolveOrigin({ name: "dev", home }, { ...none, PLINTH_URL: "https://other.example" }),
      { ...dev, envToken: null, note: null },
    );
    // A token bound elsewhere (the hosted instance, or PLINTH_URL's) is refused, not ignored.
    for (const env of [
      { PLINTH_TOKEN: PAT },
      { PLINTH_TOKEN: PAT, PLINTH_URL: "https://other.example" },
    ]) {
      for (const opts of [{ name: "dev", home }, { home: homeWithDev("plinth") }]) {
        assert.throws(
          () => resolveOrigin(opts, { ...none, ...env }),
          (e) =>
            e.exitCode === 2 &&
            /PLINTH_TOKEN belongs to https:\/\/(plinth\.aconite\.io|other\.example)/.test(
              e.message,
            ) &&
            e.message.includes(`never sent to ${fake.origin}`),
        );
      }
    }
    // A token bound to that very instance is used there.
    assert.deepEqual(
      resolveOrigin({ name: "dev", home }, { PLINTH_TOKEN: PAT, PLINTH_URL: fake.origin }),
      { ...dev, envToken: PAT, note: null },
    );
    // Without a flag the order holds: PLINTH_URL, then the local instance, then hosted.
    const implicit = resolveOrigin({}, { PLINTH_HOME: home, PLINTH_TOKEN: PAT });
    assert.equal(implicit.origin, fake.origin);
    assert.equal(implicit.envToken, null);
    assert.match(implicit.note, /PLINTH_TOKEN belongs to https:\/\/plinth\.aconite\.io/);
    assert.equal(
      resolveOrigin({}, { ...none, PLINTH_TOKEN: PAT }).envToken,
      PAT,
      "hosted, with the token",
    );
  });

  it("does not send PLINTH_TOKEN to a local instance picked without a flag", async () => {
    const home = homeWithDev();
    const from = fake.state.requests.length;
    const r = await plinth(["whoami"], { extraEnv: { PLINTH_HOME: home, PLINTH_TOKEN: PAT } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`plinth: ${fake.origin} \\(local instance "dev"\\)`));
    assert.match(
      r.stderr,
      /PLINTH_TOKEN belongs to https:\/\/plinth\.aconite\.io, so it is not used/,
    );
    assert.match(r.stderr, /Not signed in on/);
    for (const q of since(from)) assert.ok(!q.authorization?.includes(PAT), q.path);
    const named = await plinth(["whoami", "--name", "dev", "--home", home], {
      extraEnv: { PLINTH_TOKEN: PAT },
    });
    assert.equal(named.code, 2, named.stderr);
  });

  it("picks the single local instance, refuses to guess between several, else the hosted one", async () => {
    const home = path.join(work, `home-${randomBytes(3).toString("hex")}`);
    const port = new URL(fake.origin).port;
    mkdirSync(path.join(home, "dev"), { recursive: true });
    writeFileSync(
      path.join(home, "dev", "instance.json"),
      JSON.stringify({ name: "dev", mode: "local", port }),
    );
    writeFileSync(
      path.join(home, "dev", "wrangler.jsonc"),
      `{ // local\n "vars": { "APP_HOST": "127.0.0.1:${port}", "PUBLIC_SCHEME": "http", },\n}`,
    );
    const one = await plinth(["whoami"], { extraEnv: { PLINTH_HOME: home } });
    assert.match(one.stderr, new RegExp(`plinth: ${fake.origin} \\(local instance "dev"\\)`));
    assert.equal(one.code, 1);
    assert.match(one.stderr, /Not signed in on/);

    mkdirSync(path.join(home, "other", "cloudflare"), { recursive: true });
    writeFileSync(
      path.join(home, "other", "cloudflare", "deploy.json"),
      JSON.stringify({ appHost: "plinth.example.com" }),
    );
    const two = await plinth(["whoami"], { extraEnv: { PLINTH_HOME: home } });
    assert.equal(two.code, 2);
    assert.match(two.stderr, /Several instances .*dev, other/);
    const named = await plinth(["whoami", "--name", "other"], { extraEnv: { PLINTH_HOME: home } });
    assert.match(
      named.stderr,
      /plinth: https:\/\/plinth\.example\.com \(cloudflare instance "other"\)/,
    );
    const missing = await plinth(["whoami", "--name", "nope"], { extraEnv: { PLINTH_HOME: home } });
    assert.equal(missing.code, 2);

    const hosted = await plinth(["whoami"]);
    assert.match(hosted.stderr, /plinth: https:\/\/plinth\.aconite\.io \(hosted\)/);
    assert.equal(hosted.code, 1);
  });

  it("explains a Cloudflare edge block (error code: 1010)", async () => {
    fake.state.edgeBlock = true;
    try {
      const r = await plinth(["whoami"], { extraEnv: asPat() });
      assert.equal(r.code, 1);
      assert.match(
        r.stderr,
        /Blocked by the Cloudflare edge before Plinth \(Browser Integrity Check\)\. The operator should apply docs\/deploy-checklist\.md#edge-security-for-api-clients/,
      );
    } finally {
      fake.state.edgeBlock = false;
    }
  });

  it("refuses to follow a redirect from the API", async () => {
    fake.state.redirectApi = true;
    try {
      const r = await plinth(["whoami"], { extraEnv: asPat() });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /answered with a redirect; plinth does not follow redirects/);
    } finally {
      fake.state.redirectApi = false;
    }
  });

  it("signs in as Plinth CLI, keeps cli-<host>.json 0600 in a 0700 folder, and signs out", async () => {
    let opened = false;
    const login = await plinth(["login", "--url", fake.origin, "--no-browser"], {
      onStderr: (text) => {
        const url = text.split("\n").find((l) => l.includes("/oauth/authorize?"));
        if (url && !opened) {
          opened = true;
          fetch(url).catch(() => {});
        }
      },
    });
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Signed in to .* as owner@example\.com \(connection "Plinth CLI"\)/);
    const client = [...fake.state.clients.values()].at(-1);
    assert.equal(client.name, "Plinth CLI");
    assert.equal(fake.state.lastAuthorize.scope, "artifacts:read artifacts:write");
    const dir = path.join(env.XDG_CONFIG_HOME, "plinth");
    const file = path.join(dir, `cli-127.0.0.1_${new URL(fake.origin).port}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const who = await plinth(["whoami", "--url", fake.origin]);
    assert.equal(who.code, 0, who.stderr);
    assert.match(who.stdout, /signed in as Plinth CLI/);
    const out = await plinth(["logout", "--url", fake.origin]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Signed out of/);
    const again = await plinth(["whoami", "--url", fake.origin]);
    assert.equal(again.code, 1);
  });

  it("says to sign in again when the connection was revoked while the token looked fresh", async () => {
    let opened = false;
    const login = await plinth(["login", "--url", fake.origin, "--no-browser"], {
      onStderr: (text) => {
        const url = text.split("\n").find((l) => l.includes("/oauth/authorize?"));
        if (url && !opened) {
          opened = true;
          fetch(url).catch(() => {});
        }
      },
    });
    assert.equal(login.code, 0, login.stderr);
    // Revoked on the Connections page: the access token is refused, and so is the refresh.
    for (const g of fake.state.grants.values()) g.revoked = true;
    const who = await plinth(["whoami", "--url", fake.origin]);
    assert.equal(who.code, 1, who.stderr);
    assert.match(
      who.stderr,
      new RegExp(`The sign-in was revoked or expired on ${fake.origin}\\. Run: plinth login --url`),
    );
    assert.doesNotMatch(who.stderr, /Body is unusable|already been read/);
  });

  it("orders Claude Code like the Connect panel: the plugin first, set to this instance", () => {
    // A stand-in for runtime/harnesses.mjs (packages/shared/src/harnesses.ts), so this runs
    // without a build; connectClients.test.ts checks the real commands.
    const reg = {
      HOSTED_ORIGIN,
      CLAUDE_CODE_PLUGIN_CONFIGURE: "/plugin configure plinth@plinth",
      claudeCodePluginCommands: (origin = HOSTED_ORIGIN) => [
        origin === HOSTED_ORIGIN
          ? "claude plugin install plinth@plinth"
          : `claude plugin install plinth@plinth --config instance_url=${origin}`,
      ],
      claudeCodeCommand: (endpoint) => `claude mcp add --transport http plinth ${endpoint}`,
    };
    const own = claudeCodeConnectText(reg, "http://localhost:8787");
    const pluginAt = own.indexOf(
      "claude plugin install plinth@plinth --config instance_url=http://localhost:8787",
    );
    const bareAt = own.indexOf("claude mcp add --transport http plinth http://localhost:8787/mcp");
    assert.ok(pluginAt >= 0 && pluginAt < bareAt, own);
    assert.match(own, /set to this instance/);
    assert.match(
      own,
      /\/plugin configure plinth@plinth in Claude Code\)\. Restart Claude Code afterwards\./,
    );
    assert.match(own, /Or tools only, without Plinth's rules/);
    assert.match(own, /Use one or the other/);
    assert.doesNotMatch(own, /PLINTH_URL/);
    const hosted = claudeCodeConnectText(reg, HOSTED_ORIGIN);
    assert.doesNotMatch(hosted, /--config|PLINTH_URL|configure/);
    assert.ok(hosted.indexOf("claude plugin install") < hosted.indexOf("claude mcp add"), hosted);
    assert.match(hosted, /Or tools only, without Plinth's rules/);
    // The plugin's server really does follow the option, with the hosted instance as its default
    // and PLINTH_URL still taking precedence.
    const root = path.resolve(pkgDir, "../..");
    const mcp = readFileSync(path.join(root, "integrations/plugin/.mcp.json"), "utf8");
    assert.ok(mcp.includes(`\${PLINTH_URL:-\${user_config.instance_url}}/mcp`), mcp);
    const manifest = JSON.parse(
      readFileSync(path.join(root, "integrations/plugin/.claude-plugin/plugin.json"), "utf8"),
    );
    assert.equal(manifest.userConfig.instance_url.default, HOSTED_ORIGIN);
  });

  it("runs from a copy without runtime/ or wrangler", async () => {
    const copy = path.join(work, `pkg-${randomBytes(3).toString("hex")}`);
    cpSync(path.join(pkgDir, "bin"), path.join(copy, "bin"), { recursive: true });
    cpSync(path.join(pkgDir, "package.json"), path.join(copy, "package.json"));
    const r = await plinth(["whoami"], {
      extraEnv: asPat(),
      bin: path.join(copy, "bin", "plinth.mjs"),
    });
    assert.equal(r.code, 0, r.stderr);
    const runtimeCmd = await plinth(["status"], { bin: path.join(copy, "bin", "plinth.mjs") });
    assert.equal(runtimeCmd.code, 1);
    assert.match(runtimeCmd.stderr, /no runtime\/ folder/);
  });

  it("keeps HOSTED_ORIGIN equal to packages/shared/src/harnesses.ts", () => {
    const src = readFileSync(path.resolve(pkgDir, "../shared/src/harnesses.ts"), "utf8");
    assert.equal(/HOSTED_ORIGIN = "([^"]+)"/.exec(src)?.[1], HOSTED_ORIGIN);
  });

  it("uses exit code 2 for usage errors", async () => {
    for (const args of [
      ["publish"],
      ["publish", "a", "b"],
      ["whoami", "--bogus"],
      ["publish", "--id"],
    ]) {
      const r = await plinth(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  });
});

describe("reporting", () => {
  it("treats not_scanned as a note, never as a warning to fix", () => {
    const w = [
      {
        code: "missing_file",
        file: "index.html",
        ref: "a.js",
        message: "a.js is not in the version",
      },
      { code: "not_scanned", file: "c1.js", count: 166, message: "166 files were not checked" },
    ];
    const { fix, notes } = splitWarnings(w);
    assert.deepEqual(
      fix.map((x) => x.code),
      ["missing_file"],
    );
    assert.deepEqual(
      notes.map((x) => x.code),
      ["not_scanned"],
    );
    assert.deepEqual(splitWarnings(undefined), { fix: [], notes: [] });
  });

  it("treats live_draft as a note too: nothing was overwritten and nothing needs a fix", () => {
    const w = [
      { code: "live_draft", file: "content.md", message: "Nothing was overwritten." },
      { code: "blocked_host", file: "content.md", message: "evil.example is blocked" },
    ];
    const { fix, notes } = splitWarnings(w);
    assert.deepEqual(
      fix.map((x) => x.code),
      ["blocked_host"],
    );
    assert.deepEqual(
      notes.map((x) => x.code),
      ["live_draft"],
    );
  });

  it('names a version conflict whether or not the server gives reason "conflict"', () => {
    const err = (details) => new ApiError(409, "conflict", "Not current", details);
    assert.equal(isVersionConflict(err({ current_version: 2 })), true);
    assert.equal(isVersionConflict(err({ current_version: 2, reason: "conflict" })), true);
    for (const reason of ["upload_used", "upload_dead", "upload_running"])
      assert.equal(isVersionConflict(err({ reason })), false, reason);
    assert.equal(isVersionConflict(new ApiError(400, "invalid_input", "x", {})), false);
  });

  it("suggests leaving out source maps only when the folder sends some", () => {
    const limits = {
      max_assets_per_version: 2,
      max_html_bytes: 5 * 1024 * 1024,
      max_doc_bytes: 5 * 1024 * 1024,
      max_version_bytes: 50 * 1024 * 1024,
      max_bundle_file_bytes: 25 * 1024 * 1024,
    };
    const file = (p) => ({ path: p, size: 10 });
    const without = [file("index.html"), file("a.js"), file("b.js"), file("c.js")];
    assert.throws(
      () => checkLimits(without, "index.html", "html", limits),
      (e) =>
        !/source maps/.test(e.message) && /MAX_ASSETS_PER_VERSION \(up to 900\)/.test(e.message),
    );
    const withMaps = [...without, file("a.js.map")];
    assert.throws(
      () => checkLimits(withMaps, "index.html", "html", limits),
      /Leave out source maps \(drop --include-maps\)/,
    );
  });
});

describe("plinth publish for CI: one file, bound tokens, --json failures", () => {
  /** One file in a fresh folder. */
  function oneFile(name, content) {
    const dir = mkdtempSync(path.join(work, "file-"));
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  }
  const reset = () => {
    fake.state.boundArtifact = undefined;
  };

  it("publishes report.html as index.html and notes.md as a doc", async () => {
    reset();
    const html = oneFile("report.html", "<!doctype html><title>Report</title><p>ok</p>");
    const r = await plinth(["publish", html, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const a = fake.state.artifacts.get(out.id);
    assert.equal(a.type, "html");
    assert.deepEqual([...a.versions[0].keys()], ["index.html"]);
    assert.equal(out.verified, true);

    const md = oneFile("NOTES.MD", "# Notes\n");
    const d = await plinth(["publish", md, "--json"], { extraEnv: asPat() });
    assert.equal(d.code, 0, d.stderr);
    const doc = fake.state.artifacts.get(JSON.parse(d.stdout).id);
    assert.equal(doc.type, "doc");
    assert.deepEqual([...doc.versions[0].keys()], ["content.md"]);

    // An update of a page from one file.
    const next = oneFile("index.htm", "<!doctype html><title>Report</title><p>v2</p>");
    const u = await plinth(["publish", next, "--id", out.id, "--json"], { extraEnv: asPat() });
    assert.equal(u.code, 0, u.stderr);
    assert.equal(JSON.parse(u.stdout).version, 2);
  });

  it("names the file a page or document needs when the source does not match (--id)", async () => {
    reset();
    const page = fake.seed({ "index.html": "<p>one</p>" });
    const from = fake.state.requests.length;
    const md = oneFile("notes.md", "# Notes\n");
    const r = await plinth(["publish", md, "--id", page.id, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.outcome, "error");
    assert.equal(
      out.message,
      `${page.id} is a page; publish a .html file (or a folder with index.html at its top)`,
    );
    const folder = build({ "other.html": "<p>x</p>" });
    const f = await plinth(["publish", folder, "--id", page.id], { extraEnv: asPat() });
    assert.equal(f.code, 1, f.stderr);
    assert.match(
      f.stderr,
      new RegExp(`${page.id} is a page; the folder needs index\\.html at its top`),
    );
    assert.doesNotMatch(f.stderr, /before initialization/);
    // Only the reads: nothing was sent.
    assert.ok(since(from).every((q) => q.method === "GET"));
  });

  it("refuses another extension (exit 2) and a file reached through a link", async () => {
    reset();
    const txt = oneFile("x.txt", "hello");
    const from = fake.state.requests.length;
    const r = await plinth(["publish", txt], { extraEnv: asPat() });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /a build folder, or one \.html, \.md, \.csv or \.xlsx file/);
    const real = oneFile("real.html", "<!doctype html><p>x</p>");
    const link = path.join(path.dirname(real), "report.html");
    symlinkSync(real, link);
    const l = await plinth(["publish", link], { extraEnv: asPat() });
    assert.equal(l.code, 2, l.stderr);
    assert.match(l.stderr, /symbolic link/);
    assert.equal(since(from).length, 0);
  });

  it("--json prints a failure object: a conflict (exit 3, current_version) and a usage error", async () => {
    reset();
    const a = fake.seed({ "index.html": "<p>one</p>" });
    fake.bump(a);
    const dir = build({ "index.html": "<p>mine</p>" });
    const r = await plinth(["publish", dir, "--id", a.id, "--base-version", "1", "--json"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 3, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), [
      "current_version",
      "exit_code",
      "message",
      "ok",
      "outcome",
    ]);
    assert.equal(out.ok, false);
    assert.equal(out.exit_code, 3);
    assert.equal(out.outcome, "conflict");
    assert.equal(out.current_version, 2);

    // The server's own conflict (someone published between the read and the PUT).
    const b = fake.seed({ "index.html": "<p>one</p>" });
    fake.state.bumpBeforePut = () => fake.bump(b);
    const s = await plinth(["publish", dir, "--id", b.id, "--json"], { extraEnv: asPat() });
    assert.equal(s.code, 3, s.stderr);
    assert.deepEqual(JSON.parse(s.stdout), {
      ok: false,
      exit_code: 3,
      outcome: "conflict",
      message: JSON.parse(s.stdout).message,
      current_version: 2,
    });

    const u = await plinth(["publish", "--json"], { extraEnv: asPat() });
    assert.equal(u.code, 2);
    assert.deepEqual(
      (({ ok, exit_code, outcome }) => ({ ok, exit_code, outcome }))(JSON.parse(u.stdout)),
      { ok: false, exit_code: 2, outcome: "usage" },
    );
    // Without --json, stdout stays empty on failure, as before.
    const quiet = await plinth(["publish", txtLike()], { extraEnv: asPat() });
    assert.equal(quiet.code, 2);
    assert.equal(quiet.stdout, "");
  });

  it("a token limited to one artifact publishes that artifact's next version without --id", async () => {
    const a = fake.seed({ "index.html": "<p>one</p>" }, "html", "Coverage");
    fake.state.boundArtifact = { id: a.id, slug: a.slug, title: "Coverage" };
    try {
      const dir = build({ "index.html": "<p>two</p>" });
      const r = await plinth(["publish", dir, "--json", "--title", "Ignored", "--note", "n"], {
        extraEnv: asPat(),
      });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.id, a.id);
      assert.equal(out.version, 2);
      assert.equal(out.title, "Coverage");
      assert.match(r.stderr, new RegExp(`PLINTH_TOKEN is limited to ${a.slug}`));
      assert.match(r.stderr, /--title is ignored/);
      assert.equal(fake.state.lastPut.note, "n");

      const who = await plinth(["whoami"], { extraEnv: asPat() });
      assert.equal(who.code, 0, who.stderr);
      assert.match(who.stdout, new RegExp(`limited to ${a.slug} \\("Coverage"\\)`));
      assert.match(who.stdout, /^A token on /);
      assert.doesNotMatch(who.stdout, /undefined/);

      fake.state.boundArtifact = null;
      const gone = await plinth(["publish", dir], { extraEnv: asPat() });
      assert.equal(gone.code, 1);
      assert.match(gone.stderr, /deleted or is no longer shared with you/);
      const whoGone = await plinth(["whoami"], { extraEnv: asPat() });
      assert.match(whoGone.stdout, /limited to an artifact it can no longer open/);
    } finally {
      reset();
    }
  });

  it("an older server (no connection on /me) publishes a new artifact as before", async () => {
    reset();
    const dir = build(site(1));
    const r = await plinth(["publish", dir, "--json"], { extraEnv: asPat() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).version, 1);
  });

  /** A path that does not exist, for a usage error without --json. */
  function txtLike() {
    return path.join(work, "no-such-file.txt");
  }
});
