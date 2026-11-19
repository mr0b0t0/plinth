import type { CommentInfo } from "@plinth/shared";
import { describe, expect, it } from "vitest";
import { anchorLabel, buildThreads, highlightAnchors, pageThreadItems } from "./model.ts";

let n = 0;
function c(over: Partial<CommentInfo> = {}): CommentInfo {
  n += 1;
  return {
    id: `c${n}`,
    artifact_id: "a",
    version_number: 1,
    parent_id: null,
    author: { email: null, connection_id: null, label: "x" },
    body: "b",
    anchor: null,
    status: "open",
    created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    mentions: [],
    kind: "comment",
    request_data: null,
    ...over,
  };
}

describe("page anchors in the thread model", () => {
  it("numbers pins across element and page anchors, oldest first", () => {
    const threads = buildThreads([
      c({ anchor: { selector: "h1" } }),
      c(),
      c({ anchor: { kind: "page", key: "canvas", x: 1, y: 2 } }),
      c({ anchor: { selector: "p", x: 0.5, y: 0.5 } }),
    ]);
    expect(threads.map((t) => t.pin)).toEqual([1, null, 2, 3]);
    // Only element anchors are highlighted by the bridge.
    expect(highlightAnchors(threads).map((h) => h.selector)).toEqual(["h1", "p"]);
  });

  it("builds the page's thread list without any text", () => {
    const page = c({
      anchor: { kind: "page", key: "k", x: -5, text: "chip label", data: { zoom: 2 } },
      status: "resolved",
    });
    const el = c({ anchor: { selector: "#x", text: "excerpt", x: 0.1, y: 0.2 } });
    const items = pageThreadItems(buildThreads([page, el, c()]));
    expect(items).toEqual([
      {
        id: page.id,
        pin: 1,
        status: "resolved",
        anchor: { kind: "page", key: "k", x: -5, data: { zoom: 2 } },
      },
      { id: el.id, pin: 2, status: "open", anchor: { kind: "element", selector: "#x" } },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/chip label|excerpt/);
  });

  it("caps the page's list at 500 threads", () => {
    const many = Array.from({ length: 520 }, () => c({ anchor: { kind: "page", key: "a" } }));
    expect(pageThreadItems(buildThreads(many))).toHaveLength(500);
  });

  it("labels an anchor by its text, else a page anchor's key", () => {
    expect(anchorLabel({ kind: "page", key: "slide-3" })).toBe("slide-3");
    expect(anchorLabel({ kind: "page", key: "slide-3", text: "Slide 3" })).toBe("Slide 3");
    expect(anchorLabel({ selector: "h1" })).toBe("an element");
    expect(anchorLabel(null)).toBe("an element");
  });
});
