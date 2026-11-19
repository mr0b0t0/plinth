import { getDomain as tldtsGetDomain } from "tldts";
import { describe, expect, it } from "vitest";
import {
  buildDeployConfig,
  CloudflareError,
  checkZones,
  DeployUsageError,
  deployNotes,
  deployPaths,
  hostPairProblem,
  mergeDeploySettings,
  pickAccount,
  ROOMS_DO,
  ROOMS_MIGRATIONS,
  refreshRuntime,
  resourceNames,
  runtimeBase,
  runtimeConfigMissing,
  runtimeConfigNotes,
  wildcardRecord,
} from "../scripts/deploy-lib.mjs";

const deps = {
  getDomain: (h: string) => tldtsGetDomain(h, { allowPrivateDomains: true }),
  getZone: (h: string) => tldtsGetDomain(h),
};
const first = {
  "app-host": "plinth.example.com",
  "content-host": "example-content.net",
  "email-provider": "resend",
  "admin-email": "You@Example.com",
};
const layout = {
  main: "/rt/worker/index.js",
  assetsDir: "/rt/web",
  migrationsDir: "/rt/migrations",
};
const base = {
  compatibility_date: "2026-11-01",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    binding: "ASSETS",
    run_worker_first: true,
    not_found_handling: "single-page-application",
  },
  vars: { MAX_ARTIFACTS_PER_USER: "100", CDN_ALLOWLIST: "" },
};

