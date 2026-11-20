// Pure helpers for deploying Plinth to a Cloudflare account: `plinth deploy` (packages/cli) and the
// host checks of `scripts/setup.mjs --remote`. Kept free of Node imports so the Workers test pool
// can test them, like tunnel-lib.mjs; deploy.mjs runs wrangler and writes the files.
import { CloudflareError, cloudflareApi } from "./tunnel-cloudflare.mjs";
import { REQUIRED_FLAGS, ROOMS_DO, ROOMS_MIGRATIONS, SWEEP_CRON } from "./tunnel-lib.mjs";

export { CloudflareError, REQUIRED_FLAGS, ROOMS_DO, ROOMS_MIGRATIONS, SWEEP_CRON };

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const PROVIDERS = ["sendgrid", "resend", "console"];
const ISOLATIONS = ["origin", "opaque"];

/** The proxied record that sends every artifact subdomain to Cloudflare, where the route runs. */
export const WILDCARD_CONTENT = "192.0.2.0";

/** What an API token for `plinth deploy` needs (wrangler's own calls plus the wildcard record). */
export const DEPLOY_PERMISSIONS =
  "Account · Workers Scripts · Edit, Account · D1 · Edit, Account · Workers R2 Storage · Edit, " +
  "Zone · Workers Routes · Edit, Zone · DNS · Edit, Zone · Zone · Read";

/** The Worker variables `plinth deploy` owns; anything else may be added under `vars`. */
export const OWNED_VARS = [
  "ENVIRONMENT",
  "APP_HOST",
  "CONTENT_HOST",
  "CONTENT_ISOLATION",
  "PUBLIC_SCHEME",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "SINGLE_USER_MODE",
  "ADMIN_EMAIL",
  "OPERATOR_NAME",
  "OPERATOR_EMAIL",
  "OPERATOR_ADDRESS",
  "OPERATOR_REGISTRATION",
  "STAGING_CONTENT_FALLBACK",
  "DEV_OUTBOX",
  "DEV_IGNORE_CLIENT_IP",
  "DEV_SEED",
];

export class DeployUsageError extends Error {}

const fail = (message) => {
  throw new DeployUsageError(message);
};

/**
 * The checks the Worker makes on APP_HOST and CONTENT_HOST in production. `registrable(host)` is
 * the registrable domain with the Public Suffix List's private section included (tldts). Returns
 * an error message, or null when the pair is allowed with `isolation`.
 */
export function hostPairProblem(appHost, contentHost, isolation, registrable) {
  // Refused by the Worker in every isolation mode.
  if (
    appHost === contentHost ||
    contentHost.endsWith(`.${appHost}`) ||
    appHost.endsWith(`.${contentHost}`)
  )
    return "APP_HOST and CONTENT_HOST must differ and must not be subdomains of each other";
  // The same Public Suffix List check the Worker makes, so a content host that is a PSL-listed
  // subdomain of the app's domain passes once tldts knows it. A shared registrable domain is
  // allowed only with opaque isolation (docs/security.md).
  if (registrable(appHost) === registrable(contentHost) && isolation !== "opaque")
    return (
      "APP_HOST and CONTENT_HOST share a registrable domain. Pass --content-isolation opaque to " +
      "run like this (artifacts get an opaque origin and no browser storage), or use a separate " +
      "domain, or a subdomain on the Public Suffix List once the pinned tldts knows it " +
      "(docs/deploy-checklist.md)"
    );
  return null;
}

/** `own` followed by each entry of `add` whose `key` no entry of `own` has. */
function unionBy(own, add, key) {
  const seen = new Set(own.map((e) => e?.[key]));
  return [...own, ...add.filter((e) => !seen.has(e?.[key]))];
}

/**
 * The runtime settings a re-run of setup (or `plinth start`) carries into an existing config:
 * every compatibility flag of either file (the repo's config names the flags this release needs,
 * such as enable_request_signal), every cron trigger of either (the hourly staging sweep), the
 * later compatibility date, and the repo's Durable Object bindings and migrations that `existing`
 * lacks (live rooms: binding `ROOMS`, tag `rooms-v1`), matched by binding name and by tag. The
 * rest of `existing` is kept, its own triggers, bindings and migrations included.
 */
