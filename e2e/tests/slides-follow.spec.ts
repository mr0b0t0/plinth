// Following the presenter (docs/spec.md "Slides"): the owner of a deck and a viewer it is shared
// with have it open in two browsers. The viewer is signed in: email codes share one per-hour
// budget across the whole suite (DEV_IGNORE_CLIENT_IP), and a viewer confirmed by code follows the
// same way (apps/worker/test/slides-room.test.ts). The owner turns on Lead
// viewers and pages; the viewer's deck follows with the "Following the presenter" note; the viewer
// pages back by hand, which pauses following, and "Back to the presenter" returns to the owner's
// slide. A presenter's own audience window follows its presenter window, not the room, so it shows
// no note while they lead. An anonymous viewer of an unlisted deck opens no socket and sees no note.
import { type Browser, expect, type FrameLocator, type Page, test } from "@playwright/test";
import { apiPut, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
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

/** A listed viewer, signed in, in a fresh context. */
async function listedViewer(browser: Browser, slug: string, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await seedSession(page.context(), email);
  await page.goto(`/a/${slug}`);
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

test("a presenter's audience window follows its presenter window and shows no note while they lead", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("follow-pair");
  const { token } = await seedToken(owner, { label: "Deck agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Kickoff",
    html: undefined,
    type: "slides",
    content: DECK,
    visibility: "allowlist",
  });
  await seedSession(context, owner);
  await page.goto(`/a/${art.slug}`);
  await ready(page);
  await page.keyboard.press("s");
  await expect(root(page)).toHaveAttribute("data-mode", "presenter");
  const strip = page.getByRole("region", { name: "Presenter view" });
  const opened = context.waitForEvent("page");
  await strip.getByRole("button", { name: "Audience window" }).click();
  const audience = await opened;
  try {
    await expect(deck(audience).locator('html[data-ready="ok"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    // Told it is paired, the audience frame leaves the room: no note, no toggle.
    await expect(deck(audience).locator(".plinth-slides__follow")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(deck(audience).locator(".plinth-slides__lead")).toHaveCount(0);

    const lead = deck(page).locator(".plinth-slides__presenter .plinth-slides__lead");
    await expect(lead).toBeEnabled({ timeout: 15_000 });
    await lead.press("Enter");
    await expect(lead).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(html(page)).toHaveAttribute("data-slide", "3");
    await expect(html(audience)).toHaveAttribute("data-slide", "3", { timeout: 10_000 });
    await expect(deck(audience).locator(".plinth-slides__follow")).toHaveCount(0);
    await expect(root(audience)).not.toHaveAttribute("data-follow", /.*/);
    await page.keyboard.press("ArrowRight");
    await expect(html(audience)).toHaveAttribute("data-slide", "4", { timeout: 10_000 });
    await expect(deck(audience).locator(".plinth-slides__follow")).toHaveCount(0);
  } finally {
    await audience.close();
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
