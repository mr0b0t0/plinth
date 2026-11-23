// Editing on the page is always on for owners and editors (decided 2026-11-23): no Edit toggle in
// the bar, no "Edit on the page" or source editor "Edit" in the ⋯ menu, at any width, for a doc
// or a sheet, with or without on-page editing. An editor confirmed by code gets one "Sign in to
// edit", in the ⋯ menu. While editing, the ⋯ menu holds Publish changes and Discard.
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { StageContext } from "./stageItems.tsx";
import { BAR_CONTROLS, MENU_ITEMS } from "./stageItems.tsx";

function context(
  type: "sheet" | "doc" | "html",
  live: { available: boolean; merges: boolean; signIn?: boolean },
  compact = true,
) {
  return {
    compact,
    editing: false,
    gate: { role: "owner", artifact: { type }, capabilities: [] },
    live: { signIn: false, ...live },
    hrefs: { settings: "/settings", stats: "/stats", history: "/history", signIn: "/login" },
    actions: { openShare: () => undefined },
    refs: { bar: { current: null } },
    theme: { next: "dark", set: () => undefined },
    ask: { available: false, inSlot: false },
    present: { available: false },
    comments: { open: false, count: null, toggleRef: { current: null } },
  } as unknown as StageContext;
}

const labels = (c: StageContext) =>
  MENU_ITEMS.flatMap((item) => item(c)).map((e) => ("label" in e ? e.label : ""));

const EDIT_ENTRIES = ["Edit", "Edit on the page", "Edit source", "Done editing"];

describe("the ⋯ menu and the bar have no edit entries", () => {
  for (const type of ["sheet", "doc", "html"] as const) {
    for (const available of [true, false]) {
      for (const compact of [true, false]) {
        it(`${type}, on-page editing ${available ? "on" : "off"}, ${compact ? "phone" : "wide"}`, () => {
          const c = context(type, { available, merges: type === "doc" }, compact);
          for (const label of EDIT_ENTRIES) expect(labels(c)).not.toContain(label);
          const ids = BAR_CONTROLS.map((i) => i.id);
          expect(ids).not.toContain("edit");
          expect(ids).not.toContain("sign-in-to-edit");
        });
      }
    }
  }

  it("asks an editor confirmed by code to sign in, once, in the ⋯ menu at every width", () => {
    for (const compact of [true, false]) {
      const c = context("doc", { available: true, merges: true, signIn: true }, compact);
      expect(labels(c).filter((l) => l === "Sign in to edit")).toHaveLength(1);
    }
    expect(labels(context("doc", { available: true, merges: true }))).not.toContain(
      "Sign in to edit",
    );
  });

  it("keeps Present in the bar for a deck being edited", () => {
    const present = BAR_CONTROLS.find((i) => i.id === "present");
    const c = {
      ...context("doc", { available: true, merges: true }, false),
      editing: true,
      present: { available: true, mode: "off", present: () => undefined },
    } as unknown as StageContext;
    expect(present?.render(c) as ReactElement).toBeTruthy();
  });
});

describe("the ⋯ menu while editing on the page", () => {
  const editing = (
    unpublished: boolean,
    over: {
      phase?: string;
      saving?: boolean;
      reviewing?: boolean;
      status?: { publishable?: boolean; unsavable?: true } | null;
    } = {},
    compact = false,
  ) => {
    const c = context("doc", { available: true, merges: true }, compact);
    return {
      ...c,
      editing: true,
      live: {
        ...c.live,
        unpublished,
        status: { publishable: true },
        phase: "editing",
        saving: false,
        reviewing: false,
        ...over,
      },
    } as unknown as StageContext;
  };

  it("holds Publish changes and Discard once there is something unpublished", () => {
    expect(labels(editing(true))).toEqual(
      expect.arrayContaining(["Publish changes", "Discard unpublished changes"]),
    );
    expect(labels(editing(false))).not.toContain("Discard unpublished changes");
    expect(labels(editing(false))).not.toContain("Publish changes");
  });

  it("has neither while a version waits for review (the review has its own) or publishing", () => {
    for (const over of [{ phase: "conflict" }, { saving: true }, { reviewing: true }]) {
      const l = labels(editing(true, over));
      expect(l).not.toContain("Discard unpublished changes");
      expect(l).not.toContain("Publish changes");
    }
  });

  it("offers no Publish changes for changes that cannot be a version yet", () => {
    expect(labels(editing(true, { status: { publishable: false } }))).not.toContain(
      "Publish changes",
    );
    expect(labels(editing(true, { status: { unsavable: true } }))).not.toContain("Publish changes");
    expect(labels(editing(true, { status: { publishable: false } }))).toContain(
      "Discard unpublished changes",
    );
  });

  it("has no way out of edit mode at any width", () => {
    for (const compact of [true, false]) {
      const l = labels(editing(true, {}, compact));
      expect(l).not.toContain("Done editing");
      expect(l).not.toContain("Edit on the page");
    }
  });
});
