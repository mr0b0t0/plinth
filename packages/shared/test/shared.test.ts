import { describe, expect, it } from "vitest";
import { assetInputSchema, publishArtifactInput, route } from "../src/index.ts";
import { mentionHandle, parseMentions } from "../src/mentions.ts";

describe("parseMentions", () => {
  it("finds agent and label mentions, lowercased and deduplicated", () => {
    expect(parseMentions("@claude make the chart bigger, @Work-Claude too. @claude")).toEqual([
      "claude",
      "work-claude",
    ]);
  });
  it("ignores emails and trailing dots", () => {
    expect(parseMentions("mail me at a@codex.com or ask @codex.")).toEqual(["codex"]);
  });
  it("normalizes labels into handles", () => {
    expect(mentionHandle("Work Claude")).toBe("work-claude");
  });
});

describe("schemas", () => {
  it("defaults visibility to unlisted", () => {
    expect(publishArtifactInput.parse({ title: "t", html: "<p>x</p>" }).visibility).toBe(
      "unlisted",
    );
  });
  it("rejects unsafe asset paths", () => {
    for (const path of ["../a", "/a", "__plinth/x", "a/./b", "a//b/../c", "index.html"]) {
      expect(assetInputSchema.safeParse({ path, content: "" }).success, path).toBe(false);
    }
    expect(assetInputSchema.safeParse({ path: "img/a-1_b.png", content: "" }).success).toBe(true);
  });
  it("fills route params", () => {
    expect(route("/a/:slug/v/:n", { slug: "x y", n: 3 })).toBe("/a/x%20y/v/3");
  });
});
