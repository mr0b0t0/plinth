// Editing a sheet on its page, live across editors (#36, live sheets): the owner and an editor
// have the sheet open in two browser contexts. A cell one of them opens shows its row held, with
// their email, in the other; the typing arrives as it is typed; inserting a row moves the formulas
// on both pages; Publish makes the next version; and a version an agent publishes with edit_sheet
// meanwhile is never merged: the page edits freeze, and the whole-draft review in the page
// publishes them as they are or discards them.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

const HEADER = JSON.stringify({
  plinth: "sheet",
  v: 1,
  columns: [
    { name: "Item", type: "text", width: 160 },
    { name: "Qty", type: "number" },
    { name: "Price", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
    { name: "Paid", type: "checkbox" },
  ],
});
const SHEET = [
  HEADER,
  '["Apples",3,1.5,true]',
  '["Pears",5,0.5,false]',
  '["Plums",2,2]',
  '["Total","=SUM(B2:B4)","=SUM(C2:C4)"]',
].join("\n");

interface Setup {
  slug: string;
  id: string;
  token: string;
  owner: string;
  editor: string;
}

async function setup(page: Page, content = SHEET): Promise<Setup> {
  const owner = uniqueEmail("sheet-owner");
  const editor = uniqueEmail("sheet-editor");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Fruit",
    type: "sheet",
    content,
    html: undefined,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: editor, role: "editor" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return { slug: art.slug, id: art.id, token, owner, editor };
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const cell = (page: Page, a: string) => frameOf(page).locator(`#__plinth-cell-${a}`);
/** The open cell's field: in the cell, or docked at the bottom of the page at phone width. */
const fieldOf = (page: Page) => frameOf(page).locator(".plinth-sheet__input");

async function openAs(browser: Browser, email: string, slug: string, base?: Page) {
  const page = base ?? (await (await browser.newContext()).newPage());
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  return page;
}

/** Choose an item of a row's menu, opened from its number. */
async function rowMenu(page: Page, row: number, item: string) {
  await frameOf(page).locator(`tr[data-row="${row}"] th`).click();
  const menu = frameOf(page).getByRole("menu", { name: `Row ${row}` });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
}

async function startEditing(page: Page) {
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  const bar = page.getByRole("region", { name: "Editing on the page" });
  await expect(bar).toBeVisible();
  await expect(frameOf(page).locator(".plinth-sheet__page--editing")).toBeVisible();
  await expect(bar).not.toContainText("Connecting", { timeout: 10_000 });
  await expect(bar).not.toContainText("Not connected");
}

test("two editors on one sheet: a held row, typing that arrives live, a row both see, Publish makes v2", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(browser, s.owner, s.slug, page);
  const other = await openAs(browser, s.editor, s.slug);
  await startEditing(page);
  await startEditing(other);

  // The owner opens Qty of Apples and types.
  await cell(page, "B2").dblclick();
  const field = fieldOf(page);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("3");
  await field.fill("30");

  // The editor sees the row held, with the owner's email, and the value as it arrives.
  await expect(
    frameOf(other).locator("tr.plinth-sheet__row--held .plinth-sheet__holder"),
  ).toHaveText(`${s.owner} is editing`);
  await expect(cell(other, "B2")).toHaveText("30");
  await expect(cell(other, "B5")).toHaveText("37");
  await expect(other.getByRole("region", { name: "Editing on the page" })).toContainText(s.owner);
  // Opening a cell of that row does not open it.
  await cell(other, "A2").dblclick();
  await expect(frameOf(other).locator(".plinth-sheet__input")).toHaveCount(0);
  await expect(frameOf(other).locator(".plinth-sheet__notice")).toContainText(
    `${s.owner} is editing this row.`,
  );

  // The editor edits another row at the same time, by typing into a selected cell.
  await cell(other, "A3").click();
  await cell(other, "A3").press("P");
  const theirs = fieldOf(other);
  await expect(theirs).toHaveValue("P");
  await theirs.fill("Pears, ripe");
  await theirs.press("Enter");
  await expect(cell(page, "A3")).toHaveText("Pears, ripe");

  // A value the column cannot hold stays in the field with the reason.
  await field.fill("thirty");
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(frameOf(page).locator(".plinth-sheet__notice")).toContainText("Qty takes numbers");
  await field.fill("30");
  await field.press("Enter");
  await expect(frameOf(page).locator(".plinth-sheet__input")).toHaveCount(0);
  await expect(cell(page, "B3")).toBeFocused();

  // A row inserted above Plums: both pages show it, and the totals' ranges grow.
  await rowMenu(page, 4, "Insert row above");
  await expect(frameOf(page).locator("html")).toHaveAttribute("data-rows", "5");
  await expect(frameOf(other).locator("html")).toHaveAttribute("data-rows", "5");
  await expect(cell(other, "A6")).toHaveText("Total");
  await expect(cell(other, "B6")).toHaveText("37");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toContainText(
    "Published as v2",
  );
  const detail = await apiGet(page.request, `/artifacts/${s.id}`);
  expect(detail.body.current_version).toBe(2);
  expect((detail.body.content as string).split("\n")).toEqual([
    HEADER,
    '["Apples",30,1.5,true]',
    '["Pears, ripe",5,0.5,false]',
    "[]",
    '["Plums",2,2]',
    '["Total","=SUM(B2:B5)","=SUM(C2:C5)"]',
  ]);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Editing on the page" })).toHaveCount(0);
  await other.context().close();
});

test("an agent's edit_sheet during the page edits is never merged: the review publishes mine or discards it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const bar = page.getByRole("region", { name: "Editing on the page" });

  /** Type `value` into a cell and wait until the strip shows the edit. */
  async function type(a: string, value: string) {
    await cell(page, a).dblclick();
    const field = fieldOf(page);
    await field.fill(value);
    await field.press("Enter");
    await expect(bar).toContainText(/Draft saved|Saving draft/);
  }

  /** The agent sets one cell with edit_sheet on `base`. */
  async function agentSets(at: string, value: number, base: number) {
    const client = await mcpClient(s.token);
    try {
      const r = await tool<{ version: number; warnings: { code: string }[] }>(
        client,
        "edit_sheet",
        {
          id: s.id,
          base_version: base,
          ops: [{ op: "set", at, values: [[value]] }],
        },
      );
      expect(r.isError, r.text).toBe(false);
      expect(r.data.warnings.map((w) => w.code)).toContain("live_draft");
    } finally {
      await client.close();
    }
  }

  // The agent changes the row right below the page's edit: still never merged.
  await type("B2", "4");
  await agentSets("B3", 6, 1);
  await expect(bar).toContainText("v2 was published while you edited. Review it to go on.", {
    timeout: 10_000,
  });
  await bar.getByRole("button", { name: "Review changes" }).click();
  // The review is in the page itself: both grids, and what each side changed.
  const review = frameOf(page).getByRole("region", { name: "Review v2 and the page changes" });
  await expect(review.getByRole("heading", { level: 2 })).toHaveText(
    "v2 was published while you were editing",
  );
  const mine = review.getByRole("region", { name: "Your page changes" });
  await expect(mine).toContainText("B2 changed");
  await expect(mine).toContainText("3 → 4");
  await expect(mine.locator("table")).toBeVisible();
  // At phone width one sheet shows at a time, with a switch between them.
  const toV2 = review.getByRole("radio", { name: "v2" });
  if (await toV2.isVisible()) {
    await toV2.click();
    await expect(mine).toBeHidden();
  }
  await expect(review.getByRole("region", { name: "v2" })).toContainText("B3 changed");
  await expect(review.getByRole("region", { name: "v2" })).toContainText("No files changed");
  // Cancel keeps the draft frozen, and the review opens again.
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toHaveCount(0);
  await expect(bar).toContainText("Review it to go on.");
  await bar.getByRole("button", { name: "Review changes" }).click();

  // Publish mine: the page edits become v3 as they are; v2 stays in the history.
  await review.getByRole("button", { name: "Publish mine", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(bar).toContainText("Published as v3", { timeout: 10_000 });
  const v3 = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
  expect(v3.split("\n").slice(1, 3)).toEqual(['["Apples",4,1.5,true]', '["Pears",5,0.5,false]']);
  const versions = await apiGet(page.request, `/artifacts/${s.id}/versions`);
  expect(versions.body.items[0]).toMatchObject({
    number: 3,
    note: "Edited on the page. Replaces the changes in v2.",
  });
  expect(versions.body.items[1]).toMatchObject({ number: 2 });

  // Editing resumes on v3. Discard mine asks first, naming what would be lost.
  await type("B2", "7");
  await agentSets("B4", 9, 3);
  await expect(bar).toContainText("v4 was published while you edited.", { timeout: 10_000 });
  await bar.getByRole("button", { name: "Review changes" }).click();
  const second = frameOf(page).getByRole("region", { name: "Review v4 and the page changes" });
  await second.getByRole("button", { name: "Discard mine" }).click();
  const confirm = frameOf(page).getByRole("alertdialog", { name: "Discard the page changes?" });
  await expect(confirm).toContainText("This change will be lost:");
  await expect(confirm).toContainText("B2 changed");
  await expect(confirm).toContainText("The page will show v4.");
  // Clicked with the pointer left resting on any notification first: no toast covers the
  // review's choices, at phone width either, and a resting pointer does not keep one for good.
  const toast = await page.locator(".pl-toast").first().boundingBox();
  if (toast) await page.mouse.move(toast.x + toast.width / 2, toast.y + toast.height / 2);
  await confirm.getByRole("button", { name: "Discard the page changes" }).click();
  await expect(frameOf(page).locator(".plinth-review__announce")).toHaveText(
    "The page changes were discarded. The page shows v4.",
    { timeout: 10_000 },
  );
  await expect(cell(page, "B2")).toHaveText("4");
  await expect(cell(page, "B4")).toHaveText("9");
  const after = await apiGet(page.request, `/artifacts/${s.id}`);
  expect(after.body.current_version).toBe(4);
});

/**
 * Choose an item of a column's menu, opened from its header's button, which shows once the
 * header has the focus (or the pointer, or the selected cell is in its column).
 */
async function columnMenu(page: Page, a: string, item: string) {
  await cell(page, a).locator(".plinth-sheet__sort").focus();
  await cell(page, a).locator(".plinth-sheet__colmenu").click();
  const menu = frameOf(page).getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item }).click();
  await expect(menu).toHaveCount(0);
}

