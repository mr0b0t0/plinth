// Following the presenter (docs/spec.md "Slides"): the owner of a deck and a viewer it is shared
// with (confirmed by code, no account) have it open in two browsers. The owner turns on Lead
// viewers and pages; the viewer's deck follows with the "Following the presenter" note; the viewer
// pages back by hand, which pauses following, and "Back to the presenter" returns to the owner's
// slide. An anonymous viewer of an unlisted deck opens no socket and sees no note.
import { type Browser, expect, type FrameLocator, type Page, test } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { latestCode } from "../support/mail.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const DECK = ["# Kickoff", "---", "## Two", "---", "## Three", "---", "## Four", "---", "## Five"]
  .join("\n\n")
  .concat("\n");

const deck = (page: Page): FrameLocator => page.frameLocator(CURRENT_FRAME);
const html = (page: Page) => deck(page).locator("html");
const root = (page: Page) => deck(page).locator("#__plinth-slides");

/** The deck is rendered; phones in portrait show the overview, so switch to the deck. */
async function ready(page: Page) {
  await expect(deck(page).locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  await root(page).focus();
  if ((await root(page).getAttribute("data-mode")) === "overview") {
    await page.keyboard.press("o");
    await expect(root(page)).toHaveAttribute("data-mode", "deck");
  }
}

/** A listed viewer confirms their email by code on the allowlist gate, in a fresh context. */
async function listedViewer(browser: Browser, slug: string, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/a/${slug}`);
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("If this address has access, we sent a code")).toBeVisible();
  const code = await latestCode(page.request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
  await ready(page);
  return page;
}

test("viewers follow the presenter's slide, pause by paging, and go back to it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("follow-owner");
  const viewerEmail = uniqueEmail("follow-viewer");
  const { token } = await seedToken(owner, { label: "Deck agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Kickoff",
    html: undefined,
    type: "slides",
    content: DECK,
    visibility: "allowlist",
  });
  const shared = await apiPut(
    page.request,
    `/artifacts/${art.id}/sharing`,
    { grants: [{ email: viewerEmail, role: "viewer" }] },
    { token },
  );
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}`);
  await ready(page);
  const viewer = await listedViewer(browser, art.slug, viewerEmail);
  try {
    // A viewer has no Lead viewers toggle, and nobody leads yet: no note.
    await expect(deck(viewer).locator(".plinth-slides__lead")).toHaveCount(0);
    await expect(deck(viewer).locator(".plinth-slides__follow")).toBeHidden();

    // The owner leads from slide 1 and pages to 3.
    const lead = deck(page).locator(".plinth-slides__controls .plinth-slides__lead");
    await expect(lead).toBeEnabled({ timeout: 15_000 });
    await lead.press("Enter");
    await expect(lead).toHaveAttribute("aria-pressed", "true");
    await expect(lead).toHaveText("Leading · 1 following");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(html(page)).toHaveAttribute("data-slide", "3");

    // The viewer's deck follows, with the note.
    await expect(html(viewer)).toHaveAttribute("data-slide", "3", { timeout: 10_000 });
    const note = deck(viewer).locator(".plinth-slides__follow");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Following the presenter");
    await expect(root(viewer)).toHaveAttribute("data-follow", "on");
    // The note names nobody.
    await expect(note).not.toContainText(owner);

    // Paging back by hand pauses following; the owner's next slide does not pull the viewer.
    await root(viewer).focus();
    await viewer.keyboard.press("ArrowLeft");
    await expect(html(viewer)).toHaveAttribute("data-slide", "2");
    await expect(root(viewer)).toHaveAttribute("data-follow", "paused");
    await page.keyboard.press("ArrowRight");
    await expect(html(page)).toHaveAttribute("data-slide", "4");
    const back = note.getByRole("button", { name: "Back to the presenter (slide 4)" });
    await expect(back).toBeVisible({ timeout: 10_000 });
    await expect(html(viewer)).toHaveAttribute("data-slide", "2");
    await back.click();
    await expect(html(viewer)).toHaveAttribute("data-slide", "4");
    await expect(root(viewer)).toHaveAttribute("data-follow", "on");

    // The owner stops leading: the note goes.
    await lead.press("Enter");
    await expect(lead).toHaveAttribute("aria-pressed", "false");
    await expect(note).toBeHidden({ timeout: 10_000 });
  } finally {
    await viewer.context().close();
  }
});

test("an anonymous link viewer opens no socket and sees no note", async ({ page, browser }) => {
  const owner = uniqueEmail("follow-link");
  const { token } = await seedToken(owner, { label: "Deck agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Kickoff",
    html: undefined,
    type: "slides",
    content: DECK,
    visibility: "unlisted",
  });
  const anon = await (await browser.newContext()).newPage();
  try {
    const sockets: string[] = [];
    anon.on("websocket", (ws) => sockets.push(ws.url()));
    await anon.goto(`/a/${art.slug}`);
    await expect(deck(anon).locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
    await anon.waitForTimeout(1000);
    expect(sockets.filter((u) => u.includes("/__plinth/room/"))).toEqual([]);
    await expect(deck(anon).locator(".plinth-slides__follow")).toHaveCount(0);
    await expect(deck(anon).locator(".plinth-slides__lead")).toHaveCount(0);
  } finally {
    await anon.context().close();
  }
});