describe("deploy-lib: mergeDeploySettings", () => {
  it("fills defaults on a first deploy", () => {
    expect(mergeDeploySettings(first, null, deps)).toEqual({
      version: 1,
      name: "plinth",
      workerName: "plinth",
      dbName: "plinth",
      bucket: "plinth-files",
      appHost: "plinth.example.com",
      contentHost: "example-content.net",
      emailProvider: "resend",
      emailFrom: null,
      adminEmail: "you@example.com",
      singleUser: false,
      isolation: "origin",
      operator: { name: null, email: null, address: null, registration: null },
      vars: {},
    });
  });

  it("names resources after the instance", () => {
    expect(resourceNames("work")).toEqual({
      workerName: "plinth-work",
      dbName: "plinth-work",
      bucket: "plinth-work-files",
    });
    expect(resourceNames("plinth-staging").workerName).toBe("plinth-staging");
    expect(mergeDeploySettings({ ...first, name: "work" }, null, deps).bucket).toBe(
      "plinth-work-files",
    );
  });

  it("needs hosts and a provider on the first deploy, and names the missing flags", () => {
    expect(() => mergeDeploySettings({}, null, deps)).toThrow(DeployUsageError);
    expect(() => mergeDeploySettings({ "app-host": "plinth.example.com" }, null, deps)).toThrow(
      /first deploy needs --content-host, --email-provider/,
    );
  });

  it("redeploys the saved settings when no flags are given", () => {
    const saved = mergeDeploySettings(first, null, deps);
    expect(mergeDeploySettings({}, saved, deps)).toEqual(saved);
  });

  it("lets flags on a rerun update the saved settings, keeping the rest", () => {
    const saved = mergeDeploySettings(first, null, deps);
    const s = mergeDeploySettings(
      { "operator-name": "Example Lda.", "operator-email": "Hello@Example.com" },
      saved,
      deps,
    );
    expect(s.operator).toEqual({
      name: "Example Lda.",
      email: "hello@example.com",
      address: null,
      registration: null,
    });
    expect(s.appHost).toBe("plinth.example.com");
    expect(s.adminEmail).toBe("you@example.com");
  });

  it("keeps resource names from the saved settings", () => {
    const saved = { ...mergeDeploySettings(first, null, deps), dbName: "older-db" };
    expect(mergeDeploySettings({}, saved, deps).dbName).toBe("older-db");
  });

  it("clears an optional setting with an empty value", () => {
    const saved = mergeDeploySettings(
      { ...first, "email-from": "Me <me@example.com>" },
      null,
      deps,
    );
    expect(saved.emailFrom).toBe("Me <me@example.com>");
    const s = mergeDeploySettings({ "email-from": "", "admin-email": "" }, saved, deps);
    expect(s.emailFrom).toBeNull();
    expect(s.adminEmail).toBeNull();
  });

  it("refuses to clear a required setting", () => {
    const saved = mergeDeploySettings(first, null, deps);
    expect(() => mergeDeploySettings({ "app-host": "" }, saved, deps)).toThrow(/host name/);
  });

  it("switches between single-user and multi-user", () => {
    const one = mergeDeploySettings({ ...first, "single-user": true }, null, deps);
    expect(one.singleUser).toBe(true);
    expect(mergeDeploySettings({ "multi-user": true }, one, deps).singleUser).toBe(false);
    expect(() =>
      mergeDeploySettings({ ...first, "single-user": true, "multi-user": true }, null, deps),
    ).toThrow(/not both/);
  });

  it("needs an admin email for single-user mode", () => {
    const { "admin-email": _, ...noAdmin } = first;
    expect(() => mergeDeploySettings({ ...noAdmin, "single-user": true }, null, deps)).toThrow(
      /--single-user needs --admin-email/,
    );
  });

  it("allows the console provider only in single-user mode", () => {
    const consoleFirst = { ...first, "email-provider": "console" };
    expect(() => mergeDeploySettings(consoleFirst, null, deps)).toThrow(/--single-user/);
    expect(
      mergeDeploySettings({ ...consoleFirst, "single-user": true }, null, deps).emailProvider,
    ).toBe("console");
  });

  it("checks flag values", () => {
    expect(() => mergeDeploySettings({ ...first, "app-host": "not a host" }, null, deps)).toThrow(
      /host name/,
    );
    expect(() => mergeDeploySettings({ ...first, "email-provider": "smtp" }, null, deps)).toThrow(
      /sendgrid, resend or console/,
    );
    expect(() => mergeDeploySettings({ ...first, "admin-email": "nope" }, null, deps)).toThrow(
      /not an email/,
    );
    expect(() =>
      mergeDeploySettings({ ...first, "content-isolation": "none" }, null, deps),
    ).toThrow(/origin or opaque/);
    expect(() => mergeDeploySettings({ ...first, name: "Bad Name" }, null, deps)).toThrow(/--name/);
    expect(() => mergeDeploySettings({ ...first, "email-from": true }, null, deps)).toThrow(
      /needs a value/,
    );
  });

  it("refuses hosts that share a registrable domain unless isolation is opaque", () => {
    const same = { ...first, "content-host": "usercontent.example.com" };
    expect(() => mergeDeploySettings(same, null, deps)).toThrow(/share a registrable domain/);
    expect(
      mergeDeploySettings({ ...same, "content-isolation": "opaque" }, null, deps).isolation,
    ).toBe("opaque");
  });

  it("refuses equal or nested hosts in every isolation mode", () => {
    for (const contentHost of ["plinth.example.com", "c.plinth.example.com", "example.com"])
      expect(() =>
        mergeDeploySettings(
          { ...first, "content-host": contentHost, "content-isolation": "opaque" },
          null,
          deps,
        ),
      ).toThrow(/must differ/);
  });

  it("needs the operator name and email together", () => {
    expect(() => mergeDeploySettings({ ...first, "operator-name": "Me" }, null, deps)).toThrow(
      /go together/,
    );
    expect(() =>
      mergeDeploySettings({ ...first, "operator-address": "Rua 1, Lisboa" }, null, deps),
    ).toThrow(/need --operator-name/);
  });

  it("refuses overriding an owned variable under vars", () => {
    const saved = { ...mergeDeploySettings(first, null, deps), vars: { APP_HOST: "x.example" } };
    expect(() => mergeDeploySettings({}, saved, deps)).toThrow(/APP_HOST is set by plinth deploy/);
  });
});

