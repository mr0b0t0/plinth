#!/usr/bin/env node
// Container start, step 1 (docs/docker.md): turn PLINTH_* environment variables into a Plinth
// instance in $PLINTH_HOME (the /data volume), then print the arguments for `plinth start` on
// stdout, one per line. Everything else this script and `plinth init` print goes to stderr.
//
// Modes:
//   localhost  PLINTH_EMAIL                      app at http://127.0.0.1:<port>, artifacts at
//                                                http://<id>.localhost:<port>, one account
//   domains    PLINTH_APP_HOST + CONTENT_HOST    behind your own TLS-terminating reverse proxy
//   tunnel     ... + PLINTH_TUNNEL=true          a Cloudflare Tunnel run from inside the container
//
// `plinth init` runs on the first start and again whenever these settings change (it keeps the
// generated secrets and the data). Otherwise the instance starts as it is, except that `plinth
// start` adds the release's compatibility flags and cron trigger to an instance config an older
// image wrote.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plinthBin = path.join(appDir, "bin", "plinth.mjs");
const NAME = "plinth";

const env = process.env;
const log = (m) => console.error(`docker: ${m}`);
const die = (m) => {
  console.error(`docker: ${m}`);
  process.exit(1);
};
const isTrue = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const value = (k) => {
  const v = env[k];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};

// Worker settings a container sets with PLINTH_<NAME>; unset means the default from the bundled
// wrangler.base.json (limits) or empty (operator details). See docs/self-hosting.md#settings.
const WORKER_VARS = [
  "OPERATOR_NAME",
  "OPERATOR_EMAIL",
  "OPERATOR_ADDRESS",
  "OPERATOR_REGISTRATION",
  "OPERATOR_HOSTING",
  "MAX_ARTIFACTS_PER_USER",
  "MAX_PUBLISHES_PER_HOUR",
  "MAX_VERSION_BYTES",
  "MAX_ASSETS_PER_VERSION",
  "MAX_STORAGE_BYTES_PER_USER",
  "CDN_ALLOWLIST",
  "ALLOW_PUBLIC_VISIBILITY",
  "PUBLIC_MIN_ACCOUNT_AGE_HOURS",
  // Live rooms and on-page doc editing (#36): the instance config carries the ROOMS binding, so
  // these are the switches (docs/docker.md#settings). A reverse proxy must pass WebSocket upgrades.
  "ALLOW_ROOMS",
  "ALLOW_LIVE_EDITING",
  // Live views (docs/docker.md#settings): open pages follow new versions over a socket on the app
  // host, through the same ROOMS binding.
  "ALLOW_LIVE_VIEWS",
  // Formula steps one read_sheet call may spend (docs/self-hosting.md#settings).
  "SHEET_EVAL_BUDGET",
];

// `plinth init` flags and the variables that set them, to name the variable in its errors.
const FLAG_VARS = {
  email: "PLINTH_EMAIL",
  port: "PLINTH_PORT",
  "app-host": "PLINTH_APP_HOST",
  "content-host": "PLINTH_CONTENT_HOST",
  "content-isolation": "PLINTH_CONTENT_ISOLATION",
  "email-provider": "PLINTH_EMAIL_PROVIDER",
  "email-from": "PLINTH_EMAIL_FROM",
  "admin-email": "PLINTH_ADMIN_EMAIL",
  "single-user": "PLINTH_SINGLE_USER",
};

const home = path.resolve(value("PLINTH_HOME") ?? "/data");
try {
  accessSync(home, constants.W_OK);
} catch {
  die(
    `${home} is not writable by this user (uid ${process.getuid?.()}). Mount a volume there that ` +
      "uid 1000 can write to, e.g. a named volume, or chown a bind-mounted folder to 1000:1000",
  );
}

const port = value("PLINTH_PORT") ?? "8788";
const appHost = value("PLINTH_APP_HOST");
const tunnel = isTrue(env.PLINTH_TUNNEL);
const mode = appHost ? (tunnel ? "tunnel" : "domains") : "localhost";
if (tunnel && !appHost) die("PLINTH_TUNNEL needs PLINTH_APP_HOST and PLINTH_CONTENT_HOST");

