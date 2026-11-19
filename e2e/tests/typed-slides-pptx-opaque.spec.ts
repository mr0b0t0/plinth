// Download a deck as .pptx under opaque content isolation (CONTENT_ISOLATION=opaque), against the
// second e2e Worker. The deck's document has an opaque origin: the app posts the request to "*"
// and accepts the answer from origin "null" by the frame's window; the frame cannot read its own
// files (the content host sends no CORS) and a canvas would be tainted, so file images are left
// out and the app says so. Inline data: images, part of the deck's text, still go in. The writer
// still loads from the artifact's own subdomain under script-src 'self'.
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { readPptx } from "../support/pptx.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const DECK = [
  "# Opaque export",
  "",
  "Built in an opaque frame.",
  "",
  "Note: Notes travel in the file.",
  "",
  "---",
  "",
  "## A file image",
  "",
  "![A tiny square](pixel.png)",
  "",
  "---",
  "",
  "## An inline image",
  "",
  `![Inline](data:image/png;base64,${PIXEL_PNG})`,
].join("\n");

test("a deck exports under an opaque origin, leaving its file images out", async ({ page }) => {
  test.setTimeout(60_000);
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to|ERR_BLOCKED/i.test(msg.text()))
      problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  const email = uniqueEmail("opaque-pptx");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Opaque export",
      type: "slides",
      content: DECK,
      assets: [
        { path: "pixel.png", content: PIXEL_PNG, encoding: "base64", content_type: "image/png" },
      ],
    }),
  });
  const art = (await res.json()) as { slug: string; type: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  await page.goto(`/a/${art.slug}`);
  const locator = page.frameLocator(CURRENT_FRAME);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = await (await page.locator(CURRENT_FRAME).elementHandle())?.contentFrame();
  if (!frame) throw new Error("no deck frame");
  expect(await frame.evaluate(() => self.origin)).toBe("null");

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await page.getByRole("menuitem", { name: "Download .pptx" }).click();
  const download = await downloaded;
  await expect(page.getByText("Downloaded the .pptx")).toBeVisible();
  await expect(
    page.getByText("Images were left out: this Plinth instance serves decks with opaque origins."),
  ).toBeVisible();

  const file = await readPptx(download);
  expect(file.name).toBe("Opaque export.pptx");
  expect(file.slides).toHaveLength(3);
  expect(file.slides[0]).toContain("<a:t>Opaque export</a:t>");
  expect(file.notes.join("\n")).toContain("Notes travel in the file.");
  // Only the inline image: the file image could not be read from an opaque origin.
  expect(file.media).toHaveLength(1);
  expect(file.slides[1]).not.toContain("<p:pic>");
  expect(file.slides[2]).toContain("<p:pic>");
  expect(problems).toEqual([]);
});
