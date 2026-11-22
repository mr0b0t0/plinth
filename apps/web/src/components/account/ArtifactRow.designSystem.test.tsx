// A design system's row and card carry the registry's badge, like a doc's, and the owner's menu
// sets or removes it as their default design system.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyDefault } from "../../pages/Dashboard.tsx";
import { ArtifactCard, ArtifactRow, artifactMenu } from "./ArtifactRow.tsx";

afterEach(cleanup);

const summary: ArtifactSummary = {
  id: "art1",
  slug: "acme-ui",
  title: "Acme UI",
  type: "design_system",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/acme-ui",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
};

describe("a design system in the dashboard", () => {
  for (const [name, View] of [
    ["row", ArtifactRow],
    ["card", ArtifactCard],
  ] as const) {
    it(`shows the Design system badge on its ${name}`, () => {
      const { container } = render(
        <ul>
          <View artifact={summary} now={Date.parse("2026-11-14T12:00:00Z")} />
        </ul>,
      );
      const badges = Array.from(
        container.querySelectorAll(".pl-badge"),
        (b) => b.textContent ?? "",
      );
      expect(badges).toEqual(["Design system"]);
    });
  }
});

describe("the default design system in the dashboard", () => {
  const labels = (entries: ReturnType<typeof artifactMenu>) =>
    entries.flatMap((e) => (e.type === "separator" ? [] : [e.label]));

  it("offers Set as default on the owner's design system, and Remove as default on the default", () => {
    const chosen: [string, boolean][] = [];
    const onDefault = (a: ArtifactSummary, on: boolean) => chosen.push([a.id, on]);
    const set = artifactMenu(summary, () => {}, undefined, onDefault);
    expect(labels(set)).toContain("Set as default");
    const item = set.find((e) => e.type !== "separator" && e.label === "Set as default");
    if (item && item.type !== "separator") item.onSelect?.();
    const remove = artifactMenu({ ...summary, default: true }, () => {}, undefined, onDefault);
    expect(labels(remove)).toContain("Remove as default");
    expect(labels(remove)).not.toContain("Set as default");
    expect(chosen).toEqual([["art1", true]]);
  });

  it("offers nothing to an editor, on another type, or when taken down", () => {
    const onDefault = () => {};
    for (const a of [
      { ...summary, role: "editor" as const },
      { ...summary, type: "html" as const },
      { ...summary, taken_down: true },
    ]) {
      const l = labels(artifactMenu(a, () => {}, undefined, onDefault));
      expect(l).not.toContain("Set as default");
      expect(l).not.toContain("Remove as default");
    }
  });

  it("says Default design system in the default's badge", () => {
    const { container } = render(
      <ul>
        <ArtifactRow
          artifact={{ ...summary, default: true }}
          now={Date.parse("2026-11-14T12:00:00Z")}
        />
      </ul>,
    );
    const badges = Array.from(container.querySelectorAll(".pl-badge"), (b) => b.textContent ?? "");
    expect(badges).toEqual(["Default design system"]);
  });

  it("applyDefault marks only the chosen one of the owner's design systems", () => {
    const two = { ...summary, id: "art2", default: true as const };
    const page = { ...summary, id: "art3", type: "html" as const };
    const shared = { ...summary, id: "art4", role: "viewer" as const, default: true as const };
    const after = applyDefault([summary, two, page, shared], "art1", true);
    expect(after.map((a) => a.default ?? false)).toEqual([true, false, false, true]);
    const off = applyDefault(after, "art1", false);
    expect(off.map((a) => a.default ?? false)).toEqual([false, false, false, true]);
  });
});
