// The plugin's hand-written sources and their content hash. The Claude Code and portable plugins
// ship the skill (integrations/skill/) and the mention watcher (integrations/watcher/); clients
// update an installed plugin only when PLUGIN.version changes. So PLUGIN.skillHash in
// packages/shared/src/harnesses.ts records the hash of these sources, `pnpm integrations --check`
// fails when it no longer matches, and `pnpm integrations` records the new one.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Folders whose files the plugin ships, relative to the repository root. */
export const PLUGIN_SOURCE_DIRS = ["integrations/skill", "integrations/watcher"];

/** Every file under `dir` (relative to `root`), as sorted POSIX paths. */
function filesUnder(root, dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/**
 * SHA-256 over each source file's path and bytes, in path order: the same files give the same
 * hash on any machine, and a rename, an edit, an added or a removed file changes it.
 */
export function pluginSourcesHash(root) {
  const h = createHash("sha256");
  const files = PLUGIN_SOURCE_DIRS.flatMap((d) => filesUnder(root, d)).sort();
  for (const rel of files) {
    h.update(`${rel}\0`);
    h.update(readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** What `pnpm integrations --check` says when the recorded hash is stale, or null. */
export function staleHashMessage({ recorded, actual, version }) {
  if (recorded === actual) return null;
  return [
    `The plugin's sources (${PLUGIN_SOURCE_DIRS.join(", ")}) changed since PLUGIN.skillHash was recorded.`,
    `Bump PLUGIN.version (now ${version}) in packages/shared/src/harnesses.ts, one minor above the`,
    "version on main, so installed plugins update; then run pnpm integrations, which records the new",
    `hash (${actual}).`,
  ].join("\n");
}

const HASH_RE = /(\n\s*skillHash:\s*")([0-9a-f]{64})(")/;

/** harnesses.ts with `skillHash` set to `hash`. */
export function withRecordedHash(source, hash) {
  if (!HASH_RE.test(source)) throw new Error('harnesses.ts has no PLUGIN.skillHash: "<64 hex>"');
  return source.replace(HASH_RE, `$1${hash}$3`);
}
