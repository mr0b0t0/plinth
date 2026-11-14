#!/usr/bin/env node
// Plinth setup: secrets, config and D1/R2 resources, locally or on Cloudflare. No dependencies
// beyond Node and the wrangler installed in apps/worker. Safe to run again: nothing that exists is
// recreated, and secrets are never overwritten unless asked.
//
// Local (wrangler dev):
//   node scripts/setup.mjs --local [--force] [--dev-vars <file>] [--persist-to <dir>]
//                          [--single-user --admin-email <email>] [--dry-run]
// Remote (your Cloudflare account; run `wrangler login` first):
//   node scripts/setup.mjs --remote --env <name> --app-host <host> --content-host <host>
//                          [--db-name plinth] [--bucket plinth-files] [--worker-name <name>]
//                          [--content-zone <zone>] [--email-provider sendgrid|resend|console]
//                          [--email-from "Plinth <noreply@example.com>"] [--admin-email <email>]
//                          [--environment staging|production] [--single-user]
//                          [--workers-dev] [--rotate-secrets] [--dry-run]
//
// Local hosting through a Cloudflare Tunnel (docs/local-hosting.md). Needs CLOUDFLARE_API_TOKEN in
// the environment (Account: Cloudflare Tunnel Edit; Zone: DNS Edit and Zone Read on both zones):
//   node scripts/setup.mjs --tunnel --app-host <host> --content-host <zone apex>
//                          --email-provider sendgrid|resend|console [--name plinth] [--home ~/.plinth]
//                          [--port 8788] [--email-from "Plinth <noreply@example.com>"]
//                          [--single-user --admin-email <email>] [--content-isolation origin|opaque]
//                          [--no-cloudflare] [--force] [--dry-run]
// Writes <home>/<name>/ (Worker config, .dev.vars, cloudflared.yml, tunnel credentials, D1 and R2
// state), creates the tunnel and DNS records, and applies migrations. Then: pnpm local:start.
// --no-cloudflare skips the tunnel and DNS (for tests, or to wire the tunnel up by hand).
//
// --workers-dev (staging only): deploy to the account's workers.dev address with no routes or
// custom domains. workers.dev has no wildcard subdomains, so artifacts are served from the app
// host under /__content/<id>/ (STAGING_CONTENT_FALLBACK, refused in production). Pass the
// workers.dev host as --app-host; --content-host defaults to a placeholder that is never served.
//
// Secret values are generated here (or read from SENDGRID_API_KEY / RESEND_API_KEY in the
// environment) and piped to wrangler on stdin. They never appear on a command line or in output,
// except a newly generated single-user ADMIN_TOKEN, which is shown once.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "apps", "worker");
const wranglerBin = path.join(workerDir, "node_modules", ".bin", "wrangler");
// tldts is a dependency of the Worker; load it from there so this script needs no install of its own.
const { getDomain } = createRequire(path.join(workerDir, "package.json"))("tldts");
const registrableDomain = (h) =>
  getDomain(h.replace(/:\d+$/, ""), { allowPrivateDomains: true }) ?? h;

// ---------- arguments ----------

const BOOLEAN_FLAGS = new Set([
  "local",
  "remote",
  "dry-run",
  "force",
  "single-user",
  "rotate-secrets",
  "workers-dev",
  "tunnel",
  "no-cloudflare",
  "help",
]);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) opts[key] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`--${key} needs a value`);
      opts[key] = v;
      i++;
    }
  }
  return opts;
}

