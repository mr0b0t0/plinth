// Sharing a whole category (docs/spec.md "Category sharing and personal categories"): the owner
// shares "Acme" with a client from the dashboard, leaving one artifact out; the client opens the
// portal, confirms an email by code and sees exactly what the owner ticked. An agent's later filing
// waits for the owner's review, and removing the client takes their access away at once.
import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, apiGet, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { latestCode } from "../support/mail.ts";

const html = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main><h1>${title}</h1></main></body></html>`;

async function settle(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
}

async function axe(page: Page) {
  await settle(page);
  // A card's placeholder preview (the dashboard's, also on the portal) is aria-hidden glyph art in
  // --color-ink-ghost, which tokens.css keeps for decoration below 4.5:1.
  const results = await new AxeBuilder({ page })
    .exclude("iframe")
    .exclude(".pl-dash__paper")
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** The client confirms their email on the portal page and sees its heading. */
async function confirmOnPortal(page: Page, request: APIRequestContext, email: string) {
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  const code = await latestCode(request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Confirm code" }).click();
}

const portalTitles = (page: Page) => page.locator(".pl-portal__item-title").allTextContents();

test("an owner shares a category, the client sees what was ticked, and new filings wait for review", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = uniqueEmail("cat-owner");
  const client = uniqueEmail("cat-client");
  const { token } = await seedToken(owner, { label: "Work Claude", clientType: "claude" });
  const alpha = await publishArtifact(page.request, token, {
    title: "Alpha report",
    html: html("Alpha report"),
    visibility: "allowlist",
    category: "Acme",
  });
  await publishArtifact(page.request, token, {
    title: "Beta report",
    html: html("Beta report"),
    visibility: "allowlist",
    category: "Acme",
  });

  // The owner shares Acme from the dashboard with Beta left out.
  await seedSession(page.context(), owner);
  await page.goto("/dashboard?category=Acme");
  await page.getByRole("button", { name: "Share category" }).click();
  const dialog = page.getByRole("dialog", { name: "Share “Acme”" });
  await expect(dialog.getByRole("checkbox", { name: /Beta report/ })).toBeChecked();
  await axe(page);
  await dialog.getByRole("textbox", { name: "Email address" }).fill(client);
  await dialog.getByRole("button", { name: "Add" }).click();
  await dialog.getByRole("checkbox", { name: /Beta report/ }).uncheck();
  await dialog.getByRole("button", { name: "Share" }).click();
  await expect(dialog).toBeHidden();
  const shares = await apiGet<{ items: { id: string; portal_url: string }[] }>(
    page.request,
    "/category-shares",
  );
  const share = shares.body.items[0];
  expect(share?.portal_url).toBe(`${APP_ORIGIN}/p/${share?.id}`);

  // The client opens the portal and confirms by code.
  const clientContext = await browser.newContext();
  const cp = await clientContext.newPage();
  try {
    await cp.goto(`/p/${share?.id}`);
    await expect(cp.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await axe(cp);
    await confirmOnPortal(cp, cp.request, client);
    await expect(cp.getByRole("heading", { name: "Acme" })).toBeVisible();
    expect(await portalTitles(cp)).toEqual(["Alpha report"]);
    await axe(cp);

    // An agent files a third one under "acme": it waits, so the client still sees one.
    const gamma = await publishArtifact(page.request, token, {
      title: "Gamma report",
      html: html("Gamma report"),
      visibility: "allowlist",
      category: "acme",
    });
    await cp.reload();
    await expect(cp.getByRole("heading", { name: "Acme" })).toBeVisible();
    expect(await portalTitles(cp)).toEqual(["Alpha report"]);
    const direct = await apiGet(cp.request, `/view/${gamma.slug}`);
    expect(direct.body.status).not.toBe("ok");

    // The owner sees the review line, reviews and shares it; the client now sees two.
    await page.goto("/dashboard");
    await expect(page.getByText(/1 to review in Acme/)).toBeVisible();
    await page.getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog", { name: "Review “Acme”" });
    await review
      .getByRole("listitem")
      .filter({ hasText: "Gamma report" })
      .getByRole("button", { name: "Share", exact: true })
      .click();
    // The last decision closes the review.
    await expect(review).toBeHidden();
    await cp.reload();
    await expect(cp.getByRole("heading", { name: "Acme" })).toBeVisible();
    expect((await portalTitles(cp)).sort()).toEqual(["Alpha report", "Gamma report"]);

    // The client opens an artifact from the portal; then the owner removes them.
    await cp.getByRole("link", { name: "Alpha report" }).click();
    await expect(cp).toHaveURL(new RegExp(`/a/${alpha.slug}$`));
    await expect(cp.locator("iframe.pl-viewer-frame")).toBeVisible();

    await page.goto("/dashboard?category=Acme");
    await page.getByRole("button", { name: "Sharing" }).click();
    const sharing = page.getByRole("dialog", { name: "Share “Acme”" });
    await sharing.getByRole("button", { name: `Remove ${client}` }).click();
    await sharing.getByRole("button", { name: "Save" }).click();
    await expect(sharing).toBeHidden();

    // The client's next navigation returns to the gate.
    await cp.goto(`/a/${alpha.slug}`);
    await expect(
      cp.getByText("Only the people the owner listed can open this artifact", { exact: false }),
    ).toBeVisible();
  } finally {
    await clientContext.close();
  }
});
