#!/usr/bin/env node
// Plinth setup: secrets, config and D1/R2 resources, locally or on Cloudflare. No dependencies
// beyond Node and the wrangler installed in apps/worker. Safe to run again: nothing that exists is
// recreated, and secrets are never overwritten unless asked.
//
// Local (wrangler dev):
//   node scripts/setup.mjs --local [--force] [--dev-vars <file>] [--persist-to <dir>]
//                          [--single-user --admin-email <email>] [--dry-run]
// Remote (your Cloudflare account; run `wrangler login` first). The npm CLI's `plinth deploy` does
// the same with the prebuilt Worker, and deploys too (packages/cli/README.md):
//   node scripts/setup.mjs --remote --env <name> --app-host <host> --content-host <host>
//                          [--db-name plinth] [--bucket plinth-files] [--worker-name <name>]
//                          [--content-zone <zone>] [--email-provider sendgrid|resend|console]
//                          [--email-from "Plinth <noreply@example.com>"] [--admin-email <email>]
//                          [--environment staging|production] [--single-user]
//                          [--content-isolation origin|opaque]
//                          [--workers-dev] [--rotate-secrets] [--dry-run]
//
// --content-isolation opaque: writes CONTENT_ISOLATION=opaque (every artifact document gets an
// opaque origin; docs/security.md). Only with it may APP_HOST and CONTENT_HOST share a registrable
// domain, e.g. a content host whose Public Suffix List entry has not shipped yet.
// Local hosting through a Cloudflare Tunnel (docs/local-hosting.md). Needs CLOUDFLARE_API_TOKEN in
// the environment (Account: Cloudflare Tunnel Edit; Zone: DNS Edit and Zone Read on both zones):
//   node scripts/setup.mjs --tunnel --app-host <host> --content-host <zone apex>
//                          --email-provider sendgrid|resend|console [--name plinth] [--home ~/.plinth]
//                          [--port 8788] [--email-from "Plinth <noreply@example.com>"]
//                          [--single-user --admin-email <email>] [--content-isolation origin|opaque]
//                          [--no-cloudflare] [--replace-tunnel] [--force] [--dry-run]
// Writes <home>/<name>/ (Worker config, .dev.vars, cloudflared.yml, tunnel credentials, D1 and R2
// state), creates the tunnel and DNS records, and applies migrations. Then: pnpm local:start.
// --no-cloudflare skips the tunnel and DNS (for tests, or to wire the tunnel up by hand).
// --replace-tunnel deletes the instance's tunnel and makes a new one, repointing the DNS records it
// (or an already deleted tunnel) left behind. Use it when the credentials file is lost.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { provisionRemote, wranglerRunner } from "../apps/worker/scripts/deploy.mjs";
import {
  hostPairProblem,
  refreshRuntime,
  runtimeConfigProblem,
} from "../apps/worker/scripts/deploy-lib.mjs";
import {
  InstanceError,
  parseJsonc,
  readEnvFile,
  setupInstance,
  writeEnvFile,
} from "../apps/worker/scripts/instance.mjs";

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
  "replace-tunnel",
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

