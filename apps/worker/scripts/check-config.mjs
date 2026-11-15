#!/usr/bin/env node
// Refuse a Worker config this release must not be deployed with (deploy-lib runtimeConfigProblem:
// the enable_request_signal flag and the hourly cron trigger). A checkout deploy runs
// `wrangler deploy --config wrangler.<env>.jsonc` itself, so the refusal in `plinth deploy` and
// `scripts/setup.mjs --remote` never sees that file; the Worker's `build` runs this first.
//
//   node scripts/check-config.mjs [--dir <worker dir>] [config ...]
//
// With no config named it checks wrangler.jsonc and every wrangler.<env>.jsonc in the directory
// (default: apps/worker). Exits 1 and names each file that fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfigProblem } from "./deploy-lib.mjs";
import { parseJsonc } from "./instance.mjs";

const CONFIG_RE = /^wrangler(\.[A-Za-z0-9_-]+)?\.jsonc$/;

/** Each named config (or every wrangler*.jsonc in `dir`) with what is wrong with it. */
export function checkWorkerConfigs(dir, files = []) {
  const names =
    files.length > 0
      ? files
      : readdirSync(dir)
          .filter((f) => CONFIG_RE.test(f))
          .sort();
  const problems = [];
  for (const name of names) {
    const file = path.resolve(dir, name);
    if (!existsSync(file)) {
      problems.push({ name, problem: "no such file" });
      continue;
    }
    let cfg;
    try {
      cfg = parseJsonc(readFileSync(file, "utf8"));
    } catch (e) {
      problems.push({ name, problem: `not valid JSONC (${e.message})` });
      continue;
    }
    const problem = runtimeConfigProblem(cfg);
    if (problem) problems.push({ name, problem });
  }
  return { checked: names, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = path.resolve(args[++i] ?? ".");
    else files.push(args[i]);
  }
  const { problems } = checkWorkerConfigs(dir, files);
  if (problems.length > 0) {
    for (const { name, problem } of problems) console.error(`check-config: ${name}: ${problem}`);
    console.error(
      "check-config: for a wrangler.<env>.jsonc that setup wrote, re-run " +
        "`node scripts/setup.mjs --remote` with the arguments you first used: it adds the " +
        "release's flags and cron trigger and keeps the rest (docs/deploy-checklist.md#6-upgrading-and-rolling-back)",
    );
    process.exit(1);
  }
}
