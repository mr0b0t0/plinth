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
  const designLabels = (designExport: boolean) => {
    const c = { config: { design_export: designExport } } as unknown as StageContext;
    return labels((TYPE_MENU_ITEMS.design ?? []).flatMap((item) => item(c)));
  };

  it("offers Print or save as PDF, as a doc does, where the server does not export, and an HTML page has neither", () => {
    expect(designLabels(false)).toEqual(["Print or save as PDF"]);
    expect(TYPE_MENU_ITEMS.doc).toHaveLength(1);
    expect(TYPE_MENU_ITEMS.html).toBeUndefined();
  });

  it("offers the server's downloads instead where it exports: one way to a PDF", () => {
    expect(designLabels(true)).toEqual(["Download .png", "Download .pdf"]);
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
    ask: { available: false, inSlot: false },
  } as unknown as StageContext;
  return labels(menuEntries(c));
}

describe("no source for people", () => {
  it("leaves the source editor out of every page menu and every dashboard menu", () => {
    const design = pageMenu("design");
    expect(design).not.toContain("Edit");
    expect(design).toEqual(expect.arrayContaining(["Settings", "Stats", "Print or save as PDF"]));
    // People never see source on the page: an HTML page is changed by asking an agent.
    expect(pageMenu("html")).not.toContain("Edit");
    expect(labels(artifactMenu(summary, () => {}))).not.toContain("Edit");
    for (const type of ["html", "doc", "slides", "design_system"] as const) {
      expect(labels(artifactMenu({ ...summary, type }, () => {}))).not.toContain("Edit");
    }
  });
});
