// The Share category dialog: a new share sends one POST with the review of every row; a people
// change on an existing share sends one PATCH with the people and the review of the listed rows
// (rows waiting for review are not listed and stay waiting); a title change alone sends
// PATCH { title }; skipped items reload the list with a note (a new share's, in edit mode).
import type { CategoryShareArtifact } from "@plinth/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, json, stubApi } from "../viewer/test-utils.ts";
import {
  listedRows,
  reviewItems,
  ShareCategoryDialog,
  skippedText,
} from "./ShareCategoryDialog.tsx";

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

describe("listedRows and reviewItems", () => {
  it("shares ticked rows, keeps the rest private, and leaves taken-down rows out", () => {
    const rows = listedRows([row("a"), row("b"), row("c", { taken_down: true })], false);
    expect(reviewItems(rows, new Set(["a"]))).toEqual([
      { id: "a", version: 2, category_rev: 1, decision: "shared" },
      { id: "b", version: 2, category_rev: 1, decision: "private" },
    ]);
  });
  it("on an existing share, leaves rows waiting for review out", () => {
    const rows = [row("a", { state: "shared" }), row("b"), row("c", { state: "private" })];
    expect(listedRows(rows, true).map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("skippedText", () => {
  const sent = [
    { id: "a", decision: "shared" as const },
    { id: "b", decision: "private" as const },
  ];
  it("says nothing without skipped items", () => {
    expect(skippedText({ shared: 1, private: 1, skipped: [] }, sent)).toBeNull();
    expect(skippedText(null, sent)).toBeNull();
  });
  it("a skipped share was not shared; a skipped private decision left the category", () => {
    expect(
      skippedText({ shared: 0, private: 1, skipped: [{ id: "a", reason: "changed" }] }, sent),
    ).toBe("One artifact changed since you opened this, so it was not shared. Review again.");
    const left = skippedText(
      { shared: 1, private: 0, skipped: [{ id: "b", reason: "moved" }] },
      sent,
    );
    expect(left).toBe(
      "One artifact left this category since you opened this (moved, deleted or taken down), so it is not shared here.",
    );
    // Never "changed ... not shared" for an artifact the owner kept private.
    expect(left).not.toMatch(/changed since you opened this/);
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
      // "Notify people" is ticked by default and someone new is on the list.
      notify: true,
    });
  });

  it("a people change on an existing share sends one PATCH with people and review", async () => {
    const onDone = vi.fn();
    const api = stubApi({
      handle: (c) => {
        if (c.method === "GET" && c.path === `/category-shares/${SHARE.id}`)
          return json({
            ...SHARE,
            artifacts: [row("a", { state: "shared" }), row("b"), row("c", { state: "private" })],
          });
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
    // The dialog opens on the email field.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Email address" }));
    // A row waiting for review is decided in the review dialog only: it is not listed here, and
    // the people change leaves it waiting (no review item for it).
    expect(screen.queryByRole("checkbox", { name: /Report b/ })).toBeNull();
    expect(screen.queryByText("Needs review")).toBeNull();
    expect((screen.getByRole("checkbox", { name: /Report c/ }) as HTMLInputElement).checked).toBe(
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
        { id: "c", version: 2, category_rev: 1, decision: "private" },
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

  it("skipped items on a new share reload that share in edit mode, with a note", async () => {
    let previews = 0;
    let shareGets = 0;
    const api = stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview")) {
          previews += 1;
          // Once the share exists, its preview answers already_shared.
          if (previews > 1)
            return apiError(409, "already_shared", "This category is already shared.");
          return json({ category: "Acme", artifacts: [row("a"), row("b")] });
        }
        if (c.method === "POST")
          return json(
            {
              share: SHARE,
              review: { shared: 1, private: 0, skipped: [{ id: "a", reason: "changed" }] },
            },
            201,
          );
        if (c.method === "GET" && c.path === `/category-shares/${SHARE.id}`) {
          shareGets += 1;
          return json({
            ...SHARE,
            artifacts: [row("a"), row("b", { state: "shared" })],
          });
        }
        if (c.method === "PATCH")
          return json({ share: SHARE, review: { shared: 1, private: 0, skipped: [] } });
        return undefined;
      },
    });
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(
      <ShareCategoryDialog category="Acme" shareId={null} onClose={onClose} onDone={onDone} />,
    );
    await screen.findByText("Report a");
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/changed since you opened this/)).toBeTruthy();
    await waitFor(() => expect(shareGets).toBe(1));
    expect(previews).toBe(1);
    // Now in edit mode on the created share: Save, the link, and no error.
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByText(/already shared/)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    // A second press saves the share instead of posting a new one.
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "b@example.org");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: SHARE.id }));
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("closing after a new share's skipped items still tells the parent the share exists", async () => {
    stubApi({
      handle: (c) => {
        if (c.path.startsWith("/category-shares/preview"))
          return json({ category: "Acme", artifacts: [row("a")] });
        if (c.method === "POST")
          return json(
            {
              share: SHARE,
              review: { shared: 0, private: 0, skipped: [{ id: "a", reason: "changed" }] },
            },
            201,
          );
        if (c.method === "GET") return json({ ...SHARE, artifacts: [row("a")] });
        return undefined;
      },
    });
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(
      <ShareCategoryDialog category="Acme" shareId={null} onClose={onClose} onDone={onDone} />,
    );
    await screen.findByText("Report a");
    await user.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("button", { name: "Save" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalledWith({ id: SHARE.id });
    expect(onClose).not.toHaveBeenCalled();
  });
});
