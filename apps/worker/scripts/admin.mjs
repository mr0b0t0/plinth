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
//   sweep-orphans  Delete stored files no version points to (what an interrupted publish left).
//
// The email and the number are validated strictly before any SQL is built, and wrangler is run
// without a shell, so nothing typed here can change the statement. Listing R2 (sweep-orphans, and
// the last step of the erase commands) goes through wrangler's getPlatformProxy, since the
// wrangler CLI cannot list objects: the local bucket that `wrangler dev` uses, or with --remote the
// deployed one (wrangler login or CLOUDFLARE_API_TOKEN, as for the other commands).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changesFromOutput,
  deleteRoots,
  keysFromRows,
  parseArgs,
  resultSets,
  rootsFromRows,
  sweepOrphans,
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
 * The R2 bucket as a binding, through a throwaway wrangler config that binds only that bucket:
 * locally the state `wrangler dev` keeps in .wrangler/state, with --remote the deployed bucket.
 */
async function openBucket(parsed) {
  const { getPlatformProxy } = await import("wrangler");
  const dir = mkdtempSync(join(tmpdir(), "plinth-admin-"));
  const configPath = join(dir, "wrangler.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "plinth-admin",
      compatibility_date: "2026-11-01",
      r2_buckets: [
        {
          binding: "FILES",
          bucket_name: parsed.bucket,
          ...(parsed.target === "remote" ? { remote: true } : {}),
        },
      ],
    }),
  );
  try {
    const proxy = await getPlatformProxy({
      configPath,
      persist: { path: join(packageDir, ".wrangler", "state", "v3") },
      remoteBindings: parsed.target === "remote",
    });
    return {
      bucket: proxy.env.FILES,
      dispose: async () => {
        await proxy.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** sweep-orphans: version prefixes no row names, older than the threshold, are deleted. */
async function sweep(parsed) {
  const q = wrangler(parsed.prefixesArgs);
  const qf = failed(q);
  if (qf) return qf;
  const rows = resultSets(q.stdout).flat();
  let root = "artifacts/";
  if (parsed.artifact !== null) {
    const [one] = rootsFromRows(rows);
    if (one) root = one;
    else if (/^[a-z0-9]{20}$/.test(parsed.artifact)) root = `artifacts/${parsed.artifact}/`;
    else {
      console.error(`No artifact ${parsed.artifact} in the ${parsed.target} database.`);
      return 1;
    }
  }
  const { bucket, dispose } = await openBucket(parsed);
  try {
    const swept = await sweepOrphans(bucket, rows, {
      root,
      now: Date.now(),
      minAgeMs: parsed.minAgeMs,
      dryRun: parsed.dryRun,
    });
    for (const g of swept)
      console.log(
        `  ${parsed.dryRun ? "would delete" : "deleted"} ${g.prefix} (${g.files} file(s))`,
      );
    const files = swept.reduce((n, g) => n + g.files, 0);
    console.log(
      `${parsed.dryRun ? "Dry run: would delete" : "Deleted"} ${swept.length} orphaned prefix(es), ${files} file(s), under ${root} (${parsed.target}).`,
    );
    return 0;
  } finally {
    await dispose();
  }
}

/**
 * erase-user / erase-artifact: list the stored files, delete them from R2, then delete the rows
 * (the database cascades do the rest). Files first, so a failure leaves rows that can be erased
 * again rather than files nothing points to. Last of the files, everything else under each erased
 * artifact's root goes too (objects an interrupted publish left, which no row names).
 */
async function erase(parsed) {
  const what =
    parsed.command === "erase-user" ? `user ${parsed.subject}` : `artifact ${parsed.subject}`;
  const q = wrangler(parsed.keysArgs);
  const qf = failed(q);
  if (qf) return qf;
  const rows = resultSets(q.stdout).flat();
  const keys = keysFromRows(rows);
  const roots = rootsFromRows(rows);
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
  try {
    const { bucket, dispose } = await openBucket(parsed);
    try {
      const rest = await deleteRoots(bucket, roots);
      if (rest > 0) console.log(`Deleted ${rest} more file(s) no version pointed to.`);
    } finally {
      await dispose();
    }
  } catch (err) {
    console.error(
      `Could not list the bucket (${err instanceof Error ? err.message : err}); files no version points to may remain. Run sweep-orphans later.`,
    );
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

async function main() {
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

  if (parsed.command === "sweep-orphans") return sweep(parsed);
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

process.exitCode = await main();
