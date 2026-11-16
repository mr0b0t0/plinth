import { describe, expect, it } from "vitest";
import {
  assetInputSchema,
  claudeCodePluginCommands,
  codexPluginCommands,
  HARNESSES,
  HOSTED_ORIGIN,
  harness,
  PLUGIN,
  publishArtifactInput,
  route,
} from "../src/index.ts";
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
    // Private by default (allowlist with nobody added), like Claude's artifacts.
    expect(publishArtifactInput.parse({ title: "t", html: "<p>x</p>" }).visibility).toBe(
      "allowlist",
    );
  });
  it("rejects unsafe asset paths", () => {
    for (const path of ["../a", "/a", "__plinth/x", "a/./b", "a//b/../c"]) {
      expect(assetInputSchema.safeParse({ path, content: "" }).success, path).toBe(false);
    }
    expect(assetInputSchema.safeParse({ path: "img/a-1_b.png", content: "" }).success).toBe(true);
    // Reserved paths depend on the artifact's type: the Worker refuses them (checkAsset, tested in
    // apps/worker/test/typed-docs.test.ts), not the schema.
    expect(assetInputSchema.safeParse({ path: "index.html", content: "" }).success).toBe(true);
  });
  it("fills route params", () => {
    expect(route("/a/:slug/v/:n", { slug: "x y", n: 3 })).toBe("/a/x%20y/v/3");
  });
});

describe("harness registry", () => {
  it("has one entry per client, each with guidance", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HARNESSES) {
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.guidance.summary.length).toBeGreaterThan(0);
      expect(
        h.guidance.commands || h.guidance.link || h.guidance.kind === "server-only",
      ).toBeTruthy();
    }
  });
  it("marks hosted chat apps as unable to reach a local instance", () => {
    expect(harness("claude").reachesLocal).toBe(false);
    expect(harness("chatgpt").reachesLocal).toBe(false);
    expect(harness("claude-code").reachesLocal).toBe(true);
  });
  it("sets T3 Code up with the Claude Code and Codex plugins it runs", () => {
    const t3 = harness("t3code");
    expect(t3.reachesLocal).toBe(true);
    expect(t3.guidance.commands).toBe(
      [...claudeCodePluginCommands(), ...codexPluginCommands()].join("\n"),
    );
    expect(harness("codex").guidance.commands).toBe(codexPluginCommands().join("\n"));
  });
  it("keeps the product name and plugin name free of Claude and Codex", () => {
    expect(PLUGIN.name).not.toMatch(/claude|codex/i);
    expect(HOSTED_ORIGIN).toBe("https://plinth.aconite.io");
  });
});
