// A design's server-side PNG and PDF export (docs/spec.md "Designs"). The local Worker has no
// Browser Rendering binding, so here Chromium plays the export's browser: it opens what
// services/designExport.ts would open (the thumbnail's capture load, POST /__dev/capture-url: a
// capture pass bound to the version, and the pass for the boards' cookie partition) with print
// media emulated before the page loads, waits as the Worker does, then prints a PDF or takes the
// board's box as a PNG. Checked here: every board renders with its own image and styles in that
// layout, the PDF has one page per board at the board's size, one board kept alone is exactly
// the board, the same page on screen is the canvas, and an instance without the binding offers
// no export in the menu and refuses the endpoint.
import { expect, type Page, test } from "@playwright/test";
import { APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import {
  captureLoad,
  openCapture,
  openExport,
  pdfPageSizes,
  pngSize,
  seedSession,
  seedToken,
} from "../support/db.ts";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DESIGN = [
  "<title>Export kit</title>",
  '<link rel="stylesheet" href="brand.css">',
  '<!-- artboard id="home" name="Home" size="iphone" -->',
  '<img id="hero" src="img/hero.png" alt="" width="40" height="40">',
  "<h1>Ship faster</h1>",
  '<p id="out">static</p>',
  "<script>document.getElementById('out').textContent = 'script ran';</script>",
  '<!-- artboard id="post" name="Launch post" size="instagram-post" background="#0b0b0f" -->',
  '<div style="color: white; font-size: 96px; padding: 80px">Now live</div>',
  '<!-- artboard id="mrec" name="Ad" size="ad-medium-rectangle" background="transparent" -->',
  "<p>Ad</p>",
].join("\n");

/** CSS px to PDF points, as Chromium prints them (within a point of rounding). */
const pt = (px: number) => (px * 72) / 96;

async function publishDesign(origin = APP_ORIGIN, sessionPage?: Page) {
  const email = uniqueEmail("design-export");
  const { token } = await seedToken(email, { clientType: "claude", origin });
  if (sessionPage) await seedSession(sessionPage.context(), email, origin);
  const res = await fetch(`${origin}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Export kit",
      type: "design",
      content: DESIGN,
      assets: [
        { path: "img/hero.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
        { path: "brand.css", content: "h1 { color: rgb(47, 91, 234); }", content_type: "text/css" },
      ],
    }),
  });
  const art = (await res.json()) as { id: string; slug: string; version: number };
  expect(res.status, JSON.stringify(art)).toBe(201);
  return { ...art, token };
}

/** Wait as the Worker's shooter does: the renderer ready, then every board loaded. */
async function waitForExport(page: Page, boards: number) {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-ready", "ok", { timeout: 15_000 });
  await expect(html).toHaveAttribute("data-boards", String(boards));
  await expect(html).toHaveAttribute("data-boards-loaded", String(boards), { timeout: 15_000 });
}

async function boardFrame(page: Page, id: string) {
  const handle = await page
    .locator(`.plinth-design__board[data-board="${id}"] iframe`)
    .elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no board ${id}`);
  return frame;
}

test.describe("the export layout", () => {
  test.use({ viewport: { width: 1080, height: 1080 } });

  test("renders every board with its files, and prints one PDF page per board at its size", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const art = await publishDesign();
    await page.context().clearCookies();
    const load = await captureLoad(art.id, art.version);
    expect(new URL(load.url).searchParams.get("next")).toBe(`/__plinth/v/${art.version}/`);
    await openExport(page, load);
    // Nothing in the address: print media at boot is what selects the layout.
    expect(new URL(page.url()).pathname).toBe(`/__plinth/v/${art.version}/`);
    expect(new URL(page.url()).search).toBe("");
    await expect(page.locator("html")).toHaveAttribute("data-export", "");
    await waitForExport(page, 3);
    // No canvas chrome: only the boards, in source order, with no covers.
    await expect(page.locator(".plinth-design__toolbar, .plinth-design__cover")).toHaveCount(0);
    await expect(page.locator(".plinth-design__board")).toHaveCount(3);
    const home = await boardFrame(page, "home");
    await expect(home.locator("#out")).toHaveText("script ran");
    await expect(home.locator("h1")).toHaveCSS("color", "rgb(47, 91, 234)");
    await expect
      .poll(() => home.locator("#hero").evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBeGreaterThan(0);

    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const sizes = pdfPageSizes(pdf);
    expect(sizes).toHaveLength(3);
    const expected = [
      [393, 852],
      [1080, 1080],
      [300, 250],
    ];
    for (const [i, [w, h]] of expected.entries()) {
      const [pw, ph] = sizes[i] ?? [0, 0];
      expect(Math.abs(pw - pt(w ?? 0)), `page ${i + 1} width`).toBeLessThan(1);
      expect(Math.abs(ph - pt(h ?? 0)), `page ${i + 1} height`).toBeLessThan(1);
    }
  });

  test("keeps one board for a PNG, whose box is exactly the board", async ({ page }) => {
    const art = await publishDesign();
    await page.context().clearCookies();
    await openExport(page, await captureLoad(art.id, art.version), "post");
    await expect(page.locator(".plinth-design__board")).toHaveCount(1);
    await expect(page.locator('.plinth-design__board[data-board="post"][data-loaded]')).toHaveCount(
      1,
      { timeout: 15_000 },
    );
    // A PNG is taken in screen media, as people see the board.
    await page.emulateMedia({ media: "screen" });
    const box = await page.locator('.plinth-design__board[data-board="post"]').boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    const png = await page.screenshot({
      type: "png",
      omitBackground: true,
      clip: box ?? undefined,
    });
    expect(pngSize(png)).toEqual({ width: 1080, height: 1080 });
  });

  test("is the canvas on screen: the same page as a thumbnail, with no address for the layout", async ({
    page,
  }) => {
    const art = await publishDesign();
    await page.context().clearCookies();
    const load = await captureLoad(art.id, art.version);
    const enter = new URL(load.url);
    // The old export address is just the canvas now.
    enter.searchParams.set("next", `/__plinth/v/${art.version}/?plinth-print=1&plinth-board=post`);
    await openCapture(page, { ...load, url: enter.toString() });
    await expect(page.locator("html")).toHaveAttribute("data-ready", "ok", { timeout: 15_000 });
    await expect(page.locator(".plinth-design")).toHaveAttribute("data-mode", "canvas");
    await expect(page.locator("html")).not.toHaveAttribute("data-export", "");
  });
});

test("without a Browser Rendering binding the menu offers no export and the endpoint refuses", async ({
  page,
}) => {
  const art = await publishDesign(APP_ORIGIN, page);
  const config = await (await fetch(`${APP_ORIGIN}/api/v1/config`)).json();
  expect(config.design_export).toBe(false);
  const refused = await fetch(
    `${APP_ORIGIN}/api/v1/artifacts/${art.id}/export?format=pdf&version=1`,
    { headers: { Authorization: `Bearer ${art.token}` } },
  );
  expect(refused.status).toBe(403);
  expect((await refused.json()).error.code).toBe("feature_disabled");

  await page.goto(`/a/${art.slug}`);
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Print or save as PDF" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Download \.(png|pdf)$/ })).toHaveCount(0);
});
