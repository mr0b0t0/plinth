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
  it("allows a shared domain outside production (local development)", () => {
    expect(() =>
      parseConfig({ ...base, ENVIRONMENT: "development", CONTENT_HOST: "content.aconite.io" }),
    ).not.toThrow();
  });
  it("refuses the path fallback and the console email provider in production", () => {
    expect(() => parseConfig({ ...base, STAGING_CONTENT_FALLBACK: "true" })).toThrow(
      /refused in production/,
    );
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
    expect(staging.devIgnoreClientIp).toBe(false);
    const dev = parseConfig({ ...base, ENVIRONMENT: "development", DEV_IGNORE_CLIENT_IP: "true" });
    expect(dev.devIgnoreClientIp).toBe(true);
    expect(parseConfig({ ...base, DEV_SEED: "true" }).devSeed).toBe(false);
    expect(parseConfig({ ...base, ENVIRONMENT: "staging", DEV_SEED: "true" }).devSeed).toBe(false);
    expect(parseConfig({ ...base, ENVIRONMENT: "development", DEV_SEED: "true" }).devSeed).toBe(
      true,
    );
  });
});