describe("deploy-lib: hostPairProblem", () => {
  const reg = (h: string) => deps.getDomain(h) ?? h;
  it("allows separate registrable domains", () => {
    expect(hostPairProblem("plinth.example.com", "example-content.net", "origin", reg)).toBeNull();
  });
  it("allows a shared registrable domain only with opaque isolation", () => {
    expect(hostPairProblem("a.example.com", "b.example.com", "origin", reg)).toMatch(/share/);
    expect(hostPairProblem("a.example.com", "b.example.com", "opaque", reg)).toBeNull();
  });
});

describe("deploy-lib: buildDeployConfig", () => {
  it("points at the installed runtime and sets every production setting", () => {
    const s = mergeDeploySettings(
      {
        ...first,
        "operator-name": "Example Lda.",
        "operator-email": "hello@example.com",
        "operator-registration": "VAT PT000000000",
      },
      null,
      deps,
    );
    const cfg = buildDeployConfig(s, layout, base, {
      databaseId: "db-1",
      contentZone: "example-content.net",
    });
    expect(cfg).toMatchObject({
      name: "plinth",
      main: "/rt/worker/index.js",
      compatibility_date: "2026-11-01",
      workers_dev: false,
      preview_urls: false,
      assets: { binding: "ASSETS", directory: "/rt/web", run_worker_first: true },
      d1_databases: [
        {
          binding: "DB",
          database_name: "plinth",
          database_id: "db-1",
          migrations_dir: "/rt/migrations",
        },
      ],
      r2_buckets: [{ binding: "FILES", bucket_name: "plinth-files" }],
      routes: [
        { pattern: "plinth.example.com", custom_domain: true },
        { pattern: "*.example-content.net/*", zone_name: "example-content.net" },
      ],
    });
    expect(cfg.vars).toEqual({
      MAX_ARTIFACTS_PER_USER: "100",
      CDN_ALLOWLIST: "",
      ENVIRONMENT: "production",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "example-content.net",
      CONTENT_ISOLATION: "origin",
      PUBLIC_SCHEME: "https",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "Plinth <noreply@plinth.example.com>",
      SINGLE_USER_MODE: "false",
      ADMIN_EMAIL: "you@example.com",
      OPERATOR_NAME: "Example Lda.",
      OPERATOR_EMAIL: "hello@example.com",
      OPERATOR_ADDRESS: "",
      OPERATOR_REGISTRATION: "VAT PT000000000",
      STAGING_CONTENT_FALLBACK: "false",
      DEV_OUTBOX: "false",
      DEV_IGNORE_CLIENT_IP: "false",
      DEV_SEED: "false",
    });
  });

  it("adds extra vars from the settings without letting them win over owned ones", () => {
    const s = {
      ...mergeDeploySettings(first, null, deps),
      vars: { MAX_ARTIFACTS_PER_USER: "500", ALLOW_PUBLIC_VISIBILITY: "true" },
    };
    const cfg = buildDeployConfig(s, layout, base, { databaseId: "d", contentZone: "z" });
    expect(cfg.vars.MAX_ARTIFACTS_PER_USER).toBe("500");
    expect(cfg.vars.ALLOW_PUBLIC_VISIBILITY).toBe("true");
    expect(cfg.vars.ENVIRONMENT).toBe("production");
  });

  it("binds the live-rooms Durable Object with its migration, from the base or the constants", () => {
    const s = mergeDeploySettings(first, null, deps);
    const cfg = buildDeployConfig(s, layout, base, { databaseId: "d", contentZone: "z" });
    expect(cfg.durable_objects).toEqual({
      bindings: [{ name: "ROOMS", class_name: "ArtifactRoom" }],
    });
    expect(cfg.migrations).toEqual([{ tag: "rooms-v1", new_sqlite_classes: ["ArtifactRoom"] }]);
    const own = {
      ...base,
      durable_objects: { bindings: [...ROOMS_DO.bindings, { name: "X", class_name: "X" }] },
      migrations: [...ROOMS_MIGRATIONS, { tag: "x-v1", new_sqlite_classes: ["X"] }],
    };
    const withOwn = buildDeployConfig(s, layout, own, { databaseId: "d", contentZone: "z" });
    expect(withOwn.durable_objects).toEqual(own.durable_objects);
    expect(withOwn.migrations).toEqual(own.migrations);
    // An operator's ALLOW_ROOMS=false under deploy.json "vars" turns rooms off, binding or not.
    const off = buildDeployConfig(
      { ...s, vars: { ALLOW_ROOMS: "false", ALLOW_LIVE_EDITING: "false" } },
      layout,
      base,
      { databaseId: "d", contentZone: "z" },
    );
    expect(off.vars).toMatchObject({ ALLOW_ROOMS: "false", ALLOW_LIVE_EDITING: "false" });
  });

  it("keeps the explicit sender address", () => {
    const s = mergeDeploySettings({ ...first, "email-from": "Me <me@example.com>" }, null, deps);
    const cfg = buildDeployConfig(s, layout, base, { databaseId: "d", contentZone: "z" });
    expect(cfg.vars.EMAIL_FROM).toBe("Me <me@example.com>");
  });
});

