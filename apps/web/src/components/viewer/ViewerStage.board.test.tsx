// A whiteboard's ⋯ menu has one Settings item. For an editor it opens the Board settings dialog over
// the board and, after a save, loads the new version; after a refused save it loads the newer
// version behind the dialog, so the page matches the settings the dialog now shows. For the owner
// it stays the link to the settings page, whose Board section holds the same choices. Nobody gets a
// link to the source editor, and a commenter gets neither.
import type { ViewGate } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, CONFIG, json, ME, stubApi } from "./test-utils.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

const gate = (role: OkGate["role"], version = 2): OkGate => ({
  status: "ok",
  artifact: {
    id: "wb1",
    slug: "launch-board",
    title: "Launch board",
    type: "whiteboard",
    current_version: version,
    version,
    visibility: "allowlist",
    owner_name: "Ada",
  },
  enter_url: `http://wb1.content.localhost:8787/__plinth/enter?t=token-${version}&next=%2F`,
  role,
});

const DOTS = '{\n  "v": 1,\n  "background": "dots",\n  "edit": "commenters"\n}\n';
const PLAIN = '{\n  "v": 1,\n  "background": "plain",\n  "edit": "editors"\n}\n';

beforeEach(() => {
  window.history.replaceState(null, "", "/a/launch-board");
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Open the board as `role` and its ⋯ menu. With `agentPublishes`, an agent publishes v3 (new
 * settings) as soon as the dialog has read v2, so the person's save is refused as stale.
 */
async function open(role: OkGate["role"], { agentPublishes = false } = {}) {
  let version = 2;
  let content = DOTS;
  const { calls } = stubApi({
    me: ME,
    config: CONFIG,
    handle: (c: Call) => {
      if (c.path.startsWith("/view/")) return json(gate(role, version));
      if (c.path.includes("/comments")) return json({ items: [] });
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        const read = json({ ...gate(role, version).artifact, content });
        if (agentPublishes && version === 2) {
          version = 3;
          content = PLAIN;
        }
        return read;
      }
      if (c.method === "PUT" && c.path === "/artifacts/wb1") {
        const base = (c.body as { base_version: number }).base_version;
        if (base !== version) {
          return json(
            {
              error: {
                code: "conflict",
                message: `Version ${base} is not current; current is ${version}`,
                details: { current_version: version },
              },
            },
            409,
          );
        }
        version += 1;
        return json({ id: "wb1", slug: "launch-board", type: "whiteboard", version });
      }
      return undefined;
    },
  });
  vi.resetModules();
  const ArtifactPage = (await import("../../pages/ArtifactPage.tsx")).default;
  render(<ArtifactPage params={{ slug: "launch-board" }} />);
  await screen.findByTitle("Launch board, version 2");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Artifact actions" }));
  return { user, calls, menu: screen.getByRole("menu") };
}

const labels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.textContent);

describe("a whiteboard's settings in the ⋯ menu", () => {
  it("is one Settings item that opens the dialog for an editor, saves a version and shows it", async () => {
    const { user, calls, menu } = await open("editor");
    const items = labels(menu);
    expect(items.filter((l) => l?.includes("Settings") || l?.includes("settings"))).toEqual([
      "Settings",
    ]);
    expect(items).not.toContain("Edit settings");
    expect(items).not.toContain("Edit");
    expect(items).not.toContain("Edit source");
    expect(menu.querySelector('a[href$="/edit"]')).toBeNull();
    // An editor has no settings page: the item opens the dialog, it is not a link.
    expect(menu.querySelector('a[href$="/settings"]')).toBeNull();

    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Board settings" });
    await user.click(await within(dialog).findByRole("radio", { name: "Grid" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // The dialog closes and the page loads the new version.
    await screen.findByTitle("Launch board, version 3");
    expect(screen.queryByRole("dialog", { name: "Board settings" })).toBeNull();
    const put = calls.find((c) => c.method === "PUT");
    if (!put) throw new Error("no PUT");
    expect(put.body).toMatchObject({ base_version: 2 });
    expect(JSON.parse((put.body as { content: string }).content)).toEqual({
      v: 1,
      background: "grid",
      edit: "commenters",
    });
  });

  it("after a refused save, loads the newer version behind the dialog that shows its settings", async () => {
    const { user, calls, menu } = await open("editor", { agentPublishes: true });
    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Board settings" });
    await user.click(await within(dialog).findByRole("radio", { name: "Grid" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await within(dialog).findByText("v3 was published meanwhile. These are its settings.");
    // The page behind the dialog shows v3 too, and the dialog stays open on v3's settings.
    await screen.findByTitle("Launch board, version 3");
    expect(screen.getByRole("dialog", { name: "Board settings" })).toBe(dialog);
    expect((within(dialog).getByRole("radio", { name: "Plain" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("stays the owner's settings page link, and is not offered to a commenter", async () => {
    const owner = await open("owner");
    const items = labels(owner.menu);
    expect(items.filter((l) => l?.includes("Settings") || l?.includes("settings"))).toEqual([
      "Settings",
    ]);
    expect(
      within(owner.menu).getByRole("menuitem", { name: "Settings" }).getAttribute("href"),
    ).toBe("/a/launch-board/settings");
    cleanup();

    const { menu } = await open("commenter");
    expect(labels(menu).some((l) => l?.toLowerCase().includes("settings"))).toBe(false);
    expect(labels(menu)).not.toContain("Edit");
  });

  it("Cancel closes the dialog and saves nothing", async () => {
    const { user, calls, menu } = await open("editor");
    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Board settings" });
    await within(dialog).findByRole("radio", { name: "Dots" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
