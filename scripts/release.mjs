#!/usr/bin/env node
// Cut a release (docs/releasing.md). On an up-to-date, clean main:
//
//   pnpm release 0.2.0 [--push] [--dry-run]
//
// sets the version of the npm CLI (packages/cli/package.json) and every pin of the GitHub Action
// and the CLI for CI (scripts/ci-pins.mjs), turns the "Unreleased" section of CHANGELOG.md into
// "<version> (<date>)", commits "Release v<version>" and makes the annotated tag v<version>. With --push it pushes main and the tag; the tag starts .github/workflows/release.yml,
// which runs CI and publishes npm, the Docker image and the GitHub release.
//
//   node scripts/release.mjs --notes 0.2.0
//
// prints that version's CHANGELOG section (the release workflow uses it as the release notes).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_PINNED, withCiPins } from "./ci-pins.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = path.join(root, "CHANGELOG.md");
const CLI_PKG = path.join(root, "packages", "cli", "package.json");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, { capture = true } = {}) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed${capture ? `: ${r.stderr.trim()}` : ""}`);
  return (r.stdout ?? "").trim();
}

/** The body of the `## <heading>` section, without its heading. */
function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [version] = args.filter((a) => !a.startsWith("--"));
if (!version || !SEMVER.test(version))
  fail("usage: pnpm release <version> [--push] [--dry-run]   (version like 0.2.0 or 0.2.0-rc.1)");

const changelog = readFileSync(CHANGELOG, "utf8");

if (flags.has("--notes")) {
  const body = section(changelog, `${version} `) ?? section(changelog, version);
  if (!body) fail(`CHANGELOG.md has no section for ${version}`);
  console.log(
    `${body}\n\nInstall: \`npx @mr0b0t0/plinth@${version}\` · Docker: \`ghcr.io/mr0b0t0/plinth:${version}\``,
  );
  process.exit(0);
}

const dryRun = flags.has("--dry-run");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`releases are cut from main (you are on ${branch})`);
if (git(["status", "--porcelain"])) fail("the working tree has uncommitted changes");
git(["fetch", "--quiet", "origin", "main", "--tags"]);
if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "origin/main"]))
  fail("main is not the same as origin/main; pull or push first");
if (git(["tag", "-l", `v${version}`])) fail(`tag v${version} already exists`);

const pkg = JSON.parse(readFileSync(CLI_PKG, "utf8"));
const unreleased = section(changelog, "Unreleased");
if (!unreleased) fail('CHANGELOG.md has nothing under "## Unreleased"; describe the release first');

const date = new Date().toISOString().slice(0, 10);
const nextChangelog = changelog.replace(
  /^## Unreleased\n/m,
  `## Unreleased\n\n## ${version} (${date})\n`,
);
console.log(`Release v${version} (CLI ${pkg.version} -> ${version})\n\n${unreleased}\n`);
if (dryRun) {
  console.log("Dry run: nothing written, committed or tagged.");
  process.exit(0);
}

pkg.version = version;
writeFileSync(CLI_PKG, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(CHANGELOG, nextChangelog);
const pinned = CI_PINNED.map((rel) => path.join(root, rel));
for (const file of pinned) writeFileSync(file, withCiPins(readFileSync(file, "utf8"), version));
git(["add", CLI_PKG, CHANGELOG, ...pinned]);
git(["commit", "--quiet", "-m", `Release v${version}`]);
git(["tag", "-a", `v${version}`, "-m", `v${version}`]);
console.log(`Committed and tagged v${version}.`);
if (flags.has("--push")) {
  git(["push", "--quiet", "--atomic", "origin", "main", `v${version}`], { capture: false });
  console.log("Pushed. Follow the release: gh run watch (workflow Release).");
} else {
  console.log(`Push to publish: git push --atomic origin main v${version}`);
}
