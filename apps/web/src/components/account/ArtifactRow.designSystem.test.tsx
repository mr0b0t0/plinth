// A design system's row and card carry the registry's badge, like a doc's.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactCard, ArtifactRow } from "./ArtifactRow.tsx";

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
