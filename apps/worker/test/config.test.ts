import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, registrableDomain } from "../src/config.ts";

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
  it("refuses the hosted content subdomain with origin isolation until the PSL entry is known", () => {
    // plinth-usercontent.aconite.io is pending on the PSL. When a tldts release includes it, this
    // test fails on purpose: confirm the entry has shipped in current browsers before updating it
    // (and then switch the hosted instance back to CONTENT_ISOLATION=origin).
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
  it("single-user mode needs an admin token and one admin email", () => {
    expect(() => parseConfig({ ...base, SINGLE_USER_MODE: "true" })).toThrow(/ADMIN_TOKEN/);
    expect(
      parseConfig({
        ...base,
        SINGLE_USER_MODE: "true",
        ADMIN_TOKEN: "a".repeat(40),
        ADMIN_EMAIL: "me@x.com",
      }).singleUserMode,
    ).toBe(true);
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
