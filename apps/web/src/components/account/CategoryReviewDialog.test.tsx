// The review dialog sends each decision with the version and the category_rev the owner was shown.
import type { CategoryShareArtifact } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "../viewer/test-utils.ts";
import { CategoryReviewDialog, decisionsToItems } from "./CategoryReviewDialog.tsx";

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

describe("CategoryReviewDialog", () => {
  it("decisionsToItems carries version and category_rev", () => {
    expect(decisionsToItems([row("a"), row("b")], new Map([["b", "private"]]))).toEqual([
      { id: "b", version: 3, category_rev: 2, decision: "private" },
    ]);
  });

  it("lists only pending artifacts and sends the decisions made", async () => {
    const onDone = vi.fn();
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET") return json(detail);
        if (c.method === "POST") return json({ shared: 1, private: 1, skipped: [] });
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(<CategoryReviewDialog shareId={detail.id} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByText("Report a");
    expect(screen.queryByText("Report c")).toBeNull();
    expect(screen.getAllByText(/filed by Work Claude/)).toHaveLength(2);
    await user.click(
      screen
        .getByRole("group", { name: "Decision for Report a" })
        .querySelector("input") as HTMLElement,
    );
    const b = screen.getByRole("group", { name: "Decision for Report b" });
    await user.click(b.querySelectorAll("input")[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = api.calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/category-shares/${detail.id}/review`);
    expect(post?.body).toEqual({
      items: [
        { id: "a", version: 3, category_rev: 2, decision: "shared" },
        { id: "b", version: 3, category_rev: 2, decision: "private" },
      ],
    });
  });
});
