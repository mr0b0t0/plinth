import { getDomain as tldtsGetDomain } from "tldts";
import { describe, expect, it } from "vitest";
import {
  buildLocalWorkerConfig,
  buildWorkerConfig,
  credentialsJson,
  dnsRecordNames,
  instancePaths,
  localHosts,
  renderCloudflaredConfig,
  startCommands,
  TunnelUsageError,
  validateLocalOptions,
  validateTunnelOptions,
} from "../scripts/tunnel-lib.mjs";

const deps = { getDomain: (h: string) => tldtsGetDomain(h, { allowPrivateDomains: true }) };
const base = {
  name: "plinth",
  "app-host": "plinth.example.com",
  "content-host": "example-content.net",
  "email-provider": "resend",
};

describe("tunnel-lib: validateTunnelOptions", () => {
  it("fills defaults", () => {
    expect(validateTunnelOptions(base, deps)).toEqual({
      name: "plinth",
      appHost: "plinth.example.com",
      contentHost: "example-content.net",
      port: 8788,
      emailProvider: "resend",
      emailFrom: "Plinth <noreply@plinth.example.com>",
      singleUser: false,
      adminEmail: null,
      isolation: "origin",
      cloudflare: true,
    });
  });

  it("defaults the name to plinth and lowercases hosts", () => {
    const o = validateTunnelOptions(
      { ...base, name: undefined, "app-host": "Plinth.Example.com" },
      deps,
    );
    expect(o.name).toBe("plinth");
    expect(o.appHost).toBe("plinth.example.com");
  });

  it("requires the content host to be a zone apex with origin isolation", () => {
    expect(() =>
      validateTunnelOptions({ ...base, "content-host": "content.example.net" }, deps),
    ).toThrow(TunnelUsageError);
    expect(() =>
      validateTunnelOptions({ ...base, "content-host": "content.example.net" }, deps),
    ).toThrow(/apex/);
  });

  it("accepts a non-apex content host with opaque isolation", () => {
    const o = validateTunnelOptions(
      { ...base, "content-host": "content.example.net", "content-isolation": "opaque" },
      deps,
    );
    expect(o.isolation).toBe("opaque");
    expect(o.contentHost).toBe("content.example.net");
  });

  it("refuses a shared registrable domain with origin isolation", () => {
    expect(() => validateTunnelOptions({ ...base, "content-host": "example.com" }, deps)).toThrow(
      /registrable domain/,
    );
  });

  it("refuses bad names, ports and isolation values", () => {
    expect(() => validateTunnelOptions({ ...base, name: "Plinth!" }, deps)).toThrow(
      TunnelUsageError,
    );
    expect(() => validateTunnelOptions({ ...base, port: "80" }, deps)).toThrow(/port/);
    expect(() => validateTunnelOptions({ ...base, port: "70000" }, deps)).toThrow(/port/);
    expect(() => validateTunnelOptions({ ...base, "content-isolation": "none" }, deps)).toThrow(
      /content-isolation/,
    );
    expect(() => validateTunnelOptions({ ...base, "app-host": "not a host" }, deps)).toThrow(
      /app-host/,
    );
  });

  it("needs an admin email in single-user mode", () => {
    expect(() => validateTunnelOptions({ ...base, "single-user": true }, deps)).toThrow(
      /admin-email/,
    );
    const o = validateTunnelOptions(
      { ...base, "single-user": true, "admin-email": "Owner@Example.com" },
      deps,
    );
    expect(o.singleUser).toBe(true);
    expect(o.adminEmail).toBe("owner@example.com");
  });

  it("refuses the console provider outside single-user mode", () => {
    expect(() => validateTunnelOptions({ ...base, "email-provider": "console" }, deps)).toThrow(
      /production refuses/,
    );
    expect(
      validateTunnelOptions(
        {
          ...base,
          "email-provider": "console",
          "single-user": true,
          "admin-email": "o@example.com",
        },
        deps,
      ).emailProvider,
    ).toBe("console");
  });

  it("needs an email provider", () => {
    expect(() => validateTunnelOptions({ ...base, "email-provider": undefined }, deps)).toThrow(
      /email-provider/,
    );
  });

  it("turns off Cloudflare provisioning with --no-cloudflare", () => {
    expect(validateTunnelOptions({ ...base, "no-cloudflare": true }, deps).cloudflare).toBe(false);
  });
});