/** The `plinth init` arguments for this environment. */
function initArgs() {
  const args = ["init", "--name", NAME, "--home", home, "--port", port];
  const add = (flag) => {
    const v = value(FLAG_VARS[flag]);
    if (v !== undefined) args.push(`--${flag}`, v);
  };
  if (mode === "localhost") {
    const email = value("PLINTH_EMAIL") ?? value("PLINTH_ADMIN_EMAIL");
    if (!email)
      die(
        "set PLINTH_EMAIL to your email address (the one account that can sign in), or " +
          "PLINTH_APP_HOST and PLINTH_CONTENT_HOST for your own domains (docs/docker.md)",
      );
    args.push("--email", email);
    return args;
  }
  for (const k of ["PLINTH_CONTENT_HOST", "PLINTH_EMAIL_PROVIDER"])
    if (!value(k)) die(`${k} is required with PLINTH_APP_HOST (docs/docker.md)`);
  args.push("--tunnel");
  if (!tunnel) args.push("--no-cloudflare");
  for (const flag of [
    "app-host",
    "content-host",
    "content-isolation",
    "email-provider",
    "email-from",
    "admin-email",
  ])
    add(flag);
  if (isTrue(env.PLINTH_SINGLE_USER)) args.push("--single-user");
  return args;
}

const args = initArgs();
const workerVars = Object.fromEntries(WORKER_VARS.map((k) => [k, value(`PLINTH_${k}`)]));
const keyDigest = (k) => (env[k] ? createHash("sha256").update(env[k]).digest("hex") : null);
const fingerprint = createHash("sha256")
  .update(
    JSON.stringify({
      args,
      workerVars,
      // Rotating an email API key reapplies the settings, which copies the new key into .dev.vars.
      keys: ["RESEND_API_KEY", "SENDGRID_API_KEY"].map(keyDigest),
    }),
  )
  .digest("hex");

const dir = path.join(home, NAME);
const stamp = path.join(dir, "docker-settings.sha256");
const configured =
  existsSync(path.join(dir, "instance.json")) &&
  existsSync(stamp) &&
  readFileSync(stamp, "utf8").trim() === fingerprint;

if (configured) log(`settings unchanged; starting the ${mode} instance in ${dir}`);
else {
  log(`${existsSync(dir) ? "applying changed settings" : "first start: setting up"} (${mode})`);
  // init's own output goes to stderr: stdout carries only the start arguments.
  const r = spawnSync(process.execPath, [plinthBin, ...args], {
    env,
    stdio: ["ignore", 2, "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) {
    const names = { ...FLAG_VARS, "no-cloudflare": "PLINTH_TUNNEL=false" };
    const message = (r.stderr ?? "").replace(/--([a-z-]+)/g, (m, flag) => names[flag] ?? m);
    process.stderr.write(message);
    die("setup failed; fix the setting above and start the container again");
  }
  if (r.stderr) process.stderr.write(r.stderr);

  // The Worker settings `plinth init` has no flags for, written into the instance's config.
  const { parseJsonc } = await import(path.join(appDir, "runtime", "scripts", "instance.mjs"));
  const base = JSON.parse(readFileSync(path.join(appDir, "runtime", "wrangler.base.json"), "utf8"));
  const cfgFile = path.join(dir, "wrangler.jsonc");
  const text = readFileSync(cfgFile, "utf8");
  const cfg = parseJsonc(text);
  for (const [k, v] of Object.entries(workerVars)) cfg.vars[k] = v ?? base.vars?.[k] ?? "";
  const header = text.slice(0, text.indexOf("{"));
  writeFileSync(cfgFile, `${header}${JSON.stringify(cfg, null, 2)}\n`);
  writeFileSync(stamp, `${fingerprint}\n`);
}

// Localhost and domains: the published port or the reverse proxy decides who connects, so the
// Worker listens on every interface. Tunnel: cloudflared runs beside it, loopback is enough.
const listen = value("PLINTH_LISTEN") ?? (mode === "tunnel" ? "127.0.0.1" : "0.0.0.0");
const start = ["start", "--name", NAME, "--home", home, "--listen", listen];
if (mode === "domains") start.push("--no-tunnel");
console.log(start.join("\n"));
