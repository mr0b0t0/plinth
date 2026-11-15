#!/usr/bin/env node
// Start a local Plinth instance made by `node scripts/setup.mjs --tunnel` (docs/local-hosting.md):
// the Worker under wrangler dev on 127.0.0.1, and cloudflared for the tunnel. Both stop together.
// The logic is shared with the npm CLI (apps/worker/scripts/instance.mjs).
//
//   pnpm local:start [--name plinth] [--home ~/.plinth] [--no-tunnel]
//
// --no-tunnel runs only the Worker (for tests, or when cloudflared runs as its own service).
// Exit code: 0 after Ctrl-C or SIGTERM; 1 when either process stops on its own.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceError, parseJsonc, startInstance } from "../apps/worker/scripts/instance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "apps", "worker");
const wranglerBin = path.join(workerDir, "node_modules", ".bin", "wrangler");

function fail(message) {
  console.error(`local:start: ${message}`);
  process.exit(1);
}

const opts = {};
const argv = process.argv.slice(2).filter((a) => a !== "--");
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-tunnel") opts["no-tunnel"] = true;
  else if (a === "--name" || a === "--home") {
    const v = argv[++i];
    if (!v || v.startsWith("--")) fail(`${a} needs a value`);
    opts[a.slice(2)] = v;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: pnpm local:start [--name plinth] [--home ~/.plinth] [--no-tunnel]");
    process.exit(0);
  } else fail(`Unexpected argument: ${a}`);
}
if (!existsSync(wranglerBin)) fail("wrangler is not installed. Run `pnpm install` first.");

try {
  const code = await startInstance(opts, {
    label: "local:start",
    base: parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8")),
    wrangler: { command: wranglerBin, args: [], cwd: workerDir },
    setupHint: "node scripts/setup.mjs --tunnel (see docs/local-hosting.md)",
    ensureBuilt: () => {
      if (existsSync(path.join(root, "apps", "web", "dist", "index.html"))) return;
      console.log("> Building the web app (first start)");
      const b = spawnSync("pnpm", ["--filter", "@plinth/web", "build"], {
        cwd: root,
        stdio: "inherit",
      });
      if (b.status !== 0) fail("web build failed");
    },
  });
  process.exit(code);
} catch (e) {
  if (e instanceof InstanceError) fail(e.message);
  throw e;
}
