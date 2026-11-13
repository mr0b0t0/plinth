import type { CommentInfo } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import {
  applyMention,
  buildThreads,
  excerpt,
  filterThreads,
  highlightAnchors,
  mentionOptions,
  mentionQuery,
  relativeTime,
} from "./model.ts";

let n = 0;
function comment(over: Partial<CommentInfo> = {}): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "a1",
    version_number: 1,
    parent_id: null,
    author: { email: "x@example.com", connection_id: null, label: "x@example.com" },
    body: "hi",
    anchor: null,
    status: "open",
    created_at: `2026-11-13T10:00:${String(n).padStart(2, "0")}.000Z`,
    mentions: [],
    ...over,
  };
}

describe("buildThreads", () => {
  it("groups replies under roots, oldest first, and numbers anchored threads", () => {
    const a = comment({ anchor: { selector: "h1", text: "Title" } });
    const b = comment();
    const c = comment({ anchor: { selector: "p" }, status: "resolved" });
    const ra = comment({ parent_id: a.id });
    const rc = comment({ parent_id: c.id });
    const orphan = comment({ parent_id: "missing" });
    const threads = buildThreads([a, ra, b, c, rc, orphan]);
    expect(threads.map((t) => t.root.id)).toEqual([a.id, b.id, c.id]);
    expect(threads.map((t) => t.pin)).toEqual([1, null, 2]);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual([ra.id]);
    expect(threads[2]?.replies.map((r) => r.id)).toEqual([rc.id]);

    expect(filterThreads(threads, "open").map((t) => t.root.id)).toEqual([a.id, b.id]);
    expect(filterThreads(threads, "resolved").map((t) => t.root.id)).toEqual([c.id]);
    expect(filterThreads(threads, "all")).toHaveLength(3);
    // Only open anchored threads are highlighted in the frame.
    expect(highlightAnchors(threads)).toEqual([{ id: a.id, selector: "h1" }]);
  });
});

describe("mentions", () => {
  it("finds the @ token before the caret with the parseMentions token rule", () => {
    expect(mentionQuery("hey @cl", 7)).toEqual({ start: 4, query: "cl" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@claude", 14)).toBeNull();
    expect(mentionQuery("hey @cl later", 13)).toBeNull();
    expect(mentionQuery("(@co", 4)).toEqual({ start: 1, query: "co" });
  });

  it("offers @claude and @codex by prefix", () => {
    expect(mentionOptions("")).toEqual(["claude", "codex"]);
    expect(mentionOptions("C")).toEqual(["claude", "codex"]);
    expect(mentionOptions("cod")).toEqual(["codex"]);
    expect(mentionOptions("claude")).toEqual([]);
    expect(mentionOptions("x")).toEqual([]);
  });

  it("replaces the partial token and places the caret after it", () => {
    expect(applyMention("hey @cl", 7, 4, "claude")).toEqual({ text: "hey @claude ", caret: 12 });
    expect(applyMention("@c please", 2, 0, "codex")).toEqual({
      text: "@codex please",
      caret: 7,
    });
  });
});

describe("dates and excerpts", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  it("says how long ago, in words", () => {
    expect(relativeTime("2026-11-13T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-11-13T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-13T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-12T12:00:00.000Z", now)).toBe("yesterday");
    expect(relativeTime("not a date", now)).toBe("");
  });

  it("shortens anchor text", () => {
    expect(excerpt(undefined)).toBe("an element");
    expect(excerpt("  a \n b ")).toBe("a b");
    expect(excerpt("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