function fail(message) {
  console.error(`setup: ${message}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
const dryRun = !!opts["dry-run"];

if (opts.help || (!opts.local && !opts.remote && !opts.tunnel)) {
  const usage = readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("//"))
    .map((l) => l.replace(/^\/\/ ?/, ""))
    .join("\n");
  console.log(usage);
  process.exit(opts.help ? 0 : 1);
}
if ([opts.local, opts.remote, opts.tunnel].filter(Boolean).length > 1)
  fail("Choose one of --local, --remote or --tunnel.");

// ---------- helpers ----------

/** 48 random bytes, base64url: 64 characters. */
const secret = () => randomBytes(48).toString("base64url");

function show(args) {
  return ["wrangler", ...args].map((a) => (/[\s"'<>]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/**
 * Run wrangler in apps/worker. `input` is piped to stdin (never printed). With `capture`, stdout is
 * returned instead of shown. Returns { status, stdout }.
 */
function wrangler(args, { input, capture = false, allowFail = false } = {}) {
  const suffix = input === undefined ? "" : "   (value piped on stdin)";
  console.log(`  $ ${show(args)}${suffix}`);
  if (dryRun) return { status: 0, stdout: "" };
  if (!existsSync(wranglerBin)) fail("wrangler is not installed. Run `pnpm install` first.");
  const r = spawnSync(wranglerBin, args, {
    cwd: workerDir,
    input: input ?? "",
    stdio: ["pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(r.stderr ?? "");
    fail(`wrangler exited with status ${r.status}`);
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** A read-only wrangler call whose result decides what to do. Dry run: printed, returns null. */
function probe(args) {
  if (dryRun) {
    console.log(`  $ ${show(args)}`);
    return null;
  }
  return wrangler(args, { capture: true, allowFail: true });
}

function step(title) {
  console.log(`\n> ${title}`);
}

/** Read a .dev.vars style file into an ordered list of lines and a key map. */
function readEnvFile(file) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const values = new Map();
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  return { lines, values };
}

/** Set keys in an env file, replacing existing lines and appending new ones. */
function writeEnvFile(file, lines, updates) {
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
}

/** Parse JSONC: strip comments outside strings and trailing commas. */
function parseJsonc(text) {
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

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- local ----------

function setupLocal() {
  const devVars = path.resolve(opts["dev-vars"] ?? path.join(workerDir, ".dev.vars"));
  const persistTo = opts["persist-to"] ? path.resolve(opts["persist-to"]) : null;
  const single = !!opts["single-user"];
  if (single && !EMAIL_RE.test(opts["admin-email"] ?? ""))
    fail("--single-user needs --admin-email <email>");

  console.log("Plinth local setup. Plan:");
  console.log(`  1. Secrets in ${path.relative(root, devVars) || devVars}`);
  console.log(
    `  2. Apply D1 migrations to the local database${persistTo ? ` in ${persistTo}` : ""}`,
  );
  if (dryRun) console.log("  (dry run: nothing is written or executed)");

  step("Secrets");
  const { lines, values } = readEnvFile(devVars);
  const updates = {};
  let adminToken = null;
  for (const key of ["SESSION_SECRET", "TOKEN_SIGNING_KEY"]) {
    if (values.get(key) && !opts.force) console.log(`  ${key}: kept (exists; --force replaces it)`);
    else {
      updates[key] = secret();
      console.log(`  ${key}: generated`);
    }
  }
  if (single) {
    updates.SINGLE_USER_MODE = "true";
    updates.ADMIN_EMAIL = opts["admin-email"].toLowerCase();
    if (values.get("ADMIN_TOKEN") && !opts.force) console.log("  ADMIN_TOKEN: kept (exists)");
    else {
      adminToken = secret();
      updates.ADMIN_TOKEN = adminToken;
      console.log("  ADMIN_TOKEN: generated (shown once below)");
    }
  }
  if (Object.keys(updates).length === 0) console.log(`  ${devVars}: nothing to change`);
  else if (dryRun) console.log(`  would write ${Object.keys(updates).join(", ")} to ${devVars}`);
  else {
    const header = lines.length
      ? lines
      : [
          "# Local secrets for `wrangler dev`, written by scripts/setup.mjs. Never commit this file.",
          "# Optional: SENDGRID_API_KEY=, RESEND_API_KEY= (with EMAIL_PROVIDER set in wrangler.jsonc)",
        ];
    writeEnvFile(devVars, header, updates);
    console.log(`  wrote ${devVars} (mode 600)`);
  }

  step("Local D1 migrations");
  const args = ["d1", "migrations", "apply", "DB", "--local"];
  if (persistTo) args.push("--persist-to", persistTo);
  wrangler(args);

  console.log("\nDone. Next: `pnpm dev`, then open http://app.localhost:8787");
  if (adminToken && !dryRun) {
    console.log("\nSingle-user ADMIN_TOKEN (shown once; also in your .dev.vars):");
    console.log(`  ${adminToken}`);
  }
}

// ---------- remote ----------

function setupRemote() {
  const envName = opts.env;
  if (!envName || !/^[a-z][a-z0-9-]{0,30}$/.test(envName))
    fail("--remote needs --env <name> (lowercase letters, digits, dashes), e.g. --env production");
  const dbName = opts["db-name"] ?? "plinth";
  const bucket = opts.bucket ?? "plinth-files";
  const workerName =
    opts["worker-name"] ?? (envName === "production" ? "plinth" : `plinth-${envName}`);
  const environment = opts.environment ?? (envName === "staging" ? "staging" : "production");
  if (!["staging", "production"].includes(environment))
    fail("--environment must be staging or production");
  const appHost = opts["app-host"]?.toLowerCase();
  const contentHost = opts["content-host"]?.toLowerCase();
  const single = !!opts["single-user"];
  const adminEmail = opts["admin-email"]?.toLowerCase();
  const emailProvider = opts["email-provider"];
  for (const [flag, v] of [
    ["--app-host", appHost],
    ["--content-host", contentHost],
  ]) {
    if (v !== undefined && !HOST_RE.test(v))
      fail(`${flag} must be a host name like plinth.example.com`);
  }
  if (adminEmail !== undefined && !EMAIL_RE.test(adminEmail)) fail("--admin-email is not an email");
  if (single && !adminEmail) fail("--single-user needs --admin-email <email>");
  if (emailProvider && !["sendgrid", "resend", "console"].includes(emailProvider))
    fail("--email-provider must be sendgrid, resend or console");
  // The same Public Suffix List check the Worker makes (tldts, private section included), so a
  // content host that is a PSL-listed subdomain of the app's domain passes once tldts knows it.
  if (appHost && contentHost && !opts["workers-dev"]) {
    if (registrableDomain(appHost) === registrableDomain(contentHost))
      fail(
        "APP_HOST and CONTENT_HOST share a registrable domain. Use a separate domain, or a subdomain " +
          "on the Public Suffix List once the pinned tldts knows it (docs/deploy-checklist.md)",
      );
  }
  const contentZone =
    opts["content-zone"] ?? (contentHost ? (getDomain(contentHost) ?? contentHost) : null);

  const configFile = path.join(workerDir, `wrangler.${envName}.jsonc`);
  const configRel = path.relative(workerDir, configFile);

  console.log(`Plinth remote setup for "${envName}". Plan:`);
  console.log(`  1. D1 database "${dbName}" (create if missing)`);
  console.log(`  2. R2 bucket "${bucket}" (create if missing)`);
  console.log(
    `  3. Write apps/worker/${configRel} (Worker "${workerName}", ENVIRONMENT=${environment})`,
  );
  console.log(
    "  4. Secrets SESSION_SECRET, TOKEN_SIGNING_KEY (only if not set yet)" +
      (single ? ", ADMIN_TOKEN" : ""),
  );
  console.log(`  5. Apply D1 migrations to "${dbName}" (remote)`);
  if (dryRun) console.log("  (dry run: commands are printed, nothing is created or written)");

  step("D1 database");
  const findDb = () => {
    const r = probe(["d1", "list", "--json"]);
    if (r === null) return null;
    try {
      return JSON.parse(r.stdout).find((d) => d.name === dbName)?.uuid ?? null;
    } catch {
      fail("Could not parse `wrangler d1 list --json` output");
    }
  };
  let dbId = findDb();
  if (dbId) console.log(`  exists: ${dbName} (${dbId})`);
  else {
    wrangler(["d1", "create", dbName]);
    dbId = dryRun ? "<database id from wrangler d1 list>" : findDb();
    if (!dbId) fail(`Created ${dbName} but could not find its id with wrangler d1 list`);
  }

  step("R2 bucket");
  const info = probe(["r2", "bucket", "info", bucket]);
  if (info?.status === 0) console.log(`  exists: ${bucket}`);
  else wrangler(["r2", "bucket", "create", bucket]);

  step(`Config apps/worker/${configRel}`);
  const base = existsSync(configFile)
    ? parseJsonc(readFileSync(configFile, "utf8"))
    : parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
  const cfg = {
    ...base,
    name: opts["worker-name"] ?? (existsSync(configFile) ? base.name : workerName),
  };
  cfg.d1_databases = [
    {
      ...(base.d1_databases?.[0] ?? {}),
      binding: "DB",
      database_name: dbName,
      database_id: dbId,
      migrations_dir: "../../migrations",
    },
  ];
  cfg.r2_buckets = [{ binding: "FILES", bucket_name: bucket }];
  const fresh = !existsSync(configFile);
  const vars = { ...(base.vars ?? {}) };
  if (fresh) {
    Object.assign(vars, {
      ENVIRONMENT: environment,
      PUBLIC_SCHEME: "https",
      DEV_OUTBOX: "false",
      STAGING_CONTENT_FALLBACK: "false",
    });
  }
  if (appHost) vars.APP_HOST = appHost;
  if (contentHost) vars.CONTENT_HOST = contentHost;
  if (emailProvider) vars.EMAIL_PROVIDER = emailProvider;
  if (opts["email-from"]) vars.EMAIL_FROM = opts["email-from"];
  else if (appHost && /localhost/.test(String(vars.EMAIL_FROM ?? "localhost"))) {
    vars.EMAIL_FROM = `Plinth <noreply@${appHost}>`;
  }
  if (adminEmail) vars.ADMIN_EMAIL = adminEmail;
  if (single) vars.SINGLE_USER_MODE = "true";
  cfg.vars = vars;
  if (opts["workers-dev"]) {
    if (vars.ENVIRONMENT === "production") fail("--workers-dev is for staging only");
    cfg.workers_dev = true;
    // Preview URLs would serve the Worker on extra <version>-<name> hosts that are not APP_HOST.
    cfg.preview_urls = false;
    delete cfg.routes;
    vars.STAGING_CONTENT_FALLBACK = "true";
    if (!contentHost) vars.CONTENT_HOST = "content.invalid";
  } else if (appHost && contentHost && contentZone) {
    cfg.routes = [
      { pattern: appHost, custom_domain: true },
      { pattern: `*.${contentHost}/*`, zone_name: contentZone },
    ];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (/localhost/.test(String(v))) console.log(`  warning: ${k}=${v} still points at localhost`);
  }
  if (
    vars.ENVIRONMENT === "production" &&
    vars.EMAIL_PROVIDER === "console" &&
    vars.SINGLE_USER_MODE !== "true"
  ) {
    console.log(
      "  warning: production refuses EMAIL_PROVIDER=console; pass --email-provider or --single-user",
    );
  }
  const body =
    `// Generated by scripts/setup.mjs for "${envName}". Edit freely; rerunning setup keeps your\n` +
    "// changes and only updates the D1/R2 bindings and the values passed as flags.\n" +
    `// Deploy: pnpm --filter @plinth/worker exec wrangler deploy --config ${configRel}\n` +
    `${JSON.stringify(cfg, null, 2)}\n`;
  if (dryRun) {
    console.log(`  would ${fresh ? "create" : "update"} ${configFile}:`);
    console.log(body.replace(/^/gm, "    "));
  } else {
    writeFileSync(configFile, body);
    console.log(`  ${fresh ? "created" : "updated"} ${configFile}`);
  }

  step("Secrets");
  const cfgArgs = ["--config", configRel];
  let existing = new Set();
  const listed = probe(["secret", "list", ...cfgArgs, "--format", "json"]);
  if (listed?.status === 0) {
    try {
      existing = new Set(JSON.parse(listed.stdout).map((s) => s.name));
    } catch {
      // No parseable list: treat as none set.
    }
  }
  const secrets = [
    ["SESSION_SECRET", secret],
    ["TOKEN_SIGNING_KEY", secret],
  ];
  if (single) secrets.push(["ADMIN_TOKEN", secret]);
  let adminToken = null;
  for (const [name, make] of secrets) {
    if (existing.has(name) && !opts["rotate-secrets"]) {
      console.log(`  ${name}: already set (--rotate-secrets replaces it)`);
      continue;
    }
    const value = make();
    if (name === "ADMIN_TOKEN") adminToken = value;
    wrangler(["secret", "put", name, ...cfgArgs], { input: value });
  }
  for (const name of ["SENDGRID_API_KEY", "RESEND_API_KEY"]) {
    const value = process.env[name];
    if (value) wrangler(["secret", "put", name, ...cfgArgs], { input: value });
    else if (vars.EMAIL_PROVIDER === name.split("_")[0].toLowerCase() && !existing.has(name)) {
      console.log(
        `  ${name}: not set. Export it and rerun, or: wrangler secret put ${name} ${cfgArgs.join(" ")}`,
      );
    }
  }

  step("Remote D1 migrations");
  wrangler(["d1", "migrations", "apply", "DB", "--remote", ...cfgArgs]);

  console.log("\nDone. Next steps:");
  console.log("  1. pnpm build");
  console.log(`  2. pnpm --filter @plinth/worker exec wrangler deploy --config ${configRel}`);
  console.log("  3. DNS and email: see docs/deploy-checklist.md");
  if (adminToken && !dryRun) {
    console.log("\nSingle-user ADMIN_TOKEN (shown once; store it in a password manager):");
    console.log(`  ${adminToken}`);
  }
}

// ---------- tunnel (local hosting) ----------

async function setupTunnel() {
  // Read by destructuring: these are setup-time inputs, not build inputs for turbo.
  const { PLINTH_HOME: envPlinthHome, CLOUDFLARE_API_TOKEN: envCloudflareToken } = process.env;
  const lib = await import("../apps/worker/scripts/tunnel-lib.mjs");
  const { provision, CloudflareError } = await import(
    "../apps/worker/scripts/tunnel-cloudflare.mjs"
  );
  let o;
  try {
    o = lib.validateTunnelOptions(opts, {
      getDomain: (h) => getDomain(h, { allowPrivateDomains: true }),
    });
  } catch (e) {
    if (e instanceof lib.TunnelUsageError) fail(e.message);
    throw e;
  }
  const home = path.resolve(opts.home ?? envPlinthHome ?? path.join(os.homedir(), ".plinth"));
  const paths = lib.instancePaths(home, o.name);
  const token = envCloudflareToken;
  if (o.cloudflare && !token && !dryRun)
    fail(
      "CLOUDFLARE_API_TOKEN is not set. Create a token with Account: Cloudflare Tunnel Edit and " +
        "Zone: DNS Edit + Zone Read on both zones, export it, and rerun (or pass --no-cloudflare)",
    );

  console.log(`Plinth tunnel setup for instance "${o.name}". Plan:`);
  console.log(`  1. Instance directory ${paths.dir}`);
  console.log("  2. Worker config, secrets (.dev.vars) and instance.json");
  console.log(
    o.cloudflare
      ? `  3. Tunnel plinth-${o.name} and DNS for ${lib.dnsRecordNames(o.appHost, o.contentHost).join(", ")}`
      : "  3. Tunnel and DNS: skipped (--no-cloudflare)",
  );
  console.log("  4. Apply D1 migrations to the instance's local database");
  if (dryRun) console.log("  (dry run: nothing is written, created or executed)");

  step("Instance directory");
  if (dryRun) console.log(`  would create ${paths.dir} (mode 700)`);
  else {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    console.log(`  ${paths.dir}`);
  }

  step("Worker config");
  const base = parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
  const built = lib.buildWorkerConfig(o, root, base);
  const previous = existsSync(paths.wranglerConfig)
    ? parseJsonc(readFileSync(paths.wranglerConfig, "utf8"))
    : {};
  const cfg = { ...previous, ...built, vars: { ...(previous.vars ?? {}), ...built.vars } };
  const body =
    `// Generated by scripts/setup.mjs --tunnel for "${o.name}". Rerunning setup updates the keys it\n` +
    "// owns and keeps anything else you add. Start with: pnpm local:start" +
    (o.name === "plinth" ? "" : ` --name ${o.name}`) +
    `\n${JSON.stringify(cfg, null, 2)}\n`;
  const meta = `${JSON.stringify({ name: o.name, port: o.port }, null, 2)}\n`;
  if (dryRun) console.log(`  would write ${paths.wranglerConfig} and ${paths.meta}`);
  else {
    writeFileSync(paths.wranglerConfig, body);
    writeFileSync(paths.meta, meta);
    console.log(`  wrote ${paths.wranglerConfig} and ${paths.meta}`);
  }

  step("Secrets");
  const { lines, values } = readEnvFile(paths.devVars);
  const updates = {};
  let adminToken = null;
  const keys = ["SESSION_SECRET", "TOKEN_SIGNING_KEY", ...(o.singleUser ? ["ADMIN_TOKEN"] : [])];
  for (const key of keys) {
    if (values.get(key) && !opts.force) console.log(`  ${key}: kept (exists; --force replaces it)`);
    else {
      updates[key] = secret();
      if (key === "ADMIN_TOKEN") adminToken = updates[key];
      console.log(`  ${key}: generated`);
    }
  }
  for (const name of ["SENDGRID_API_KEY", "RESEND_API_KEY"]) {
    if (process.env[name]) {
      updates[name] = process.env[name];
      console.log(`  ${name}: taken from the environment`);
    } else if (o.emailProvider === name.split("_")[0].toLowerCase() && !values.get(name)) {
      console.log(
        `  warning: ${name} is not set. Export it and rerun, or add it to ${paths.devVars}`,
      );
    }
  }
  if (dryRun)
    console.log(
      `  would write ${Object.keys(updates).join(", ") || "nothing"} to ${paths.devVars}`,
    );
  else if (Object.keys(updates).length) {
    const header = lines.length
      ? lines
      : [
          `# Secrets for the "${o.name}" Plinth instance, written by scripts/setup.mjs --tunnel.`,
          "# Never share or commit this file.",
        ];
    writeEnvFile(paths.devVars, header, updates);
    chmodSync(paths.devVars, 0o600);
    console.log(`  wrote ${paths.devVars} (mode 600)`);
  } else console.log(`  ${paths.devVars}: nothing to change`);

  step("Tunnel and DNS");
  if (!o.cloudflare) console.log("  skipped (--no-cloudflare)");
  else if (dryRun)
    console.log("  would look up both zones, then create the tunnel and DNS records");
  else {
    let r;
    try {
      r = await provision({
        token,
        fetch,
        tunnelName: `plinth-${o.name}`,
        appHost: o.appHost,
        contentHost: o.contentHost,
        appZone: getDomain(o.appHost, { allowPrivateDomains: true }) ?? o.appHost,
        contentZone: getDomain(o.contentHost, { allowPrivateDomains: true }) ?? o.contentHost,
        hasCredentials: existsSync(paths.credentials),
        newSecret: () => randomBytes(32).toString("base64"),
      });
    } catch (e) {
      if (e instanceof CloudflareError) fail(e.message);
      throw e;
    }
    if (r.credentials) {
      writeFileSync(paths.credentials, r.credentials, { mode: 0o600 });
      chmodSync(paths.credentials, 0o600);
      console.log(
        `  tunnel plinth-${o.name}: created (${r.tunnelId}); credentials in ${paths.credentials}`,
      );
    } else console.log(`  tunnel plinth-${o.name}: exists (${r.tunnelId})`);
    for (const rec of r.records) console.log(`  DNS ${rec.name}: ${rec.action}`);
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
    console.log(`  wrote ${paths.cloudflaredConfig}`);
    if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0)
      console.log(
        "  warning: cloudflared is not installed. Install it before starting: " +
          "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
      );
  }

  step("Local D1 migrations");
  wrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    paths.wranglerConfig,
    "--persist-to",
    paths.state,
  ]);

  const nameFlag = o.name === "plinth" ? "" : ` --name ${o.name}`;
  const homeFlag = opts.home ? ` --home ${home}` : "";
  console.log(
    `\nDone. Next: pnpm local:start${nameFlag}${homeFlag}, then open https://${o.appHost}`,
  );
  if (adminToken && !dryRun) {
    console.log(`\nSingle-user ADMIN_TOKEN (shown once; also in ${paths.devVars}):`);
    console.log(`  ${adminToken}`);
  }
}

if (opts.local) setupLocal();
else if (opts.tunnel) await setupTunnel();
else setupRemote();
