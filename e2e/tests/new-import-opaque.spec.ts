// New and Import under opaque content isolation (docs/spec.md "New and Import"): there is no
// editing on the page, so New offers only Import, an imported sheet opens on its page (no `?edit`,
// no edit strip, no frame key), and a sheet's "Replace with a file…" still works, since it is an
// ordinary app request.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { CURRENT_FRAME } from "../support/viewer.ts";

test("New offers only Import; an imported sheet opens on its page and can be replaced", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const email = uniqueEmail("opaque-import");
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  await page.goto("/dashboard");
  await expect(page.getByText("Nothing on display yet")).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  const menu = page.getByRole("menu", { name: "New" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Import a spreadsheet…"]);
  const picker = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Import a spreadsheet…" }).click();
  await (await picker).setFiles({
    name: "fruit.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Item,Qty\nApples,3\n"),
  });
  await expect(page).toHaveURL(/\/a\/[^/?]+$/, { timeout: 15_000 });
  const frame = page.frameLocator(CURRENT_FRAME);
  await expect(frame.locator("#__plinth-cell-A2")).toHaveText("Apples", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Editing on the page" })).toHaveCount(0);
  expect(await page.locator(CURRENT_FRAME).getAttribute("src")).not.toContain("#plinth-k=");

  await page.getByRole("button", { name: "Artifact actions" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Replace with a file…" }).click();
  await (await chooser).setFiles({
    name: "fruit-2.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Item,Qty\nPears,5\n"),
  });
  const dialog = page.getByRole("dialog", { name: "Replace with a file" });
  await expect(dialog).toContainText("fruit-2.csv becomes v2.");
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(frame.locator("#__plinth-cell-A2")).toHaveText("Pears", { timeout: 15_000 });
});
