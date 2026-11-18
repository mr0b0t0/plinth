import { type ArtifactViews, CSRF_HEADER, type DataSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { apiError, json, stubApi } from "./test-utils.ts";

const summary = (docs: number, bytes: number, caps: DataSummary["capabilities"] = ["data"]) =>
  ({
    capabilities: caps,
    available: true,
    usage: { docs, bytes },
    limits: { max_doc_bytes: 16384, max_docs: 1000, max_bytes: 1048576 },
    collections: [],
    untrusted: "UNTRUSTED",
  }) satisfies DataSummary;

const views = (last30: number, total: number, enabled = true): ArtifactViews => ({
  enabled,
  total,
  last_7: Math.min(last30, 2),
  last_30: last30,
  days: Array.from({ length: 30 }, (_, i) => ({
    day: `2026-10-${String(i + 1).padStart(2, "0")}`,
    views: i === 29 ? last30 : 0,
  })),
});

function renderDialog(isOwner = true, open = true) {
  return render(
    <>
      <ShareDialog
        open={open}
        onClose={() => undefined}
        link="http://app.localhost:8787/a/s1"
        slug="s1"
        visibility="allowlist"
        isOwner={isOwner}
      />
      <Toaster />
    </>,
  );
}

beforeEach(() => {
  // Both cookie names, so the token is found whichever name this location uses.
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShareDialog shared data", () => {
  it("shows the owner how much shared data there is", async () => {
    const { calls } = stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(3, 2400)) : undefined),
    });
    renderDialog();
    expect((await screen.findByText(/Shared data:/)).textContent).toBe(
      "Shared data: 3 entries, 2.4 KB",
    );
    expect(calls.some((c) => c.method === "GET" && c.path === "/artifacts/s1/data")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete all shared data" })).toBeTruthy();
  });

  it("says one entry, and shows the row for a declaration with no data yet", async () => {
    stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(1, 120)) : undefined),
    });
    renderDialog();
    expect((await screen.findByText(/Shared data:/)).textContent).toBe(
      "Shared data: 1 entry, 120 B",
    );
    cleanup();

    stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(0, 0)) : undefined),
    });
    renderDialog();
    expect((await screen.findByText(/Shared data:/)).textContent).toBe(
      "Shared data: 0 entries, 0 B",
    );
    // Nothing to delete.
    expect(screen.queryByRole("button", { name: "Delete all shared data" })).toBeNull();
  });

  it("hides the row when there is no data and no declaration", async () => {
    const { calls } = stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(0, 0, [])) : undefined),
    });
    renderDialog();
    await waitFor(() => expect(calls.some((c) => c.path === "/artifacts/s1/data")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Shared data/)).toBeNull();
  });

  it("does not load shared data for people who are not the owner", async () => {
    const { calls } = stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? json(summary(3, 2400)) : undefined),
    });
    renderDialog(false);
    await screen.findByRole("dialog", { name: "Share this artifact" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.path.includes("/data"))).toBe(false);
    expect(screen.queryByText(/Shared data/)).toBeNull();
  });

  it("asks before deleting, sends DELETE with the CSRF header, then refreshes", async () => {
    let docs = 3;
    const { calls } = stubApi({
      handle: (c) => {
        if (c.path !== "/artifacts/s1/data") return undefined;
        if (c.method === "DELETE") {
          const deleted = docs;
          docs = 0;
          return json({ deleted });
        }
        return json(summary(docs, docs * 800));
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Delete all shared data" }));

    // A confirmation first; cancelling sends nothing.
    const confirm = await screen.findByRole("alertdialog", { name: /Delete all shared data/ });
    expect(confirm.textContent).toContain("3 entries");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await screen.findByRole("dialog", { name: "Share this artifact" });

    await user.click(screen.getByRole("button", { name: "Delete all shared data" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Delete 3 entries" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const del = calls.find((c) => c.method === "DELETE");
    expect(del).toMatchObject({ path: "/artifacts/s1/data" });
    expect(del?.headers[CSRF_HEADER]).toBe("tok-123");

    // Back in the share dialog, with fresh numbers.
    expect(
      (await screen.findByText("Shared data: 0 entries, 0 B")).closest('[role="dialog"]'),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && c.path === "/artifacts/s1/data").length).toBe(
      2,
    );
    expect(await screen.findByText("Shared data deleted")).toBeTruthy();
  });

  it("shows an error when the delete fails, and keeps the data", async () => {
    stubApi({
      handle: (c) => {
        if (c.path !== "/artifacts/s1/data") return undefined;
        if (c.method === "DELETE") return apiError(403, "forbidden", "Only the owner can do that.");
        return json(summary(2, 900));
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Delete all shared data" }));
    await user.click(await screen.findByRole("button", { name: "Delete 2 entries" }));
    const msg = await screen.findByText(/Could not delete the shared data/);
    expect(msg.closest('[role="alert"]')?.closest('[role="dialog"]')).toBeTruthy();
    expect(msg.textContent).toContain("Only the owner can do that.");
    expect(screen.getByText("Shared data: 2 entries, 900 B")).toBeTruthy();
  });

  it("says so when the usage cannot be loaded", async () => {
    stubApi({
      handle: (c) => (c.path === "/artifacts/s1/data" ? apiError(500, "internal") : undefined),
    });
    renderDialog();
    const msg = await screen.findByText(/Could not load the shared data/);
    expect(msg.closest('[role="alert"]')?.closest('[role="dialog"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete all shared data" })).toBeNull();
  });
});

describe("ShareDialog open counts", () => {
  const handler = (v: ArtifactViews | Response) =>
    stubApi({
      handle: (c) => {
        if (c.path === "/artifacts/s1/views") return v instanceof Response ? v : json(v);
        if (c.path === "/artifacts/s1/data") return json(summary(0, 0, []));
        return undefined;
      },
    });

  it("tells the owner how often other people opened the page", async () => {
    handler(views(3, 5));
    renderDialog();
    const status = await screen.findByText(/^Opened /);
    expect(status.textContent).toBe("Opened 3 times in the last 30 days · 5 in all");
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.getByText(/at most once per browser every 12 hours/)).toBeTruthy();
    expect(document.querySelector(".pl-sparkline")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".pl-sparkline__bar").length).toBe(30);
  });

  it("says one time, and says so when no one else has opened it", async () => {
    handler(views(1, 1));
    renderDialog();
    expect((await screen.findByText(/^Opened /)).textContent).toBe(
      "Opened 1 time in the last 30 days · 1 in all",
    );
    cleanup();

    handler(views(0, 0));
    renderDialog();
    expect(await screen.findByText("No one else has opened it yet.")).toBeTruthy();
    expect(document.querySelector(".pl-sparkline")).toBeNull();
  });

  it("shows nothing when the instance does not count opens", async () => {
    const { calls } = handler(views(3, 5, false));
    renderDialog();
    await waitFor(() => expect(calls.some((c) => c.path === "/artifacts/s1/views")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Opened|opened/)).toBeNull();
  });

  it("asks nothing for people who are not the owner, or while the dialog is closed", async () => {
    const { calls } = handler(views(3, 5));
    renderDialog(false);
    await screen.findByRole("dialog", { name: "Share this artifact" });
    cleanup();
    renderDialog(true, false);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.path.endsWith("/views"))).toBe(false);
  });

  it("says so in one quiet line when the counts cannot be loaded", async () => {
    handler(apiError(500, "internal"));
    renderDialog();
    const line = await screen.findByText("Could not load how often this page was opened.");
    expect(line.closest('[role="alert"]')).toBeNull();
  });
});
