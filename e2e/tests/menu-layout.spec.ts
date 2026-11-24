// Opening a menu never moves the page. Every menu button on the dashboard (list and grid), the
// artifact page and the history page is opened in turn; the page's size, scroll position and the
// boxes of its bars, heading and the trigger itself must not change, and the open list must sit
// inside the viewport. A list positioned in the page's flow used to grow a short page past the
// screen when it opened below a row near the bottom: the page gained a scrollbar and everything
// shifted sideways by its width. Runs in the light, dark and mobile projects.
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { apiPut, newApiContext, publishArtifact, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";
import { shotsDir } from "../support/shots.ts";

/**
 * Headless Chromium draws overlay scrollbars that take no room, which hides a sideways shift. A
 * styled ::-webkit-scrollbar is a classic one (15px, as on Windows, Linux and a Mac with a mouse),
 * so a scrollbar that appears takes width from the page the way users see it.
 */
async function classicScrollbars(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent =
        "::-webkit-scrollbar{width:15px;height:15px}::-webkit-scrollbar-thumb{background:#8888}";
      document.head.append(style);
    });
  });
}

/** What must not change when a menu opens. */
function layout(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    };
    const trigger = document.activeElement?.closest("[aria-haspopup=menu]") ?? null;
    return {
      viewport: [root.clientWidth, root.clientHeight],
      scroll: [root.scrollWidth, root.scrollHeight, window.scrollX, window.scrollY],
      bar: box(document.querySelector(".pl-topbar, .pl-viewer__bar")),
      main: box(document.querySelector("main")),
      heading: box(document.querySelector("h1")),
      trigger: box(trigger),
    };
  });
}

/** Open every visible menu button on the page, one at a time, and check nothing moves. */
async function openEveryMenu(page: Page, where: string): Promise<number> {
  const triggers = page.locator("[aria-haspopup=menu]:visible");
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    const name = (await trigger.getAttribute("aria-label")) ?? (await trigger.textContent());
    // Focus first, so the trigger's own box is measured before and after.
    await trigger.focus();
    const before = await layout(page);
    await trigger.click();
    const menu = page.locator(`[role=menu][aria-labelledby="${await trigger.getAttribute("id")}"]`);
    await expect(menu, `${where}: ${name}`).toBeVisible();
    // The list's entrance animation has finished: compare the settled page.
    await page.waitForTimeout(200);
    const after = await layout(page);
    expect({ ...after, trigger: after.trigger ?? before.trigger }, `${where}: ${name}`).toEqual(
      before,
    );
    const r = await menu.boundingBox();
    const [vw, vh] = before.viewport as [number, number];
    expect(r, `${where}: ${name}`).not.toBeNull();
    if (r) {
      expect(r.x, `${where}: ${name} left`).toBeGreaterThanOrEqual(0);
      expect(r.y, `${where}: ${name} top`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${where}: ${name} right`).toBeLessThanOrEqual(vw);
      expect(r.y + r.height, `${where}: ${name} bottom`).toBeLessThanOrEqual(vh);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  return count;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = shotsDir("menu-layout");
  if (dir)
    await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`) });
}

test("opening a menu does not move or resize the page", async ({ page, context }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await classicScrollbars(page);
  const email = uniqueEmail("menus");
  const { token } = await seedToken(email);
  const req = await newApiContext();
  // Enough rows that the last one sits near the bottom of a laptop screen: its menu has no room
  // below it.
  let last = { id: "", slug: "" };
  for (let i = 0; i < 14; i++) {
    last = await publishArtifact(req, token, {
      title: `Menu row ${i}`,
      category: i % 2 ? "Alpha" : "Beta",
    });
  }
  for (const v of [1, 2]) {
    const put = await apiPut(
      req,
      `/artifacts/${last.id}`,
      { html: `<!doctype html><h1>v${v + 1}</h1>`, base_version: v },
      { token },
    );
    expect(put.status).toBe(200);
  }
  await seedSession(context, email);

  // Dashboard, list view: the sort, category and New menus, the account menu, and every row.
  await page.goto("/");
  await expect(page.getByText("Menu row 0", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "List view" }).click();
  expect(await openEveryMenu(page, "dashboard list")).toBeGreaterThanOrEqual(16);
  const lastRow = page.getByRole("button", { name: "Actions for Menu row 0" });
  await lastRow.click();
  await shot(page, "dashboard-last-row");
  await page.keyboard.press("Escape");

  // The same at the bottom of a page that already scrolls.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await openEveryMenu(page, "dashboard list, scrolled to the end");
  await page.evaluate(() => window.scrollTo(0, 0));

  // Grid view.
  await page.getByRole("button", { name: "Grid view" }).click();
  expect(await openEveryMenu(page, "dashboard grid")).toBeGreaterThanOrEqual(16);

  // The artifact page: the version picker and the actions menu.
  await page.goto(`/a/${last.slug}`);
  await expect(page.getByRole("button", { name: "Artifact actions" })).toBeVisible();
  expect(await openEveryMenu(page, "artifact")).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Artifact actions" }).click();
  await shot(page, "artifact-actions");
  await page.keyboard.press("Escape");

  // History: one menu per version.
  await page.goto(`/a/${last.slug}/history`);
  await expect(page.getByRole("button", { name: "More actions for v1" })).toBeVisible();
  expect(await openEveryMenu(page, "history")).toBeGreaterThanOrEqual(2);

  // The design system page's menus, in both of its theme panels.
  await page.goto("/design");
  await expect(page.getByRole("heading", { name: "Design system", level: 1 })).toBeVisible();
  expect(await openEveryMenu(page, "design")).toBeGreaterThanOrEqual(1);
});
