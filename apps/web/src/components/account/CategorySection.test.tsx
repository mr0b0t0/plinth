import type { ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, Toaster } from "../ui/index.ts";
import { json, stubApi } from "../viewer/test-utils.ts";
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

/** The section as Settings mounts it: keyed on the stored category, merged into the artifact. */
function Harness({ initial }: { initial: ArtifactSummary }) {
  const [artifact, setArtifact] = useState(initial);
  return (
    <>
      <CategorySection
        key={`category-${artifact.category ?? ""}`}
        artifact={artifact}
        onSaved={(category) => setArtifact((a) => ({ ...a, category }))}
      />
      <Toaster />
    </>
  );
}

function backend() {
  return stubApi({
    handle: (c) => {
      if (c.method === "GET" && c.path === "/categories") return json({ items: NAMES });
      if (c.method === "PATCH" && c.path === "/artifacts/art1") {
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
      await screen.findByText(
        "A category cannot contain control, invisible or line-break characters.",
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("snapTargets", () => {
  it("leaves out a category only this artifact uses, so it can be respelled", () => {
    expect(snapTargets({ category: "blog" }, NAMES)).toEqual(["Acme Site"]);
    expect(snapTargets({ category: "acme site" }, NAMES)).toEqual(["Acme Site", "blog"]);
    expect(snapTargets({ category: null }, NAMES)).toEqual(["Acme Site", "blog"]);
  });
});
