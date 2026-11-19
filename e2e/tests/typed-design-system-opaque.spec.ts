// A design system under opaque content isolation (CONTENT_ISOLATION=opaque), against the second
// e2e Worker: the site renders under the CSP sandbox, and the preview frames, which inherit that
// sandbox and are opaque too, still show the design system's own image.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ACME_ASSETS, acmeWith, stubGoogleFonts } from "../support/designSystem.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

test("the site renders and its previews show the design system's images", async ({ page }) => {
  await stubGoogleFonts(page);
  const email = uniqueEmail("ds-opaque");
  const { token } = await seedToken(email, {
    label: "Design agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Acme UI",
      type: "design_system",
      content: acmeWith(),
      assets: ACME_ASSETS,
    }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  await page.goto(`/a/${art.slug}`);
  const site = page.frameLocator(CURRENT_FRAME);
  await expect(site.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(site.locator(".ds-header h1")).toHaveText("Acme UI");

  const handle = site.locator('iframe[title="Card: With logo (light)"]');
  await handle.scrollIntoViewIfNeeded();
  await expect(handle).toHaveAttribute("sandbox", "allow-same-origin");
  const card = site.frameLocator('iframe[title="Card: With logo (light)"]');
  const img = card.locator('img[alt="Acme"]');
  await expect(img).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
  // The button preview still gets the design system's CSS.
  const button = site.frameLocator('iframe[title="Button: Primary (light)"]').locator("button");
  await expect(button).toHaveCSS("background-color", "rgb(51, 85, 255)");
});
