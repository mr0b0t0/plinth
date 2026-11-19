// The Share category dialog: a new share sends one POST with the review of every row; a people
// change on an existing share sends one PATCH with the people and the review; a title change alone
// sends PATCH { title }; skipped items reload the list with a note.
import type { CategoryShareArtifact } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubApi } from "../viewer/test-utils.ts";
import { reviewItems, ShareCategoryDialog } from "./ShareCategoryDialog.tsx";

const row = (id: string, over: Partial<CategoryShareArtifact> = {}): CategoryShareArtifact => ({
  id,
  slug: `${id}-slug`,
  title: `Report ${id}`,
  current_version: 2,
  category_rev: 1,
  state: "pending",
  taken_down: false,
  updated_at: "2026-11-18T10:00:00Z",
  last_author: "Work Claude",
  ...over,
});

const SHARE = {
  id: "share00000000000000a",
  category: "Acme",
  title: "Acme Corp",
  portal_url: "http://app.localhost:8787/p/share00000000000000a",
  people: [{ email: "client@example.org", role: "viewer" as const }],
  counts: { shared: 1, pending: 1, private: 0 },
};

beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-plinth_csrf=t; plinth_csrf=t");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reviewItems", () => {
  it("shares ticked rows, keeps the rest private, and leaves taken-down rows out", () => {
    expect(
      reviewItems([row("a"), row("b"), row("c", { taken_down: true })], new Set(["a"])),
    ).toEqual([
      { id: "a", version: 2, category_rev: 1, decision: "shared" },
      { id: "b", version: 2, category_rev: 1, decision: "private" },
    ]);
  });
});

describe("ShareCategoryDialog", () => {
  it("a new share sends one POST with people and the review of every row shown", async () => {
    const onDone = vi.fn();
    const api = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview"))
          return json({ category: "Acme", artifacts: [row("a"), row("b")] });
        if (c.method === "POST" && c.path === "/category-shares")
          return json({ share: SHARE, review: { shared: 1, private: 1, skipped: [] } }, 201);
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(
      <ShareCategoryDialog category="Acme" shareId={null} onClose={vi.fn()} onDone={onDone} />,
    );
    await screen.findByText("Report a");
    await user.click(screen.getByRole("checkbox", { name: /Report b/ }));
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "client@example.org");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: SHARE.id }));
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      category: "Acme",
      title: "Acme",
      people: [{ email: "client@example.org", role: "viewer" }],
      review: [
        { id: "a", version: 2, category_rev: 1, decision: "shared" },
        { id: "b", version: 2, category_rev: 1, decision: "private" },
      ],
    });
  });

  it("a people change on an existing share sends one PATCH with people and review", async () => {
    const onDone = vi.fn();
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET" && c.path === `/category-shares/${SHARE.id}`)
          return json({ ...SHARE, artifacts: [row("a", { state: "shared" }), row("b")] });
        if (c.method === "PATCH")
          return json({ share: SHARE, review: { shared: 1, private: 1, skipped: [] } });
        return undefined;
      },
    });
    const user = userEvent.setup();
    render(
      <ShareCategoryDialog category="Acme" shareId={SHARE.id} onClose={vi.fn()} onDone={onDone} />,
    );
    await screen.findByText("Report a");
    // Pending rows show who filed them and stay unticked.
    expect(screen.getByText(/Waiting for your review · filed by Work Claude/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Report b/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Remove client@example.org" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({
      people: [],
      review: [
        { id: "a", version: 2, category_rev: 1, decision: "shared" },
        { id: "b", version: 2, category_rev: 1, decision: "private" },
      ],
    });
  });

  it("a title change alone sends PATCH { title }", async () => {
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET")
          return json({ ...SHARE, artifacts: [row("a", { state: "shared" })] });
        if (c.method === "PATCH") return json({ share: SHARE, review: null });
        return undefined;
      },
    });
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      <ShareCategoryDialog category="Acme" shareId={SHARE.id} onClose={vi.fn()} onDone={onDone} />,
    );
    const name = await screen.findByRole("textbox", { name: "Name people see" });
    await user.clear(name);
    await user.type(name, "Acme reports");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.body])).toEqual([
      ["PATCH", { title: "Acme reports" }],
    ]);
  });

  it("skipped items reload the list with a note", async () => {
    let gets = 0;
    stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview")) {
          gets += 1;
          return json({ category: "Acme", artifacts: [row("a")] });
        }
        if (c.method === "POST")
          return json(
            {
              share: SHARE,
              review: { shared: 0, private: 0, skipped: [{ id: "a", reason: "changed" }] },
            },
            201,
          );
        return undefined;
      },
    });
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      <ShareCategoryDialog category="Acme" shareId={null} onClose={vi.fn()} onDone={onDone} />,
    );
    await screen.findByText("Report a");
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/changed since you opened this/)).toBeTruthy();
    await waitFor(() => expect(gets).toBe(2));
    expect(onDone).not.toHaveBeenCalled();
  });
});
