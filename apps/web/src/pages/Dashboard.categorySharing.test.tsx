// The dashboard with category sharing and personal categories: the one review line and ?review=
// (rows carry no review badge), and filing a shared artifact under the person's own category.
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

function backend(
  items: ArtifactSummary[],
  extra: { my?: { name: string; count: number }[]; sharing?: boolean } = {},
) {
  return stubApi({
    me: ME,
    config: { ...CONFIG, category_sharing: extra.sharing ?? true },
    handle: (c) => {
      if (c.method === "POST" && c.path === "/categories/rename")
        return json({ updated: 1, category: (c.body as { to: string | null }).to });
      if (c.method === "GET" && c.path.startsWith("/artifacts"))
        return json({
          items,
          categories: [{ name: "Acme", count: 2, shared: true }],
          my_categories: extra.my ?? [],
        });
      if (c.method === "GET" && c.path === "/category-shares") return json({ items: [SHARE] });
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
  it("shows one review line, and no review badge on the rows", async () => {
    const api = backend(fixture());
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    const line = (await screen.findByText(/2 to review in Acme/)).closest("p") as HTMLElement;
    expect(within(line).getByRole("button", { name: "Review" })).toBeTruthy();
    const region = screen.getByRole("region", { name: "Artifacts" });
    const waiting = within(region).getByText("Waiting report").closest("li") as HTMLElement;
    expect(within(waiting).queryByText("Needs review")).toBeNull();
    expect(within(waiting).getByText("Taken down")).toBeTruthy();
    // A shared row carries no badge of its own: its category's share dialog lists it.
    const shared = within(region).getByText("Shared report").closest("li") as HTMLElement;
    expect(within(shared).queryByText("Shared")).toBeNull();
    // The dashboard does not list the categories shared with the person.
    expect(api.calls.some((c) => c.path === "/portals")).toBe(false);
    // Under Shared, the line is gone.
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    expect(screen.queryByText(/to review/)).toBeNull();
  });

  it("reviewText names the category only when one has artifacts waiting", async () => {
    const { reviewText } = await import("./Dashboard.tsx");
    expect(reviewText([{ category: "Acme", pending: 1 }])).toBe("1 to review in Acme");
    expect(
      reviewText([
        { category: "Acme", pending: 2 },
        { category: "Internal", pending: 3 },
      ]),
    ).toBe("5 to review");
  });

  it("?review= opens the review dialog", async () => {
    window.history.replaceState(null, "", `/dashboard?review=${SHARE.id}`);
    backend(fixture());
    const Dashboard = await loadPage();
    render(<Dashboard />);
    expect(await screen.findByRole("dialog", { name: "Review “Acme”" })).toBeTruthy();
  });

  it("?review= is ignored where the instance does not offer category sharing", async () => {
    window.history.replaceState(null, "", `/dashboard?review=${SHARE.id}`);
    const api = backend(fixture(), { sharing: false });
    const Dashboard = await loadPage();
    render(<Dashboard />);
    await screen.findByText("Shared report");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith("/category-shares"))).toBe(false);
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

  it("under All, a name that is both kinds renames the owner's category, with its own count", async () => {
    const api = backend(fixture(), { my: [{ name: "Acme", count: 1 }] });
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Shared report");
    await user.click(screen.getByRole("button", { name: /^Category: / }));
    await user.click(screen.getByRole("menuitemradio", { name: "Acme (3)" }));
    await user.click(screen.getByRole("button", { name: "Rename category" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename category" });
    expect(dialog.textContent).toContain("“Acme” is on 2 artifacts of yours.");
    expect(dialog.textContent).toContain("rename those under Shared");
    await user.click(within(dialog).getByRole("button", { name: "Remove category" }));
    await user.click(await screen.findByRole("button", { name: "Remove from 2 artifacts" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "POST" && c.path === "/categories/rename")).toBe(
        true,
      ),
    );
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/categories/rename");
    expect(post?.body).toEqual({ from: "Acme", to: null });
    // The owner's artifacts without a category, under All.
    expect((screen.getByRole("radio", { name: "All" }) as HTMLInputElement).checked).toBe(true);
  });

  it("under All, clearing the person's own category shows Shared, where those artifacts went", async () => {
    const api = backend(fixture(), { my: [{ name: "Clients", count: 1 }] });
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Their page");
    await user.click(screen.getByRole("button", { name: /^Category: / }));
    await user.click(screen.getByRole("menuitemradio", { name: "Clients (1)" }));
    await user.click(screen.getByRole("button", { name: "Rename category" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename category" });
    expect(dialog.textContent).toContain("“Clients” is on 1 artifact.");
    await user.click(within(dialog).getByRole("button", { name: "Remove category" }));
    await user.click(await screen.findByRole("button", { name: "Remove from 1 artifact" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "POST" && c.path === "/categories/rename")).toBe(
        true,
      ),
    );
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/categories/rename");
    expect(post?.body).toEqual({ from: "Clients", to: null, personal: true });
    const shared = screen.getByRole("radio", { name: "Shared" }) as HTMLInputElement;
    await waitFor(() => expect(shared.checked).toBe(true));
  });
});
