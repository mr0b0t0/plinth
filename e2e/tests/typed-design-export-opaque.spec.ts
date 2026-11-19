// A design's export layout under opaque content isolation (CONTENT_ISOLATION=opaque), against the
// second e2e Worker. Chromium plays the export's browser as in typed-design-export.spec.ts: the
// shell is itself opaque at the top here, so the boards' requests have no cookie partition and
// the Worker hands the browser an unpartitioned capture pass. The boards still load their image
// and CSS, and the PDF has one page per board at its size.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { exportLoad, openCapture, pdfPageSizes, seedToken } from "../support/db.ts";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DESIGN = [
  '<link rel="stylesheet" href="brand.css">',
  '<!-- artboard id="home" name="Home" size="iphone" -->',
  '<img id="hero" src="img/hero.png" alt="" width="40" height="40">',
  "<h1>Opaque export</h1>",
  '<!-- artboard id="ad" name="Ad" size="ad-medium-rectangle" -->',
  "<p>Ad</p>",
].join("\n");

test("the export layout loads the boards' files and prints a page per board", async ({ page }) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("design-export-opaque");
  const { token } = await seedToken(email, { clientType: "claude", origin: OPAQUE_APP_ORIGIN });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Opaque export",
      type: "design",
      content: DESIGN,
      assets: [
        { path: "img/hero.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
        { path: "brand.css", content: "h1 { color: rgb(1, 2, 3); }", content_type: "text/css" },
      ],
    }),
  });
  const art = (await res.json()) as { id: string; version: number };
  expect(res.status, JSON.stringify(art)).toBe(201);

  const load = await exportLoad(art.id, art.version, null, OPAQUE_APP_ORIGIN);
  expect(load.cookies).toHaveLength(1);
  expect(load.cookies[0]?.partitionKey).toBeUndefined();
  await openCapture(page, load);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-ready", "ok", { timeout: 15_000 });
  await expect(html).toHaveAttribute("data-boards-loaded", "2", { timeout: 15_000 });
  const handle = await page
    .locator('.plinth-design__board[data-board="home"] iframe')
    .elementHandle();
  const home = await handle?.contentFrame();
  if (!home) throw new Error("no board home");
  await expect(home.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  await expect
    .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);

  const sizes = pdfPageSizes(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
  expect(sizes).toHaveLength(2);
  expect(Math.abs((sizes[0]?.[0] ?? 0) - 294.75)).toBeLessThan(1);
  expect(Math.abs((sizes[1]?.[1] ?? 0) - 187.5)).toBeLessThan(1);
});
