#!/usr/bin/env node
// Start a local Plinth instance made by `node scripts/setup.mjs --tunnel` (docs/local-hosting.md):
// the Worker under wrangler dev on 127.0.0.1, and cloudflared for the tunnel. Both stop together.
//
//   pnpm local:start [--name plinth] [--home ~/.plinth] [--no-tunnel]
//
// --no-tunnel runs only the Worker (for tests, or when cloudflared runs as its own service).
// Exit code: 0 after Ctrl-C or SIGTERM; 1 when either process stops on its own.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { instancePaths, startCommands } from "../apps/worker/scripts/tunnel-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "apps", "worker");
const wranglerBin = path.join(workerDir, "node_modules", ".bin", "wrangler");

function fail(message) {
  console.error(`local:start: ${message}`);
  process.exit(1);
}

const opts = { name: "plinth", home: null, tunnel: true };
const argv = process.argv.slice(2).filter((a) => a !== "--");
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-tunnel") opts.tunnel = false;
  else if (a === "--name" || a === "--home") {
    const v = argv[++i];
    if (!v || v.startsWith("--")) fail(`${a} needs a value`);
    opts[a.slice(2)] = v;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: pnpm local:start [--name plinth] [--home ~/.plinth] [--no-tunnel]");
    process.exit(0);
  } else fail(`Unexpected argument: ${a}`);
}

const { PLINTH_HOME: envHome } = process.env;
const home = path.resolve(opts.home ?? envHome ?? path.join(os.homedir(), ".plinth"));
const paths = instancePaths(home, opts.name);
if (!existsSync(paths.wranglerConfig) || !existsSync(paths.meta))
  fail(
    `No instance "${opts.name}" in ${home}. Create it with: node scripts/setup.mjs --tunnel ` +
      "(see docs/local-hosting.md)",
  );
const { port } = JSON.parse(readFileSync(paths.meta, "utf8"));
if (opts.tunnel && !existsSync(paths.cloudflaredConfig))
  fail(
    `${paths.cloudflaredConfig} is missing: the instance was set up with --no-cloudflare. ` +
      "Rerun setup with CLOUDFLARE_API_TOKEN set, or start with --no-tunnel",
  );
if (opts.tunnel && spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0)
  fail(
    "cloudflared is not installed: " +
      "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
  );
if (!existsSync(wranglerBin)) fail("wrangler is not installed. Run `pnpm install` first.");

// wrangler dev serves a D1/R2 explorer and a log query API at /cdn-cgi/local/* to loopback
// requests; on a production instance that would let any local process read the database, so both
// are off. Its logs (which include the Worker's console output) go to the instance directory
// instead of the world-readable global wrangler log folder.
const logDir = path.join(paths.dir, "logs");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
chmodSync(logDir, 0o700);
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  X_LOCAL_EXPLORER: "false",
  X_LOCAL_OBSERVABILITY: "false",
  WRANGLER_LOG_PATH: logDir,
};

if (!existsSync(path.join(root, "apps", "web", "dist", "index.html"))) {
  console.log("> Building the web app (first start)");
  const b = spawnSync("pnpm", ["--filter", "@plinth/web", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (b.status !== 0) fail("web build failed");
}

console.log("> Applying D1 migrations");
const m = spawnSync(
  wranglerBin,
  [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    paths.wranglerConfig,
    "--persist-to",
    paths.state,
  ],
  { cwd: workerDir, env, stdio: ["ignore", "ignore", "inherit"] },
);
if (m.status !== 0) fail("migrations failed");

const cmds = startCommands(paths, port, opts.tunnel);
const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }, 5000);
  force.unref();
  Promise.all(
    children.map((c) =>
      c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.once("exit", r)),
    ),
  ).then(() => process.exit(code));
}

function run(label, bin, args, cwd) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => {
    console.error(`local:start: ${label} failed to start: ${e.message}`);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`local:start: ${label} stopped (${signal ?? `exit ${code}`}); stopping the rest`);
    stopAll(1);
  });
  children.push(child);
}

console.log(`> Starting the Worker on http://127.0.0.1:${port}`);
run("wrangler", wranglerBin, cmds.wrangler, workerDir);
if (cmds.cloudflared) {
  console.log("> Starting the tunnel");
  run("cloudflared", "cloudflared", cmds.cloudflared, paths.dir);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stopAll(0));
