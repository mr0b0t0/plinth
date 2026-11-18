#!/usr/bin/env node
// Assemble packages/cli/runtime/: everything the published CLI needs to run Plinth without this
// repo. Runs after the Worker and web builds (turbo orders it through the workspace devDependencies).
//
//   runtime/worker/index.js     the Worker, bundled by `wrangler deploy --dry-run` (apps/worker/dist),
//                               which exports the live-rooms Durable Object class ArtifactRoom
//   runtime/web/                the built web app (apps/web/dist)
//   runtime/migrations/         the D1 migrations
//   runtime/scripts/            instance.mjs, deploy.mjs and the helpers they import
//   runtime/wrangler.base.json  compatibility settings, the cron trigger, assets settings, the ROOMS
//                               binding and its migration, and default vars (deploy-lib.mjs
//                               runtimeBase)
//   runtime/harnesses.mjs       the harness registry (packages/shared), types stripped
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkgDir, "../..");
const out = path.join(pkgDir, "runtime");

const fail = (m) => {
  console.error(`bundle: ${m}`);
  process.exit(1);
};

const workerJs = path.join(root, "apps/worker/dist/index.js");
const webDir = path.join(root, "apps/web/dist");
if (!existsSync(workerJs)) fail("apps/worker/dist/index.js is missing: run `pnpm build` first");
if (!existsSync(path.join(webDir, "index.html")))
  fail("apps/web/dist is missing: run `pnpm build`");
// Every generated config binds ROOMS to this class, and wrangler refuses to run or deploy a Worker
// that does not export the class a binding names.
if (!/\bexport\s*\{[^}]*\bArtifactRoom\b[^}]*\}/.test(readFileSync(workerJs, "utf8")))
  fail("apps/worker/dist/index.js does not export ArtifactRoom: rebuild with `pnpm build`");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "worker"), { recursive: true });
cpSync(workerJs, path.join(out, "worker/index.js"));
cpSync(webDir, path.join(out, "web"), { recursive: true });
mkdirSync(path.join(out, "migrations"));
for (const f of readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")))
  cpSync(path.join(root, "migrations", f), path.join(out, "migrations", f));
mkdirSync(path.join(out, "scripts"));
for (const f of [
  "instance.mjs",
  "tunnel-lib.mjs",
  "tunnel-cloudflare.mjs",
  "deploy.mjs",
  "deploy-lib.mjs",
])
  cpSync(path.join(root, "apps/worker/scripts", f), path.join(out, "scripts", f));

// The repo's wrangler.jsonc, minus everything instance-specific (setup writes those per instance).
const { parseJsonc } = await import(path.join(root, "apps/worker/scripts/instance.mjs"));
const { runtimeBase, runtimeConfigProblem } = await import(
  path.join(root, "apps/worker/scripts/deploy-lib.mjs")
);
const repoCfg = parseJsonc(readFileSync(path.join(root, "apps/worker/wrangler.jsonc"), "utf8"));
const base = runtimeBase(repoCfg);
const problem = runtimeConfigProblem(base);
if (problem) fail(`apps/worker/wrangler.jsonc: ${problem}`);
writeFileSync(path.join(out, "wrangler.base.json"), `${JSON.stringify(base, null, 2)}\n`);

// The same registry the web app's Connect panel uses, so `plinth connect` says the same things.
const registry = readFileSync(path.join(root, "packages/shared/src/harnesses.ts"), "utf8");
writeFileSync(path.join(out, "harnesses.mjs"), stripTypeScriptTypes(registry));
console.log(`bundle: wrote ${path.relative(root, out)}`);
