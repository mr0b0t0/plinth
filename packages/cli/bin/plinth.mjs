#!/usr/bin/env node
// plinth: run Plinth on your own computer (docs/local-hosting.md).
//
//   plinth init --email you@example.com      localhost-only: no domain, no Cloudflare account
//   plinth init --tunnel --app-host ... --content-host ... --email-provider ...
//                                            reachable from the internet through a Cloudflare Tunnel
//   plinth start | status | connect          run it, check it, connect agents to it
//
// Every command takes --name (default plinth) and --home (default ~/.plinth, or PLINTH_HOME).
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(pkgDir, "runtime");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

const USAGE = `plinth ${pkg.version}: run Plinth on your own computer

Usage:
  plinth init [--email you@example.com] [--port 8788]
      Localhost-only instance: one account, this computer only, no domain needed.
      Sign-in codes appear in the terminal that runs \`plinth start\`.
  plinth init --tunnel --app-host plinth.example.com --content-host example-content.net
              --email-provider resend|sendgrid|console [--email-from "Plinth <noreply@...>"]
              [--single-user --admin-email you@example.com] [--content-isolation origin|opaque]
              [--no-cloudflare] [--replace-tunnel] [--port 8788]
      Reachable from the internet through a Cloudflare Tunnel. Needs two domains on Cloudflare,
      cloudflared, and CLOUDFLARE_API_TOKEN for setup (see docs/local-hosting.md).
  plinth start [--no-tunnel] [--listen 127.0.0.1]
                               Run the instance (Ctrl-C stops it). Applies new migrations first.
                               --listen (or PLINTH_LISTEN) sets the Worker's address, e.g. 0.0.0.0
                               in a container; the default is 127.0.0.1.
  plinth status                Show the instance's address and whether it is running.
  plinth connect               Print how to connect Claude Code, Codex, Cursor and others.

Common options: --name <name> (default plinth), --home <dir> (default ~/.plinth or PLINTH_HOME),
--force (init: replace existing secrets), --dry-run (init: show the plan only).
Upgrade: run a newer version of this package; \`plinth start\` applies its migrations.`;

const BOOLEAN = new Set([
  "tunnel",
  "single-user",
  "no-cloudflare",
  "replace-tunnel",
  "no-tunnel",
  "force",
  "dry-run",
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
  try {
    instance = await import(path.join(runtimeDir, "scripts", "instance.mjs"));
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
    startCommand: (name, home) =>
      `plinth start${name === "plinth" ? "" : ` --name ${name}`}${home ? ` --home ${home}` : ""}`,
    setupHint: "plinth init --email you@example.com",
  };
  return { instance, runtime };
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

function requireInstance(instance, opts) {
  const name = opts.name ?? "plinth";
  const home = instance.resolveHome(opts.home);
  const inst = instance.readInstance(home, name);
  if (!inst)
    die(`No instance "${name}" in ${home}. Create one with: plinth init --email you@example.com`);
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

const { command, opts } = parseArgs(process.argv.slice(2));
if (opts.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (opts.help || !command || command === "help") {
  console.log(USAGE);
  process.exit(command || opts.help ? 0 : 1);
}

const { instance, runtime } = await loadRuntime();
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
    console.log(`\nConnect your agents: plinth connect${selector(opts)}`);
  } else if (command === "start") {
    process.exit(await instance.startInstance(opts, runtime));
  } else if (command === "status") {
    const inst = requireInstance(instance, opts);
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
      `Status:    ${h?.ok ? `running on 127.0.0.1:${inst.port}` : `not running (start it: plinth start${selector(opts)})`}`,
    );
    process.exit(h?.ok ? 0 : 3);
  } else if (command === "connect") {
    await printConnect(requireInstance(instance, opts));
  } else die(`Unknown command "${command}". Run plinth --help`);
} catch (e) {
  if (e instanceof instance.InstanceError) die(e.message);
  throw e;
}
