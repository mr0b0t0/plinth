// Unit checks of the header builders (the response-level checks live in security.test.ts).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appCsp, applyAppHeaders } from "../src/app/headers.ts";
import { parseConfig } from "../src/config.ts";
import {
  applyContentHeaders,
  contentCsp,
  contentResourcePolicy,
  OPAQUE_SANDBOX,
  PERMISSIONS_POLICY,
} from "../src/content/csp.ts";

const vars = (extra: Record<string, string> = {}) =>
  parseConfig({ ...(env as unknown as Record<string, unknown>), ...extra });

describe("content CSP builder", () => {
  it("frame-ancestors names the configured app origin", () => {
    const c = vars({
      ENVIRONMENT: "staging",
      APP_HOST: "plinth.example.com",
      CONTENT_HOST: "plinth-content.example.net",
      PUBLIC_SCHEME: "https",
    });
    expect(contentCsp(c)).toContain("frame-ancestors 'self' https://plinth.example.com");
  });

  it("adds an opaque-origin sandbox under opaque isolation and in the path fallback only", () => {
    expect(contentCsp(vars())).not.toContain("sandbox");
    expect(contentCsp(vars({ CONTENT_ISOLATION: "origin" }))).not.toContain("sandbox");
    const opaque = contentCsp(vars({ CONTENT_ISOLATION: "opaque" }));
    expect(opaque).toContain(`; ${OPAQUE_SANDBOX}`);
    const fallback = contentCsp(vars({ STAGING_CONTENT_FALLBACK: "true" }));
    expect(fallback).toContain(OPAQUE_SANDBOX);
    expect(OPAQUE_SANDBOX).toMatch(/^sandbox /);
    expect(OPAQUE_SANDBOX).toContain("allow-scripts");
    expect(OPAQUE_SANDBOX).not.toContain("allow-same-origin");
    expect(OPAQUE_SANDBOX).not.toContain("allow-top-navigation");
    // The sandbox is the only difference: the opaque CSP keeps every other directive.
    expect(opaque.replace(`; ${OPAQUE_SANDBOX}`, "")).toBe(contentCsp(vars()));
  });

  it("allows the artifact's own subresources under opaque isolation (CORP)", () => {
    // An opaque-origin document is same-origin with nothing, so CORP same-origin would block the
    // artifact's own CSS, scripts and images. The content cookie and CSP still gate every load.
    expect(contentResourcePolicy(vars())).toBe("same-origin");
    expect(contentResourcePolicy(vars({ CONTENT_ISOLATION: "opaque" }))).toBe("cross-origin");
    expect(contentResourcePolicy(vars({ STAGING_CONTENT_FALLBACK: "true" }))).toBe("cross-origin");
  });

  it("refuses an unknown CONTENT_ISOLATION", () => {
    expect(() => vars({ CONTENT_ISOLATION: "none" })).toThrow(/CONTENT_ISOLATION/);
    expect(vars({ CONTENT_ISOLATION: "OPAQUE" }).contentIsolation).toBe("opaque");
  });

  it("Permissions-Policy grants no powerful feature to anyone", () => {
    const features = PERMISSIONS_POLICY.split(", ");
    expect(features.length).toBeGreaterThanOrEqual(20);
    for (const f of features) expect(f).toMatch(/^[a-z-]+=\(\)$/);
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "hid"]) {
      expect(features).toContain(`${f}=()`);
    }
  });

  it("applyContentHeaders sets every header the content host relies on", () => {
    const h = new Headers();
    applyContentHeaders(vars(), h);
    expect(Object.fromEntries(h)).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "private, no-cache",
    });
  });
});

describe("app CSP builder", () => {
  it("frames only content subdomains, and the app origin itself in the path fallback", () => {
    const c = vars({ CONTENT_HOST: "plinthcontent.net", PUBLIC_SCHEME: "https" });
    expect(appCsp(c)).toContain("frame-src https://*.plinthcontent.net;");
    expect(appCsp(vars({ STAGING_CONTENT_FALLBACK: "true" }))).toContain("frame-src 'self';");
  });

  it("app pages run only their own scripts and cannot be framed", () => {
    const h = new Headers();
    applyAppHeaders(vars({ PUBLIC_SCHEME: "https" }), h);
    expect(h.get("content-security-policy")).toContain("script-src 'self';");
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(h.get("strict-transport-security")).toBe("max-age=31536000");
  });
});
