// Theme: follows the system, the manual choice persists, no flash of the wrong theme on load;
// and the /design route shows every token and component in both modes, axe-clean.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const themeOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test("follows the system setting until the user picks a mode", async ({ page }, info) => {
  await page.goto("/design");
  const system = info.project.use.colorScheme === "dark" ? "dark" : "light";
  expect(await themeOf(page)).toBe(system);
});

test("the manual toggle persists across reloads, applied before the app script runs", async ({
  page,
}) => {
  await page.goto("/design");
  const before = await themeOf(page);
  const target = before === "dark" ? "light" : "dark";
  await page
    .getByRole("button", { name: new RegExp(`\\(${target} mode\\)`) })
    .first()
    .click();
  expect(await themeOf(page)).toBe(target);
  expect(await page.evaluate(() => localStorage.getItem("plinth-theme"))).toBe(target);

  // Block the app bundle: only the blocking public/theme.js in <head> can set the theme now. If
  // the attribute is right without the bundle, the first paint already had the right theme.
  await page.route(/\/assets\/.*\.js$/, (route) => route.abort());
  await page.reload();
  expect(await themeOf(page)).toBe(target);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("");
});

test("/design shows tokens and components in both modes and passes axe", async ({ page }) => {
  await page.goto("/design");
  await expect(page.getByRole("heading", { name: "Design system", level: 1 })).toBeVisible();
  for (const name of ["Color", "Type", "Components"]) {
    await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("--color-accent", { exact: true }).first()).toBeVisible();
  for (const mode of ["Gallery", "After hours"]) {
    await page.getByRole("radio", { name: mode }).first().click();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});
