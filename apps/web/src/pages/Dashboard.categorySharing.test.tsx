// The dashboard with category sharing and personal categories: the review banner and ?review=, the
// collections strip under Shared, the owner's share badges, and filing a shared artifact under the
// person's own category.
import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Dashboard.tsx")).default;
}

let n = 0;
const art = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => {
  n += 1;
  return {
    id: `art${n}`,
    slug: `s${n}`,
    title: `Artifact ${n}`,
    type: "html",
    visibility: "allowlist",
    current_version: 1,
    version_count: 1,
    created_at: `2026-11-0${n}T00:00:00Z`,
    updated_at: `2026-11-0${n}T00:00:00Z`,
    url: `http://app.localhost:8787/a/s${n}`,
    content_url: `http://art${n}.content.localhost:8787/`,
    owner: { id: "u1", email: "ada@example.org", name: null },
    role: "owner",
    taken_down: false,
    thumbnail_url: null,
    category: null,
    category_share: null,
    my_category: null,
    ...over,
  };
};

const SHARE = {
  id: "share00000000000000d",
  category: "Acme",
  title: "Acme Corp",
  portal_url: "http://app.localhost:8787/p/share00000000000000d",
  people: [{ email: "client@example.org", role: "viewer" }],
  counts: { shared: 1, pending: 2, private: 0 },
};

function backend(items: ArtifactSummary[], extra: { my?: { name: string; count: number }[] } = {}) {
  return stubApi({
    me: ME,
    config: { ...CONFIG, category_sharing: true },
    handle: (c) => {
      if (c.method === "GET" && c.path.startsWith("/artifacts"))
        return json({
          items,
          categories: [{ name: "Acme", count: 2, shared: true }],
          my_categories: extra.my ?? [],
        });
      if (c.method === "GET" && c.path === "/category-shares") return json({ items: [SHARE] });
      if (c.method === "GET" && c.path === "/portals")
        return json({ items: [{ id: "p1", title: "Bo's designs", owner_name: "Bo", count: 3 }] });
      if (c.method === "GET" && c.path === `/category-shares/${SHARE.id}`)
        return json({ ...SHARE, artifacts: [] });
      if (c.method === "PUT" && c.path.endsWith("/my-category"))
        return json({ ...items[1], my_category: (c.body as { category: string }).category });
      return undefined;
    },
  });
}

beforeEach(() => {
  n = 0;
  window.history.replaceState(null, "", "/dashboard");
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fixture = () => [
  art({ title: "Shared report", category: "Acme", category_share: "shared" }),
  art({
    title: "Their page",
    role: "viewer",
    owner: { id: "u2", email: "bo@example.org", name: "Bo" },
    my_category: "Clients",
  }),
  art({ title: "Waiting report", category: "Acme", category_share: "pending", taken_down: true }),
];

describe("Dashboard: category sharing", () => {
  it("shows the review banner and the owner's share badges", async () => {
    backend(fixture());
    const Dashboard = await loadPage();
    render(<Dashboard />);
    expect(
      await screen.findByText(
        "2 artifacts wait for your review before Acme's people can see them.",
      ),
    ).toBeTruthy();
    const region = screen.getByRole("region", { name: "Artifacts" });
    const waiting = within(region).getByText("Waiting report").closest("li") as HTMLElement;
    expect(within(waiting).getByText("Waiting for review")).toBeTruthy();
    // The Taken down badge stays beside it.
    expect(within(waiting).getByText("Taken down")).toBeTruthy();
    const shared = within(region).getByText("Shared report").closest("li") as HTMLElement;
    expect(within(shared).getByText("Shared")).toBeTruthy();
  });

  it("?review= opens the review dialog", async () => {
    window.history.replaceState(null, "", `/dashboard?review=${SHARE.id}`);
    backend(fixture());
    const Dashboard = await loadPage();
    render(<Dashboard />);
    expect(await screen.findByRole("dialog", { name: "Review for “Acme Corp”" })).toBeTruthy();
  });

  it("lists the collections shared with the person under Shared", async () => {
    backend(fixture());
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Their page");
    expect(screen.queryByRole("navigation", { name: "Collections shared with you" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    const strip = await screen.findByRole("navigation", { name: "Collections shared with you" });
    expect(within(strip).getByRole("link", { name: "Bo's designs" }).getAttribute("href")).toBe(
      "/p/p1",
    );
  });

  it("offers Share category for an owner category", async () => {
    backend(fixture());
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Shared report");
    await user.click(screen.getByRole("button", { name: /^Category: / }));
    await user.click(screen.getByRole("menuitemradio", { name: "Acme (2)" }));
    expect(screen.getByRole("button", { name: "Sharing" })).toBeTruthy();
  });
});

describe("Dashboard: personal categories", () => {
  it("shows the person's own category on a shared row and filters by it under Shared", async () => {
    backend(fixture(), { my: [{ name: "Clients", count: 1 }] });
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    const row = (await screen.findByText("Their page")).closest("li") as HTMLElement;
    // The badge beside the title and the plain text a phone shows on the second line (one of them
    // hidden by CSS), both named as the person's own category.
    expect(within(row).getByText("Clients", { selector: ".pl-dash__category-name" })).toBeTruthy();
    expect(within(row).getByText("Clients", { selector: ".pl-dash__category-text" })).toBeTruthy();
    expect(within(row).getAllByText("Your category:", { exact: false })).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    await user.click(screen.getByRole("button", { name: /^Category: / }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent),
    ).toEqual(["All categories", "Clients (1)", "No category"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Clients (1)" }));
    const region = screen.getByRole("region", { name: "Artifacts" });
    expect(
      within(region)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Their page"]);
  });

  it("files a shared artifact under the person's own category from its menu", async () => {
    const items = fixture();
    const api = backend(items, { my: [{ name: "Clients", count: 1 }] });
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Their page");
    await user.click(screen.getByRole("button", { name: "Actions for Their page" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to category…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to category" });
    const input = within(dialog).getByRole("combobox", { name: "Your category" });
    await user.clear(input);
    await user.type(input, "Design reviews");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === "PUT" && c.path === "/artifacts/art2/my-category"),
      ).toBe(true),
    );
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ category: "Design reviews" });
  });
});
