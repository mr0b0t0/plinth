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
// deployed one (wrangler login or CLOUDFLARE_API_TOKEN, as for the other commands). The bucket is
// always the FILES binding of the wrangler config and environment the database comes from
// (--config, --env), read with wrangler's own config resolution, so the two cannot belong to
// different instances.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changesFromOutput,
  deleteRoots,
  filesBucket,
  keysFromRows,
  parseArgs,
  parseResultSets,
  resultSets,
  rootsFromRows,
  SweepRefused,
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
 * The name of the bucket the database's own config binds as FILES: the config file --config names
 * (apps/worker/wrangler.jsonc without it) with the --env section applied, exactly as
 * `wrangler d1 execute` resolves the database. --bucket, when given, must agree.
 */
async function resolveBucket(parsed) {
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({
    config: join(packageDir, parsed.config ?? "wrangler.jsonc"),
    ...(parsed.env ? { env: parsed.env } : {}),
  });
  return filesBucket(config.r2_buckets, parsed.bucket);
}

/**
 * The R2 bucket as a binding, through a throwaway wrangler config that binds only that bucket:
 * locally the state `wrangler dev` keeps in .wrangler/state, with --remote the deployed bucket.
 */
async function openBucket(parsed, bucketName) {
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
          bucket_name: bucketName,
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

/** The version prefixes the database names, or SweepRefused when its answer cannot be read. */
function loadPrefixRows(parsed) {
  const q = wrangler(parsed.prefixesArgs);
  if (failed(q)) throw new SweepRefused("The database query failed");
  const sets = parseResultSets(q.stdout);
  if (!sets) throw new SweepRefused("The database answer could not be read");
  return sets.flat();
}

/**
 * sweep-orphans: version prefixes no row names, older than the threshold, are deleted. The bucket
 * is listed before the rows are read (sweepOrphans), and every doubt refuses rather than deletes.
 */
async function sweep(parsed) {
  try {
    return await sweepOrRefuse(parsed);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    if (!(e instanceof SweepRefused)) throw e;
    console.error(`Refusing to sweep (${parsed.target}): ${e.message}. Nothing was deleted.`);
    return 1;
  }
}

async function sweepOrRefuse(parsed) {
  const bucketName = await resolveBucket(parsed);
  let root = "artifacts/";
  if (parsed.artifact !== null) {
    const [one] = rootsFromRows(loadPrefixRows(parsed));
    if (!one) {
      console.error(
        `No artifact ${parsed.artifact} in the ${parsed.target} database. Files of an artifact whose first publish failed go with a sweep without --artifact.`,
      );
      return 1;
    }
    root = one;
  }
  const { bucket, dispose } = await openBucket(parsed, bucketName);
  try {
    const swept = await sweepOrphans(bucket, {
      root,
      now: Date.now(),
      minAgeMs: parsed.minAgeMs,
      dryRun: parsed.dryRun,
      loadRows: async () => loadPrefixRows(parsed),
    });
    for (const g of swept)
      console.log(
        `  ${parsed.dryRun ? "would delete" : "deleted"} ${g.prefix} (${g.files} file(s))`,
      );
    const files = swept.reduce((n, g) => n + g.files, 0);
    console.log(
      `${parsed.dryRun ? "Dry run: would delete" : "Deleted"} ${swept.length} orphaned prefix(es), ${files} file(s), under ${root} in ${bucketName} (${parsed.target}).`,
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
  let bucketName;
  try {
    bucketName = await resolveBucket(parsed);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
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
    const r = wrangler(parsed.deleteObjectArgs(bucketName, key));
    const f = failed(r);
    if (f) {
      console.error(
        `Stopped at ${key}; nothing in the database was changed. Run the command again.`,
      );
      return f;
    }
  }
  try {
    const { bucket, dispose } = await openBucket(parsed, bucketName);
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
  if (parsed.command === "bump-epochs") {
    const r = wrangler(parsed.wranglerArgs);
    const f = failed(r);
    if (f) return f;
    const n = changesFromOutput(r.stdout);
    console.log(
      `Ended the passes of ${n ?? "every"} artifact${n === 1 ? "" : "s"} shared through a category (${parsed.target}).`,
    );
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

process.exitCode = await main();
