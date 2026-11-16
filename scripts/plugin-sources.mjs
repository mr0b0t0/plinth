// The plugin's hand-written sources and their content hash. The Claude Code and portable plugins
// ship the skill (integrations/skill/), the mention watcher (integrations/watcher/) and the
// session note (integrations/hooks/); clients update an installed plugin only when PLUGIN.version
// changes. So PLUGIN.skillHash in
// packages/shared/src/harnesses.ts records the hash of these sources, and PLUGIN.skillHashVersion
// the PLUGIN.version it was recorded under. A changed hash is recorded only under a new version:
// `pnpm integrations` refuses while PLUGIN.version still equals skillHashVersion (a skill edit
// without a bump), and `pnpm integrations --check` fails on any mismatch.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Folders whose files the plugin ships, relative to the repository root. */
export const PLUGIN_SOURCE_DIRS = [
  "integrations/skill",
  "integrations/watcher",
  "integrations/hooks",
];

/**
 * The files git would commit under `dirs`: tracked and untracked ones, never ignored ones (a
 * Finder .DS_Store), as POSIX paths relative to `root`. Null when `root` is not a git work tree.
 */
function gitFiles(root, dirs) {
  const r = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...dirs],
    { cwd: root, encoding: "utf8" },
  );
  if (r.error || r.status !== 0) return null;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  // Inside some other repository (a scratch copy under one): its index does not describe root.
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return null;
  return [...new Set(r.stdout.split("\0").filter(Boolean))].filter((rel) => {
    const file = path.join(root, rel);
    return existsSync(file) && statSync(file).isFile();
  });
}

/** Outside git: every file under `dir` whose name does not start with a dot. */
function walkFiles(root, dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  // A folder that does not exist ships nothing (a fresh checkout with no hooks yet).
  if (existsSync(path.join(root, dir))) walk(dir);
  return out;
}

/** The plugin's source files, sorted. */
export function pluginSourceFiles(root) {
  const files =
    gitFiles(root, PLUGIN_SOURCE_DIRS) ?? PLUGIN_SOURCE_DIRS.flatMap((d) => walkFiles(root, d));
  return files.sort();
}

/**
 * SHA-256 over each source file's path and bytes, in path order: the same files give the same
 * hash on any machine, and a rename, an edit, an added or a removed file changes it. Files git
 * ignores never count.
 */
export function pluginSourcesHash(root) {
  const h = createHash("sha256");
  for (const rel of pluginSourceFiles(root)) {
    h.update(`${rel}\0`);
    h.update(readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * What the guard says, or null when the recorded hash and version match. `refuse` is true when
 * the sources changed and PLUGIN.version has not moved since the hash was recorded: `pnpm
 * integrations` will not record it (unless `--same-version`).
 */
export function hashProblem({ recorded, recordedVersion, actual, version, sameVersion = false }) {
  if (recorded === actual && recordedVersion === version) return null;
  if (recorded !== actual && recordedVersion === version && !sameVersion) {
    return {
      refuse: true,
      message: [
        `The plugin's sources (${PLUGIN_SOURCE_DIRS.join(", ")}) changed, and PLUGIN.version is still ${version},`,
        "the version their last hash was recorded under. Bump PLUGIN.version in",
        "packages/shared/src/harnesses.ts (one minor above the version on main) so installed plugins",
        "update, then run pnpm integrations, which records the new hash. If this branch already bumped",
        "it above main, run pnpm integrations --same-version instead.",
      ].join("\n"),
    };
  }
  return {
    refuse: false,
    message: `PLUGIN.skillHash or PLUGIN.skillHashVersion is not up to date (sources ${actual}, version ${version}): run pnpm integrations.`,
  };
}

const HASH_RE = /(\n\s*skillHash:\s*")([0-9a-f]{64})(")/;
const HASH_VERSION_RE = /(\n\s*skillHashVersion:\s*")([^"]*)(")/;

/** harnesses.ts with `skillHash` set to `hash` and `skillHashVersion` to `version`. */
export function withRecordedHash(source, hash, version) {
  if (!HASH_RE.test(source)) throw new Error('harnesses.ts has no PLUGIN.skillHash: "<64 hex>"');
  if (!HASH_VERSION_RE.test(source)) {
    throw new Error('harnesses.ts has no PLUGIN.skillHashVersion: "<version>"');
  }
  return source.replace(HASH_RE, `$1${hash}$3`).replace(HASH_VERSION_RE, `$1${version}$3`);
}