export function refreshRuntime(existing, repo) {
  const flags = [
    ...new Set([...(existing.compatibility_flags ?? []), ...(repo.compatibility_flags ?? [])]),
  ];
  const dates = [existing.compatibility_date, repo.compatibility_date].filter(Boolean).sort();
  const crons = [
    ...new Set([...(existing.triggers?.crons ?? []), ...(repo.triggers?.crons ?? [])]),
  ];
  const repoBindings = repo.durable_objects?.bindings ?? [];
  const repoMigrations = repo.migrations ?? [];
  return {
    ...existing,
    ...(dates.length > 0 ? { compatibility_date: dates[dates.length - 1] } : {}),
    compatibility_flags: flags,
    ...(crons.length > 0 || existing.triggers
      ? { triggers: { ...(existing.triggers ?? {}), crons } }
      : {}),
    ...(repoBindings.length > 0 || existing.durable_objects
      ? {
          durable_objects: {
            ...(existing.durable_objects ?? {}),
            bindings: unionBy(existing.durable_objects?.bindings ?? [], repoBindings, "name"),
          },
        }
      : {}),
    ...(repoMigrations.length > 0 || existing.migrations
      ? { migrations: unionBy(existing.migrations ?? [], repoMigrations, "tag") }
      : {}),
  };
}

/**
 * The parts of the repo's apps/worker/wrangler.jsonc a generated config takes, minus everything
 * instance-specific: compatibility settings, the cron trigger, observability, assets settings, the
 * live-rooms Durable Object binding and its migration, and default limits.
 * packages/cli/scripts/bundle.mjs writes it as runtime/wrangler.base.json.
 */
export function runtimeBase(repoCfg) {
  return {
    compatibility_date: repoCfg.compatibility_date,
    compatibility_flags: repoCfg.compatibility_flags,
    triggers: repoCfg.triggers,
    observability: repoCfg.observability,
    assets: { ...repoCfg.assets, directory: undefined },
    durable_objects: repoCfg.durable_objects,
    migrations: repoCfg.migrations,
    vars: Object.fromEntries(
      [
        "MAX_ARTIFACTS_PER_USER",
        "MAX_PUBLISHES_PER_HOUR",
        "MAX_VERSION_BYTES",
        "MAX_ASSETS_PER_VERSION",
        "CDN_ALLOWLIST",
        "ALLOW_PUBLIC_VISIBILITY",
        "PUBLIC_MIN_ACCOUNT_AGE_HOURS",
        "ALLOW_SHARED_DATA",
        "SHOW_SOURCE_LINK",
        "DATA_MAX_DOCS_PER_ARTIFACT",
        "DATA_MAX_BYTES_PER_ARTIFACT",
        "DATA_MAX_BYTES_PER_USER",
        "DATA_MAX_DOC_BYTES",
        "DATA_WRITES_PER_VIEWER_PER_HOUR",
        "DATA_WRITES_PER_ARTIFACT_PER_HOUR",
        "ALLOW_ROOMS",
        "ROOM_MAX_CONNECTIONS_PER_ARTIFACT",
        "ROOM_MAX_MESSAGE_BYTES",
        "ROOM_MESSAGES_PER_SECOND",
        "ALLOW_LIVE_EDITING",
        "LIVE_CHECKPOINT_IDLE_S",
        "LIVE_AUTO_CHECKPOINT_MIN_S",
        "LIVE_DRAFT_FLUSH_S",
        "LIVE_DRAFT_RETENTION_DAYS",
        "SHEET_EVAL_BUDGET",
      ]
        .filter((k) => k in (repoCfg.vars ?? {}))
        .map((k) => [k, repoCfg.vars[k]]),
    ),
  };
}

/**
 * The runtime settings this release needs that a Worker config lacks (empty when it has both).
 * The live-rooms binding is not one of them: a config without `ROOMS` runs with rooms off
 * (runtimeConfigNotes says so).
 */
export function runtimeConfigMissing(cfg) {
  const missing = [];
  if (!(cfg?.compatibility_flags ?? []).includes("enable_request_signal"))
    missing.push('"enable_request_signal" in compatibility_flags');
  if (!(cfg?.triggers?.crons ?? []).includes(SWEEP_CRON))
    missing.push(`"${SWEEP_CRON}" in triggers.crons`);
  return missing;
}

