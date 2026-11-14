// Pure helpers for local hosting through a Cloudflare Tunnel (scripts/setup.mjs --tunnel and
// scripts/local-start.mjs). Kept free of Node imports so the Workers test pool can test them, like
// admin-lib.mjs. Paths are POSIX: local hosting scripts support macOS and Linux only.

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const PROVIDERS = ["sendgrid", "resend", "console"];
const ISOLATIONS = ["origin", "opaque"];

export const DEFAULT_PORT = 8788;

export class TunnelUsageError extends Error {}

const fail = (message) => {
  throw new TunnelUsageError(message);
};

/**
 * Check the --tunnel flags and fill defaults. `raw` holds flag values keyed by flag name without
 * dashes; boolean flags are `true`. `deps.getDomain` returns the registrable domain (tldts with
 * private domains), or null.
 */
export function validateTunnelOptions(raw, deps) {
  const name = raw.name === undefined ? "plinth" : String(raw.name);
  if (!NAME_RE.test(name)) fail("--name must be lowercase letters, digits and dashes, e.g. plinth");

  const host = (flag) => {
    const v = raw[flag];
    if (typeof v !== "string" || !HOST_RE.test(v.toLowerCase()))
      fail(`--${flag} must be a host name like plinth.example.com`);
    return v.toLowerCase();
  };
  const appHost = host("app-host");
  const contentHost = host("content-host");

  const isolation = raw["content-isolation"] === undefined ? "origin" : raw["content-isolation"];
  if (!ISOLATIONS.includes(isolation)) fail("--content-isolation must be origin or opaque");

  if (contentHost === appHost) fail("--content-host must differ from --app-host");
  if (isolation === "origin") {
    const appDomain = deps.getDomain(appHost);
    const contentDomain = deps.getDomain(contentHost);
    if (appDomain && appDomain === contentDomain)
      fail(
        "--app-host and --content-host share a registrable domain. Use a second domain for content, " +
          "or --content-isolation opaque",
      );
    if (contentDomain !== contentHost)
      fail(
        `--content-host must be the apex of its own zone (e.g. ${contentDomain ?? "example-content.net"}). ` +
          "Artifacts are served at <id>.<content host>, and Cloudflare's free certificate covers only " +
          "one level of wildcard below the apex",
      );
  }

  let port = DEFAULT_PORT;
  if (raw.port !== undefined) {
    port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      fail("--port must be a number from 1024 to 65535");
  }

  const singleUser = raw["single-user"] === true;
  let adminEmail = null;
  if (raw["admin-email"] !== undefined) {
    adminEmail = String(raw["admin-email"]).toLowerCase();
    if (!EMAIL_RE.test(adminEmail)) fail("--admin-email is not an email address");
  }
  if (singleUser && !adminEmail) fail("--single-user needs --admin-email <email>");

  const emailProvider = raw["email-provider"];
  if (!PROVIDERS.includes(emailProvider))
    fail("--email-provider must be sendgrid, resend or console");
  if (emailProvider === "console" && !singleUser)
    fail(
      "production refuses --email-provider console unless --single-user (it logs sign-in codes); " +
        "use sendgrid or resend",
    );

  const emailFrom =
    raw["email-from"] === undefined ? `Plinth <noreply@${appHost}>` : String(raw["email-from"]);

  return {
    name,
    appHost,
    contentHost,
    port,
    emailProvider,
    emailFrom,
    singleUser,
    adminEmail,
    isolation,
    cloudflare: raw["no-cloudflare"] !== true,
  };
}

/** Files of one instance under the Plinth home directory (default ~/.plinth). */
export function instancePaths(home, name) {
  const dir = `${home.replace(/\/+$/, "")}/${name}`;
  return {
    dir,
    state: `${dir}/state`,
    wranglerConfig: `${dir}/wrangler.jsonc`,
    devVars: `${dir}/.dev.vars`,
    cloudflaredConfig: `${dir}/cloudflared.yml`,
    credentials: `${dir}/tunnel-credentials.json`,
    meta: `${dir}/instance.json`,
  };
}

/**
 * The Wrangler config for a local instance. `base` is the repo's apps/worker/wrangler.jsonc, for
 * the compatibility settings and default limits; everything that makes the instance production and
 * local is set here and wins over `base`.
 */
export function buildWorkerConfig(o, repoRoot, base = {}) {
  const root = repoRoot.replace(/\/+$/, "");
  return {
    name: `plinth-${o.name}`,
    main: `${root}/apps/worker/src/index.ts`,
    compatibility_date: base.compatibility_date ?? "2026-11-01",
    compatibility_flags: base.compatibility_flags ?? ["nodejs_compat"],
    workers_dev: false,
    assets: {
      ...(base.assets ?? {
        binding: "ASSETS",
        run_worker_first: true,
        not_found_handling: "single-page-application",
      }),
      directory: `${root}/apps/web/dist`,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "plinth",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: `${root}/migrations`,
      },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: "plinth-files" }],
    vars: {
      ...(base.vars ?? {}),
      ENVIRONMENT: "production",
      APP_HOST: o.appHost,
      CONTENT_HOST: o.contentHost,
      CONTENT_ISOLATION: o.isolation,
      PUBLIC_SCHEME: "https",
      EMAIL_PROVIDER: o.emailProvider,
      EMAIL_FROM: o.emailFrom,
      SINGLE_USER_MODE: o.singleUser ? "true" : "false",
      ADMIN_EMAIL: o.adminEmail ?? "",
      STAGING_CONTENT_FALLBACK: "false",
      DEV_OUTBOX: "false",
      DEV_IGNORE_CLIENT_IP: "false",
      DEV_SEED: "false",
    },
  };
}

/**
 * cloudflared config: the app host, the content apex and every artifact subdomain go to the local
 * Worker; anything else gets a 404. The Host header is passed through unchanged (no
 * httpHostHeader), because the Worker routes by host.
 */
export function renderCloudflaredConfig({ tunnelId, credentialsFile, appHost, contentHost, port }) {
  const service = `http://127.0.0.1:${port}`;
  return [
    "# Generated by scripts/setup.mjs --tunnel. Rerunning setup rewrites this file.",
    `tunnel: ${tunnelId}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    "ingress:",
    `  - hostname: ${appHost}`,
    `    service: ${service}`,
    `  - hostname: ${contentHost}`,
    `    service: ${service}`,
    `  - hostname: ${JSON.stringify(`*.${contentHost}`)}`,
    `    service: ${service}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

/** The proxied CNAMEs that point the instance's hosts at the tunnel. */
export function dnsRecordNames(appHost, contentHost) {
  return [appHost, contentHost, `*.${contentHost}`];
}

/** Contents of the tunnel credentials file cloudflared reads (keep it mode 0600). */
export function credentialsJson({ accountId, tunnelId, secret }) {
  return `${JSON.stringify({ AccountTag: accountId, TunnelID: tunnelId, TunnelSecret: secret }, null, 2)}\n`;
}

/**
 * Arguments for wrangler and cloudflared. `--upstream-protocol https` keeps the browser's Origin
 * header and an https request URL; without it wrangler dev rewrites both to http and every
 * CSRF-checked request is refused.
 */
export function startCommands(paths, port, tunnel) {
  return {
    wrangler: [
      "dev",
      "--config",
      paths.wranglerConfig,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      paths.state,
      "--upstream-protocol",
      "https",
      "--show-interactive-dev-session=false",
    ],
    cloudflared: tunnel
      ? ["tunnel", "--no-autoupdate", "--config", paths.cloudflaredConfig, "run"]
      : null,
  };
}
