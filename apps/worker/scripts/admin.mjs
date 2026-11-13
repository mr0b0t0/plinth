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
import { changesFromOutput, parseArgs, USAGE, UsageError } from "./admin-lib.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

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

  const bin = join(
    packageDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const [cmd, args] = existsSync(bin)
    ? [bin, parsed.wranglerArgs]
    : ["npx", ["wrangler", ...parsed.wranglerArgs]];
  const r = spawnSync(cmd, args, { cwd: packageDir, encoding: "utf8", shell: false });
  if (r.error) {
    console.error(`Could not run wrangler: ${r.error.message}`);
    return 1;
  }
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || "");
    return r.status ?? 1;
  }
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
