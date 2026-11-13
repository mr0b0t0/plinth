import type { AppConfig } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FRAME_SANDBOX,
  isReadyMessage,
  MAX_PREVIEW_BYTES,
  PREVIEW_PATH,
  previewOrigin,
  renderMessage,
  utf8Bytes,
} from "./previewProtocol.ts";

const config: AppConfig = {
  app_origin: "https://app.example",
  content_host: "plinthcontent.example",
  content_protocol: "https:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  environment: "production",
};

describe("preview protocol", () => {
  it("addresses the artifact's own origin, never the app's", () => {
    expect(previewOrigin(config, "abc123")).toBe("https://abc123.plinthcontent.example");
    expect(previewOrigin({ ...config, content_protocol: "http" }, "abc")).toBe(
      "http://abc.plinthcontent.example",
    );
    // The path fallback gives frames an opaque origin: no live preview there.
    expect(previewOrigin({ ...config, content_path_fallback: true }, "abc")).toBeNull();
    expect(PREVIEW_PATH).toBe("/__plinth/preview");
  });

  it("accepts only well-formed ready messages", () => {
    expect(isReadyMessage({ source: "plinth-preview", v: 1, type: "ready" })).toBe(true);
    for (const bad of [
      null,
      "ready",
      { source: "plinth-bridge", v: 1, type: "ready" },
      { source: "plinth-preview", v: 2, type: "ready" },
      { source: "plinth-preview", v: 1, type: "render" },
    ]) {
      expect(isReadyMessage(bad)).toBe(false);
    }
  });

  it("builds render messages", () => {
    expect(renderMessage("<p>x</p>")).toEqual({
      source: "plinth-preview",
      v: 1,
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
});
