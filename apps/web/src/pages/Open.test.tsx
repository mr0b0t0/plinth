import { describe, expect, it } from "vitest";
import { openTarget } from "./Open.tsx";

describe("Open", () => {
  it("forwards direct content links to the framed artifact page", () => {
    expect(openTarget("abc", null)).toBe("/a/abc");
    expect(openTarget("abc", "/")).toBe("/a/abc");
    expect(openTarget("abc", "/__plinth/v/3/")).toBe("/a/abc/v/3");
    expect(openTarget("abc", "/page.html?x=1")).toBe(
      `/a/abc?path=${encodeURIComponent("/page.html?x=1")}`,
    );
    expect(openTarget("abc", "//evil.example")).toBe("/a/abc");
    expect(openTarget("abc", "https://evil.example")).toBe("/a/abc");
  });
});
