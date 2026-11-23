// An invited person without an account: they open the link, confirm their email by code on the
// allowlist gate and see the page. Each call uses a fresh browser context.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Frame,
  type Page,
} from "@playwright/test";
import { apiPut, uniqueEmail } from "./api.ts";
import { seedSession } from "./db.ts";
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

// ---------- editing on the page: always on for owners and editors ----------

/** The save status in the artifact bar (the whole edit chrome; editing has no toggle). */
export const saveStatus = (page: Page) => page.getByRole("region", { name: "Editing on the page" });

/**
 * The page is in edit mode from the moment it opens: no Edit toggle and no Done anywhere, the save
 * status is there, and the frame's renderer is editing (`editingSelector`, its edit-mode class).
 */
export async function expectEditing(page: Page, editingSelector: string) {
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
  await expect(saveStatus(page)).toHaveCount(1);
  await expect(page.frameLocator(CURRENT_FRAME).locator(editingSelector).first()).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Look at an artifact as a reader instead of its owner: owners and editors of a doc, a deck, a
 * sheet or a design system are always in edit mode, so a test of the page as people view it
 * shares the artifact with a fresh viewer (with the owner's `token`) and signs the context in as
 * them. Returns the viewer's email.
 */
export async function viewAsReader(
  context: BrowserContext,
  request: APIRequestContext,
  artifactId: string,
  token: string,
  role: "viewer" | "commenter" = "viewer",
): Promise<string> {
  const email = uniqueEmail("reader");
  const shared = await apiPut(
    request,
    `/artifacts/${artifactId}/sharing`,
    { grants: [{ email, role }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  await context.clearCookies();
  await seedSession(context, email);
  return email;
}

/** Publish the changes now: the ⋯ menu's "Publish changes" (Cmd/Ctrl+S does the same). */
export async function publishChanges(page: Page) {
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Publish changes" }).click();
}
