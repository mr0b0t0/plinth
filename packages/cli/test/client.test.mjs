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
import { claudeCodeConnectText } from "../bin/client/connect.mjs";
import { checkLimits } from "../bin/client/files.mjs";
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

  it("needs index.html (or content.md) at the top of the folder", async () => {
    const r = await plinth(["publish", build({ "dist/index.html": "x" }), "--dry-run"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No index\.html/);
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

  it("publish --id --base-version: when the current version already matches the folder, it sends nothing (exit 0)", async () => {
    const a = fake.seed(site(2));
    const dir = build({ ...site(2), "assets/a1.js": "console.log('landed');" });
    const first = await plinth(["publish", dir, "--id", a.id], { extraEnv: asPat() });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(a.versions.length, 2);
    const from = fake.state.requests.length;
    // The rerun a lost answer suggests, after that update landed anyway.
    const r = await plinth(["publish", dir, "--id", a.id, "--base-version", "1"], {
      extraEnv: asPat(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /already at v2, which matches this folder/);
    assert.equal(since(from).filter((q) => q.method === "PUT" || q.method === "POST").length, 0);
    assert.equal(a.versions.length, 2);
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

  it("orders Claude Code like the Connect panel: plugin first only on the hosted instance", () => {
    const reg = {
      HOSTED_ORIGIN,
      claudeCodePluginCommands: () => ["claude plugin install plinth@plinth"],
      claudeCodeCommand: (endpoint) => `claude mcp add --transport http plinth ${endpoint}`,
    };
    const own = claudeCodeConnectText(reg, "http://localhost:8787");
    const bareAt = own.indexOf("claude mcp add --transport http plinth http://localhost:8787/mcp");
    const exportAt = own.indexOf("export PLINTH_URL=http://localhost:8787");
    const pluginAt = own.indexOf("claude plugin install");
    assert.ok(bareAt >= 0 && bareAt < exportAt, own);
    assert.ok(exportAt < pluginAt, own);
    assert.match(own, /tools only, without Plinth's rules/);
    assert.match(own, /a different instance, unless PLINTH_URL is set every time/);
    assert.match(own, /Use one or the other/);
    const hosted = claudeCodeConnectText(reg, HOSTED_ORIGIN);
    assert.doesNotMatch(hosted, /PLINTH_URL/);
    assert.ok(hosted.indexOf("claude plugin install") < hosted.indexOf("claude mcp add"), hosted);
    assert.match(hosted, /Or tools only, without Plinth's rules/);
    assert.match(hosted, /Use one or the other/);
    // The plugin's server really does default to the hosted instance.
    const mcp = readFileSync(path.resolve(pkgDir, "../../integrations/plugin/.mcp.json"), "utf8");
    assert.ok(mcp.includes(`\${PLINTH_URL:-${HOSTED_ORIGIN}}/mcp`), mcp);
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
