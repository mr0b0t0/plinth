import type { AppConfig } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../lib/api.ts";
import {
  contentOriginOf,
  gateErrorMessage,
  gatePath,
  gateQueryString,
  parseVersion,
  shareLink,
} from "./gate.ts";

const config: AppConfig = {
  app_origin: "https://plinth.example",
  content_host: "content.example",
  content_protocol: "https:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  content_isolation: "origin",
  environment: "production",
  operator: null,
  email_provider: "console",
  max_artifacts_per_user: 100,
  source_url: null,
  limits: {
    max_html_bytes: 5242880,
    max_doc_bytes: 1048576,
    max_version_bytes: 52428800,
    max_assets_per_version: 511,
    max_asset_path_length: 200,
    max_request_bytes: 41943040,
    max_bundle_bytes: 60817408,
    max_bundle_file_bytes: 26214400,
    max_sheet_bytes: 1048576,
    max_sheet_rows: 10000,
    max_sheet_columns: 100,
  },
  cdn_allowlist: ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
  upload_ticket_ttl_s: 1800,
  dictation: false,
};

describe("gate query and paths", () => {
  it("builds only the parameters that are set", () => {
    expect(gateQueryString()).toBe("");
    expect(gateQueryString({ version: 3 })).toBe("?version=3");
    expect(gateQueryString({ review: true })).toBe("?review=1");
    expect(gateQueryString({ review: false, next: "/a b?x=1#h" })).toBe("?next=%2Fa+b%3Fx%3D1%23h");
    // A place carried from an older version says so; the flag means nothing without a path.
    expect(gateQueryString({ next: "/settings", carried: true })).toBe(
      "?next=%2Fsettings&carried=1",
    );
    expect(gateQueryString({ carried: true })).toBe("");
  });

  it("fills the artifact ref into each gate step", () => {
    expect(gatePath("view", "my-slug", { version: 2, review: true })).toBe(
      "/view/my-slug?version=2&review=1",
    );
    expect(gatePath("viewPassword", "abc")).toBe("/view/abc/password");
    expect(gatePath("viewEmail", "abc", { next: "/x" })).toBe("/view/abc/email?next=%2Fx");
    expect(gatePath("viewCode", "a/b")).toBe("/view/a%2Fb/code");
  });

  it("parses version params strictly", () => {
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseVersion("1")).toBe(1);
    expect(parseVersion("12")).toBe(12);
    expect(parseVersion("0")).toBeUndefined();
    expect(parseVersion("-1")).toBeUndefined();
    expect(parseVersion("1.5")).toBeUndefined();
    expect(parseVersion("2abc")).toBeUndefined();
    expect(parseVersion("1234567890")).toBeUndefined();
  });
});

describe("contentOriginOf", () => {
  it("takes the origin of the enter URL", () => {
    expect(
      contentOriginOf("http://abc.content.localhost:8812/__plinth/enter?t=x", "abc", config),
    ).toBe("http://abc.content.localhost:8812");
  });

  it("falls back to the config when the URL does not parse", () => {
    expect(contentOriginOf("not a url", "abc", config)).toBe("https://abc.content.example");
    expect(contentOriginOf("", "abc", { ...config, content_path_fallback: true })).toBe(
      "https://plinth.example",
    );
    expect(contentOriginOf("", "abc", null)).toBe("");
  });
});

describe("shareLink", () => {
  it("links to the app page, or to one version", () => {
    expect(shareLink("https://plinth.example/", "my-slug")).toBe(
      "https://plinth.example/a/my-slug",
    );
    expect(shareLink("https://plinth.example", "my-slug", 2)).toBe(
      "https://plinth.example/a/my-slug/v/2",
    );
  });
});

describe("gateErrorMessage", () => {
  const err = (status: number, code: ConstructorParameters<typeof ApiRequestError>[1]) =>
    new ApiRequestError(status, code, "server text");

  it("says what went wrong for each step", () => {
    expect(gateErrorMessage(err(403, "forbidden"), "password")).toBe("That password is not right.");
    expect(gateErrorMessage(err(403, "forbidden"), "code")).toMatch(/^That code did not work/);
    expect(gateErrorMessage(err(429, "rate_limited"), "password")).toMatch(/Too many attempts/);
    expect(gateErrorMessage(err(429, "rate_limited"), "email")).toMatch(/Too many requests/);
    expect(gateErrorMessage(err(400, "invalid_input"), "email")).toBe(
      "Enter a valid email address.",
    );
    expect(gateErrorMessage(err(404, "not_found"), "code")).toMatch(/no longer available/);
    expect(gateErrorMessage(new TypeError("Failed to fetch"), "password")).toBe(
      "Something went wrong. Try again.",
    );
  });
});
