// Page requests in the configuration (docs/self-hosting.md): ALLOW_PAGE_REQUESTS ships off, its
// limits have bounds, it is in effect only with origin isolation, and turning it on seals the
// identity claim even with shared data and rooms off. An upgrade with the defaults seals nothing new.
import { PAGE_REQUEST_DEFAULTS } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  identityClaimsActive,
  type OptionalBindings,
  pageRequestsActive,
  parseConfig,
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
const binding = { ROOMS: {} as NonNullable<OptionalBindings["ROOMS"]> };

describe("config: page requests (ALLOW_PAGE_REQUESTS, PAGE_REQUESTS_*)", () => {
  it("ships off with the default limits; only a true value turns it on", () => {
    const c = parseConfig(base);
    expect(c.allowPageRequests).toBe(false);
    expect(pageRequestsActive(c)).toBe(false);
    expect(c.pageRequests).toEqual(PAGE_REQUEST_DEFAULTS);
    expect(c.pageRequests).toEqual({
      perViewerPerHour: 10,
      perArtifactPerHour: 60,
      maxOpenPerArtifact: 25,
    });
    for (const v of ["true", "1", "yes", "on"]) {
      expect(parseConfig({ ...base, ALLOW_PAGE_REQUESTS: v }).allowPageRequests, v).toBe(true);
    }
    expect(parseConfig({ ...base, ALLOW_PAGE_REQUESTS: "false" }).allowPageRequests).toBe(false);
    expect(parseConfig({ ...base, PAGE_REQUESTS_PER_VIEWER_PER_HOUR: "" }).pageRequests).toEqual(
      PAGE_REQUEST_DEFAULTS,
    );
  });

  it("refuses limits outside their bounds", () => {
    for (const [name, bad] of [
      ["PAGE_REQUESTS_PER_VIEWER_PER_HOUR", "0"],
      ["PAGE_REQUESTS_PER_VIEWER_PER_HOUR", "101"],
      ["PAGE_REQUESTS_PER_ARTIFACT_PER_HOUR", "1001"],
      ["PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT", "0"],
      ["PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT", "501"],
      ["PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT", "ten"],
    ] as const) {
      expect(() => parseConfig({ ...base, [name]: bad }), `${name}=${bad}`).toThrow(ConfigError);
    }
    const c = parseConfig({
      ...base,
      PAGE_REQUESTS_PER_VIEWER_PER_HOUR: "100",
      PAGE_REQUESTS_PER_ARTIFACT_PER_HOUR: "1",
      PAGE_REQUESTS_MAX_OPEN_PER_ARTIFACT: "500",
    });
    expect(c.pageRequests).toEqual({
      perViewerPerHour: 100,
      perArtifactPerHour: 1,
      maxOpenPerArtifact: 500,
    });
  });

  it("is in effect only with origin isolation", () => {
    const on = { ...base, ALLOW_PAGE_REQUESTS: "true" };
    expect(pageRequestsActive(parseConfig(on))).toBe(true);
    expect(pageRequestsActive(parseConfig({ ...on, CONTENT_ISOLATION: "opaque" }))).toBe(false);
  });

  it("seals the identity claim with only page requests on; with the defaults, nothing new", () => {
    const off = everyIdentityReaderOff().vars;
    const only = parseConfig({ ...base, ...off, ALLOW_PAGE_REQUESTS: "true" });
    expect(identityClaimsActive(only, binding)).toBe(true);
    const opaque = parseConfig({
      ...base,
      ...off,
      ALLOW_PAGE_REQUESTS: "true",
      CONTENT_ISOLATION: "opaque",
    });
    expect(identityClaimsActive(opaque, binding)).toBe(false);
    // The upgrade case: shared data and rooms off, page requests at their default.
    const upgraded = parseConfig({
      ...base,
      ALLOW_SHARED_DATA: "false",
      ALLOW_ROOMS: "false",
      ALLOW_FILES: "false",
    });
    expect(identityClaimsActive(upgraded, binding)).toBe(false);
  });
});
