import { describe, expect, it } from "vitest";
import { agentInitials } from "../../lib/agents.ts";
import {
  formatRelative,
  formatRelativeShort,
  guessClientType,
  mcpUrl,
  mentionReach,
  mentionReachText,
  mentionReachWarns,
  quotaText,
  scopeLabel,
  versionsText,
} from "./format.ts";
import { addGrant, countByRole, removeGrant, setGrantRole } from "./grants.ts";
import { loginHref, safeNext } from "./nav.ts";

describe("safeNext", () => {
  it("keeps same-origin paths with their query and hash", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/oauth/consent?request=abc123")).toBe("/oauth/consent?request=abc123");
    expect(safeNext("/a/my-slug/settings#people")).toBe("/a/my-slug/settings#people");
  });

  it("falls back for anything that could leave the app", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "dashboard",
      "https://evil.example/",
      "//evil.example/path",
      "/\\evil.example",
      "/\\/evil.example",
      "javascript:alert(1)",
      "/ok\nLocation: x",
      "/tab\there",
      `/${"a".repeat(2001)}`,
    ]) {
      expect(safeNext(bad)).toBe("/dashboard");
    }
  });

  it("never returns to the sign-in pages", () => {
    expect(safeNext("/login")).toBe("/dashboard");
    expect(safeNext("/login/magic?token=x")).toBe("/dashboard");
    expect(safeNext("/loginx")).toBe("/loginx");
  });

  it("uses the given fallback", () => {
    expect(safeNext("//x", "/connections")).toBe("/connections");
  });

  it("builds the sign-in link with next encoded", () => {
    expect(loginHref("/oauth/consent?request=a b")).toBe(
      "/login?next=%2Foauth%2Fconsent%3Frequest%3Da%20b",
    );
    expect(loginHref("/")).toBe("/login");
    expect(loginHref()).toBe("/login");
    expect(
      safeNext(new URL(`http://x${loginHref("/dashboard?q=a")}`).searchParams.get("next")),
    ).toBe("/dashboard?q=a");
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  it("formats relative times", () => {
    expect(formatRelative("2026-11-13T11:59:30Z", now, "en")).toBe("just now");
    expect(formatRelative("2026-11-13T13:00:00Z", now, "en")).toBe("just now");
    expect(formatRelative("2026-11-13T11:55:00Z", now, "en")).toBe("5 minutes ago");
    expect(formatRelative("2026-11-13T09:00:00Z", now, "en")).toBe("3 hours ago");
    expect(formatRelative("2026-11-12T10:00:00Z", now, "en")).toBe("yesterday");
    expect(formatRelative("2026-11-09T12:00:00Z", now, "en")).toBe("4 days ago");
    expect(formatRelative("2026-10-01T12:00:00Z", now, "en")).toBe("Oct 1, 2026");
    expect(formatRelative("not a date", now, "en")).toBe("");
  });

  it("formats short relative times for dense columns", () => {
    expect(formatRelativeShort("2026-11-13T11:59:30Z", now, "en")).toBe("now");
    expect(formatRelativeShort("2026-11-13T13:00:00Z", now, "en")).toBe("now");
    expect(formatRelativeShort("2026-11-13T11:55:00Z", now, "en")).toBe("5m");
    expect(formatRelativeShort("2026-11-13T09:00:00Z", now, "en")).toBe("3h");
    expect(formatRelativeShort("2026-11-09T12:00:00Z", now, "en")).toBe("4d");
    expect(formatRelativeShort("2026-10-01T12:00:00Z", now, "en")).toBe("Oct 1");
    expect(formatRelativeShort("2025-10-01T12:00:00Z", now, "en")).toBe("Oct 1, 2025");
    expect(formatRelativeShort("not a date", now, "en")).toBe("");
  });

  it("makes two-letter marks for agents", () => {
    expect(agentInitials("Work Claude")).toBe("WC");
    expect(agentInitials("codex")).toBe("Co");
    expect(agentInitials("claude-code")).toBe("CC");
    expect(agentInitials("  ")).toBe("?");
  });

  it("words quota and versions", () => {
    expect(quotaText(12, 100)).toBe("12 of 100 artifacts");
    expect(quotaText(0, 1)).toBe("0 of 1 artifact");
    expect(versionsText(1)).toBe("1 version");
    expect(versionsText(3)).toBe("3 versions");
  });

  it("guesses the client type from a registered name", () => {
    expect(guessClientType("Claude")).toBe("claude");
    expect(guessClientType("claude-code (my laptop)")).toBe("claude");
    expect(guessClientType("Codex CLI")).toBe("codex");
    expect(guessClientType("Cursor")).toBe("other");
    expect(guessClientType(null)).toBe("other");
  });

  it("labels scopes, including unknown ones", () => {
    expect(scopeLabel("artifacts:read")).toBe("Read artifacts");
    expect(scopeLabel("mentions")).toBe("Answer mentions");
    expect(scopeLabel("future:scope")).toBe("future:scope");
  });

  it("builds the MCP URL from the app origin", () => {
    expect(mcpUrl("https://plinth.example")).toBe("https://plinth.example/mcp");
    expect(mcpUrl("http://app.localhost:8787/")).toBe("http://app.localhost:8787/mcp");
  });
});

