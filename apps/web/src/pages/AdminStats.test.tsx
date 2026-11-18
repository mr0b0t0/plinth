import type { AdminStats, StatsDay } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./AdminStats.tsx")).default;
}

const ADMIN = { ...ME, is_admin: true };

function series(days: number): StatsDay[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 18) - (days - 1 - i) * 86_400_000);
    return {
      day: d.toISOString().slice(0, 10),
      users: i === days - 1 ? 2 : 0,
      artifacts: 1,
      publishes: 3,
      agent_publishes: 2,
      views: i === days - 2 ? 51 : 1,
      artifacts_viewed: 1,
    };
  });
}

function stats(days = 30, overrides: Partial<AdminStats> = {}): AdminStats {
  return {
    generated_at: "2026-11-18T12:00:00.000Z",
    days,
    view_counts: true,
    totals: {
      users: 1234,
      artifacts: 57,
      artifacts_by_visibility: { public: 3, unlisted: 4, password: 0, allowlist: 50 },
      artifacts_taken_down: 1,
      versions: 4321,
      agent_versions: 4000,
      storage_bytes: 2_400_000,
      data_docs: 12,
      data_bytes: 900,
      data_artifacts: 2,
      connections: 9,
      connections_by_client: { claude: 5, codex: 3, other: 1 },
      views: 98765,
      open_reports: 2,
    },
    window: {
      new_users: 8,
      new_artifacts: 6,
      publishes: 90,
      agent_publishes: 60,
      connections_used: 4,
      views: 412,
      artifacts_viewed: 7,
    },
    series: series(days),
    ...overrides,
  };
}

function statsHandler(override?: (days: number) => AdminStats) {
  return stubApi({
    me: ADMIN,
    handle: (c) => {
      const m = /^\/admin\/stats\?days=(\d+)$/.exec(c.path);
      if (!m) return undefined;
      const days = Number(m[1]);
      return json(override ? override(days) : stats(days));
    },
  });
}