/**
 * Why a Worker config must not be deployed with this release, or null: it lacks the
 * enable_request_signal flag (an abandoned upload's cleanup would never start) or the hourly cron
 * trigger (nothing would remove what abandoned uploads leave).
 */
export function runtimeConfigProblem(cfg) {
  const review = reviewLoginConfigProblem(cfg);
  if (review) return review;
  const missing = runtimeConfigMissing(cfg);
  if (missing.length === 0) return null;
  return (
    `the Worker config lacks ${missing.join(" and ")}. Plinth needs both from 0.4.0 on. ` +
    'Add `"compatibility_flags": ["nodejs_compat", "enable_request_signal"]` and ' +
    `\`"triggers": { "crons": ["${SWEEP_CRON}"] }\` (as apps/worker/wrangler.jsonc has them), or ` +
    "rerun setup, which adds them to an existing config (docs/deploy-checklist.md)"
  );
}

/**
 * The review account (REVIEW_LOGIN_EMAIL) must be an ordinary user: never an ADMIN_EMAIL address,
 * and never on a single-user instance. The Worker refuses both at start-up too (src/config.ts);
 * this stops the deploy first. Its password hash is a secret, so it is not in the config to check.
 */
export function reviewLoginConfigProblem(cfg) {
  const vars = cfg?.vars ?? {};
  const review = String(vars.REVIEW_LOGIN_EMAIL ?? "")
    .trim()
    .toLowerCase();
  if (!review) return null;
  const admins = String(vars.ADMIN_EMAIL ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (admins.includes(review)) {
    return "REVIEW_LOGIN_EMAIL is an ADMIN_EMAIL address. The review account signs in with a shared password, so it must be an ordinary account: pick another address";
  }
  if (String(vars.SINGLE_USER_MODE ?? "").toLowerCase() === "true") {
    return "REVIEW_LOGIN_EMAIL is set on a single-user instance, where only the admin signs in. Remove it, or turn SINGLE_USER_MODE off";
  }
  return null;
}

/** True when `cfg` binds the live-rooms Durable Object (`ROOMS`, class `ArtifactRoom`). */
export function hasRoomsBinding(cfg) {
  return (cfg?.durable_objects?.bindings ?? []).some(
    (b) => b?.name === "ROOMS" && b?.class_name === "ArtifactRoom" && !b?.script_name,
  );
}

/**
 * What a deployable Worker config leaves off that the operator may want on, as notes that never
 * stop a deploy: today only live rooms, which need the `ROOMS` binding and its migration.
 */
export function runtimeConfigNotes(cfg) {
  if (hasRoomsBinding(cfg)) return [];
  return [
    "it has no ROOMS Durable Object binding, so live rooms are off (doc editors edit on the page " +
      "alone, without seeing each other). To turn them on, rerun setup (it adds the binding and the rooms-v1 migration) or add " +
      `\`"durable_objects": ${JSON.stringify(ROOMS_DO)}\` and \`"migrations": ` +
      `${JSON.stringify(ROOMS_MIGRATIONS)}\` as apps/worker/wrangler.jsonc has them ` +
      "(docs/deploy-checklist.md#live-rooms)",
  ];
}

/** The --name flag, checked: lowercase letters, digits and dashes; default plinth. */
export function instanceName(raw) {
  const name = raw.name === undefined ? "plinth" : String(raw.name);
  if (!NAME_RE.test(name)) fail("--name must be lowercase letters, digits and dashes, e.g. plinth");
  return name;
}

/** Files of a Cloudflare deployment under the Plinth home directory (default ~/.plinth). */
export function deployPaths(home, name) {
  const dir = `${home.replace(/\/+$/, "")}/${name}/cloudflare`;
  return { dir, wranglerConfig: `${dir}/wrangler.jsonc`, settings: `${dir}/deploy.json` };
}

/** Worker, D1 database and R2 bucket names for an instance name: plinth, plinth, plinth-files. */
export function resourceNames(name) {
  const base = name === "plinth" || name.startsWith("plinth-") ? name : `plinth-${name}`;
  return { workerName: base, dbName: base, bucket: `${base}-files` };
}

/**
 * Merge `plinth deploy` flags into the settings saved by an earlier run (or null) and check the
 * result. `raw` holds flag values keyed by flag name without dashes; boolean flags are `true`. An
 * empty string clears an optional setting. `deps.getDomain` is tldts with the private section,
 * `deps.getZone` without it (the Cloudflare zone a host belongs to). Returns the settings to save.
 */
export function mergeDeploySettings(raw, saved, deps) {
  const name = instanceName(raw);
  const s = {
    version: 1,
    name,
    ...resourceNames(name),
    appHost: null,
    contentHost: null,
    emailProvider: null,
    emailFrom: null,
    adminEmail: null,
    singleUser: false,
    isolation: "origin",
    operator: { name: null, email: null, address: null, registration: null },
    vars: {},
    ...(saved ?? {}),
  };
  s.name = name;
  s.operator = { name: null, email: null, address: null, registration: null, ...s.operator };
  s.vars = { ...(s.vars ?? {}) };

  const text = (flag) => {
    const v = raw[flag];
    if (v === undefined) return undefined;
    if (v === true) fail(`--${flag} needs a value`);
    const t = String(v).trim();
    return t === "" ? null : t;
  };
  const host = (flag) => {
    const v = text(flag);
    if (v === undefined) return undefined;
    if (v === null || !HOST_RE.test(v.toLowerCase()))
      fail(`--${flag} must be a host name like plinth.example.com`);
    return v.toLowerCase();
  };
  const email = (flag) => {
    const v = text(flag);
    if (v === undefined || v === null) return v;
    if (!EMAIL_RE.test(v)) fail(`--${flag} is not an email address`);
    return v.toLowerCase();
  };

  const appHost = host("app-host");
  if (appHost !== undefined) s.appHost = appHost;
  const contentHost = host("content-host");
  if (contentHost !== undefined) s.contentHost = contentHost;
  const provider = text("email-provider");
  if (provider !== undefined) {
    if (!PROVIDERS.includes(provider)) fail("--email-provider must be sendgrid, resend or console");
    s.emailProvider = provider;
  }
  const from = text("email-from");
  if (from !== undefined) s.emailFrom = from;
  const admin = email("admin-email");
  if (admin !== undefined) s.adminEmail = admin;
  if (raw["single-user"] === true && raw["multi-user"] === true)
    fail("Pass --single-user or --multi-user, not both");
  if (raw["single-user"] === true) s.singleUser = true;
  if (raw["multi-user"] === true) s.singleUser = false;
  const isolation = text("content-isolation");
  if (isolation !== undefined) {
    if (!ISOLATIONS.includes(isolation)) fail("--content-isolation must be origin or opaque");
    s.isolation = isolation;
  }
  for (const [flag, key] of [
    ["operator-name", "name"],
    ["operator-address", "address"],
    ["operator-registration", "registration"],
  ]) {
    const v = text(flag);
    if (v !== undefined) s.operator[key] = v;
  }
  const opEmail = email("operator-email");
  if (opEmail !== undefined) s.operator.email = opEmail;

  const missing = [
    ["--app-host", s.appHost],
    ["--content-host", s.contentHost],
    ["--email-provider", s.emailProvider],
  ]
    .filter(([, v]) => !v)
    .map(([f]) => f);
  if (missing.length)
    fail(
      saved
        ? `the saved settings have no ${missing.join(", ")}; pass ${missing.length > 1 ? "them" : "it"}`
        : `the first deploy needs ${missing.join(", ")} (later runs reuse the saved settings)`,
    );

  const problem = hostPairProblem(s.appHost, s.contentHost, s.isolation, (h) => {
    return deps.getDomain(h) ?? h;
  });
  if (problem) fail(problem);
  if (s.singleUser && !s.adminEmail) fail("--single-user needs --admin-email <email>");
  if (s.emailProvider === "console" && !s.singleUser)
    fail(
      "production refuses --email-provider console unless --single-user (it logs sign-in codes); " +
        "use sendgrid or resend",
    );
  const op = s.operator;
  if (!!op.name !== !!op.email)
    fail("--operator-name and --operator-email go together: the legal pages need both");
  if (!op.name && (op.address || op.registration))
    fail(
      "--operator-address and --operator-registration need --operator-name and --operator-email",
    );
  for (const k of Object.keys(s.vars)) {
    if (OWNED_VARS.includes(k))
      fail(`deploy.json: ${k} is set by plinth deploy and cannot be overridden under "vars"`);
  }
  return s;
}

/** Cloudflare zones of the two hosts (tldts without the private section). */
export function zonesOf(s, deps) {
  return {
    appZone: deps.getZone(s.appHost) ?? s.appHost,
    contentZone: deps.getZone(s.contentHost) ?? s.contentHost,
  };
}

/**
 * The Wrangler config for a deployment. `layout` names the prebuilt Worker, the web app and the
 * migrations ({ main, assetsDir, migrationsDir }); `base` holds compatibility settings, assets
 * settings and default limits (runtime/wrangler.base.json). Every setting that makes the instance
 * production comes from `s` and wins over `base` and `s.vars`.
 */
export function buildDeployConfig(s, layout, base, { databaseId, contentZone }) {
  const op = s.operator;
  return {
    name: s.workerName,
    main: layout.main,
    compatibility_date: base.compatibility_date ?? "2026-11-01",
    compatibility_flags: base.compatibility_flags ?? REQUIRED_FLAGS,
    triggers: base.triggers ?? { crons: [SWEEP_CRON] },
    workers_dev: false,
    // Preview URLs would serve the Worker on extra hosts that are not APP_HOST.
    preview_urls: false,
    observability: base.observability ?? { enabled: true },
    assets: {
      ...(base.assets ?? {
        binding: "ASSETS",
        run_worker_first: true,
        not_found_handling: "single-page-application",
      }),
      directory: layout.assetsDir,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: s.dbName,
        database_id: databaseId,
        migrations_dir: layout.migrationsDir,
      },
    ],
    r2_buckets: [{ binding: "FILES", bucket_name: s.bucket }],
    durable_objects: base.durable_objects ?? ROOMS_DO,
    migrations: base.migrations ?? ROOMS_MIGRATIONS,
    routes: [
      { pattern: s.appHost, custom_domain: true },
      { pattern: `*.${s.contentHost}/*`, zone_name: contentZone },
    ],
    vars: {
      ...(base.vars ?? {}),
      ...s.vars,
      ENVIRONMENT: "production",
      APP_HOST: s.appHost,
      CONTENT_HOST: s.contentHost,
      CONTENT_ISOLATION: s.isolation,
      PUBLIC_SCHEME: "https",
      EMAIL_PROVIDER: s.emailProvider,
      EMAIL_FROM: s.emailFrom ?? `Plinth <noreply@${s.appHost}>`,
      SINGLE_USER_MODE: s.singleUser ? "true" : "false",
      ADMIN_EMAIL: s.adminEmail ?? "",
      OPERATOR_NAME: op.name ?? "",
      OPERATOR_EMAIL: op.email ?? "",
      OPERATOR_ADDRESS: op.address ?? "",
      OPERATOR_REGISTRATION: op.registration ?? "",
      STAGING_CONTENT_FALLBACK: "false",
      DEV_OUTBOX: "false",
      DEV_IGNORE_CLIENT_IP: "false",
      DEV_SEED: "false",
    },
  };
}

