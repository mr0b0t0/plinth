// The default design system (docs/spec.md "Design systems"): the owner sets one of their design
// systems as the default from its ⋯ menu on the dashboard, its badge says so, and their agent sees
// it marked in list_artifacts. Also an install: a page copies the design system's files with
// copy_files and its stylesheet applies on the content host.
import { expect, test } from "@playwright/test";
import { contentOrigin, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { ACME_ASSETS, acmeWith } from "../support/designSystem.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

test("the owner sets a design system as their default from the dashboard menu", async ({
  page,
}, info) => {
  const email = uniqueEmail("dsdefault");
  const { token } = await seedToken(email, { label: "Design agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  for (const title of ["Acme UI", "Marketing"]) {
    const r = await tool(client, "publish_artifact", {
      title,
      type: "design_system",
      content: acmeWith((ds) => {
        ds.name = title;
      }),
      assets: ACME_ASSETS,
    });
    expect(r.isError, r.text).toBe(false);
  }
  await tool(client, "publish_artifact", {
    title: "Launch page",
    html: "<!doctype html><title>Launch</title><h1>Hi</h1>",
  });

  // Phone shots at 390px, the width the visual review uses.
  if (info.project.name === "mobile") await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  const row = page.locator(".pl-dash__card, .pl-dash__row").filter({ hasText: "Acme UI" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Actions for Acme UI" }).click();
  await expect(page.getByRole("menuitem", { name: "Set as default" })).toBeVisible();
  const dir = shotsDir("ds-default");
  if (dir) await page.screenshot({ path: `${dir}/${info.project.name}-menu.png` });
  await page.getByRole("menuitem", { name: "Set as default" }).click();
  await expect(row.locator(".pl-badge")).toHaveText("Default design system");
  // The other design system keeps its plain badge.
  const other = page.locator(".pl-dash__card, .pl-dash__row").filter({ hasText: "Marketing" });
  await expect(other.locator(".pl-badge")).toHaveText("Design system");
  if (dir) await page.screenshot({ path: `${dir}/${info.project.name}-default.png` });

  const listed = await tool<{ items: { title: string; default?: boolean }[] }>(
    client,
    "list_artifacts",
    { type: "design_system" },
  );
  expect(listed.data.items.filter((i) => i.default).map((i) => i.title)).toEqual(["Acme UI"]);

  // The menu now offers to remove it, and removing it clears the badge.
  await row.getByRole("button", { name: "Actions for Acme UI" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove as default" })).toBeVisible();
  if (dir) await page.screenshot({ path: `${dir}/${info.project.name}-menu-remove.png` });
  await page.getByRole("menuitem", { name: "Remove as default" }).click();
  await expect(row.locator(".pl-badge")).toHaveText("Design system");
  await client.close();
});

test("a page installs a design system with copy_files and its tokens apply", async ({ page }) => {
  const email = uniqueEmail("dsinstall");
  const { token } = await seedToken(email, { label: "Design agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const ds = await tool<{ id: string }>(client, "publish_artifact", {
    title: "Acme UI",
    type: "design_system",
    content: acmeWith(),
    assets: ACME_ASSETS,
  });
  const read = await tool<{ install: { copy_files: unknown[]; stylesheets: string[] } }>(
    client,
    "get_design_system",
    { id: ds.data.id, include: ["css"] },
  );
  const links = read.data.install.stylesheets
    .map((h) => `<link rel="stylesheet" href="${h}">`)
    .join("");
  const html = `<!doctype html><html><head><title>Built on Acme</title><meta name="plinth-design-system" content="${ds.data.id}@1">${links}<style>h1{color:var(--acme-color-brand-500)}</style></head><body><h1>Acme</h1></body></html>`;
  const pub = await tool<{ id: string; slug: string; warnings: { code: string }[] }>(
    client,
    "publish_artifact",
    { title: "Built on Acme", html, copy_files: read.data.install.copy_files },
  );
  expect(pub.isError, pub.text).toBe(false);
  expect(pub.data.warnings.filter((w) => w.code === "missing_file")).toEqual([]);
  await page.goto(`/a/${pub.data.slug}`);
  const frame = page.frameLocator("iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)");
  await expect(frame.locator("h1")).toHaveText("Acme");
  const color = await frame.locator("h1").evaluate((el) => getComputedStyle(el).color);
  // #3355ff in light, #6b8cff in dark: either way the copied tokens.css applied.
  expect(["rgb(51, 85, 255)", "rgb(107, 140, 255)"]).toContain(color);
  expect(contentOrigin(pub.data.id)).toContain(pub.data.id);
  await client.close();
});