describe("grants", () => {
  const base = [{ email: "a@example.com", role: "viewer" as const }];

  it("adds a normalized address", () => {
    const r = addGrant(base, "  Bob@Example.COM ", "commenter");
    expect(r).toEqual({
      ok: true,
      grants: [...base, { email: "bob@example.com", role: "commenter" }],
    });
  });

  it("refuses invalid, duplicate and owner addresses", () => {
    expect(addGrant(base, "nope", "viewer").ok).toBe(false);
    const dup = addGrant(base, "A@example.com", "editor");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("already");
    const own = addGrant(base, "me@example.com", "viewer", "Me@Example.com");
    expect(own.ok).toBe(false);
  });

  it("refuses a full list", () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      email: `p${i}@example.com`,
      role: "viewer" as const,
    }));
    expect(addGrant(full, "new@example.com", "viewer").ok).toBe(false);
  });

  it("changes a role and removes a person without touching the others", () => {
    const list = [...base, { email: "b@example.com", role: "viewer" as const }];
    expect(setGrantRole(list, "b@example.com", "editor")).toEqual([
      base[0],
      { email: "b@example.com", role: "editor" },
    ]);
    expect(removeGrant(list, "a@example.com")).toEqual([list[1]]);
    expect(countByRole(setGrantRole(list, "b@example.com", "editor"))).toEqual({
      viewer: 1,
      commenter: 0,
      editor: 1,
    });
  });
});

