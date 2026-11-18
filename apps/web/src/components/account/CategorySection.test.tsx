import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { apiError, json, stubApi } from "../viewer/test-utils.ts";
import { CategorySection, snapTargets } from "./SettingsSections.tsx";

const summary = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: "art1",
  slug: "plan",
  title: "Release plan",
  type: "html",
  visibility: "allowlist",
  current_version: 2,
  version_count: 2,
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

const NAMES = [
  { name: "Acme Site", count: 3 },
  { name: "blog", count: 1 },
];

/** The section as Settings mounts it (not keyed, so a save keeps the focus), merged into the artifact. */
function Harness({
  initial,
  onSaved,
}: {
  initial: ArtifactSummary;
  onSaved?: (category: string | null) => void;
}) {
  const [artifact, setArtifact] = useState(initial);
  return (
    <>
      <CategorySection
        artifact={artifact}
        onSaved={(category) => {
          onSaved?.(category);
          setArtifact((a) => ({ ...a, category }));
        }}
      />
      <Toaster />
    </>
  );
}

function backend({ failPatch = false } = {}) {
  return stubApi({
    handle: (c) => {
      if (c.method === "GET" && c.path === "/categories") return json({ items: NAMES });
      if (c.method === "PATCH" && c.path === "/artifacts/art1") {
        if (failPatch) return apiError(403, "forbidden", "Your session expired. Reload the page.");
        const { category } = c.body as { category: string | null };
        // The Worker snaps onto the owner's spelling.
        const stored = category === "acme-site" ? "Acme Site" : category;
        return json(summary({ category: stored }));
      }
      return undefined;
    },
  });
}

const field = () => screen.getByRole("combobox", { name: "Category" }) as HTMLInputElement;

beforeEach(() => {
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

describe("CategorySection", () => {
  it("fills the datalist from GET /categories", async () => {
    backend();
    render(<Harness initial={summary()} />);
    const list = field().getAttribute("list") ?? "";
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll(`#${CSS.escape(list)} option`), (o) =>
          o.getAttribute("value"),
        ),
      ).toEqual(["Acme Site", "blog"]),
    );
    expect(screen.getByRole("heading", { name: "Category" }).id).toBe("settings-category");
    expect(field().maxLength).toBe(60);
    expect(screen.queryByRole("button", { name: "Remove category" })).toBeNull();
  });

  it("shows where a name will be filed, saves it and shows the stored spelling", async () => {
    const { calls } = backend();
    const user = userEvent.setup();
    render(<Harness initial={summary()} />);
    await waitFor(() => expect(calls.some((c) => c.path === "/categories")).toBe(true));
    await user.type(field(), "acme-site");
    expect(screen.getByText("Will be filed under “Acme Site”.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save category" }));

    await screen.findByText("Category saved");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ category: "acme-site" });
    await waitFor(() => expect(field().value).toBe("Acme Site"));
    expect(
      (screen.getByRole("button", { name: "Save category" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Remove category" })).toBeTruthy();
  });

  it("removes the category", async () => {
    const { calls } = backend();
    const user = userEvent.setup();
    render(<Harness initial={summary({ category: "blog" })} />);
    expect(field().value).toBe("blog");
    await user.click(screen.getByRole("button", { name: "Remove category" }));
    await screen.findByText("Category removed");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ category: null });
    await waitFor(() => expect(field().value).toBe(""));
    expect(screen.queryByRole("button", { name: "Remove category" })).toBeNull();
  });

  it("refuses a name the Worker would refuse, without a request", async () => {
    const { calls } = backend();
    const user = userEvent.setup();
    render(<Harness initial={summary()} />);
    await user.type(field(), "a​b");
    await user.click(screen.getByRole("button", { name: "Save category" }));
    expect(
      await screen.findByText("A category cannot contain control or invisible characters."),
    ).toBeTruthy();
    await user.clear(field());
    await user.type(field(), "- _");
    await user.click(screen.getByRole("button", { name: "Save category" }));
    expect(
      await screen.findByText("A category needs a character other than spaces, '-' and '_'."),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("keeps the focus in the field after Save and after Remove", async () => {
    backend();
    const user = userEvent.setup();
    render(<Harness initial={summary()} />);
    await user.type(field(), "Fresh{Enter}");
    await screen.findByText("Category saved");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    await user.click(screen.getByRole("button", { name: "Remove category" }));
    await screen.findByText("Category removed");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove category" })).toBeNull(),
    );
    expect(document.activeElement).toBe(field());
  });

  it("says why Save stays off when the name snaps back onto the current, shared one", async () => {
    const { calls } = backend();
    const user = userEvent.setup();
    render(<Harness initial={summary({ category: "Acme Site" })} />);
    await waitFor(() => expect(calls.some((c) => c.path === "/categories")).toBe(true));
    await user.clear(field());
    await user.type(field(), "acme site");
    expect(
      screen.getByText(
        "Matches “Acme Site”, its current category. To respell it on every artifact, use Rename category on your dashboard.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save category" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the error and re-enables the buttons when the save or the removal fails", async () => {
    const { calls } = backend({ failPatch: true });
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={summary({ category: "blog" })} onSaved={saved} />);
    await user.clear(field());
    await user.type(field(), "Other");
    await user.click(screen.getByRole("button", { name: "Save category" }));
    expect(await screen.findByText("Your session expired. Reload the page.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save category" }) as HTMLButtonElement;
    const remove = screen.getByRole("button", { name: "Remove category" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(field().value).toBe("Other");

    await user.click(remove);
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(await screen.findByText("Your session expired. Reload the page.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove category" })).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
    expect(screen.queryByText("Category saved")).toBeNull();
    expect(screen.queryByText("Category removed")).toBeNull();
  });
});

describe("snapTargets", () => {
  it("leaves out a category only this artifact uses, so it can be respelled", () => {
    expect(snapTargets({ category: "blog" }, NAMES)).toEqual(["Acme Site"]);
    expect(snapTargets({ category: "acme site" }, NAMES)).toEqual(["Acme Site", "blog"]);
    expect(snapTargets({ category: null }, NAMES)).toEqual(["Acme Site", "blog"]);
  });
});
