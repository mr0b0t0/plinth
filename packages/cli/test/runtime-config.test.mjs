// Every Worker config Plinth writes carries the runtime settings this release needs: the
// enable_request_signal compatibility flag (an abandoned upload cleans up at once) and the hourly
// cron trigger (the staging sweep removes what a killed attempt left). One test per generator.
// Each also carries the live-rooms Durable Object (#36): the ROOMS binding, its rooms-v1
// migration and the room and live-editing vars, which a config may lack (rooms are then off).
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
  hasRoomsBinding,
  mergeDeploySettings,
  ROOMS_DO,
  ROOMS_MIGRATIONS,
  refreshRuntime,
  runtimeBase,
  runtimeConfigMissing,
  runtimeConfigNotes,
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

const ROOM_VARS = [
  "ALLOW_ROOMS",
  "ROOM_MAX_CONNECTIONS_PER_ARTIFACT",
  "ROOM_MAX_MESSAGE_BYTES",
  "ROOM_MESSAGES_PER_SECOND",
  "ALLOW_LIVE_EDITING",
  "LIVE_CHECKPOINT_IDLE_S",
  "LIVE_AUTO_CHECKPOINT_MIN_S",
  "LIVE_DRAFT_FLUSH_S",
  "LIVE_DRAFT_RETENTION_DAYS",
  "ALLOW_LIVE_VIEWS",
  "LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT",
  "ALLOW_SLIDES_FOLLOW",
];

/**
 * The ROOMS binding and the rooms-v1 migration are in `cfg`, and (unless `vars: false`, for a
 * refreshed config, which keeps the operator's vars) the room and live-editing vars with the
 * committed defaults.
 */
