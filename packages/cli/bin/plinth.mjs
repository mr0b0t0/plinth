#!/usr/bin/env node
// plinth: run Plinth on your own computer (docs/local-hosting.md), or deploy it to your own
// Cloudflare account (docs/self-hosting.md).
//
//   plinth init --email you@example.com      localhost-only: no domain, no Cloudflare account
//   plinth init --tunnel --app-host ... --content-host ... --email-provider ...
//                                            reachable from the internet through a Cloudflare Tunnel
//   plinth start | status | connect          run it, check it, connect agents to it
//   plinth deploy --app-host ... --content-host ... --email-provider ...
//                                            Workers, D1 and R2 on your Cloudflare account; rerun
//                                            with no flags to redeploy or upgrade
//
//   plinth login | logout | whoami            sign in to any instance (OAuth in the browser)
//   plinth publish <dir> [--id REF]          publish a build folder, or its next version
//   plinth upload <dir> --to <upload_url>    send a folder with a start_upload ticket
//
// Every command takes --name (default plinth) and --home (default ~/.plinth, or PLINTH_HOME).
// Hints name the command as it was run: `npx @mr0b0t0/plinth <cmd>` under npx, else `plinth <cmd>`.
// The client commands (bin/client/) are dispatched before the runtime is loaded: they need no
// build, no dependencies and no wrangler.
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { claudeCodeConnectText } from "./client/connect.mjs";
import { clientCommandOf, main as clientMain, clientUsage } from "./client/main.mjs";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(pkgDir, "runtime");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

/** How to run a plinth command, the way the user ran this one: through npx, or installed. */
const viaNpx = process.env.npm_command === "exec";
const cli = (args) => `${viaNpx ? `npx ${pkg.name}` : "plinth"} ${args}`;
const p = viaNpx ? `npx ${pkg.name}` : "plinth";

const USAGE = `plinth ${pkg.version}: run Plinth on your own computer or on your Cloudflare account

Usage:
  ${p} init [--email you@example.com] [--port 8788]
      Localhost-only instance: one account, this computer only, no domain needed.
      Sign-in codes appear in the terminal that runs \`${cli("start")}\`.
  ${p} init --tunnel --app-host plinth.example.com --content-host example-content.net
      --email-provider resend|sendgrid|console [--email-from "Plinth <noreply@...>"]
      [--single-user --admin-email you@example.com] [--content-isolation origin|opaque]
      [--no-cloudflare] [--replace-tunnel] [--port 8788]
      Reachable from the internet through a Cloudflare Tunnel. Needs two domains on Cloudflare,
      cloudflared, and CLOUDFLARE_API_TOKEN for setup (see docs/local-hosting.md).
  ${p} start [--no-tunnel] [--listen 127.0.0.1]
      Run the instance (Ctrl-C stops it). Applies new migrations first. --listen (or
      PLINTH_LISTEN) sets the Worker's address, e.g. 0.0.0.0 in a container; default 127.0.0.1.
  ${p} status [--cloudflare]
      Show the instance's address and whether it is running.
  ${p} connect [--cloudflare]
      Print how to connect Claude Code, Codex, Cursor and others.
  ${p} deploy --app-host plinth.example.com --content-host example-content.net
      --email-provider resend|sendgrid|console [--email-from "Plinth <noreply@...>"]
      [--admin-email you@example.com] [--single-user | --multi-user]
      [--content-isolation origin|opaque] [--operator-name "..." --operator-email ...]
      [--operator-address "..."] [--operator-registration "..."] [--rotate-secrets]
      Run Plinth on your own Cloudflare account (Workers, D1, R2) with two domains on it.
      Uses wrangler's login, or CLOUDFLARE_API_TOKEN; takes RESEND_API_KEY or SENDGRID_API_KEY
      from the environment. Rerun with no flags to redeploy the saved settings or upgrade;
      flags given then change the saved settings ("" clears an optional one).

status and connect use the local instance of that name if there is one; --cloudflare picks the
Cloudflare deployment.
Common options: --name <name> (default plinth), --home <dir> (default ~/.plinth or PLINTH_HOME),
--force (init: replace existing secrets), --dry-run (init, deploy: show the plan only).
Upgrade: run a newer version of this package. \`${cli("start")}\` applies its migrations;
\`${cli("deploy")}\` applies them to your Cloudflare deployment and deploys the new Worker.

${clientUsage(p)}`;

