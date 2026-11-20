// The GitHub Action (publish/), run as GitHub runs it (node publish/main.mjs with INPUT_* and the
// GITHUB_* files) against the fake instance: the first run, updates and their notes, conflicts,
// fail-on-warnings, the token's binding, and above all that nothing the server or the artifact
// says is ever read as a workflow command (::stop-commands:: around the client, escaped
// annotations and summary, random heredoc delimiters), and that the token is printed only in
// the mask command.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  actionableWarnings,
  buildArgv,
  conflictAdvice,
  cut,
  defaultNote,
  escapeData,
  escapeMarkdown,
  formatOutputs,
  outcomeOf,
  readInputs,
  SLUG_RE,
  writeOutputFile,
} from "../../../publish/lib.mjs";
import { SLUG_RE as SERVER_SLUG_RE } from "../../shared/src/schemas.ts";
import { PAT, startFakePlinth } from "./helpers/fake-plinth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTION = path.join(root, "publish", "main.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";

let fake;
let work;

before(async () => {
  fake = await startFakePlinth();
  work = mkdtempSync(path.join(tmpdir(), "plinth-action-test-"));
});
after(async () => {
  await fake.close();
  rmSync(work, { recursive: true, force: true });
});

function build(files) {
  const dir = mkdtempSync(path.join(work, "build-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), content);
  }
  return dir;
}

/** Parse a $GITHUB_OUTPUT file (name<<DELIM ... DELIM). */
function parseOutputs(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z][a-z0-9-]*)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const value = [];
    for (i++; lines[i] !== m[2]; i++) {
      assert.ok(i < lines.length, `unterminated output ${m[1]}`);
      value.push(lines[i]);
    }
    out[m[1]] = value.join("\n");
  }
  return out;
}

/** Run the Action with these inputs; resolves with the exit code, its log lines and files. */
function action(inputs, { event = { head_commit: { message: "Add coverage\n\nDetails" } } } = {}) {
  const dir = mkdtempSync(path.join(work, "run-"));
  const files = {
    output: path.join(dir, "output"),
    summary: path.join(dir, "summary"),
    event: path.join(dir, "event.json"),
  };
  writeFileSync(files.output, "");
  writeFileSync(files.summary, "");
  writeFileSync(files.event, JSON.stringify(event));
  const env = {
    PATH: path.dirname(process.execPath),
    HOME: dir,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_EVENT_PATH: files.event,
    GITHUB_SHA: SHA,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/reports",
    GITHUB_RUN_ID: "4242",
    GITHUB_WORKFLOW: "Coverage",
    GITHUB_RUN_NUMBER: "7",
    INPUT_TOKEN: PAT,
    INPUT_URL: fake.origin,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [ACTION], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => {
      stdout += d;
    });
    c.stderr.on("data", (d) => {
      stderr += d;
    });
    c.on("exit", (code) => {
      const outputText = readFileSync(files.output, "utf8");
      resolve({
        code,
        stdout,
        stderr,
        lines: stdout.split("\n").filter((l) => l !== ""),
        outputText,
        outputs: parseOutputs(outputText),
        summary: readFileSync(files.summary, "utf8"),
      });
    });
  });
}

/** The lines before, inside and after the ::stop-commands:: block. */
function blocks(lines) {
  const start = lines.findIndex((l) => /^::stop-commands::[0-9a-f]{32}$/.test(l));
  assert.ok(start >= 0, `no stop-commands line in:\n${lines.join("\n")}`);
  const stop = lines[start].slice("::stop-commands::".length);
  const end = lines.indexOf(`::${stop}::`);
  assert.ok(end > start, "no resume line");
  return {
    stop,
    before: lines.slice(0, start + 1),
    inside: lines.slice(start + 1, end),
    after: lines.slice(end + 1),
  };
}

/** After the resume line, only our own escaped annotations look like commands. */
function onlyOwnCommands(after) {
  for (const l of after) {
    if (!l.trimStart().startsWith("::")) continue;
    assert.match(l, /^::(warning|error) title=Plinth::/, l);
    const payload = l.replace(/^::(warning|error) title=Plinth::/, "");
    assert.doesNotMatch(payload, /[\r\n]/);
    assert.doesNotMatch(payload, /%(?!25|0D|0A)/, `unescaped % in ${l}`);
  }
}

