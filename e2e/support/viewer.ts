// An invited person without an account: they open the link, confirm their email by code on the
// allowlist gate and see the page. Each call uses a fresh browser context.
import { type Browser, expect, type Frame, type Page } from "@playwright/test";
import { latestCode } from "./mail.ts";

/** The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads. */
export const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

/** Open `url` in a new context as `email`, confirming the address with the emailed code. */
export async function confirmByCode(browser: Browser, url: string, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
  const code = await latestCode(page.request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
  return page;
}

/** The example page's frame once it has settled (the examples set body[data-ready="1"]). */
export async function readyFrame(page: Page): Promise<Frame> {
  await page
    .frameLocator(CURRENT_FRAME)
    .locator('body[data-ready="1"]')
    .waitFor({ timeout: 15_000 });
  const handle = await page.locator(CURRENT_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("the artifact frame is not attached");
  return frame;
}