test("column settings, widths, freezing, options and row moves on the page publish as one version", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const header = JSON.stringify({
    plinth: "sheet",
    v: 1,
    columns: [
      { name: "Item", type: "text" },
      { name: "Qty", type: "number" },
      { name: "Price", type: "number", format: { style: "currency", currency: "EUR" } },
      { name: "Stage", type: "select", options: ["new", "done"] },
    ],
  });
  const s = await setup(
    page,
    [header, '["Apples",3,1500,"new"]', '["Pears",5,2,"done"]', '["Total","=SUM(B2:B3)"]'].join(
      "\n",
    ),
  );
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const bar = page.getByRole("region", { name: "Editing on the page" });
  const frame = frameOf(page);
  const settings = frame.locator(".plinth-sheet__panel");
  const saved = async () => expect(bar).toContainText(/Draft saved|Saving draft/);

  // Price: no thousands separators.
  await columnMenu(page, "C1", "Column settings…");
  await expect(settings).toBeVisible();
  await settings.getByLabel("Thousands separators").uncheck();
  await settings.getByRole("button", { name: "Apply" }).click();
  await expect(settings).toHaveCount(0);
  await expect(cell(page, "C2")).not.toContainText(/1[,.\s  ]500/);
  await saved();

  // Price 180 px wide, by dragging its header's edge 60 px to the right.
  const handle = cell(page, "C1").locator(".plinth-sheet__resize");
  await handle.scrollIntoViewIfNeeded();
  const edge = await handle.boundingBox();
  if (!edge) throw new Error("no width handle");
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y);
  await page.mouse.move(x + 60, y);
  await page.mouse.up();
  await expect(frame.locator(".plinth-sheet__announce")).toHaveText("Price: 180 pixels wide.");
  await saved();

  // Stage: "done" renamed "shipped" (in its cell too), and a third option added.
  await columnMenu(page, "D1", "Column settings…");
  await settings.getByLabel("Option 2").fill("shipped");
  await settings.getByLabel("New option").fill("later");
  await settings.getByLabel("New option").press("Enter");
  await expect(settings.getByLabel("Option 3")).toHaveValue("later");
  await settings.getByRole("button", { name: "Apply" }).click();
  await expect(cell(page, "D3")).toHaveText("shipped");

  // Item stays in view; Qty two steps wider with the keyboard.
  await columnMenu(page, "A1", "Freeze up to this column");
  await expect(cell(page, "A2")).toHaveClass(/plinth-sheet__frozen/);
  await cell(page, "B1").locator(".plinth-sheet__sort").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(frame.locator(".plinth-sheet__announce")).toHaveText("Qty: 136 pixels wide.", {
    timeout: 10_000,
  });
  // The width is sent once the keys rest (WIDTH_DEBOUNCE_MS).
  await page.waitForTimeout(800);

  // Pears above Apples: the total still adds both.
  await rowMenu(page, 3, "Move row up");
  await expect(cell(page, "A2")).toHaveText("Pears");
  await expect(frame.locator(".plinth-sheet__announce")).toHaveText("Row 3 moved to row 2.");
  await expect(cell(page, "B4")).toHaveText("8");
  await saved();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(bar).toContainText("Published as v2", { timeout: 10_000 });
  const detail = await apiGet(page.request, `/artifacts/${s.id}`);
  const lines = (detail.body.content as string).split("\n");
  expect(JSON.parse(lines[0] as string)).toEqual({
    plinth: "sheet",
    v: 1,
    columns: [
      { name: "Item", type: "text" },
      { name: "Qty", type: "number", width: 136 },
      {
        name: "Price",
        type: "number",
        width: 180,
        format: { style: "currency", currency: "EUR", grouping: false },
      },
      { name: "Stage", type: "select", options: ["new", "shipped", "later"] },
    ],
    freeze: { cols: 1 },
  });
  expect(lines.slice(1)).toEqual([
    '["Pears",5,2,"shipped"]',
    '["Apples",3,1500,"new"]',
    '["Total","=SUM(B2:B3)"]',
  ]);
});

