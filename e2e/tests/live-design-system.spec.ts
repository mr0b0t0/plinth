// Editing a design system on its page (docs/spec.md "Design systems", "Editing"): the owner turns
// Edit on and changes a token's colour in place, and Publish makes v2, stored as Plinth's 2-space
// JSON with that colour; a version an agent publishes meanwhile is never merged: the page edits
// freeze, and the whole-draft review shows both sites and publishes the page's as they are; a
// token row's "Rename: Ask an agent" opens the Ask dialog pointing at that token; and a compact
// system of about 900 KB, changed in place, is published compact. With PLINTH_E2E_SHOTS set, the
// edit mode, the menus, the Ask dialog and the review are saved for review in each project.
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { apiGet, uniqueEmail } from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { ACME, ACME_ASSETS, stubGoogleFonts } from "../support/designSystem.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { shotsDir } from "../support/shots.ts";
import { seedToken } from "../support/tokens.ts";

const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";
const SHOTS = shotsDir("ds-inline");

type Json = Record<string, any>;

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` });
}

/** An owner whose agent publishes `content` as a design system, signed in on the page. */
async function publishDs(page: Page, content: string) {
  const email = uniqueEmail("ds-live");
  const { token } = await seedToken(email, { label: "Design agent", clientType: "claude" });
  await seedSession(page.context(), email);
  const client = await mcpClient(token);
  const r = await tool<{ id: string; slug: string }>(client, "publish_artifact", {
    title: "Acme UI",
    type: "design_system",
    content,
    assets: ACME_ASSETS,
  });
  expect(r.isError, r.text).toBe(false);
  return { client, id: r.data.id, slug: r.data.slug };
}

const frameOf = (page: Page) => page.frameLocator(CURRENT_FRAME);
const tokenRow = (page: Page, path: string) =>
  frameOf(page).locator(`.ds-token[data-path="${path}"]`);

async function startEditing(page: Page) {
  const toggle = page.getByRole("button", { name: "Edit", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  else {
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Edit on the page" }).click();
  }
  const bar = page.getByRole("region", { name: "Editing on the page" });
  await expect(bar).toBeVisible();
  await expect(bar).not.toContainText("Connecting", { timeout: 10_000 });
  await expect(frameOf(page).locator(".ds-token--editing").first()).toBeVisible();
  return bar;
}

async function open(page: Page, slug: string) {
  await page.goto(`/a/${slug}`);
  await expect(frameOf(page).locator('html[data-ready="ok"]')).toHaveCount(1, { timeout: 15_000 });
}

/** Type a colour into a token's light value field, as a person does: then Enter. */
async function setColor(page: Page, path: string, value: string) {
  const field = tokenRow(page, path).locator('.ds-token__controls input[type="text"]').first();
  await field.fill(value);
  await field.press("Enter");
}

test("a colour changed in place is published as v2, in Plinth's 2-space JSON", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await stubGoogleFonts(page);
  const { client, id, slug } = await publishDs(page, JSON.stringify(ACME));
  try {
    await open(page, slug);
    // View mode shows no controls.
    await expect(frameOf(page).locator(".ds-token__controls")).toHaveCount(0);
    const bar = await startEditing(page);
    // Every example is its rendered preview only: no code anywhere.
    await expect(frameOf(page).locator("pre, textarea")).toHaveCount(0);
    await shot(page, info, "edit-tokens");
    await setColor(page, "color.bg", "#fafafa");
    await expect(bar).toContainText("Draft saved", { timeout: 10_000 });
    // The row's menu: dark values, other tokens, and what an agent changes.
    await tokenRow(page, "radius.md")
      .getByRole("button", { name: /actions$/ })
      .click();
    const menu = frameOf(page).getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Add a dark value" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Rename: Ask an agent" })).toBeVisible();
    await shot(page, info, "edit-row-menu");
    await menu.getByRole("menuitem", { name: "Add a dark value" }).click();
    await expect(tokenRow(page, "radius.md").locator(".ds-token__side")).toHaveCount(2);
    await shot(page, info, "edit-dark-value");
    // A group's menu adds a token: a name, then its value is edited in its row.
    const group = frameOf(page).locator('.ds-group[data-group="color"]');
    await group.getByRole("button", { name: /actions$/ }).click();
    await frameOf(page).getByRole("menuitem", { name: "Add a token" }).click();
    const form = group.getByRole("form", { name: "Add a token to color" });
    await form.getByRole("textbox", { name: "Token name" }).fill("line");
    await shot(page, info, "edit-add-token");
    await form.getByRole("button", { name: "Add" }).click();
    await expect(tokenRow(page, "color.line")).toBeVisible();
    // A token in use stays, and the page says what uses it.
    await tokenRow(page, "color.brand.500")
      .getByRole("button", { name: /actions$/ })
      .click();
    await frameOf(page).getByRole("menuitem", { name: "Remove this token" }).click();
    await expect(frameOf(page).locator(".ds-notice")).toContainText(
      "Used by color.accent. Change those first.",
    );
    // Guidelines and a component's text are formatted text: a block opens for typing.
    await frameOf(page).locator("#ds-components-button").scrollIntoViewIfNeeded();
    await expect(
      frameOf(page).locator("#ds-components-button .ds-component__bar select"),
    ).toHaveValue("stable");
    // Its examples are drawn from v1's files, which a Publish keeps.
    const preview = frameOf(page).frameLocator('iframe[title^="Button: Primary ("]');
    await expect(preview.locator("button")).toHaveText("Save", { timeout: 10_000 });
    await expect(preview.locator('img[src="img/logo.png"]')).toHaveCount(0);
    await shot(page, info, "edit-component");
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(bar).toContainText("Published as v2", { timeout: 10_000 });
    const got = await tool<{ version: number; content: string }>(client, "get_artifact", { id });
    expect(got.data.version).toBe(2);
    const v2 = JSON.parse(got.data.content) as Json;
    expect(v2.tokens.color.bg.$value).toBe("#fafafa");
    expect(v2.themes.dark.radius.md.$value).toBe("8px");
    expect(got.data.content).toBe(JSON.stringify(v2, null, 2));
    const versions = await apiGet(page.request, `/artifacts/${id}/versions`);
    expect(versions.body.items[0]).toMatchObject({ number: 2, note: "Edited on the page" });
  } finally {
    await client.close();
  }
});

test("a version an agent publishes meanwhile is reviewed beside the page's changes, never merged", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await stubGoogleFonts(page);
  const { client, id, slug } = await publishDs(page, JSON.stringify(ACME));
  try {
    await open(page, slug);
    const bar = await startEditing(page);
    await setColor(page, "color.bg", "#fafafa");
    await expect(bar).toContainText("Draft saved", { timeout: 10_000 });
    const v2 = JSON.parse(JSON.stringify(ACME)) as Json;
    v2.tokens.color.fg.$value = "#000000";
    const r = await tool<{ version: number; warnings: { code: string; message: string }[] }>(
      client,
      "update_artifact",
      { id, content: JSON.stringify(v2), base_version: 1 },
    );
    expect(r.isError, r.text).toBe(false);
    const warning = r.data.warnings.find((w) => w.code === "live_draft");
    expect(warning?.message).toContain("People are editing this design system on its page.");
    await expect(bar).toContainText("v2 was published while you edited", { timeout: 10_000 });
    await bar.getByRole("button", { name: "Review changes" }).click();
    const review = frameOf(page).getByRole("region", { name: "Review v2 and your changes" });
    await expect(review).toBeVisible();
    const mine = review.getByRole("region", { name: "Your changes" });
    await expect(mine).toContainText("color.bg changed");
    await expect(mine.locator('.ds-token[data-path="color.bg"][data-review-changed]')).toHaveCount(
      1,
    );
    await shot(page, info, "review");
    await review.getByRole("button", { name: "Publish your changes", exact: true }).click();
    await expect(bar).toContainText("Published as v3", { timeout: 10_000 });
    const got = await tool<{ version: number; content: string }>(client, "get_artifact", { id });
    const v3 = JSON.parse(got.data.content) as Json;
    expect(v3.tokens.color.bg.$value).toBe("#fafafa");
    expect(v3.tokens.color.fg.$value).toBe("#1f2328");
    const versions = await apiGet(page.request, `/artifacts/${id}/versions`);
    expect(versions.body.items[0]).toMatchObject({
      number: 3,
      note: "Edited on the page. Replaces the changes in v2.",
    });
  } finally {
    await client.close();
  }
});

test("Rename: Ask an agent on a token row opens the Ask dialog pointing at the token", async ({
  page,
}, info) => {
  await stubGoogleFonts(page);
  const { client, slug } = await publishDs(page, JSON.stringify(ACME));
  try {
    await open(page, slug);
    await startEditing(page);
    await tokenRow(page, "color.bg")
      .getByRole("button", { name: /actions$/ })
      .click();
    await frameOf(page).getByRole("menuitem", { name: "Rename: Ask an agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Ask an agent" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("color.bg");
    // Once it has finished opening.
    await page.waitForTimeout(400);
    await shot(page, info, "ask-dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Still editing.
    await expect(page.getByRole("region", { name: "Editing on the page" })).toBeVisible();
  } finally {
    await client.close();
  }
});

test("a compact system of about 900 KB, changed in place, is published compact", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await stubGoogleFonts(page);
  const big = JSON.parse(JSON.stringify(ACME)) as Json;
  // Deeply nested tokens with long descriptions: 2-space JSON indents every one of their lines,
  // so it is past the 1 MB limit while the compact file is within it.
  const leaf: Json = {};
  for (let i = 0; i < 1980; i++) {
    leaf[`t${i}`] = { $value: "#123456", $description: `Shade ${i} ${"x".repeat(330)}` };
  }
  big.tokens.deep = { $type: "color", a: { b: { c: { d: { e: { f: leaf } } } } } };
  big.guidelines = `${big.guidelines}\n\n${"Long guidance. ".repeat(10_000)}`;
  const compact = JSON.stringify(big);
  expect(compact.length).toBeGreaterThan(850_000);
  expect(compact.length).toBeLessThan(1024 * 1024);
  expect(JSON.stringify(big, null, 2).length).toBeGreaterThan(1024 * 1024);
  const { client, id, slug } = await publishDs(page, compact);
  try {
    await open(page, slug);
    const bar = await startEditing(page);
    await setColor(page, "color.bg", "#fafafa");
    await expect(bar).toContainText("Draft saved", { timeout: 15_000 });
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(bar).toContainText("Published as v2", { timeout: 15_000 });
    const got = await tool<{ content: string }>(client, "get_artifact", { id });
    big.tokens.color.bg.$value = "#fafafa";
    // A Publish from the page stores the guidelines last.
    const { guidelines, ...rest } = big;
    expect(got.data.content).toBe(JSON.stringify({ ...rest, guidelines }));
  } finally {
    await client.close();
  }
});
