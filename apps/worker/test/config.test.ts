import { env } from "cloudflare:workers";
import {
  DEFAULTS,
  LIMITS,
  LIVE_DEFAULTS,
  LIVE_VIEW_DEFAULTS,
  ROOM_DEFAULTS,
  TTL,
} from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  IDENTITY_READERS,
  identityClaimsActive,
  liveEditMode,
  liveViewsActive,
  MIN_VERSION_BYTES,
  maxBundleBytes,
  type OptionalBindings,
  parseConfig,
  registrableDomain,
  roomsActive,
  sharedDataActive,
  uploadTicketsPerHour,
} from "../src/config.ts";
import { everyIdentityReaderOff } from "./identity-readers.ts";

const base = {
  ENVIRONMENT: "production",
  APP_HOST: "plinth.aconite.io",
  CONTENT_HOST: "plinthusercontent.net",
  PUBLIC_SCHEME: "https",
  EMAIL_PROVIDER: "sendgrid",
  SENDGRID_API_KEY: "SG.x",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_SIGNING_KEY: "t".repeat(40),
};

describe("config", () => {
  it("accepts separate registrable domains in production", () => {
    expect(parseConfig(base).appOrigin).toBe("https://plinth.aconite.io");
  });
  it("refuses production when app and content share a registrable domain", () => {
    expect(() => parseConfig({ ...base, CONTENT_HOST: "content.aconite.io" })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...base, APP_HOST: "a.example.co.uk", CONTENT_HOST: "b.example.co.uk" }),
    ).toThrow(/registrable domain/);
  });
  it("refuses a content subdomain with origin isolation until the PSL entry is known", () => {
    // plinth-usercontent.aconite.io (the hosted instance's former content host, never listed on
    // the PSL) stands in for any unlisted content subdomain of the app's registrable domain. If a
    // tldts release ever lists it, pick another unlisted subdomain for this test.
    expect(registrableDomain("x.plinth-usercontent.aconite.io")).toBe("aconite.io");
    const hosted = { ...base, CONTENT_HOST: "plinth-usercontent.aconite.io" };
    expect(() => parseConfig(hosted)).toThrow(/Public Suffix List/);
    expect(() => parseConfig(hosted)).toThrow(/CONTENT_ISOLATION=opaque/);
    expect(() => parseConfig({ ...hosted, CONTENT_ISOLATION: "origin" })).toThrow(
      /registrable domain/,
    );
  });

  it("runs production on a shared registrable domain only with opaque isolation", () => {
    const hosted = { ...base, CONTENT_HOST: "plinth-usercontent.aconite.io" };
    const c = parseConfig({ ...hosted, CONTENT_ISOLATION: "opaque" });
    expect(c.contentIsolation).toBe("opaque");
    expect(c.configuredContentIsolation).toBe("opaque");
    expect(() =>
      parseConfig({
        ...base,
        APP_HOST: "a.example.co.uk",
        CONTENT_HOST: "b.example.co.uk",
        CONTENT_ISOLATION: "opaque",
      }),
    ).not.toThrow();
  });

  it("refuses a content host equal to, inside or above the app host in every isolation mode", () => {
    for (const mode of ["origin", "opaque"]) {
      for (const [app, content] of [
        ["plinth.aconite.io", "plinth.aconite.io"],
        ["plinth.aconite.io", "content.plinth.aconite.io"],
        ["app.plinth.aconite.io", "plinth.aconite.io"],
      ]) {
        expect(() =>
          parseConfig({ ...base, APP_HOST: app, CONTENT_HOST: content, CONTENT_ISOLATION: mode }),
        ).toThrow(ConfigError);
      }
    }
  });

  it("defaults to origin isolation and keeps it with a separate content domain", () => {
    expect(parseConfig(base).contentIsolation).toBe("origin");
    expect(parseConfig({ ...base, CONTENT_ISOLATION: "opaque" }).contentIsolation).toBe("opaque");
    expect(() => parseConfig({ ...base, CONTENT_ISOLATION: "sandbox" })).toThrow(
      /CONTENT_ISOLATION must be origin or opaque/,
    );
  });
  it("treats a PSL-listed subdomain as its own registrable domain", () => {
    // github.io is on the PSL's private section, so two of its subdomains are different sites.
    expect(registrableDomain("a.example.github.io")).toBe("example.github.io");
    expect(() =>
      parseConfig({ ...base, APP_HOST: "app.github.io", CONTENT_HOST: "content.github.io" }),
    ).not.toThrow();
  });
  it("allows a shared domain outside production (local development)", () => {
    expect(() =>
      parseConfig({
        ...base,
        ENVIRONMENT: "development",
        APP_HOST: "app.localhost:8787",
        CONTENT_HOST: "content.localhost:8787",
      }),
    ).not.toThrow();
  });
  it("refuses the path fallback and the console email provider in production", () => {
    expect(() => parseConfig({ ...base, STAGING_CONTENT_FALLBACK: "true" })).toThrow(
      /refused in production/,
    );
    // Opaque isolation does not make the fallback acceptable in production.
    expect(() =>
      parseConfig({ ...base, STAGING_CONTENT_FALLBACK: "true", CONTENT_ISOLATION: "opaque" }),
    ).toThrow(/STAGING_CONTENT_FALLBACK is refused in production/);
    expect(() => parseConfig({ ...base, EMAIL_PROVIDER: "console" })).toThrow(/console/);
  });
  it("needs strong secrets", () => {
    expect(() => parseConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
  it("uses the default CDN allowlist unless one is configured", () => {
    expect(parseConfig(base).cdnAllowlist).toContain("cdn.jsdelivr.net");
    expect(
      parseConfig({ ...base, CDN_ALLOWLIST: "cdn.example.com, unpkg.com" }).cdnAllowlist,
    ).toEqual(["cdn.example.com", "unpkg.com"]);
    expect(() => parseConfig({ ...base, CDN_ALLOWLIST: "https://evil.example/x" })).toThrow();
  });
  it("computes registrable domains with the public suffix list", () => {
    expect(registrableDomain("plinth.aconite.io")).toBe("aconite.io");
    expect(registrableDomain("x.user.workers.dev:443")).toBe("user.workers.dev");
  });
  it("single-user mode needs one admin email; the admin token is optional but long", () => {
    expect(() => parseConfig({ ...base, SINGLE_USER_MODE: "true" })).toThrow(/ADMIN_EMAIL/);
    const single = { ...base, SINGLE_USER_MODE: "true", ADMIN_EMAIL: "me@x.com" };
    const noToken = parseConfig(single);
    expect(noToken.singleUserMode).toBe(true);
    expect(noToken.adminToken).toBeNull();
    expect(parseConfig({ ...single, ADMIN_TOKEN: "a".repeat(40) }).adminToken).toBe("a".repeat(40));
    expect(() => parseConfig({ ...single, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });
});

describe("operator settings (legal pages)", () => {
  it("are optional: no operator means no published terms or privacy notice", () => {
    expect(parseConfig(base).operator).toBeNull();
  });
  it("parse the operator, defaulting the hosting provider to Cloudflare", () => {
    const c = parseConfig({
      ...base,
      OPERATOR_NAME: "Example Operator, Lda.",
      OPERATOR_ADDRESS: "Rua Exemplo 1, Lisboa",
      OPERATOR_REGISTRATION: "VAT PT000000000",
      OPERATOR_EMAIL: "Hello@Example.org",
    });
    expect(c.operator).toEqual({
      name: "Example Operator, Lda.",
      address: "Rua Exemplo 1, Lisboa",
      registration: "VAT PT000000000",
      email: "hello@example.org",
      hosting: "Cloudflare",
    });
  });
  it("need a name and a contact email together", () => {
    expect(() => parseConfig({ ...base, OPERATOR_NAME: "Op" })).toThrow(/OPERATOR_EMAIL/);
    expect(() => parseConfig({ ...base, OPERATOR_EMAIL: "a@b.co" })).toThrow(/OPERATOR_NAME/);
    expect(() => parseConfig({ ...base, OPERATOR_NAME: "Op", OPERATOR_EMAIL: "nope" })).toThrow(
      /not an email/,
    );
  });
  it("reach the web app through /api/v1/config", async () => {
    const { call, json } = await import("./helpers.ts");
    const cfg = await json(await call("/api/v1/config"));
    expect(cfg).toHaveProperty("operator");
    expect(cfg.email_provider).toBeTypeOf("string");
    expect(cfg.max_artifacts_per_user).toBeTypeOf("number");
    expect(cfg.source_url).toBe("https://github.com/mr0b0t0/plinth");
  });
  it("report the instance's limits, CDN allowlist and upload ticket lifetime in /api/v1/config", async () => {
    const { call, config, json } = await import("./helpers.ts");
    const cfg = await json(await call("/api/v1/config"));
    expect(cfg.limits).toEqual({
      max_html_bytes: LIMITS.maxHtmlBytes,
      max_doc_bytes: LIMITS.maxDocBytes,
      max_version_bytes: DEFAULTS.maxVersionBytes,
      max_assets_per_version: DEFAULTS.maxAssetsPerVersion,
      max_asset_path_length: LIMITS.maxAssetPathLength,
      max_request_bytes: LIMITS.maxInlineRequestBytes,
      max_bundle_bytes: DEFAULTS.maxVersionBytes + LIMITS.bundleOverheadBytes,
      max_bundle_file_bytes: LIMITS.maxBundleFileBytes,
    });
    expect(cfg.cdn_allowlist).toEqual(config().cdnAllowlist);
    expect(cfg.upload_ticket_ttl_s).toBe(TTL.uploadTicketMs / 1000);
  });
  it("report the same CDN allowlist the content host's CSP and publish warnings use", async () => {
    const { call, config, fetchWith, json } = await import("./helpers.ts");
    const { contentCsp, contentSources } = await import("../src/content/csp.ts");
    const cfg = await json(await call("/api/v1/config"));
    expect(contentSources(config()).script).toEqual(cfg.cdn_allowlist);
    const scriptSrc = contentCsp(config())
      .split("; ")
      .find((d) => d.startsWith("script-src"));
    for (const h of cfg.cdn_allowlist) expect(scriptSrc).toContain(`https://${h}`);
    // A self-hoster's CDN_ALLOWLIST reaches /config unchanged.
    const custom = await json(
      await fetchWith({ CDN_ALLOWLIST: "cdn.example.org, esm.sh" }, "/api/v1/config"),
    );
    expect(custom.cdn_allowlist).toEqual(["cdn.example.org", "esm.sh"]);
    const limited = await json(
      await fetchWith(
        { MAX_VERSION_BYTES: String(2 * 1024 * 1024), MAX_ASSETS_PER_VERSION: "40" },
        "/api/v1/config",
      ),
    );
    expect(limited.limits).toMatchObject({
      max_version_bytes: 2 * 1024 * 1024,
      max_assets_per_version: 40,
      max_bundle_bytes: 2 * 1024 * 1024 + LIMITS.bundleOverheadBytes,
    });
  });
  it("read MAX_VERSION_BYTES and MAX_ASSETS_PER_VERSION within their bounds", () => {
    const c = parseConfig(base);
    expect(c.maxVersionBytes).toBe(DEFAULTS.maxVersionBytes);
    expect(c.maxAssetsPerVersion).toBe(DEFAULTS.maxAssetsPerVersion);
    expect(maxBundleBytes(c)).toBe(DEFAULTS.maxVersionBytes + LIMITS.bundleOverheadBytes);
    expect(uploadTicketsPerHour(c)).toBe(c.maxPublishesPerHour);
    // An empty value (as wrangler.jsonc may list it) keeps the default.
    expect(
      parseConfig({ ...base, MAX_VERSION_BYTES: "", MAX_ASSETS_PER_VERSION: "" }),
    ).toMatchObject({
      maxVersionBytes: DEFAULTS.maxVersionBytes,
      maxAssetsPerVersion: DEFAULTS.maxAssetsPerVersion,
    });
    const set = parseConfig({
      ...base,
      MAX_VERSION_BYTES: String(MIN_VERSION_BYTES),
      MAX_ASSETS_PER_VERSION: String(LIMITS.maxAssetsCeiling),
    });
    expect(set.maxVersionBytes).toBe(MIN_VERSION_BYTES);
    expect(set.maxAssetsPerVersion).toBe(LIMITS.maxAssetsCeiling);
    expect(
      parseConfig({ ...base, MAX_VERSION_BYTES: String(LIMITS.maxVersionBytesCeiling) })
        .maxVersionBytes,
    ).toBe(LIMITS.maxVersionBytesCeiling);
    for (const bad of [
      String(MIN_VERSION_BYTES - 1),
      String(LIMITS.maxVersionBytesCeiling + 1),
      "0",
      "-5",
      "50MB",
      "1.5e7",
    ]) {
      expect(() => parseConfig({ ...base, MAX_VERSION_BYTES: bad }), bad).toThrow(ConfigError);
    }
    for (const bad of ["0", String(LIMITS.maxAssetsCeiling + 1), "many", "-1"]) {
      expect(() => parseConfig({ ...base, MAX_ASSETS_PER_VERSION: bad }), bad).toThrow(
        /MAX_ASSETS_PER_VERSION/,
      );
    }
  });
  it("show the source link unless SHOW_SOURCE_LINK is off", () => {
    expect(parseConfig(base).showSourceLink).toBe(true);
    expect(parseConfig({ ...base, SHOW_SOURCE_LINK: "" }).showSourceLink).toBe(true);
    expect(parseConfig({ ...base, SHOW_SOURCE_LINK: "true" }).showSourceLink).toBe(true);
    expect(parseConfig({ ...base, SHOW_SOURCE_LINK: "false" }).showSourceLink).toBe(false);
    expect(parseConfig({ ...base, SHOW_SOURCE_LINK: "0" }).showSourceLink).toBe(false);
  });
  it("count artifact opens unless VIEW_COUNTS is off", () => {
    expect(parseConfig(base).viewCounts).toBe(true);
    expect(parseConfig({ ...base, VIEW_COUNTS: "" }).viewCounts).toBe(true);
    for (const on of ["true", "1", "yes", "on", " ON "])
      expect(parseConfig({ ...base, VIEW_COUNTS: on }).viewCounts, on).toBe(true);
    for (const off of ["false", "0", "no", "off", "nope"])
      expect(parseConfig({ ...base, VIEW_COUNTS: off }).viewCounts, off).toBe(false);
  });
});

describe("development-only switches", () => {
  it("POST /__dev/seed is not served unless DEV_SEED is on in development", async () => {
    const { call } = await import("./helpers.ts");
    const res = await call("/__dev/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", session: true }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /__dev/capture-url is not served unless DEV_SEED is on in development", async () => {
    const { call } = await import("./helpers.ts");
    const res = await call("/__dev/capture-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifact_id: "aaaaaaaaaaaaaaaaaaaa", version: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /__dev/data/:id answers counts only with DEV_SEED on in development", async () => {
    const { call, agent, publish, json } = await import("./helpers.ts");
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const { env } = await import("cloudflare:workers");
    const { default: worker } = await import("../src/index.ts");
    const owner = await agent();
    const { body } = await publish(owner.auth, {
      html: '<!doctype html><meta name="plinth-capabilities" content="data"><p>x</p>',
    });
    expect((await call(`/__dev/data/${body.id}`)).status).toBe(404);
    const ops = await call(`/api/v1/artifacts/${body.id}/data`, {
      method: "POST",
      headers: { ...owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "set", collection: "votes", doc_id: "a", data: { n: 1 }, if_rev: 0 }],
      }),
    });
    expect(ops.status).toBe(200);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://app.localhost:8787/__dev/data/${body.id}`),
      { ...env, DEV_SEED: "true" } as never,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ docs: 1, usage_rows: 1 });
  });

  it("DEV_IGNORE_CLIENT_IP and DEV_OUTBOX are ignored outside development", () => {
    const prod = parseConfig({ ...base, DEV_IGNORE_CLIENT_IP: "true", DEV_OUTBOX: "true" });
    expect(prod.devIgnoreClientIp).toBe(false);
    expect(prod.devOutbox).toBe(false);
    const staging = parseConfig({ ...base, ENVIRONMENT: "staging", DEV_IGNORE_CLIENT_IP: "true" });
    const local = { APP_HOST: "app.localhost:8787", CONTENT_HOST: "content.localhost:8787" };
    expect(staging.devIgnoreClientIp).toBe(false);
    const dev = parseConfig({
      ...base,
      ...local,
      ENVIRONMENT: "development",
      DEV_IGNORE_CLIENT_IP: "true",
    });
    expect(dev.devIgnoreClientIp).toBe(true);
    expect(parseConfig({ ...base, DEV_SEED: "true" }).devSeed).toBe(false);
    expect(parseConfig({ ...base, ENVIRONMENT: "staging", DEV_SEED: "true" }).devSeed).toBe(false);
    expect(
      parseConfig({ ...base, ...local, ENVIRONMENT: "development", DEV_SEED: "true" }).devSeed,
    ).toBe(true);
  });
});

describe("environment checks", () => {
  it("development is refused on a public host", () => {
    expect(() => parseConfig({ ...base, ENVIRONMENT: "development" })).toThrow(/localhost/);
  });
  it("staging refuses a shared registrable domain unless isolation is opaque", () => {
    const shared = {
      ...base,
      ENVIRONMENT: "staging",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "content.example.com",
    };
    expect(() => parseConfig(shared)).toThrow(/registrable domain/);
    expect(() => parseConfig({ ...shared, CONTENT_ISOLATION: "opaque" })).not.toThrow();
    // The path fallback implies opaque isolation, whatever CONTENT_ISOLATION says.
    const fallback = parseConfig({ ...shared, STAGING_CONTENT_FALLBACK: "true" });
    expect(fallback.contentIsolation).toBe("opaque");
    expect(fallback.configuredContentIsolation).toBe("origin");
  });
  it("the two secrets must differ", () => {
    expect(() => parseConfig({ ...base, TOKEN_SIGNING_KEY: base.SESSION_SECRET })).toThrow(
      /different/,
    );
  });
});

describe("shared data settings", () => {
  it("default to on, with the limits from DEFAULTS.data", () => {
    const c = parseConfig(base);
    expect(c.allowSharedData).toBe(true);
    expect(c.data).toEqual(DEFAULTS.data);
    expect(c.data).toEqual({
      maxDocsPerArtifact: 1000,
      maxBytesPerArtifact: 1048576,
      maxBytesPerUser: 16777216,
      maxDocBytes: 16384,
      writesPerViewerPerHour: 300,
      writesPerArtifactPerHour: 2000,
    });
    expect(sharedDataActive(c)).toBe(true);
  });

  it("read the DATA_* env vars and ALLOW_SHARED_DATA", () => {
    const c = parseConfig({
      ...base,
      ALLOW_SHARED_DATA: "false",
      DATA_MAX_DOCS_PER_ARTIFACT: "10",
      DATA_MAX_BYTES_PER_ARTIFACT: "4096",
      DATA_MAX_BYTES_PER_USER: "8192",
      DATA_MAX_DOC_BYTES: "1024",
      DATA_WRITES_PER_VIEWER_PER_HOUR: "5",
      DATA_WRITES_PER_ARTIFACT_PER_HOUR: "7",
    });
    expect(c.allowSharedData).toBe(false);
    expect(c.data).toEqual({
      maxDocsPerArtifact: 10,
      maxBytesPerArtifact: 4096,
      maxBytesPerUser: 8192,
      maxDocBytes: 1024,
      writesPerViewerPerHour: 5,
      writesPerArtifactPerHour: 7,
    });
    expect(sharedDataActive(c)).toBe(false);
    // An empty value (as wrangler.jsonc may list it) keeps the default.
    expect(parseConfig({ ...base, ALLOW_SHARED_DATA: "" }).allowSharedData).toBe(true);
    expect(parseConfig({ ...base, ALLOW_SHARED_DATA: "true" }).allowSharedData).toBe(true);
    expect(parseConfig({ ...base, ALLOW_SHARED_DATA: "0" }).allowSharedData).toBe(false);
  });

  it("refuse limits out of bounds", () => {
    expect(() => parseConfig({ ...base, DATA_MAX_DOC_BYTES: "1023" })).toThrow(
      /DATA_MAX_DOC_BYTES/,
    );
    expect(() => parseConfig({ ...base, DATA_MAX_DOC_BYTES: "65537" })).toThrow(
      /DATA_MAX_DOC_BYTES/,
    );
    expect(parseConfig({ ...base, DATA_MAX_DOC_BYTES: "65536" }).data.maxDocBytes).toBe(65536);
    expect(() =>
      parseConfig({ ...base, DATA_MAX_DOC_BYTES: "4096", DATA_MAX_BYTES_PER_ARTIFACT: "2048" }),
    ).toThrow(/DATA_MAX_BYTES_PER_ARTIFACT/);
    expect(() =>
      parseConfig({
        ...base,
        DATA_MAX_DOC_BYTES: "1024",
        DATA_MAX_BYTES_PER_ARTIFACT: "4096",
        DATA_MAX_BYTES_PER_USER: "2048",
      }),
    ).toThrow(/DATA_MAX_BYTES_PER_USER/);
    expect(() => parseConfig({ ...base, DATA_WRITES_PER_VIEWER_PER_HOUR: "0" })).toThrow(
      /DATA_WRITES_PER_VIEWER_PER_HOUR/,
    );
    expect(() => parseConfig({ ...base, DATA_WRITES_PER_ARTIFACT_PER_HOUR: "0" })).toThrow(
      /DATA_WRITES_PER_ARTIFACT_PER_HOUR/,
    );
    expect(() => parseConfig({ ...base, DATA_MAX_DOCS_PER_ARTIFACT: "0" })).toThrow(
      /DATA_MAX_DOCS_PER_ARTIFACT/,
    );
  });

  it("are inactive under opaque isolation and the path fallback, which are not errors", () => {
    const opaque = parseConfig({ ...base, CONTENT_ISOLATION: "opaque" });
    expect(opaque.allowSharedData).toBe(true);
    expect(sharedDataActive(opaque)).toBe(false);
    const fallback = parseConfig({
      ...base,
      ENVIRONMENT: "staging",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "content.example.com",
      STAGING_CONTENT_FALLBACK: "true",
    });
    expect(fallback.configuredContentIsolation).toBe("origin");
    expect(sharedDataActive(fallback)).toBe(false);
  });
});

describe("room and live editing settings", () => {
  it("default to on, with the limits from ROOM_DEFAULTS and LIVE_DEFAULTS", () => {
    const c = parseConfig(base);
    expect(c.allowRooms).toBe(true);
    expect(c.allowLiveEditing).toBe(true);
    expect(c.rooms).toEqual(ROOM_DEFAULTS);
    expect(c.rooms).toEqual({
      maxConnectionsPerArtifact: 50,
      maxMessageBytes: 8192,
      messagesPerSecond: 20,
    });
    expect(c.live).toEqual(LIVE_DEFAULTS);
    expect(c.live).toEqual({
      checkpointIdleS: 120,
      autoCheckpointMinS: 600,
      draftFlushS: 5,
      draftRetentionDays: 30,
    });
    // An empty value (as wrangler.jsonc may list it) keeps the default.
    expect(parseConfig({ ...base, ALLOW_ROOMS: "", ALLOW_LIVE_EDITING: "" })).toMatchObject({
      allowRooms: true,
      allowLiveEditing: true,
    });
  });

  it("read the ROOM_* and LIVE_* env vars and the switches", () => {
    const c = parseConfig({
      ...base,
      ALLOW_ROOMS: "false",
      ALLOW_LIVE_EDITING: "0",
      ROOM_MAX_CONNECTIONS_PER_ARTIFACT: "2",
      ROOM_MAX_MESSAGE_BYTES: "512",
      ROOM_MESSAGES_PER_SECOND: "100",
      LIVE_CHECKPOINT_IDLE_S: "30",
      LIVE_AUTO_CHECKPOINT_MIN_S: "30",
      LIVE_DRAFT_FLUSH_S: "60",
      LIVE_DRAFT_RETENTION_DAYS: "365",
    });
    expect(c.allowRooms).toBe(false);
    expect(c.allowLiveEditing).toBe(false);
    expect(c.rooms).toEqual({
      maxConnectionsPerArtifact: 2,
      maxMessageBytes: 512,
      messagesPerSecond: 100,
    });
    expect(c.live).toEqual({
      checkpointIdleS: 30,
      autoCheckpointMinS: 30,
      draftFlushS: 60,
      draftRetentionDays: 365,
    });
  });

  it("refuse values out of bounds", () => {
    const bad: [string, string][] = [
      ["ROOM_MAX_CONNECTIONS_PER_ARTIFACT", "1"],
      ["ROOM_MAX_CONNECTIONS_PER_ARTIFACT", "1001"],
      ["ROOM_MAX_MESSAGE_BYTES", "511"],
      ["ROOM_MAX_MESSAGE_BYTES", "65537"],
      ["ROOM_MESSAGES_PER_SECOND", "0"],
      ["ROOM_MESSAGES_PER_SECOND", "101"],
      ["LIVE_DRAFT_FLUSH_S", "1"],
      ["LIVE_DRAFT_FLUSH_S", "61"],
      ["LIVE_DRAFT_RETENTION_DAYS", "0"],
      ["LIVE_DRAFT_RETENTION_DAYS", "366"],
      ["LIVE_CHECKPOINT_IDLE_S", "3601"],
      ["LIVE_CHECKPOINT_IDLE_S", "-1"],
      ["LIVE_CHECKPOINT_IDLE_S", "1.5"],
    ];
    for (const [k, v] of bad)
      expect(() => parseConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(new RegExp(k));
    for (const [k, v] of [
      ["ROOM_MAX_MESSAGE_BYTES", "65536"],
      ["LIVE_DRAFT_FLUSH_S", "2"],
      ["LIVE_DRAFT_RETENTION_DAYS", "1"],
    ])
      expect(() => parseConfig({ ...base, [k as string]: v })).not.toThrow();
  });

  it("the idle time is 0 (explicit saves only) or 30 to 3600, and autosaves are spaced past it", () => {
    expect(parseConfig({ ...base, LIVE_CHECKPOINT_IDLE_S: "0" }).live.checkpointIdleS).toBe(0);
    for (const v of ["1", "29"])
      expect(() => parseConfig({ ...base, LIVE_CHECKPOINT_IDLE_S: v })).toThrow(
        /LIVE_CHECKPOINT_IDLE_S must be 0/,
      );
    expect(parseConfig({ ...base, LIVE_CHECKPOINT_IDLE_S: "3600" }).live).toMatchObject({
      checkpointIdleS: 3600,
      // Unset, the spacing follows a longer idle time instead of failing.
      autoCheckpointMinS: 3600,
    });
    expect(() =>
      parseConfig({ ...base, LIVE_CHECKPOINT_IDLE_S: "300", LIVE_AUTO_CHECKPOINT_MIN_S: "299" }),
    ).toThrow(/LIVE_AUTO_CHECKPOINT_MIN_S must be at least LIVE_CHECKPOINT_IDLE_S/);
    expect(
      parseConfig({ ...base, LIVE_CHECKPOINT_IDLE_S: "0", LIVE_AUTO_CHECKPOINT_MIN_S: "0" }).live,
    ).toMatchObject({ checkpointIdleS: 0, autoCheckpointMinS: 0 });
  });

  it("the shipped wrangler.jsonc lists them with the documented defaults", () => {
    const c = parseConfig(env as unknown as Record<string, unknown>);
    expect(c.allowRooms).toBe(true);
    expect(c.allowLiveEditing).toBe(true);
    expect(c.rooms).toEqual(ROOM_DEFAULTS);
    expect(c.live).toEqual(LIVE_DEFAULTS);
    for (const k of [
      "ALLOW_ROOMS",
      "ROOM_MAX_CONNECTIONS_PER_ARTIFACT",
      "ROOM_MAX_MESSAGE_BYTES",
      "ROOM_MESSAGES_PER_SECOND",
      "ALLOW_LIVE_EDITING",
      "LIVE_CHECKPOINT_IDLE_S",
      "LIVE_AUTO_CHECKPOINT_MIN_S",
      "LIVE_DRAFT_FLUSH_S",
      "LIVE_DRAFT_RETENTION_DAYS",
    ])
      expect(typeof (env as unknown as Record<string, unknown>)[k], k).toBe("string");
  });

  it("rooms are active with the switch, the ROOMS binding and origin isolation only", () => {
    const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };
    const on = parseConfig(base);
    expect(roomsActive(on, binding)).toBe(true);
    // An older config without the binding: rooms are simply off, never a config error.
    expect(roomsActive(on, {})).toBe(false);
    expect(roomsActive(parseConfig({ ...base, ALLOW_ROOMS: "false" }), binding)).toBe(false);
    const opaque = parseConfig({
      ...base,
      CONTENT_HOST: "content.aconite.io",
      CONTENT_ISOLATION: "opaque",
    });
    expect(roomsActive(opaque, binding)).toBe(false);
    const fallback = parseConfig({
      ...base,
      ENVIRONMENT: "staging",
      APP_HOST: "plinth.example.workers.dev",
      STAGING_CONTENT_FALLBACK: "true",
    });
    expect(fallback.contentIsolation).toBe("opaque");
    expect(roomsActive(fallback, binding)).toBe(false);
  });

  it("live editing: room with rooms, solo without, none when off or opaque", () => {
    const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };
    expect(liveEditMode(parseConfig(base), binding)).toBe("room");
    expect(liveEditMode(parseConfig(base), {})).toBe("solo");
    expect(liveEditMode(parseConfig({ ...base, ALLOW_ROOMS: "false" }), binding)).toBe("solo");
    expect(liveEditMode(parseConfig({ ...base, ALLOW_LIVE_EDITING: "false" }), binding)).toBe(null);
    const opaque = parseConfig({ ...base, CONTENT_ISOLATION: "opaque" });
    expect(liveEditMode(opaque, binding)).toBe(null);
  });

  it("the identity claim is sealed under origin isolation while shared data or rooms are on", () => {
    const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };
    expect(identityClaimsActive(parseConfig(base), {})).toBe(true);
    const noData = parseConfig({ ...base, ALLOW_SHARED_DATA: "false" });
    expect(identityClaimsActive(noData, binding)).toBe(true);
    expect(identityClaimsActive(noData, {})).toBe(false);
    expect(
      identityClaimsActive(parseConfig({ ...base, ...everyIdentityReaderOff().vars }), binding),
    ).toBe(false);
    const opaque = parseConfig({ ...base, CONTENT_ISOLATION: "opaque" });
    expect(identityClaimsActive(opaque, binding)).toBe(false);
  });

  it("everyIdentityReaderOff turns off every identity reader, and each one alone seals the claim", () => {
    const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };
    const off = everyIdentityReaderOff();
    const viaVars = parseConfig({ ...base, ...off.vars });
    const viaConfig = { ...parseConfig(base), ...off.config };
    for (const r of IDENTITY_READERS) {
      expect(r.active(viaVars, binding), r.name).toBe(false);
      expect(r.active(viaConfig, binding), r.name).toBe(false);
      expect(r.active(parseConfig(base), binding), r.name).toBe(true);
    }
    expect(new Set(IDENTITY_READERS.map((r) => r.name)).size).toBe(IDENTITY_READERS.length);
  });
});