const tile = (label: string) => {
  const dt = screen.getAllByText(label, { selector: "dt" })[0];
  return dt?.parentElement as HTMLElement;
};

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/stats");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminStats", () => {
  it("is not found for people who are not admins, and asks the API nothing", async () => {
    const { calls } = stubApi({ me: ME });
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/admin/"))).toBe(false);
  });

  it("shows the tiles with formatted numbers and sizes", async () => {
    const { calls } = statsHandler();
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByRole("heading", { name: "Stats", level: 1 })).toBeTruthy();
    await screen.findByText("Opens, last 30 days", { selector: "dt" });
    expect(document.title).toBe("Stats · Plinth");
    expect(calls.some((c) => c.path === "/admin/stats?days=30")).toBe(true);

    expect(tile("People").textContent).toContain("1,234");
    expect(tile("People").textContent).toContain("+8 in the last 30 days");
    const artifacts = tile("Artifacts").textContent ?? "";
    expect(artifacts).toContain("57");
    expect(artifacts).toContain("3 public");
    expect(artifacts).toContain("50 private");
    expect(artifacts).not.toContain("password");
    expect(artifacts).toContain("1 taken down");
    // Period figures say so in their label; the rest are instance totals.
    const publishes = tile("Publishes, last 30 days").textContent ?? "";
    expect(publishes).toContain("90");
    expect(publishes).toContain("60 by agents");
    expect(publishes).toContain("4,321 versions kept on live pages");
    expect(tile("Storage").textContent).toContain("2.4 MB");
    expect(tile("Shared data entries").textContent).toContain("12");
    expect(tile("Shared data entries").textContent).toContain("900 B on 2 pages");
    expect(tile("Agent connections").textContent).toContain("4 used in the last 30 days");
    expect(tile("Agent connections").textContent).toContain("Claude 5");
    expect(tile("Opens, last 30 days").textContent).toContain("412");
    expect(tile("Opens, last 30 days").textContent).toContain("98,765 counted in all");
    const reports = tile("Open reports");
    expect(within(reports).getByRole("link").getAttribute("href")).toBe("/admin/reports");
    for (const dd of document.querySelectorAll(".pl-stat__value")) {
      expect(dd.classList.contains("type-num")).toBe(true);
    }
  });

  it("gives every chart a summary and a table of numbers, one row per day", async () => {
    statsHandler();
    const Page = await loadPage();
    render(<Page />);
    await screen.findByText("Opens per day", { selector: ".pl-trend__title" });
    const figures = document.querySelectorAll("figure.pl-trend");
    expect(figures.length).toBe(4);
    for (const fig of figures) {
      expect(fig.querySelector("figcaption")?.textContent).toMatch(/Last 30 days/);
      expect(fig.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(fig.querySelector("details summary")?.textContent).toBe("Show numbers");
      expect(fig.querySelectorAll("tbody tr").length).toBe(30);
    }
    const opens = figures[0] as HTMLElement;
    expect(opens.querySelector("figcaption")?.textContent).toContain("most on 2026-11-17 (51)");
    // Publishes stack agents and people, with a legend and a column each.
    const publishes = figures[1] as HTMLElement;
    const headers = Array.from(publishes.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual(["Day", "By agents", "By people", "Total"]);
    expect(publishes.querySelector(".pl-trend__legend")?.textContent).toContain("By people");
  });

  it("asks for 7 days when the period changes", async () => {
    const { calls } = statsHandler();
    const Page = await loadPage();
    const user = userEvent.setup();
    render(<Page />);
    await screen.findByText("Opens per day", { selector: ".pl-trend__title" });
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/admin/stats?days=7")).toBe(true));
    await waitFor(() =>
      expect(document.querySelector("figure.pl-trend tbody")?.querySelectorAll("tr").length).toBe(
        7,
      ),
    );
    expect(tile("Publishes, last 7 days")).toBeTruthy();
    expect(tile("Opens, last 7 days")).toBeTruthy();
    expect(tile("People").textContent).toContain("in the last 7 days");
  });

  it("leaves out an empty caption on an instance with no artifacts", async () => {
    statsHandler((days) => {
      const s = stats(days);
      return {
        ...s,
        totals: {
          ...s.totals,
          artifacts: 0,
          artifacts_taken_down: 0,
          artifacts_by_visibility: { public: 0, unlisted: 0, password: 0, allowlist: 0 },
        },
      };
    });
    const Page = await loadPage();
    render(<Page />);
    await screen.findByText("Opens, last 30 days", { selector: "dt" });
    expect(tile("Artifacts").querySelector(".pl-stat__caption")).toBeNull();
    expect(tile("People").querySelector(".pl-stat__caption")).toBeTruthy();
  });

  it("says when stats could not load, and tries again", async () => {
    let fail = true;
    const { calls } = stubApi({
      me: ADMIN,
      handle: (c) => {
        if (!c.path.startsWith("/admin/stats")) return undefined;
        return fail ? apiError(500, "internal", "Something broke") : json(stats());
      },
    });
    const Page = await loadPage();
    const user = userEvent.setup();
    render(<Page />);
    expect(await screen.findByText("Stats could not be loaded")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Opens, last 30 days", { selector: "dt" });
    expect(calls.filter((c) => c.path.startsWith("/admin/stats")).length).toBe(2);
  });

  it("reads Off when the instance does not count opens", async () => {
    statsHandler((days) => stats(days, { view_counts: false }));
    const Page = await loadPage();
    render(<Page />);
    await screen.findByText("Opens", { selector: "dt" });
    expect(tile("Opens").querySelector(".pl-stat__value")?.textContent).toBe("Off");
    expect(tile("Opens").textContent).toContain("VIEW_COUNTS");
    // The chart says counting is off, so a drop to zero does not read as traffic stopping.
    const opens = document.querySelector("figure.pl-trend") as HTMLElement;
    expect(opens.querySelector("figcaption")?.textContent).toContain(
      "Counting is turned off on this instance (VIEW_COUNTS)",
    );
    const publishes = document.querySelectorAll("figure.pl-trend")[1] as HTMLElement;
    expect(publishes.querySelector("figcaption")?.textContent).not.toContain("turned off");
  });

  it("goes to the dashboard when the API says not found (no longer an admin)", async () => {
    stubApi({
      me: ADMIN,
      handle: (c) => (c.path.startsWith("/admin/stats") ? apiError(404, "not_found") : undefined),
    });
    const Page = await loadPage();
    render(<Page />);
    await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
  });
});
