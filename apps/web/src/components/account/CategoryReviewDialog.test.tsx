// The review dialog applies each row's choice at once, with the version and the category_rev the
// owner was shown, and closes once nothing waits.
import type { CategoryShareArtifact } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "../viewer/test-utils.ts";
import { CategoryReviewDialog, decisionItem } from "./CategoryReviewDialog.tsx";

const row = (id: string, over: Partial<CategoryShareArtifact> = {}): CategoryShareArtifact => ({
  id,
  slug: id,
  title: `Report ${id}`,
  current_version: 3,
  category_rev: 2,
  state: "pending",
  taken_down: false,
  updated_at: "2026-11-18T10:00:00Z",
  last_author: "Work Claude",
  ...over,
});

const detail = {
  id: "share00000000000000b",
  category: "Acme",
  title: "Acme Corp",
  portal_url: "http://app.localhost:8787/p/share00000000000000b",
  people: [],
  counts: { shared: 1, pending: 2, private: 0 },
  artifacts: [row("a"), row("b"), row("c", { state: "shared" })],
};

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rowOf = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

describe("CategoryReviewDialog", () => {
  it("decisionItem carries version and category_rev", () => {
    expect(decisionItem(row("b"), "private")).toEqual({
      id: "b",
      version: 3,
      category_rev: 2,
      decision: "private",
    });
  });

  it("lists only pending artifacts and applies each choice at once", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET") return json(detail);
        if (c.method === "POST") return json({ shared: 1, private: 0, skipped: [] });
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<CategoryReviewDialog shareId={detail.id} onClose={onClose} onDone={onDone} />);
    const dialog = await screen.findByRole("dialog", { name: "Review “Acme”" });
    await screen.findByText("Report a");
    expect(screen.queryByText("Report c")).toBeNull();
    expect(screen.getAllByText(/Work Claude/)).toHaveLength(2);
    // No Save and no second close: the header's close button is the only way out.
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    // Focus does not start on the close button.
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Close");

    await user.click(within(rowOf("Report a")).getByRole("button", { name: "Share" }));
    await waitFor(() => expect(screen.queryByText("Report a")).toBeNull());
    expect(onDone).not.toHaveBeenCalled();
    await user.click(within(rowOf("Report b")).getByRole("button", { name: "Keep private" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([
      `/category-shares/${detail.id}/review`,
      `/category-shares/${detail.id}/review`,
    ]);
    expect(posts.map((c) => c.body)).toEqual([
      { items: [{ id: "a", version: 3, category_rev: 2, decision: "shared" }] },
      { items: [{ id: "b", version: 3, category_rev: 2, decision: "private" }] },
    ]);
  });

  it("a skipped share reloads the list with a note", async () => {
    let gets = 0;
    stubApi({
      handle: (c) => {
        if (c.method === "GET") {
          gets += 1;
          return json(detail);
        }
        if (c.method === "POST")
          return json({ shared: 0, private: 0, skipped: [{ id: "a", reason: "changed" }] });
        return undefined;
      },
    });
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<CategoryReviewDialog shareId={detail.id} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByText("Report a");
    await user.click(within(rowOf("Report a")).getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/changed since you opened this/)).toBeTruthy();
    await waitFor(() => expect(gets).toBe(2));
    expect(onDone).not.toHaveBeenCalled();
  });
});