/**
 * The account to deploy to, from `wrangler whoami --json` output. CLOUDFLARE_ACCOUNT_ID (passed
 * as `envAccountId`) wins and must be one of the accounts; otherwise there must be exactly one.
 */
export function pickAccount(whoami, envAccountId) {
  const accounts = Array.isArray(whoami?.accounts) ? whoami.accounts : [];
  if (envAccountId) {
    const found = accounts.find((a) => a.id === envAccountId);
    if (!found && accounts.length)
      fail(
        `CLOUDFLARE_ACCOUNT_ID ${envAccountId} is not one of your accounts: ` +
          accounts.map((a) => `${a.name} (${a.id})`).join(", "),
      );
    return { id: envAccountId, name: found?.name ?? envAccountId };
  }
  if (accounts.length === 1) return { id: accounts[0].id, name: accounts[0].name };
  if (accounts.length === 0)
    fail("wrangler found no Cloudflare account for these credentials. Check `wrangler whoami`");
  fail(
    "You have access to several Cloudflare accounts. Choose one with CLOUDFLARE_ACCOUNT_ID and " +
      `rerun:\n${accounts.map((a) => `  export CLOUDFLARE_ACCOUNT_ID=${a.id}   # ${a.name}`).join("\n")}`,
  );
}

/** The wildcard record for the content host, as the Cloudflare dashboard names it. */
export function wildcardRecord(contentHost, contentZone) {
  const fqdn = `*.${contentHost}`;
  const label =
    contentHost === contentZone ? "*" : `*.${contentHost.slice(0, -contentZone.length - 1)}`;
  return { type: "A", name: fqdn, label, content: WILDCARD_CONTENT, proxied: true };
}

