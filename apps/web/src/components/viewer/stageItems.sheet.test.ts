// A sheet edited on its page has one way into editing: the Edit toggle (or, at phone width, "Edit
// on the page" in the ⋯ menu). A sheet has no source editor, so there is no Edit source beside it,
// and without on-page editing there is no Edit at all.
import { typeDef } from "@plinth/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { BAR_CONTROLS, MENU_ITEMS } from "./stageItems.tsx";

function context(
  type: "sheet" | "doc",
  live: { available: boolean; merges: boolean },
  compact = true,
) {
  return {
    compact,
    editing: false,
    gate: { role: "owner", artifact: { type }, capabilities: [] },
    live: { ...live, signIn: false },
    hrefs: { edit: "/edit", settings: "/settings", stats: "/stats", history: "/history" },
    actions: { toggleEditing: () => undefined, openShare: () => undefined },
    refs: { edit: { current: null }, bar: { current: null } },
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

  it("a sheet has no source editor and still offers the page's Edit toggle", () => {
    // The registry says both: no source editor (editor null) and on-page editing (`edit:
    // "live"`). The toggle follows that (the gate's `live`), never `editor`.
    expect(typeDef("sheet")).toMatchObject({ editor: null, edit: "live" });
    const wide = context("sheet", { available: true, merges: false }, false);
    const edit = BAR_CONTROLS.find((i) => i.id === "edit")?.render(wide) as ReactElement<{
      children: ReactElement<{ "aria-label": string }>;
    }>;
    expect(edit).toBeTruthy();
    expect(edit.props.children.props["aria-label"]).toBe("Edit");
    const l = labels(wide);
    expect(l).not.toContain("Edit source");
    expect(l).not.toContain("Edit");
  });

  it("a doc is unchanged: Edit on the page and Edit source", () => {
    const l = labels(context("doc", { available: true, merges: true }));
    expect(l).toEqual(expect.arrayContaining(["Edit on the page", "Edit source"]));
  });
});
