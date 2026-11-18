import type { ArtifactSummary, CategoryCount } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";

// The session store is module state; load a fresh copy of the page for each test.
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
    ...over,
  };
};

/** A backend with a fixed list; records the rename calls and answers them. */
function backend(items: ArtifactSummary[], categories: CategoryCount[]) {
  const s = { items, categories };
  const api = stubApi({
    me: ME,
    handle: (c) => {
      if (c.method === "GET" && c.path.startsWith("/artifacts")) {
        const q = new URL(c.path, "http://x").searchParams.get("query");
        const hits = q ? s.items.filter((a) => a.title.includes(q)) : s.items;
        return json({ items: hits, categories: s.categories });
      }
      if (c.method === "POST" && c.path === "/categories/rename") {
        const { to } = c.body as { from: string; to: string | null };
        return json({ updated: 2, category: to === "acme" ? "Acme" : to });
      }
      return undefined;
    },
  });
  return { ...api, state: s };
}

function rowTitles(): string[] {
  const region = screen.getByRole("region", { name: "Artifacts" });
  return within(region)
    .queryAllByRole("link")
    .map((a) => a.textContent ?? "");
}

const categoryTrigger = () => screen.getByRole("button", { name: /^Category: / });

async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(categoryTrigger());
  await user.click(screen.getByRole("menuitemradio", { name: label }));
}

