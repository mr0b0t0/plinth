// Deploying Plinth to a Cloudflare account with wrangler. provisionRemote (D1, R2, config, secrets,
// migrations) is shared by `scripts/setup.mjs --remote` and `plinth deploy` (packages/cli);
// deployToCloudflare is the whole of `plinth deploy`: login and account, zones and the content
// wildcard record, provisioning, `wrangler deploy` and a health check. Pure parts are in
// deploy-lib.mjs.
//
// runtime = {
//   wrangler,   // { command, args: [...prefix], cwd }: how to run wrangler
//   log,        // optional, default console.log
//   ...         // deployToCloudflare also takes layout, base, getDomain, getZone and command
// }
//
// Secret values are generated here (or read from SENDGRID_API_KEY / RESEND_API_KEY in the
// environment) and piped to wrangler on stdin. They never appear on a command line or in output,
// except a newly generated single-user ADMIN_TOKEN, which the callers show once.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildDeployConfig,
  CloudflareError,
  checkZones,
  DEPLOY_PERMISSIONS,
  DeployUsageError,
  deployNotes,
  deployPaths,
  instanceName,
  mergeDeploySettings,
  pickAccount,
  runtimeConfigProblem,
  wildcardRecord,
  zonesOf,
} from "./deploy-lib.mjs";
import { InstanceError, resolveHome, secret } from "./instance.mjs";

const fail = (message) => {
  throw new InstanceError(message);
};