describe("tunnel-lib: paths and configs", () => {
  const paths = instancePaths("/h", "p");

  it("lays out the instance directory", () => {
    expect(paths).toEqual({
      dir: "/h/p",
      state: "/h/p/state",
      wranglerConfig: "/h/p/wrangler.jsonc",
      devVars: "/h/p/.dev.vars",
      cloudflaredConfig: "/h/p/cloudflared.yml",
      credentials: "/h/p/tunnel-credentials.json",
      meta: "/h/p/instance.json",
    });
  });

  it("builds a production Worker config with absolute paths and no routes", () => {
    const o = validateTunnelOptions(base, deps);
    const cfg = buildWorkerConfig(o, "/repo") as Record<string, unknown> & {
      vars: Record<string, string>;
      assets: { directory: string };
      d1_databases: { migrations_dir: string; binding: string }[];
      r2_buckets: { binding: string }[];
    };
    expect(cfg.main).toBe("/repo/apps/worker/src/index.ts");
    expect(cfg.assets.directory).toBe("/repo/apps/web/dist");
    expect(cfg.d1_databases[0]?.migrations_dir).toBe("/repo/migrations");
    expect(cfg.d1_databases[0]?.binding).toBe("DB");
    expect(cfg.r2_buckets[0]?.binding).toBe("FILES");
    expect(cfg.workers_dev).toBe(false);
    expect("routes" in cfg).toBe(false);
    expect(cfg.vars).toMatchObject({
      ENVIRONMENT: "production",
      PUBLIC_SCHEME: "https",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "example-content.net",
      CONTENT_ISOLATION: "origin",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "Plinth <noreply@plinth.example.com>",
      SINGLE_USER_MODE: "false",
      ADMIN_EMAIL: "",
      DEV_OUTBOX: "false",
      DEV_SEED: "false",
      DEV_IGNORE_CLIENT_IP: "false",
      STAGING_CONTENT_FALLBACK: "false",
    });
  });

  it("renders cloudflared ingress for app, content apex and wildcard, then a 404", () => {
    const yml = renderCloudflaredConfig({
      tunnelId: "t-1",
      credentialsFile: "/h/p/tunnel-credentials.json",
      appHost: "plinth.example.com",
      contentHost: "example-content.net",
      port: 8788,
    });
    expect(yml).toContain("tunnel: t-1\n");
    expect(yml).toContain('credentials-file: "/h/p/tunnel-credentials.json"\n');
    const a = yml.indexOf("hostname: plinth.example.com");
    const b = yml.indexOf("hostname: example-content.net");
    const c = yml.indexOf('hostname: "*.example-content.net"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(yml.match(/service: http:\/\/127\.0\.0\.1:8788/g)).toHaveLength(3);
    expect(yml.trimEnd().endsWith("- service: http_status:404")).toBe(true);
    expect(yml).not.toMatch(/httpHostHeader|originServerName/);
  });

  it("names the three DNS records", () => {
    expect(dnsRecordNames("plinth.example.com", "example-content.net")).toEqual([
      "plinth.example.com",
      "example-content.net",
      "*.example-content.net",
    ]);
  });

  it("writes the tunnel credentials file", () => {
    expect(JSON.parse(credentialsJson({ accountId: "a", tunnelId: "t", secret: "s" }))).toEqual({
      AccountTag: "a",
      TunnelID: "t",
      TunnelSecret: "s",
    });
  });

  it("builds the start commands", () => {
    const off = startCommands(paths, 8788, false);
    expect(off.cloudflared).toBeNull();
    expect(off.wrangler).toEqual([
      "dev",
      "--config",
      "/h/p/wrangler.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      "8788",
      "--persist-to",
      "/h/p/state",
      "--upstream-protocol",
      "https",
      "--show-interactive-dev-session=false",
    ]);
    expect(startCommands(paths, 8788, true).cloudflared).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--config",
      "/h/p/cloudflared.yml",
      "run",
    ]);
  });
});

describe("tunnel-lib: localhost-only instances", () => {
  it("requires an email and fills defaults", () => {
    expect(validateLocalOptions({ email: "Me@Example.com" })).toEqual({
      name: "plinth",
      port: 8788,
      adminEmail: "me@example.com",
    });
    expect(() => validateLocalOptions({})).toThrow(/--email/);
    expect(() => validateLocalOptions({ email: "nope" })).toThrow(TunnelUsageError);
    expect(() => validateLocalOptions({ email: "a@b.co", port: "80" })).toThrow(/--port/);
    expect(() => validateLocalOptions({ email: "a@b.co", name: "Bad Name" })).toThrow(/--name/);
  });

  it("serves the app and artifacts from separate *.localhost hosts", () => {
    expect(localHosts(9000)).toEqual({
      appHost: "app.localhost:9000",
      contentHost: "content.localhost:9000",
    });
  });

  it("builds a single-user development config from a layout object", () => {
    const o = validateLocalOptions({ email: "me@example.com", port: "9000" });
    const layout = { main: "/pkg/w/index.js", assetsDir: "/pkg/web", migrationsDir: "/pkg/m" };
    const cfg = buildLocalWorkerConfig(o, layout, { vars: { MAX_ARTIFACTS_PER_USER: "100" } }) as {
      main: string;
      assets: { directory: string };
      d1_databases: { migrations_dir: string }[];
      vars: Record<string, string>;
    };
    expect(cfg.main).toBe("/pkg/w/index.js");
    expect(cfg.assets.directory).toBe("/pkg/web");
    expect(cfg.d1_databases[0]?.migrations_dir).toBe("/pkg/m");
    expect(cfg.vars).toMatchObject({
      ENVIRONMENT: "development",
      APP_HOST: "app.localhost:9000",
      CONTENT_HOST: "content.localhost:9000",
      CONTENT_ISOLATION: "origin",
      PUBLIC_SCHEME: "http",
      EMAIL_PROVIDER: "console",
      SINGLE_USER_MODE: "true",
      ADMIN_EMAIL: "me@example.com",
      DEV_OUTBOX: "false",
      DEV_SEED: "false",
      DEV_IGNORE_CLIENT_IP: "false",
      MAX_ARTIFACTS_PER_USER: "100",
    });
  });

  it("keeps a repo-root layout working for tunnel configs", () => {
    const o = validateTunnelOptions(base, deps);
    const layout = { main: "/pkg/w/index.js", assetsDir: "/pkg/web", migrationsDir: "/pkg/m" };
    expect((buildWorkerConfig(o, layout) as { main: string }).main).toBe("/pkg/w/index.js");
  });

  it("starts wrangler without the https upstream rewrite", () => {
    const paths = instancePaths("/h", "p");
    const cmd = startCommands(paths, 9000, false, { local: true });
    expect(cmd.wrangler).not.toContain("--upstream-protocol");
    expect(cmd.wrangler).toContain("127.0.0.1");
    expect(cmd.cloudflared).toBeNull();
  });
});