describe("config: live views (ALLOW_LIVE_VIEWS, LIVE_VIEW_*)", () => {
  const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };

  it("default on, 1000 watch sockets per artifact; an empty value keeps the defaults", () => {
    const c = parseConfig(base);
    expect(c.allowLiveViews).toBe(true);
    expect(c.liveViews).toEqual({ maxSocketsPerArtifact: 1000 });
    expect(c.liveViews).toEqual(LIVE_VIEW_DEFAULTS);
    const empty = parseConfig({
      ...base,
      ALLOW_LIVE_VIEWS: "",
      LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: "",
    });
    expect(empty.allowLiveViews).toBe(true);
    expect(empty.liveViews.maxSocketsPerArtifact).toBe(1000);
  });

  it("reads the switch and the cap, and refuses a cap out of bounds", () => {
    for (const off of ["false", "0", "no", "off", "nope"]) {
      expect(parseConfig({ ...base, ALLOW_LIVE_VIEWS: off }).allowLiveViews, off).toBe(false);
    }
    for (const v of ["10", "10000"]) {
      const c = parseConfig({ ...base, LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: v });
      expect(c.liveViews.maxSocketsPerArtifact).toBe(Number(v));
    }
    for (const v of ["9", "10001", "-1", "1.5", "lots"]) {
      expect(() => parseConfig({ ...base, LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT: v }), v).toThrow(
        /LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT must be an integer from 10 to 10000/,
      );
    }
  });

  it("active with the switch and the ROOMS binding, under any isolation, without ALLOW_ROOMS", () => {
    expect(liveViewsActive(parseConfig(base), binding)).toBe(true);
    // Without the binding: off, never a config error.
    expect(liveViewsActive(parseConfig(base), {})).toBe(false);
    expect(liveViewsActive(parseConfig({ ...base, ALLOW_LIVE_VIEWS: "false" }), binding)).toBe(
      false,
    );
    // The socket is on the app host: rooms off and opaque isolation do not matter.
    expect(liveViewsActive(parseConfig({ ...base, ALLOW_ROOMS: "false" }), binding)).toBe(true);
    const opaque = parseConfig({
      ...base,
      CONTENT_HOST: "content.aconite.io",
      CONTENT_ISOLATION: "opaque",
    });
    expect(liveViewsActive(opaque, binding)).toBe(true);
    const fallback = parseConfig({
      ...base,
      ENVIRONMENT: "staging",
      APP_HOST: "plinth.example.workers.dev",
      STAGING_CONTENT_FALLBACK: "true",
    });
    expect(liveViewsActive(fallback, binding)).toBe(true);
  });

  it("the shipped wrangler.jsonc lists them with the documented defaults", () => {
    const c = parseConfig(env as unknown as Record<string, unknown>);
    expect(c.allowLiveViews).toBe(true);
    expect(c.liveViews).toEqual(LIVE_VIEW_DEFAULTS);
    for (const k of ["ALLOW_LIVE_VIEWS", "LIVE_VIEW_MAX_SOCKETS_PER_ARTIFACT"])
      expect(typeof (env as unknown as Record<string, unknown>)[k], k).toBe("string");
  });
});
