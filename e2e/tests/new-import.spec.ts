// New, Import and Replace with a file (docs/spec.md "New and Import"), under origin isolation with
// live rooms: New on the dashboard makes a blank document or sheet that opens in edit mode with
// the focus on its title or first cell, and Publish makes v2; Import sends an .xlsx that the Worker
// converts and opens the sheet in edit mode, saying in a toast which sheets it left out; a sheet's
// "Replace with a file…" confirms (with what the import would change), asks again when an agent
// published meanwhile, keeps the artifact, is hidden while the page is edited, and on a pinned
// version link moves to the artifact's own link once replaced.
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

/** New, then "Import a spreadsheet…", then this file in the picker it opens. */
async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const menu = await openNew(page);
  const chooser = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Import a spreadsheet…" }).click();
  await (await chooser).setFiles(file);
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
  // The title opens as formatted text, with no Markdown shown.
  const field = frameOf(page).locator('.plinth-doc__open [contenteditable="true"]');
  await expect(field).toHaveText("Untitled document", { timeout: 15_000 });
  await expect(field).toBeFocused();
  await expect(frameOf(page).locator("textarea")).toHaveCount(0);
  // The title's text is selected: typing replaces it and keeps the heading.
  await page.keyboard.type("Trip plan");
  await expect(field).toHaveText("Trip plan");
  // Enter at its end opens a paragraph below.
  await page.keyboard.press("Enter");
  await expect(field).toHaveText("", { timeout: 10_000 });
  await page.keyboard.type("Day one: the coast.");
  await expect(field).toHaveText("Day one: the coast.");
  await page.keyboard.press("Escape");
  await expect(frameOf(page).locator("h1")).toContainText("Trip plan");
  await expect(frameOf(page).locator("p", { hasText: "Day one: the coast." })).toBeVisible();
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
  // The open cell's field: in the cell, or docked at the bottom of the page at phone width.
  const input = frameOf(page).locator(".plinth-sheet__input");
  await expect(input).toHaveValue("A");
  await input.fill("Apples");
  await input.press("Enter");
  await expect(cell(page, "A2")).toHaveText("Apples");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(bar(page)).toContainText("Published as v2", { timeout: 10_000 });
  const detail = await apiGet(page.request, `/artifacts/${slugOf(page)}`);
  expect((detail.body.content as string).split("\n")[1]).toBe('["Apples"]');
});

test("Import an .xlsx: converted by the Worker, opened in edit mode, other sheets named", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("import");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  await importFile(page, {
    name: "Q4_sales.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: xlsxOf(
      [
        ["Region", "Sales"],
        ["North", 120],
        ["South", 80],
      ],
      ["Q3", "Notes"],
    ),
  });
  await expect(page).toHaveURL(/\/a\/[^/?]+$/, { timeout: 15_000 });
  // What the import left out, in one toast with no button.
  const toast = page.locator(".pl-toast", { hasText: "Imported Q4_sales.xlsx" });
  await expect(toast).toContainText("Only the first sheet is used; “Q3” and “Notes” are left out.");
  await expect(toast.locator(".pl-toast__action")).toHaveCount(0);
  await expect(bar(page)).toBeVisible();
  await expect(cell(page, "B3")).toHaveText("80", { timeout: 15_000 });
  await expect(cell(page, "A2")).toBeFocused();
  const slug = slugOf(page);
  const detail = await apiGet(page.request, `/artifacts/${slug}`);
  expect(detail.body).toMatchObject({ title: "Q4 sales", type: "sheet", current_version: 1 });
  const versions = await apiGet(page.request, `/artifacts/${slug}/versions`);
  expect(versions.body.items[0].note).toBe("Imported from Q4_sales.xlsx");
  // The Edit toggle leaves edit mode; at phone width, where the toggle is in the ⋯ menu, Done.
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else await page.getByRole("button", { name: "Done" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("Import refuses a file it cannot read and says why, creating nothing", async ({ page }) => {
  const email = uniqueEmail("import-bad");
  await seedSession(page.context(), email);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  await importFile(page, {
    name: "broken.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("not a zip"),
  });
  const dialog = page.getByRole("alertdialog", { name: "Could not import broken.xlsx" });
  await expect(dialog).toContainText("This is not an .xlsx file.");
  await expect(dialog).not.toContainText("could not be imported:");
  await expect(dialog).not.toContainText("ZIP");
  await expect(dialog.getByRole("button", { name: "Choose another file…" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const list = await apiGet(page.request, "/artifacts");
  expect(list.body.items).toEqual([]);
});

async function openActions(page: Page) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  return page.getByRole("menu", { name: "Artifact actions" });
}

test("Replace a sheet with a file: confirm, a version published meanwhile, and hidden while editing", async ({
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
  await expect(dialog).toContainText(
    "Work agent published v2 meanwhile. Replace it with fruit.csv?",
  );
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByText("Replaced with fruit.csv")).toBeVisible();
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

  // While editing on the page, the item is hidden.
  await page.keyboard.press("Escape");
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    menu = await openActions(page);
    await menu.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  await expect(bar(page)).toBeVisible();
  menu = await openActions(page);
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Replace with a file…" })).toHaveCount(0);
});

test("Replace on a pinned version link: says what the file changes, then shows the new version on the artifact's link", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("replace-pinned");
  const { token } = await seedToken(email, { label: "Work agent" });
  const art = await publishArtifact(page.request, token, {
    title: "Menu",
    type: "sheet",
    html: undefined,
    content: '{"plinth":"sheet","v":1,"columns":[{"name":"Item","type":"text"}]}\n["Tea"]',
    visibility: "allowlist",
  });
  await seedSession(page.context(), email);
  // v1 is current, so its permanent link offers Replace.
  await page.goto(`/a/${art.slug}/v/1`);
  await expect(cell(page, "A2")).toHaveText("Tea", { timeout: 15_000 });
  const menu = await openActions(page);
  const chooser = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Replace with a file…" }).click();
  // "Item,Price / Café,3" saved by Excel on Windows: é is the byte 0xE9.
  await (await chooser).setFiles({
    name: "menu.csv",
    mimeType: "text/csv",
    buffer: Buffer.concat([
      Buffer.from("Item,Price\nCaf"),
      Buffer.from([0xe9]),
      Buffer.from(",3\n"),
    ]),
  });
  const dialog = page.getByRole("dialog", { name: "Replace with a file" });
  await expect(dialog).toContainText("menu.csv becomes v2. v1 stays in history.");
  await expect(dialog.getByRole("listitem")).toHaveText([
    "The file is not UTF-8, so it is read as Windows-1252. Check accented letters.",
  ]);
  // No button of its own: Cancel and Replace stay the choice.
  await expect(dialog.locator(".pl-dialog__footer").getByRole("button")).toHaveText([
    "Cancel",
    "Replace",
  ]);
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The pinned link would show v1 again: the page moves to the artifact's own link, on v2.
  await expect(page).toHaveURL(new RegExp(`/a/${art.slug}$`));
  await expect(cell(page, "A2")).toHaveText("Café", { timeout: 15_000 });
  const detail = await apiGet(page.request, `/artifacts/${art.id}`);
  expect(detail.body).toMatchObject({ current_version: 2 });
  expect(detail.body.content).toContain('["Café",3]');
});