const BOOLEAN = new Set([
  "tunnel",
  "single-user",
  "no-cloudflare",
  "replace-tunnel",
  "no-tunnel",
  "force",
  "dry-run",
  "rotate-secrets",
  "multi-user",
  "cloudflare",
  "help",
  "version",
]);

function die(message) {
  console.error(`plinth: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") opts.help = true;
    else if (a === "-v") opts.version = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN.has(key)) opts[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) die(`--${key} needs a value`);
        opts[key] = v;
        i++;
      }
    } else if (!command) command = a;
    else die(`Unexpected argument: ${a}`);
  }
  return { command, opts };
}

async function loadRuntime() {
  let instance;
  let deploy;
  try {
    instance = await import(path.join(runtimeDir, "scripts", "instance.mjs"));
    deploy = await import(path.join(runtimeDir, "scripts", "deploy.mjs"));
  } catch {
    die("this copy of plinth has no runtime/ folder. In the repo, run `pnpm build` first.");
  }
  const { getDomain } = require("tldts");
  const wranglerPkgPath = require.resolve("wrangler/package.json");
  const wranglerPkg = JSON.parse(readFileSync(wranglerPkgPath, "utf8"));
  const binRel = typeof wranglerPkg.bin === "string" ? wranglerPkg.bin : wranglerPkg.bin.wrangler;
  const base = JSON.parse(readFileSync(path.join(runtimeDir, "wrangler.base.json"), "utf8"));
  const runtime = {
    label: "plinth",
    layout: {
      main: path.join(runtimeDir, "worker", "index.js"),
      assetsDir: path.join(runtimeDir, "web"),
      migrationsDir: path.join(runtimeDir, "migrations"),
    },
    base,
    wrangler: {
      command: process.execPath,
      args: [path.join(path.dirname(wranglerPkgPath), binRel)],
      cwd: runtimeDir,
    },
    getDomain: (h) => getDomain(h, { allowPrivateDomains: true }),
    // The Cloudflare zone a host belongs to: its registrable domain without the private section.
    getZone: (h) => getDomain(h),
    startCommand: (name, home) =>
      cli(`start${name === "plinth" ? "" : ` --name ${name}`}${home ? ` --home ${home}` : ""}`),
    setupHint: cli("init --email you@example.com"),
    command: cli,
  };
  return { instance, deploy, runtime };
}

/** GET /healthz on the local Worker, with the instance's own Host header (it routes by host). */
function health(port, host) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/healthz", headers: { host }, timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * The local instance of that name or, with --cloudflare or when there is none, the Cloudflare
 * deployment.
 */
function requireInstance(opts) {
  const name = opts.name ?? "plinth";
  const home = instance.resolveHome(opts.home);
  const inst =
    (opts.cloudflare ? null : instance.readInstance(home, name)) ??
    deploy.readDeployment(home, name);
  if (!inst)
    die(
      opts.cloudflare
        ? `No Cloudflare deployment "${name}" in ${home}. Create one with: ${cli("deploy --app-host ... --content-host ... --email-provider ...")}`
        : `No instance "${name}" in ${home}. Create one with: ${cli("init --email you@example.com")}`,
    );
  return inst;
}

function selector(opts) {
  return `${opts.name && opts.name !== "plinth" ? ` --name ${opts.name}` : ""}${opts.home ? ` --home ${opts.home}` : ""}`;
}

async function printConnect(inst) {
  const reg = await import(path.join(runtimeDir, "harnesses.mjs"));
  const endpoint = `${inst.appOrigin}/mcp`;
  const own = inst.appOrigin !== reg.HOSTED_ORIGIN;
  const indent = (text) => text.replace(/^/gm, "  ");
  console.log(`Plinth MCP endpoint: ${endpoint}`);
  console.log(
    "Agents sign in with OAuth: the first time, a browser opens on Plinth; click Allow.\n",
  );
  if (inst.mode === "local")
    console.log(
      "This instance runs on this computer only. Agents on this machine can use it; claude.ai\n" +
        "and ChatGPT connect from their own servers and cannot.\n",
    );
  const commands = {
    "claude-code": reg.claudeCodeCommand(endpoint),
    codex: reg.codexCommand(endpoint),
    "gemini-cli": reg.geminiCommand(endpoint),
  };
  for (const h of reg.HARNESSES) {
    if (inst.mode === "local" && !h.reachesLocal) continue;
    console.log(`${h.label}:`);
    if (h.id === "claude-code") {
      // Plugin first: the server plus the plinth-artifacts skill. The bare server is tools only.
      console.log(claudeCodeConnectText(reg, inst.appOrigin));
      console.log("");
      continue;
    }
    if (commands[h.id]) console.log(indent(commands[h.id]));
    else if (h.id === "other")
      console.log(`  OAuth 2.1 with discovery at ${reg.protectedResourceUrl(endpoint)}`);
    else console.log(`  Sign in at ${inst.appOrigin} and open Connections > Connect an agent.`);
    const g = h.guidance;
    console.log(`  Plinth's rules: ${g.summary}`);
    if (g.commands) console.log(indent(indent(g.commands)));
    if (g.link) console.log(`    ${g.link.href}`);
    if (own && g.ownInstance) console.log(`    ${g.ownInstance}`);
    console.log("");
  }
}

