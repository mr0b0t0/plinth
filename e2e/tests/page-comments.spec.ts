// Comments from the page (plinth.comments), with the example sketch board
// (docs/examples/canvas-comments.html). A click on the canvas opens Plinth's composer with the
// page's own anchor and the frame does not reload; the person writes and posts the comment; the
// page draws its own marker from onThreads, Plinth's pin lands where locate says, and picking the
// pin reaches the page's onFocus. A hostile page can only open the composer, at most once a
// second, and never fill it in; a link viewer is told to sign in; agents read the page anchor.
import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { ROOT } from "../support/paths.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const BOARD = readFileSync(path.join(ROOT, "docs/examples/canvas-comments.html"), "utf8");

const board = (page: Page): FrameLocator => page.frameLocator(CURRENT_FRAME);

async function open(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(board(page).locator("h1")).toHaveText("Sketch board", { timeout: 15_000 });
  // The board said hello at load, and the app welcomed it. The heading renders before the
  // runtime script after it has loaded, so wait for the runtime rather than read it once.
  await expect
    .poll(
      () =>
        board(page)
          .locator("body")
          .evaluate(() => window.plinth?.comments?.ready ?? null),
      { timeout: 15_000 },
    )
    .toEqual({ available: true, reason: null });
}

/** Marks the frame's document, so a reload (a new document) would lose the mark. */
const mark = (page: Page) =>
  board(page)
    .locator("body")
    .evaluate(() => {
      (window as unknown as { __mark: number }).__mark = 42;
    });
const marked = (page: Page) =>
  board(page)
    .locator("body")
    .evaluate(() => (window as unknown as { __mark?: number }).__mark ?? null);

async function owner(page: Page, visibility = "allowlist") {
  const email = uniqueEmail("sketch");
  const { token } = await seedToken(email, { label: "Sketch agent", clientType: "claude" });
  const art = await publishArtifact(page.request, token, {
    title: "Sketch board",
    html: BOARD,
    visibility,
  });
  return { email, token, art };
}

test("the page opens the composer with its anchor, and the frame keeps its state", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const { email, token, art } = await owner(page);
  await seedSession(page.context(), email);
  const gates: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/view/")) gates.push(r.url());
  });
  await open(page, art.slug);
  await mark(page);

  const canvas = board(page).locator("canvas");
  await canvas.click({ position: { x: 120, y: 80 } });
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel).toBeVisible();
  const chip = panel.locator(".cm-anchor-chip");
  await expect(chip).toContainText("Placed by the page:");
  await expect(chip).toContainText("Point");
  // No pick button: the page places its own anchors.
  await expect(panel.getByRole("button", { name: "Pin to an element" })).toHaveCount(0);
  // The frame was not reloaded into review mode: same document, no review gate.
  expect(await marked(page)).toBe(42);
  expect(gates.filter((g) => g.includes("review=1"))).toEqual([]);

  if (info.project.name !== "mobile") {
    // The app's chrome with the page's chip shown; the board inside the frame is the author's.
    const results = await new AxeBuilder({ page }).exclude("iframe").analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  }

  const box = panel.getByRole("textbox", { name: "New comment" });
  await box.fill("Look at this dot");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.locator(".cm-thread")).toHaveCount(1);
  await expect(board(page).locator("#status")).toHaveText("Comment posted.");
  // The page drew its own marker for the thread.
  const marker = board(page).locator(".marker[data-thread-id]");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText("1");
  const threadId = await marker.getAttribute("data-thread-id");
  expect(threadId).toBeTruthy();
  expect(await marked(page)).toBe(42);

  // Agents read the page anchor.
  const client = await mcpClient(token);
  const { data } = await tool<{ items: { anchor: Record<string, unknown> }[] }>(
    client,
    "list_comments",
    { id: art.id },
  );
  await client.close();
  expect(data.items[0]?.anchor).toMatchObject({ kind: "page", key: "canvas" });

  // On a phone the panel covers the frame, and pins behind it are not drawn.
  if (info.project.name === "mobile") return;

  // Plinth's pin sits where the page's locator put the anchor: on the page's own marker (the
  // board moved when the panel opened and the frame got narrower). The pin is the active one,
  // drawn larger, and stays centred on its spot.
  const pin = page.locator('[data-testid="comment-pins"] button');
  await expect(pin).toHaveCount(1);
  const center = (b: { x: number; y: number; width: number; height: number } | null) => ({
    x: (b?.x ?? 0) + (b?.width ?? 0) / 2,
    y: (b?.y ?? 0) + (b?.height ?? 0) / 2,
  });
  await expect
    .poll(async () => {
      const p = center(await pin.boundingBox());
      const m = center(await marker.boundingBox());
      return Math.max(Math.abs(p.x - m.x), Math.abs(p.y - m.y));
    })
    .toBeLessThan(3);

  // Clicking Plinth's pin tells the page, which marks its own marker.
  await pin.click();
  await expect(board(page).locator("#focused")).toHaveText(threadId ?? "");
  await expect(marker).toHaveAttribute("data-focused", "");

  // After a reload the page and the pins come back.
  await page.reload();
  await expect(board(page).locator("h1")).toHaveText("Sketch board", { timeout: 15_000 });
  await expect(board(page).locator(".marker[data-thread-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(page.locator('[data-testid="comment-pins"] button')).toHaveCount(1);
});

