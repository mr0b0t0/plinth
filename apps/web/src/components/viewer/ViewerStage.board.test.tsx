// A whiteboard's ⋯ menu: owners and editors get "Board settings", which opens the dialog over the
// board and, after a save, loads the new version. Nobody gets a link to the source editor, and a
// commenter gets neither.
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

async function open(role: OkGate["role"]) {
  let version = 2;
  const { calls } = stubApi({
    me: ME,
    config: CONFIG,
    handle: (c: Call) => {
      if (c.path.startsWith("/view/")) return json(gate(role, version));
      if (c.path.includes("/comments")) return json({ items: [] });
      if (c.method === "GET" && c.path === "/artifacts/wb1") {
        return json({
          ...gate(role, version).artifact,
          content: '{\n  "v": 1,\n  "background": "dots",\n  "edit": "commenters"\n}\n',
        });
      }
      if (c.method === "PUT" && c.path === "/artifacts/wb1") {
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

describe("a whiteboard's Board settings", () => {
  it("opens from the ⋯ menu for an editor, saves a version and shows it", async () => {
    const { user, calls, menu } = await open("editor");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(items).toContain("Board settings");
    expect(items).not.toContain("Edit settings");
    expect(items).not.toContain("Edit");
    expect(items).not.toContain("Edit source");
    expect(menu.querySelector('a[href$="/edit"]')).toBeNull();

    await user.click(within(menu).getByRole("menuitem", { name: "Board settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Board settings" });
    await user.click(await within(dialog).findByRole("radio", { name: /^Grid/ }));
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

  it("is not offered to a commenter, and Cancel saves nothing", async () => {
    const { menu } = await open("commenter");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(items).not.toContain("Board settings");
    expect(items).not.toContain("Edit");
    cleanup();

    const owner = await open("owner");
    await owner.user.click(within(owner.menu).getByRole("menuitem", { name: "Board settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Board settings" });
    await within(dialog).findByRole("radio", { name: /^Dots/ });
    await owner.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(owner.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
