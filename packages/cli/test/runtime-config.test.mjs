// Every Worker config Plinth writes carries the runtime settings this release needs: the
// enable_request_signal compatibility flag (an abandoned upload cleans up at once) and the hourly
// cron trigger (the staging sweep removes what a killed attempt left). One test per generator.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { deployToCloudflare } from "../../../apps/worker/scripts/deploy.mjs";
import {
  buildDeployConfig,
  mergeDeploySettings,
  refreshRuntime,
  runtimeBase,
  runtimeConfigProblem,
} from "../../../apps/worker/scripts/deploy-lib.mjs";
import {
  parseJsonc,
  setupInstance,
  startInstance,
} from "../../../apps/worker/scripts/instance.mjs";
import {
  buildLocalWorkerConfig,
  buildWorkerConfig,
  validateTunnelOptions,
} from "../../../apps/worker/scripts/tunnel-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workerDir = path.join(root, "apps", "worker");
const repoCfg = parseJsonc(readFileSync(path.join(workerDir, "wrangler.jsonc"), "utf8"));
const FLAG = "enable_request_signal";
const CRON = "0 * * * *";

const tmp = mkdtempSync(path.join(tmpdir(), "plinth-runtime-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Both runtime settings are in `cfg`. */
function assertRuntime(cfg, where) {
  assert.ok(cfg.compatibility_flags?.includes(FLAG), `${where}: compatibility_flags has ${FLAG}`);
  assert.ok(cfg.compatibility_flags?.includes("nodejs_compat"), `${where}: nodejs_compat`);
  assert.ok(cfg.triggers?.crons?.includes(CRON), `${where}: triggers.crons has ${CRON}`);
  assert.equal(runtimeConfigProblem(cfg), null, `${where}: runtimeConfigProblem`);
}

const layout = {
  main: "/rt/worker/index.js",
  assetsDir: "/rt/web",
  migrationsDir: "/rt/migrations",
};
const deps = {
  getDomain: (h) => h.split(".").slice(-2).join("."),
  getZone: (h) => h.split(".").slice(-2).join("."),
};
const deployFlags = {
  "app-host": "plinth.example.com",
  "content-host": "example-content.net",
  "email-provider": "resend",
};

// A stand-in for wrangler: every command succeeds, and `dev` exits at once.
const fake = path.join(tmp, "fake-wrangler.mjs");
writeFileSync(fake, "process.exit(process.argv.includes('dev') ? 3 : 0);\n");
const quiet = () => {};

describe("generated Worker configs carry the flag and the cron", () => {
  it("apps/worker/wrangler.jsonc (local dev and the Workers test pool)", () => {
    assertRuntime(repoCfg, "wrangler.jsonc");
  });

  it("the CLI's runtime/wrangler.base.json (packages/cli/scripts/bundle.mjs)", () => {
    const base = runtimeBase(repoCfg);
    assertRuntime(base, "wrangler.base.json");
    // bundle.mjs builds the file with runtimeBase, so `triggers` is copied with the flags.
    const bundle = readFileSync(path.join(root, "packages/cli/scripts/bundle.mjs"), "utf8");
    assert.match(bundle, /runtimeBase\(repoCfg\)/);
    assert.equal(base.assets.directory, undefined);
  });

  it("plinth deploy (buildDeployConfig)", () => {
    const s = mergeDeploySettings(deployFlags, null, deps);
    const cfg = buildDeployConfig(s, layout, runtimeBase(repoCfg), {
      databaseId: "db",
      contentZone: "example-content.net",
    });
    assertRuntime(cfg, "plinth deploy");
  });

  it("tunnel instances (tunnel-lib buildWorkerConfig)", () => {
    const o = validateTunnelOptions(
      {
        "app-host": "plinth.example.com",
        "content-host": "example-content.net",
        "email-provider": "resend",
      },
      { getDomain: deps.getDomain },
    );
    assertRuntime(buildWorkerConfig(o, layout, runtimeBase(repoCfg)), "tunnel");
    assertRuntime(buildWorkerConfig(o, root, repoCfg), "tunnel (checkout)");
  });

  it("localhost instances (tunnel-lib buildLocalWorkerConfig)", () => {
    const o = { name: "plinth", port: 9821, adminEmail: "me@example.com" };
    assertRuntime(buildLocalWorkerConfig(o, layout, runtimeBase(repoCfg)), "local");
  });

  it("refreshRuntime carries triggers into an existing config, keeping the operator's own", () => {
    const old = {
      name: "plinth-production",
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { APP_HOST: "plinth.example.com" },
    };
    const next = refreshRuntime(old, repoCfg);
    assertRuntime(next, "refreshRuntime");
    assert.deepEqual(next.vars, old.vars);
    const own = refreshRuntime({ ...old, triggers: { crons: ["*/5 * * * *"] } }, repoCfg);
    assert.deepEqual(own.triggers.crons, ["*/5 * * * *", CRON]);
    // Already current: nothing changes.
    assert.deepEqual(refreshRuntime(next, repoCfg), next);
  });

  it("plinth init and plinth start (an instance an older release wrote is refreshed)", async () => {
    const home = path.join(tmp, "start");
    const runtime = {
      label: "test",
      layout,
      base: runtimeBase(repoCfg),
      wrangler: { command: process.execPath, args: [fake], cwd: tmp },
      startCommand: () => "plinth start",
      log: quiet,
    };
    await setupInstance({ email: "me@example.com", home, port: "9822" }, runtime);
    const file = path.join(home, "plinth", "wrangler.jsonc");
    assertRuntime(parseJsonc(readFileSync(file, "utf8")), "plinth init");
    const old = parseJsonc(readFileSync(file, "utf8"));
    old.compatibility_flags = ["nodejs_compat"];
    delete old.triggers;
    writeFileSync(file, `// Generated by Plinth setup.\n${JSON.stringify(old, null, 2)}\n`);
    const log = console.log;
    console.log = quiet;
    try {
      assert.equal(await startInstance({ home }, runtime), 1);
    } finally {
      console.log = log;
    }
    assertRuntime(parseJsonc(readFileSync(file, "utf8")), "plinth start");
  });

  it("docker/configure.mjs keeps them when it writes the container's settings", () => {
    // The image's layout: /app/docker/configure.mjs, /app/bin/plinth.mjs, /app/runtime/.
    const app = path.join(tmp, "app");
    mkdirSync(path.join(app, "docker"), { recursive: true });
    mkdirSync(path.join(app, "bin"), { recursive: true });
    mkdirSync(path.join(app, "runtime", "scripts"), { recursive: true });
    cpSync(path.join(root, "docker/configure.mjs"), path.join(app, "docker/configure.mjs"));
    for (const f of [
      "instance.mjs",
      "tunnel-lib.mjs",
      "tunnel-cloudflare.mjs",
      "deploy.mjs",
      "deploy-lib.mjs",
    ])
      cpSync(path.join(workerDir, "scripts", f), path.join(app, "runtime", "scripts", f));
    writeFileSync(
      path.join(app, "runtime", "wrangler.base.json"),
      `${JSON.stringify(runtimeBase(repoCfg), null, 2)}\n`,
    );
    // `plinth init` as the CLI runs it: setupInstance with the bundled base.
    writeFileSync(
      path.join(app, "bin", "plinth.mjs"),
      `import { readFileSync } from "node:fs";
import path from "node:path";
import { setupInstance } from "../runtime/scripts/instance.mjs";
const argv = process.argv.slice(3);
const raw = {};
for (let i = 0; i < argv.length; i += 2) raw[argv[i].slice(2)] = argv[i + 1];
const rt = path.resolve(import.meta.dirname, "../runtime");
await setupInstance(raw, {
  label: "plinth",
  layout: { main: rt + "/worker/index.js", assetsDir: rt + "/web", migrationsDir: rt + "/migrations" },
  base: JSON.parse(readFileSync(rt + "/wrangler.base.json", "utf8")),
  wrangler: { command: process.execPath, args: [${JSON.stringify(fake)}], cwd: rt },
  startCommand: () => "plinth start",
  log: () => {},
});
`,
    );
    const data = path.join(tmp, "data");
    mkdirSync(data);
    const r = spawnSync(process.execPath, [path.join(app, "docker/configure.mjs")], {
      env: {
        PATH: process.env.PATH,
        PLINTH_HOME: data,
        PLINTH_EMAIL: "me@example.com",
        PLINTH_PORT: "9823",
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^start$/m);
    assertRuntime(
      parseJsonc(readFileSync(path.join(data, "plinth", "wrangler.jsonc"), "utf8")),
      "docker",
    );
  });

  it("scripts/setup.mjs --remote, fresh and re-run on a config written before both", () => {
    const env = `gentest${process.pid}`;
    const file = path.join(workerDir, `wrangler.${env}.jsonc`);
    const run = () => {
      const r = spawnSync(
        process.execPath,
        [
          path.join(root, "scripts/setup.mjs"),
          "--remote",
          "--env",
          env,
          "--app-host",
          "plinth.example.com",
          "--content-host",
          "example-content.net",
          "--email-provider",
          "resend",
          "--dry-run",
        ],
        { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
      );
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.split("\n");
      const at = lines.findIndex((l) => /would (create|update) .*wrangler\./.test(l));
      assert.ok(at >= 0, r.stdout);
      const body = [];
      for (const l of lines.slice(at + 1)) {
        if (!l.startsWith("    ")) break;
        body.push(l.slice(4));
      }
      return parseJsonc(body.join("\n"));
    };
    try {
      assertRuntime(run(), "setup (fresh)");
      const old = { ...repoCfg, name: "plinth-old", compatibility_flags: ["nodejs_compat"] };
      delete old.triggers;
      writeFileSync(file, `// old\n${JSON.stringify(old, null, 2)}\n`);
      const next = run();
      assertRuntime(next, "setup (re-run)");
      assert.equal(next.name, "plinth-old");
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("deploys refuse a config without them", () => {
  it("runtimeConfigProblem names what is missing and how to fix it", () => {
    const full = runtimeBase(repoCfg);
    assert.equal(runtimeConfigProblem(full), null);
    const noFlag = { ...full, compatibility_flags: ["nodejs_compat"] };
    assert.match(runtimeConfigProblem(noFlag), /enable_request_signal/);
    const noCron = { ...full, triggers: undefined };
    assert.match(runtimeConfigProblem(noCron), /0 \* \* \* \*/);
    assert.match(runtimeConfigProblem({ ...full, triggers: { crons: [] } }), /triggers/);
    assert.match(runtimeConfigProblem({}), /enable_request_signal[\s\S]*0 \* \* \* \*/);
  });

  it("plinth deploy stops before touching the account when the bundled base lacks the cron", async () => {
    const base = { ...runtimeBase(repoCfg), triggers: { crons: [] } };
    const calls = [];
    await assert.rejects(
      deployToCloudflare(
        { ...deployFlags, home: path.join(tmp, "deploy"), "dry-run": true },
        {
          layout,
          base,
          getDomain: deps.getDomain,
          getZone: deps.getZone,
          wrangler: { command: process.execPath, args: [fake], cwd: tmp },
          log: (m) => calls.push(m),
        },
      ),
      /0 \* \* \* \*/,
    );
    assert.ok(!calls.some((m) => /> Cloudflare account/.test(m)));
  });
});

// A checkout deploy runs `wrangler deploy --config wrangler.<env>.jsonc` itself, so nothing on that
// path runs setup's or plinth deploy's refusal. The Worker's build (which the documented update
// runs before migrations and the deploy) and `check-config` refuse such a config.
describe("checkout deploys refuse a per-environment config without them", () => {
  const checkScript = path.join(workerDir, "scripts", "check-config.mjs");
  const oldCfg = { ...runtimeBase(repoCfg), name: "plinth", triggers: undefined };
  oldCfg.compatibility_flags = ["nodejs_compat"];
  const runCheck = (dir, ...files) =>
    spawnSync(process.execPath, [checkScript, "--dir", dir, ...files], { encoding: "utf8" });
  const workerCopy = (name) => {
    const dir = path.join(tmp, name);
    mkdirSync(dir, { recursive: true });
    cpSync(path.join(workerDir, "wrangler.jsonc"), path.join(dir, "wrangler.jsonc"));
    return dir;
  };

  it("passes the committed config and a setup-refreshed one", () => {
    const dir = workerCopy("check-ok");
    const refreshed = refreshRuntime(oldCfg, repoCfg);
    writeFileSync(path.join(dir, "wrangler.production.jsonc"), JSON.stringify(refreshed, null, 2));
    const r = runCheck(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  it("refuses every wrangler.<env>.jsonc that setup wrote before 0.4.0, naming the file", () => {
    const dir = workerCopy("check-old");
    writeFileSync(path.join(dir, "wrangler.production.jsonc"), JSON.stringify(oldCfg, null, 2));
    writeFileSync(
      path.join(dir, "wrangler.staging.jsonc"),
      `// written by setup\n${JSON.stringify({ ...oldCfg, compatibility_flags: ["nodejs_compat", FLAG] }, null, 2)}`,
    );
    const r = runCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /wrangler\.production\.jsonc: [^\n]*enable_request_signal/);
    assert.match(r.stderr, /wrangler\.staging\.jsonc: [^\n]*0 \* \* \* \*/);
    assert.match(r.stderr, /scripts\/setup\.mjs --remote/);
    // Naming one file checks only that one.
    assert.equal(runCheck(dir, "wrangler.jsonc").status, 0);
    assert.equal(runCheck(dir, "wrangler.production.jsonc").status, 1);
    assert.equal(runCheck(dir, "wrangler.missing.jsonc").status, 1);
  });

  it("the Worker's build runs the check first, and turbo rebuilds when a per-env config changes", () => {
    const pkg = JSON.parse(readFileSync(path.join(workerDir, "package.json"), "utf8"));
    assert.match(pkg.scripts.build, /^node scripts\/check-config\.mjs && /);
    assert.equal(pkg.scripts["check-config"], "node scripts/check-config.mjs");
    const turbo = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8"));
    assert.ok(turbo.tasks["@plinth/worker#build"].inputs.includes("wrangler.*.jsonc"));
  });

  it("the documented checkout update runs the check before migrations and the deploy", () => {
    const doc = readFileSync(path.join(root, "docs", "self-hosting.md"), "utf8");
    const block = doc.split("To update later:")[1].split("```")[1];
    const check = block.indexOf("check-config");
    assert.ok(check > 0, "the update block runs check-config");
    assert.ok(check < block.indexOf("migrations apply"));
    assert.ok(check < block.indexOf("wrangler deploy"));
  });
});
