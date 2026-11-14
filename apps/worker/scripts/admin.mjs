#!/usr/bin/env node
// Plinth admin CLI. Runs SQL against the D1 database through wrangler.
//
// Usage (from the repo root):
//   pnpm --filter @plinth/worker admin -- set-limit <email> <n|default> --local
//   pnpm --filter @plinth/worker admin -- set-limit <email> <n|default> --remote [--env staging]
//
//   set-limit   Set a user's artifact quota (users.artifact_limit). "default" clears the override,
//               so MAX_ARTIFACTS_PER_USER applies again.
//   --local     The local D1 database that `wrangler dev` uses (.wrangler/state).
//   --remote    The deployed D1 database (needs `wrangler login` or CLOUDFLARE_API_TOKEN).
//
// The email and the number are validated strictly before any SQL is built, and wrangler is run
// without a shell, so nothing typed here can change the statement.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changesFromOutput,
  keysFromRows,
  parseArgs,
  resultSets,
  USAGE,
  UsageError,
} from "./admin-lib.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(
  packageDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

/** Run wrangler in apps/worker without a shell. */
function wrangler(args) {
  const [cmd, full] = existsSync(bin) ? [bin, args] : ["npx", ["wrangler", ...args]];
  return spawnSync(cmd, full, { cwd: packageDir, encoding: "utf8", shell: false });
}

function failed(r) {
  if (r.error) {
    console.error(`Could not run wrangler: ${r.error.message}`);
    return 1;
  }
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || "");
    return r.status ?? 1;
  }
  return 0;
}

/**
 * erase-user / erase-artifact: list the stored files, delete them from R2, then delete the rows
 * (the database cascades do the rest). Files first, so a failure leaves rows that can be erased
 * again rather than files nothing points to.
 */
function erase(parsed) {
  const what =
    parsed.command === "erase-user" ? `user ${parsed.subject}` : `artifact ${parsed.subject}`;
  const q = wrangler(parsed.keysArgs);
  const qf = failed(q);
  if (qf) return qf;
  const keys = keysFromRows(resultSets(q.stdout).flat());
  console.log(`Erasing ${what} (${parsed.target}): ${keys.length} stored file(s).`);
  if (parsed.dryRun) {
    for (const k of keys) console.log(`  would delete ${k}`);
    console.log("Dry run: nothing changed.");
    return 0;
  }
  for (const key of keys) {
    const r = wrangler(parsed.deleteObjectArgs(key));
    const f = failed(r);
    if (f) {
      console.error(
        `Stopped at ${key}; nothing in the database was changed. Run the command again.`,
      );
      return f;
    }
  }
  const e = wrangler(parsed.eraseArgs);
  const ef = failed(e);
  if (ef) return ef;
  const sets = resultSets(e.stdout);
  const erased = sets.length ? sets[sets.length - 1].length : null;
  if (erased === 0) {
    console.error(
      `No ${what} in the ${parsed.target} database (stored files listed above, if any, are gone).`,
    );
    return 1;
  }
  console.log(`Erased ${what} and ${keys.length} stored file(s) (${parsed.target}).`);
  return 0;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  if (parsed.command !== "set-limit") return erase(parsed);
  const r = wrangler(parsed.wranglerArgs);
  const f = failed(r);
  if (f) return f;
  const changes = changesFromOutput(r.stdout);
  if (changes === 0) {
    console.error(`No user with email ${parsed.email} in the ${parsed.target} database.`);
    return 1;
  }
  const what =
    parsed.limit === null ? "the default (MAX_ARTIFACTS_PER_USER)" : String(parsed.limit);
  console.log(`Artifact limit for ${parsed.email} set to ${what} (${parsed.target}).`);
  return 0;
}

process.exitCode = main();
