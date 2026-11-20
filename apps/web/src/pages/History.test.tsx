// The history page's restore: an ordinary artifact restores a version's content; a whiteboard,
// whose versions hold only its settings, offers "Restore settings" and says that the board itself
// stays as it is.
import type { ArtifactType, VersionInfo } from "@plinth/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./History.tsx")).default;
}

const artifact = (type: ArtifactType) => ({
  id: "art1",
  slug: "plan",
  title: "Retro",
  type,
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
  content: '{\n  "v": 1\n}\n',
});

const version = (number: number): VersionInfo => ({
  number,
  size_bytes: 40,
  note: null,
  created_at: "2026-11-14T11:00:00Z",
  author: { kind: "user", label: "Ada", user_id: "u1", connection_id: null },
  restored_from: null,
});

function handler(type: ArtifactType) {
  return stubApi({
    me: ME,
    handle: (c) => {
      if (c.path === "/artifacts/plan") return json(artifact(type));
      if (c.path.startsWith("/artifacts/plan/versions") && c.method === "GET") {
        return json({ items: [version(2), version(1)], next_cursor: null });
      }
      if (c.path === "/artifacts/plan/versions/1/restore" && c.method === "POST") {
        return json({ version: 3 }, 201);
      }
      return undefined;
    },
  });
}

/** Open v1's menu and pick its restore item. */
async function openRestore(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "More actions for v1" }));
  await user.click(await screen.findByRole("menuitem", { name }));
  return { user, dialog: await screen.findByRole("dialog") };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/plan/history");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("History: restore", () => {
  it("restores a version's content on an ordinary artifact", async () => {
    handler("html");
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    const { dialog } = await openRestore("Restore v1");
    expect(within(dialog).getByText("Restore v1?")).toBeTruthy();
    expect(dialog.textContent).toContain("This publishes v1's content as v3.");
    expect(within(dialog).getByRole("button", { name: "Restore v1" })).toBeTruthy();
  });

  it("calls it Restore settings on a whiteboard, and says the board stays as it is", async () => {
    const { calls } = handler("whiteboard");
    const Page = await loadPage();
    render(<Page params={{ slug: "plan" }} />);
    await screen.findByRole("button", { name: "More actions for v1" });
    expect(screen.queryByRole("menuitem", { name: "Restore v1" })).toBeNull();
    const { user, dialog } = await openRestore("Restore settings");
    expect(within(dialog).getByText("Restore v1's settings?")).toBeTruthy();
    expect(dialog.textContent).toContain(
      "This publishes v1's settings as v3. What is on the whiteboard stays as it is.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Restore settings" }));
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/artifacts/plan/versions/1/restore"),
    ).toBe(true);
    expect(await screen.findByText("Restored v1's settings")).toBeTruthy();
  });
});
