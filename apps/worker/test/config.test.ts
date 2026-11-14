import { DEFAULTS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, registrableDomain, sharedDataActive } from "../src/config.ts";

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
