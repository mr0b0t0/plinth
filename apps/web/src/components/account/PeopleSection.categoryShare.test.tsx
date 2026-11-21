// Settings > People with a shared category: one line says how many people see the artifact through
// it, and "Nobody else has access yet." is gone while the category grants access.
import type { ArtifactSummary, SharingSettings } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleSection } from "./SettingsSections.tsx";

const artifact: ArtifactSummary = {
  id: "art1",
  slug: "q3",
  title: "Q3 review",
  type: "html",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/q3",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: "Acme",
};

const sharing = (state: "shared" | "pending" | null): SharingSettings => ({
  visibility: "allowlist",
  has_password: false,
  grants: [],
  public_allowed: false,
  category_share: state
    ? {
        id: "share00000000000000a",
        title: "Acme Corp",
        state,
        people: [
          { email: "a@acme.example", role: "viewer" },
          { email: "b@acme.example", role: "commenter" },
        ],
      }
    : null,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PeopleSection: a shared category", () => {
  it("one line names the people who see it through the category, with Manage", () => {
    render(
      <PeopleSection
        artifact={artifact}
        sharing={sharing("shared")}
        ownerEmail="ada@example.org"
        onChange={vi.fn()}
      />,
    );
    const line = screen.getByText(/2 people via Acme/);
    expect(line.querySelector("a")?.textContent).toBe("Manage");
    expect(screen.queryByText("Nobody else has access yet.")).toBeNull();
  });

  it("an artifact still waiting for review says nobody else has access", () => {
    render(
      <PeopleSection
        artifact={artifact}
        sharing={sharing("pending")}
        ownerEmail="ada@example.org"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/via Acme/)).toBeNull();
    expect(screen.getByText("Nobody else has access yet.")).toBeTruthy();
  });
});
