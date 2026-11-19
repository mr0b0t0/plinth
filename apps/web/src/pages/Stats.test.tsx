import type { ArtifactStatsSummary, ArtifactStatsSummaryItem } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";
import { sortItems } from "./Stats.tsx";

async function loadPage() {
  vi.resetModules();
  return (await import("./Stats.tsx")).default;
}

const item = (over: Partial<ArtifactStatsSummaryItem>): ArtifactStatsSummaryItem => ({
  id: "a",
  slug: "a",
  title: "A",
  type: "html",
  visibility: "allowlist",
  current_version: 1,
  opens_7d: 0,
  opens_30d: 0,
  viewers_7d: 0,
  viewers_30d: 0,
  all_time_opens: 0,
  last_opened_at: null,
  ...over,
});

const ITEMS = [
  item({
    id: "1",
    slug: "plan",
    title: "Release plan",
    opens_7d: 3,
    opens_30d: 10,
    viewers_30d: 4,
    last_opened_at: "2026-11-18T10:00:00.000Z",
  }),
  item({
    id: "2",
    slug: "deck",
    title: "Board deck",
    opens_7d: 8,
    opens_30d: 9,
    viewers_30d: 6,
    last_opened_at: "2026-11-19T09:00:00.000Z",
  }),
  item({ id: "3", slug: "notes", title: "Notes" }),
];

function summary(over: Partial<ArtifactStatsSummary> = {}): ArtifactStatsSummary {
  return {
    enabled: true,
    retention_days: 365,
    generated_at: "2026-11-19T12:00:00.000Z",
    items: ITEMS,
    ...over,
  };
}

function handler(body: ArtifactStatsSummary = summary()) {
  return stubApi({
    me: ME,
    handle: (c) => (c.path === "/stats/artifacts" ? json(body) : undefined),
  });
}

const titles = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("th")?.textContent);

beforeEach(() => {
  window.history.replaceState(null, "", "/stats");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Stats", () => {
  it("lists the owner's artifacts, last opened first, each linking to its stats", async () => {
    const { calls } = handler();
    const Page = await loadPage();
    render(<Page />);
    const table = await screen.findByRole("table", { name: /Your artifacts/ });
    expect(calls.some((c) => c.path === "/stats/artifacts")).toBe(true);
    expect(screen.getByRole("heading", { name: "Stats", level: 1 })).toBeTruthy();
    expect(document.title).toBe("Stats · Plinth");
    expect(titles(table)).toEqual(["Board deck", "Release plan", "Notes"]);
    expect(screen.getByRole("link", { name: "Release plan" }).getAttribute("href")).toBe(
      "/a/plan/stats",
    );
    const notes = within(table).getAllByRole("row")[3] as HTMLElement;
    expect(notes.textContent).toContain("Never");
    const sorted = within(table).getByRole("columnheader", { name: /Last opened/ });
    expect(sorted.getAttribute("aria-sort")).toBe("descending");
  });

  it("sorts by a column, and flips it on a second click", async () => {
    handler();
    const Page = await loadPage();
    const user = userEvent.setup();
    render(<Page />);
    const table = await screen.findByRole("table", { name: /Your artifacts/ });
    await user.click(within(table).getByRole("button", { name: /Opens, 30 days/ }));
    expect(titles(table)).toEqual(["Release plan", "Board deck", "Notes"]);
    const header = within(table).getByRole("columnheader", { name: /Opens, 30 days/ });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(
      within(table)
        .getByRole("columnheader", { name: /Last opened/ })
        .getAttribute("aria-sort"),
    ).toBeNull();
    await user.click(within(table).getByRole("button", { name: /Opens, 30 days/ }));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(titles(table)).toEqual(["Notes", "Board deck", "Release plan"]);
    // Titles sort A to Z first.
    await user.click(within(table).getByRole("button", { name: /Artifact/ }));
    expect(titles(table)).toEqual(["Board deck", "Notes", "Release plan"]);
  });

  it("keeps never-opened artifacts last whichever way Last opened sorts", () => {
    const asc = sortItems(ITEMS, { key: "last_opened_at", dir: "asc" }).map((i) => i.title);
    expect(asc).toEqual(["Release plan", "Board deck", "Notes"]);
  });

  it("has an empty state without artifacts", async () => {
    handler(summary({ items: [] }));
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByRole("heading", { name: "No artifacts yet" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when the instance does not record opens", async () => {
    handler(summary({ enabled: false }));
    const Page = await loadPage();
    render(<Page />);
    expect(await screen.findByText(/This instance does not record opens/)).toBeTruthy();
  });

  it("sends a signed-out visitor to sign in", async () => {
    stubApi({ me: null });
    const Page = await loadPage();
    render(<Page />);
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });
});