test("a cell opens in a docked editor at phone width, and in the cell otherwise", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const frame = frameOf(page);
  await cell(page, "B3").dblclick();
  const field = fieldOf(page);
  await expect(field).toBeFocused();
  const phone = (page.viewportSize()?.width ?? 1024) <= 640;
  const dock = frame.getByRole("group", { name: "Edit B3" });
  if (phone) {
    await expect(dock).toBeVisible();
    await expect(dock).toContainText("Qty");
    await expect(cell(page, "B3").locator(".plinth-sheet__input")).toHaveCount(0);
    // The docked editor fits the page: no sideways scroll.
    const box = await dock.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 361).toBe(true);
    await field.fill("12");
    await dock.getByRole("button", { name: "Done" }).click();
    await expect(dock).toHaveCount(0);
  } else {
    await expect(dock).toHaveCount(0);
    await expect(cell(page, "B3").locator(".plinth-sheet__input")).toHaveCount(1);
    await field.fill("12");
    await field.press("Enter");
  }
  await expect(cell(page, "B3")).toHaveText("12");
  await expect(cell(page, "B5")).toHaveText("17");
  // A row's menu, from its number: a sheet across the bottom at phone width.
  await frame.locator('tr[data-row="4"] th').click();
  const menu = frame.getByRole("menu", { name: "Row 4" });
  await expect(menu).toBeVisible();
  if (phone) await expect(menu).toHaveClass(/plinth-sheet__menu--sheet/);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("an agent's version during a row move or a width change is never merged: the review shows both", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const s = await setup(page);
  await openAs(page.context().browser() as Browser, s.owner, s.slug, page);
  await startEditing(page);
  const bar = page.getByRole("region", { name: "Editing on the page" });

  async function agentSets(at: string, value: number, base: number) {
    const client = await mcpClient(s.token);
    try {
      const r = await tool<{ version: number }>(client, "edit_sheet", {
        id: s.id,
        base_version: base,
        ops: [{ op: "set", at, values: [[value]] }],
      });
      expect(r.isError, r.text).toBe(false);
    } finally {
      await client.close();
    }
  }

  // A row swap on the page, an agent's cell meanwhile: Publish mine keeps the swap.
  await rowMenu(page, 3, "Move row up");
  await expect(cell(page, "A2")).toHaveText("Pears");
  await expect(bar).toContainText(/Draft saved|Saving draft/);
  await agentSets("B4", 9, 1);
  await expect(bar).toContainText("v2 was published while you edited.", { timeout: 10_000 });
  await bar.getByRole("button", { name: "Review changes" }).click();
  const review = frameOf(page).getByRole("region", { name: "Review v2 and the page changes" });
  const mine = review.getByRole("region", { name: "Your page changes" });
  await expect(mine).toContainText("Row 2 removed");
  await expect(mine).toContainText("Row 3 added");
  await review.getByRole("button", { name: "Publish mine", exact: true }).click();
  await expect(bar).toContainText("Published as v3", { timeout: 10_000 });
  const v3 = (await apiGet(page.request, `/artifacts/${s.id}`)).body.content as string;
  expect(v3.split("\n").slice(1)).toEqual([
    '["Pears",5,0.5,false]',
    '["Apples",3,1.5,true]',
    '["Plums",2,2]',
    '["Total","=SUM(B2:B4)","=SUM(C2:C4)"]',
  ]);

  // A width on the page, an agent's cell meanwhile: Discard mine goes back to the agent's.
  await cell(page, "B1").locator(".plinth-sheet__sort").focus();
  await page.keyboard.press("Alt+ArrowRight");
  // The width is sent once the keys rest (WIDTH_DEBOUNCE_MS).
  await page.waitForTimeout(800);
  await expect(bar).toContainText(/Draft saved|Saving draft/, { timeout: 10_000 });
  await agentSets("B4", 4, 3);
  await expect(bar).toContainText("v4 was published while you edited.", { timeout: 10_000 });
  await bar.getByRole("button", { name: "Review changes" }).click();
  const second = frameOf(page).getByRole("region", { name: "Review v4 and the page changes" });
  await expect(second.getByRole("region", { name: "Your page changes" })).toContainText(
    "width changed",
  );
  await second.getByRole("button", { name: "Discard mine" }).click();
  const confirm = frameOf(page).getByRole("alertdialog", { name: "Discard the page changes?" });
  await confirm.getByRole("button", { name: "Discard the page changes" }).click();
  await expect(frameOf(page).locator(".plinth-review__announce")).toHaveText(
    "The page changes were discarded. The page shows v4.",
    { timeout: 10_000 },
  );
  const v4 = (await apiGet(page.request, `/artifacts/${s.id}`)).body;
  expect(v4.current_version).toBe(4);
  expect(JSON.parse((v4.content as string).split("\n")[0] as string).columns[1]).toEqual({
    name: "Qty",
    type: "number",
  });
});
