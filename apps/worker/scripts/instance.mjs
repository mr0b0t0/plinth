// Local instances (docs/local-hosting.md): set up and start a Plinth instance in <home>/<name>/,
// either localhost-only (no domain, no Cloudflare account) or behind a Cloudflare Tunnel. Shared by
// scripts/setup.mjs --tunnel, scripts/local-start.mjs and the npm CLI (packages/cli), which differ
// only in where the Worker code and wrangler live (`runtime`, below). macOS and Linux only.
//
// runtime = {
//   layout,        // repo root, or { main, assetsDir, migrationsDir } (tunnel-lib.resolveLayout)
//   base,          // parsed apps/worker/wrangler.jsonc: compatibility settings and default limits
//   wrangler,      // { command, args: [...prefix], cwd }: how to run wrangler
//   getDomain,     // registrable domain of a host (tldts, private section included), or null
//   startCommand,  // (name, home) => the command that starts this instance, for messages
//   ensureBuilt,   // optional () => void, run before start (the repo builds the web app once)
//   label,         // prefix for messages, e.g. "setup" or "plinth"
// }
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as lib from "./tunnel-lib.mjs";

export class InstanceError extends Error {}

const fail = (message) => {
  throw new InstanceError(message);
};

const CLOUDFLARED_DOWNLOAD =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";

/** 48 random bytes, base64url: 64 characters. */
export const secret = () => randomBytes(48).toString("base64url");

/** Read a .dev.vars style file into an ordered list of lines and a key map. */
export function readEnvFile(file) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const values = new Map();
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  return { lines, values };
}

