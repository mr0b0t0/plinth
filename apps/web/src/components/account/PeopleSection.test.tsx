import type { ArtifactSummary, SharingSettings } from "@plinth/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeopleSection } from "./SettingsSections.tsx";

afterEach(cleanup);

const artifact = {
  id: "art1",
  slug: "plan",
  title: "Release plan",
  version_count: 1,
} as ArtifactSummary;

const sharing: SharingSettings = {
  visibility: "allowlist",
  has_password: false,
  public_allowed: false,
  grants: [
    { email: "bo@example.org", role: "editor", created_at: "2026-11-19T00:00:00Z", name: "Bo" },
    { email: "cy@example.org", role: "viewer", created_at: "2026-11-19T00:00:00Z", name: null },
  ],
};

describe("PeopleSection", () => {
  it("shows the name beside the email when the account has one", () => {
    render(
      <PeopleSection
        artifact={artifact}
        sharing={sharing}
        ownerEmail="ada@example.org"
        onChange={() => {}}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]?.querySelector(".pl-acct-person__email")?.textContent).toBe("Bo bo@example.org");
    expect(rows[1]?.querySelector(".pl-acct-person__email")?.textContent).toBe("cy@example.org");
    // Controls still name the address, which is what the grant is.
    expect(screen.getByRole("button", { name: "Remove bo@example.org" })).toBeTruthy();
  });
});
