// New and Import on the dashboard (docs/spec.md "New and Import"): the New menu offers a blank
// document and sheet where editing on the page works here, and always Import; a blank artifact is
// its registry row published as v1 "Created in the app", then opened with ?edit; an import sends
// the file as it is and shows the Worker's refusal with the cells it names. With nothing yet, New
// stands in the empty state beside Connect an agent.
import type { AppConfig, ArtifactSummary } from "@plinth/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, CONFIG, json, ME, stubApi } from "../components/viewer/test-utils.ts";

async function loadPage() {
  vi.resetModules();
  return (await import("./Dashboard.tsx")).default;
}

const ONE: ArtifactSummary = {
  id: "art1",
  slug: "s1",
  title: "Report",
  type: "html",
  visibility: "allowlist",
  current_version: 1,
  version_count: 1,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  url: "http://app.localhost:8787/a/s1",
  content_url: "http://art1.content.localhost:8787/",
  owner: { id: "u1", email: "ada@example.org", name: null },
  role: "owner",
  taken_down: false,
  thumbnail_url: null,
  category: null,
};

const ROOM: AppConfig = { ...CONFIG, inline_editing: "room" };
const OFF: AppConfig = { ...CONFIG, inline_editing: null };

function backend(
  config: AppConfig,
  opts: { items?: ArtifactSummary[]; publish?: (c: Call) => Response } = {},
) {
  return stubApi({
    me: ME,
    config,
    handle: (c) => {
      if (c.method === "GET" && c.path.startsWith("/artifacts")) {
        return json({ items: opts.items ?? [ONE], categories: [] });
      }
      if (c.method === "POST" && c.path === "/artifacts") {
        if (opts.publish) return opts.publish(c);
        const b = c.body as { type: string; title: string };
        return json({ id: "new1", slug: "untitled", type: b.type, version: 1 }, 201);
      }
      return undefined;
    },
  });
}

const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path === "/artifacts");

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard");
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-plinth_csrf=tok-123; plinth_csrf=tok-123",
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "New" });
  await user.click(trigger);
  return screen.getByRole("menu", { name: "New" });
}

describe("the New menu", () => {
  it("offers a document, a sheet and Import, and says pages and designs come from agents", async () => {
    backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    const menu = await openNew(user);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.firstChild && i.textContent),
    ).toEqual([
      "Document",
      "Sheet",
      "Import a spreadsheet (.xlsx, .csv)…",
      "Connect an agentPages and designs are made by your agents.",
    ]);
    const connect = within(menu).getByRole("menuitem", { name: "Connect an agent" });
    expect(connect.getAttribute("href")).toBe("/connections?connect=1");
    expect(
      document.getElementById(connect.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Pages and designs are made by your agents.");
  });

  it("offers only Import where editing on the page is off", async () => {
    backend(OFF);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    const menu = await openNew(user);
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.getAttribute("aria-describedby") === null && i.textContent);
    expect(names).toEqual(["Import a spreadsheet (.xlsx, .csv)…", false]);
  });

  it("publishes a blank document as v1 'Created in the app' and opens it in edit mode", async () => {
    const { calls } = backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    const menu = await openNew(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Document" }));
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    expect(window.location.search).toBe("?edit");
    expect(posts(calls).map((c) => c.body)).toEqual([
      {
        title: "Untitled document",
        type: "doc",
        content: "# Untitled document\n",
        note: "Created in the app",
      },
    ]);
  });

  it("says why a blank artifact was not created, and stays", async () => {
    backend(ROOM, {
      publish: () =>
        json(
          {
            error: {
              code: "forbidden",
              message: "You have reached your limit of 100 artifacts",
            },
          },
          403,
        ),
    });
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    const menu = await openNew(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Sheet" }));
    expect(await screen.findByText("Could not create the sheet")).toBeTruthy();
    expect(screen.getByText("You have reached your limit of 100 artifacts")).toBeTruthy();
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("Import", () => {
  it("sends a CSV as it is, titled from its name, and opens the new sheet in edit mode", async () => {
    const { calls } = backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    const input = screen.getByTestId("new-import-file") as HTMLInputElement;
    expect(input.accept).toContain(".xlsx");
    await user.upload(input, new File(["Item,Qty\nApples,3\n"], "fruit_list.csv"));
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    expect(window.location.search).toBe("?edit");
    expect(posts(calls).map((c) => c.body)).toEqual([
      {
        title: "fruit list",
        type: "sheet",
        content_format: "csv",
        content: "Item,Qty\nApples,3\n",
        note: "Imported from fruit_list.csv",
      },
    ]);
  });

  it("opens an imported sheet on its page where editing on the page is off", async () => {
    backend(OFF);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    await user.upload(
      screen.getByTestId("new-import-file") as HTMLInputElement,
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], "Book.xlsx"),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    expect(window.location.search).toBe("");
  });

  it("shows a refusal with the cells it names, and sends nothing for a file it cannot take", async () => {
    const { calls } = backend(ROOM, {
      publish: () =>
        json(
          {
            error: {
              code: "invalid_input",
              message: "This sheet has 2 problems; the first ones are listed in details.issues",
              details: {
                issues: [
                  { line: 7, cell: "B7", code: "cell", message: "B7: the text is too long" },
                  { line: 8, cell: "C8", code: "cell", message: "C8: the text is too long" },
                ],
                count: 2,
              },
            },
          },
          400,
        ),
    });
    const Dashboard = await loadPage();
    const user = userEvent.setup({ applyAccept: false });
    render(<Dashboard />);
    await screen.findByText("Report");
    const input = screen.getByTestId("new-import-file") as HTMLInputElement;
    await user.upload(input, new File(["%PDF"], "notes.pdf"));
    const first = await screen.findByRole("alertdialog", {
      name: "This file could not be imported",
    });
    expect(first.textContent).toContain("notes.pdf: Pick a .xlsx, .csv or .tsv file.");
    expect(posts(calls)).toHaveLength(0);
    await user.click(within(first).getByRole("button", { name: "Cancel" }));

    await user.upload(input, new File(["a,b\n1,2\n"], "long.csv"));
    const dialog = await screen.findByRole("alertdialog", {
      name: "This file could not be imported",
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["B7: the text is too long", "C8: the text is too long"]);
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("the empty state", () => {
  it("puts New beside Connect an agent and says what it can start", async () => {
    backend(ROOM, { items: [] });
    const Dashboard = await loadPage();
    render(<Dashboard />);
    const empty = (await screen.findByText("Nothing on display yet")).closest(".pl-empty");
    if (!(empty instanceof HTMLElement)) throw new Error("empty state");
    const actions = empty.querySelector(".pl-empty__action") as HTMLElement;
    expect(within(actions).getByRole("link", { name: "Connect an agent" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "New" })).toBeTruthy();
    // Not twice: the top bar has no New while the empty state shows one.
    expect(screen.getAllByRole("button", { name: "New" })).toHaveLength(1);
    expect(
      screen.getByText(
        "Or start a document or a sheet yourself with New, or import a spreadsheet.",
      ),
    ).toBeTruthy();
  });

  it("says only Import where editing on the page is off", async () => {
    backend(OFF, { items: [] });
    const Dashboard = await loadPage();
    render(<Dashboard />);
    expect(await screen.findByText("Or import a spreadsheet with New.")).toBeTruthy();
  });
});
