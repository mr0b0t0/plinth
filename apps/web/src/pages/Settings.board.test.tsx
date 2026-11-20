// The settings page's Board section: only on a whiteboard, the owner's way to change its background
// and who can change it. Save board publishes the next version against the version it read and
// the page's version number follows; a refused save shows the newer version's settings and number.
import type { ArtifactSummary, SharingSettings } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts } from "../components/ui/index.ts";
import { type Call, json, ME, stubApi } from "../components/viewer/test-utils.ts";

const artifact = (over: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: "wb1",
  slug: "launch-board",
  title: "Launch board",
  type: "whiteboard",
  visibility: "allowlist",
  current_version: 3,
  version_count: 3,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  url: "http://app.localhost:8787/a/launch-board",
  content_url: "http://wb1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
  ...over,
});

const SHARING: SharingSettings = {
  visibility: "allowlist",
  has_password: false,
  grants: [],
  public_allowed: false,
};

const board = (background: string, edit: string) =>
  JSON.stringify({ v: 1, background, edit }, null, 2);

async function open(over: Partial<ArtifactSummary>, handle?: (c: Call) => Response | undefined) {
  const api = stubApi({
    me: ME,
    handle: (c) => {
      const answer = handle?.(c);
      if (answer) return answer;
      if (c.method === "GET" && c.path === "/artifacts/launch-board") return json(artifact(over));
      if (c.method === "GET" && c.path === "/artifacts/wb1/sharing") return json(SHARING);
      if (c.path.startsWith("/categories")) return json({ items: [] });
      return undefined;
    },
  });
  vi.resetModules();
  const Settings = (await import("./Settings.tsx")).default;
  render(<Settings params={{ slug: "launch-board" }} />);
  await screen.findByRole("heading", { name: "Title" });
  return api;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/a/launch-board/settings");
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});
afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the settings page's Board section", () => {
  it("is not there for another type", async () => {
    await open({ type: "html", id: "wb1" });
    expect(screen.queryByRole("heading", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Background" })).toBeNull();
  });

  it("saves the owner's choice as the next version, and the page shows its number", async () => {
    const user = userEvent.setup();
    const { calls } = await open({}, (c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        return json({ ...artifact(), version: 3, content: board("dots", "editors") });
      }
      if (c.method === "PUT" && c.path === "/artifacts/wb1") return json({ id: "wb1", version: 4 });
      return undefined;
    });
    const section = screen
      .getByRole("heading", { name: "Board" })
      .closest("section") as HTMLElement;
    const grid = await within(section).findByRole("radio", { name: "Grid" });
    const save = within(section).getByRole("button", { name: "Save board" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(grid);
    await user.click(save);
    await screen.findByText("Saved as v4");
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ base_version: 3 });
    await waitFor(() =>
      expect(document.querySelector(".pl-acct-settings__meta")?.textContent).toContain("v4"),
    );
    // The saved settings are now the ones read: nothing left to save.
    expect(save.disabled).toBe(true);
  });

  it("after a refused save shows the newer version's settings and number", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { calls } = await open({}, (c) => {
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        reads += 1;
        return json(
          reads === 1
            ? { ...artifact(), version: 3, content: board("dots", "editors") }
            : { ...artifact(), version: 5, content: board("plain", "commenters") },
        );
      }
      if (c.method === "PUT") {
        return json(
          {
            error: {
              code: "conflict",
              message: "Version 3 is not current; current is 5",
              details: { current_version: 5 },
            },
          },
          409,
        );
      }
      return undefined;
    });
    const section = screen
      .getByRole("heading", { name: "Board" })
      .closest("section") as HTMLElement;
    await user.click(await within(section).findByRole("radio", { name: "Grid" }));
    await user.click(within(section).getByRole("button", { name: "Save board" }));
    await within(section).findByText("v5 was published meanwhile. These are its settings.");
    expect(
      (within(section).getByRole("radio", { name: "Plain" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(section).getByRole("radio", { name: "Commenters and editors" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await waitFor(() =>
      expect(document.querySelector(".pl-acct-settings__meta")?.textContent).toContain("v5"),
    );
  });
});