function step(title) {
  console.log(`\n> ${title}`);
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
  const configFile = path.join(workerDir, `wrangler.${envName}.jsonc`);
  const configRel = path.relative(workerDir, configFile);
  // production and staging have a deploy script that checks the config first (check-config).
  const deployCommand =
    envName === "production" || envName === "staging"
      ? `pnpm --filter @plinth/worker run deploy:${envName}`
      : `pnpm --filter @plinth/worker check-config ${configRel} && pnpm --filter @plinth/worker exec wrangler deploy --config ${configRel}`;
  const isolationFlag = opts["content-isolation"]?.toLowerCase();
  if (isolationFlag !== undefined && !["origin", "opaque"].includes(isolationFlag))
    fail("--content-isolation must be origin or opaque");
  // The mode the deploy will run with: the flag, else what an existing config already says.
  const isolation =
    isolationFlag ??
    (existsSync(configFile)
      ? String(parseJsonc(readFileSync(configFile, "utf8")).vars?.CONTENT_ISOLATION ?? "origin")
      : "origin");
  if (appHost && contentHost && !opts["workers-dev"]) {
    const problem = hostPairProblem(appHost, contentHost, isolation, registrableDomain);
    if (problem) fail(problem);
  }
  const contentZone =
    opts["content-zone"] ?? (contentHost ? (getDomain(contentHost) ?? contentHost) : null);
  // The config this run writes takes the repo's flags and cron trigger; refuse before creating
  // anything if the result would still lack them (a checkout whose wrangler.jsonc lost them).
  {
    const repoCfg = parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
    const existing = existsSync(configFile) ? parseJsonc(readFileSync(configFile, "utf8")) : null;
    const problem = runtimeConfigProblem(existing ? refreshRuntime(existing, repoCfg) : repoCfg);
    if (problem) fail(problem);
  }

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

  if (!dryRun && !existsSync(wranglerBin))
    fail("wrangler is not installed. Run `pnpm install` first.");
  const cfgArgs = ["--config", configRel];
  const { adminToken } = provisionRemote(
    {
      wrangler: wranglerRunner(
        { wrangler: { command: wranglerBin, args: [], cwd: workerDir } },
        { dryRun },
      ),
      dbName,
      bucket,
      configTitle: `Config apps/worker/${configRel}`,
      configArgs: cfgArgs,
      adminToken: single,
      rotateSecrets: !!opts["rotate-secrets"],
      missingKeyHint: (name) =>
        `Export it and rerun, or: wrangler secret put ${name} ${cfgArgs.join(" ")}`,
      writeConfig: (databaseId) => {
        const repoCfg = parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
        // An existing config keeps its own settings but takes the flags this release needs.
        const base = existsSync(configFile)
          ? refreshRuntime(parseJsonc(readFileSync(configFile, "utf8")), repoCfg)
          : repoCfg;
        const cfg = {
          ...base,
          name: opts["worker-name"] ?? (existsSync(configFile) ? base.name : workerName),
        };
        cfg.d1_databases = [
          {
            ...(base.d1_databases?.[0] ?? {}),
            binding: "DB",
            database_name: dbName,
            database_id: databaseId,
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
        if (isolationFlag) vars.CONTENT_ISOLATION = isolationFlag;
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
          if (/localhost/.test(String(v)))
            console.log(`  warning: ${k}=${v} still points at localhost`);
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
          `// Deploy: ${deployCommand}\n` +
          `${JSON.stringify(cfg, null, 2)}\n`;
        if (dryRun) {
          console.log(`  would ${fresh ? "create" : "update"} ${configFile}:`);
          console.log(body.replace(/^/gm, "    "));
        } else {
          writeFileSync(configFile, body);
          console.log(`  ${fresh ? "created" : "updated"} ${configFile}`);
        }
        return { vars };
      },
    },
    {},
  );

  console.log("\nDone. Next steps:");
  console.log("  1. pnpm build");
  console.log(`  2. ${deployCommand}`);
  console.log("  3. DNS and email: see docs/deploy-checklist.md");
  if (adminToken && !dryRun) {
    console.log("\nSingle-user ADMIN_TOKEN (shown once; store it in a password manager):");
    console.log(`  ${adminToken}`);
  }
}

// ---------- tunnel (local hosting) ----------

async function setupTunnel() {
  if (!dryRun && !existsSync(wranglerBin))
    fail("wrangler is not installed. Run `pnpm install` first.");
  const base = parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
  await setupInstance(
    { ...opts, tunnel: true },
    {
      layout: root,
      base,
      wrangler: { command: wranglerBin, args: [], cwd: workerDir },
      getDomain: (h) => getDomain(h, { allowPrivateDomains: true }),
      startCommand: (name, home) =>
        `pnpm local:start${name === "plinth" ? "" : ` --name ${name}`}${home ? ` --home ${home}` : ""}`,
    },
  );
}

try {
  if (opts.local) setupLocal();
  else if (opts.tunnel) await setupTunnel();
  else setupRemote();
} catch (e) {
  if (e instanceof InstanceError) fail(e.message);
  throw e;
}
