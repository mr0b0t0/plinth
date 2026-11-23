// Editing a doc on its page without live rooms (solo mode, ALLOW_ROOMS=false; the "solo" project's
// Worker): the frame edits its own copy and the app publishes it with PUT and base_version, without
// reloading the frame. A change back to the text the page loaded after a publish is a change again;
// a copy the tab kept from before a reload keeps the page out of edit mode until it is published or
// discarded; and going elsewhere in the app publishes first.
import { expect, type Page, test } from "@playwright/test";
import { SOLO_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { CURRENT_FRAME, publishChanges, saveStatus } from "../support/viewer.ts";

const DOC = "# Plan\n\nHello\n";

async function setup(page: Page) {
  const email = uniqueEmail("solo-owner");
  const { token } = await seedToken(email, { origin: SOLO_APP_ORIGIN });
  await seedSession(page.context(), email, SOLO_APP_ORIGIN);
  const res = await fetch(`${SOLO_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Plan", type: "doc", content: DOC }),
  });
  const art = (await res.json()) as { slug: string; id: string };
  expect(res.status, JSON.stringify(art)).toBe(201);
  const read = async () => {
    const r = await fetch(`${SOLO_APP_ORIGIN}/api/v1/artifacts/${art.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return (await r.json()) as { current_version: number; content: string };
  };
  return { ...art, read };
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);

async function open(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator("main.plinth-doc--editing")).toBeVisible({ timeout: 15_000 });
}

/** Replace the paragraph's text, as a person typing would. */
async function setParagraph(page: Page, from: string, to: string) {
  await frameOf(page).locator("p", { hasText: from }).click();
  const field = frameOf(page).locator('.plinth-doc__open [contenteditable="true"]');
  await expect(field).toBeFocused();
  await field.press("ControlOrMeta+a");
  await field.pressSequentially(to);
  await field.press("Escape");
}

test("a change back to the loaded text after a publish is unpublished, and publishes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const art = await setup(page);
  await open(page, art.slug);
  await setParagraph(page, "Hello", "Hello world");
  await expect(saveStatus(page)).toContainText("Unpublished changes");
  await publishChanges(page);
  await expect(saveStatus(page)).toContainText("Published as v2", { timeout: 10_000 });
  expect((await art.read()).content).toContain("Hello world");
  // Back to what the page loaded ("Hello"): a change from what is published now.
  await setParagraph(page, "Hello world", "Hello");
  await expect(saveStatus(page)).toContainText("Unpublished changes");
  await publishChanges(page);
  await expect(saveStatus(page)).toContainText("Published as v3", { timeout: 10_000 });
  const v3 = await art.read();
  expect(v3.current_version).toBe(3);
  expect(v3.content).not.toContain("Hello world");
});

test("a copy kept from before a reload holds edit mode until it is published or discarded", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const art = await setup(page);
  await open(page, art.slug);
  await setParagraph(page, "Hello", "Kept across the reload");
  // The tab keeps a copy every few seconds.
  await page.waitForTimeout(5_600);
  page.on("dialog", (d) => void d.accept());
  await page.reload();
  const notice = page.getByRole("note");
  await expect(notice).toContainText("Unpublished changes from earlier in this tab", {
    timeout: 15_000,
  });
  await expect(frameOf(page).locator("html[data-ready]")).toHaveCount(1);
  // Not editable meanwhile: typing cannot replace the kept copy.
  await expect(frameOf(page).locator("main.plinth-doc--editing")).toHaveCount(0);
  await notice.getByRole("button", { name: "Publish" }).click();
  await expect.poll(async () => (await art.read()).current_version, { timeout: 10_000 }).toBe(2);
  expect((await art.read()).content).toContain("Kept across the reload");
  await expect(frameOf(page).locator("main.plinth-doc--editing")).toBeVisible({ timeout: 15_000 });
});

test("going elsewhere in the app publishes the changes first", async ({ page }) => {
  test.setTimeout(60_000);
  const art = await setup(page);
  await open(page, art.slug);
  await setParagraph(page, "Hello", "Published on the way out");
  const history = page.getByRole("link", { name: "History" });
  if (await history.isVisible()) await history.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "History" }).click();
  }
  await expect(page).toHaveURL(/\/history$/, { timeout: 10_000 });
  const now = await art.read();
  expect(now.current_version).toBe(2);
  expect(now.content).toContain("Published on the way out");
});
