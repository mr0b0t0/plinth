#!/usr/bin/env node
// Refuse a Worker config this release must not be deployed with (deploy-lib runtimeConfigProblem:
// the enable_request_signal flag and the hourly cron trigger). A checkout deploy runs wrangler
// itself, so the refusal in `plinth deploy` and `scripts/setup.mjs --remote` never sees that file;
// the Worker's `deploy:production` and `deploy:staging` scripts run this on their config first.
//
//   node scripts/check-config.mjs [--warn] [--dir <worker dir>] [config ...]
//
// With no config named it checks wrangler.jsonc and every wrangler.<env>.jsonc in the directory
// (default: apps/worker). Exits 1 and names each file that fails. With --warn (the Worker's
// `build`) it prints one warning line per file that fails and exits 0: a stale git-ignored config
// on someone's machine must not break the build, only its deploy. Without --warn it also prints a
// note for a config that passes but leaves something optional off (deploy-lib runtimeConfigNotes:
// no live-rooms binding), and still exits 0 for it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfigMissing, runtimeConfigNotes, runtimeConfigProblem } from "./deploy-lib.mjs";
import { parseJsonc } from "./instance.mjs";

const CONFIG_RE = /^wrangler(\.[A-Za-z0-9_-]+)?\.jsonc$/;

/**
 * Each named config (or every wrangler*.jsonc in `dir`) with what is wrong with it, and notes on
 * the ones that pass.
 */
export function checkWorkerConfigs(dir, files = []) {
  const names =
    files.length > 0
      ? files
      : readdirSync(dir)
          .filter((f) => CONFIG_RE.test(f))
          .sort();
  const problems = [];
  const notes = [];
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
    if (problem) problems.push({ name, problem, missing: runtimeConfigMissing(cfg) });
    else for (const note of runtimeConfigNotes(cfg)) notes.push({ name, note });
  }
  return { checked: names, problems, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let warn = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir") dir = path.resolve(args[++i] ?? ".");
    else if (args[i] === "--warn") warn = true;
    else files.push(args[i]);
  }
  const { problems, notes } = checkWorkerConfigs(dir, files);
  if (warn) {
    for (const { name, missing, problem } of problems) {
      const what = missing ? `lacks ${missing.join(" and ")}` : problem;
      console.error(
        `check-config: warning: ${name}: ${what}; the deploy:<env> scripts and check-config refuse ` +
          "it until it has them (docs/deploy-checklist.md#6-upgrading-and-rolling-back)",
      );
    }
  } else if (problems.length > 0) {
    for (const { name, problem } of problems) console.error(`check-config: ${name}: ${problem}`);
    console.error(
      "check-config: for a wrangler.<env>.jsonc that setup wrote, re-run " +
        "`node scripts/setup.mjs --remote` with the arguments you first used: it adds the " +
        "release's flags and cron trigger and keeps the rest (docs/deploy-checklist.md#6-upgrading-and-rolling-back)",
    );
    process.exit(1);
  } else {
    for (const { name, note } of notes) console.error(`check-config: note: ${name}: ${note}`);
  }
}