/** Set keys in an env file (mode 600), replacing existing lines and appending new ones. */
export function writeEnvFile(file, lines, updates) {
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${out.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Parse JSONC: strip comments outside strings and trailing commas. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) fail("Unterminated comment in wrangler config");
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The Plinth home directory: --home, else PLINTH_HOME, else ~/.plinth. */
export function resolveHome(flag) {
  const { PLINTH_HOME: envHome } = process.env;
  return path.resolve(flag ?? envHome ?? path.join(os.homedir(), ".plinth"));
}

/**
 * Environment for wrangler. wrangler dev serves a D1/R2 explorer and a log query API at
 * /cdn-cgi/local/* to loopback requests; on an instance holding real data that would let any local
 * process read the database, so both are off. Logs (which include the Worker's console output) go
 * to the instance directory instead of the world-readable global wrangler log folder.
 */
function wranglerEnv(logDir) {
  return {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    X_LOCAL_EXPLORER: "false",
    X_LOCAL_OBSERVABILITY: "false",
    ...(logDir ? { WRANGLER_LOG_PATH: logDir } : {}),
  };
}

function ensureLogDir(paths) {
  const logDir = path.join(paths.dir, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  return logDir;
}

function applyMigrations(runtime, paths, logDir) {
  const r = spawnSync(
    runtime.wrangler.command,
    [
      ...runtime.wrangler.args,
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
    { cwd: runtime.wrangler.cwd, env: wranglerEnv(logDir), stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) fail("applying the database migrations failed");
}

/** Read an instance's metadata; instances made before localhost mode existed are tunnel ones. */
export function readInstance(home, name) {
  const paths = lib.instancePaths(home, name);
  if (!existsSync(paths.wranglerConfig) || !existsSync(paths.meta)) return null;
  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  const cfg = parseJsonc(readFileSync(paths.wranglerConfig, "utf8"));
  const vars = cfg.vars ?? {};
  const mode = meta.mode ?? "tunnel";
  const scheme = vars.PUBLIC_SCHEME === "http" ? "http" : "https";
  return {
    paths,
    name: meta.name ?? name,
    port: meta.port,
    mode,
    appHost: vars.APP_HOST,
    contentHost: vars.CONTENT_HOST,
    appOrigin: `${scheme}://${vars.APP_HOST}`,
    singleUser: vars.SINGLE_USER_MODE === "true",
    adminEmail: vars.ADMIN_EMAIL || null,
  };
}

/**
 * Create or update an instance. `raw` holds the flags keyed by name without dashes; `raw.tunnel`
 * picks the tunnel mode. Prints a plan and each step; returns { mode, paths, adminToken }.
 */
export async function setupInstance(raw, runtime) {
  const log = runtime.log ?? console.log;
  const dryRun = raw["dry-run"] === true;
  const tunnel = raw.tunnel === true;
  const step = (title) => log(`\n> ${title}`);

  let o;
  try {
    o = tunnel
      ? lib.validateTunnelOptions(raw, { getDomain: runtime.getDomain })
      : lib.validateLocalOptions(raw);
  } catch (e) {
    if (e instanceof lib.TunnelUsageError) fail(e.message);
    throw e;
  }
  const home = resolveHome(raw.home);
  const paths = lib.instancePaths(home, o.name);
  const { CLOUDFLARE_API_TOKEN: token } = process.env;
  const cloudflare = tunnel && o.cloudflare;
  if (cloudflare && !token && !dryRun)
    fail(
      "CLOUDFLARE_API_TOKEN is not set. Create a token with Account: Cloudflare Tunnel Edit and " +
        "Zone: DNS Edit + Zone Read on both zones, export it, and rerun (or pass --no-cloudflare)",
    );
  const hosts = tunnel ? o : lib.localHosts(o.port);

  log(`Plinth ${tunnel ? "tunnel" : "localhost-only"} setup for instance "${o.name}". Plan:`);
  log(`  1. Instance directory ${paths.dir}`);
  log("  2. Worker config, secrets (.dev.vars) and instance.json");
  if (tunnel)
    log(
      cloudflare
        ? `  3. Tunnel plinth-${o.name} and DNS for ${lib.dnsRecordNames(o.appHost, o.contentHost).join(", ")}`
        : "  3. Tunnel and DNS: skipped (--no-cloudflare)",
    );
  else log(`  3. No tunnel: the app answers at http://${hosts.appHost} on this computer only`);
  log("  4. Apply database migrations to the instance's local database");
  if (dryRun) log("  (dry run: nothing is written, created or executed)");

  step("Instance directory");
  if (dryRun) log(`  would create ${paths.dir} (mode 700)`);
  else {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    log(`  ${paths.dir}`);
  }

  step("Worker config");
  const built = tunnel
    ? lib.buildWorkerConfig(o, runtime.layout, runtime.base)
    : lib.buildLocalWorkerConfig(o, runtime.layout, runtime.base);
  const previous = existsSync(paths.wranglerConfig)
    ? parseJsonc(readFileSync(paths.wranglerConfig, "utf8"))
    : {};
  const cfg = { ...previous, ...built, vars: { ...(previous.vars ?? {}), ...built.vars } };
  const startCmd = runtime.startCommand(o.name, raw.home ? home : null);
  const body =
    `// Generated by Plinth setup for "${o.name}". Rerunning setup updates the keys it owns and\n` +
    `// keeps anything else you add. Start with: ${startCmd}\n` +
    `${JSON.stringify(cfg, null, 2)}\n`;
  const meta = `${JSON.stringify({ name: o.name, port: o.port, mode: tunnel ? "tunnel" : "local" }, null, 2)}\n`;
  if (dryRun) log(`  would write ${paths.wranglerConfig} and ${paths.meta}`);
  else {
    writeFileSync(paths.wranglerConfig, body);
    writeFileSync(paths.meta, meta);
    log(`  wrote ${paths.wranglerConfig} and ${paths.meta}`);
  }

  step("Secrets");
  const { lines, values } = readEnvFile(paths.devVars);
  const updates = {};
  let adminToken = null;
  const singleUser = tunnel ? o.singleUser : true;
  const keys = ["SESSION_SECRET", "TOKEN_SIGNING_KEY", ...(singleUser ? ["ADMIN_TOKEN"] : [])];
  for (const key of keys) {
    if (values.get(key) && raw.force !== true) log(`  ${key}: kept (exists; --force replaces it)`);
    else {
      updates[key] = secret();
      if (key === "ADMIN_TOKEN") adminToken = updates[key];
      log(`  ${key}: generated`);
    }
  }
  if (tunnel) {
    for (const name of ["SENDGRID_API_KEY", "RESEND_API_KEY"]) {
      if (process.env[name]) {
        updates[name] = process.env[name];
        log(`  ${name}: taken from the environment`);
      } else if (o.emailProvider === name.split("_")[0].toLowerCase() && !values.get(name)) {
        log(`  warning: ${name} is not set. Export it and rerun, or add it to ${paths.devVars}`);
      }
    }
  }
  if (dryRun)
    log(`  would write ${Object.keys(updates).join(", ") || "nothing"} to ${paths.devVars}`);
  else if (Object.keys(updates).length) {
    const header = lines.length
      ? lines
      : [
          `# Secrets for the "${o.name}" Plinth instance, written by Plinth setup.`,
          "# Never share or commit this file.",
        ];
    writeEnvFile(paths.devVars, header, updates);
    log(`  wrote ${paths.devVars} (mode 600)`);
  } else log(`  ${paths.devVars}: nothing to change`);

  if (tunnel) {
    step("Tunnel and DNS");
    if (!cloudflare) log("  skipped (--no-cloudflare)");
    else if (dryRun) log("  would look up both zones, then create the tunnel and DNS records");
    else {
      const { provision, CloudflareError } = await import("./tunnel-cloudflare.mjs");
      let r;
      try {
        r = await provision({
          token,
          fetch,
          tunnelName: `plinth-${o.name}`,
          appHost: o.appHost,
          contentHost: o.contentHost,
          appZone: runtime.getDomain(o.appHost) ?? o.appHost,
          contentZone: runtime.getDomain(o.contentHost) ?? o.contentHost,
          hasCredentials: existsSync(paths.credentials),
          newSecret: () => randomBytes(32).toString("base64"),
          replaceTunnel: raw["replace-tunnel"] === true,
          // Written the moment the tunnel exists: Cloudflare never shows its secret again.
          onTunnelCreated: (credentials) => {
            writeFileSync(paths.credentials, credentials, { mode: 0o600 });
            chmodSync(paths.credentials, 0o600);
          },
        });
      } catch (e) {
        if (e instanceof CloudflareError) fail(e.message);
        throw e;
      }
      if (r.credentials)
        log(
          `  tunnel plinth-${o.name}: created (${r.tunnelId}); credentials in ${paths.credentials}`,
        );
      else log(`  tunnel plinth-${o.name}: exists (${r.tunnelId})`);
      for (const rec of r.records) log(`  DNS ${rec.name}: ${rec.action}`);
      writeFileSync(
        paths.cloudflaredConfig,
        lib.renderCloudflaredConfig({
          tunnelId: r.tunnelId,
          credentialsFile: paths.credentials,
          appHost: o.appHost,
          contentHost: o.contentHost,
          port: o.port,
        }),
      );
      log(`  wrote ${paths.cloudflaredConfig}`);
      if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0)
        log(
          `  warning: cloudflared is not installed. Install it before starting: ${CLOUDFLARED_DOWNLOAD}`,
        );
    }
  }

  step("Database migrations");
  if (dryRun) log(`  would apply the migrations to ${paths.state}`);
  else {
    applyMigrations(runtime, paths, ensureLogDir(paths));
    log("  applied");
  }

  const origin = tunnel ? `https://${o.appHost}` : `http://${hosts.appHost}`;
  log(`\nDone. Next: ${startCmd}, then open ${origin}`);
  if (adminToken && !dryRun) {
    // e2e/local/smoke.mjs reads the token after "ADMIN_TOKEN (shown once".
    log(`\nSingle-user ADMIN_TOKEN (shown once; also in ${paths.devVars}):`);
    log(`  ${adminToken}`);
  }
  return { mode: tunnel ? "tunnel" : "local", paths, adminToken, origin };
}

/**
 * Start an instance: apply migrations, then run the Worker under wrangler dev on 127.0.0.1 and, for
 * a tunnel instance, cloudflared. Both stop together. Resolves with the exit code: 0 after Ctrl-C
 * or SIGTERM, 1 when either process stops on its own.
 */
export async function startInstance(raw, runtime) {
  const label = runtime.label ?? "plinth";
  const name = raw.name ?? "plinth";
  const home = resolveHome(raw.home);
  const inst = readInstance(home, name);
  if (!inst)
    fail(
      `No instance "${name}" in ${home}. Create it first: ${runtime.setupHint ?? "plinth init"}`,
    );
  const useTunnel = inst.mode === "tunnel" && raw["no-tunnel"] !== true;
  if (useTunnel && !existsSync(inst.paths.cloudflaredConfig))
    fail(
      `${inst.paths.cloudflaredConfig} is missing: the instance was set up with --no-cloudflare. ` +
        "Rerun setup with CLOUDFLARE_API_TOKEN set, or start with --no-tunnel",
    );
  if (useTunnel && spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0)
    fail(`cloudflared is not installed: ${CLOUDFLARED_DOWNLOAD}`);
  runtime.ensureBuilt?.();

  const logDir = ensureLogDir(inst.paths);
  console.log("> Applying database migrations");
  applyMigrations(runtime, inst.paths, logDir);

  const cmds = lib.startCommands(inst.paths, inst.port, useTunnel, {
    local: inst.mode === "local",
  });
  const env = wranglerEnv(logDir);
  const children = [];
  let stopping = false;
  let resolveExit;
  const exited = new Promise((r) => {
    resolveExit = r;
  });

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
    ).then(() => resolveExit(code));
  }

  function run(what, bin, args, cwd) {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (e) => {
      console.error(`${label}: ${what} failed to start: ${e.message}`);
      stopAll(1);
    });
    child.on("exit", (code, signal) => {
      if (stopping) return;
      console.error(`${label}: ${what} stopped (${signal ?? `exit ${code}`}); stopping the rest`);
      stopAll(1);
    });
    children.push(child);
  }

  console.log(`> Starting the Worker on http://127.0.0.1:${inst.port}`);
  run(
    "wrangler",
    runtime.wrangler.command,
    [...runtime.wrangler.args, ...cmds.wrangler],
    runtime.wrangler.cwd,
  );
  if (cmds.cloudflared) {
    console.log("> Starting the tunnel");
    run("cloudflared", "cloudflared", cmds.cloudflared, inst.paths.dir);
  }
  console.log(
    inst.mode === "local"
      ? `> Open ${inst.appOrigin} (this computer only). Sign-in codes appear in this terminal.`
      : `> Open ${inst.appOrigin}`,
  );
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stopAll(0));
  return exited;
}