function show(args) {
  return ["wrangler", ...args].map((a) => (/[\s"'<>]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/**
 * A wrangler runner. `run(args, { input, capture, allowFail, interactive, quiet })` prints the
 * command (unless `quiet`) and runs it; `input` is piped to stdin and never printed; `capture`
 * returns stdout instead of showing it. In a dry run nothing runs and `probe` returns null.
 */
export function wranglerRunner(runtime, { dryRun = false, env = {} } = {}) {
  const log = runtime.log ?? console.log;
  function run(
    args,
    { input, capture = false, allowFail = false, interactive = false, quiet } = {},
  ) {
    const suffix = input === undefined ? "" : "   (value piped on stdin)";
    if (!quiet) log(`  $ ${show(args)}${suffix}`);
    if (dryRun) return { status: 0, stdout: "" };
    const r = spawnSync(runtime.wrangler.command, [...runtime.wrangler.args, ...args], {
      cwd: runtime.wrangler.cwd,
      input: interactive ? undefined : (input ?? ""),
      stdio: interactive
        ? "inherit"
        : ["pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
    });
    if (r.error) fail(`could not run wrangler: ${r.error.message}`);
    if (r.status !== 0 && !allowFail) {
      if (capture) process.stderr.write(r.stderr ?? "");
      fail(`wrangler exited with status ${r.status}`);
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  }
  /** A read-only call whose result decides what to do. Dry run: printed, returns null. */
  function probe(args) {
    if (dryRun) {
      log(`  $ ${show(args)}`);
      return null;
    }
    return run(args, { capture: true, allowFail: true });
  }
  return { run, probe, dryRun };
}

/** The JSON object in wrangler's output (it may print a banner or warnings first), or null. */
function parseJsonOutput(text) {
  const at = text.search(/[[{]/);
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}

/**
 * D1 database, R2 bucket, Worker config, secrets and remote migrations, in that order, each step
 * kept if already done. Shared by setup.mjs --remote and plinth deploy.
 *
 * p = {
 *   wrangler,        // wranglerRunner(...)
 *   dbName, bucket,
 *   configTitle,     // step title for the config, e.g. "Config apps/worker/wrangler.x.jsonc"
 *   writeConfig,     // (databaseId) => { vars }: writes (or in a dry run prints) the config
 *   configArgs,      // ["--config", <path as wrangler sees it>]
 *   adminToken,      // generate ADMIN_TOKEN if missing (single-user)
 *   rotateSecrets,   // replace existing generated secrets
 *   missingKeyHint,  // (name) => what to do about a missing email provider key
 * }
 * Returns { databaseId, adminToken (new value or null), missingKeys }.
 */
export function provisionRemote(p, runtime) {
  const log = runtime.log ?? console.log;
  const w = p.wrangler;
  const step = (title) => log(`\n> ${title}`);

  step("D1 database");
  const findDb = () => {
    const r = w.probe(["d1", "list", "--json"]);
    if (r === null) return null;
    const list = parseJsonOutput(r.stdout);
    if (!Array.isArray(list)) fail("Could not parse `wrangler d1 list --json` output");
    return list.find((d) => d.name === p.dbName)?.uuid ?? null;
  };
  let databaseId = findDb();
  if (databaseId) log(`  exists: ${p.dbName} (${databaseId})`);
  else {
    w.run(["d1", "create", p.dbName]);
    databaseId = w.dryRun ? "<database id from wrangler d1 list>" : findDb();
    if (!databaseId) fail(`Created ${p.dbName} but could not find its id with wrangler d1 list`);
  }

  step("R2 bucket");
  const info = w.probe(["r2", "bucket", "info", p.bucket]);
  if (info?.status === 0) log(`  exists: ${p.bucket}`);
  else w.run(["r2", "bucket", "create", p.bucket]);

  step(p.configTitle);
  const { vars } = p.writeConfig(databaseId);

  step("Secrets");
  let existing = new Set();
  const listed = w.probe(["secret", "list", ...p.configArgs, "--format", "json"]);
  if (listed?.status === 0) {
    const names = parseJsonOutput(listed.stdout);
    // No parseable list: treat as none set.
    if (Array.isArray(names)) existing = new Set(names.map((s) => s.name));
  }
  const names = ["SESSION_SECRET", "TOKEN_SIGNING_KEY", ...(p.adminToken ? ["ADMIN_TOKEN"] : [])];
  let adminToken = null;
  for (const name of names) {
    if (existing.has(name) && !p.rotateSecrets) {
      log(`  ${name}: already set (--rotate-secrets replaces it)`);
      continue;
    }
    const value = secret();
    if (name === "ADMIN_TOKEN") adminToken = value;
    w.run(["secret", "put", name, ...p.configArgs], { input: value });
  }
  const missingKeys = [];
  for (const name of ["SENDGRID_API_KEY", "RESEND_API_KEY"]) {
    const value = process.env[name];
    if (value) w.run(["secret", "put", name, ...p.configArgs], { input: value });
    else if (vars.EMAIL_PROVIDER === name.split("_")[0].toLowerCase() && !existing.has(name)) {
      missingKeys.push(name);
      log(`  ${name}: not set. ${p.missingKeyHint(name)}`);
    }
  }

  step("Remote D1 migrations");
  w.run(["d1", "migrations", "apply", "DB", "--remote", ...p.configArgs]);
  return { databaseId, adminToken, missingKeys };
}

/** Read the saved settings of a Cloudflare deployment, or null. */
export function readDeployment(home, name) {
  const paths = deployPaths(home, name);
  if (!existsSync(paths.settings)) return null;
  const s = JSON.parse(readFileSync(paths.settings, "utf8"));
  return {
    paths,
    name: s.name ?? name,
    mode: "cloudflare",
    workerName: s.workerName,
    appHost: s.appHost,
    contentHost: s.contentHost,
    appOrigin: `https://${s.appHost}`,
    singleUser: s.singleUser === true,
    adminEmail: s.adminEmail ?? null,
  };
}

/** GET https://<app host>/healthz once; true when the Worker answers { ok: true }. */
export async function remoteHealthy(appHost, fetchFn = fetch) {
  try {
    const res = await fetchFn(`https://${appHost}/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

/** Log in if needed (wrangler login in a terminal), then pick the account. */
function account(runner, log) {
  const whoami = () => {
    const r = runner.run(["whoami", "--json"], { capture: true, allowFail: true, quiet: true });
    const json = r.status === 0 ? parseJsonOutput(r.stdout) : null;
    return json?.loggedIn ? json : null;
  };
  let me = whoami();
  if (!me && process.env.CLOUDFLARE_API_TOKEN)
    fail(
      `Cloudflare rejected CLOUDFLARE_API_TOKEN. Create a token with ${DEPLOY_PERMISSIONS} ` +
        "(both zones), export it and rerun, or unset it to use `wrangler login`",
    );
  if (!me) {
    if (!process.stdin.isTTY)
      fail(
        "Not logged in to Cloudflare. Run `npx wrangler login` once, or export " +
          `CLOUDFLARE_API_TOKEN (${DEPLOY_PERMISSIONS}), then rerun`,
      );
    log("  not logged in: opening `wrangler login` in your browser");
    runner.run(["login"], { interactive: true });
    me = whoami();
    if (!me) fail("wrangler login did not complete");
  }
  const acc = pickAccount(me, process.env.CLOUDFLARE_ACCOUNT_ID);
  log(`  logged in${me.email ? ` as ${me.email}` : ""} (${me.authType ?? "wrangler"})`);
  log(`  account: ${acc.name} (${acc.id})`);
  return acc;
}

/**
 * `plinth deploy`: create or update the deployment `<home>/<name>/cloudflare/`. Flags update the
 * saved settings; with none, the saved settings are deployed again (the upgrade path). Prints a
 * plan and each step; returns what the caller needs to print how to connect.
 */
export async function deployToCloudflare(raw, runtime) {
  const log = runtime.log ?? console.log;
  const cmd = runtime.command ?? ((c) => `plinth ${c}`);
  const dryRun = raw["dry-run"] === true;
  const step = (title) => log(`\n> ${title}`);
  const deps = { getDomain: runtime.getDomain, getZone: runtime.getZone };

  let s;
  let paths;
  try {
    const name = instanceName(raw);
    paths = deployPaths(resolveHome(raw.home), name);
    const saved = existsSync(paths.settings)
      ? JSON.parse(readFileSync(paths.settings, "utf8"))
      : null;
    s = mergeDeploySettings(raw, saved, deps);
  } catch (e) {
    if (e instanceof DeployUsageError) fail(e.message);
    throw e;
  }
  const { appZone, contentZone } = zonesOf(s, deps);
  // Before anything on the account: the config this deploy will write must carry the release's
  // runtime settings (a runtime/ bundled from a config without them would not).
  const problem = runtimeConfigProblem(
    buildDeployConfig(s, runtime.layout, runtime.base, { databaseId: "-", contentZone }),
  );
  if (problem) fail(`${problem}. Reinstall or rebuild plinth (pnpm build) and deploy again`);
  const record = wildcardRecord(s.contentHost, contentZone);
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || null;
  const selector = `${s.name === "plinth" ? "" : ` --name ${s.name}`}${raw.home ? ` --home ${raw.home}` : ""}`;

  log(`Plinth deploy of "${s.name}" to Cloudflare. Plan:`);
  log(
    `  1. Check the Cloudflare login, the account and the zones ${[...new Set([appZone, contentZone])].join(", ")}`,
  );
  log(
    `  2. DNS ${record.type} ${record.name} -> ${record.content}, proxied ` +
      (apiToken ? "(created if missing)" : "(checked; you add it if missing)"),
  );
  log(`  3. D1 database "${s.dbName}" and R2 bucket "${s.bucket}" (created if missing)`);
  log(`  4. Settings and Worker config in ${paths.dir}`);
  log(
    "  5. Secrets SESSION_SECRET, TOKEN_SIGNING_KEY (only if not set yet)" +
      (s.singleUser ? ", ADMIN_TOKEN" : ""),
  );
  log("  6. Apply the database migrations (remote)");
  log(`  7. Deploy Worker "${s.workerName}" to https://${s.appHost} and *.${s.contentHost}`);
  if (dryRun) log("  (dry run: commands are printed, nothing is created, written or deployed)");

  step("Cloudflare account and zones");
  let env = {};
  let wildcard = "unknown";
  if (dryRun) {
    log("  would check the login (wrangler whoami), the account and both zones");
    log(
      apiToken
        ? `  would create ${record.name} if missing (CLOUDFLARE_API_TOKEN is set)`
        : `  would check for ${record.name}`,
    );
  } else {
    const probeRunner = wranglerRunner(runtime);
    const acc = account(probeRunner, log);
    env = { CLOUDFLARE_ACCOUNT_ID: acc.id };
    let token = apiToken;
    if (!token) {
      // wrangler's OAuth login can read zones but not DNS records; good enough for the check.
      const r = wranglerRunner(runtime, { env }).run(["auth", "token", "--json"], {
        capture: true,
        allowFail: true,
        quiet: true,
      });
      token = r.status === 0 ? (parseJsonOutput(r.stdout)?.token ?? null) : null;
    }
    if (!token) log("  warning: could not check the zones; wrangler deploy will report problems");
    else {
      try {
        const z = await checkZones({
          token,
          fetch,
          accountId: acc.id,
          accountName: acc.name,
          appZone,
          contentZone,
          contentHost: s.contentHost,
          create: !!apiToken,
        });
        for (const zone of Object.keys(z.zones)) log(`  zone ${zone}: on the account`);
        wildcard = z.wildcard;
      } catch (e) {
        if (!(e instanceof CloudflareError)) throw e;
        if (!apiToken && (e.status === 401 || e.status === 403))
          log(
            "  warning: the wrangler login cannot read zones; wrangler deploy will report problems",
          );
        else fail(e.message);
      }
    }
    const said = {
      created: "created",
      exists: "exists, proxied",
      missing: "missing: add it (below)",
      unknown: "not checked: make sure it exists (below)",
    };
    log(`  DNS ${record.name}: ${said[wildcard]}`);
  }

  step("Settings");
  const settingsBody = `${JSON.stringify(s, null, 2)}\n`;
  if (dryRun) {
    log(`  would write ${paths.settings}:`);
    log(settingsBody.replace(/\n$/, "").replace(/^/gm, "    "));
  } else {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    writeFileSync(paths.settings, settingsBody);
    log(`  wrote ${paths.settings}`);
  }

  const w = wranglerRunner(
    {
      ...runtime,
      wrangler: { ...runtime.wrangler, cwd: dryRun ? runtime.wrangler.cwd : paths.dir },
    },
    { dryRun, env },
  );
  const configArgs = ["--config", paths.wranglerConfig];
  const result = provisionRemote(
    {
      wrangler: w,
      dbName: s.dbName,
      bucket: s.bucket,
      configTitle: "Worker config",
      configArgs,
      adminToken: s.singleUser,
      rotateSecrets: raw["rotate-secrets"] === true,
      missingKeyHint: () => `Export it and rerun: ${cmd(`deploy${selector}`)}`,
      writeConfig: (databaseId) => {
        const cfg = buildDeployConfig(s, runtime.layout, runtime.base, { databaseId, contentZone });
        const body =
          `// Generated by plinth deploy for "${s.name}". Rerunning plinth deploy rewrites this file:\n` +
          `// change settings with its flags, or add other Worker settings under "vars" in deploy.json.\n` +
          `${JSON.stringify(cfg, null, 2)}\n`;
        if (dryRun) {
          log(`  would write ${paths.wranglerConfig}:`);
          log(body.replace(/\n$/, "").replace(/^/gm, "    "));
        } else {
          writeFileSync(paths.wranglerConfig, body);
          log(`  wrote ${paths.wranglerConfig}`);
        }
        return { vars: cfg.vars };
      },
    },
    runtime,
  );

  step("Deploy");
  w.run(["deploy", ...configArgs]);

  step("Health check");
  const appOrigin = `https://${s.appHost}`;
  let healthy = null;
  if (dryRun) log(`  would GET ${appOrigin}/healthz`);
  else {
    const tries = runtime.healthTries ?? 6;
    for (let i = 0; i < tries && !healthy; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, runtime.healthDelayMs ?? 10_000));
      healthy = await remoteHealthy(s.appHost);
    }
    log(
      healthy
        ? `  ${appOrigin}/healthz: ok`
        : `  ${appOrigin}/healthz: not reachable yet. A new custom domain's certificate can take a ` +
            `few minutes; check again with ${cmd(`status --cloudflare${selector}`)}`,
    );
  }

  log(
    dryRun
      ? `\nDry run done. Plinth would run at ${appOrigin}`
      : `\nDone. Plinth runs at ${appOrigin}`,
  );
  const tail = `npx wrangler tail --config ${paths.wranglerConfig}`;
  if (s.singleUser)
    log(
      `  Sign in as ${s.adminEmail}: ` +
        (s.emailProvider === "console"
          ? `the code appears in the Worker log (${tail}).`
          : "the code arrives by email."),
    );
  else
    log(
      "  Sign in with your email address" +
        (s.adminEmail ? `; ${s.adminEmail} sees the report queue at /admin/reports.` : "."),
    );
  if (wildcard === "missing" || wildcard === "unknown")
    log(
      `\nAdd this DNS record in the ${contentZone} zone (Cloudflare dashboard > DNS > Records) so ` +
        "artifact pages reach the Worker" +
        (wildcard === "unknown" ? ", unless it is there already" : "") +
        `:\n  Type ${record.type}   Name ${record.label}   IPv4 address ${record.content}   Proxy status: Proxied\n` +
        `  (With CLOUDFLARE_API_TOKEN set, including DNS Edit, ${cmd("deploy")} adds it for you.)`,
    );
  for (const name of result.missingKeys)
    log(
      `\n${name} is not set, so sign-in email fails. Export it and rerun: ${cmd(`deploy${selector}`)}`,
    );
  const notes = deployNotes(s, deps);
  if (notes.length) log(`\n${notes.map((n) => `- ${n}`).join("\n")}`);
  if (result.adminToken && !dryRun) {
    log("\nSingle-user ADMIN_TOKEN (shown once; store it in a password manager):");
    log(`  ${result.adminToken}`);
  }
  return {
    settings: s,
    paths,
    healthy,
    instance: {
      name: s.name,
      mode: "cloudflare",
      appHost: s.appHost,
      contentHost: s.contentHost,
      appOrigin,
      singleUser: s.singleUser,
      adminEmail: s.adminEmail,
    },
  };
}
