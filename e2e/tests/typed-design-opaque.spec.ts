// A design under opaque content isolation (CONTENT_ISOLATION=opaque), against the second e2e
// Worker: the shell renders under the CSP sandbox, its board frames (opaque in every mode) still
// load the design's image and CSS and run its script, the menu's print reaches the opaque shell
// through "*", and the editor's preview renders the boards of the draft.
import { expect, type Frame, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { captureLoad, openCapture, seedSession, seedToken } from "../support/db.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PREVIEW_FRAME = 'iframe[title^="Preview of"]';
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const DESIGN = [
  '<link rel="stylesheet" href="brand.css">',
  '<!-- artboard id="home" name="Home" size="iphone" -->',
  '<img id="hero" src="img/hero.png" alt="" width="40" height="40">',
  "<h1>Opaque design</h1>",
  '<p id="out">static</p>',
  "<script>document.getElementById('out').textContent = self.origin;</script>",
  '<!-- artboard id="ad" name="Ad" size="ad-medium-rectangle" -->',
  "<p>Ad</p>",
].join("\n");

async function boardFrame(shell: Frame, id: string): Promise<Frame> {
  await expect(shell.locator(`.plinth-design__board[data-board="${id}"][data-loaded]`)).toHaveCount(
    1,
    { timeout: 15_000 },
  );
  const handle = await shell
    .locator(`.plinth-design__board[data-board="${id}"] iframe`)
    .elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no board ${id}`);
  return frame;
}

test("a design renders its boards with their image, prints, and previews in the editor", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const email = uniqueEmail("design-opaque");
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
      title: "Opaque kit",
      type: "design",
      content: DESIGN,
      assets: [
        { path: "img/hero.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
        { path: "brand.css", content: "h1 { color: rgb(1, 2, 3); }", content_type: "text/css" },
      ],
    }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  await page.goto(`/a/${art.slug}`);
  await expect(page.frameLocator(CURRENT_FRAME).locator('html[data-ready="ok"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  const shell = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!shell) throw new Error("no shell");
  expect(await shell.evaluate(() => self.origin)).toBe("null");
  const home = await boardFrame(shell, "home");
  await expect(home.locator("#out")).toHaveText("null");
  await expect(home.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  await expect
    .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  expect(await home.evaluate(() => window.innerWidth)).toBe(393);

  // Print reaches the opaque shell (posted with "*").
  await shell.evaluate(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    window.print = () => {
      w.__printed += 1;
    };
  });
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Print or save as PDF" }).click();
  await expect
    .poll(() => shell.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);

  // The editor's preview renders the draft's boards with the version's image.
  await page.goto(`/a/${art.slug}/edit`);
  const preview = page.frameLocator(PREVIEW_FRAME);
  await expect(preview.locator(".plinth-design__board")).toHaveCount(2, { timeout: 15_000 });
  const pf = await (await page.locator(PREVIEW_FRAME).elementHandle())?.contentFrame();
  if (!pf) throw new Error("no preview");
  const previewHome = await boardFrame(pf, "home");
  await expect
    .poll(() => previewHome.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});

test("a thumbnail capture loads the boards' image and CSS under opaque isolation too", async ({
  page,
}) => {
  const email = uniqueEmail("design-opaque-capture");
  const { token } = await seedToken(email, { clientType: "claude", origin: OPAQUE_APP_ORIGIN });
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Opaque capture",
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
  // As services/thumbnails.ts does: the boards' cookie first, then the enter URL top-level. Here
  // the shell itself is opaque at the top, so the boards' requests have no cookie partition at
  // all and the Worker hands the browser an unpartitioned pass.
  await openCapture(page, await captureLoad(art.id, art.version, OPAQUE_APP_ORIGIN));
  const shell = page.mainFrame();
  await expect(shell.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const home = await boardFrame(shell, "home");
  await expect(home.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  await expect
    .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});