describe("mentionReach", () => {
  const conn = (id: string, label: string, created_at: string, extra = {}) => ({
    id,
    label,
    created_at,
    revoked_at: null as string | null,
    ...extra,
  });
  const self = { id: "me", created_at: "2026-11-10T00:00:00Z", client_type: "other" as const };

  it("turns a label into the handle a comment uses", () => {
    expect(mentionReach("Claude Code", [], self)).toEqual({
      kind: "handle",
      handle: "claude-code",
    });
    expect(mentionReach("  Gemini CLI (laptop) ", [], self)).toEqual({
      kind: "handle",
      handle: "gemini-cli-laptop",
    });
    expect(mentionReachText({ kind: "handle", handle: "claude-code" })).toBe(
      "Mention as @claude-code.",
    );
  });

  it("agent names always mean the client type", () => {
    expect(mentionReach("Claude", [], { ...self, client_type: "claude" })).toEqual({
      kind: "agent_name",
      handle: "claude",
      reached: true,
    });
    const codex = mentionReach("codex", [], self);
    expect(codex).toEqual({ kind: "agent_name", handle: "codex", reached: false });
    expect(mentionReachText(codex)).toBe("@codex means your Codex connections. Pick another name.");
    expect(mentionReachText({ kind: "agent_name", handle: "claude", reached: true })).toBe(
      "Mention as @claude, with your other Claude connections.",
    );
  });

  it("an older live connection with the same handle takes it; a revoked one does not", () => {
    const older = conn("a", "Claude-Code", "2026-11-01T00:00:00Z");
    const newer = conn("b", "claude code", "2026-11-20T00:00:00Z");
    expect(mentionReach("Claude Code", [older, newer], self)).toEqual({
      kind: "shadowed",
      handle: "claude-code",
      by: "Claude-Code",
    });
    expect(mentionReach("Claude Code", [newer], self)).toEqual({
      kind: "handle",
      handle: "claude-code",
    });
    const revoked = { ...older, revoked_at: "2026-11-02T00:00:00Z" };
    expect(mentionReach("Claude Code", [revoked], self).kind).toBe("handle");
    // A token limited to one artifact is never a target, so it shadows nothing.
    expect(mentionReach("Claude Code", [{ ...older, artifact: { id: "x" } }], self).kind).toBe(
      "handle",
    );
    // A connection that does not exist yet comes after every live one.
    expect(mentionReach("claude code", [newer], { client_type: "other" })).toMatchObject({
      kind: "shadowed",
      by: "claude code",
    });
    // Its own row never shadows itself.
    expect(
      mentionReach("Claude Code", [conn("me", "Claude Code", self.created_at)], self).kind,
    ).toBe("handle");
  });

  it("names no mention can reach", () => {
    expect(mentionReach("!!!", [], self)).toEqual({ kind: "none" });
    expect(mentionReach("-dash", [], self)).toEqual({ kind: "none" });
    expect(mentionReach("ends.", [], self)).toEqual({ kind: "none" });
    expect(mentionReachText({ kind: "none" })).toBe(
      "Cannot be mentioned: start the name with a letter or digit.",
    );
  });

  it("tokens that never pick up mentions", () => {
    expect(mentionReach("CI", [], { ...self, artifact: { id: "x" } })).toEqual({
      kind: "artifact_only",
    });
    expect(mentionReach("CI", [], { ...self, scopes: ["artifacts:read"] })).toEqual({
      kind: "no_mentions",
    });
    expect(mentionReach("CI", [], { ...self, scopes: ["artifacts:read", "mentions"] })).toEqual({
      kind: "handle",
      handle: "ci",
    });
    // The row and the dialog already show both, so the hints add nothing.
    expect(mentionReachText({ kind: "artifact_only" })).toBeNull();
    expect(mentionReachText({ kind: "no_mentions" })).toBeNull();
  });

  it("a Claude or Codex connection is also reached by its client name", () => {
    const claude = mentionReach("Laptop", [], { ...self, client_type: "claude" });
    expect(claude).toEqual({ kind: "handle", handle: "laptop", also: "claude" });
    expect(mentionReachText(claude)).toBe("Mention as @laptop or @claude.");
    expect(mentionReachText(mentionReach("Laptop", [], { ...self, client_type: "codex" }))).toBe(
      "Mention as @laptop or @codex.",
    );
  });

  it("warns only when no mention reaches the connection by its name", () => {
    expect(mentionReachWarns({ kind: "shadowed", handle: "a", by: "A" })).toBe(true);
    expect(mentionReachWarns({ kind: "none" })).toBe(true);
    expect(mentionReachWarns({ kind: "agent_name", handle: "claude", reached: false })).toBe(true);
    expect(mentionReachWarns({ kind: "agent_name", handle: "claude", reached: true })).toBe(false);
    expect(mentionReachWarns({ kind: "handle", handle: "a" })).toBe(false);
    expect(mentionReachWarns({ kind: "artifact_only" })).toBe(false);
    expect(mentionReachWarns({ kind: "no_mentions" })).toBe(false);
  });
});