function assertRooms(cfg, where, { vars = true } = {}) {
  assert.ok(
    cfg.durable_objects?.bindings?.some(
      (b) => b.name === "ROOMS" && b.class_name === "ArtifactRoom" && !b.script_name,
    ),
    `${where}: durable_objects binds ROOMS to ArtifactRoom`,
  );
  assert.equal(hasRoomsBinding(cfg), true, `${where}: hasRoomsBinding`);
  assert.deepEqual(
    cfg.migrations?.filter((m) => m.tag === "rooms-v1"),
    [{ tag: "rooms-v1", new_sqlite_classes: ["ArtifactRoom"] }],
    `${where}: one rooms-v1 migration, a SQLite class`,
  );
  assert.deepEqual(runtimeConfigNotes(cfg), [], `${where}: no rooms note`);
  if (vars)
    for (const k of ROOM_VARS)
      assert.equal(cfg.vars?.[k], repoCfg.vars[k], `${where}: vars.${k} is the committed default`);
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
    assertRooms(repoCfg, "wrangler.jsonc");
    // The shared constants are what the committed config says.
    assert.deepEqual(repoCfg.durable_objects, ROOMS_DO);
    assert.deepEqual(repoCfg.migrations, ROOMS_MIGRATIONS);
    for (const k of ROOM_VARS) assert.ok(k in repoCfg.vars, `wrangler.jsonc vars.${k}`);
    // Dictation ships off.
    assert.equal(repoCfg.vars.ALLOW_DICTATION, "false");
    // Category sharing ships on.
    assert.equal(repoCfg.vars.ALLOW_CATEGORY_SHARING, "true");
    // The sheet formula budget ships at its documented default, and the CLI's base copies it.
    assert.equal(repoCfg.vars.SHEET_EVAL_BUDGET, "200000");
    assert.equal(runtimeBase(repoCfg).vars.SHEET_EVAL_BUDGET, "200000");
    // Files people add to a page ship off.
    assert.equal(repoCfg.vars.ALLOW_FILES, "false");
    // Page requests ship off, and the CLI's base copies the switch and its limits.
    assert.equal(repoCfg.vars.ALLOW_PAGE_REQUESTS, "false");
    assert.equal(runtimeBase(repoCfg).vars.ALLOW_PAGE_REQUESTS, "false");
    assert.equal(runtimeBase(repoCfg).vars.PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT, "25");
  });

  it("the CLI's runtime/wrangler.base.json (packages/cli/scripts/bundle.mjs)", () => {
    const base = runtimeBase(repoCfg);
    assertRuntime(base, "wrangler.base.json");
    assertRooms(base, "wrangler.base.json");
    // bundle.mjs builds the file with runtimeBase, so `triggers` is copied with the flags.
    const bundle = readFileSync(path.join(root, "packages/cli/scripts/bundle.mjs"), "utf8");
    assert.match(bundle, /runtimeBase\(repoCfg\)/);
    // ...and refuses a Worker bundle that does not export the class the binding names.
    assert.match(bundle, /export[^\n]*ArtifactRoom/);
    assert.equal(base.assets.directory, undefined);
  });

  it("the CLI's prebuilt Worker exports ArtifactRoom (when built)", (t) => {
    const built = path.join(root, "packages/cli/runtime");
    let js;
    try {
      js = readFileSync(path.join(built, "worker/index.js"), "utf8");
    } catch {
      t.skip("packages/cli/runtime is not built; `pnpm build` makes it");
      return;
    }
    assert.match(js, /\bexport\s*\{[^}]*\bArtifactRoom\b[^}]*\}/);
    assertRooms(JSON.parse(readFileSync(path.join(built, "wrangler.base.json"), "utf8")), "built");
  });

  it("plinth deploy (buildDeployConfig)", () => {
    const s = mergeDeploySettings(deployFlags, null, deps);
    const cfg = buildDeployConfig(s, layout, runtimeBase(repoCfg), {
      databaseId: "db",
      contentZone: "example-content.net",
    });
    assertRuntime(cfg, "plinth deploy");
    assertRooms(cfg, "plinth deploy");
    // A base without them (an older wrangler.base.json) still gets the binding and migration.
    const bare = { ...runtimeBase(repoCfg), durable_objects: undefined, migrations: undefined };
    const fallback = buildDeployConfig(s, layout, bare, { databaseId: "db", contentZone: "z" });
    assert.deepEqual(fallback.durable_objects, ROOMS_DO);
    assert.deepEqual(fallback.migrations, ROOMS_MIGRATIONS);
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
    assertRooms(buildWorkerConfig(o, layout, runtimeBase(repoCfg)), "tunnel");
    assertRooms(buildWorkerConfig(o, root, repoCfg), "tunnel (checkout)");
  });

  it("localhost instances (tunnel-lib buildLocalWorkerConfig)", () => {
    const o = { name: "plinth", port: 9821, adminEmail: "me@example.com" };
    assertRuntime(buildLocalWorkerConfig(o, layout, runtimeBase(repoCfg)), "local");
    assertRooms(buildLocalWorkerConfig(o, layout, runtimeBase(repoCfg)), "local");
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

  it("refreshRuntime adds the ROOMS binding and migration, keeping the operator's own", () => {
    const old = {
      name: "plinth-production",
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat", FLAG],
      triggers: { crons: [CRON] },
      vars: { APP_HOST: "plinth.example.com", ALLOW_ROOMS: "false" },
    };
    const next = refreshRuntime(old, repoCfg);
    assertRuntime(next, "refreshRuntime");
    assertRooms(next, "refreshRuntime", { vars: false });
    // The operator's vars are kept as they are: an explicit ALLOW_ROOMS=false stays off.
    assert.deepEqual(next.vars, old.vars);
    assert.deepEqual(refreshRuntime(next, repoCfg), next);

    const own = refreshRuntime(
      {
        ...old,
        durable_objects: { bindings: [{ name: "MINE", class_name: "Mine" }] },
        migrations: [{ tag: "mine-v1", new_classes: ["Mine"] }],
      },
      repoCfg,
    );
    assert.deepEqual(own.durable_objects.bindings, [
      { name: "MINE", class_name: "Mine" },
      ...ROOMS_DO.bindings,
    ]);
    assert.deepEqual(own.migrations, [
      { tag: "mine-v1", new_classes: ["Mine"] },
      ...ROOMS_MIGRATIONS,
    ]);
    // Present already (by name and by tag): never duplicated or rewritten.
    assert.deepEqual(refreshRuntime(own, repoCfg), own);
    // A repo config without them adds nothing.
    const { durable_objects: _d, migrations: _m, ...noRooms } = repoCfg;
    assert.equal("durable_objects" in refreshRuntime(old, noRooms), false);
    assert.equal("migrations" in refreshRuntime(old, noRooms), false);
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
    assertRooms(parseJsonc(readFileSync(file, "utf8")), "plinth init");
    const old = parseJsonc(readFileSync(file, "utf8"));
    old.compatibility_flags = ["nodejs_compat"];
    delete old.triggers;
    // What a release before live rooms wrote: no binding, no migration.
    delete old.durable_objects;
    delete old.migrations;
    writeFileSync(file, `// Generated by Plinth setup.\n${JSON.stringify(old, null, 2)}\n`);
    const log = console.log;
    console.log = quiet;
    try {
      assert.equal(await startInstance({ home }, runtime), 1);
    } finally {
      console.log = log;
    }
    assertRuntime(parseJsonc(readFileSync(file, "utf8")), "plinth start");
    // The operator's vars stay; the binding and migration are added.
    assertRooms(parseJsonc(readFileSync(file, "utf8")), "plinth start");
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
    const dockerCfg = parseJsonc(readFileSync(path.join(data, "plinth", "wrangler.jsonc"), "utf8"));
    assertRuntime(dockerCfg, "docker");
    assertRooms(dockerCfg, "docker");

    // PLINTH_ALLOW_ROOMS and PLINTH_ALLOW_LIVE_EDITING set the switches; the binding stays.
    const off = spawnSync(process.execPath, [path.join(app, "docker/configure.mjs")], {
      env: {
        PATH: process.env.PATH,
        PLINTH_HOME: data,
        PLINTH_EMAIL: "me@example.com",
        PLINTH_PORT: "9823",
        PLINTH_ALLOW_ROOMS: "false",
        PLINTH_ALLOW_LIVE_EDITING: "false",
        PLINTH_ALLOW_DICTATION: "true",
        PLINTH_ALLOW_CATEGORY_SHARING: "false",
        PLINTH_ALLOW_FILES: "true",
        PLINTH_ALLOW_PAGE_REQUESTS: "true",
      },
      encoding: "utf8",
    });
    assert.equal(off.status, 0, off.stderr);
    const offCfg = parseJsonc(readFileSync(path.join(data, "plinth", "wrangler.jsonc"), "utf8"));
    assert.equal(offCfg.vars.ALLOW_ROOMS, "false");
    assert.equal(offCfg.vars.ALLOW_LIVE_EDITING, "false");
    assert.equal(offCfg.vars.ALLOW_DICTATION, "true");
    assert.equal(offCfg.vars.ALLOW_CATEGORY_SHARING, "false");
    assert.equal(offCfg.vars.ALLOW_FILES, "true");
    assert.equal(offCfg.vars.ALLOW_PAGE_REQUESTS, "true");
    assertRooms(offCfg, "docker (rooms off)", { vars: false });
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
      const fresh = run();
      assertRuntime(fresh, "setup (fresh)");
      assertRooms(fresh, "setup (fresh)");
      const old = { ...repoCfg, name: "plinth-old", compatibility_flags: ["nodejs_compat"] };
      delete old.triggers;
      delete old.durable_objects;
      delete old.migrations;
      writeFileSync(file, `// old\n${JSON.stringify(old, null, 2)}\n`);
      const next = run();
      assertRuntime(next, "setup (re-run)");
      assertRooms(next, "setup (re-run)");
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

  it("a config without the ROOMS binding is not refused, only noted (rooms are off)", () => {
    const { durable_objects: _d, migrations: _m, ...noRooms } = runtimeBase(repoCfg);
    assert.deepEqual(runtimeConfigMissing(noRooms), []);
    assert.equal(runtimeConfigProblem(noRooms), null);
    assert.equal(hasRoomsBinding(noRooms), false);
    const [note, ...more] = runtimeConfigNotes(noRooms);
    assert.equal(more.length, 0);
    assert.match(note, /no ROOMS Durable Object binding/);
    assert.match(note, /rooms-v1/);
    // A binding to another Worker's class is not this Worker's room.
    const elsewhere = {
      ...noRooms,
      durable_objects: { bindings: [{ ...ROOMS_DO.bindings[0], script_name: "other" }] },
    };
    assert.equal(hasRoomsBinding(elsewhere), false);
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

// A checkout deploy runs wrangler itself, so nothing on that path runs setup's or plinth deploy's
// refusal. The Worker's `deploy:production` and `deploy:staging` scripts run `check-config` on
// their own config first and refuse a stale one; `pnpm build` only warns, so a stale per-env config
// on a developer's machine never breaks the build.
describe("checkout deploys refuse a per-environment config without them", () => {
  const checkScript = path.join(workerDir, "scripts", "check-config.mjs");
  const pkg = JSON.parse(readFileSync(path.join(workerDir, "package.json"), "utf8"));
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
  const writeOld = (dir) => {
    writeFileSync(path.join(dir, "wrangler.production.jsonc"), JSON.stringify(oldCfg, null, 2));
    writeFileSync(
      path.join(dir, "wrangler.staging.jsonc"),
      `// written by setup\n${JSON.stringify({ ...oldCfg, compatibility_flags: ["nodejs_compat", FLAG] }, null, 2)}`,
    );
  };

  it("passes the committed config and a setup-refreshed one", () => {
    const dir = workerCopy("check-ok");
    const refreshed = refreshRuntime(oldCfg, repoCfg);
    writeFileSync(path.join(dir, "wrangler.production.jsonc"), JSON.stringify(refreshed, null, 2));
    const r = runCheck(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });

  it("passes a config without the ROOMS binding, with a note on how to turn rooms on", () => {
    const dir = workerCopy("check-no-rooms");
    const { durable_objects: _d, migrations: _m, ...noRooms } = refreshRuntime(oldCfg, repoCfg);
    writeFileSync(path.join(dir, "wrangler.production.jsonc"), JSON.stringify(noRooms, null, 2));
    const r = runCheck(dir, "wrangler.production.jsonc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^check-config: note: wrangler\.production\.jsonc: [^\n]*ROOMS/);
    // The build's --warn mode stays quiet about it.
    const warn = spawnSync(process.execPath, [checkScript, "--warn", "--dir", dir], {
      encoding: "utf8",
    });
    assert.equal(warn.status, 0);
    assert.equal(warn.stderr, "");
  });

  it("refuses every wrangler.<env>.jsonc that setup wrote before 0.4.0, naming the file", () => {
    const dir = workerCopy("check-old");
    writeOld(dir);
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

  it("--warn prints one line per stale config and never fails", () => {
    const dir = workerCopy("check-warn");
    writeOld(dir);
    writeFileSync(path.join(dir, "wrangler.broken.jsonc"), "{ not json");
    const r = spawnSync(process.execPath, [checkScript, "--warn", "--dir", dir], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 3, r.stderr);
    assert.match(lines[0], /^check-config: warning: wrangler\.broken\.jsonc: not valid JSONC/);
    assert.match(
      lines[1],
      /^check-config: warning: wrangler\.production\.jsonc: [^\n]*enable_request_signal/,
    );
    assert.match(lines[1], /0 \* \* \* \*/);
    assert.match(lines[2], /^check-config: warning: wrangler\.staging\.jsonc: [^\n]*0 \* \* \* \*/);
    assert.doesNotMatch(lines[2], /enable_request_signal/);
    for (const l of lines.slice(1)) assert.match(l, /deploy:/);
    // Nothing stale: nothing printed.
    const ok = spawnSync(
      process.execPath,
      [checkScript, "--warn", "--dir", workerCopy("check-warn-ok")],
      {
        encoding: "utf8",
      },
    );
    assert.equal(ok.status, 0);
    assert.equal(ok.stderr, "");
  });

  it("the Worker's build only warns, and turbo hashes the git-ignored per-env configs it warns about", () => {
    assert.match(pkg.scripts.build, /^node scripts\/check-config\.mjs --warn && /);
    assert.equal(pkg.scripts["check-config"], "node scripts/check-config.mjs");
    // $TURBO_DEFAULT$ leaves out git-ignored files, so without the explicit input a cache hit
    // replays the old warning after the config was fixed.
    const hash = () => {
      const r = spawnSync(
        path.join(root, "node_modules", ".bin", "turbo"),
        ["run", "build", "--filter=@plinth/worker", "--dry=json"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).tasks.find((t) => t.taskId === "@plinth/worker#build").hash;
    };
    const probe = path.join(workerDir, `wrangler.turbo-probe-${process.pid}.jsonc`);
    try {
      writeFileSync(probe, '{ "compatibility_flags": [] }\n');
      const stale = hash();
      writeFileSync(probe, '{ "compatibility_flags": ["enable_request_signal"] }\n');
      assert.notEqual(hash(), stale, "a fixed per-env config misses the build cache");
    } finally {
      rmSync(probe, { force: true });
    }
  });

  // The deploy scripts as package.json has them, run by a shell in a copy of apps/worker with a
  // stand-in `wrangler` first on PATH that records its arguments.
  const runDeploy = (name, env, cfg) => {
    const dir = path.join(tmp, name);
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    cpSync(path.join(workerDir, "scripts"), path.join(dir, "worker", "scripts"), {
      recursive: true,
    });
    cpSync(path.join(workerDir, "wrangler.jsonc"), path.join(dir, "worker", "wrangler.jsonc"));
    if (cfg)
      writeFileSync(
        path.join(dir, "worker", `wrangler.${env}.jsonc`),
        `// written by setup\n${JSON.stringify(cfg, null, 2)}\n`,
      );
    const record = path.join(dir, "wrangler-args.json");
    const bin = path.join(dir, "bin", "wrangler");
    writeFileSync(
      bin,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
      { mode: 0o755 },
    );
    const r = spawnSync("/bin/sh", ["-c", pkg.scripts[`deploy:${env}`]], {
      cwd: path.join(dir, "worker"),
      env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}` },
      encoding: "utf8",
    });
    let args = null;
    try {
      args = JSON.parse(readFileSync(record, "utf8"));
    } catch {}
    return { ...r, args };
  };

  for (const env of ["production", "staging"]) {
    it(`deploy:${env} checks wrangler.${env}.jsonc, then deploys with it`, () => {
      assert.equal(
        pkg.scripts[`deploy:${env}`],
        `node scripts/check-config.mjs wrangler.${env}.jsonc && wrangler deploy --config wrangler.${env}.jsonc`,
      );
      const ok = runDeploy(`deploy-ok-${env}`, env, refreshRuntime(oldCfg, repoCfg));
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(ok.args, ["deploy", "--config", `wrangler.${env}.jsonc`]);
    });

    it(`deploy:${env} refuses a stale or missing wrangler.${env}.jsonc before wrangler runs`, () => {
      const old = runDeploy(`deploy-old-${env}`, env, oldCfg);
      assert.equal(old.status, 1);
      assert.equal(old.args, null, "wrangler never ran");
      assert.match(
        old.stderr,
        new RegExp(`wrangler\\.${env}\\.jsonc: [^\\n]*enable_request_signal`),
      );
      const missing = runDeploy(`deploy-missing-${env}`, env, null);
      assert.equal(missing.status, 1);
      assert.equal(missing.args, null);
      assert.match(missing.stderr, /no such file/);
    });
  }

  it("the documented deploys use the deploy scripts, checked before the migrations", () => {
    const blocks = {
      "self-hosting.md": readFileSync(path.join(root, "docs", "self-hosting.md"), "utf8")
        .split("To update later:")[1]
        .split("```")[1],
      "production.md": readFileSync(path.join(root, "docs", "production.md"), "utf8")
        .split("## Redeploy")[1]
        .split("```")[1],
      "deploy-checklist.md": readFileSync(path.join(root, "docs", "deploy-checklist.md"), "utf8")
        .split("## 6. Upgrading and rolling back")[1]
        .split("```")[1],
    };
    for (const [doc, block] of Object.entries(blocks)) {
      const deploy = block.indexOf("deploy:production");
      assert.ok(deploy > 0, `${doc} deploys with deploy:production`);
      assert.doesNotMatch(block, /exec wrangler deploy/, `${doc} has no bare wrangler deploy`);
      // One command list joined with &&, so a failing check-config stops everything after it
      // when the block is pasted into a shell (separate lines would still run the migrations).
      const commands = block
        .replace(/^sh\n/, "")
        .trim()
        .split(/(?<!\\)\n/);
      assert.equal(commands.length, 1, `${doc}: the commands are joined with && (\\ continues)`);
      assert.doesNotMatch(commands[0], /;|\|\|/, `${doc}: only && between the commands`);
      const migrate = block.indexOf("migrations apply");
      if (migrate >= 0) {
        const check = block.indexOf("check-config");
        assert.ok(check >= 0 && check < migrate, `${doc} checks the config before migrating`);
        assert.ok(migrate < deploy, `${doc} migrates before the deploy`);
      }
    }
    const staging = readFileSync(path.join(root, "docs", "staging.md"), "utf8")
      .split("## Deploy steps")[1]
      .split("```")[1];
    assert.match(staging, /deploy:staging/);
    assert.doesNotMatch(staging, /exec wrangler deploy/);
  });
});
