// A design's row and card carry the registry's badge, like a doc's, and its menu prints it the way
// a doc's does. People never see a design's source: neither its row nor its page offers Edit.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MenuEntry } from "../ui/index.ts";
import { menuEntries, type StageContext, TYPE_MENU_ITEMS } from "../viewer/stageItems.tsx";
import { ArtifactCard, ArtifactRow, artifactMenu } from "./ArtifactRow.tsx";

afterEach(cleanup);

const summary: ArtifactSummary = {
  id: "art1",
  slug: "launch-kit",
  title: "Launch kit",
  type: "design",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/launch-kit",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
};

describe("a design in the dashboard", () => {
  for (const [name, View] of [
    ["row", ArtifactRow],
    ["card", ArtifactCard],
  ] as const) {
    it(`shows the Design badge on its ${name}`, () => {
      const { container } = render(
        <ul>
          <View artifact={summary} now={Date.parse("2026-11-14T12:00:00Z")} />
        </ul>,
      );
      const badges = Array.from(
        container.querySelectorAll(".pl-badge"),
        (b) => b.textContent ?? "",
      );
      expect(badges).toEqual(["Design"]);
    });
  }
});

describe("a design's menu", () => {
  it("offers Print or save as PDF, as a doc does, then the server export, and an HTML page has neither", () => {
    // Print first, as for a doc; then "Download PNG or PDF…" (designItems.ts), which shows only
    // where the instance renders exports (ExportDialog.test.tsx).
    expect(TYPE_MENU_ITEMS.design?.[0]).toBe(TYPE_MENU_ITEMS.doc?.[0]);
    expect(TYPE_MENU_ITEMS.doc).toHaveLength(1);
    expect(TYPE_MENU_ITEMS.design).toHaveLength(2);
    expect(TYPE_MENU_ITEMS.html).toBeUndefined();
  });
});

const labels = (entries: MenuEntry[]) => entries.map((e) => ("label" in e ? e.label : "—"));

/** The page's ⋯ menu for an owner on a wide screen, for an artifact of `type`. */
function pageMenu(type: ArtifactSummary["type"]) {
  const c = {
    gate: { status: "ok", role: "owner", artifact: { type } },
    compact: false,
    live: { available: false, signIn: false },
    editing: false,
    frame: null,
    config: null,
    contentOrigin: "",
    hrefs: { edit: "/e", settings: "/s", stats: "/t", report: "/r", history: "/h" },
    theme: { next: "dark", set: () => {} },
  } as unknown as StageContext;
  return labels(menuEntries(c));
}

describe("no source for people", () => {
  it("leaves Edit out of a design's page menu and dashboard menu, and keeps it for a page", () => {
    const design = pageMenu("design");
    expect(design).not.toContain("Edit");
    expect(design).toEqual(expect.arrayContaining(["Settings", "Stats", "Print or save as PDF"]));
    expect(pageMenu("html")).toContain("Edit");
    expect(labels(artifactMenu(summary, () => {}))).not.toContain("Edit");
    expect(labels(artifactMenu({ ...summary, type: "html" }, () => {}))).toContain("Edit");
  });
});
