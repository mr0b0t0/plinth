#!/usr/bin/env node
// Write docs/openapi.json from the same function that serves /openapi.json.
//
//   pnpm openapi                       # server URL https://plinth.aconite.io/api/v1
//   pnpm openapi --origin https://plinth.example.com
//   pnpm openapi --check               # exit 1 if docs/openapi.json is out of date (CI)
//
// Needs Node 22.18+ (TypeScript type stripping); pnpm runs the Node pinned in .npmrc. The output
// goes through Biome so `pnpm lint` and `--check` agree on the formatting.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = "docs/openapi.json";
const out = path.join(root, rel);

const args = process.argv.slice(2);
const originAt = args.indexOf("--origin");
const appOrigin = originAt >= 0 ? args[originAt + 1] : "https://plinth.aconite.io";
if (!appOrigin || !/^https?:\/\/[^/]+$/.test(appOrigin)) {
  console.error("--origin must look like https://host[:port]");
  process.exit(2);
}

const { openApiDocument } = await import(
  path.join(root, "apps", "worker", "src", "api", "openapi.ts")
);
const doc = openApiDocument({ appOrigin });

const biome = path.join(root, "node_modules", ".bin", "biome");
const formatted = spawnSync(biome, ["format", `--stdin-file-path=${rel}`], {
  cwd: root,
  input: JSON.stringify(doc),
  encoding: "utf8",
});
if (formatted.status !== 0) {
  console.error(formatted.stderr || "biome format failed");
  process.exit(1);
}
const text = formatted.stdout;

if (args.includes("--check")) {
  const current = await readFile(out, "utf8").catch(() => "");
  if (current !== text) {
    console.error(`${rel} is out of date. Run \`pnpm openapi\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${rel} is up to date.`);
} else {
  await writeFile(out, text);
  console.log(`Wrote ${rel} (${Object.keys(doc.paths).length} paths).`);
}
