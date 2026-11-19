// Notifications never cover a modal dialog's controls (#36 review fix): a toast raised while a
// dialog is open sits below the dialog layer, so a click on the dialog's button lands even with
// the pointer left resting on the toast, at phone width too; and a resting pointer holds a toast
// only for a while.
import { expect, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

test("a toast under a resting pointer never blocks the dialog's buttons", async ({ page }) => {
  test.setTimeout(60_000);
  const owner = uniqueEmail("toast-owner");
  const { token } = await seedToken(owner, { label: "Work agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Plan",
    type: "doc",
    content: "# Plan\n\nText.\n",
    html: undefined,
    visibility: "allowlist",
  });
  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator("h1")).toContainText("Plan", {
    timeout: 15_000,
  });
  const share = page.getByRole("button", { name: "Share" });
  if (await share.isVisible()) await share.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Share this artifact" });
  const copy = dialog.getByRole("button", { name: "Copy link" });
  await copy.click();
  // "Link copied", or "Could not copy the link" where the clipboard is refused: a toast either way.
  const toast = page.locator(".pl-toast").first();
  await expect(toast).toBeVisible();
  // The pointer rests where the toast is, then the dialog's button is clicked: the dialog is on
  // top, so the click lands.
  const at = await toast.boundingBox();
  if (at) await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await copy.click({ timeout: 5_000 });
  const box = await copy.boundingBox();
  if (box) {
    const top = await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x as number, y as number)?.closest("button")?.textContent,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(top).toContain("Copy link");
  }
  // The toast still goes by itself, and the dialog is still there.
  await expect(page.locator(".pl-toast")).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog).toBeVisible();
});
