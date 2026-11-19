import { type AppConfig, ARTIFACT_IFRAME_SANDBOX, artifactIframeSandbox } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FRAME_SANDBOX,
  isReadyMessage,
  MAX_PREVIEW_BYTES,
  newPreviewNonce,
  PREVIEW_PATH,
  previewTarget,
  renderMessage,
  utf8Bytes,
  withPreviewNonce,
} from "./previewProtocol.ts";

const config: AppConfig = {
  app_origin: "https://app.example",
  content_host: "plinthcontent.example",
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

const NONCE = "0123456789abcdef0123456789abcdef";
const ready = (extra: Record<string, unknown> = {}) => ({
  source: "plinth-preview",
  v: 2,
  type: "ready",
  nonce: NONCE,
  ...extra,
});

describe("preview protocol", () => {
  it("addresses the artifact's own origin under origin isolation, never the app's", () => {
    const origin = "https://abc123.plinthcontent.example";
    expect(previewTarget(config, "abc123")).toEqual({
      base: origin,
      messageOrigin: origin,
      postOrigin: origin,
    });
    expect(previewTarget({ ...config, content_protocol: "http" }, "abc").base).toBe(
      "http://abc.plinthcontent.example",
    );
    expect(PREVIEW_PATH).toBe("/__plinth/preview");
  });

  it("expects origin null and posts to * under opaque isolation and in the path fallback", () => {
    expect(previewTarget({ ...config, content_isolation: "opaque" }, "abc")).toEqual({
      base: "https://abc.plinthcontent.example",
      messageOrigin: "null",
      postOrigin: "*",
    });
    expect(
      previewTarget({ ...config, content_path_fallback: true, content_isolation: "opaque" }, "abc"),
    ).toEqual({
      base: "https://app.example/__content/abc",
      messageOrigin: "null",
      postOrigin: "*",
    });
  });

  it("accepts only well-formed ready messages that carry the frame's nonce", () => {
    expect(isReadyMessage(ready(), NONCE)).toBe(true);
    for (const bad of [
      null,
      "ready",
      ready({ source: "plinth-bridge" }),
      ready({ v: 1 }),
      ready({ type: "render" }),
      ready({ nonce: "f".repeat(32) }),
      ready({ nonce: undefined }),
    ]) {
      expect(isReadyMessage(bad, NONCE)).toBe(false);
    }
    // No frame waiting (empty nonce): nothing matches, not even an empty nonce.
    expect(isReadyMessage(ready({ nonce: "" }), "")).toBe(false);
  });

  it("makes a fresh hex nonce per frame and puts it in the fragment", () => {
    const a = newPreviewNonce();
    const b = newPreviewNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(withPreviewNonce("https://x.example/__plinth/preview", NONCE)).toBe(
      `https://x.example/__plinth/preview#plinth-preview=${NONCE}`,
    );
    expect(withPreviewNonce("https://x.example/enter?t=1#old", NONCE)).toBe(
      `https://x.example/enter?t=1#plinth-preview=${NONCE}`,
    );
  });

  it("builds render messages", () => {
    expect(renderMessage("<p>x</p>")).toEqual({
      source: "plinth-preview",
      v: 2,
      type: "render",
      html: "<p>x</p>",
    });
  });

  it("counts UTF-8 bytes against the 5 MB cap", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("x".repeat(MAX_PREVIEW_BYTES + 1))).toBeGreaterThan(MAX_PREVIEW_BYTES);
  });

  it("never lets an artifact frame navigate the app", () => {
    expect(ARTIFACT_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(ARTIFACT_FRAME_SANDBOX.split(" ")).toEqual(
      expect.arrayContaining(["allow-scripts", "allow-same-origin"]),
    );
  });

  it("drops allow-same-origin from the frame sandbox under opaque isolation", () => {
    expect(artifactIframeSandbox("origin")).toBe(ARTIFACT_IFRAME_SANDBOX);
    expect(artifactIframeSandbox(undefined)).toBe(ARTIFACT_IFRAME_SANDBOX);
    const opaque = artifactIframeSandbox("opaque").split(" ");
    expect(opaque).not.toContain("allow-same-origin");
    expect(opaque.join(" ")).not.toContain("allow-top-navigation");
    // Otherwise the same flags as the origin-mode sandbox.
    expect(opaque).toEqual(
      ARTIFACT_IFRAME_SANDBOX.split(" ").filter((f) => f !== "allow-same-origin"),
    );
  });
});
