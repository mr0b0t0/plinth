// The plugin version guard (scripts/plugin-sources.mjs): PLUGIN.skillHash in harnesses.ts records
// the hash of the skill and watcher sources, `pnpm integrations --check` fails when they change
// without it, and `pnpm integrations` records the new hash. Installed plugins update only when
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
  PLUGIN_SOURCE_DIRS,
  pluginSourcesHash,
  staleHashMessage,
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
  return d;
}
const integrations = (cwd, ...args) =>
  spawnSync(process.execPath, [path.join(cwd, "scripts/integrations.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });

describe("PLUGIN.skillHash", () => {
  it("matches the committed skill and watcher sources", () => {
    assert.match(PLUGIN.skillHash, /^[0-9a-f]{64}$/);
    assert.equal(pluginSourcesHash(root), PLUGIN.skillHash);
    assert.deepEqual(PLUGIN_SOURCE_DIRS, ["integrations/skill", "integrations/watcher"]);
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
    assert.notEqual(pluginSourcesHash(d), h2);
  });

  it("the stale message says to bump PLUGIN.version and run pnpm integrations", () => {
    assert.equal(staleHashMessage({ recorded: "a", actual: "a", version: "1.0.0" }), null);
    const m = staleHashMessage({ recorded: "a", actual: "b".repeat(64), version: "1.0.0" });
    assert.match(m, /Bump PLUGIN\.version \(now 1\.0\.0\)/);
    assert.match(m, /run pnpm integrations/);
    const src =
      'export const PLUGIN = {\n  version: "1.0.0",\n  skillHash: "' + "0".repeat(64) + '",\n};';
    assert.match(
      withRecordedHash(src, "f".repeat(64)),
      new RegExp(`skillHash: "${"f".repeat(64)}"`),
    );
    assert.throws(() => withRecordedHash("const PLUGIN = {}", "f".repeat(64)), /skillHash/);
  });

  it("pnpm integrations --check fails on a skill edit; pnpm integrations records the new hash", () => {
    const d = repoCopy();
    assert.equal(integrations(d, "--check").status, 0);
    appendFileSync(path.join(d, "integrations/skill/plinth-artifacts/SKILL.md"), "\nA new rule.\n");
    const stale = integrations(d, "--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /changed since PLUGIN\.skillHash was recorded/);
    assert.match(stale.stderr, /Bump PLUGIN\.version/);

    const wrote = integrations(d);
    assert.equal(wrote.status, 0, wrote.stderr);
    assert.match(wrote.stdout, /recorded the plugin sources' new hash/i);
    const harnesses = readFileSync(path.join(d, "packages/shared/src/harnesses.ts"), "utf8");
    assert.ok(harnesses.includes(`skillHash: "${pluginSourcesHash(d)}"`));
    assert.equal(integrations(d, "--check").status, 0);
  });
});
