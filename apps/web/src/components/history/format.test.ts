import { describe, expect, it } from "vitest";
import {
  comparePath,
  excerpt,
  formatBytes,
  parseVersion,
  relativeTime,
  versionPath,
} from "./format.ts";

describe("formatBytes", () => {
  it("uses decimal units with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(12_400)).toBe("12.4 KB");
    expect(formatBytes(250_000)).toBe("250 KB");
    expect(formatBytes(3_100_000)).toBe("3.1 MB");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  it("reads naturally", () => {
    expect(relativeTime(ago(5), now)).toBe("just now");
    expect(relativeTime(ago(5 * 60), now)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3 hours ago");
    expect(relativeTime(ago(26 * 3600), now)).toBe("yesterday");
    expect(relativeTime(ago(14 * 86400), now)).toBe("2 weeks ago");
    expect(relativeTime(ago(400 * 86400), now)).toMatch(/2025/);
  });
});

describe("excerpt", () => {
  it("keeps short notes, cuts long ones at a word and takes the first line", () => {
    expect(excerpt(null)).toBe("");
    expect(excerpt("Fix chart")).toBe("Fix chart");
    expect(excerpt("First line\nsecond")).toBe("First line");
    const e = excerpt("Make the revenue chart bigger and use the brand colours everywhere", 30);
    expect(e.length).toBeLessThanOrEqual(30);
    expect(e.endsWith("…")).toBe(true);
    expect(e).toBe("Make the revenue chart bigger…");
  });
});

describe("paths", () => {
  it("links the current version to the bare artifact URL", () => {
    expect(versionPath("my-doc", 3, 3)).toBe("/a/my-doc");
    expect(versionPath("my-doc", 2, 3)).toBe("/a/my-doc/v/2");
  });
  it("builds compare links", () => {
    expect(comparePath("my-doc", 1, 3)).toBe("/a/my-doc/compare?from=1&to=3");
    expect(comparePath("my-doc", 1, 3, "rendered")).toBe(
      "/a/my-doc/compare?from=1&to=3&view=rendered",
    );
  });
  it("parses version numbers strictly", () => {
    expect(parseVersion("3")).toBe(3);
    expect(parseVersion("0")).toBeNull();
    expect(parseVersion("-1")).toBeNull();
    expect(parseVersion("2.5")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
});
