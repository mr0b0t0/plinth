// Comments from the page under opaque content isolation (the second e2e Worker): the sketch board
// (docs/examples/canvas-comments.html) runs with an opaque origin, so the app identifies its frame
// by window and posts to it with "*". The same flow works: compose, post, the page's own marker,
// Plinth's pin, and the pin reaching the page's onFocus.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { ROOT } from "../support/paths.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const BOARD = readFileSync(path.join(ROOT, "docs/examples/canvas-comments.html"), "utf8");
const OPAQUE_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const board = (page: Page): FrameLocator => page.frameLocator(CURRENT_FRAME);

test("comments from the page work with an opaque-origin frame", async ({ page }) => {
  test.setTimeout(90_000);
  const email = uniqueEmail("sketch-opaque");
  const { token } = await seedToken(email, {
    label: "Sketch agent",
    clientType: "claude",
    origin: OPAQUE_APP_ORIGIN,
  });
  await seedSession(page.context(), email, OPAQUE_APP_ORIGIN);
  const res = await fetch(`${OPAQUE_APP_ORIGIN}/api/v1/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Sketch board", html: BOARD }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  await page.goto(`/a/${art.slug}`);
  await expect(page.locator(CURRENT_FRAME)).toHaveAttribute("sandbox", OPAQUE_FRAME_SANDBOX);
  await expect(board(page).locator("h1")).toHaveText("Sketch board", { timeout: 15_000 });
  const body = board(page).locator("body");
  expect(await body.evaluate(() => self.origin)).toBe("null");
  // The heading renders before the runtime script after it has loaded: wait for the runtime.
  await expect
    .poll(
      () =>
        body.evaluate(
          () =>
            (window as unknown as { plinth?: { comments?: { ready: unknown } } }).plinth?.comments
              ?.ready ?? null,
        ),
      { timeout: 15_000 },
    )
    .toEqual({ available: true, reason: null });
  await body.evaluate(() => {
    (window as unknown as { __mark: number }).__mark = 7;
  });

  await board(page)
    .locator("canvas")
    .click({ position: { x: 150, y: 90 } });
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel.locator(".cm-anchor-chip")).toContainText("Placed by the page:");
  await panel.getByRole("textbox", { name: "New comment" }).fill("An opaque dot");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(board(page).locator("#status")).toHaveText("Comment posted.");
  const marker = board(page).locator(".marker[data-thread-id]");
  await expect(marker).toHaveCount(1);
  const threadId = await marker.getAttribute("data-thread-id");
  // The same document: opening comments did not reload it.
  expect(await body.evaluate(() => (window as unknown as { __mark?: number }).__mark)).toBe(7);

  const pin = page.locator('[data-testid="comment-pins"] button');
  await expect(pin).toHaveCount(1);
  await pin.click();
  await expect(board(page).locator("#focused")).toHaveText(threadId ?? "");
});