test("a hostile page can only open the composer, once, and never fill it in", async ({ page }) => {
  test.setTimeout(60_000);
  const { email, art } = await owner(page);
  await seedSession(page.context(), email);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await open(page, art.slug);
  // Page script posts the protocol itself, bypassing the runtime's checks.
  await board(page)
    .locator("body")
    .evaluate(() => {
      const post = (req: string, anchor: Record<string, unknown>) =>
        window.parent.postMessage(
          { source: "plinth-comments", v: 1, type: "compose", req, anchor },
          "*",
        );
      post("forged-request-big-0000", { key: "a", data: { s: "x".repeat(4096) } });
      post("forged-request-img-0000", { key: "a", text: '<img src=x onerror="alert(1)">' });
      for (let i = 0; i < 8; i++) post(`forged-request-${i}-000000`, { key: `k${i}` });
    });
  const panel = page.getByRole("region", { name: "Comments" });
  await expect(panel).toBeVisible();
  const chip = panel.locator(".cm-anchor-chip");
  // The oversized one was dropped; the next one opened the composer; the rest were refused.
  await expect(chip).toHaveText(/Placed by the page: <img src=x onerror=/);
  await expect(panel.locator(".cm-anchor-chip")).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(chip).toHaveText(/<img src=x/);
  expect(await page.locator("img[src='x']").count()).toBe(0);
  expect(dialogs).toEqual([]);
  // The page cannot write the comment: the box is empty.
  await expect(panel.getByRole("textbox", { name: "New comment" })).toHaveValue("");
});

test("a link viewer is told to sign in, and the page hears closed when the panel closes", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const { art } = await owner(page, "unlisted");
  const anon = await (await browser.newContext()).newPage();
  try {
    await open(anon, art.slug);
    const body = board(anon).locator("body");
    await body.evaluate(() => {
      window.composeResult = null;
      window.plinth.comments.compose({ key: "canvas", x: 1, y: 1 }).then((r: unknown) => {
        window.composeResult = r;
      });
    });
    const panel = anon.getByRole("region", { name: "Comments" });
    await expect(panel.getByRole("link", { name: "Sign in to comment" })).toBeVisible();
    // The page is not told this person cannot comment, not even by how soon it hears back.
    await anon.waitForTimeout(1500);
    expect(await body.evaluate(() => window.composeResult)).toBeNull();
    await panel.getByRole("button", { name: "Close comments" }).click();
    await expect
      .poll(() => body.evaluate(() => window.composeResult))
      .toEqual({ status: "closed" });
  } finally {
    await anon.context().close();
  }
});

declare global {
  interface Window {
    // The page runtime has no types in the e2e package.
    plinth: any;
    composeResult: unknown;
  }
}