// Client commands first: they never load the runtime (or wrangler).
if (clientCommandOf(process.argv.slice(2))) {
  const code = await clientMain(process.argv.slice(2), { prog: p });
  // Pipes are asynchronous on macOS: let pending output (e.g. --json) drain before exiting.
  await new Promise((r) => process.stdout.write("", () => process.stderr.write("", r)));
  process.exit(code);
}

const { command, opts } = parseArgs(process.argv.slice(2));
if (opts.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (opts.help || !command || command === "help") {
  console.log(USAGE);
  process.exit(command || opts.help ? 0 : 1);
}

const { instance, deploy, runtime } = await loadRuntime();
try {
  if (command === "init") {
    if (!opts.tunnel && !opts.email && !opts["admin-email"]) {
      if (!process.stdin.isTTY)
        die("--email <address> is required (the one account that can sign in)");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      opts.email = (
        await rl.question("Your email address (the one account that can sign in): ")
      ).trim();
      rl.close();
    }
    await instance.setupInstance(opts, runtime);
    console.log(`\nConnect your agents: ${cli(`connect${selector(opts)}`)}`);
  } else if (command === "start") {
    process.exit(await instance.startInstance(opts, runtime));
  } else if (command === "deploy") {
    const r = await deploy.deployToCloudflare(opts, runtime);
    if (opts["dry-run"])
      console.log(`\nThen connect your agents: ${cli(`connect --cloudflare${selector(opts)}`)}`);
    else {
      console.log(
        `\nConnect your agents (again any time: ${cli(`connect --cloudflare${selector(opts)}`)}):\n`,
      );
      await printConnect(r.instance);
    }
  } else if (command === "status" && requireInstance(opts).mode === "cloudflare") {
    const inst = requireInstance(opts);
    const ok = await deploy.remoteHealthy(inst.appHost);
    console.log(`Instance:  ${inst.name} (Cloudflare Workers, Worker ${inst.workerName})`);
    console.log(`App:       ${inst.appOrigin}`);
    console.log(`Artifacts: <id>.${inst.contentHost}`);
    console.log(
      `Account:   ${inst.singleUser ? `${inst.adminEmail} (single user)` : "multi-user"}`,
    );
    console.log(`Settings:  ${inst.paths.dir}`);
    console.log(
      `Status:    ${ok ? "running" : `not reachable (redeploy: ${cli(`deploy${selector(opts)}`)})`}`,
    );
    process.exit(ok ? 0 : 3);
  } else if (command === "status") {
    const inst = requireInstance(opts);
    const h = await health(inst.port, inst.appHost);
    console.log(
      `Instance:  ${inst.name} (${inst.mode === "local" ? "localhost only" : "Cloudflare Tunnel"})`,
    );
    console.log(`App:       ${inst.appOrigin}`);
    console.log(`Artifacts: <id>.${inst.contentHost}`);
    console.log(
      `Account:   ${inst.singleUser ? `${inst.adminEmail} (single user)` : "multi-user"}`,
    );
    console.log(`Data:      ${inst.paths.state}`);
    console.log(
      `Status:    ${h?.ok ? `running on 127.0.0.1:${inst.port}` : `not running (start it: ${cli(`start${selector(opts)}`)})`}`,
    );
    process.exit(h?.ok ? 0 : 3);
  } else if (command === "connect") {
    await printConnect(requireInstance(opts));
  } else die(`Unknown command "${command}". Run ${cli("--help")}`);
} catch (e) {
  if (e instanceof instance.InstanceError) die(e.message);
  throw e;
}