beforeEach(() => {
  n = 0;
  window.history.replaceState(null, "", "/dashboard");
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fixture = () => {
  const a1 = art({ title: "Acme report", category: "Acme site" });
  const a2 = art({ title: "Acme plan", category: "Acme site" });
  const a3 = art({ title: "Blog draft", category: "blog" });
  const a4 = art({ title: "Loose page" });
  const shared = art({
    title: "Their page",
    role: "viewer",
    owner: { id: "u2", email: "bo@example.org", name: "Bo" },
  });
  return {
    items: [a1, a2, a3, a4, shared],
    categories: [
      { name: "Acme site", count: 2 },
      { name: "blog", count: 1 },
    ],
  };
};

describe("Dashboard categories", () => {
  it("lists the names with counts, sorted by name, then No category", async () => {
    const f = fixture();
    backend(f.items, [
      { name: "Acme site", count: 2 },
      { name: "Zeta", count: 5 },
      { name: "blog", count: 1 },
    ]);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    expect(categoryTrigger().textContent).toBe("Category: All");
    await user.click(categoryTrigger());
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent),
    ).toEqual(["All categories", "Acme site (2)", "blog (1)", "Zeta (5)", "No category"]);
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: "All categories" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("filters to one category and keeps it in ?category=", async () => {
    const f = fixture();
    backend(f.items, f.categories);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    await pick(user, "Acme site (2)");
    expect(rowTitles().sort()).toEqual(["Acme plan", "Acme report"]);
    expect(categoryTrigger().textContent).toBe("Category: Acme site");
    expect(window.location.search).toBe("?category=Acme%20site");

    await pick(user, "All categories");
    expect(rowTitles()).toHaveLength(5);
    expect(window.location.search).toBe("");
  });

  it("matches ?category= by key and shows the owner's artifacts with none", async () => {
    const f = fixture();
    window.history.replaceState(null, "", "/dashboard?category=acme-SITE");
    backend(f.items, f.categories);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    expect(rowTitles().sort()).toEqual(["Acme plan", "Acme report"]);
    expect(categoryTrigger().textContent).toBe("Category: Acme site");

    await pick(user, "No category");
    expect(rowTitles()).toEqual(["Loose page"]);
    expect(window.location.search).toBe("?category=");
  });

  it("shows the empty states, and an unknown ?category= can be reset from the menu", async () => {
    const f = fixture();
    window.history.replaceState(null, "", "/dashboard?category=Nowhere");
    backend(
      f.items.filter((a) => a.title !== "Loose page"),
      f.categories,
    );
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    expect(await screen.findByText("Nothing in Nowhere yet.")).toBeTruthy();
    // Nothing to rename: the name is not one of the owner's categories.
    expect(screen.queryByRole("button", { name: "Rename category" })).toBeNull();

    await pick(user, "No category");
    expect(screen.getByText("Every artifact you own has a category.")).toBeTruthy();

    await pick(user, "All categories");
    expect(rowTitles()).toHaveLength(4);
  });

  it("hides the menu on Shared and when there are no categories", async () => {
    const f = fixture();
    backend(f.items, f.categories);
    let Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    await pick(user, "Acme site (2)");
    await user.click(screen.getByRole("radio", { name: "Shared" }));
    expect(screen.queryByRole("button", { name: /^Category: / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename category" })).toBeNull();
    expect(rowTitles()).toEqual(["Their page"]);
    cleanup();

    backend(
      f.items.map((a) => ({ ...a, category: null })),
      [],
    );
    window.history.replaceState(null, "", "/dashboard");
    Dashboard = await loadPage();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    expect(screen.queryByRole("button", { name: /^Category: / })).toBeNull();
  });

  it("round-trips ?category= together with ?q=", async () => {
    const f = fixture();
    window.history.replaceState(null, "", "/dashboard?q=Acme&category=Acme%20site");
    const { calls } = backend(f.items, f.categories);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    expect(calls.some((c) => c.path === "/artifacts?query=Acme")).toBe(true);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Acme");
    expect(categoryTrigger().textContent).toBe("Category: Acme site");
    expect(window.location.search).toBe("?q=Acme&category=Acme%20site");

    await pick(user, "blog (1)");
    expect(window.location.search).toBe("?q=Acme&category=blog");
    expect(screen.getByText("Nothing in blog matches.")).toBeTruthy();
  });

  it("renames a category, and offers Merge when the new name matches another", async () => {
    const f = fixture();
    const { calls } = backend(f.items, f.categories);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    await pick(user, "blog (1)");
    await user.click(screen.getByRole("button", { name: "Rename category" }));

    const dialog = screen.getByRole("dialog", { name: "Rename category" });
    const input = within(dialog).getByRole("combobox", { name: "New name" }) as HTMLInputElement;
    expect(input.value).toBe("blog");
    const options = Array.from(
      document.querySelectorAll(`#${CSS.escape(input.getAttribute("list") ?? "")} option`),
      (o) => o.getAttribute("value"),
    );
    expect(options).toEqual(["Acme site"]);
    expect(
      (within(dialog).getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // A name that matches another category by key merges into it.
    await user.clear(input);
    await user.type(input, "acme_site");
    expect(within(dialog).getByText("Acme site already has 2 artifacts. This one will join it."));
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/categories/rename")?.body).toEqual({
        from: "blog",
        to: "acme_site",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renames to a new name, or removes the category", async () => {
    const f = fixture();
    const { calls } = backend(f.items, f.categories);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Acme report");
    await pick(user, "Acme site (2)");
    await user.click(screen.getByRole("button", { name: "Rename category" }));
    let dialog = screen.getByRole("dialog", { name: "Rename category" });
    const input = within(dialog).getByRole("combobox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "  acme  ");
    expect(within(dialog).queryByText(/already has/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const renames = () => calls.filter((c) => c.path === "/categories/rename");
    expect(renames()[0]?.body).toEqual({ from: "Acme site", to: "acme" });
    // The filter follows the stored spelling the Worker returned.
    expect(window.location.search).toBe("?category=Acme");

    await pick(user, "blog (1)");
    await user.click(screen.getByRole("button", { name: "Rename category" }));
    dialog = screen.getByRole("dialog", { name: "Rename category" });
    await user.click(within(dialog).getByRole("button", { name: "Remove category" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(renames()[1]?.body).toEqual({ from: "blog", to: null });
    expect(window.location.search).toBe("");
  });
});