/**
 * Check both zones on the account and, with `create`, add the content wildcard record when it is
 * missing. Never changes or deletes a record: a wildcard that is not proxied through Cloudflare is
 * a conflict. Every read happens before the write. Returns
 * { zones: { [zone]: id }, wildcard: "created" | "exists" | "missing" | "unknown" }; "unknown"
 * when the token cannot read DNS records (wrangler's OAuth login cannot).
 */
export async function checkZones(a) {
  const call = cloudflareApi(a.token, a.fetch, DEPLOY_PERMISSIONS);
  const q = encodeURIComponent;
  const zones = {};
  for (const zone of [...new Set([a.appZone, a.contentZone])]) {
    const found = await call("GET", `/zones?name=${q(zone)}&account.id=${q(a.accountId)}`);
    if (!found?.length)
      throw new CloudflareError(
        `The zone ${zone} is not on the Cloudflare account ${a.accountName ?? a.accountId}. ` +
          "Add the domain to that account (Cloudflare dashboard > Add a domain) and rerun, or " +
          "choose the account with CLOUDFLARE_ACCOUNT_ID",
      );
    zones[zone] = found[0].id;
  }
  const rec = wildcardRecord(a.contentHost, a.contentZone);
  let records;
  try {
    records = await call("GET", `/zones/${zones[a.contentZone]}/dns_records?name=${q(rec.name)}`);
  } catch (e) {
    if (e instanceof CloudflareError && (e.status === 401 || e.status === 403))
      return { zones, wildcard: "unknown" };
    throw e;
  }
  if (records.length) {
    const unproxied = records.filter((r) => !r.proxied);
    if (unproxied.length)
      throw new CloudflareError(
        `A DNS record for ${rec.name} already exists and is not proxied through Cloudflare ` +
          `(${unproxied.map((r) => `${r.type} ${r.content}`).join(", ")}), so artifact requests ` +
          "would not reach the Worker. Plinth does not change existing records: turn on the proxy " +
          "(orange cloud) for it or remove it in the Cloudflare dashboard, then rerun",
      );
    return { zones, wildcard: "exists" };
  }
  if (!a.create) return { zones, wildcard: "missing" };
  await call("POST", `/zones/${zones[a.contentZone]}/dns_records`, {
    type: rec.type,
    name: rec.name,
    content: rec.content,
    proxied: true,
    comment: "Plinth: sends artifact subdomains to the Worker route",
  });
  return { zones, wildcard: "created" };
}

