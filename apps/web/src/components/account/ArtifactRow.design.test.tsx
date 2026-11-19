// A design's row and card carry the registry's badge, like a doc's, and its menu prints it the way
// a doc's does.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_MENU_ITEMS } from "../viewer/stageItems.tsx";
import { ArtifactCard, ArtifactRow } from "./ArtifactRow.tsx";

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
