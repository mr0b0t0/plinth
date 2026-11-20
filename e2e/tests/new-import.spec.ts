// New, Import and Replace with a file (docs/spec.md "New and Import"), under origin isolation with
// live rooms: New on the dashboard makes a blank document or sheet that opens in edit mode with
// the focus on its title or first cell, and Publish makes v2; Import sends an .xlsx that the Worker
// converts and opens the sheet in edit mode; a sheet's "Replace with a file…" confirms, asks again
// when an agent published meanwhile, keeps the artifact, and is off while the page is edited.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { apiGet, apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { CURRENT_FRAME } from "../support/viewer.ts";
import { xlsxOf } from "../support/xlsx.ts";

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const cell = (page: Page, a: string) => frameOf(page).locator(`#__plinth-cell-${a}`);
const bar = (page: Page) => page.getByRole("region", { name: "Editing on the page" });

async function openNew(page: Page) {
  // While there is nothing yet, New stands in the empty state; otherwise in the top bar.
  await page.getByRole("button", { name: "New", exact: true }).click();
  return page.getByRole("menu", { name: "New" });
}

/** The artifact this page shows, from its address. */
const slugOf = (page: Page) => /\/a\/([^/?#]+)/.exec(page.url())?.[1] ?? "";

test("New document: v1 'Created in the app' opens in edit mode on its title, and Publish makes v2", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("new-doc");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  const menu = await openNew(page);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Document",
    "Sheet",
    "Import a spreadsheet…",
  ]);
  const axe = await new AxeBuilder({ page }).include(".pl-menu__list").analyze();
  expect(axe.violations).toEqual([]);
  await menu.getByRole("menuitem", { name: "Document", exact: true }).click();

  await expect(page).toHaveURL(/\/a\/[^/?]+$/);
  await expect(bar(page)).toBeVisible();
  const field = frameOf(page).locator("textarea.plinth-doc__field");
  await expect(field).toHaveValue("# Untitled document", { timeout: 15_000 });
  await expect(field).toBeFocused();
  await field.fill("# Trip plan\n\nDay one: the coast.");
  await field.press("Escape");
  await expect(frameOf(page).locator("h1")).toContainText("Trip plan");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(bar(page)).toContainText("Published as v2", { timeout: 10_000 });

  const slug = slugOf(page);
  const detail = await apiGet(page.request, `/artifacts/${slug}`);
  expect(detail.body).toMatchObject({ type: "doc", current_version: 2, visibility: "allowlist" });
  expect(detail.body.content).toContain("Day one: the coast.");
  const versions = await apiGet(page.request, `/artifacts/${slug}/versions`);
  expect(versions.body.items.map((v: { note: string }) => v.note)).toEqual([
    "Edited on the page",
    "Created in the app",
  ]);
});

test("New sheet opens in edit mode on A2, and typing fills it", async ({ page }) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("new-sheet");
  const { token } = await seedToken(email, { label: "Work agent" });
  await publishArtifact(page.request, token, { title: "Notes" });
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Notes" }).first()).toBeVisible();
  const menu = await openNew(page);
  await menu.getByRole("menuitem", { name: "Sheet", exact: true }).click();

  await expect(bar(page)).toBeVisible();
  await expect(cell(page, "A1")).toHaveText(/Column 1/, { timeout: 15_000 });
  await expect(cell(page, "A2")).toBeFocused();
  await page.keyboard.press("A");
  const input = frameOf(page).locator("#__plinth-cell-A2 .plinth-sheet__input");
  await expect(input).toHaveValue("A");
  await input.fill("Apples");
  await input.press("Enter");
  await expect(cell(page, "A2")).toHaveText("Apples");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(bar(page)).toContainText("Published as v2", { timeout: 10_000 });
  const detail = await apiGet(page.request, `/artifacts/${slugOf(page)}`);
  expect((detail.body.content as string).split("\n")[1]).toBe('["Apples"]');
});