/**
 * Things to tell the operator after a deploy, from the settings: legal pages, the content domain
 * and the Public Suffix List, and the certificate a content subdomain needs.
 */
export function deployNotes(s, deps) {
  const notes = [];
  const { contentZone } = zonesOf(s, deps);
  if (!s.operator.name && !s.singleUser)
    notes.push(
      "Legal pages: with no operator set, the instance publishes only its acceptable use policy. " +
        "Before other people sign up, rerun with --operator-name and --operator-email (in the EU " +
        "also --operator-address and --operator-registration) to publish terms and a privacy notice.",
    );
  if (s.contentHost !== contentZone)
    notes.push(
      `Certificate: ${s.contentHost} is not the apex of its zone, so artifacts at ` +
        `<id>.${s.contentHost} need an Advanced Certificate for *.${s.contentHost} ` +
        "(Cloudflare dashboard > SSL/TLS > Edge Certificates); Universal SSL covers one level only.",
    );
  if (s.isolation === "opaque")
    notes.push(
      "Opaque isolation: artifacts have no cookies or browser storage. Once the content host is " +
        "on the Public Suffix List and the pinned tldts knows it, rerun with " +
        "--content-isolation origin.",
    );
  else
    notes.push(
      `Public Suffix List: submit ${s.contentHost} to github.com/publicsuffix/list so artifacts are ` +
        "separate sites from each other too (https://github.com/mr0b0t0/plinth/blob/main/docs/deploy-checklist.md#public-suffix-list).",
    );
  return notes;
}