describe("deploy-lib: paths, accounts, records and notes", () => {
  it("keeps a deployment under <home>/<name>/cloudflare", () => {
    expect(deployPaths("/h/.plinth/", "plinth")).toEqual({
      dir: "/h/.plinth/plinth/cloudflare",
      wranglerConfig: "/h/.plinth/plinth/cloudflare/wrangler.jsonc",
      settings: "/h/.plinth/plinth/cloudflare/deploy.json",
    });
  });

  it("picks the only account, or the one CLOUDFLARE_ACCOUNT_ID names", () => {
    const one = { accounts: [{ id: "a1", name: "Mine" }] };
    expect(pickAccount(one)).toEqual({ id: "a1", name: "Mine" });
    const two = { accounts: [...one.accounts, { id: "a2", name: "Work" }] };
    expect(pickAccount(two, "a2")).toEqual({ id: "a2", name: "Work" });
    expect(() => pickAccount(two)).toThrow(/export CLOUDFLARE_ACCOUNT_ID=a2 {3}# Work/);
    expect(() => pickAccount(two, "a3")).toThrow(/not one of your accounts/);
    expect(() => pickAccount({ accounts: [] })).toThrow(/no Cloudflare account/);
  });

  it("describes the wildcard record for an apex and for a subdomain", () => {
    expect(wildcardRecord("example-content.net", "example-content.net")).toEqual({
      type: "A",
      name: "*.example-content.net",
      label: "*",
      content: "192.0.2.0",
      proxied: true,
    });
    expect(wildcardRecord("content.example.net", "example.net").label).toBe("*.content");
  });

  it("notes the legal pages, the PSL and a subdomain's certificate", () => {
    const s = mergeDeploySettings(first, null, deps);
    const notes = deployNotes(s, deps).join("\n");
    expect(notes).toMatch(/--operator-name/);
    expect(notes).toMatch(/submit example-content\.net/);
    const sub = mergeDeploySettings(
      {
        ...first,
        "content-host": "content.example.net",
        "operator-name": "Me",
        "operator-email": "me@example.com",
      },
      null,
      deps,
    );
    const subNotes = deployNotes(sub, deps).join("\n");
    expect(subNotes).toMatch(/Advanced Certificate for \*\.content\.example\.net/);
    expect(subNotes).not.toMatch(/--operator-name/);
  });
});

type Rec = { id: string; type: string; name: string; content: string; proxied: boolean };

/** A fake Cloudflare API for zones and DNS records. Records every call. */
function fakeCloudflare(state: {
  zones: { [name: string]: { id: string; account: string } };
  records: Rec[];
  dnsStatus?: number;
}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: url.pathname + url.search, body });
    const p = url.pathname.replace("/client/v4", "");
    if (method === "GET" && p === "/zones") {
      const name = url.searchParams.get("name") ?? "";
      const z = state.zones[name];
      return ok(z && z.account === url.searchParams.get("account.id") ? [{ id: z.id, name }] : []);
    }
    if (p.endsWith("/dns_records")) {
      if (state.dnsStatus)
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
          { status: state.dnsStatus },
        );
      if (method === "GET")
        return ok(state.records.filter((r) => r.name === url.searchParams.get("name")));
      state.records.push({ id: `r${state.records.length + 1}`, ...body });
      return ok(body);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: "no route" }] },
      {
        status: 404,
      },
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const zones = {
  "example.com": { id: "z-app", account: "acc" },
  "example-content.net": { id: "z-content", account: "acc" },
};
const zoneArgs = {
  token: "cf-token-SECRET",
  accountId: "acc",
  appZone: "example.com",
  contentZone: "example-content.net",
  contentHost: "example-content.net",
};

