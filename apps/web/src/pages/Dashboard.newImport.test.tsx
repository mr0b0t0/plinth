// New and Import on the dashboard (docs/spec.md "New and Import"): the New menu offers a blank
// document and sheet where editing on the page works here, and always Import; a blank artifact is
// its registry row published as v1 "Created in the app", then opened with ?edit; an import sends
// the file as it is and shows the Worker's refusal with the cells it names; what the import left
// out or changed is one toast once the sheet is open. With nothing yet, New stands in the empty
// state beside Connect an agent, and New waits for the list before it takes either place.
import type { AppConfig, ArtifactSummary } from "@plinth/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LABEL } from "../components/account/NewMenu.tsx";
import { CHOOSE_ANOTHER_LABEL, PICKER_ATTR } from "../components/account/newArtifact.ts";
import { clearToasts, Toaster } from "../components/ui/index.ts";
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
  opts: {
    items?: ArtifactSummary[];
    publish?: (c: Call) => Response;
    /** Holds the list's answer until it resolves. */
    list?: Promise<void>;
  } = {},
) {
  return stubApi({
    me: ME,
    config,
    handle: (c) => {
      if (c.method === "GET" && c.path.startsWith("/artifacts")) {
        const answer = () => json({ items: opts.items ?? [ONE], categories: [] });
        return opts.list ? opts.list.then(answer) : answer();
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
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "New" });
  await user.click(trigger);
  return screen.getByRole("menu", { name: "New" });
}

/** The file the picker pickSpreadsheetFile opened gives back, as a browser does on a pick. */
function pick(file: File) {
  const input = document.querySelector(`input[${PICKER_ATTR}]`);
  if (!(input instanceof HTMLInputElement)) throw new Error("no file picker open");
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
}

/** New, then "Import a spreadsheet…", then this file in the picker it opens. */
async function importFile(user: ReturnType<typeof userEvent.setup>, file: File) {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  const menu = await openNew(user);
  await user.click(within(menu).getByRole("menuitem", { name: IMPORT_LABEL }));
  pick(file);
}

/** An .xlsx of these parts, with a two-column first sheet when none is given. */
function xlsxFile(name: string, parts: Record<string, string>): File {
  const files: Record<string, string> = {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Q4" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Apples</t></is></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>',
    ...parts,
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return new File([zip], name);
}

describe("the New menu", () => {
  it("offers a document, a deck, a sheet and Import, and nothing else", async () => {
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
    ).toEqual(["Document", "Slide deck", "Sheet", "Import a spreadsheet…"]);
    // Connect an agent has its own ways in (the sidebar, the empty state), not this menu.
    expect(within(menu).queryByRole("menuitem", { name: "Connect an agent" })).toBeNull();
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
    expect(names).toEqual(["Import a spreadsheet…"]);
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
    await importFile(user, new File(["Item,Qty\nApples,3\n"], "fruit_list.csv"));
    // One picker, the one a sheet's Replace opens too, gone once a file is picked.
    expect(document.querySelector(`input[${PICKER_ATTR}]`)).toBeNull();
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
    await importFile(user, new File([new Uint8Array([0x50, 0x4b, 3, 4])], "Book.xlsx"));
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
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText("Report");
    await importFile(user, new File(["%PDF"], "notes.pdf"));
    const first = await screen.findByRole("alertdialog", { name: "Could not import notes.pdf" });
    // The problem as the title, the cause as the one description line, the same buttons as a
    // sheet's Replace problem.
    expect(
      screen.getByRole("alertdialog", { description: "Pick a .xlsx, .csv or .tsv file." }),
    ).toBe(first);
    expect(within(first).getByRole("button", { name: CHOOSE_ANOTHER_LABEL })).toBeTruthy();
    expect(CHOOSE_ANOTHER_LABEL).toBe("Choose another file…");
    expect(posts(calls)).toHaveLength(0);
    // "Choose another file…" opens the same picker, from its click.
    await user.click(within(first).getByRole("button", { name: CHOOSE_ANOTHER_LABEL }));
    pick(new File(["a,b\n1,2\n"], "long.csv"));
    const dialog = await screen.findByRole("alertdialog", { name: "Could not import long.csv" });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["B7: the text is too long", "C8: the text is too long"]);
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("Import's warnings", () => {
  it("reads a CSV that is not UTF-8 as Windows-1252, and says so in one toast", async () => {
    const { calls } = backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(
      <>
        <Dashboard />
        <Toaster />
      </>,
    );
    await screen.findByText("Report");
    // "Item,Price\nCafé,3" as Excel on Windows saves it (é is 0xE9).
    const bytes = new Uint8Array([...strToU8("Item,Price\nCaf"), 0xe9, ...strToU8(",3\n")]);
    await importFile(user, new File([bytes], "menu.csv"));
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    expect(posts(calls)[0]?.body).toMatchObject({
      content_format: "csv",
      content: "Item,Price\nCafé,3\n",
    });
    const toast = (await screen.findByText("Imported menu.csv")).closest(".pl-toast");
    expect(toast?.textContent).toContain(
      "The file is not UTF-8, so it is read as Windows-1252. Check accented letters.",
    );
  });

  it("says which sheets were left out and how many formulas became values", async () => {
    backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(
      <>
        <Dashboard />
        <Toaster />
      </>,
    );
    await screen.findByText("Report");
    await importFile(
      user,
      xlsxFile("Q4_sales.xlsx", {
        "xl/workbook.xml":
          '<workbook><sheets><sheet name="Q4" r:id="rId1"/><sheet name="Q3" r:id="rId2"/><sheet name="Notes" r:id="rId3"/></sheets></workbook>',
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Apples</t></is></c><c r="B2"><f>Q3!B2</f><v>3</v></c></row></sheetData></worksheet>',
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    const toast = (await screen.findByText("Imported Q4_sales.xlsx")).closest(".pl-toast");
    expect(toast?.textContent).toContain(
      "Only the first sheet is used; “Q3” and “Notes” are left out. 1 formula becomes a plain value.",
    );
  });

  it("shows no toast for a file imported whole, and notes the name without bidi characters", async () => {
    const { calls } = backend(ROOM);
    const Dashboard = await loadPage();
    const user = userEvent.setup();
    render(
      <>
        <Dashboard />
        <Toaster />
      </>,
    );
    await screen.findByText("Report");
    await importFile(user, new File(["Item,Qty\nApples,3\n"], "\u202Bfruit\u200F\u0085\u2066.csv"));
    await waitFor(() => expect(window.location.pathname).toBe("/a/untitled"));
    expect(posts(calls)[0]?.body).toMatchObject({ note: "Imported from fruit.csv" });
    expect(document.querySelector(".pl-toast")).toBeNull();
  });
});

describe("the empty state", () => {
  it("puts New beside Connect an agent, with no extra paragraph", async () => {
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
    expect(screen.queryByText(/with New/)).toBeNull();
  });

  it("waits for the list before placing New, in the top bar or the empty state", async () => {
    for (const items of [[ONE], []]) {
      let release = () => {};
      const list = new Promise<void>((r) => {
        release = r;
      });
      const { calls } = backend(ROOM, { items, list });
      const Dashboard = await loadPage();
      render(<Dashboard />);
      // While the list loads there is no New anywhere, so it never jumps between the two.
      await waitFor(() =>
        expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/artifacts"))).toBe(true),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("button", { name: "New" })).toBeNull();
      await act(async () => release());
      const button = await screen.findByRole("button", { name: "New" });
      expect(button.closest(".pl-empty") !== null).toBe(items.length === 0);
      expect(screen.getAllByRole("button", { name: "New" })).toHaveLength(1);
      cleanup();
    }
  });
});

describe("NewMenu", () => {
  it("renders nothing when there is nothing to offer", async () => {
    const { NewMenu } = await import("../components/account/NewMenu.tsx");
    const none: AppConfig = {
      ...OFF,
      artifact_types: [{ id: "sheet", available: false }],
    };
    const { container } = render(<NewMenu config={none} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });
});
