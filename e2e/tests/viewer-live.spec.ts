// The artifact page while it stays open: toggling comments reloads the frame at most once (review
// mode stays on), a version an agent publishes replaces the one on view without a manual reload,
// and on touch screens text fields are 16px so focusing one does not zoom the page (iOS Safari).
import { expect, type Page, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { signInApi } from "../support/auth.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const page1 = (heading: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title></head><body><h1>${heading}</h1></body></html>`;

/** Count the frame's one-time enter navigations (one per frame load). */
function countEnters(page: Page): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (r.url().includes("/__plinth/enter")) n++;
  });
  return () => n;
}

test("closing and reopening comments does not reload the artifact again", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("owner"));
  const art = await publishArtifact(page.request, token, { html: page1("Steady") });
  const enters = countEnters(page);
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator("iframe").first().locator("h1")).toHaveText("Steady");
  expect(enters()).toBe(1);

  const toggle = page.getByRole("button", { name: "Comments", exact: true });
  await toggle.click();
  await expect(page.getByRole("region", { name: "Comments" })).toBeVisible();
  await expect.poll(enters).toBe(2); // review mode: one reload, under the old frame
  await expect(page.locator("iframe")).toHaveCount(1); // the old frame went once the new loaded

  await toggle.click();
  await expect(page.getByRole("region", { name: "Comments" })).toHaveCount(0);
  await toggle.click();
  await expect(page.getByRole("region", { name: "Comments" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(enters()).toBe(2);
  await expect(page.frameLocator("iframe").first().locator("h1")).toHaveText("Steady");
});

test("a version published by an agent replaces the one on view", async ({ page }) => {
  const { token } = await seedToken(uniqueEmail("owner"));
  const art = await publishArtifact(page.request, token, { html: page1("First draft") });
  // The gate poll, without the live-view socket (live-view.spec.ts covers the pushed path, which
  // would show the version and its toast before the clock moves).
  await page.routeWebSocket(/\/api\/v1\/view\/[a-z0-9]+\/watch$/, (ws) => ws.close({ code: 4409 }));
  await page.clock.install();
  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator("iframe").first().locator("h1")).toHaveText("First draft");

  const client = await mcpClient(token);
  try {
    const r = await tool(client, "update_artifact", {
      id: art.id,
      html: page1("Second draft"),
      base_version: 1,
    });
    expect(r.isError).toBe(false);
  } finally {
    await client.close();
  }

  await page.clock.fastForward(16_000);
  await expect(page.getByText("Updated to v2")).toBeVisible();
  await expect(page.locator('iframe[title$="version 2"]')).toHaveCount(1);
  await expect(page.frameLocator('iframe[title$="version 2"]').locator("h1")).toHaveText(
    "Second draft",
  );
  await expect(page.locator("iframe")).toHaveCount(1);
});

test("text fields are 16px on touch screens, so focusing one does not zoom", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "touch screens only");
  const email = uniqueEmail("owner");
  const { token } = await seedToken(email);
  const art = await publishArtifact(page.request, token, { html: page1("Zoom") });
  await signInApi(page.request, email);
  await page.goto(`/a/${art.slug}?comments`);
  const composer = page.getByRole("region", { name: "Comments" }).getByRole("textbox").first();
  await expect(composer).toBeVisible();
  expect(await composer.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
});