describe("deploy-lib: checkZones", () => {
  it("creates the proxied wildcard record when it is missing", async () => {
    const cf = fakeCloudflare({ zones, records: [] });
    const r = await checkZones({ ...zoneArgs, fetch: cf.fetch, create: true });
    expect(r).toEqual({
      zones: { "example.com": "z-app", "example-content.net": "z-content" },
      wildcard: "created",
    });
    const post = cf.calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/client/v4/zones/z-content/dns_records");
    expect(post?.body).toMatchObject({
      type: "A",
      name: "*.example-content.net",
      content: "192.0.2.0",
      proxied: true,
    });
  });

  it("only reports a missing record without create", async () => {
    const cf = fakeCloudflare({ zones, records: [] });
    const r = await checkZones({ ...zoneArgs, fetch: cf.fetch, create: false });
    expect(r.wildcard).toBe("missing");
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("keeps an existing proxied wildcard record", async () => {
    const records = [
      { id: "r1", type: "AAAA", name: "*.example-content.net", content: "100::", proxied: true },
    ];
    const cf = fakeCloudflare({ zones, records });
    const r = await checkZones({ ...zoneArgs, fetch: cf.fetch, create: true });
    expect(r.wildcard).toBe("exists");
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stops on a wildcard record that is not proxied, changing nothing", async () => {
    const records = [
      {
        id: "r1",
        type: "A",
        name: "*.example-content.net",
        content: "203.0.113.9",
        proxied: false,
      },
    ];
    const cf = fakeCloudflare({ zones, records });
    await expect(checkZones({ ...zoneArgs, fetch: cf.fetch, create: true })).rejects.toThrow(
      /not proxied.*A 203\.0\.113\.9/,
    );
    expect(cf.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("explains a zone that is not on the account", async () => {
    const cf = fakeCloudflare({ zones: { "example.com": zones["example.com"] }, records: [] });
    const err = await checkZones({ ...zoneArgs, fetch: cf.fetch, create: true }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect(err.message).toMatch(/example-content\.net is not on the Cloudflare account acc/);
    expect(err.message).not.toContain("SECRET");
  });

  it("reports unknown when the login cannot read DNS records", async () => {
    const cf = fakeCloudflare({ zones, records: [], dnsStatus: 403 });
    const r = await checkZones({ ...zoneArgs, fetch: cf.fetch, create: false });
    expect(r.wildcard).toBe("unknown");
  });
});

describe("runtimeBase (packages/cli runtime/wrangler.base.json)", () => {
  const repo = {
    compatibility_date: "2026-11-01",
    compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    triggers: { crons: ["0 * * * *"] },
    assets: { directory: "../web/dist", binding: "ASSETS" },
    d1_databases: [{ binding: "DB" }],
    durable_objects: ROOMS_DO,
    migrations: ROOMS_MIGRATIONS,
    vars: {
      APP_HOST: "app.localhost:8787",
      ALLOW_ROOMS: "true",
      ROOM_MAX_CONNECTIONS_PER_ARTIFACT: "50",
      ROOM_MAX_MESSAGE_BYTES: "8192",
      ROOM_MESSAGES_PER_SECOND: "20",
      ALLOW_LIVE_EDITING: "true",
      LIVE_CHECKPOINT_IDLE_S: "120",
      LIVE_AUTO_CHECKPOINT_MIN_S: "600",
      LIVE_DRAFT_FLUSH_S: "5",
      LIVE_DRAFT_RETENTION_DAYS: "30",
    },
  };

  it("copies ALLOW_DICTATION with its committed default", () => {
    const b = runtimeBase({ ...repo, vars: { ...repo.vars, ALLOW_DICTATION: "false" } }) as {
      vars: Record<string, string>;
    };
    expect(b.vars.ALLOW_DICTATION).toBe("false");
  });

  it("copies the Durable Object binding, its migration and the room vars, not the hosts", () => {
    const b = runtimeBase(repo) as {
      durable_objects: unknown;
      migrations: unknown;
      vars: Record<string, string>;
    };
    expect(b.durable_objects).toEqual(ROOMS_DO);
    expect(b.migrations).toEqual(ROOMS_MIGRATIONS);
    expect("d1_databases" in b).toBe(false);
    const { APP_HOST: _host, ...roomVars } = repo.vars;
    expect(b.vars).toEqual(roomVars);
  });

  it("does not require the binding: a config without it runs with rooms off", () => {
    const { durable_objects: _d, migrations: _m, ...noRooms } = runtimeBase(repo);
    expect(runtimeConfigMissing(noRooms)).toEqual([]);
    expect(runtimeConfigNotes(noRooms)).toEqual([
      expect.stringMatching(/no ROOMS Durable Object binding.*rooms-v1/),
    ]);
    expect(runtimeConfigNotes(runtimeBase(repo))).toEqual([]);
  });
});

describe("refreshRuntime (setup re-run on an existing per-environment config)", () => {
  it("adds the flags this release needs to a config written before them, keeping the rest", () => {
    // A wrangler.production.jsonc written by setup before 0.4.0: request.signal never aborts on
    // a client disconnect without enable_request_signal, so the upload cleanup never starts.
    const old = {
      name: "plinth-production",
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { APP_HOST: "plinth.example.com" },
    };
    const repo = {
      compatibility_date: "2026-11-01",
      compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    };
    expect(refreshRuntime(old, repo)).toEqual({
      ...old,
      compatibility_flags: ["nodejs_compat", "enable_request_signal"],
    });
    // An operator's own extra flag and a later date stay; an older repo date never wins.
    const own = { ...old, compatibility_date: "2026-12-01", compatibility_flags: ["x_flag"] };
    expect(refreshRuntime(own, repo)).toMatchObject({
      compatibility_date: "2026-12-01",
      compatibility_flags: ["x_flag", "nodejs_compat", "enable_request_signal"],
    });
    expect(
      refreshRuntime({ ...old, compatibility_date: "2026-10-01" }, repo).compatibility_date,
    ).toBe("2026-11-01");
  });

  it("adds the repo's Durable Object binding and migration, matched by name and tag", () => {
    const old = {
      name: "plinth-production",
      compatibility_flags: ["nodejs_compat", "enable_request_signal"],
      vars: { ALLOW_ROOMS: "false" },
    };
    const repo = {
      compatibility_flags: ["nodejs_compat", "enable_request_signal"],
      durable_objects: ROOMS_DO,
      migrations: ROOMS_MIGRATIONS,
    };
    const next = refreshRuntime(old, repo);
    expect(next.durable_objects).toEqual(ROOMS_DO);
    expect(next.migrations).toEqual(ROOMS_MIGRATIONS);
    expect(next.vars).toEqual({ ALLOW_ROOMS: "false" });
    expect(refreshRuntime(next, repo)).toEqual(next);
    // An operator's binding of the same name (say, pointed elsewhere) is kept as it is.
    const mine = {
      ...old,
      durable_objects: {
        bindings: [{ name: "ROOMS", class_name: "ArtifactRoom", script_name: "x" }],
      },
    };
    expect(refreshRuntime(mine, repo).durable_objects).toEqual(mine.durable_objects);
    // Neither file has any: no keys appear.
    const plain = refreshRuntime(old, { compatibility_flags: repo.compatibility_flags });
    expect("durable_objects" in plain || "migrations" in plain).toBe(false);
  });
});
