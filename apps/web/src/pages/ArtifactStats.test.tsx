import type { ArtifactStats, ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./ArtifactStats.tsx")).default;
}

const artifact = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: "art1",
  slug: "plan",
  title: "Release plan",
  type: "html",
  visibility: "allowlist",
  current_version: 3,
  version_count: 3,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/plan",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  ...over,
});

function stats(days: ArtifactStats["days"] = 30, over: Partial<ArtifactStats> = {}): ArtifactStats {
  const series = Array.from({ length: days }, (_, i) => ({
    day: new Date(Date.UTC(2026, 10, 19) - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    opens: i === days - 1 ? 4 : 0,
    viewers: i === days - 1 ? 3 : 0,
  }));
  return {
    enabled: true,
    days,
    retention_days: 365,
    current_version: 3,
    totals: {
      opens: 1234,
      viewers: 7,
      people: 2,
      anonymous_visitors: 5,
      anonymous_opens: 9,
      all_time_opens: 2000,
      since: "2026-08-02",
    },
    series,
    people: [
      {
        name: "Bo Builder",
        email: "bo@example.org",
        kind: "user",
        role: "editor",
        first_opened_at: "2026-11-02T10:00:00.000Z",
        last_opened_at: "2026-11-18T10:00:00.000Z",
        opens: 6,
        last_version_seen: 3,
      },
      {
        name: null,
        email: "cy@example.org",
        kind: "email",
        role: "viewer",
        first_opened_at: "2026-11-03T10:00:00.000Z",
        last_opened_at: "2026-11-10T10:00:00.000Z",
        opens: 2,
        last_version_seen: 2,
      },
    ],
    people_total: 2,
    versions: [
      { version: 3, opens: 5, viewers: 3 },
      { version: 2, opens: 4, viewers: 2 },
    ],
    ...over,
  };
}

function handler(opts: { artifact?: ArtifactSummary; stats?: (days: number) => Response } = {}) {
  return stubApi({
    me: ME,
    handle: (c) => {
      if (c.path === "/artifacts/plan") return json(opts.artifact ?? artifact());
      const m = /^\/artifacts\/art1\/stats\?days=(\d+)$/.exec(c.path);
      if (!m) return undefined;
      const days = Number(m[1]);
      return opts.stats ? opts.stats(days) : json(stats(days as ArtifactStats["days"]));
    },
  });
}

const tile = (label: string) => {
  const dt = screen.getAllByText(label, { selector: "dt" })[0];
  return dt?.parentElement as HTMLElement;
};

beforeEach(() => {
  window.history.replaceState(null, "", "/a/plan/stats");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ArtifactStats", () => {
  it("shows the tiles, charts and footnote for the owner over 30 days by default", async () => {
    const { calls } = handler();
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    await screen.findByText("Opens, last 30 days", { selector: "dt" });
    expect(calls.some((c) => c.path === "/artifacts/art1/stats?days=30")).toBe(true);
    await waitFor(() => expect(document.title).toBe("Stats · Release plan · Plinth"));
    expect(tile("Opens, last 30 days").textContent).toContain("1,234");
    expect(tile("Opens, last 30 days").textContent).toContain("9 anonymous");
    expect(tile("Viewers, last 30 days").textContent).toContain("7");
    expect(tile("People").textContent).toContain("2");
    expect(tile("Anonymous visitors").textContent).toContain("Approximate");
    expect(tile("Opens in all").textContent).toContain("Since 2 Aug 2026");
    const titles = Array.from(document.querySelectorAll("figure.pl-trend .pl-trend__title"));
    expect(titles.map((t) => t.textContent)).toEqual(["Opens per day", "Viewers per day"]);
    // One bar slot per day of the window.
    expect(document.querySelector("figure.pl-trend tbody")?.querySelectorAll("tr").length).toBe(30);
    expect(document.body.textContent).toContain("for 365 days, and after that only counted");
    // The title links back to the artifact.
    expect(screen.getByRole("link", { name: "Release plan" }).getAttribute("href")).toBe("/a/plan");
  });

  it("lists people, marking anyone who last saw an older version", async () => {
    handler();
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    const table = await screen.findByRole("table", { name: "People who opened this artifact" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const [bo, cy] = rows as [HTMLElement, HTMLElement];
    expect(bo.textContent).toContain("Bo Builder");
    expect(bo.textContent).toContain("bo@example.org");
    expect(bo.textContent).toContain("Editor");
    expect(bo.textContent).toContain("v3");
    expect(bo.textContent).not.toContain("Not the latest version");
    expect(cy.textContent).toContain("cy@example.org");
    expect(cy.textContent).toContain("v2");
    expect(cy.textContent).toContain("Not the latest version");
  });

  it("shows opens per version, the current one marked", async () => {
    handler();
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    const table = await screen.findByRole("table", { name: "Opens per version" });
    const rows = within(table).getAllByRole("row").slice(1);
    const cells = rows.map((r) => Array.from(r.children, (c) => c.textContent));
    expect(cells).toEqual([
      ["v3Current", "5", "3"],
      ["v2", "4", "2"],
    ]);
  });

  it("says when the people list is cut", async () => {
    handler({ stats: (d) => json(stats(d as ArtifactStats["days"], { people_total: 812 })) });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect((await screen.findByText(/^Showing the/)).textContent).toBe(
      "Showing the 2 who opened it most recently, of 812 people.",
    );
  });

  it("fetches another window from the range picker and keeps it in ?days=", async () => {
    const { calls } = handler();
    const Page = await loadPage();
    const user = userEvent.setup();
    render(<Page params={{ slug: "plan" }} />);
    await screen.findByText("Opens, last 30 days", { selector: "dt" });
    await user.click(screen.getByRole("radio", { name: "365 days" }));
    await screen.findByText("Opens, last 365 days", { selector: "dt" });
    expect(calls.some((c) => c.path === "/artifacts/art1/stats?days=365")).toBe(true);
    expect(window.location.search).toBe("?days=365");
  });

  it("starts from ?days=", async () => {
    window.history.replaceState(null, "", "/a/plan/stats?days=7");
    const { calls } = handler();
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    await screen.findByText("Opens, last 7 days", { selector: "dt" });
    expect(calls.some((c) => c.path === "/artifacts/art1/stats?days=7")).toBe(true);
    expect((screen.getByRole("radio", { name: "7 days" }) as HTMLInputElement).checked).toBe(true);
  });

  it("has an empty state before the first open", async () => {
    const empty = stats(30, {
      totals: {
        opens: 0,
        viewers: 0,
        people: 0,
        anonymous_visitors: 0,
        anonymous_opens: 0,
        all_time_opens: 0,
        since: null,
      },
      people: [],
      people_total: 0,
      versions: [],
    });
    handler({ stats: () => json(empty) });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect(await screen.findByRole("heading", { name: "No opens yet" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when the instance does not record opens", async () => {
    handler({ stats: (d) => json(stats(d as ArtifactStats["days"], { enabled: false })) });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect(await screen.findByText(/This instance does not record opens/)).toBeTruthy();
    // What was recorded is still shown.
    expect(screen.getByRole("table", { name: "People who opened this artifact" })).toBeTruthy();
  });

  it("says why when the artifact was taken down", async () => {
    handler({
      stats: () =>
        json(
          {
            error: {
              code: "forbidden",
              message: "This artifact was taken down.",
              details: { reason: "taken_down" },
            },
          },
          403,
        ),
    });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect(
      await screen.findByRole("heading", { name: "This artifact was taken down", level: 1 }),
    ).toBeTruthy();
  });

  it("tells a collaborator only the owner sees it, and never asks for the stats", async () => {
    const { calls } = handler({ artifact: artifact({ role: "editor" }) });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect(
      await screen.findByRole("heading", { name: "Only the owner can see who opened it" }),
    ).toBeTruthy();
    expect(calls.some((c) => c.path.includes("/stats"))).toBe(false);
  });

  it("is not found for an artifact the person cannot see", async () => {
    stubApi({
      me: ME,
      handle: (c) => (c.path === "/artifacts/plan" ? apiError(404, "not_found") : undefined),
    });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    expect(await screen.findByRole("heading", { name: "Artifact not found" })).toBeTruthy();
  });

  it("sends a signed-out visitor to sign in", async () => {
    stubApi({ me: null });
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });
});