test("Import an .xlsx: converted by the Worker, opened in edit mode", async ({ page }) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("import");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  await page.getByTestId("new-import-file").setInputFiles({
    name: "Q4_sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: xlsxOf([
      ["Region", "Sales"],
      ["North", 120],
      ["South", 80],
    ]),
  });
  await expect(page).toHaveURL(/\/a\/[^/?]+$/, { timeout: 15_000 });
  await expect(bar(page)).toBeVisible();
  await expect(cell(page, "B3")).toHaveText("80", { timeout: 15_000 });
  await expect(cell(page, "A2")).toBeFocused();
  const slug = slugOf(page);
  const detail = await apiGet(page.request, `/artifacts/${slug}`);
  expect(detail.body).toMatchObject({ title: "Q4 sales", type: "sheet", current_version: 1 });
  const versions = await apiGet(page.request, `/artifacts/${slug}/versions`);
  expect(versions.body.items[0].note).toBe("Imported from Q4_sales.xlsx");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("Import refuses a file it cannot read and says why, creating nothing", async ({ page }) => {
  const email = uniqueEmail("import-bad");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  await page.getByTestId("new-import-file").setInputFiles({
    name: "broken.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a zip"),
  });
  const dialog = page.getByRole("alertdialog", { name: "Could not import broken.xlsx" });
  await expect(dialog).toContainText("The xlsx file could not be imported");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const list = await apiGet(page.request, "/artifacts");
  expect(list.body.items).toEqual([]);
});

async function openActions(page: Page) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  return page.getByRole("menu", { name: "Artifact actions" });
}

test("Replace a sheet with a file: confirm, a version published meanwhile, and off while editing", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const email = uniqueEmail("replace");
  const { token } = await seedToken(email, { label: "Work agent" });
  const art = await publishArtifact(page.request, token, {
    title: "Fruit",
    type: "sheet",
    html: undefined,
    content: '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"}]}\n["Figs"]',
    visibility: "allowlist",
  });
  await seedSession(page.context(), email);
  await page.goto(`/a/${art.slug}`);
  await expect(cell(page, "A2")).toHaveText("Figs", { timeout: 15_000 });

  // The item opens the file picker straight away; the dialog only confirms.
  let menu = await openActions(page);
  const chooser = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Replace with a file…" }).click();
  await (await chooser).setFiles({
    name: "fruit.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Item,Qty\nApples,3\nPears,5\n"),
  });
  const dialog = page.getByRole("dialog", { name: "Replace with a file" });
  await expect(dialog).toContainText("fruit.csv becomes v2. v1 stays in history.");
  // The agent publishes v2 before the person confirms.
  const agentV2 = await apiPut(
    page.request,
    `/artifacts/${art.id}`,
    { content: '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"}]}\n["Kiwis"]' },
    { token },
  );
  expect(agentV2.status).toBe(200);
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(dialog).toContainText("v2 was published by Work agent meanwhile. Replace v2 too?");
  await dialog.getByRole("button", { name: "Replace v2" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cell(page, "B3")).toHaveText("5", { timeout: 15_000 });
  const versions = await apiGet(page.request, `/artifacts/${art.id}/versions`);
  expect(versions.body.items.map((v: { number: number; note: string | null }) => v.note)).toEqual([
    "Replaced from fruit.csv",
    null,
    null,
  ]);
  const detail = await apiGet(page.request, `/artifacts/${art.id}`);
  expect(detail.body).toMatchObject({ id: art.id, slug: art.slug, current_version: 3 });

  // While editing on the page, the item is off and says why.
  await page.keyboard.press("Escape");
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    menu = await openActions(page);
    await menu.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  await expect(bar(page)).toBeVisible();
  menu = await openActions(page);
  const off = menu.getByRole("menuitem", { name: "Replace with a file…" });
  await expect(off).toHaveAttribute("aria-disabled", "true");
  await expect(off).toContainText("Publish or discard changes first");
});
