// Where a doc's "Comment" points: the block as the published version (the one the
// agent reads) names it, whatever was added, moved or deleted above it in the draft.
import { describe, expect, it } from "vitest";
import { askKey, matchBlocks } from "./askAnchor.ts";

const PUBLISHED = "# Title\n\nIntro\n\n- a\n- b\n\nEnd";

describe("askKey", () => {
  it("names an unchanged draft as the published version does", () => {
    expect(askKey(PUBLISHED, PUBLISHED, 2)).toEqual({ key: "block-3", published: true });
    expect(askKey(PUBLISHED, PUBLISHED, 0, "replace").key).toBe("block-1:image");
    expect(askKey(PUBLISHED, PUBLISHED, 3, "add").key).toBe("block-4:add-image");
  });

  it("follows a block past inserts and deletes above it in the draft", () => {
    // Two blocks inserted above "- a", "Intro" deleted.
    const draft = "# Title\n\nNew one\n\nNew two\n\n- a\n- b\n\nEnd";
    expect(askKey(draft, PUBLISHED, 3)).toEqual({ key: "block-3", published: true });
    expect(askKey(draft, PUBLISHED, 4).key).toBe("block-4");
    // A block moved up keeps its published number.
    const moved = "End\n\n# Title\n\nIntro\n\n- a\n- b";
    expect(askKey(moved, PUBLISHED, 3).key).toBe("block-3");
  });

  it("names a block only in the draft after the published block above it, as not published", () => {
    const draft = "# Title\n\nNew one\n\nIntro\n\nChanged\n\nEnd";
    expect(askKey(draft, PUBLISHED, 1)).toEqual({ key: "new-1", published: false });
    // An edited block is not the published one: it is new, after the block above it.
    expect(askKey(draft, PUBLISHED, 3)).toEqual({ key: "new-2", published: false });
    expect(askKey("First\n\n# Title", PUBLISHED, 0).key).toBe("new-0");
    expect(askKey(draft, PUBLISHED, 1, "add").key).toBe("new-1:add-image");
  });
});

describe("matchBlocks", () => {
  it("matches blocks in order, the longest common run, repeats included", () => {
    expect(matchBlocks(["a", "x", "b", "a"], ["a", "b", "a"])).toEqual([0, -1, 1, 2]);
    expect(matchBlocks(["b", "a"], ["a", "b"])).toEqual([-1, 0]);
    expect(matchBlocks([], ["a"])).toEqual([]);
  });
});