describe("the GitHub Action", () => {
  it("first run without id: a new artifact, version 1, and the hint to add id", async () => {
    const dir = build({ "index.html": "<!doctype html><title>Coverage</title><p>1</p>" });
    const r = await action({ path: dir, title: "Coverage" });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const o = r.outputs;
    assert.equal(o.outcome, "published");
    assert.equal(o.version, "1");
    assert.match(o.id, /^[a-z0-9]{20}$/);
    assert.equal(o.url, `${fake.origin}/a/${o.slug}`);
    assert.equal(o["version-url"], `${fake.origin}/a/${o.slug}/v/1`);
    assert.equal(o["compare-url"], "");
    assert.equal(o.verified, "true");
    assert.match(r.summary, /### Plinth: published v1/);
    assert.match(r.summary, new RegExp(`Add \`id: ${o.id}\` to this step`));
    assert.deepEqual(fake.state.lastUploadInput, { type: "html", title: "Coverage" });
    // The client says who is calling.
    const ua = fake.state.requests.filter((q) => q.path.startsWith("/api/v1/")).at(-1).ua;
    assert.match(ua, /^plinth-cli\/\S+ github-action$/);
  });

  it("an update: the note is the commit subject and short SHA, with the compare link", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    const dir = build({ "index.html": "<p>2</p>" });
    const r = await action({ path: dir, id: a.id });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(fake.state.lastPut.note, "Add coverage (0123456)");
    assert.equal(r.outputs.version, "2");
    assert.equal(r.outputs["version-url"], `${fake.origin}/a/${a.slug}/v/2`);
    assert.equal(
      r.outputs["compare-url"],
      `${fake.origin}/a/${a.slug}/compare?from=1&to=2&view=rendered`,
    );
    assert.match(r.summary, /\| Compare with v1 \|/);
    assert.doesNotMatch(r.summary, /Add `id:/);
  });

  it('note "-" sends none; link-run appends the run; a long subject is cut, keeping the SHA', async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    const none = await action({ path: build({ "index.html": "<p>2</p>" }), id: a.id, note: "-" });
    assert.equal(none.code, 0, none.stdout);
    assert.equal(fake.state.lastPut.note, undefined);

    const linked = await action({
      path: build({ "index.html": "<p>3</p>" }),
      id: a.id,
      "link-run": "true",
    });
    assert.equal(linked.code, 0, linked.stdout);
    assert.equal(
      fake.state.lastPut.note,
      "Add coverage (0123456) https://github.com/acme/reports/actions/runs/4242",
    );

    const long = await action(
      { path: build({ "index.html": "<p>4</p>" }), id: a.id },
      { event: { head_commit: { message: "é".repeat(600) } } },
    );
    assert.equal(long.code, 0, long.stdout);
    const note = fake.state.lastPut.note;
    assert.equal([...note].length, 500);
    assert.ok(note.endsWith(" (0123456)"));

    // The server counts UTF-16 code units: a subject of emoji (two units each) must still fit.
    const astral = await action(
      { path: build({ "index.html": "<p>5</p>" }), id: a.id },
      { event: { head_commit: { message: "🚀".repeat(300) } } },
    );
    assert.equal(astral.code, 0, astral.stdout);
    const cutNote = fake.state.lastPut.note;
    assert.ok(cutNote.length <= 500, `${cutNote.length} code units`);
    assert.ok(cutNote.isWellFormed(), "never splits a surrogate pair");
    assert.ok(cutNote.endsWith(" (0123456)"));
    const given = await action({
      path: build({ "index.html": "<p>6</p>" }),
      id: a.id,
      note: "🚀".repeat(400),
      "link-run": "true",
    });
    assert.equal(given.code, 0, given.stdout);
    const givenNote = fake.state.lastPut.note;
    assert.ok(givenNote.length <= 500 && givenNote.isWellFormed());
    assert.ok(givenNote.endsWith(" https://github.com/acme/reports/actions/runs/4242"));
  });

  it("a conflict: exit 3, outcome conflict, the current version and an error annotation", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    fake.bump(a);
    const r = await action({
      path: build({ "index.html": "<p>x</p>" }),
      id: a.id,
      "base-version": "1",
    });
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.outputs.outcome, "conflict");
    assert.equal(r.outputs["current-version"], "2");
    const { after: tail } = blocks(r.lines);
    assert.ok(tail.some((l) => l.startsWith("::error title=Plinth::")));
    // base-version is past: a re-run with the same one stops the same way, so it says to change it.
    assert.match(r.summary, /The artifact is at v2, past the base-version this step states/);
    assert.match(r.summary, /set base-version to 2/);
    assert.doesNotMatch(r.summary, /while this run was sending/);
  });

  it("dry-run: one JSON object in the json output, outcome dry_run, and nothing sent", async () => {
    const from = fake.state.requests.length;
    const fresh = await action({
      path: build({ "index.html": "<p>1</p>", "a.css": "p{}" }),
      "dry-run": "true",
    });
    assert.equal(fresh.code, 0, fresh.stdout);
    assert.equal(fresh.outputs.outcome, "dry_run");
    const json = JSON.parse(fresh.outputs.json);
    assert.equal(json.outcome, "dry_run");
    assert.equal(json.type, "html");
    assert.equal(json.files, 2);
    assert.equal(fresh.outputs.version, undefined);
    assert.match(fresh.summary, /### Plinth: dry run/);
    assert.match(fresh.summary, /would publish 2 files \(\d+ B\) as a new private artifact/);
    assert.doesNotMatch(fresh.summary, /Add `id:/);

    const a = fake.seed({ "index.html": "<p>1</p>", "a.css": "p{}" });
    const upd = await action({
      path: build({ "index.html": "<p>2</p>", "a.css": "p{}" }),
      id: a.id,
      "dry-run": "true",
    });
    assert.equal(upd.code, 0, upd.stdout);
    assert.equal(upd.outputs.outcome, "dry_run");
    assert.equal(upd.outputs.id, a.id);
    assert.equal(upd.outputs["compare-url"], undefined);
    const u = JSON.parse(upd.outputs.json);
    assert.deepEqual(
      { base: u.base_version, next: u.next_version, changed: u.changed, reused: u.reused },
      { base: 1, next: 2, changed: 0, reused: 1 },
    );
    assert.match(upd.summary, /would publish v2 from 2 files .*: 0 changed asset files, 1 reused/);
    assert.equal(a.versions.length, 1);
    assert.deepEqual(
      fake.state.requests
        .slice(from)
        .filter((q) => q.method !== "GET")
        .map((q) => `${q.method} ${q.path}`),
      [],
    );
  });

  it("nothing to publish: no compare link, since this run changed nothing", async () => {
    const a = fake.seed({ "index.html": "<p>0</p>" });
    fake.commitFiles(a, { "index.html": "<p>1</p>" });
    const r = await action({
      path: build({ "index.html": "<p>1</p>" }),
      id: a.id,
      "base-version": "2",
    });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.outputs.outcome, "nothing_to_publish");
    assert.equal(r.outputs.version, "2");
    assert.equal(r.outputs["compare-url"], "");
  });

  it("a conflict without base-version: someone published while it was sending, so re-run", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    fake.state.bumpBeforePut = () => fake.bump(a);
    const r = await action({ path: build({ "index.html": "<p>x</p>" }), id: a.id });
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.outputs.outcome, "conflict");
    assert.equal(r.outputs["current-version"], "2");
    assert.match(r.summary, /Someone published v2 while this run was sending/);
    assert.match(r.summary, /Re-run the job/);
    assert.doesNotMatch(r.summary, /base-version/);
  });

  it("fail-on-warnings ignores the notes that need no action (not_scanned, live_draft)", async () => {
    const a = fake.seed({ "content.md": "# 1" }, "doc");
    fake.state.warnings = [
      {
        code: "live_draft",
        file: "content.md",
        message: "Nothing was overwritten. No action needed.",
      },
      { code: "not_scanned", file: "a.js", count: 1, message: "1 file was not checked" },
    ];
    try {
      const r = await action({
        path: build({ "content.md": "# 2" }),
        id: a.id,
        "fail-on-warnings": "true",
      });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.outputs.outcome, "published");
      assert.equal(r.outputs.warnings, "0");
      const { after: tail } = blocks(r.lines);
      assert.ok(!tail.some((l) => l.startsWith("::warning")), tail.join("\n"));
      assert.ok(!tail.some((l) => l.startsWith("::error")), tail.join("\n"));
      assert.doesNotMatch(r.summary, /\| Warnings \|/);
    } finally {
      fake.state.warnings = null;
    }
  });

  it("fail-on-warnings: exit 1 with a warning, and it is still published", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    fake.state.warnings = [
      { code: "missing_asset", file: "index.html", ref: "img/logo.svg", message: "Not found" },
    ];
    try {
      const r = await action({
        path: build({ "index.html": "<p>2</p>" }),
        id: a.id,
        "fail-on-warnings": "true",
      });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(r.outputs.outcome, "published");
      assert.equal(r.outputs.warnings, "1");
      assert.equal(a.versions.length, 2);
      const { after: tail } = blocks(r.lines);
      assert.ok(tail.includes("::warning title=Plinth::missing_asset index.html: Not found"));
      const plain = await action({ path: build({ "index.html": "<p>3</p>" }), id: a.id });
      assert.equal(plain.code, 0);
    } finally {
      fake.state.warnings = null;
    }
  });

  it("never lets the server's or the artifact's text run as a workflow command", async () => {
    const title = "::set-output name=y::z | <script>alert(1)</script> [x](https://evil)";
    const a = fake.seed({ "index.html": "<p>1</p>" }, "html", title);
    fake.state.warnings = [
      { code: "missing_asset", file: "::add-mask::abc\n::error::x", message: "100% ::warning::" },
    ];
    try {
      const ok = await action({ path: build({ "index.html": "<p>2</p>" }), id: a.id });
      assert.equal(ok.code, 0, ok.stdout);
      const b = blocks(ok.lines);
      assert.deepEqual(b.before, [`::add-mask::${PAT}`, `::stop-commands::${b.stop}`]);
      onlyOwnCommands(b.after);
      // The title reaches the summary only escaped, and the json output whole, in a heredoc.
      assert.ok(!ok.summary.includes("<script>"));
      assert.ok(!ok.summary.includes("](https://evil)"));
      assert.match(ok.summary, /\\<script\\>/);
      assert.equal(JSON.parse(ok.outputs.json).title, title);
      assert.deepEqual(
        Object.keys(parseOutputs(ok.outputText)).sort(),
        Object.keys(ok.outputs).sort(),
      );

      fake.state.putError = {
        status: 400,
        code: "invalid_input",
        message: "::set-output name=x::pwned\n::error::boom",
        details: { path: "::add-mask::zzz" },
      };
      const bad = await action({ path: build({ "index.html": "<p>3</p>" }), id: a.id });
      assert.equal(bad.code, 1, bad.stdout);
      const f = blocks(bad.lines);
      // Each line that carries an injected payload is inside the stopped block or escaped after it.
      for (const l of bad.lines) {
        if (!/set-output|add-mask::zzz|::error::boom/.test(l)) continue;
        assert.ok(f.inside.includes(l) || /^::error title=Plinth::/.test(l), l);
      }
      onlyOwnCommands(f.after);
      assert.ok(f.inside.some((l) => l.includes("::set-output name=x::pwned")));
      assert.notEqual(f.stop, b.stop);
    } finally {
      fake.state.warnings = null;
    }
  });

  it("a connection lost mid-answer still resumes commands before its error", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    fake.state.dropPut = "before";
    const r = await action({ path: build({ "index.html": "<p>2</p>" }), id: a.id });
    assert.equal(r.code, 1, r.stdout);
    const b = blocks(r.lines);
    assert.ok(b.after.some((l) => l.startsWith("::error title=Plinth::")));
    onlyOwnCommands(b.after);
  });

  it("prints the token only in the mask, and refuses a token with a newline", async () => {
    const from = fake.state.requests.length;
    const a = fake.seed({ "index.html": "<p>1</p>" });
    const r = await action({ path: build({ "index.html": "<p>2</p>" }), id: a.id });
    assert.equal(r.code, 0, r.stdout);
    const withToken = r.lines.filter((l) => l.includes(PAT));
    assert.deepEqual(withToken, [`::add-mask::${PAT}`]);
    assert.ok(!r.stderr.includes(PAT));
    assert.ok(!r.outputText.includes(PAT));
    assert.ok(!r.summary.includes(PAT));
    for (const q of fake.state.requests.slice(from)) {
      if (q.authorization?.includes(PAT)) assert.equal(q.authorization, `Bearer ${PAT}`);
    }

    const evil = `${PAT}\n::error::x`;
    const n = await action({ path: build({ "index.html": "<p>3</p>" }), id: a.id, token: evil });
    assert.equal(n.code, 2);
    assert.ok(!n.stdout.includes(PAT) && !n.stderr.includes(PAT));
    assert.ok(n.lines.every((l) => !l.startsWith("::add-mask::")));
  });

  it("sends the token only to the url input's instance; a bad boolean is exit 2", async () => {
    const other = await startFakePlinth();
    try {
      const a = other.seed({ "index.html": "<p>1</p>" });
      const before = fake.state.requests.length;
      const r = await action({
        path: build({ "index.html": "<p>2</p>" }),
        id: a.id,
        url: other.origin,
      });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(fake.state.requests.length, before);
      assert.ok(other.state.requests.some((q) => q.authorization === `Bearer ${PAT}`));
    } finally {
      await other.close();
    }
    const bad = await action({ path: build({ "index.html": "<p>x</p>" }), "dry-run": "yes" });
    assert.equal(bad.code, 2);
    assert.ok(bad.lines.some((l) => l.startsWith("::error title=Plinth::The dry-run input")));
  });

  it("a token limited to one artifact: no id needed; another id is refused", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" }, "html", "Report");
    const b = fake.seed({ "index.html": "<p>1</p>" });
    fake.state.boundArtifact = { id: a.id, slug: a.slug, title: "Report" };
    try {
      const r = await action({ path: build({ "index.html": "<p>2</p>" }) });
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.outputs.id, a.id);
      assert.equal(r.outputs.version, "2");
      assert.doesNotMatch(r.summary, /Add `id:/);
      assert.match(r.summary, /published v2 of "Report"/);
      const slug = await action({ path: build({ "index.html": "<p>3</p>" }), id: a.slug });
      assert.equal(slug.code, 0, slug.stdout);
      const wrong = await action({ path: build({ "index.html": "<p>4</p>" }), id: b.id });
      assert.equal(wrong.code, 2, wrong.stdout);
      assert.ok(wrong.lines.some((l) => l.includes(`This token is limited to ${a.slug}`)));
      assert.equal(b.versions.length, 1);
    } finally {
      fake.state.boundArtifact = undefined;
    }
  });

  it("base-version without an id is refused (exit 2) and creates nothing", async () => {
    const from = fake.state.requests.length;
    const r = await action({ path: build({ "index.html": "<p>1</p>" }), "base-version": "7" });
    assert.equal(r.code, 2, r.stdout);
    assert.ok(
      r.lines.some((l) =>
        l.startsWith("::error title=Plinth::The base-version input applies to an update"),
      ),
    );
    assert.equal(r.outputs.outcome, "error");
    assert.deepEqual(
      fake.state.requests
        .slice(from)
        .filter((q) => q.method !== "GET")
        .map((q) => `${q.method} ${q.path}`),
      [],
    );
  });

  it("an unknown outcome names the safe re-run (base-version), and that re-run publishes nothing twice", async () => {
    const a = fake.seed({ "index.html": "<p>1</p>" });
    const dir = build({ "index.html": "<p>2</p>" });
    fake.state.dropPut = "after";
    fake.state.armReadFail = true;
    let r;
    try {
      r = await action({ path: dir, id: a.id });
    } finally {
      fake.state.armReadFail = false;
      fake.state.artifactReadFail = 0;
    }
    assert.equal(r.code, 1, r.stdout);
    assert.equal(r.outputs.outcome, "unknown");
    assert.equal(a.versions.length, 2);
    assert.doesNotMatch(r.summary, /does not publish twice/);
    assert.match(r.summary, /Set base-version to 1 on this step, then re-run/);
    assert.match(r.summary, /A re-run without base-version publishes it again/);
    assert.ok(r.lines.some((l) => /^::error title=Plinth::.*Set base-version to 1/.test(l)));

    // The re-run the summary names sends nothing: v2 is this build.
    const again = await action({ path: dir, id: a.id, "base-version": "1" });
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.outputs.outcome, "already_published");
    assert.equal(a.versions.length, 2);

    // With base-version already set, the summary says a plain re-run is safe.
    const b = fake.seed({ "index.html": "<p>1</p>" });
    fake.state.dropPut = "after";
    fake.state.armReadFail = true;
    let s;
    try {
      s = await action({ path: dir, id: b.id, "base-version": "1" });
    } finally {
      fake.state.armReadFail = false;
      fake.state.artifactReadFail = 0;
    }
    assert.equal(s.outputs.outcome, "unknown");
    assert.match(
      s.summary,
      /Re-run the job: with base-version set it sends nothing if v2 is this build/,
    );
  });

  it("a rejected token is named before anything is sent", async () => {
    const r = await action({
      path: build({ "index.html": "<p>1</p>" }),
      token: "plinth_pat_revoked0000",
    });
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => /^::error title=Plinth::The token was rejected by/.test(l)));
  });
});

describe("the Action's helpers", () => {
  it("cut counts UTF-16 code units, as the server does, and never splits a surrogate pair", () => {
    assert.equal(cut("abc", 5), "abc");
    assert.equal(cut("abcdef", 4), "abcd");
    // "a🚀🚀" is 5 units: 4 would end inside the second pair, so it drops the whole pair.
    assert.equal(cut("a🚀🚀", 4), "a🚀");
    assert.equal(cut("a🚀🚀", 3), "a🚀");
    assert.equal(cut("🚀", 1), "");
    const env = { GITHUB_SHA: SHA };
    const i = readInputs({ INPUT_TOKEN: PAT, INPUT_PATH: "dist" });
    for (const subject of ["🚀".repeat(300), `x${"🚀".repeat(300)}`]) {
      const note = defaultNote(
        i,
        env,
        () => ({ head_commit: { message: subject } }),
        () => "",
      );
      assert.ok(note.length <= 500 && note.length >= 499, String(note.length));
      assert.ok(note.isWellFormed());
      assert.ok(note.endsWith(" (0123456)"));
    }
  });

  it("conflict advice: re-run after a race, change base-version when it is past", () => {
    assert.match(conflictAdvice("7", false), /Someone published v7 while this run was sending/);
    const stated = conflictAdvice("7", true);
    assert.match(stated, /set base-version to 7/);
    assert.doesNotMatch(stated, /while this run was sending/);
  });

  it("counts only the warnings that need a fix", () => {
    const json = {
      warnings: [
        { code: "live_draft", file: "content.md", message: "x" },
        { code: "not_scanned", file: "a.js", message: "x" },
        { code: "missing_file", file: "index.html", message: "x" },
      ],
    };
    assert.deepEqual(
      actionableWarnings(json).map((w) => w.code),
      ["missing_file"],
    );
    assert.deepEqual(actionableWarnings(null), []);
  });

  it("escape workflow command data and properties", () => {
    assert.equal(escapeData("a%b\r\nc"), "a%25b%0D%0Ac");
    assert.equal(escapeData("::set-output name=x::y"), "::set-output name=x::y");
  });

  it("escape Markdown and HTML for the summary, on one line", () => {
    assert.equal(
      escapeMarkdown("# [x](y) <b>|`*_~!</b>\nnext & more"),
      "\\# \\[x\\]\\(y\\) \\<b\\>\\|\\`\\*\\_\\~\\!\\</b\\> next &amp; more",
    );
  });

  it("writes outputs with heredoc delimiters that never occur in the value", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "plinth-out-")), "out");
    writeFileSync(file, "");
    const tricky = "line\nplinth_00\nEOF\n";
    writeOutputFile(file, [
      ["json", tricky],
      ["id", "abc"],
    ]);
    const text = readFileSync(file, "utf8");
    const delims = [...text.matchAll(/^[a-z-]+<<(.+)$/gm)].map((m) => m[1]);
    assert.equal(delims.length, 2);
    assert.notEqual(delims[0], delims[1]);
    for (const d of delims) assert.ok(!tricky.includes(d));
    assert.deepEqual(parseOutputs(text), { json: tricky, id: "abc" });
    assert.throws(() => writeOutputFile(file, [["Bad Name", "x"]]));
  });

  it("reads inputs strictly and builds the CLI's argv", () => {
    const base = { INPUT_TOKEN: PAT, INPUT_PATH: "dist" };
    const i = readInputs(base);
    assert.equal(i.url, "https://plinth.aconite.io");
    assert.equal(i.summary, true);
    assert.equal(i.dryRun, false);
    assert.throws(() => readInputs({ ...base, "INPUT_LINK-RUN": "1" }), /link-run input/);
    assert.throws(() => readInputs({ ...base, "INPUT_BASE-VERSION": "v2" }), /base-version/);
    assert.throws(() => readInputs({ INPUT_PATH: "dist" }), /token input is empty/);
    assert.deepEqual(buildArgv({ ...i, title: "T" }, "", null), [
      "publish",
      "dist",
      "--json",
      "--title",
      "T",
    ]);
    // base-version goes with an update only (the step refuses it without an id before this).
    assert.deepEqual(buildArgv({ ...i, baseVersion: "7" }, "", null), [
      "publish",
      "dist",
      "--json",
    ]);
    assert.deepEqual(buildArgv({ ...i, baseVersion: "3", includeMaps: true }, "abc", "n"), [
      "publish",
      "dist",
      "--json",
      "--id",
      "abc",
      "--note",
      "n",
      "--base-version",
      "3",
      "--include-maps",
    ]);
  });

  it("falls back from the event to git, then to the workflow and run number", () => {
    const i = readInputs({ INPUT_TOKEN: PAT, INPUT_PATH: "dist" });
    const env = { GITHUB_SHA: SHA, GITHUB_WORKFLOW: "Nightly", GITHUB_RUN_NUMBER: "12" };
    const noEvent = () => null;
    assert.equal(
      defaultNote(
        i,
        env,
        () => ({ pull_request: { title: "PR" } }),
        () => "",
      ),
      "PR (0123456)",
    );
    assert.equal(
      defaultNote(i, env, noEvent, () => "From git\n"),
      "From git (0123456)",
    );
    assert.equal(
      defaultNote(i, env, noEvent, () => ""),
      "Nightly #12 (0123456)",
    );
    assert.equal(
      defaultNote({ ...i, note: "Mine" }, env, noEvent, () => ""),
      "Mine",
    );
  });

  it("reads the outcome from the CLI's object, never guessing dry_run from output it cannot read", () => {
    assert.equal(outcomeOf(0, { outcome: "dry_run", files: 1 }), "dry_run");
    assert.equal(outcomeOf(0, { id: "a", version: 2 }), "published");
    assert.equal(outcomeOf(0, { outcome: "nothing_to_publish", version: 2 }), "nothing_to_publish");
    assert.equal(outcomeOf(0, null), "unknown");
    assert.equal(outcomeOf(0, { ok: true }), "unknown");
    assert.equal(outcomeOf(3, { ok: false, outcome: "conflict" }), "conflict");
    assert.equal(outcomeOf(2, null), "error");
    const dry = Object.fromEntries(
      formatOutputs({
        code: 0,
        json: { outcome: "dry_run", id: "a", slug: "s", version: 4, files: 1 },
        raw: "{}",
        origin: "https://p.example",
      }),
    );
    assert.equal(dry.outcome, "dry_run");
    assert.equal(dry.version, undefined);
    assert.equal(dry["compare-url"], undefined);
  });

  it("builds URLs only from a slug the server could have made", () => {
    assert.equal(SLUG_RE.source, SERVER_SLUG_RE.source);
    const o = Object.fromEntries(
      formatOutputs({
        code: 0,
        json: { id: "a", slug: "x/../evil", version: 2, verified: true, warnings: [] },
        raw: "{}",
        origin: "https://p.example",
      }),
    );
    assert.equal(o.slug, undefined);
    assert.equal(o.url, "");
    assert.equal(o["compare-url"], "");
  });
});
