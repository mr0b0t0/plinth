// A sheet edited on its page has one way into editing: the Edit toggle (or, at phone width, "Edit
// on the page" in the ⋯ menu). A sheet has no source editor, so there is no Edit source beside it,
// and without on-page editing there is no Edit at all.
import { describe, expect, it } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { MENU_ITEMS } from "./stageItems.tsx";

function context(type: "sheet" | "doc", live: { available: boolean; merges: boolean }) {
  return {
    compact: true,
    editing: false,
    gate: { role: "owner", artifact: { type }, capabilities: [] },
    live: { ...live, signIn: false },
    hrefs: { edit: "/edit", settings: "/settings", stats: "/stats", history: "/history" },
    actions: { toggleEditing: () => undefined, openShare: () => undefined },
    theme: { next: "dark", set: () => undefined },
  } as unknown as StageContext;
}

const labels = (c: StageContext) =>
  MENU_ITEMS.flatMap((item) => item(c)).map((e) => ("label" in e ? e.label : ""));

describe("the ⋯ menu's edit entries", () => {
  it("a sheet edited on its page: Edit on the page only, no Edit source", () => {
    const l = labels(context("sheet", { available: true, merges: false }));
    expect(l).toContain("Edit on the page");
    expect(l).not.toContain("Edit source");
  });

  it("a sheet without on-page editing has no Edit: agents change it", () => {
    const l = labels(context("sheet", { available: false, merges: false }));
    expect(l).not.toContain("Edit");
    expect(l).not.toContain("Edit source");
    expect(l).not.toContain("Edit on the page");
  });

  it("a doc is unchanged: Edit on the page and Edit source", () => {
    const l = labels(context("doc", { available: true, merges: true }));
    expect(l).toEqual(expect.arrayContaining(["Edit on the page", "Edit source"]));
  });
});
