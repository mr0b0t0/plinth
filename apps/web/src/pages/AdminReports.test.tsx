import type { ReportInfo } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./AdminReports.tsx")).default;
}

const report = (id: string, artifactId: string, title: string): ReportInfo => ({
  id,
  artifact_id: artifactId,
  artifact_slug: `${title.toLowerCase()}-slug`,
  artifact_title: title,
  reason: `Reason for ${title}`,
  reporter_email: null,
  state: "open",
  created_at: "2026-11-13T10:00:00.000Z",
});

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/reports");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminReports", () => {
  it("is not found for people who are not admins", async () => {
    const { calls } = stubApi({ me: ME });
    const AdminReports = await loadPage();
    render(<AdminReports />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/admin/"))).toBe(false);
  });

  it("lists open reports and takes an artifact down after confirming", async () => {
    const items = [
      report("r1", "a1", "Phish"),
      report("r2", "a1", "Phish"),
      report("r3", "a2", "Fine"),
    ];
    const { calls } = stubApi({
      me: { ...ME, is_admin: true },
      handle: (c) => {
        if (c.path === "/admin/reports?state=open") return json({ items });
        if (c.path === "/admin/reports/r1" && c.method === "POST")
          return json({ ...items[0], state: "actioned" });
        return undefined;
      },
    });
    const AdminReports = await loadPage();
    const user = userEvent.setup();
    render(<AdminReports />);
    await screen.findByText("Reason for Fine");
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>("li.pl-report"));
    expect(cards()).toHaveLength(3);
    const first = cards()[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "Phish" }).getAttribute("href")).toBe(
      "/a/phish-slug",
    );
    expect(first.textContent).toContain("an anonymous visitor");
    expect(first.textContent).toContain("Reason for Phish");

    await user.click(within(first).getByRole("button", { name: "Take down" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Take down artifact" }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(calls.find((c) => c.path === "/admin/reports/r1")?.body).toEqual({ state: "actioned" });
    // The other open report for the same artifact closed with it.
    expect(cards()[0]?.textContent).toContain("Fine");
    expect(await screen.findByText("Artifact taken down")).toBeTruthy();
  });
});
