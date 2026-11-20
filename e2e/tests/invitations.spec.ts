// Invitation emails (docs/spec.md "Invitation emails"): the owner adds a person in the People
// section with "Notify people" ticked (the default); the person gets '<owner> shared "<title>"
// with you' with the artifact's link, and the link opens the page for them once signed in.
// Unticked, nobody is emailed. Sharing a category from the dashboard emails its people the portal.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, apiGet, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { latestEmail, outbox } from "../support/mail.ts";

const html = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><main><h1>${title}</h1></main></body></html>`;

async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const results = await new AxeBuilder({ page }).exclude("iframe").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Nothing in the outbox for `to` after a short wait (the email would go out right after the save). */
async function expectNoEmail(page: Page, to: string) {
  await page.waitForTimeout(1500);
  expect(await outbox(page.request, to)).toEqual([]);
}

test("adding a person with Notify people emails them a link that opens the page", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("invite-owner");
  const invitee = uniqueEmail("invitee");
  const quiet = uniqueEmail("quiet");
  const { token } = await seedToken(owner, { label: "Work Claude", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Launch plan",
    html: html("Launch plan"),
    visibility: "allowlist",
  });

  await seedSession(page.context(), owner);
  await page.goto(`/a/${art.slug}/settings`);
  const notify = page.getByRole("checkbox", { name: /Notify people/ });
  await expect(notify).toBeChecked();
  await axe(page);
  await page.getByRole("textbox", { name: "Email address" }).fill(invitee);
  await page.getByLabel("Role", { exact: true }).selectOption("commenter");
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByLabel(`Role for ${invitee}`)).toBeVisible();

  const mail = await latestEmail(page.request, invitee);
  expect(mail.subject).toBe(`${owner} shared "Launch plan" with you`);
  expect(mail.text).toContain("You can view it and comment on it.");
  const links = mail.text.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  expect(links).toEqual([`${APP_ORIGIN}/a/${art.slug}`]);
  expect(mail.text).not.toMatch(/\b\d{6}\b/);

  // Unticked: the next person is added without an email.
  await notify.uncheck();
  await page.getByRole("textbox", { name: "Email address" }).fill(quiet);
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByLabel(`Role for ${quiet}`)).toBeVisible();
  await expectNoEmail(page, quiet);

  // The link from the email asks a stranger who they are, and opens the page for the invitee once
  // signed in (by seed, not by code: the whole suite shares one address's code limit).
  const strangerCtx = await browser.newContext();
  const inviteeCtx = await browser.newContext();
  try {
    const stranger = await strangerCtx.newPage();
    await stranger.goto(links[0] as string);
    await expect(stranger.getByRole("heading", { level: 1, name: "Launch plan" })).toBeVisible();
    await expect(stranger.getByLabel("Email")).toBeVisible();
    await expect(stranger.locator("iframe")).toHaveCount(0);

    await seedSession(inviteeCtx, invitee);
    const ip = await inviteeCtx.newPage();
    await ip.goto(links[0] as string);
    await expect(ip.locator("iframe.pl-viewer-frame")).toBeVisible();
  } finally {
    await strangerCtx.close();
    await inviteeCtx.close();
  }
});

test("sharing a category with Notify people emails its people the portal link", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("invite-cat-owner");
  const client = uniqueEmail("invite-cat-client");
  const { token } = await seedToken(owner, { label: "Work Claude", clientType: "claude" });
  await publishArtifact(page.request, token, {
    title: "Alpha report",
    html: html("Alpha report"),
    visibility: "allowlist",
    category: "Northwind",
  });

  await seedSession(page.context(), owner);
  await page.goto("/dashboard?category=Northwind");
  await page.getByRole("button", { name: "Share category" }).click();
  const dialog = page.getByRole("dialog", { name: "Share “Northwind”" });
  await dialog.getByRole("textbox", { name: "Name people see" }).fill("Client reports");
  await dialog.getByRole("textbox", { name: "Email address" }).fill(client);
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByRole("checkbox", { name: /Notify people/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Share" }).click();
  await expect(dialog).toBeHidden();

  const shares = await apiGet<{ items: { id: string; portal_url: string }[] }>(
    page.request,
    "/category-shares",
  );
  const portal = shares.body.items[0]?.portal_url;
  const mail = await latestEmail(page.request, client);
  expect(mail.subject).toBe(`${owner} shared "Client reports" with you`);
  expect(mail.text).toContain(`${portal}`);
  // The people see the share's name, never the category's.
  expect(mail.text).not.toContain("Northwind");
});
