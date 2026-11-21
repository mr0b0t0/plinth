// An HTML deck under opaque content isolation (CONTENT_ISOLATION=opaque), against the second e2e
// Worker. The shell's document has an opaque origin there, and a slide still renders in its shadow
// root, its live embed still runs in a frame of the fixed loader (itself opaque, with no network),
// and fragments still step. No CSP report but the one the probe below makes on purpose.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, type Frame, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ROOT } from "../support/paths.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const DECK_DIR = path.join(ROOT, "docs/examples/plinth-deck");

function sampleDeck() {
  const assets: Record<string, unknown>[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(DECK_DIR, full).split(path.sep).join("/");
      if (rel === "deck.json") continue;
      assets.push(
        rel.endsWith(".png")
          ? { path: rel, content: readFileSync(full).toString("base64"), encoding: "base64" }
          : { path: rel, content: readFileSync(full, "utf8") },
      );
    }
  };
  walk(DECK_DIR);
  return { content: readFileSync(path.join(DECK_DIR, "deck.json"), "utf8"), assets };
}

test("an HTML deck renders, steps and runs its embed under an opaque origin", async ({ page }) => {
  test.setTimeout(60_000);
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  const email = uniqueEmail("opaque-htmldeck");
  const { token } = await seedToken(email, {
    label: "Opaque agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Opaque deck", type: "slides", ...sampleDeck() }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const artifact = (await res.json()) as { slug: string };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${OPAQUE_APP_ORIGIN}/a/${artifact.slug}`);
  const locator = page.frameLocator(CURRENT_FRAME);
  await expect(locator.locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
  const frame = (await (
    await page.locator(CURRENT_FRAME).elementHandle()
  )?.contentFrame()) as Frame;
  expect(await frame.evaluate(() => window.origin)).toBe("null");
  expect(
    await frame.evaluate(() => document.querySelectorAll(".plinth-slides__slide").length),
  ).toBe(11);

  // The publish slide's fragments step under an opaque origin too.
  const box = await page.locator(CURRENT_FRAME).boundingBox();
  if (!box) throw new Error("no frame box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.slide)).toBe("5");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          document
            .querySelector('.plinth-slides__frame[data-n="5"] .plinth-slides__slide')
            ?.shadowRoot?.querySelectorAll(".fragment.visible").length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  // The embed on slide 6 mounts and runs in the loader's own opaque document.
  await page.keyboard.type("6");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.frames().filter((f) => f.url().endsWith("/embed.html")).length)
    .toBeGreaterThan(0);
  const embed = page.frames().find((f) => f.url().endsWith("/embed.html"));
  await expect
    .poll(() => embed?.evaluate(() => document.body?.childElementCount ?? 0))
    .toBeGreaterThan(0);
  expect(await embed?.evaluate(() => window.origin)).toBe("null");
  expect(problems).toEqual([]);
});
