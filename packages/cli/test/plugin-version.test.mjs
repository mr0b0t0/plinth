// The plugin version guard (scripts/plugin-sources.mjs): PLUGIN.skillHash in harnesses.ts records
// the hash of the skill and watcher sources and PLUGIN.skillHashVersion the version it was recorded
// under. `pnpm integrations` refuses to record a new hash under the same version, and
// `pnpm integrations --check` fails on any mismatch. Installed plugins update only when
// PLUGIN.version changes, so a skill edit without a bump never reaches them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  hashProblem,
  PLUGIN_SOURCE_DIRS,
  pluginSourcesHash,
  withRecordedHash,
} from "../../../scripts/plugin-sources.mjs";
import { PLUGIN } from "../../shared/src/harnesses.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "plinth-plugin-hash-"));
  temps.push(d);
  return d;
};

/** The files scripts/integrations.mjs reads and writes, in a scratch copy of the repository. */
function repoCopy() {
  const d = temp();
  for (const rel of [
    "scripts/integrations.mjs",
    "scripts/plugin-sources.mjs",
    "packages/shared/src/harnesses.ts",
    "packages/shared/src/constants.ts",
    "packages/cli/bin/client/vendor",
    "integrations",
    "docs/agents.md",
    "biome.json",
    ".gitignore",
    ".claude-plugin",
    ".agents",
  ]) {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    cpSync(path.join(root, rel), path.join(d, rel), { recursive: true });
  }
  symlinkSync(path.join(root, "node_modules"), path.join(d, "node_modules"));
  git(d, "init", "-q");
  git(d, "add", "-A");
  return d;
}
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
/** Set PLUGIN.version in the copy's harnesses.ts. */
function setVersion(d, version) {
  const file = path.join(d, "packages/shared/src/harnesses.ts");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(/(\n\s*version:\s*")[^"]*(")/, `$1${version}$2`),
  );
}
const recorded = (d) => readFileSync(path.join(d, "packages/shared/src/harnesses.ts"), "utf8");
const integrations = (cwd, ...args) =>
  spawnSync(process.execPath, [path.join(cwd, "scripts/integrations.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });

describe("PLUGIN.skillHash", () => {
  it("matches the committed skill, watcher and hook sources, under the current version", () => {
    assert.match(PLUGIN.skillHash, /^[0-9a-f]{64}$/);
    assert.equal(pluginSourcesHash(root), PLUGIN.skillHash);
    assert.equal(PLUGIN.skillHashVersion, PLUGIN.version);
    assert.deepEqual(PLUGIN_SOURCE_DIRS, [
      "integrations/skill",
      "integrations/watcher",
      "integrations/hooks",
    ]);
  });

  it("is deterministic, and changes with an edit, an added file or a rename", () => {
    const d = temp();
    mkdirSync(path.join(d, "integrations/skill/s"), { recursive: true });
    mkdirSync(path.join(d, "integrations/watcher"), { recursive: true });
    writeFileSync(path.join(d, "integrations/skill/s/SKILL.md"), "rules\n");
    writeFileSync(path.join(d, "integrations/watcher/w.mjs"), "watch\n");
    const h0 = pluginSourcesHash(d);
    assert.equal(pluginSourcesHash(d), h0);
    appendFileSync(path.join(d, "integrations/skill/s/SKILL.md"), "one more rule\n");
    const h1 = pluginSourcesHash(d);
    assert.notEqual(h1, h0);
    writeFileSync(path.join(d, "integrations/watcher/extra.mjs"), "");
    const h2 = pluginSourcesHash(d);
    assert.notEqual(h2, h1);
    renameSync(
      path.join(d, "integrations/watcher/extra.mjs"),
      path.join(d, "integrations/watcher/x.mjs"),
    );
    const h3 = pluginSourcesHash(d);
    assert.notEqual(h3, h2);
    mkdirSync(path.join(d, "integrations/hooks"), { recursive: true });
    writeFileSync(path.join(d, "integrations/hooks/session-note.md"), "note\n");
    assert.notEqual(pluginSourcesHash(d), h3);
  });

  it("refuses a new hash under the same version, and says to bump PLUGIN.version", () => {
    const base = { recorded: "a", recordedVersion: "1.0.0", actual: "a", version: "1.0.0" };
    assert.equal(hashProblem(base), null);
    const same = hashProblem({ ...base, actual: "b".repeat(64) });
    assert.equal(same.refuse, true);
    assert.match(same.message, /PLUGIN\.version is still 1\.0\.0/);
    assert.match(same.message, /Bump PLUGIN\.version/);
    assert.match(same.message, /--same-version/);
    assert.equal(hashProblem({ ...base, actual: "b", sameVersion: true }).refuse, false);
    const bumped = hashProblem({ ...base, actual: "b", version: "1.1.0" });
    assert.equal(bumped.refuse, false);
    assert.match(bumped.message, /run pnpm integrations/);
    // A bump without a source change still needs the recorded version moved.
    assert.equal(hashProblem({ ...base, version: "1.1.0" }).refuse, false);
    const src = `export const PLUGIN = {\n  version: "1.0.0",\n  skillHash: "${"0".repeat(64)}",\n  skillHashVersion: "1.0.0",\n};`;
    const out = withRecordedHash(src, "f".repeat(64), "1.1.0");
    assert.match(out, new RegExp(`skillHash: "${"f".repeat(64)}"`));
    assert.match(out, /skillHashVersion: "1\.1\.0"/);
    assert.throws(() => withRecordedHash("const PLUGIN = {}", "f".repeat(64), "1"), /skillHash/);
  });

  it("a skill edit without a bump fails both --check and pnpm integrations", () => {
    const d = repoCopy();
    assert.equal(integrations(d, "--check").status, 0);
    const before = recorded(d);
    appendFileSync(path.join(d, "integrations/skill/plinth-artifacts/SKILL.md"), "\nA new rule.\n");
    const stale = integrations(d, "--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Bump PLUGIN\.version/);

    // Regenerating does not clear it: nothing is recorded, and --check still fails.
    const refused = integrations(d);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Bump PLUGIN\.version/);
    assert.equal(recorded(d), before);
    assert.equal(integrations(d, "--check").status, 1);

    // With a bump, pnpm integrations records the hash under the new version.
    setVersion(d, "9.9.0");
    const wrote = integrations(d);
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.match(wrote.stdout, /recorded the plugin sources' hash under PLUGIN\.version 9\.9\.0/i);
    assert.ok(recorded(d).includes(`skillHash: "${pluginSourcesHash(d)}"`));
    assert.ok(recorded(d).includes(`skillHashVersion: "9.9.0"`));
    assert.equal(integrations(d, "--check").status, 0);

    // A second edit on the same (already bumped) branch needs --same-version on purpose.
    appendFileSync(path.join(d, "integrations/skill/plinth-artifacts/SKILL.md"), "Another.\n");
    assert.equal(integrations(d).status, 1);
    const again = integrations(d, "--same-version");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(integrations(d, "--check").status, 0);
  });

  it("files git ignores (a Finder .DS_Store) never change the hash", () => {
    const d = repoCopy();
    const h = pluginSourcesHash(d);
    writeFileSync(path.join(d, "integrations/skill/.DS_Store"), "finder");
    writeFileSync(path.join(d, "integrations/watcher/.DS_Store"), "finder");
    assert.equal(pluginSourcesHash(d), h);
    assert.equal(integrations(d, "--check").status, 0);
    // An untracked file that is not ignored does count: it would be committed.
    writeFileSync(path.join(d, "integrations/watcher/new.mjs"), "x");
    assert.notEqual(pluginSourcesHash(d), h);
  });
});

describe("the GitHub Action's pins (publishing from CI)", () => {
  const semver = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
  const atLeast = (a, b) => {
    const [x, y] = [semver(a), semver(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return true;
  };

  it("pins a release tag no older than the CLI, and every doc pins the same one", async () => {
    const { ACTION_REF, CI_CLI_VERSION } = await import("../../shared/src/ci.ts");
    const { ACTION_REF_RE, CI_PINNED, ciPinsIn } = await import("../../../scripts/ci-pins.mjs");
    const cli = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
    assert.match(ACTION_REF, ACTION_REF_RE);
    assert.equal(ACTION_REF, `mr0b0t0/plinth/publish@v${CI_CLI_VERSION}`);
    // pnpm release moves the pin to the version it releases; it is never behind the CLI.
    assert.ok(atLeast(CI_CLI_VERSION, cli.version), `${CI_CLI_VERSION} < ${cli.version}`);
    for (const rel of CI_PINNED) {
      const pins = ciPinsIn(readFileSync(path.join(root, rel), "utf8"));
      assert.ok(pins.length > 0, `${rel} pins nothing`);
      for (const p of pins) assert.equal(p, CI_CLI_VERSION, rel);
    }
  });

  it("pnpm release rewrites every Action and CLI pin, and nothing else", async () => {
    const { withCiPins } = await import("../../../scripts/ci-pins.mjs");
    const text =
      "uses: mr0b0t0/plinth/publish@v0.6.0\nnpx --yes @mr0b0t0/plinth@0.6.0 publish\nother@v0.6.0";
    assert.equal(
      withCiPins(text, "0.7.0"),
      "uses: mr0b0t0/plinth/publish@v0.7.0\nnpx --yes @mr0b0t0/plinth@0.7.0 publish\nother@v0.6.0",
    );
  });

  it("a prerelease that pnpm release takes gives pins this test accepts", async () => {
    const { ACTION_REF_RE, VERSION_RE, ciPinsIn, withCiPins } = await import(
      "../../../scripts/ci-pins.mjs"
    );
    const ref = "mr0b0t0/plinth/publish@v0.6.0";
    for (const v of ["0.7.0", "0.7.0-rc.1"]) {
      assert.match(v, VERSION_RE);
      const moved = withCiPins(`${ref}\n@mr0b0t0/plinth@0.6.0`, v);
      assert.deepEqual(ciPinsIn(moved), [v, v]);
      assert.match(moved.split("\n")[0], ACTION_REF_RE);
    }
    assert.doesNotMatch("0.7", VERSION_RE);
    assert.doesNotMatch("mr0b0t0/plinth/publish@v1", ACTION_REF_RE);
  });
});
